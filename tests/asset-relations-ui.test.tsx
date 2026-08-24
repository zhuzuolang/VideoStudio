import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vitest";
import AssetManager from "@/app/components/AssetManager";
import type {
  AssetRelation,
  ProjectAsset,
} from "@/lib/platform-types";

const NOW = "2026-08-24T00:00:00.000Z";

type RelationAwareAsset = ProjectAsset & { relationsLoaded: boolean };

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function makeAsset(
  overrides: Partial<RelationAwareAsset> = {},
): RelationAwareAsset {
  return {
    id: "asset-concept",
    projectId: "project-1",
    name: "角色概念图",
    mediaType: "image",
    category: "character",
    description: "主角造型与色彩基准",
    contentUrl: "/api/projects/project-1/assets/asset-concept/content",
    sourceUrl: null,
    thumbnailUrl: null,
    status: "ready",
    metadata: null,
    relations: [],
    relationsLoaded: true,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } as RelationAwareAsset;
}

function makeRelation(overrides: Partial<AssetRelation> = {}): AssetRelation {
  return {
    id: "relation-1",
    targetType: "asset",
    targetId: "asset-reference",
    targetName: "雨夜构图",
    targetMediaType: "image",
    targetCategory: "reference",
    relationType: "references",
    note: "光影参考",
    direction: "outgoing",
    ...overrides,
  };
}

function installAssetApi(
  assets: RelationAwareAsset[],
  onPatch?: (body: Record<string, unknown>) => void,
) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/assets/generate")) {
        return jsonResponse({ generations: [] });
      }
      if (init?.method === "PATCH") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        onPatch?.(body);
        const id = decodeURIComponent(url.split("/").at(-1) ?? "");
        return jsonResponse(assets.find((asset) => asset.id === id) ?? assets[0]);
      }
      if (url.endsWith("/assets")) return jsonResponse(assets);
      if (url.endsWith("/characters") || url === "/api/models") {
        return jsonResponse([]);
      }
      throw new Error(`unexpected request: ${url}`);
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("资产关联管理", () => {
  test("卡片使用正反向语义标签，关系可跳转到目标预览，预览按方向分组", async () => {
    const concept = makeAsset({
      relations: [
        makeRelation(),
        makeRelation({
          id: "relation-incoming",
          targetId: "asset-poster",
          targetName: "首发海报",
          relationType: "references",
          note: "使用角色主视觉",
          direction: "incoming",
        }),
      ],
    });
    const reference = makeAsset({
      id: "asset-reference",
      name: "雨夜构图",
      category: "reference",
      description: "雨夜街道构图参考",
      contentUrl: "/api/projects/project-1/assets/asset-reference/content",
    });
    const poster = makeAsset({
      id: "asset-poster",
      name: "首发海报",
      category: "reference",
      contentUrl: "/api/projects/project-1/assets/asset-poster/content",
    });
    installAssetApi([concept, reference, poster]);
    const user = userEvent.setup();

    render(<AssetManager projectId="project-1" />);

    const outgoingChip = await screen.findByRole("button", {
      name: "参考 · 雨夜构图",
    });
    expect(
      screen.getByRole("button", { name: "被参考 · 首发海报" }),
    ).toBeVisible();

    const relationFilters = screen.getByRole("group", {
      name: "按关联关系筛选",
    });
    await user.click(
      within(relationFilters).getByRole("button", { name: "参考" }),
    );
    expect(
      screen.getByRole("button", { name: "查看资产 角色概念图" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "查看资产 雨夜构图" }),
    ).toBeNull();
    await user.click(
      within(relationFilters).getByRole("button", { name: "全部" }),
    );

    await user.click(outgoingChip);
    let preview = screen.getByRole("dialog", { name: "雨夜构图" });
    expect(
      within(preview).getByRole("img", { name: "雨夜构图 大图预览" }),
    ).toHaveAttribute(
      "src",
      "/api/projects/project-1/assets/asset-reference/content",
    );
    expect(within(preview).getByRole("tab", { name: "预览" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(
      within(preview).getByRole("tab", { name: /^关联(?:\s|$)/ }),
    ).toBeVisible();

    await user.click(within(preview).getByRole("button", { name: "关闭资产预览" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "雨夜构图" })).toBeNull(),
    );
    await user.click(screen.getByRole("button", { name: "查看资产 角色概念图" }));

    preview = screen.getByRole("dialog", { name: "角色概念图" });
    const relationsTab = within(preview).getByRole("tab", {
      name: /^关联(?:\s|$)/,
    });
    await user.click(relationsTab);
    expect(relationsTab).toHaveAttribute("aria-selected", "true");
    expect(within(preview).getByRole("heading", { name: "关联到" })).toBeVisible();
    expect(within(preview).getByRole("heading", { name: "被关联" })).toBeVisible();
    expect(
      within(preview).getByRole("button", { name: "参考 · 雨夜构图" }),
    ).toBeVisible();
    expect(
      within(preview).getByRole("button", { name: "被参考 · 首发海报" }),
    ).toBeVisible();
    expect(within(preview).getByText("光影参考")).toBeVisible();
    expect(within(preview).getByText("使用角色主视觉")).toBeVisible();
  });

  test("编辑器可搜索目标、选择关系类型、填写备注和增删关系，PATCH 保留完整关系对象", async () => {
    const concept = makeAsset({
      relations: [
        makeRelation({
          id: "relation-keep",
          targetId: "asset-base",
          targetName: "原始构图",
          relationType: "derived_from",
          note: "保留原始构图",
        }),
        makeRelation({
          id: "relation-remove",
          targetId: "asset-remove",
          targetName: "待移除资产",
          relationType: "paired_with",
          note: "旧的临时配套",
        }),
        makeRelation({
          id: "relation-incoming",
          targetId: "asset-owner",
          targetName: "引用方海报",
          relationType: "references",
          note: "入向关系只读，不应写回当前资产",
          direction: "incoming",
        }),
      ],
    });
    const base = makeAsset({ id: "asset-base", name: "原始构图" });
    const removable = makeAsset({ id: "asset-remove", name: "待移除资产" });
    const nextTarget = makeAsset({ id: "asset-new", name: "新增目标资产" });
    const owner = makeAsset({ id: "asset-owner", name: "引用方海报" });
    let patchBody: Record<string, unknown> | undefined;
    installAssetApi([concept, base, removable, nextTarget, owner], (body) => {
      patchBody = body;
    });
    const user = userEvent.setup();

    render(<AssetManager projectId="project-1" />);
    await user.click(
      await screen.findByRole("button", { name: "编辑资产 角色概念图" }),
    );

    const editor = screen.getByRole("dialog", { name: "编辑项目资产" });
    expect(within(editor).getByText("保留原始构图")).toBeVisible();
    const relationType = within(editor).getByRole("combobox", {
      name: "关系类型",
    });
    await user.selectOptions(relationType, "references");

    const targetSearch = within(editor).getByLabelText("搜索关联目标");
    await user.type(targetSearch, "新增目标");
    const targetChoice =
      within(editor).queryByRole("option", { name: /新增目标资产/ }) ??
      within(editor).queryByRole("button", { name: /新增目标资产/ });
    expect(targetChoice).not.toBeNull();
    await user.click(targetChoice!);

    const note = within(editor).getByRole("textbox", { name: "关联备注" });
    expect(note).not.toBeRequired();
    await user.type(note, "补充光影参考");
    await user.click(within(editor).getByRole("button", { name: "添加关联" }));
    expect(within(editor).getByText("补充光影参考")).toBeVisible();

    await user.click(
      within(editor).getByRole("button", { name: "移除关联 待移除资产" }),
    );
    expect(
      within(editor).queryByRole("button", { name: "移除关联 待移除资产" }),
    ).toBeNull();
    await user.click(within(editor).getByRole("button", { name: "保存资产" }));

    await waitFor(() => expect(patchBody).toBeDefined());
    const relations = patchBody?.relations;
    expect(relations).toHaveLength(2);
    expect(relations).toEqual(
      expect.arrayContaining([
        {
          targetType: "asset",
          targetId: "asset-base",
          relationType: "derived_from",
          note: "保留原始构图",
        },
        {
          targetType: "asset",
          targetId: "asset-new",
          relationType: "references",
          note: "补充光影参考",
        },
      ]),
    );
  });

  test("关联数据未完整加载时禁用关系编辑并在普通 PATCH 中省略关系", async () => {
    let patchBody: Record<string, unknown> | undefined;
    installAssetApi([
      makeAsset({
        relations: [],
        relationsLoaded: false,
      }),
    ], (body) => {
      patchBody = body;
    });
    const user = userEvent.setup();

    render(<AssetManager projectId="project-1" />);

    const editButton = await screen.findByRole("button", {
      name: "编辑资产 角色概念图",
    });
    expect(editButton).toHaveAccessibleDescription(/关联数据未完整加载/);
    expect(screen.getByText(/关联数据未完整加载/)).toBeInTheDocument();
    await user.click(editButton);

    const editor = screen.getByRole("dialog", { name: "编辑项目资产" });
    expect(
      within(editor).getByText(/关联数据未完整加载，当前不会覆盖已有关系/),
    ).toBeVisible();
    expect(
      within(editor).getByRole("combobox", { name: "关系类型" }),
    ).toBeDisabled();
    expect(within(editor).getByLabelText("搜索关联目标")).toBeDisabled();
    expect(within(editor).getByRole("textbox", { name: "关联备注" })).toBeDisabled();
    expect(within(editor).getByRole("button", { name: "添加关联" })).toBeDisabled();

    const description = within(editor).getByRole("textbox", {
      name: "用途与描述",
    });
    await user.clear(description);
    await user.type(description, "只更新普通字段");
    await user.click(within(editor).getByRole("button", { name: "保存资产" }));

    await waitFor(() => expect(patchBody).toBeDefined());
    expect(patchBody).toMatchObject({ description: "只更新普通字段" });
    expect(patchBody).not.toHaveProperty("relations");
  });
});
