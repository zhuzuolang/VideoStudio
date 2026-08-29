import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  decryptApiKey: vi.fn(async () => "provider-key"),
  validateModelEndpoint: vi.fn(async (value: string) => value),
}));

vi.mock("@/lib/server/crypto", () => ({ decryptApiKey: mocks.decryptApiKey }));
vi.mock("@/lib/server/outbound", () => ({
  validateModelEndpoint: mocks.validateModelEndpoint,
}));
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
