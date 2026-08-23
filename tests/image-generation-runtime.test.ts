import { beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  decryptApiKey: vi.fn(async () => "provider-key"),
  validateModelEndpoint: vi.fn(async (value: string) => value),
  validatePublicHttpsUrl: vi.fn(async (value: string) => value),
}));

vi.mock("@/lib/server/crypto", () => ({ decryptApiKey: mocks.decryptApiKey }));
vi.mock("@/lib/server/outbound", () => ({
  validateModelEndpoint: mocks.validateModelEndpoint,
  validatePublicHttpsUrl: mocks.validatePublicHttpsUrl,
}));

const seedreamModel = {
  id: "model-1",
  name: "图片生成",
  provider: "火山引擎",
  model_id: "doubao-seedream-5-0-pro",
  endpoint: "https://ark.example.com/api/v3",
  enabled: 1,
  api_key_ciphertext: "cipher",
  api_key_iv: "iv",
  parameters_json: JSON.stringify({ capabilities: ["image-generation"] }),
};

beforeEach(() => {
  vi.clearAllMocks();
});

test("Seedream 使用 URL 响应并下载校验后的位图", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.includes("/images/generations")) {
      return new Response(JSON.stringify({ data: [{ url: "https://cdn.example.com/generated.jpg" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), {
      status: 200,
      headers: { "content-type": "application/octet-stream" },
    });
  }) as unknown as typeof fetch;
  const { generateImageWithModel } = await import("@/lib/server/image-generation");

  const generated = await generateImageWithModel(seedreamModel, {
    prompt: "电影感人物概念图",
    aspectRatio: "1:1",
  }, fetchImpl);

  expect(generated.mimeType).toBe("image/jpeg");
  expect(calls).toHaveLength(2);
  expect(JSON.parse(String(calls[0].init?.body))).toMatchObject({
    model: "doubao-seedream-5-0-pro",
    response_format: "url",
    stream: false,
    size: "2048x2048",
  });
  expect(mocks.validatePublicHttpsUrl).toHaveBeenCalledWith(
    "https://cdn.example.com/generated.jpg",
    expect.objectContaining({ allowQuery: true }),
  );
});

test("供应商鉴权失败返回可展示的明确错误码", async () => {
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
    error: { code: "invalid_api_key", message: "invalid key" },
  }), {
    status: 401,
    headers: { "content-type": "application/json" },
  })) as unknown as typeof fetch;
  const { generateImageWithModel } = await import("@/lib/server/image-generation");

  await expect(generateImageWithModel(seedreamModel, { prompt: "test" }, fetchImpl)).rejects.toMatchObject({
    status: 422,
    code: "IMAGE_AUTH_FAILED",
  });
});

test("租约已丢失时不会再调用付费模型", async () => {
  const controller = new AbortController();
  controller.abort();
  const fetchImpl = vi.fn() as unknown as typeof fetch;
  const { generateImageWithModel } = await import("@/lib/server/image-generation");

  await expect(generateImageWithModel(seedreamModel, {
    prompt: "test",
    signal: controller.signal,
  }, fetchImpl)).rejects.toMatchObject({ code: "GENERATION_LEASE_LOST" });
  expect(fetchImpl).not.toHaveBeenCalled();
});
