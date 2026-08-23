import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vitest";
import StageAgentPanel, { type StageAgentStage } from "@/app/components/StageAgentPanel";
import Home from "@/app/page";
import type { AgentRun, AiModel, WorkspaceBootstrap } from "@/lib/platform-types";

const NOW = "2026-08-23T08:00:00.000Z";

const model: AiModel = {
  id: "model-text",
  name: "短剧编剧模型",
  provider: "OpenAI-compatible",
  modelId: "drama-writer-v1",
  level: "专业",
  endpoint: "https://api.example.test/v1",
  iconUrl: null,
  enabled: true,
  parameters: { capabilities: ["文本分析", "剧本创作"] },
  hasApiKey: true,
  apiKeyMasked: "sk-••••test",
  createdAt: NOW,
  updatedAt: NOW,
};

const run: AgentRun = {
  id: "run-stage-1",
  projectId: "project-1",
  modelId: model.id,
  modelName: model.name,
  status: "completed",
  prompt: "为当前故事创建一位核心人物",
  systemPrompt: null,
  response: "我建议创建一位与核心冲突直接相关的调查者。",
  errorMessage: null,
  usage: {},
  requestMeta: { kind: "stage_agent", stage: "characters" },
  sources: [],
  createdAt: NOW,
  completedAt: NOW,
};

function dataResponse(data: unknown): Response {
  return new Response(JSON.stringify({ data }), { status: 200, headers: { "Content-Type": "application/json" } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("制作环节定制 Agent", () => {
  test.each<[StageAgentStage, string]>([
    ["story", "故事策划 Agent"],
    ["characters", "人物导演 Agent"],
    ["scripts", "编剧 Agent"],
    ["breakdown", "制片拆解 Agent"],
    ["assets", "资产统筹 Agent"],
    ["shots", "分镜导演 Agent"],
  ])("%s 环节显示独立角色与快捷任务", (stage, title) => {
    render(<StageAgentPanel projectId="project-1" projectName="雾港来信" stage={stage} models={[model]} />);

    const panel = screen.getByRole("complementary", { name: `${title} 对话框` });
    expect(within(panel).getByRole("heading", { name: title })).toBeVisible();
    expect(within(panel).getAllByRole("button").length).toBeGreaterThanOrEqual(3);
    expect(within(panel).getByRole("combobox", { name: "执行模型" })).toHaveValue(model.id);
  });

  test("对话生成结构化建议，确认后由服务端写入项目并刷新页面数据", async () => {
    const action = {
      type: "create_character",
      label: "创建人物卡：沈雾",
      payload: { name: "沈雾", role: "调查者", bio: "追查雾港旧案。" },
    };
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (body.mode === "plan") return dataResponse({ run, reply: run.response, actions: [action] });
      if (body.mode === "execute") return dataResponse({
        message: "已创建 1 张人物卡。",
        actions: [action],
        results: [{ index: 0, type: action.type, status: "completed", entityType: "character", entityId: "character-1", message: "人物已创建", entity: action.payload }],
      });
      throw new Error("未处理的 Stage Agent 请求");
    });
    vi.stubGlobal("fetch", fetchMock);
    const onRunRecorded = vi.fn();
    const onExecuted = vi.fn(async () => undefined);
    const user = userEvent.setup();

    render(
      <StageAgentPanel
        projectId="project-1"
        projectName="雾港来信"
        stage="characters"
        models={[model]}
        onRunRecorded={onRunRecorded}
        onExecuted={onExecuted}
      />,
    );

    await user.type(screen.getByPlaceholderText("告诉人物导演 Agent你想分析或创建什么…"), run.prompt);
    await user.click(screen.getByRole("button", { name: "发送给 Agent" }));

    expect(await screen.findByText(run.response!)).toBeVisible();
    expect(screen.getByText(action.label)).toBeVisible();
    expect(onRunRecorded).toHaveBeenCalledWith(run);
    const planBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(planBody).toMatchObject({ mode: "plan", stage: "characters", modelId: model.id, message: run.prompt });

    await user.click(screen.getByRole("button", { name: "确认并执行 1 项操作" }));

    expect(await screen.findByText("已创建 1 张人物卡。")).toBeVisible();
    expect(screen.getByRole("button", { name: "已写入项目" })).toBeDisabled();
    expect(onExecuted).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const executeBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as Record<string, unknown>;
    expect(executeBody).toMatchObject({ mode: "execute", stage: "characters", runId: run.id, actions: [action] });
  });

  test("没有文本模型时提供模型中心入口，不发送空请求", async () => {
    const onOpenModels = vi.fn();
    const user = userEvent.setup();
    render(<StageAgentPanel projectId="project-1" stage="story" models={[]} onOpenModels={onOpenModels} />);

    await user.click(screen.getByRole("button", { name: "去配置可用文本模型" }));
    expect(onOpenModels).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "发送给 Agent" })).not.toBeInTheDocument();
  });

  test("六个制作 Tab 都在右侧挂载对应 Agent", async () => {
    const workspace: WorkspaceBootstrap = {
      workspace: { userId: "owner-1", email: "owner@example.test", displayName: "测试制片人", activeProjectId: "project-1" },
      projects: [{ id: "project-1", name: "雾港来信" }],
      activeProjectId: "project-1",
      project: { id: "project-1", name: "雾港来信" },
      story: null,
      episodes: [],
      characters: [],
      scripts: [],
      assets: [],
      models: [model],
      agentRuns: [],
    };
    vi.stubGlobal("fetch", vi.fn(async () => dataResponse(workspace)));
    const user = userEvent.setup();
    render(<Home />);
    const navigation = await screen.findByRole("navigation", { name: "项目制作阶段" });

    for (const [tab, title] of [
      ["故事设计", "故事策划 Agent"],
      ["人物设定", "人物导演 Agent"],
      ["剧本工作台", "编剧 Agent"],
      ["生产拆解", "制片拆解 Agent"],
      ["资产中心", "资产统筹 Agent"],
      ["分镜预演", "分镜导演 Agent"],
    ]) {
      await user.click(within(navigation).getByRole("button", { name: new RegExp(tab) }));
      expect(screen.getByRole("complementary", { name: `${title} 对话框` })).toBeVisible();
    }
  });
});
