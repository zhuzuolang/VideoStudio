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
import type { AiModel, AssetGenerationJob, ProjectAsset } from "@/lib/platform-types";

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

function makeGenerationJob(overrides: Partial<AssetGenerationJob> = {}): AssetGenerationJob {
  return {
    id: "gen-1",
    projectId: "project-1",
    clientRequestId: "request-1",
    modelId: "generation",
    modelName: "正式生图模型",
    name: "即时任务卡",
    category: "character",
    prompt: "电影感人物设定",
    size: null,
    aspectRatio: "1:1",
    relations: [],
    status: "queued",
    phase: "queued",
    progress: 0,
    attemptCount: 0,
    errorCode: null,
    errorMessage: null,
    retryable: true,
    assetId: null,
    canRun: true,
    createdAt: NOW,
    updatedAt: NOW,
    startedAt: null,
    completedAt: null,
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
        if (url.endsWith("/assets/generate")) return jsonResponse({ generations: [] });
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
        if (url.endsWith("/assets/generate")) return jsonResponse({ generations: [] });
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
        if (url.endsWith("/assets/generate")) return jsonResponse({ generations: [] });
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
        if (url.endsWith("/assets/generate")) return jsonResponse({ generations: [] });
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
        if (url.endsWith("/assets/generate")) return jsonResponse({ generations: [] });
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

  test("AI 创建后立即关闭弹窗并显示持久任务卡，失败时展示服务端原因", async () => {
    const model = makeModel({ id: "generation", name: "正式生图模型" });
    let resolveRunner: ((response: Response) => void) | undefined;
    const runnerResponse = new Promise<Response>((resolve) => {
      resolveRunner = resolve;
    });
    let serverJob: AssetGenerationJob | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "/api/models") return jsonResponse([model]);
        if (url.endsWith("/characters") || url.endsWith("/assets")) return jsonResponse([]);
        if (url.endsWith("/assets/generate") && init?.method === "POST") {
          serverJob = {
            id: "gen-1",
            projectId: "project-1",
            clientRequestId: String((JSON.parse(String(init.body)) as { clientRequestId: string }).clientRequestId),
            modelId: model.id,
            modelName: model.name,
            name: "浪子基础建模",
            category: "character",
            prompt: "A Pose，漫画风格",
            size: null,
            aspectRatio: "1:1",
            relations: [],
            status: "queued",
            phase: "queued",
            progress: 0,
            attemptCount: 0,
            errorCode: null,
            errorMessage: null,
            retryable: true,
            assetId: null,
            canRun: true,
            createdAt: NOW,
            updatedAt: NOW,
            startedAt: null,
            completedAt: null,
          };
          return new Response(JSON.stringify({ data: { generation: serverJob } }), {
            status: 202,
            headers: { "content-type": "application/json" },
          });
        }
        if (url.endsWith("/assets/generate") && !init?.method) {
          return jsonResponse({ generations: serverJob ? [serverJob] : [] });
        }
        if (url.endsWith("/assets/generate/gen-1") && init?.method === "POST") return runnerResponse;
        throw new Error(`unexpected request: ${url}`);
      }),
    );
    const user = userEvent.setup();
    render(<AssetManager projectId="project-1" />);

    await user.click(await screen.findByRole("button", { name: "AI 创建资产" }));
    await user.type(screen.getByRole("textbox", { name: "资产名称 *" }), "浪子基础建模");
    await user.type(screen.getByRole("textbox", { name: "生成提示词 *" }), "A Pose，漫画风格");
    await user.click(screen.getByRole("button", { name: "创建生成任务" }));

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "AI 创建资产" })).toBeNull());
    expect(await screen.findByRole("heading", { name: "浪子基础建模" })).toBeVisible();
    expect(screen.getByText("生成中")).toBeVisible();

    serverJob = {
      ...(serverJob as unknown as AssetGenerationJob),
      status: "failed",
      phase: "failed",
      progress: 15,
      errorCode: "IMAGE_INVALID_REQUEST",
      errorMessage: "模型不支持当前尺寸，请改用 1024x1024。",
      retryable: false,
      canRun: false,
      attemptCount: 1,
    };
    resolveRunner?.(errorResponse("模型请求失败"));

    expect(await screen.findByText("模型不支持当前尺寸，请改用 1024x1024。")).toBeVisible();
    expect(screen.getByText("IMAGE_INVALID_REQUEST")).toBeVisible();
    expect(screen.getByText("生成失败")).toBeVisible();
  });

  test("创建请求仍在等待时立即显示卡片，空列表刷新不会把卡片覆盖掉", async () => {
    const model = makeModel({ id: "generation", name: "正式生图模型" });
    let resolveEnqueue: ((response: Response) => void) | undefined;
    const enqueueResponse = new Promise<Response>((resolve) => {
      resolveEnqueue = resolve;
    });
    const runnerResponse = new Promise<Response>(() => undefined);
    let generationGets = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "/api/models") return jsonResponse([model]);
        if (url.endsWith("/characters") || url.endsWith("/assets")) return jsonResponse([]);
        if (url.endsWith("/assets/generate") && init?.method === "POST") return enqueueResponse;
        if (url.endsWith("/assets/generate") && !init?.method) {
          generationGets += 1;
          return jsonResponse({ generations: [] });
        }
        if (url.includes("/assets/generate/gen-1") && init?.method === "POST") return runnerResponse;
        throw new Error(`unexpected request: ${url}`);
      }),
    );
    const user = userEvent.setup();
    const view = render(<AssetManager projectId="project-1" refreshKey={0} />);

    await user.click(await screen.findByRole("button", { name: "AI 创建资产" }));
    await user.type(screen.getByRole("textbox", { name: "资产名称 *" }), "即时任务卡");
    await user.type(screen.getByRole("textbox", { name: "生成提示词 *" }), "电影感人物设定");
    await user.click(screen.getByRole("button", { name: "创建生成任务" }));

    expect(await screen.findByRole("heading", { name: "即时任务卡" })).toBeVisible();
    expect(screen.getByText("正在创建任务")).toBeVisible();
    view.rerender(<AssetManager projectId="project-1" refreshKey={1} />);
    await waitFor(() => expect(generationGets).toBeGreaterThanOrEqual(2));
    expect(screen.getByRole("heading", { name: "即时任务卡" })).toBeVisible();

    const job = makeGenerationJob();
    resolveEnqueue?.(new Response(JSON.stringify({ data: { generation: job } }), {
      status: 202,
      headers: { "content-type": "application/json" },
    }));
    expect(await screen.findByText("生成中")).toBeVisible();
  });

  test("提交响应丢失时使用相同幂等标识确认，不会创建第二个任务", async () => {
    const model = makeModel({ id: "generation", name: "正式生图模型" });
    const runnerResponse = new Promise<Response>(() => undefined);
    const idempotencyKeys: string[] = [];
    const clientRequestIds: string[] = [];
    let enqueueCalls = 0;
    let serverJob: AssetGenerationJob | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "/api/models") return jsonResponse([model]);
        if (url.endsWith("/characters") || url.endsWith("/assets")) return jsonResponse([]);
        if (url.endsWith("/assets/generate") && init?.method === "POST") {
          enqueueCalls += 1;
          const headers = new Headers(init.headers);
          const body = JSON.parse(String(init.body)) as { clientRequestId: string };
          idempotencyKeys.push(headers.get("Idempotency-Key") ?? "");
          clientRequestIds.push(body.clientRequestId);
          if (enqueueCalls === 1) throw new TypeError("response lost after commit");
          serverJob = makeGenerationJob({ clientRequestId: body.clientRequestId });
          return new Response(JSON.stringify({ data: { generation: serverJob } }), {
            status: 202,
            headers: { "content-type": "application/json" },
          });
        }
        if (url.endsWith("/assets/generate") && !init?.method) {
          return jsonResponse({ generations: serverJob ? [serverJob] : [] });
        }
        if (url.includes("/assets/generate/gen-1") && init?.method === "POST") return runnerResponse;
        throw new Error(`unexpected request: ${url}`);
      }),
    );
    const user = userEvent.setup();
    render(<AssetManager projectId="project-1" />);

    await user.click(await screen.findByRole("button", { name: "AI 创建资产" }));
    await user.type(screen.getByRole("textbox", { name: "资产名称 *" }), "幂等任务");
    await user.type(screen.getByRole("textbox", { name: "生成提示词 *" }), "保持同一请求标识");
    await user.click(screen.getByRole("button", { name: "创建生成任务" }));

    await waitFor(() => expect(enqueueCalls).toBe(2));
    expect(idempotencyKeys[0]).toBeTruthy();
    expect(new Set(idempotencyKeys).size).toBe(1);
    expect(new Set(clientRequestIds).size).toBe(1);
    expect(await screen.findByRole("heading", { name: "即时任务卡" })).toBeVisible();
  });
});
