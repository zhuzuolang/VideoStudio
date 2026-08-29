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
    relationsLoaded: true,
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
    mediaType: "image",
    name: "即时任务卡",
    category: "character",
    prompt: "电影感人物设定",
    size: null,
    aspectRatio: "1:1",
    options: {},
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
  test("点击资产卡片打开原图预览，并可用 Escape 关闭", async () => {
    const asset = makeAsset({
      contentUrl: "/api/projects/project-1/assets/asset-1/content",
      sourceUrl: "https://example.test/source.png",
      thumbnailUrl: "https://example.test/thumb.png",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/assets/generate")) return jsonResponse({ generations: [] });
        if (url.endsWith("/assets")) return jsonResponse([asset]);
        if (url.endsWith("/characters") || url === "/api/models") return jsonResponse([]);
        throw new Error(`unexpected request: ${url}`);
      }),
    );
    const user = userEvent.setup();

    render(<AssetManager projectId="project-1" />);
    await user.click(await screen.findByRole("button", { name: "查看资产 雨夜参考图" }));

    const dialog = screen.getByRole("dialog", { name: "雨夜参考图" });
    expect(within(dialog).getByRole("img", { name: "雨夜参考图 大图预览" })).toHaveAttribute(
      "src",
      "/api/projects/project-1/assets/asset-1/content",
    );
    expect(within(dialog).getByRole("link", { name: "打开原文件" })).toHaveAttribute(
      "href",
      "/api/projects/project-1/assets/asset-1/content",
    );

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "雨夜参考图" })).toBeNull());
  });

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
    expect(screen.getByRole("button", { name: "另有 3 条" })).toBeVisible();
    expect(await screen.findByText(/人物关联选项加载失败/)).toBeVisible();
    expect(await screen.findByText(/生成模型选项加载失败/)).toBeVisible();
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
    const relation = {
      id: "relation-1",
      targetType: "asset" as const,
      targetId: "asset-reference",
      targetName: "构图参考",
      targetMediaType: "image" as const,
      targetCategory: "reference" as const,
      relationType: "references",
      note: "",
      direction: "outgoing" as const,
    };
    const firstAsset = makeAsset({
      thumbnailUrl: "https://example.test/bad.png",
      relations: [relation],
    });
    const nextAsset = makeAsset({
      thumbnailUrl: "https://example.test/good.png",
      relations: [relation],
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
    expect(window.confirm).toHaveBeenCalledWith(
      expect.stringContaining("同时解除 1 条关联"),
    );
    expect(
      screen.getByRole("button", { name: "编辑资产 雨夜参考图" }),
    ).toBeDisabled();
    resolveDelete?.(jsonResponse(null));
  });

  test("AI 创建仅展示真正支持生成资产的模型", async () => {
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

    const select = screen.getByRole("combobox", { name: "生成模型 *" });
    expect(
      within(select).queryByRole("option", { name: "Image Vision" }),
    ).toBeNull();
    expect(
      within(select).getByRole("option", { name: "正式生图模型 · 图片" }),
    ).toBeVisible();
  });

  test("失败生成卡可打开并查看完整的历史提交参数", async () => {
    const prompt = "韩立立于乱星海上空，镜头缓慢环绕人物，远处群岛与雷云逐层显现，保持人物服饰和面部一致。";
    const model = makeModel({
      id: "seedance-mini",
      name: "豆包 Seedance 2.0 Mini",
      modelId: "doubao-seedance-2-0-mini-260615",
      parameters: { capabilities: ["video-generation", "image-to-video"] },
    });
    const reference = makeAsset({ id: "ref-1", name: "乱星海参考图" });
    const failedJob = makeGenerationJob({
      id: "gen-video-details",
      clientRequestId: "request-video-details",
      modelId: model.id,
      modelName: model.name,
      mediaType: "video",
      name: "韩立遨游乱星海",
      category: "scene",
      prompt,
      aspectRatio: "16:9",
      options: {
        resolution: "720p",
        duration: 8,
        generateAudio: false,
        referenceImages: [{ assetId: reference.id, role: "reference_image" }],
      },
      relations: [{
        targetType: "character",
        targetId: "character-1",
        relationType: "references",
        note: "保持角色一致性",
      }],
      status: "failed",
      phase: "failed",
      progress: 15,
      attemptCount: 2,
      errorCode: "VIDEO_SUBMISSION_STATE_UNKNOWN",
      errorMessage: "视频任务提交状态无法确认。",
      retryable: false,
      canRun: false,
      providerTaskId: "cgt-details-1",
      startedAt: "2026-08-23T00:00:03.000Z",
      completedAt: "2026-08-23T00:01:00.000Z",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/assets/generate")) return jsonResponse({ generations: [failedJob] });
        if (url.endsWith("/assets")) return jsonResponse([reference]);
        if (url.endsWith("/characters")) return jsonResponse([{ id: "character-1", name: "韩立" }]);
        if (url === "/api/models") return jsonResponse([model]);
        throw new Error(`unexpected request: ${url}`);
      }),
    );
    const user = userEvent.setup();

    render(<AssetManager projectId="project-1" />);

    const openButton = await screen.findByRole("button", { name: "查看生成参数 韩立遨游乱星海" });
    await user.click(openButton);

    const dialog = screen.getByRole("dialog", { name: "韩立遨游乱星海" });
    expect(within(dialog).getByText("豆包 Seedance 2.0 Mini")).toBeVisible();
    expect(within(dialog).getByText(/doubao-seedance-2-0-mini-260615/)).toBeVisible();
    expect(within(dialog).getByText(prompt)).toBeVisible();
    expect(within(dialog).getByText("16:9")).toBeVisible();
    expect(within(dialog).getByText("720p")).toBeVisible();
    expect(within(dialog).getByText("8 秒")).toBeVisible();
    expect(within(dialog).getByText("否")).toBeVisible();
    expect(within(dialog).getByText("内容参考")).toBeVisible();
    expect(within(dialog).getByText("乱星海参考图")).toBeVisible();
    expect(within(dialog).getByText("参考")).toBeVisible();
    expect(within(dialog).getByText("韩立 · 保持角色一致性")).toBeVisible();
    expect(within(dialog).getByText("VIDEO_SUBMISSION_STATE_UNKNOWN")).toBeVisible();
    expect(within(dialog).getByText("cgt-details-1")).toBeVisible();
    expect(within(dialog).getByRole("button", { name: "编辑参数后重新生成" })).toBeVisible();

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "韩立遨游乱星海" })).toBeNull());
    await waitFor(() => expect(openButton).toHaveFocus());

    await user.click(openButton);
    const reopenedDetails = screen.getByRole("dialog", { name: "韩立遨游乱星海" });
    await user.click(within(reopenedDetails).getByRole("button", { name: "编辑参数后重新生成" }));
    const editor = screen.getByRole("dialog", { name: "编辑参数后重新生成" });
    expect(within(editor).getByRole("textbox", { name: "资产名称 *" })).toHaveValue("韩立遨游乱星海");
    await user.click(within(editor).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(openButton).toHaveFocus());
  });

  test("原模型不可用时仍展示模型名与图片历史参数，并要求改选模型", async () => {
    const fallbackModel = makeModel({
      id: "fallback-image-model",
      name: "当前图片模型",
      modelId: "current-image-model",
    });
    const failedJob = makeGenerationJob({
      id: "gen-removed-image-model",
      clientRequestId: "request-removed-image-model",
      modelId: "removed-image-model",
      modelName: "旧版绘图模型",
      mediaType: "image",
      name: "历史竖版概念图",
      prompt: "竖版人物概念设计",
      aspectRatio: "2:3",
      size: "800x1200",
      status: "failed",
      phase: "failed",
      errorCode: "MODEL_DISABLED",
      errorMessage: "原模型已停用。",
      canRun: false,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "/api/models") return jsonResponse([fallbackModel]);
        if (url.endsWith("/characters") || url.endsWith("/assets")) return jsonResponse([]);
        if (url.endsWith("/assets/generate") && !init?.method) {
          return jsonResponse({ generations: [failedJob] });
        }
        throw new Error(`unexpected request: ${url}`);
      }),
    );
    const user = userEvent.setup();

    render(<AssetManager projectId="project-1" />);
    await user.click(await screen.findByRole("button", {
      name: "编辑参数后重新生成 历史竖版概念图",
    }));

    const dialog = screen.getByRole("dialog", { name: "编辑参数后重新生成" });
    const modelSelect = within(dialog).getByRole("combobox", { name: "生成模型 *" });
    expect(modelSelect).toHaveValue("removed-image-model");
    expect(within(modelSelect).getByRole("option", {
      name: "旧版绘图模型 · 原模型当前不可用",
    })).toBeDisabled();
    expect(within(dialog).getByRole("combobox", { name: "画幅" })).toHaveValue("2:3");
    expect(within(dialog).getByRole("option", { name: "2:3（历史值，需确认）" })).toBeVisible();
    expect(within(dialog).getByRole("textbox", { name: "自定义尺寸" })).toHaveValue("800x1200");
    expect(within(dialog).getByRole("button", { name: "关闭编辑参数后重新生成" })).toBeVisible();

    await user.click(within(dialog).getByRole("button", { name: "创建新的生成任务" }));
    expect(within(dialog).getByRole("alert")).toHaveTextContent("原生成模型当前不可用");
  });

  test("失败卡可编辑完整参数并用全新请求创建任务，同时保留原失败记录", async () => {
    const originalPrompt = "韩立御剑穿过乱星海，镜头从全景推进到人物近景。";
    const editedPrompt = "韩立御剑穿过乱星海，镜头从全景推进到人物近景，增加雷云闪光。";
    const model = makeModel({
      id: "editable-video-model",
      name: "可编辑视频模型",
      modelId: "custom-video-model-v1",
      parameters: {
        capabilities: ["video-generation", "image-to-video"],
        video: {
          resolutions: ["720p", "1080p"],
          defaultResolution: "720p",
          aspectRatios: ["16:9", "9:16"],
          defaultAspectRatio: "16:9",
          minDuration: 4,
          maxDuration: 12,
          defaultDuration: 5,
          supportsAutoDuration: false,
          supportsGenerateAudio: true,
          defaultGenerateAudio: false,
          maxReferenceImages: 9,
          referenceImageRoles: ["reference_image"],
        },
      },
    });
    const reference = makeAsset({ id: "ref-edit", name: "乱星海角色参考图" });
    const relations = [{
      targetType: "character" as const,
      targetId: "character-edit",
      relationType: "references",
      note: "保持韩立造型一致",
    }];
    const failedJob = makeGenerationJob({
      id: "gen-edit-source",
      clientRequestId: "request-edit-source",
      modelId: model.id,
      modelName: model.name,
      mediaType: "video",
      name: "韩立遨游乱星海",
      category: "scene",
      prompt: originalPrompt,
      aspectRatio: "16:9",
      options: {
        resolution: "720p",
        duration: 8,
        generateAudio: false,
        referenceImages: [{ assetId: reference.id, role: "reference_image" }],
      },
      relations,
      status: "failed",
      phase: "failed",
      progress: 15,
      errorCode: "VIDEO_TASK_FAILED",
      errorMessage: "服务商返回生成失败。",
      retryable: true,
      canRun: false,
    });
    let serverGenerations: AssetGenerationJob[] = [failedJob];
    let createBody: Record<string, unknown> | undefined;
    let createKey = "";
    const postUrls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "/api/models") return jsonResponse([model]);
        if (url.endsWith("/characters")) {
          return jsonResponse([{ id: "character-edit", name: "韩立" }]);
        }
        if (url.endsWith("/assets")) return jsonResponse([reference]);
        if (url.endsWith("/assets/generate") && init?.method === "POST") {
          postUrls.push(url);
          createBody = JSON.parse(String(init.body)) as Record<string, unknown>;
          createKey = new Headers(init.headers).get("Idempotency-Key") ?? "";
          const createdJob = makeGenerationJob({
            id: "gen-edit-new",
            clientRequestId: String(createBody.clientRequestId),
            modelId: model.id,
            modelName: model.name,
            mediaType: "video",
            name: String(createBody.name),
            category: "scene",
            prompt: String(createBody.prompt),
            aspectRatio: "16:9",
            options: createBody.options as AssetGenerationJob["options"],
            relations,
            status: "queued",
            phase: "queued",
            canRun: false,
          });
          serverGenerations = [createdJob, failedJob];
          return jsonResponse({ generation: createdJob });
        }
        if (url.endsWith("/assets/generate/gen-edit-new") && init?.method === "POST") {
          postUrls.push(url);
          return jsonResponse({ generation: serverGenerations[0] });
        }
        if (url.endsWith("/assets/generate")) {
          return jsonResponse({ generations: serverGenerations });
        }
        throw new Error(`unexpected request: ${url}`);
      }),
    );
    const user = userEvent.setup();

    render(<AssetManager projectId="project-1" />);
    await user.click(await screen.findByRole("button", {
      name: "编辑参数后重新生成 韩立遨游乱星海",
    }));

    const dialog = screen.getByRole("dialog", { name: "编辑参数后重新生成" });
    expect(within(dialog).getByRole("status")).toHaveTextContent("不会覆盖原失败任务");
    expect(within(dialog).getByRole("combobox", { name: "生成模型 *" })).toHaveValue(model.id);
    expect(within(dialog).getByRole("textbox", { name: "资产名称 *" })).toHaveValue("韩立遨游乱星海");
    expect(within(dialog).getByRole("combobox", { name: "制作分类 *" })).toHaveValue("scene");
    expect(within(dialog).getByRole("textbox", { name: "生成提示词 *" })).toHaveValue(originalPrompt);
    expect(within(dialog).getByRole("combobox", { name: "画幅" })).toHaveValue("16:9");
    expect(within(dialog).getByRole("combobox", { name: "分辨率" })).toHaveValue("720p");
    expect(within(dialog).getByRole("combobox", { name: "视频时长" })).toHaveValue("8");
    expect(within(dialog).getByRole("checkbox", { name: /生成同步音频/ })).not.toBeChecked();
    expect(within(dialog).getByLabelText("已选参考图列表")).toHaveTextContent("乱星海角色参考图");
    expect(within(dialog).getByText(/保持韩立造型一致/)).toBeVisible();

    const promptInput = within(dialog).getByRole("textbox", { name: "生成提示词 *" });
    await user.clear(promptInput);
    await user.type(promptInput, editedPrompt);
    await user.selectOptions(within(dialog).getByRole("combobox", { name: "视频时长" }), "10");
    await user.click(within(dialog).getByRole("button", { name: "创建新的生成任务" }));

    await waitFor(() => expect(createBody).toBeDefined());
    expect(createKey).toBeTruthy();
    expect(createKey).toBe(createBody?.clientRequestId);
    expect(createKey).not.toBe(failedJob.clientRequestId);
    expect(createBody).toMatchObject({
      modelId: model.id,
      mediaType: "video",
      name: "韩立遨游乱星海",
      category: "scene",
      prompt: editedPrompt,
      aspectRatio: "16:9",
      options: {
        resolution: "720p",
        duration: 10,
        generateAudio: false,
        referenceImages: [{ assetId: reference.id, role: "reference_image" }],
      },
      relations,
    });
    expect(postUrls).not.toContain(expect.stringContaining("gen-edit-source"));
    await waitFor(() => {
      expect(screen.getAllByRole("heading", { name: "韩立遨游乱星海" })).toHaveLength(2);
    });
    expect(screen.getByText("VIDEO_TASK_FAILED")).toBeVisible();
  });

  test("官方受理状态不明的失败视频在编辑后新建前要求再次确认", async () => {
    const model = makeModel({
      id: "uncertain-video-model",
      name: "状态确认视频模型",
      modelId: "custom-video-model-v2",
      parameters: {
        capabilities: ["video-generation"],
        video: {
          resolutions: ["720p"],
          defaultResolution: "720p",
          aspectRatios: ["16:9"],
          defaultAspectRatio: "16:9",
          minDuration: 4,
          maxDuration: 8,
          defaultDuration: 5,
          supportsGenerateAudio: false,
          referenceImageRoles: ["reference_image"],
        },
      },
    });
    const failedJob = makeGenerationJob({
      id: "gen-uncertain-source",
      clientRequestId: "request-uncertain-source",
      modelId: model.id,
      modelName: model.name,
      mediaType: "video",
      name: "待核对的视频任务",
      prompt: "云海中的人物镜头",
      aspectRatio: "16:9",
      options: { resolution: "720p", duration: 5, generateAudio: false },
      status: "failed",
      phase: "failed",
      progress: 15,
      errorCode: "VIDEO_SUBMISSION_STATE_UNKNOWN",
      errorMessage: "视频任务提交状态无法确认。",
      retryable: false,
      canRun: false,
      providerTaskId: null,
    });
    const confirmMock = vi.fn(() => false);
    let collectionPosts = 0;
    let serverGenerations = [failedJob];
    vi.stubGlobal("confirm", confirmMock);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "/api/models") return jsonResponse([model]);
        if (url.endsWith("/characters") || url.endsWith("/assets")) return jsonResponse([]);
        if (url.endsWith("/assets/generate") && init?.method === "POST") {
          collectionPosts += 1;
          const body = JSON.parse(String(init.body)) as { clientRequestId: string };
          const createdJob = makeGenerationJob({
            id: "gen-uncertain-new",
            clientRequestId: body.clientRequestId,
            modelId: model.id,
            modelName: model.name,
            mediaType: "video",
            name: failedJob.name,
            prompt: failedJob.prompt,
            aspectRatio: "16:9",
            options: failedJob.options,
            status: "queued",
            phase: "queued",
            canRun: false,
          });
          serverGenerations = [createdJob, failedJob];
          return jsonResponse({ generation: createdJob });
        }
        if (url.endsWith("/assets/generate/gen-uncertain-new") && init?.method === "POST") {
          return jsonResponse({ generation: serverGenerations[0] });
        }
        if (url.endsWith("/assets/generate")) return jsonResponse({ generations: serverGenerations });
        throw new Error(`unexpected request: ${url}`);
      }),
    );
    const user = userEvent.setup();

    render(<AssetManager projectId="project-1" />);
    await user.click(await screen.findByRole("button", {
      name: "编辑参数后重新生成 待核对的视频任务",
    }));
    const submit = screen.getByRole("button", { name: "创建新的生成任务" });
    await user.click(submit);

    expect(confirmMock).toHaveBeenCalledWith(expect.stringContaining("仅当控制台没有匹配任务时才重新提交"));
    expect(collectionPosts).toBe(0);
    expect(screen.getByRole("dialog", { name: "编辑参数后重新生成" })).toBeVisible();

    confirmMock.mockReturnValue(true);
    await user.click(submit);
    await waitFor(() => expect(collectionPosts).toBe(1));
  });

  test("模型能力变化时展示历史值并阻止静默改写，修正后才允许新建", async () => {
    const model = makeModel({
      id: "changed-video-model",
      name: "能力已变更的视频模型",
      modelId: "custom-video-model-v3",
      parameters: {
        capabilities: ["video-generation"],
        video: {
          resolutions: ["720p"],
          defaultResolution: "720p",
          aspectRatios: ["16:9"],
          defaultAspectRatio: "16:9",
          minDuration: 4,
          maxDuration: 6,
          defaultDuration: 5,
          supportsGenerateAudio: false,
          referenceImageRoles: [],
        },
      },
    });
    const reference = makeAsset({ id: "legacy-reference", name: "旧首帧图片" });
    const failedJob = makeGenerationJob({
      id: "gen-changed-profile",
      clientRequestId: "request-changed-profile",
      modelId: model.id,
      modelName: model.name,
      mediaType: "video",
      name: "历史参数视频",
      prompt: "保留旧参数供编辑",
      aspectRatio: "21:9",
      options: {
        resolution: "1080p",
        duration: 10,
        generateAudio: true,
        referenceImages: [{ assetId: reference.id, role: "first_frame" }],
      },
      status: "failed",
      phase: "failed",
      errorCode: "VIDEO_TASK_FAILED",
      errorMessage: "模型能力已更新。",
      canRun: false,
    });
    let createBody: { options?: Record<string, unknown> } | undefined;
    let serverGenerations = [failedJob];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "/api/models") return jsonResponse([model]);
        if (url.endsWith("/characters")) return jsonResponse([]);
        if (url.endsWith("/assets")) return jsonResponse([reference]);
        if (url.endsWith("/assets/generate") && init?.method === "POST") {
          createBody = JSON.parse(String(init.body)) as { options?: Record<string, unknown> };
          const createdJob = makeGenerationJob({
            id: "gen-changed-profile-new",
            clientRequestId: "request-changed-profile-new",
            modelId: model.id,
            modelName: model.name,
            mediaType: "video",
            name: failedJob.name,
            prompt: failedJob.prompt,
            aspectRatio: "16:9",
            options: createBody.options ?? {},
            status: "queued",
            phase: "queued",
            canRun: false,
          });
          serverGenerations = [createdJob, failedJob];
          return jsonResponse({ generation: createdJob });
        }
        if (url.endsWith("/assets/generate/gen-changed-profile-new") && init?.method === "POST") {
          return jsonResponse({ generation: serverGenerations[0] });
        }
        if (url.endsWith("/assets/generate")) return jsonResponse({ generations: serverGenerations });
        throw new Error(`unexpected request: ${url}`);
      }),
    );
    const user = userEvent.setup();

    render(<AssetManager projectId="project-1" />);
    await user.click(await screen.findByRole("button", {
      name: "编辑参数后重新生成 历史参数视频",
    }));
    const dialog = screen.getByRole("dialog", { name: "编辑参数后重新生成" });
    expect(within(dialog).getByRole("combobox", { name: "画幅" })).toHaveValue("21:9");
    expect(within(dialog).getByRole("option", { name: /21:9（历史值/ })).toBeVisible();
    expect(within(dialog).getByRole("combobox", { name: "分辨率" })).toHaveValue("1080p");
    expect(within(dialog).getByRole("combobox", { name: "视频时长" })).toHaveValue("10");
    expect(within(dialog).getByRole("checkbox", { name: /生成同步音频/ })).toBeChecked();
    expect(within(dialog).getByText(/当前模型不再支持，请关闭音频或更换模型/)).toBeVisible();
    expect(within(dialog).getByLabelText("已选参考图列表")).toHaveTextContent("旧首帧图片");

    await user.click(within(dialog).getByRole("button", { name: "创建新的生成任务" }));
    expect(within(dialog).getByRole("alert")).toHaveTextContent("不支持这个历史画幅");
    expect(createBody).toBeUndefined();

    await user.selectOptions(within(dialog).getByRole("combobox", { name: "画幅" }), "16:9");
    await user.selectOptions(within(dialog).getByRole("combobox", { name: "分辨率" }), "720p");
    await user.selectOptions(within(dialog).getByRole("combobox", { name: "视频时长" }), "5");
    await user.click(within(dialog).getByRole("checkbox", { name: /生成同步音频/ }));
    await user.click(within(dialog).getByRole("button", { name: "移除首帧" }));
    await user.click(within(dialog).getByRole("button", { name: "创建新的生成任务" }));

    await waitFor(() => expect(createBody).toBeDefined());
    expect(createBody?.options).toMatchObject({
      resolution: "720p",
      duration: 5,
      generateAudio: false,
    });
    expect(createBody?.options).not.toHaveProperty("referenceImages");
  });

  test("视频卡片展示官方离散状态，并把临时查询故障保留为生成中提示", async () => {
    const submittingJob = makeGenerationJob({
      id: "gen-video-submitting",
      mediaType: "video",
      name: "正在提交任务",
      status: "running",
      phase: "model",
      progress: 15,
      providerTaskId: null,
      canRun: false,
    });
    const queuedJob = makeGenerationJob({
      id: "gen-video-queued",
      mediaType: "video",
      name: "官方排队任务",
      status: "running",
      phase: "model",
      progress: 35,
      providerTaskId: "cgt-queued",
      canRun: false,
    });
    const delayedJob = makeGenerationJob({
      id: "gen-video-delayed",
      mediaType: "video",
      name: "状态同步任务",
      status: "running",
      phase: "model",
      progress: 55,
      providerTaskId: "cgt-running",
      errorCode: "VIDEO_STATUS_SYNC_DELAYED",
      errorMessage: "官方视频任务状态暂时未同步，系统会继续查询，不会停止生成。",
      canRun: false,
    });
    const resumableJob = makeGenerationJob({
      id: "gen-video-storage",
      mediaType: "video",
      name: "等待入库任务",
      status: "failed",
      phase: "failed",
      progress: 82,
      providerTaskId: "cgt-succeeded",
      errorCode: "VIDEO_STORAGE_FAILED",
      errorMessage: "视频已生成，但媒体存储暂时不可用。",
      retryable: true,
      canRun: false,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/assets/generate")) return jsonResponse({ generations: [submittingJob, queuedJob, delayedJob, resumableJob] });
        if (url.endsWith("/assets") || url.endsWith("/characters") || url === "/api/models") return jsonResponse([]);
        throw new Error(`unexpected request: ${url}`);
      }),
    );

    render(<AssetManager projectId="project-1" />);

    const submittingCard = (await screen.findByRole("heading", { name: "正在提交任务" })).closest("article");
    expect(submittingCard).not.toBeNull();
    expect(within(submittingCard as HTMLElement).getByText("正在提交官方视频任务")).toBeVisible();
    const submissionProgress = within(submittingCard as HTMLElement).getByRole("progressbar", { name: "官方视频任务提交状态" });
    expect(submissionProgress).not.toHaveAttribute("aria-valuenow");
    expect(submissionProgress).toHaveAttribute("aria-valuetext", "正在提交官方视频任务");
    expect(within(submittingCard as HTMLElement).getByText("提交中")).toBeVisible();
    expect(within(submittingCard as HTMLElement).queryByText("持续查询")).toBeNull();

    const queuedCard = (await screen.findByRole("heading", { name: "官方排队任务" })).closest("article");
    expect(queuedCard).not.toBeNull();
    expect(within(queuedCard as HTMLElement).getByText("官方状态：排队中")).toBeVisible();
    const officialProgress = within(queuedCard as HTMLElement).getByRole("progressbar", { name: "官方视频任务状态" });
    expect(officialProgress).not.toHaveAttribute("aria-valuenow");
    expect(officialProgress).toHaveAttribute("aria-valuetext", "官方状态：排队中");
    expect(within(queuedCard as HTMLElement).getByText("持续查询")).toBeVisible();

    const delayedCard = screen.getByRole("heading", { name: "状态同步任务" }).closest("article");
    expect(delayedCard).not.toBeNull();
    expect(within(delayedCard as HTMLElement).getByText("正在重新查询官方任务状态")).toBeVisible();
    expect(within(delayedCard as HTMLElement).getByText(/不会停止生成/)).toBeVisible();
    expect(within(delayedCard as HTMLElement).queryByRole("alert")).toBeNull();
    expect(screen.getByRole("button", { name: "继续处理 等待入库任务" })).toBeVisible();
  });

  test("提交状态不明的视频失败卡提供核对信息，并只在风险确认后重新提交", async () => {
    const startedAt = "2026-08-23T00:02:00.000Z";
    let serverJob = makeGenerationJob({
      id: "gen-video-failed",
      mediaType: "video",
      name: "提交状态不明任务",
      modelName: "豆包 Seedance 2.5",
      status: "failed",
      phase: "failed",
      progress: 15,
      attemptCount: 1,
      providerTaskId: null,
      errorCode: "VIDEO_SUBMISSION_STATE_UNKNOWN",
      errorMessage: "视频任务提交状态无法确认。",
      retryable: false,
      canRun: false,
      startedAt,
      updatedAt: "2026-08-23T00:10:00.000Z",
    });
    let retryBody: Record<string, unknown> | null = null;
    let runnerCalls = 0;
    const confirmMock = vi.fn()
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    vi.stubGlobal("confirm", confirmMock);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/assets/generate/gen-video-failed") && init?.method === "POST") {
          runnerCalls += 1;
          retryBody = JSON.parse(String(init.body)) as Record<string, unknown>;
          serverJob = {
            ...serverJob,
            status: "running",
            phase: "model",
            errorCode: null,
            errorMessage: null,
            canRun: false,
          };
          return new Response(JSON.stringify({ data: { generation: serverJob } }), {
            status: 202,
            headers: { "content-type": "application/json" },
          });
        }
        if (url.endsWith("/assets/generate")) return jsonResponse({ generations: [serverJob] });
        if (url.endsWith("/assets") || url.endsWith("/characters") || url === "/api/models") return jsonResponse([]);
        throw new Error(`unexpected request: ${url}`);
      }),
    );
    const user = userEvent.setup();

    render(<AssetManager projectId="project-1" />);

    const retryButton = await screen.findByRole("button", { name: "核对后重新提交 提交状态不明任务" });
    const failedCard = screen.getByRole("heading", { name: "提交状态不明任务" }).closest("article");
    expect(failedCard).not.toBeNull();
    expect(within(failedCard as HTMLElement).getByText(/控制台核对信息：豆包 Seedance 2.5 · 提交时间/)).toBeVisible();
    expect((failedCard as HTMLElement).querySelector("time[datetime]")).toHaveAttribute("datetime", startedAt);
    await user.click(retryButton);
    expect(confirmMock).toHaveBeenCalledWith(expect.stringContaining("仅当控制台没有匹配任务时才重新提交"));
    expect(runnerCalls).toBe(0);

    await user.click(retryButton);
    await waitFor(() => expect(runnerCalls).toBe(1));
    expect(retryBody).toEqual({ retry: true, confirmedRetry: true });
  });

  test.each([
    ["VIDEO_REFERENCE_OPTIMIZATION_UNAVAILABLE", "参考图需要压缩，但图片处理服务当前不可用。"],
    ["VIDEO_SUBMISSION_PREPARATION_TIMEOUT", "参考图准备耗时过长，尚未提交付费视频任务。"],
  ])("安全的预提交失败超过三次仍可直接重试（%s）", async (errorCode, errorMessage) => {
    let serverJob = makeGenerationJob({
      id: "gen-video-preflight",
      mediaType: "video",
      name: "参考图预处理任务",
      status: "failed",
      phase: "failed",
      progress: 10,
      attemptCount: 3,
      providerTaskId: null,
      errorCode,
      errorMessage,
      retryable: false,
      canRun: false,
    });
    let retryBody: Record<string, unknown> | null = null;
    const confirmMock = vi.fn();
    vi.stubGlobal("confirm", confirmMock);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/assets/generate/gen-video-preflight") && init?.method === "POST") {
          retryBody = JSON.parse(String(init.body)) as Record<string, unknown>;
          serverJob = {
            ...serverJob,
            status: "running",
            phase: "model",
            errorCode: null,
            errorMessage: null,
            canRun: false,
          };
          return new Response(JSON.stringify({ data: { generation: serverJob } }), {
            status: 202,
            headers: { "content-type": "application/json" },
          });
        }
        if (url.endsWith("/assets/generate")) return jsonResponse({ generations: [serverJob] });
        if (url.endsWith("/assets") || url.endsWith("/characters") || url === "/api/models") return jsonResponse([]);
        throw new Error(`unexpected request: ${url}`);
      }),
    );
    const user = userEvent.setup();

    render(<AssetManager projectId="project-1" />);

    await user.click(await screen.findByRole("button", { name: "重试生成 参考图预处理任务" }));
    await waitFor(() => expect(retryBody).toEqual({ retry: true, confirmedRetry: false }));
    expect(confirmMock).not.toHaveBeenCalled();
  });

  test("视频参考图只列出已就绪项目图片，并按重排后的顺序与角色提交", async () => {
    const model = makeModel({
      id: "seedance-2-5",
      name: "豆包 Seedance 2.5",
      modelId: "doubao-seedance-2-5-260628",
      parameters: {
        presetKey: "seedance-2.5",
        capabilities: ["video-generation", "image-to-video"],
      },
    });
    const assets = [
      makeAsset({ id: "ready-street", name: "就绪街景", sourceUrl: "https://example.test/street.png" }),
      makeAsset({
        id: "ready-character",
        name: "就绪人物",
        sourceUrl: null,
        hasContent: true,
        contentUrl: "/api/projects/project-1/assets/ready-character/content",
      }),
      makeAsset({ id: "pending-image", name: "处理中图片", status: "processing" }),
      makeAsset({ id: "ready-video", name: "就绪视频", mediaType: "video", sourceUrl: "https://example.test/video.mp4" }),
      makeAsset({ id: "empty-image", name: "空图片", sourceUrl: null, thumbnailUrl: null, hasContent: false }),
    ];
    let createBody: Record<string, unknown> | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "/api/models") return jsonResponse([model]);
        if (url.endsWith("/characters")) return jsonResponse([]);
        if (url.endsWith("/assets/generate") && init?.method === "POST") {
          createBody = JSON.parse(String(init.body)) as Record<string, unknown>;
          const options = (createBody.options ?? {}) as AssetGenerationJob["options"];
          const job = makeGenerationJob({
            id: "gen-video",
            modelId: model.id,
            modelName: model.name,
            mediaType: "video",
            name: String(createBody.name),
            prompt: String(createBody.prompt),
            aspectRatio: String(createBody.aspectRatio),
            options,
          });
          return new Response(JSON.stringify({ data: { generation: job } }), {
            status: 202,
            headers: { "content-type": "application/json" },
          });
        }
        if (url.endsWith("/assets/generate/gen-video") && init?.method === "POST") {
          return jsonResponse({ generation: makeGenerationJob({ id: "gen-video", mediaType: "video" }) });
        }
        if (url.endsWith("/assets/generate")) return jsonResponse({ generations: [] });
        if (url.endsWith("/assets")) return jsonResponse(assets);
        throw new Error(`unexpected request: ${url}`);
      }),
    );
    const user = userEvent.setup();

    render(<AssetManager projectId="project-1" />);
    await user.click(await screen.findByRole("button", { name: "AI 创建资产" }));

    await user.selectOptions(screen.getByRole("combobox", { name: "参考方式" }), "first_last_frame");
    let assetSelect = screen.getByRole("combobox", { name: "添加项目图片" }) as HTMLSelectElement;
    expect(Array.from(assetSelect.options, (option) => option.value)).toEqual([
      "",
      "ready-street",
      "ready-character",
    ]);
    expect(within(assetSelect).queryByRole("option", { name: /处理中图片/ })).toBeNull();
    expect(within(assetSelect).queryByRole("option", { name: /就绪视频/ })).toBeNull();
    expect(within(assetSelect).queryByRole("option", { name: /空图片/ })).toBeNull();

    await user.selectOptions(assetSelect, "ready-street");
    assetSelect = screen.getByRole("combobox", { name: "添加项目图片" }) as HTMLSelectElement;
    await user.selectOptions(assetSelect, "ready-character");
    expect(screen.getByText("已选 2 / 2 张")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "上移尾帧" }));
    let selectedList = screen.getByLabelText("已选参考图列表");
    expect(within(selectedList).getAllByText(/就绪(?:街景|人物)/).map((item) => item.textContent)).toEqual([
      "就绪人物",
      "就绪街景",
    ]);

    await user.click(screen.getByRole("button", { name: "移除尾帧" }));
    expect(within(screen.getByLabelText("已选参考图列表")).queryByText("就绪街景")).toBeNull();
    assetSelect = screen.getByRole("combobox", { name: "添加项目图片" }) as HTMLSelectElement;
    await user.selectOptions(assetSelect, "ready-street");
    selectedList = screen.getByLabelText("已选参考图列表");
    expect(within(selectedList).getAllByText(/就绪(?:街景|人物)/).map((item) => item.textContent)).toEqual([
      "就绪人物",
      "就绪街景",
    ]);

    await user.type(screen.getByRole("textbox", { name: "资产名称 *" }), "首尾帧短片");
    await user.type(screen.getByRole("textbox", { name: "生成提示词 *" }), "从人物特写过渡到雨夜街景");
    await user.click(screen.getByRole("button", { name: "创建生成任务" }));

    await waitFor(() => expect(createBody).toBeDefined());
    expect(createBody).toMatchObject({
      mediaType: "video",
      options: {
        referenceImages: [
          { assetId: "ready-character", role: "first_frame" },
          { assetId: "ready-street", role: "last_frame" },
        ],
      },
    });
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
            mediaType: "image",
            name: "浪子基础建模",
            category: "character",
            prompt: "A Pose，漫画风格",
            size: null,
            aspectRatio: "1:1",
            options: {},
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
