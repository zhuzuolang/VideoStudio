import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vitest";
import ModelCenter from "@/app/components/ModelCenter";
import type { AiModel } from "@/lib/platform-types";
import { SEEDANCE_MODEL_PRESETS } from "@/lib/seedance-model-presets";

const NOW = "2026-08-26T00:00:00.000Z";
const sortedPresets = [...SEEDANCE_MODEL_PRESETS].sort(
  (left, right) => left.parameters.sortOrder - right.parameters.sortOrder,
);

function dataResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ data }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function configuredModel(preset: (typeof SEEDANCE_MODEL_PRESETS)[number]): AiModel {
  return {
    id: `configured-${preset.presetId}`,
    name: preset.name,
    provider: preset.provider,
    modelId: preset.modelId,
    level: preset.level,
    endpoint: preset.endpoint,
    iconUrl: null,
    enabled: true,
    parameters: { ...preset.parameters, capabilities: [...preset.capabilities] },
    hasApiKey: true,
    apiKeyMasked: "ark-••••test",
    createdAt: NOW,
    updatedAt: NOW,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Seedance 官方预设卡片", () => {
  test("按产品价格顺序独立展示四张卡片及关键规格", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => dataResponse([])));

    render(<ModelCenter />);

    const region = await screen.findByRole("region", { name: "Seedance 视频模型" });
    await waitFor(() => expect(within(region).getAllByRole("article")).toHaveLength(4));
    const cards = within(region).getAllByRole("article");

    expect(cards.map((card) => within(card).getByRole("heading", { level: 4 }).textContent)).toEqual(
      sortedPresets.map((preset) => preset.name),
    );
    sortedPresets.forEach((preset, index) => {
      expect(cards[index]).toHaveTextContent(preset.priceLabel);
      expect(cards[index]).toHaveTextContent(preset.resolutionLabel);
      expect(cards[index]).toHaveTextContent(preset.durationLabel);
      expect(within(cards[index]).getByRole("button", { name: `配置 Seedance 预设 ${preset.name}` })).toBeEnabled();
    });
  });

  test("一键预填并把完整 preset profile、能力与当前卡片 API Key 一起保存", async () => {
    const preset = sortedPresets[0];
    let postedBody: Record<string, unknown> | null = null;
    const savedModel = configuredModel(preset);
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/models" && init?.method === "POST") {
        postedBody = JSON.parse(String(init.body)) as Record<string, unknown>;
        return dataResponse(savedModel, 201);
      }
      if (url === "/api/models") return dataResponse(postedBody ? [savedModel] : []);
      throw new Error(`未处理的请求：${init?.method ?? "GET"} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<ModelCenter />);
    await user.click(await screen.findByRole("button", { name: `配置 Seedance 预设 ${preset.name}` }));

    const dialog = screen.getByRole("dialog", { name: "配置 Seedance 预设" });
    expect(within(dialog).getByRole("textbox", { name: /显示名称/ })).toHaveValue(preset.name);
    expect(within(dialog).getByRole("textbox", { name: /服务商/ })).toHaveValue(preset.provider);
    expect(within(dialog).getByRole("textbox", { name: /模型 ID/ })).toHaveValue(preset.modelId);
    expect(within(dialog).getByRole("textbox", { name: /API 地址/ })).toHaveValue(preset.endpoint);

    await user.type(within(dialog).getByLabelText("API Key"), "ark-shared-key");
    await user.click(within(dialog).getByRole("button", { name: "保存模型" }));

    await waitFor(() => expect(postedBody).not.toBeNull());
    expect(postedBody).toMatchObject({
      name: preset.name,
      provider: preset.provider,
      modelId: preset.modelId,
      level: preset.level,
      endpoint: preset.endpoint,
      apiKey: "ark-shared-key",
      parameters: {
        ...preset.parameters,
        capabilities: [...preset.capabilities],
      },
    });
  });

  test("通过 presetKey 标记已配置卡片并打开对应编辑表单", async () => {
    const preset = sortedPresets[1];
    const model = configuredModel(preset);
    vi.stubGlobal("fetch", vi.fn(async () => dataResponse([model])));
    const user = userEvent.setup();

    render(<ModelCenter />);

    const card = await screen.findByRole("article", { name: preset.name });
    await waitFor(() => expect(card).toHaveTextContent("已配置"));
    expect(card).toHaveTextContent(model.apiKeyMasked!);
    await user.click(within(card).getByRole("button", { name: `编辑已配置 Seedance 预设 ${preset.name}` }));

    const dialog = screen.getByRole("dialog", { name: "编辑 Seedance 预设" });
    expect(within(dialog).getByRole("textbox", { name: /模型 ID/ })).toHaveValue(model.modelId);
    expect(within(dialog).getByLabelText("API Key")).toHaveAttribute("placeholder", expect.stringContaining("留空不修改"));
  });
});
