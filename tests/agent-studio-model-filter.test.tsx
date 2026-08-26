import { render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import AgentStudio from "@/app/components/AgentStudio";
import type { AiModel, WorkspaceBootstrap } from "@/lib/platform-types";

const NOW = "2026-08-26T00:00:00.000Z";

const textModel: AiModel = {
  id: "model-text",
  name: "文本创作模型",
  provider: "OpenAI-compatible",
  modelId: "text-model",
  level: "标准",
  endpoint: "https://api.example.test/v1",
  iconUrl: null,
  enabled: true,
  parameters: { capabilities: ["文本分析", "剧本创作"] },
  hasApiKey: true,
  apiKeyMasked: "sk-••••test",
  createdAt: NOW,
  updatedAt: NOW,
};

const videoModel: AiModel = {
  ...textModel,
  id: "model-video",
  name: "Seedance 视频生成",
  modelId: "doubao-seedance-test",
  parameters: { capabilities: ["video-generation", "text-to-video", "image-to-video"] },
};

function dataResponse(data: unknown): Response {
  return new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function workspace(models: AiModel[]): WorkspaceBootstrap {
  return {
    workspace: { userId: "owner-1", email: "owner@example.test", displayName: "测试用户", activeProjectId: "project-1" },
    projects: [{ id: "project-1", name: "测试项目" }],
    activeProjectId: "project-1",
    project: { id: "project-1", name: "测试项目" },
    story: { title: "测试故事" },
    episodes: [],
    characters: [],
    scripts: [],
    assets: [],
    models,
    agentRuns: [],
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("文本 Agent 模型过滤", () => {
  test("纯视频生成模型不会出现在执行模型列表中", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => dataResponse(workspace([videoModel, textModel]))));

    render(<AgentStudio projectId="project-1" />);

    const select = await screen.findByRole("combobox", { name: /执行模型/ });
    expect(select).toHaveValue(textModel.id);
    expect(within(select).getByRole("option", { name: /文本创作模型/ })).toBeVisible();
    expect(within(select).queryByRole("option", { name: /Seedance 视频生成/ })).not.toBeInTheDocument();
  });

  test("只有纯视频模型时提示配置文本模型", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => dataResponse(workspace([videoModel]))));

    render(<AgentStudio projectId="project-1" />);

    const select = await screen.findByRole("combobox", { name: /执行模型/ });
    expect(select).toBeDisabled();
    expect(await screen.findByText(/没有已启用且已配置 API Key 的文本模型/)).toBeVisible();
  });
});
