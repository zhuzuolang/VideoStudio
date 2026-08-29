import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  allowlistedPublicHttpModelEndpoint: vi.fn<(value: string) => string | null>(() => null),
  decryptApiKey: vi.fn(async () => "provider-key"),
  directHttpFetch: vi.fn(),
  validateModelEndpoint: vi.fn(async (value: string) => value),
}));

vi.mock("@/lib/server/crypto", () => ({ decryptApiKey: mocks.decryptApiKey }));
vi.mock("@/lib/server/outbound", () => ({
  allowlistedPublicHttpModelEndpoint: mocks.allowlistedPublicHttpModelEndpoint,
  validateModelEndpoint: mocks.validateModelEndpoint,
}));
vi.mock("@/lib/server/direct-http", () => ({ directHttpFetch: mocks.directHttpFetch }));
vi.mock("@/lib/server/runtime", () => ({ mediaBucket: vi.fn() }));

import { callConfiguredModel } from "@/lib/server/agent";

const configuredModel: Record<string, unknown> = {
  enabled: 1,
  api_key_ciphertext: "cipher",
  api_key_iv: "iv",
  endpoint: "http://8.163.6.244:8317/v1",
  model_id: "gpt-5.6-luna",
  parameters_json: JSON.stringify({ capabilities: ["text"] }),
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.allowlistedPublicHttpModelEndpoint.mockReturnValue(null);
  mocks.decryptApiKey.mockResolvedValue("provider-key");
  mocks.validateModelEndpoint.mockImplementation(async (value: string) => value);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OpenAI-compatible provider responses", () => {
  test("preserves a custom endpoint port and requests JSON", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: "模型连接正常" } }],
      usage: { total_tokens: 12 },
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(callConfiguredModel(configuredModel, "测试", "只回复连接状态", []))
      .resolves.toMatchObject({ response: "模型连接正常", usage: { total_tokens: 12 } });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://8.163.6.244:8317/v1/chat/completions");
    expect(init).toMatchObject({
      method: "POST",
      redirect: "manual",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: "Bearer provider-key",
      },
    });
  });

  test("uses the direct transport for an explicitly allowlisted HTTP endpoint", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    mocks.allowlistedPublicHttpModelEndpoint.mockImplementation((value: string) => value);
    mocks.directHttpFetch.mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: "模型连接正常" } }],
    }), { status: 200, headers: { "Content-Type": "application/json" } }));

    await expect(callConfiguredModel(configuredModel, "测试", null, []))
      .resolves.toMatchObject({ response: "模型连接正常" });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.directHttpFetch).toHaveBeenCalledWith(
      "http://8.163.6.244:8317/v1/chat/completions",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer provider-key" }),
      }),
      { timeoutMs: 120_000, maxResponseBytes: 2 * 1024 * 1024 },
    );
  });

  test("does not expose a direct provider error body or API key", async () => {
    mocks.allowlistedPublicHttpModelEndpoint.mockImplementation((value: string) => value);
    mocks.directHttpFetch.mockResolvedValue(new Response(
      "provider-key must stay private; upstream diagnostic must stay private",
      { status: 401, headers: { "Content-Type": "text/plain" } },
    ));

    const error = await callConfiguredModel(configuredModel, "测试", null, []).catch((reason) => reason);
    expect(error).toMatchObject({
      code: "MODEL_REQUEST_REJECTED",
      details: { providerStatus: 401 },
    });
    const publicError = JSON.stringify({ code: error.code, message: error.message, details: error.details });
    expect(publicError).not.toContain("provider-key");
    expect(publicError).not.toContain("upstream diagnostic");
  });

  test("keeps the provider status when an error response is not JSON", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>upstream error</html>", {
      status: 501,
      headers: { "Content-Type": "text/html" },
    })));

    await expect(callConfiguredModel(configuredModel, "测试", null, []))
      .rejects.toMatchObject({
        status: 502,
        code: "MODEL_REQUEST_REJECTED",
        details: { providerStatus: 501 },
      });
  });

  test("reports invalid content only for a successful non-JSON response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not json", {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    })));

    await expect(callConfiguredModel(configuredModel, "测试", null, []))
      .rejects.toMatchObject({
        status: 502,
        code: "INVALID_MODEL_RESPONSE",
        details: { providerStatus: 200 },
      });
  });
});
