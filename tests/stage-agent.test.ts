import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@/lib/server/runtime", () => ({ database: vi.fn(), mediaBucket: vi.fn() }));

import { ApiError } from "@/lib/server/api";
import {
  assertStageAgentRunExecutable,
  normalizeStageAgentAction,
  normalizeStageAgentActions,
  parseStageAgentHistory,
  parseStageAgentModelResponse,
} from "@/lib/server/stage-agent";

describe("stage agent action guardrails", () => {
  test("解析模型 JSON 并只保留当前制作环节允许的动作", () => {
    const parsed = parseStageAgentModelResponse("characters", `\`\`\`json
      {"reply":"建议先建立主角卡。","actions":[
        {"type":"create_character","payload":{"name":"林夏","role":"主角"}},
        {"type":"create_asset","payload":{"name":"越权资产","mediaType":"image","category":"character"}}
      ]}
    \`\`\``);

    expect(parsed.reply).toBe("建议先建立主角卡。");
    expect(parsed.actions).toEqual([{ type: "create_character", label: "创建人物：林夏", payload: { name: "林夏", role: "主角" } }]);
  });

  test("执行模式拒绝跨环节动作", () => {
    expect(() => normalizeStageAgentActions("story", [
      { type: "create_script", payload: { title: "不允许的剧本" } },
    ], true)).toThrowError(ApiError);
  });

  test("资产动作同时保留介质属性、制作分类和关联关系", () => {
    const action = normalizeStageAgentAction("assets", {
      type: "create_asset",
      payload: {
        name: "林夏雨夜造型",
        mediaType: "image",
        category: "costume",
        sourceUrl: "https://cdn.example.test/linxia.png",
        relatedCharacterIds: ["chr_linxia"],
      },
    });

    expect(action.payload).toMatchObject({
      mediaType: "image",
      category: "costume",
      sourceUrl: "https://cdn.example.test/linxia.png",
      relations: [{ targetType: "character", targetId: "chr_linxia" }],
    });
  });

  test("分镜 Agent 强制建立 storyboard 分类且只接受图像或视频", () => {
    expect(normalizeStageAgentAction("shots", {
      type: "create_storyboard_asset",
      payload: { name: "S01-03 推镜", sceneId: "scn_1", framing: "近景" },
    })).toMatchObject({
      type: "create_storyboard_asset",
      payload: { mediaType: "image", category: "storyboard", sceneId: "scn_1", metadata: { framing: "近景" } },
    });

    expect(() => normalizeStageAgentAction("shots", {
      type: "create_storyboard_asset",
      payload: { name: "错误音频", mediaType: "audio" },
    })).toThrowError(ApiError);
  });

  test("连续对话历史有条数与长度上限", () => {
    expect(parseStageAgentHistory([{ role: "user", content: "继续完善人物弧光" }])).toEqual([
      { role: "user", content: "继续完善人物弧光" },
    ]);
    expect(() => parseStageAgentHistory(Array.from({ length: 13 }, () => ({ role: "user", content: "x" })))).toThrowError(ApiError);
  });

  test("同一运行记录不能重复执行建议", () => {
    try {
      assertStageAgentRunExecutable({ executedAt: "2026-08-23T12:00:00.000Z", executionResults: [] });
      throw new Error("expected duplicate execution to be rejected");
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).status).toBe(409);
      expect((error as ApiError).code).toBe("STAGE_AGENT_RUN_ALREADY_EXECUTED");
    }
  });
});

const routeMocks = vi.hoisted(() => ({
  apiContext: vi.fn(),
  planStageAgent: vi.fn(),
  executeStageAgentActions: vi.fn(),
}));

vi.mock("@/lib/server/context", () => ({ apiContext: routeMocks.apiContext }));
vi.mock("@/lib/server/stage-agent", async () => {
  const actual = await vi.importActual<typeof import("@/lib/server/stage-agent")>("@/lib/server/stage-agent");
  return {
    ...actual,
    planStageAgent: routeMocks.planStageAgent,
    executeStageAgentActions: routeMocks.executeStageAgentActions,
  };
});

import { POST } from "@/app/api/projects/[projectId]/stage-agent/route";

function context() {
  return { params: Promise.resolve({ projectId: "prj_1" }) };
}

beforeEach(() => {
  routeMocks.apiContext.mockResolvedValue({ db: { marker: "db" }, identity: { userId: "owner_1" } });
  routeMocks.planStageAgent.mockResolvedValue({ run: { id: "run_1" }, reply: "分析完成", actions: [] });
  routeMocks.executeStageAgentActions.mockResolvedValue({ message: "已执行 1 项操作", actions: [], results: [] });
});

describe("POST /api/projects/[projectId]/stage-agent", () => {
  test("plan 模式传入环节、模型、消息和历史并返回 201", async () => {
    const response = await POST(new Request("https://frameflow.test/api/projects/prj_1/stage-agent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "plan", stage: "scripts", modelId: "mdl_1", message: "创建第一集剧本", history: [{ role: "user", content: "都市悬疑" }] }),
    }), context());

    expect(response.status).toBe(201);
    expect(routeMocks.planStageAgent).toHaveBeenCalledWith(expect.objectContaining({
      projectId: "prj_1", ownerId: "owner_1", stage: "scripts", modelId: "mdl_1", message: "创建第一集剧本",
      history: [{ role: "user", content: "都市悬疑" }],
    }));
  });

  test("execute 模式把已确认动作交给执行器", async () => {
    const actions = [{ type: "update_story", payload: { logline: "新的故事命题" } }];
    const response = await POST(new Request("https://frameflow.test/api/projects/prj_1/stage-agent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "execute", stage: "story", runId: "run_1", actions }),
    }), context());

    expect(response.status).toBe(200);
    expect(routeMocks.executeStageAgentActions).toHaveBeenCalledWith(expect.objectContaining({
      projectId: "prj_1", ownerId: "owner_1", stage: "story", runId: "run_1", actions,
    }));
  });

  test("拒绝未知 mode", async () => {
    const response = await POST(new Request("https://frameflow.test/api/projects/prj_1/stage-agent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "delete", stage: "story" }),
    }), context());
    const payload = await response.json() as { error: { code: string } };

    expect(response.status).toBe(400);
    expect(payload.error.code).toBe("INVALID_STAGE_AGENT_MODE");
  });
});
