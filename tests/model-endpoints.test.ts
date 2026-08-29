import { describe, expect, test, vi } from "vitest";

vi.mock("@/lib/server/runtime", () => ({ mediaBucket: vi.fn(), bindings: vi.fn(), database: vi.fn() }));

import { chatCompletionsEndpoint, modelSupportsTextAgent } from "@/lib/server/agent";
import { buildImageGenerationRequest, defaultImageSize, imageGenerationEndpoint, modelSupportsImageGeneration } from "@/lib/server/image-generation";
import { validateModelEndpoint, validatePublicHttpsUrl } from "@/lib/server/outbound";
import { bindings } from "@/lib/server/runtime";

describe("OpenAI-compatible 模型路径归一化", () => {
  test.each([
    ["https://api.deepseek.com/", "https://api.deepseek.com/chat/completions"],
    ["https://api.openai.com/v1", "https://api.openai.com/v1/chat/completions"],
    ["https://ark.cn-beijing.volces.com/api/v3", "https://ark.cn-beijing.volces.com/api/v3/chat/completions"],
    ["https://api.openai.com/v1/chat/completions", "https://api.openai.com/v1/chat/completions"],
  ])("聊天根地址 %s 会得到 %s", (configured, expected) => {
    expect(chatCompletionsEndpoint(configured)).toBe(expected);
  });

  test("显式启用时仅允许回环地址作为本地模型端点", async () => {
    vi.mocked(bindings).mockReturnValue({ ALLOW_LOCAL_MODEL_ENDPOINTS: "true" });

    await expect(validateModelEndpoint("http://127.0.0.1:8317/v1")).resolves.toBe("http://127.0.0.1:8317/v1");
    await expect(validateModelEndpoint("http://localhost:8317/v1")).resolves.toBe("http://localhost:8317/v1");
    await expect(validateModelEndpoint("http://192.168.1.8:8317/v1")).rejects.toMatchObject({ code: "INVALID_PUBLIC_URL" });
    await expect(validatePublicHttpsUrl("http://127.0.0.1:8317/v1")).rejects.toMatchObject({ code: "INVALID_PUBLIC_URL" });
  });

  test("未启用本地端点开关时仍拒绝回环地址", async () => {
    vi.mocked(bindings).mockReturnValue({});
    await expect(validateModelEndpoint("http://127.0.0.1:8317/v1")).rejects.toMatchObject({ code: "INVALID_PUBLIC_URL" });
  });

  test("公网 HTTP 模型端点只允许显式配置的公共 IPv4 与端口", async () => {
    vi.mocked(bindings).mockReturnValue({ MODEL_HTTP_ENDPOINT_ALLOWLIST: "8.163.6.244:8317" });

    await expect(validateModelEndpoint("http://8.163.6.244:8317/v1")).resolves.toBe("http://8.163.6.244:8317/v1");
    await expect(validateModelEndpoint("http://8.163.6.244:8317/v1/chat/completions")).resolves.toBe("http://8.163.6.244:8317/v1/chat/completions");
    await expect(validateModelEndpoint("http://8.163.6.244:8318/v1")).rejects.toMatchObject({ code: "INVALID_PUBLIC_URL" });
    await expect(validateModelEndpoint("http://8.163.6.245:8317/v1")).rejects.toMatchObject({ code: "INVALID_PUBLIC_URL" });
    await expect(validateModelEndpoint("http://8.163.6.244/v1")).rejects.toMatchObject({ code: "INVALID_PUBLIC_URL" });
    await expect(validateModelEndpoint("http://8.163.6.244:8317/v1?token=unsafe")).rejects.toMatchObject({ code: "INVALID_PUBLIC_URL" });
  });

  test("公网 HTTP 允许列表不能放行私网或回环地址", async () => {
    vi.mocked(bindings).mockReturnValue({
      MODEL_HTTP_ENDPOINT_ALLOWLIST: "127.0.0.1:8317,192.168.1.8:8317",
    });

    await expect(validateModelEndpoint("http://127.0.0.1:8317/v1")).rejects.toMatchObject({ code: "INVALID_PUBLIC_URL" });
    await expect(validateModelEndpoint("http://192.168.1.8:8317/v1")).rejects.toMatchObject({ code: "INVALID_PUBLIC_URL" });
  });

  test("公网 HTTP 允许列表支持显式默认端口且拒绝非法端口", async () => {
    vi.mocked(bindings).mockReturnValue({ MODEL_HTTP_ENDPOINT_ALLOWLIST: "8.163.6.244:80,8.163.6.244:0,8.163.6.244:65536" });

    await expect(validateModelEndpoint("http://8.163.6.244:80/v1")).resolves.toBe("http://8.163.6.244:80/v1");
    await expect(validateModelEndpoint("http://8.163.6.244/v1")).rejects.toMatchObject({ code: "INVALID_PUBLIC_URL" });
    await expect(validateModelEndpoint("http://8.163.6.244:0/v1")).rejects.toMatchObject({ code: "INVALID_PUBLIC_URL" });
  });

  test("纯图像生成模型不会被识别为文本 Agent", () => {
    const parameters_json = JSON.stringify({ capabilities: ["image-generation", "text-to-image"] });
    expect(modelSupportsTextAgent({ model_id: "gpt-image-2", parameters_json })).toBe(false);
    expect(modelSupportsTextAgent({ model_id: "gpt-5.4", parameters_json: JSON.stringify({ capabilities: ["text", "analysis"] }) })).toBe(true);
  });

  test.each([
    ["https://api.openai.com/v1", "https://api.openai.com/v1/images/generations"],
    ["https://ark.cn-beijing.volces.com/api/v3", "https://ark.cn-beijing.volces.com/api/v3/images/generations"],
    ["https://api.openai.com/v1/chat/completions", "https://api.openai.com/v1/images/generations"],
  ])("图像根地址 %s 会得到 %s", (configured, expected) => {
    expect(imageGenerationEndpoint(configured)).toBe(expected);
  });

  test("只把明确的生图能力或生图模型识别为图像生成", () => {
    expect(modelSupportsImageGeneration({ name: "图片生成", model_id: "custom-v1", parameters_json: "{}" })).toBe(true);
    expect(modelSupportsImageGeneration({ name: "视觉创作", model_id: "doubao-seedream-5-0-pro", parameters_json: "{}" })).toBe(true);
    expect(modelSupportsImageGeneration({ name: "创作模型", model_id: "custom-v1", parameters_json: JSON.stringify({ capabilities: ["图像生成"] }) })).toBe(true);
    expect(modelSupportsImageGeneration({ name: "文本模型", model_id: "deepseek-chat", parameters_json: JSON.stringify({ capabilities: ["analysis"] }) })).toBe(false);
    expect(modelSupportsImageGeneration({ name: "视觉理解", model_id: "doubao-vision-pro", parameters_json: JSON.stringify({ capabilities: ["image"] }) })).toBe(false);
  });

  test("GPT Image 不发送 DALL-E 专用 response_format，并使用对应尺寸", () => {
    const model = { provider: "OpenAI", name: "GPT Image", model_id: "gpt-image-1.5", parameters_json: "{}" };
    expect(defaultImageSize(model, "16:9")).toBe("1536x1024");
    expect(buildImageGenerationRequest(model, { prompt: "角色设定", aspectRatio: "16:9" })).toEqual({
      model: "gpt-image-1.5",
      prompt: "角色设定",
      size: "1536x1024",
      output_format: "webp",
    });
  });

  test("Seedream 优先返回 URL，避免在 Worker 内存中复制大段 base64", () => {
    const model = { provider: "火山方舟", name: "图片生成", model_id: "doubao-seedream-5-0-pro", parameters_json: "{}" };
    expect(buildImageGenerationRequest(model, { prompt: "场景概念图", aspectRatio: "1:1" })).toEqual({
      model: "doubao-seedream-5-0-pro",
      prompt: "场景概念图",
      size: "2048x2048",
      response_format: "url",
      stream: false,
    });
  });

  test("DALL-E 仍使用 b64_json 兼容参数", () => {
    const model = { provider: "OpenAI", name: "DALL-E 3", model_id: "dall-e-3", parameters_json: "{}" };
    expect(buildImageGenerationRequest(model, { prompt: "道具设定", aspectRatio: "9:16" })).toMatchObject({
      model: "dall-e-3",
      size: "1024x1792",
      response_format: "b64_json",
    });
  });

  test("DALL-E 2 默认保持正方形尺寸", () => {
    const model = { provider: "OpenAI", name: "DALL-E 2", model_id: "dall-e-2", parameters_json: "{}" };
    expect(defaultImageSize(model, "9:16")).toBe("1024x1024");
    expect(buildImageGenerationRequest(model, { prompt: "角色草图", aspectRatio: "9:16" })).toMatchObject({
      size: "1024x1024",
      response_format: "b64_json",
    });
  });
});
