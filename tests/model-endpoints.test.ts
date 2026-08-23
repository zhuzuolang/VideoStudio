import { describe, expect, test, vi } from "vitest";

vi.mock("@/lib/server/runtime", () => ({ mediaBucket: vi.fn(), bindings: vi.fn(), database: vi.fn() }));

import { chatCompletionsEndpoint } from "@/lib/server/agent";
import { imageGenerationEndpoint, modelSupportsImageGeneration } from "@/lib/server/image-generation";

describe("OpenAI-compatible 模型路径归一化", () => {
  test.each([
    ["https://api.deepseek.com/", "https://api.deepseek.com/chat/completions"],
    ["https://api.openai.com/v1", "https://api.openai.com/v1/chat/completions"],
    ["https://ark.cn-beijing.volces.com/api/v3", "https://ark.cn-beijing.volces.com/api/v3/chat/completions"],
    ["https://api.openai.com/v1/chat/completions", "https://api.openai.com/v1/chat/completions"],
  ])("聊天根地址 %s 会得到 %s", (configured, expected) => {
    expect(chatCompletionsEndpoint(configured)).toBe(expected);
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
});
