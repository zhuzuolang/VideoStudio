import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vitest";
import Home from "@/app/page";
import type { ProjectScript, WorkspaceBootstrap } from "@/lib/platform-types";

const NOW = "2026-08-23T08:00:00.000Z";
const PROJECT_ID = "project-blank";

function blankWorkspace(): WorkspaceBootstrap {
  const project = {
    id: PROJECT_ID,
    name: "空白回归项目",
    genre: "剧情",
    status: "planning",
    description: "验证空白项目进度与首份剧本创建。",
    episodeCount: 12,
    singleEpisodeDuration: 120,
    aspectRatio: "9:16",
    targetPlatform: "测试平台",
    updatedAt: NOW,
  };
  return {
    workspace: {
      userId: "progress-test-user",
      email: "progress@example.test",
      displayName: "进度回归用户",
      activeProjectId: PROJECT_ID,
    },
    projects: [project],
    activeProjectId: PROJECT_ID,
    project,
    story: {
      projectId: PROJECT_ID,
      title: project.name,
      logline: "",
      synopsis: "",
      worldview: "",
      coreConflict: "",
      themes: [],
      styleReference: "",
      storyBible: "",
      status: "draft",
      updatedAt: NOW,
    },
    episodes: [],
    characters: [],
    scripts: [],
    assets: [],
    models: [],
    agentRuns: [],
  };
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ data }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("空白项目进度与首份剧本", () => {
  test("空 story 与空制作数据全部从 0% 开始", async () => {
    const workspace = blankWorkspace();
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(workspace)));

    render(<Home />);

    await screen.findByRole("heading", { name: workspace.project?.name });
    const projectNavigation = within(screen.getByRole("navigation", { name: "项目制作阶段" }));

    const overviewButton = projectNavigation.getByRole("button", { name: /项目总览/ });
    expect(overviewButton).toHaveTextContent("项目完整度");
    expect(within(overviewButton).getAllByText("0%")).toHaveLength(1);
    expect(projectNavigation.getByRole("button", { name: /故事设计/ })).toHaveTextContent("未开始");
    expect(projectNavigation.getByRole("button", { name: /剧本工作台/ })).toHaveTextContent("0 份");

    const progressCard = screen.getByText("项目完整度", { selector: "article.metric-card > span" }).closest("article");
    expect(progressCard).not.toBeNull();
    expect(within(progressCard as HTMLElement).getByText("0%")).toBeVisible();
  });

  test("空正文剧本计入侧栏数量但不提高项目完整度", async () => {
    const workspace = blankWorkspace();
    workspace.scripts = [{
      id: "script-draft",
      projectId: PROJECT_ID,
      title: "仅标题草稿",
      status: "draft",
      bodyText: "",
      scenes: [],
    }];
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(workspace)));

    render(<Home />);
    await screen.findByRole("heading", { name: workspace.project?.name });

    const projectNavigation = within(screen.getByRole("navigation", { name: "项目制作阶段" }));
    expect(projectNavigation.getByRole("button", { name: /剧本工作台/ })).toHaveTextContent("1 份");
    expect(projectNavigation.getByRole("button", { name: /项目总览/ })).toHaveTextContent("0%");
    expect(within(screen.getByText("项目完整度", { selector: "article.metric-card > span" }).closest("article") as HTMLElement).getByText("0%")).toBeVisible();
  });

  test("有未保存草稿时关闭剧本弹窗需要确认", async () => {
    const workspace = blankWorkspace();
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(workspace)));
    const confirmMock = vi.fn(() => false);
    vi.stubGlobal("confirm", confirmMock);
    const user = userEvent.setup();

    render(<Home />);
    await screen.findByRole("heading", { name: workspace.project?.name });
    const projectNavigation = within(screen.getByRole("navigation", { name: "项目制作阶段" }));
    await user.click(projectNavigation.getByRole("button", { name: /剧本工作台/ }));
    await user.click(screen.getByRole("button", { name: "创建第一份剧本" }));
    const titleInput = screen.getByRole("textbox", { name: "剧本标题 *" });
    await user.type(titleInput, "尚未保存的剧本");

    await user.click(screen.getByRole("button", { name: "取消" }));
    expect(confirmMock).toHaveBeenCalledWith("放弃未保存的剧本草稿？");
    expect(screen.getByRole("dialog", { name: "新建剧本" })).toBeVisible();
    expect(titleInput).toHaveValue("尚未保存的剧本");

    confirmMock.mockReturnValue(true);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "新建剧本" })).not.toBeInTheDocument();
  });

  test("可从空状态创建含正文的第一份剧本并刷新项目", async () => {
    let workspace = blankWorkspace();
    const createdScript: ProjectScript = {
      id: "script-first",
      projectId: PROJECT_ID,
      title: "第一份回归剧本",
      status: "draft",
      bodyText: "内景。旧码头仓库。夜。\n沈雾推门而入。",
      scenes: [],
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/bootstrap" || url === `/api/bootstrap?projectId=${PROJECT_ID}`) {
        return jsonResponse(workspace);
      }
      if (url === `/api/projects/${PROJECT_ID}/scripts` && init?.method === "POST") {
        expect(JSON.parse(String(init.body))).toEqual({
          title: createdScript.title,
          episodeId: null,
          bodyText: createdScript.bodyText,
        });
        workspace = { ...workspace, scripts: [createdScript] };
        return jsonResponse({ script: createdScript }, 201);
      }
      throw new Error(`未处理的测试请求：${init?.method ?? "GET"} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<Home />);
    await screen.findByRole("heading", { name: workspace.project?.name });

    const projectNavigation = within(screen.getByRole("navigation", { name: "项目制作阶段" }));
    await user.click(projectNavigation.getByRole("button", { name: /剧本工作台/ }));
    await user.click(screen.getByRole("button", { name: "创建第一份剧本" }));

    await user.type(screen.getByRole("textbox", { name: "剧本标题 *" }), createdScript.title);
    await user.type(screen.getByRole("textbox", { name: "剧本正文（可选）" }), String(createdScript.bodyText));
    await user.click(screen.getByRole("button", { name: "创建剧本" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/projects/${PROJECT_ID}/scripts`,
        expect.objectContaining({ method: "POST" }),
      );
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/bootstrap?projectId=${PROJECT_ID}`,
        expect.objectContaining({ cache: "no-store" }),
      );
    });
    expect(await screen.findByRole("status")).toHaveTextContent("剧本已保存到当前项目。");
    expect((await screen.findAllByText(createdScript.title)).length).toBeGreaterThan(0);
  });
});
