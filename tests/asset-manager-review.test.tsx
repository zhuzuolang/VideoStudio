import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vitest";
import AssetManager from "@/app/components/AssetManager";
import type { AiModel, ProjectAsset } from "@/lib/platform-types";

const NOW = "2026-08-23T00:00:00.000Z";

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function errorResponse(message: string): Response {
  return new Response(JSON.stringify({ error: { message } }), {
    status: 503,
    headers: { "Content-Type": "application/json" },
  });
}

function makeAsset(overrides: Partial<ProjectAsset> = {}): ProjectAsset {
  return {
    id: "asset-1",
    projectId: "project-1",
    name: "雨夜参考图",
    mediaType: "image",
    category: "reference",
    description: "街道氛围参考",
    sourceUrl: "https://example.test/source.png",
    thumbnailUrl: "https://example.test/thumb.png",
    status: "ready",
    metadata: null,
    relations: [],
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeModel(overrides: Partial<AiModel>): AiModel {
  return {
    id: "model-1",
    name: "Seedream 生成",
    provider: "test",
    modelId: "seedream-4",
    level: "standard",
    endpoint: "https://example.test/models",
    iconUrl: null,
    enabled: true,
    parameters: { capabilities: ["image-generation"] },
    hasApiKey: true,
    apiKeyMasked: "sk-***",
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AssetManager 审查项回归", () => {
  test("辅助数据失败不会阻断资产，并提供独立重试与可访问筛选", async () => {
    const relations = Array.from({ length: 5 }, (_, index) => ({
      id: `relation-${index}`,
      targetType: "asset" as const,
      targetId: `target-${index}`,
      targetName: `关联资产 ${index + 1}`,
      targetMediaType: "image" as const,
      targetCategory: "reference" as const,
      relationType: "reference",
      note: "",
      direction: "outgoing" as const,
    }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/assets"))
          return jsonResponse([makeAsset({ relations })]);
        if (url.endsWith("/characters")) return errorResponse("人物服务不可用");
        if (url === "/api/models") return errorResponse("模型服务不可用");
        throw new Error(`unexpected request: ${url}`);
      }),
    );

    render(<AssetManager projectId="project-1" />);

    expect(
      await screen.findByRole("heading", { name: "雨夜参考图" }),
    ).toBeVisible();
    expect(screen.getByText("另有 1 条")).toBeVisible();
    expect(await screen.findByText(/人物关联选项加载失败/)).toBeVisible();
    expect(await screen.findByText(/图像模型选项加载失败/)).toBeVisible();
    expect(screen.getByRole("button", { name: "重试人物选项" })).toBeVisible();
    expect(screen.getByRole("button", { name: "重试模型选项" })).toBeVisible();

    const mediaGroup = screen.getByRole("group", { name: "按介质属性筛选" });
    const categoryGroup = screen.getByRole("group", { name: "按制作分类筛选" });
    expect(
      within(mediaGroup).getByRole("button", { name: "全部" }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(
      within(categoryGroup).getByRole("button", { name: "全部" }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  test("资产刷新失败时保留已加载卡片并提供重试", async () => {
    let assetLoads = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/assets")) {
          assetLoads += 1;
          return assetLoads === 1
            ? jsonResponse([makeAsset()])
            : errorResponse("资产服务暂时不可用");
        }
        if (url.endsWith("/characters") || url === "/api/models")
          return jsonResponse([]);
        throw new Error(`unexpected request: ${url}`);
      }),
    );
    const view = render(<AssetManager projectId="project-1" refreshKey={0} />);

    expect(
      await screen.findByRole("heading", { name: "雨夜参考图" }),
    ).toBeVisible();
    view.rerender(<AssetManager projectId="project-1" refreshKey={1} />);

    expect(
      await screen.findByRole("button", { name: "重试资产列表" }),
    ).toBeVisible();
    expect(screen.getByRole("heading", { name: "雨夜参考图" })).toBeVisible();
  });

  test("编辑可显式清空 URL，保存期间锁定字段", async () => {
    const asset = makeAsset();
    let resolvePatch: ((response: Response) => void) | undefined;
    const patchResponse = new Promise<Response>((resolve) => {
      resolvePatch = resolve;
    });
    let patchBody: unknown;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (init?.method === "PATCH") {
          patchBody = JSON.parse(String(init.body));
          return patchResponse;
        }
        if (url.endsWith("/assets")) return jsonResponse([asset]);
        if (url.endsWith("/characters") || url === "/api/models")
          return jsonResponse([]);
        throw new Error(`unexpected request: ${url}`);
      }),
    );
    const user = userEvent.setup();

    render(<AssetManager projectId="project-1" />);
    await user.click(
      await screen.findByRole("button", { name: "编辑资产 雨夜参考图" }),
    );
    const sourceInput = screen.getByRole("textbox", { name: "外部地址" });
    const thumbnailInput = screen.getByRole("textbox", { name: "缩略图地址" });
    await user.clear(sourceInput);
    await user.clear(thumbnailInput);
    await user.click(screen.getByRole("button", { name: "保存资产" }));

    await waitFor(() => expect(sourceInput).toBeDisabled());
    expect(thumbnailInput).toBeDisabled();
    expect(screen.getByRole("button", { name: "关闭资产表单" })).toBeDisabled();
    expect(patchBody).toMatchObject({ sourceUrl: null, thumbnailUrl: null });

    resolvePatch?.(
      jsonResponse({ ...asset, sourceUrl: null, thumbnailUrl: null }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "编辑项目资产" })).toBeNull(),
    );
  });

  test("删除期间禁用编辑，更新预览 URL 后重新显示图片", async () => {
    const firstAsset = makeAsset({
      thumbnailUrl: "https://example.test/bad.png",
    });
    const nextAsset = makeAsset({
      thumbnailUrl: "https://example.test/good.png",
    });
    let assetLoads = 0;
    let resolveDelete: ((response: Response) => void) | undefined;
    const deleteResponse = new Promise<Response>((resolve) => {
      resolveDelete = resolve;
    });
    vi.stubGlobal(
      "confirm",
      vi.fn(() => true),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (init?.method === "DELETE") return deleteResponse;
        if (url.endsWith("/assets")) {
          assetLoads += 1;
          return jsonResponse([assetLoads === 1 ? firstAsset : nextAsset]);
        }
        if (url.endsWith("/characters") || url === "/api/models")
          return jsonResponse([]);
        throw new Error(`unexpected request: ${url}`);
      }),
    );
    const user = userEvent.setup();
    const view = render(<AssetManager projectId="project-1" refreshKey={0} />);

    const failedPreview = await screen.findByAltText("雨夜参考图预览");
    fireEvent.error(failedPreview);
    expect(failedPreview).toHaveStyle({ display: "none" });

    view.rerender(<AssetManager projectId="project-1" refreshKey={1} />);
    await waitFor(() =>
      expect(screen.getByAltText("雨夜参考图预览")).toHaveAttribute(
        "src",
        "https://example.test/good.png",
      ),
    );
    const recoveredPreview = screen.getByAltText("雨夜参考图预览");
    expect(recoveredPreview).not.toHaveStyle({ display: "none" });

    await user.click(
      screen.getByRole("button", { name: "删除资产 雨夜参考图" }),
    );
    expect(
      screen.getByRole("button", { name: "编辑资产 雨夜参考图" }),
    ).toBeDisabled();
    resolveDelete?.(jsonResponse(null));
  });

  test("AI 创建仅展示真正支持生图的模型", async () => {
    const models = [
      makeModel({
        id: "vision",
        name: "Image Vision",
        modelId: "vision-understanding",
        parameters: { capabilities: ["image"] },
      }),
      makeModel({ id: "generation", name: "正式生图模型" }),
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "/api/models") return jsonResponse(models);
        return jsonResponse([]);
      }),
    );
    const user = userEvent.setup();

    render(<AssetManager projectId="project-1" />);
    await user.click(
      await screen.findByRole("button", { name: "AI 创建资产" }),
    );

    const select = screen.getByRole("combobox", { name: "图像模型 *" });
    expect(
      within(select).queryByRole("option", { name: "Image Vision" }),
    ).toBeNull();
    expect(
      within(select).getByRole("option", { name: "正式生图模型" }),
    ).toBeVisible();
  });
});
