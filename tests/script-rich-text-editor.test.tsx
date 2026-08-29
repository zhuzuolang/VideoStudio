import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vitest";
import Home from "@/app/page";
import ScriptRichTextEditor, {
  serializeScriptMention,
  tokenizeScriptMentions,
  type ScriptMentionTarget,
} from "@/app/components/ScriptRichTextEditor";
import type { WorkspaceBootstrap } from "@/lib/platform-types";

const PROJECT_ID = "project-script-mentions";
const SCRIPT_ID = "script-mention-scene";

function mentionWorkspace(): WorkspaceBootstrap {
  const project = {
    id: PROJECT_ID,
    name: "水乡短片",
    genre: "剧情",
    status: "developing",
    description: "验证剧本中的项目资产引用。",
    episodeCount: 1,
    singleEpisodeDuration: 120,
    aspectRatio: "16:9",
    targetPlatform: "测试平台",
  };
  return {
    workspace: {
      userId: "mention-user",
      email: "mention@example.test",
      displayName: "剧本编辑用户",
      activeProjectId: PROJECT_ID,
    },
    projects: [project],
    activeProjectId: PROJECT_ID,
    project,
    story: null,
    episodes: [],
    characters: [{
      id: "character-zhu",
      name: "朱佐浪",
      role: "船夫",
      bio: "熟悉水路的年轻船夫。",
      appearance: "",
      personality: "",
      arc: "",
      voice: "",
      status: "locked",
    }],
    scripts: [{
      id: SCRIPT_ID,
      projectId: PROJECT_ID,
      title: "湖上相逢",
      version: 1,
      status: "draft",
      bodyText: "旧正文",
      scenes: [],
    }],
    assets: [{
      id: "asset-boat",
      projectId: PROJECT_ID,
      name: "乌篷船",
      mediaType: "image",
      category: "prop",
      description: "朱佐浪使用的小船",
      sourceUrl: null,
      thumbnailUrl: null,
      status: "ready",
      metadata: null,
      relations: [],
      relationsLoaded: true,
      createdAt: "2026-08-30T00:00:00.000Z",
      updatedAt: "2026-08-30T00:00:00.000Z",
    }],
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

describe("剧本富文本资产引用", () => {
  test("稳定引用会按 ID 解析最新名称，并兼容旧的 @名称正文", () => {
    const target: ScriptMentionTarget = {
      id: "asset-1",
      name: "新船名",
      type: "asset",
      category: "prop",
    };
    expect(serializeScriptMention({ ...target, name: "旧船名" })).toBe("@[旧船名](asset:asset-1)");

    const stableTokens = tokenizeScriptMentions("驶向 @[旧船名](asset:asset-1)", [target]);
    expect(stableTokens).toEqual([
      { type: "text", value: "驶向 " },
      { type: "mention", target },
    ]);
    expect(tokenizeScriptMentions("@新船名靠岸", [target])).toEqual([
      { type: "mention", target },
      { type: "text", value: "靠岸" },
    ]);
  });

  test("输入 @ 可筛选并插入项目人物，Escape 只关闭联想菜单", async () => {
    let workspace = mentionWorkspace();
    let savedBody = "";
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/bootstrap" || url === `/api/bootstrap?projectId=${PROJECT_ID}`) {
        return jsonResponse(workspace);
      }
      if (url === `/api/projects/${PROJECT_ID}/scripts/${SCRIPT_ID}` && init?.method === "PATCH") {
        const payload = JSON.parse(String(init.body)) as { bodyText: string };
        savedBody = payload.bodyText;
        workspace = {
          ...workspace,
          scripts: workspace.scripts.map((script) => script.id === SCRIPT_ID
            ? { ...script, ...payload }
            : script),
        };
        return jsonResponse({ script: workspace.scripts[0] });
      }
      throw new Error(`未处理的测试请求：${init?.method ?? "GET"} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<Home />);
    await screen.findByRole("heading", { name: workspace.project?.name });
    const navigation = within(screen.getByRole("navigation", { name: "项目制作阶段" }));
    await user.click(navigation.getByRole("button", { name: /剧本工作台/ }));
    await user.click(screen.getByRole("button", { name: "编辑剧本" }));

    const dialog = screen.getByRole("dialog", { name: "编辑剧本" });
    const editor = within(dialog).getByRole("textbox", { name: "剧本正文（可选）" });
    const combobox = within(dialog).getByRole("combobox", { name: "项目资产引用编辑器" });

    await user.click(within(dialog).getByRole("button", { name: "引用项目资产" }));
    expect(combobox).toHaveAttribute("aria-expanded", "true");
    await user.keyboard("{Escape}");
    expect(editor).toHaveTextContent("旧正文");
    expect(dialog).toBeVisible();

    await user.clear(editor);
    await user.type(editor, "@乌");
    expect(within(dialog).getByRole("listbox", { name: "项目资产引用" })).toBeVisible();
    expect(within(dialog).getByRole("option", { name: /乌篷船/ })).toBeVisible();
    expect(within(dialog).queryByRole("option", { name: /^朱佐浪/ })).not.toBeInTheDocument();

    await user.keyboard("{Escape}");
    expect(within(dialog).queryByRole("listbox", { name: "项目资产引用" })).not.toBeInTheDocument();
    expect(dialog).toBeVisible();

    await user.clear(editor);
    await user.type(editor, "@");
    fireEvent.compositionStart(editor);
    fireEvent.keyDown(editor, { key: "Enter", keyCode: 229, isComposing: true });
    expect(editor).toHaveTextContent("@");
    expect(within(dialog).getByRole("listbox", { name: "项目资产引用" })).toBeVisible();
    fireEvent.compositionEnd(editor);

    await user.clear(editor);
    await user.type(editor, "@朱");
    const characterOption = within(within(dialog).getByRole("listbox", { name: "项目资产引用" }))
      .getByText("朱佐浪")
      .closest("button");
    expect(characterOption).not.toBeNull();
    await user.click(characterOption as HTMLButtonElement);
    await user.type(editor, "在湖上划船");
    expect(editor.textContent?.replace(/\u200B/g, "")).toBe("@朱佐浪在湖上划船");

    await user.click(within(dialog).getByRole("button", { name: "保存修改" }));
    await waitFor(() => {
      expect(savedBody).toBe("@[朱佐浪](character:character-zhu)在湖上划船");
    });
    expect(await screen.findByText("@朱佐浪")).toBeVisible();
    expect(screen.getByText("在湖上划船")).toBeVisible();
  });

  test("光标停在已保存引用之后不会把旧标签重新当成查询词", () => {
    const target: ScriptMentionTarget = {
      id: "character-zhu",
      name: "朱佐浪",
      type: "character",
      category: "character",
    };
    render(
      <ScriptRichTextEditor
        value="@[朱佐浪](character:character-zhu)"
        targets={[target]}
        onChange={() => undefined}
      />,
    );
    const editor = screen.getByRole("textbox", { name: "剧本正文（可选）" });
    const mention = screen.getByText("@朱佐浪");
    const range = document.createRange();
    range.setStartAfter(mention);
    range.collapse(true);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    fireEvent.keyUp(editor, { key: "ArrowRight" });

    expect(screen.queryByRole("listbox", { name: "项目资产引用" })).not.toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "项目资产引用编辑器" })).toHaveAttribute("aria-expanded", "false");
  });
});
