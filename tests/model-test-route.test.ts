import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  apiContext: vi.fn(),
  requireOwnedModel: vi.fn(),
  callConfiguredModel: vi.fn(),
  modelSupportsImageGeneration: vi.fn(),
  generateImageWithModel: vi.fn(),
}));

vi.mock("@/lib/server/context", () => ({ apiContext: mocks.apiContext }));
vi.mock("@/lib/server/store", () => ({ requireOwnedModel: mocks.requireOwnedModel }));
vi.mock("@/lib/server/agent", () => ({ callConfiguredModel: mocks.callConfiguredModel }));
vi.mock("@/lib/server/image-generation", () => ({
  modelSupportsImageGeneration: mocks.modelSupportsImageGeneration,
  generateImageWithModel: mocks.generateImageWithModel,
}));

import { POST } from "@/app/api/models/[modelId]/test/route";

const model = {
  id: "model-test",
  owner_id: "owner-test",
  name: "测试模型",
  model_id: "gpt-test",
  endpoint: "https://api.example.test/v1/chat/completions",
  enabled: 1,
  api_key_ciphertext: "encrypted-secret",
  api_key_iv: "encrypted-iv",
  parameters_json: "{}",
};

function request(): Request {
  return new Request("https://frameflow.example.test/api/models/model-test/test", { method: "POST" });
}

function context() {
  return { params: Promise.resolve({ modelId: model.id }) };
}

beforeEach(() => {
  mocks.apiContext.mockResolvedValue({ db: {}, identity: { userId: model.owner_id } });
  mocks.requireOwnedModel.mockResolvedValue({ ...model });
  mocks.modelSupportsImageGeneration.mockReturnValue(false);
});

describe("POST /api/models/[modelId]/test", () => {
  test("文本模型复用现有调用并只返回安全摘要", async () => {
    mocks.callConfiguredModel.mockResolvedValue({
      response: "模型连接正常",
      usage: { total_tokens: 8 },
      requestMeta: { endpointHost: "api.example.test" },
    });

    const response = await POST(request(), context());
    const payload = await response.json() as { data: Record<string, unknown> };

    expect(response.status).toBe(200);
    expect(mocks.requireOwnedModel).toHaveBeenCalledWith({}, model.id, model.owner_id);
    expect(mocks.callConfiguredModel).toHaveBeenCalledWith(expect.objectContaining({ id: model.id }), expect.any(String), expect.any(String), []);
    expect(payload.data).toMatchObject({ type: "text", status: "success", summary: "模型连接正常" });
    expect(typeof payload.data.latencyMs).toBe("number");
    expect(JSON.stringify(payload)).not.toContain("encrypted-secret");
    expect(JSON.stringify(payload)).not.toContain(model.endpoint);
  });

  test("停用模型在实际出站请求前失败", async () => {
    mocks.requireOwnedModel.mockResolvedValue({ ...model, enabled: 0 });

    const response = await POST(request(), context());
    const payload = await response.json() as { error: { code: string; details: Record<string, unknown> } };

    expect(response.status).toBe(400);
    expect(payload.error.code).toBe("MODEL_DISABLED");
    expect(payload.error.details).toMatchObject({ type: "text", status: "failed" });
    expect(mocks.callConfiguredModel).not.toHaveBeenCalled();
    expect(mocks.generateImageWithModel).not.toHaveBeenCalled();
  });

  test("图像模型复用无落库生成 helper 且不返回图片字节", async () => {
    mocks.modelSupportsImageGeneration.mockReturnValue(true);
    mocks.generateImageWithModel.mockResolvedValue({
      bytes: new Uint8Array(2048),
      mimeType: "image/png",
      sourceUrl: null,
      revisedPrompt: "蓝色圆点",
    });

    const response = await POST(request(), context());
    const payload = await response.json() as { data: Record<string, unknown> };

    expect(response.status).toBe(200);
    expect(mocks.generateImageWithModel).toHaveBeenCalledOnce();
    expect(payload.data).toMatchObject({ type: "image", status: "success", summary: "图像生成成功：蓝色圆点" });
    expect(JSON.stringify(payload)).not.toContain("bytes");
    expect(JSON.stringify(payload)).not.toContain("b64");
    expect(JSON.stringify(payload)).not.toContain("data:image");
  });
});
