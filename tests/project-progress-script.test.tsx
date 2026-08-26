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

  test("故事设计可按下一集编号新建分集并刷新项目", async () => {
    let workspace = blankWorkspace();
    workspace.episodes = [
      {
        id: "episode-1",
        projectId: PROJECT_ID,
        episodeNo: 1,
        title: "雾港来信",
        summary: "沈雾收到第一封信。",
        hook: "信纸上有陌生指纹。",
        durationSeconds: 120,
        status: "outline",
      },
      {
        id: "episode-2",
        projectId: PROJECT_ID,
        episodeNo: 2,
        title: "潮汐证词",
        summary: "证词把调查引向旧码头。",
        hook: "退潮后露出第二现场。",
        durationSeconds: 120,
        status: "outline",
      },
    ];
    const createdEpisode = {
      id: "episode-3",
      projectId: PROJECT_ID,
      episodeNo: 3,
      title: "第三集 · 回声仓库",
      summary: "沈雾在废弃仓库发现录音来源。",
      hook: "录音里出现了她自己的声音。",
      durationSeconds: 120,
      status: "outline",
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/bootstrap" || url === `/api/bootstrap?projectId=${PROJECT_ID}`) {
        return jsonResponse(workspace);
      }
      if (url === `/api/projects/${PROJECT_ID}/episodes` && init?.method === "POST") {
        expect(JSON.parse(String(init.body))).toEqual({
          episodeNo: createdEpisode.episodeNo,
          title: createdEpisode.title,
          summary: createdEpisode.summary,
          hook: createdEpisode.hook,
          durationSeconds: createdEpisode.durationSeconds,
          status: createdEpisode.status,
        });
        workspace = { ...workspace, episodes: [...workspace.episodes, createdEpisode] };
        return jsonResponse({ episode: createdEpisode }, 201);
      }
      throw new Error(`未处理的测试请求：${init?.method ?? "GET"} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<Home />);
    await screen.findByRole("heading", { name: workspace.project?.name });
    const projectNavigation = within(screen.getByRole("navigation", { name: "项目制作阶段" }));
    await user.click(projectNavigation.getByRole("button", { name: /故事设计/ }));
    await user.click(screen.getByRole("button", { name: "新建分集" }));

    const dialog = screen.getByRole("dialog", { name: "新建分集" });
    expect(within(dialog).getByRole("spinbutton", { name: "集数 *" })).toHaveValue(3);
    expect(within(dialog).getByRole("spinbutton", { name: "预计时长（秒） *" })).toHaveValue(120);
    const titleInput = within(dialog).getByRole("textbox", { name: "分集标题 *" });
    expect(titleInput).toHaveValue("第 3 集");
    await user.clear(titleInput);
    await user.type(titleInput, createdEpisode.title);
    await user.type(within(dialog).getByRole("textbox", { name: "本集梗概" }), createdEpisode.summary);
    await user.type(within(dialog).getByRole("textbox", { name: "结尾钩子" }), createdEpisode.hook);
    await user.click(within(dialog).getByRole("button", { name: "创建分集" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/projects/${PROJECT_ID}/episodes`,
        expect.objectContaining({ method: "POST" }),
      );
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/bootstrap?projectId=${PROJECT_ID}`,
        expect.objectContaining({ cache: "no-store" }),
      );
    });
    expect(await screen.findByText(createdEpisode.title)).toBeVisible();
    expect(screen.getByText(createdEpisode.hook)).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent("第 3 集已创建");
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

  test("可用真实分集编辑默认剧本，并在删除后稳定选中剩余剧本", async () => {
    let workspace = blankWorkspace();
    workspace.episodes = [
      {
        id: "episode-1",
        projectId: PROJECT_ID,
        episodeNo: 1,
        title: "雾港来信",
        summary: "沈雾收到一封没有寄件人的信。",
        hook: "信纸上出现了失踪者的指纹。",
        durationSeconds: 120,
        status: "outline",
      },
      {
        id: "episode-2",
        projectId: PROJECT_ID,
        episodeNo: 2,
        title: "潮汐证词",
        summary: "旧码头的证词互相矛盾。",
        hook: "退潮后露出第二现场。",
        durationSeconds: 120,
        status: "outline",
      },
    ];
    const firstScript: ProjectScript = {
      id: "script-first",
      projectId: PROJECT_ID,
      episodeId: "episode-1",
      title: "第一集初稿",
      version: 1,
      status: "draft",
      bodyText: "内景。修复室。夜。",
      scenes: [],
    };
    const remainingScript: ProjectScript = {
      id: "script-second",
      projectId: PROJECT_ID,
      episodeId: "episode-2",
      title: "第二集初稿",
      version: 1,
      status: "draft",
      bodyText: "外景。旧码头。清晨。",
      scenes: [],
    };
    workspace.scripts = [firstScript, remainingScript];

    const editedScript: ProjectScript = {
      ...firstScript,
      episodeId: "episode-2",
      title: "第一集修订稿",
      version: 2,
      status: "review",
      bodyText: "内景。修复室。深夜。沈雾拆开第二封信。",
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/bootstrap" || url === `/api/bootstrap?projectId=${PROJECT_ID}`) {
        return jsonResponse(workspace);
      }
      if (url === `/api/projects/${PROJECT_ID}/scripts/${firstScript.id}` && init?.method === "PATCH") {
        expect(JSON.parse(String(init.body))).toEqual({
          title: editedScript.title,
          episodeId: editedScript.episodeId,
          bodyText: editedScript.bodyText,
          status: editedScript.status,
          version: editedScript.version,
        });
        workspace = {
          ...workspace,
          scripts: workspace.scripts.map((script) => script.id === editedScript.id ? editedScript : script),
        };
        return jsonResponse({ script: editedScript });
      }
      if (url === `/api/projects/${PROJECT_ID}/scripts/${firstScript.id}` && init?.method === "DELETE") {
        workspace = {
          ...workspace,
          scripts: workspace.scripts.filter((script) => script.id !== firstScript.id),
        };
        return new Response(null, { status: 204 });
      }
      throw new Error(`未处理的测试请求：${init?.method ?? "GET"} ${url}`);
    });
    const confirmMock = vi.fn(() => true);
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("confirm", confirmMock);
    const user = userEvent.setup();

    render(<Home />);
    await screen.findByRole("heading", { name: workspace.project?.name });
    const projectNavigation = within(screen.getByRole("navigation", { name: "项目制作阶段" }));
    await user.click(projectNavigation.getByRole("button", { name: /剧本工作台/ }));

    expect(screen.getByText(firstScript.bodyText as string)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "编辑剧本" }));

    const editor = screen.getByRole("dialog", { name: "编辑剧本" });
    const episodeSelect = within(editor).getByRole("combobox", { name: /关联已有分集/ });
    expect(within(episodeSelect).getByRole("option", { name: /第 1 集 · 雾港来信.*已有 1 份稿件/ })).toBeVisible();
    expect(within(episodeSelect).getByRole("option", { name: /第 2 集 · 潮汐证词.*已有 1 份稿件/ })).toBeVisible();

    const titleInput = within(editor).getByRole("textbox", { name: "剧本标题 *" });
    const bodyInput = within(editor).getByRole("textbox", { name: "剧本正文（可选）" });
    await user.clear(titleInput);
    await user.type(titleInput, editedScript.title);
    await user.selectOptions(episodeSelect, String(editedScript.episodeId));
    await user.clear(bodyInput);
    await user.type(bodyInput, String(editedScript.bodyText));
    await user.selectOptions(within(editor).getByRole("combobox", { name: /状态/ }), String(editedScript.status));
    const versionInput = within(editor).getByRole("spinbutton", { name: /版本/ });
    await user.clear(versionInput);
    await user.type(versionInput, String(editedScript.version));
    await user.click(within(editor).getByRole("button", { name: "保存修改" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/projects/${PROJECT_ID}/scripts/${firstScript.id}`,
        expect.objectContaining({ method: "PATCH" }),
      );
    });
    expect(await screen.findByText(String(editedScript.bodyText))).toBeVisible();

    await user.click(screen.getByRole("button", { name: "删除剧本" }));
    expect(confirmMock).toHaveBeenCalled();
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/projects/${PROJECT_ID}/scripts/${firstScript.id}`,
        expect.objectContaining({ method: "DELETE" }),
      );
    });
    expect(await screen.findByText(String(remainingScript.bodyText))).toBeVisible();
    expect(screen.queryByText(String(editedScript.bodyText))).not.toBeInTheDocument();
  });
});
