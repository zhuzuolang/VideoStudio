import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vitest";
import Home from "@/app/page";
import AssetManager from "@/app/components/AssetManager";
import ModelCenter from "@/app/components/ModelCenter";
import type { WorkspaceBootstrap } from "@/lib/platform-types";

const NOW = "2026-08-23T00:00:00.000Z";

const workspace: WorkspaceBootstrap = {
  workspace: {
    userId: "test-user",
    email: "tester@example.test",
    displayName: "回归测试用户",
    activeProjectId: "project-1",
  },
  projects: [
    {
      id: "project-1",
      name: "回归测试项目",
      genre: "都市悬疑",
      status: "active",
      description: "用于验证前端交互。",
      episodeCount: 12,
      singleEpisodeDuration: 120,
      aspectRatio: "9:16",
      targetPlatform: "测试平台",
      updatedAt: NOW,
    },
  ],
  activeProjectId: "project-1",
  project: {
    id: "project-1",
    name: "回归测试项目",
    genre: "都市悬疑",
    status: "active",
    description: "用于验证前端交互。",
    episodeCount: 12,
    singleEpisodeDuration: 120,
    aspectRatio: "9:16",
    targetPlatform: "测试平台",
    updatedAt: NOW,
  },
  story: null,
  episodes: [],
  characters: [],
  scripts: [],
  assets: [],
  models: [],
  agentRuns: [],
};

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe("关键按钮点击回归", () => {
  test("Home 加载数据后点击“新建项目”显示创建表单", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        expect(String(input)).toBe("/api/bootstrap");
        return jsonResponse(workspace);
      }),
    );
    const user = userEvent.setup();

    render(<Home />);

    await screen.findByRole("heading", { name: "回归测试项目" });
    await user.click(screen.getByRole("button", { name: /新建项目/ }));

    expect(screen.getByRole("heading", { name: "创建短剧项目" })).toBeVisible();
    expect(screen.getByRole("textbox", { name: "项目名称 *" })).toBeVisible();
  });

  test("Home 搜索、通知、用户信息和刷新按钮都有可见行为", async () => {
    const searchableWorkspace: WorkspaceBootstrap = {
      ...workspace,
      characters: [{ id: "character-1", name: "沈雾", role: "主角", bio: "调查雾港旧案" }],
    };
    const fetchMock = vi.fn(async () => jsonResponse(searchableWorkspace));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<Home />);
    await screen.findByRole("heading", { name: "回归测试项目" });

    await user.click(screen.getByRole("button", { name: "查看通知" }));
    expect(screen.getByRole("dialog", { name: "通知" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "关闭通知" }));

    await user.click(screen.getByRole("button", { name: "打开用户信息" }));
    expect(screen.getByRole("dialog", { name: "用户信息" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "关闭" }));

    await user.type(screen.getByRole("combobox", { name: "搜索项目内容" }), "沈雾");
    await user.click(screen.getByRole("option", { name: /沈雾/ }));
    expect(screen.getByRole("heading", { name: "人物设定" })).toBeVisible();

    await user.click(screen.getByRole("button", { name: "刷新数据" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  test("项目切换器整块可点击，并使用站内风格列表切换项目", async () => {
    const secondProject = {
      ...workspace.project!,
      id: "project-2",
      name: "第二个项目",
    };
    const projects = [workspace.project!, secondProject];
    const initialWorkspace = { ...workspace, projects };
    const switchedWorkspace: WorkspaceBootstrap = {
      ...workspace,
      projects,
      activeProjectId: secondProject.id,
      project: secondProject,
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/bootstrap") return jsonResponse(initialWorkspace);
      if (url === "/api/projects/project-2/activate" && init?.method === "POST") {
        return jsonResponse({ activeProjectId: secondProject.id });
      }
      if (url === "/api/bootstrap?projectId=project-2") return jsonResponse(switchedWorkspace);
      throw new Error(`unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<Home />);
    const switcher = await screen.findByRole("combobox", { name: /当前项目/ });
    await user.click(switcher);

    expect(screen.getByRole("listbox", { name: "当前项目" })).toBeVisible();
    expect(screen.getByRole("option", { name: /回归测试项目/ })).toHaveAttribute("aria-selected", "true");
    await user.click(screen.getByRole("option", { name: /第二个项目/ }));

    await waitFor(() => expect(switcher).toHaveTextContent("第二个项目"));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/projects/project-2/activate",
      expect.objectContaining({ method: "POST" }),
    );
  });

  test("制作页 Agent 面板支持拖拽和键盘调整宽度", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(workspace)));
    const user = userEvent.setup();

    const view = render(<Home />);
    await screen.findByRole("heading", { name: "回归测试项目" });
    await user.click(
      within(screen.getByRole("navigation", { name: "项目制作阶段" })).getByRole(
        "button",
        { name: /故事设计/ },
      ),
    );

    const separator = screen.getByRole("separator", { name: "调整 Agent 面板宽度" });
    expect(separator).toHaveAttribute("aria-valuenow", "336");
    fireEvent.keyDown(separator, { key: "ArrowLeft" });
    expect(separator).toHaveAttribute("aria-valuenow", "352");

    fireEvent.pointerDown(separator, { button: 0, clientX: 700, pointerId: 1 });
    fireEvent.pointerMove(separator, { clientX: 650, pointerId: 1 });
    fireEvent.pointerUp(separator, { clientX: 650, pointerId: 1 });

    expect(separator).toHaveAttribute("aria-valuenow", "402");
    expect(view.container.querySelector(".workspace-layout")).toHaveStyle("--stage-agent-width: 402px");
    expect(window.localStorage.getItem("frameflow.stageAgentWidth")).toBe("402");
  });

  test("ModelCenter 加载数据后点击“添加模型”显示模型 dialog", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse([])));
    const user = userEvent.setup();

    render(<ModelCenter />);

    const addButton = await screen.findByRole("button", { name: "添加模型" });
    await user.click(addButton);

    expect(screen.getByRole("dialog", { name: "添加 AI 模型" })).toBeVisible();
    expect(screen.getByRole("textbox", { name: /显示名称/ })).toBeVisible();
  });

  test("ModelCenter 本地开发表单接受严格回环 HTTP 模型地址", async () => {
    let savedBody: Record<string, unknown> | null = null;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        savedBody = JSON.parse(String(init.body)) as Record<string, unknown>;
        return jsonResponse({});
      }
      return jsonResponse([]);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<ModelCenter />);
    await user.click(await screen.findByRole("button", { name: "添加模型" }));
    const dialog = screen.getByRole("dialog", { name: "添加 AI 模型" });
    await user.type(within(dialog).getByRole("textbox", { name: /显示名称/ }), "gpt-5.4");
    await user.type(within(dialog).getByRole("textbox", { name: /服务商/ }), "OpenAI-compatible");
    await user.type(within(dialog).getByRole("textbox", { name: /模型 ID/ }), "gpt-5.4");
    await user.type(within(dialog).getByRole("textbox", { name: /API 地址/ }), "http://127.0.0.1:8317/v1");
    await user.type(within(dialog).getByLabelText("API Key"), "test-local-key");
    await user.click(within(dialog).getByRole("button", { name: "保存模型" }));

    await waitFor(() => expect(savedBody).not.toBeNull());
    expect(savedBody).toMatchObject({ endpoint: "http://127.0.0.1:8317/v1", modelId: "gpt-5.4" });
  });

  test("AssetManager 点击“新增资产”显示资产 dialog", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse([])));
    const user = userEvent.setup();

    render(<AssetManager projectId="project-1" projectName="回归测试项目" />);

    const addButton = await screen.findByRole("button", { name: "新增资产" });
    await user.click(addButton);

    expect(screen.getByRole("dialog", { name: "新增项目资产" })).toBeVisible();
    expect(screen.getByRole("textbox", { name: /资产名称/ })).toBeVisible();
    expect(screen.getByRole("combobox", { name: /介质属性/ })).toBeVisible();
    expect(screen.getByRole("combobox", { name: /制作分类/ })).toBeVisible();
  });

  test("AssetManager 点击“AI 创建资产”显示生成 dialog", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse([])));
    const user = userEvent.setup();
    render(<AssetManager projectId="project-1" projectName="回归测试项目" />);

    await user.click(await screen.findByRole("button", { name: "AI 创建资产" }));

    expect(screen.getByRole("dialog", { name: "AI 创建资产" })).toBeVisible();
    expect(screen.getByRole("combobox", { name: /生成模型/ })).toBeVisible();
    expect(screen.getByRole("textbox", { name: /生成提示词/ })).toBeVisible();
  });
});

test("模块主按钮颜色不会被高 specificity 的继承重置覆盖", async () => {
  const cssPath = resolve(process.cwd(), "app/components/PlatformModules.module.css");
  const css = await readFile(cssPath, "utf8");
  const highSpecificityReset = css.match(
    /\.moduleRoot\s+button\s*,[\s\S]*?\.moduleRoot\s+textarea\s*\{([\s\S]*?)\}/,
  );
  const primaryButton = css.match(/\.primaryButton\s*\{([\s\S]*?)\}/);

  expect(highSpecificityReset?.[1] ?? "").not.toMatch(/\bcolor\s*:\s*inherit\s*;/);
  expect(primaryButton?.[1]).toMatch(/\bcolor\s*:\s*#fff\s*;/);
  expect(primaryButton?.[1]).toMatch(/\bbackground\s*:\s*var\(--module-ink\)\s*;/);
});
