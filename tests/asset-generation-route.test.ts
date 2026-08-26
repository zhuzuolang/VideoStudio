import { beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  put: vi.fn(),
  delete: vi.fn(),
  generate: vi.fn(),
  supportsImages: vi.fn(() => true),
  supportsVideos: vi.fn(() => true),
  seedanceRequestProfile: vi.fn(() => ({ profile: { maxReferenceImages: 30 }, preset: {} })),
  buildVideoRequest: vi.fn(() => ({})),
  createVideoTask: vi.fn(),
  getVideoTask: vi.fn(),
  downloadVideo: vi.fn(),
  prepareRelations: vi.fn(),
  validateRelations: vi.fn(),
  requireProject: vi.fn(),
  requireModel: vi.fn(),
  findByClientRequest: vi.fn(),
  listGenerations: vi.fn(),
  getGeneration: vi.fn(),
  serializeGeneration: vi.fn((row: Record<string, unknown>) => ({ ...row, relations: [], canRun: true })),
  updateProgress: vi.fn(),
  renewLease: vi.fn(),
  getStorageKey: vi.fn(),
  setStorageKey: vi.fn(),
  persistFailure: vi.fn(),
  persistProviderTask: vi.fn(),
  releaseForPolling: vi.fn(),
  generationFailure: vi.fn(() => ({ code: "IMAGE_PROCESSING_FAILED", message: "图片生成处理发生内部错误，请稍后重试。", retryable: true })),
  parseReferenceAssets: vi.fn((value: unknown) => value ?? []),
  validateReferenceProfile: vi.fn(),
  validateReferenceAssets: vi.fn(),
  resolveReferenceAssets: vi.fn(),
}));

const prepared: Array<{ sql: string; values: unknown[] }> = [];
const batch = vi.fn(async (statements: Array<{ sql: string }>) => statements.map(() => ({ success: true, meta: { changes: 1 } })));
const fakeDb = {
  prepare: vi.fn((sql: string) => {
    const statement = {
      sql,
      values: [] as unknown[],
      bind(...values: unknown[]) {
        this.values = values;
        prepared.push({ sql, values });
        return this;
      },
      first: vi.fn(async () => null),
      run: vi.fn(async () => ({ success: true, meta: { changes: 1 } })),
    };
    return statement;
  }),
  batch,
} as unknown as D1Database;

vi.mock("@/lib/server/context", () => ({
  apiContext: vi.fn(async () => ({ db: fakeDb, identity: { userId: "user-1" } })),
}));
vi.mock("@/lib/server/runtime", () => ({ mediaBucket: () => ({ put: mocks.put, delete: mocks.delete }) }));
vi.mock("@/lib/server/image-generation", () => ({
  generateImageWithModel: mocks.generate,
  modelSupportsImageGeneration: mocks.supportsImages,
}));
vi.mock("@/lib/server/video-generation", () => ({
  modelSupportsVideoGeneration: mocks.supportsVideos,
  seedanceRequestProfile: mocks.seedanceRequestProfile,
  buildVideoGenerationRequest: mocks.buildVideoRequest,
  createVideoGenerationTask: mocks.createVideoTask,
  getVideoGenerationTask: mocks.getVideoTask,
  openGeneratedVideoStream: mocks.downloadVideo,
}));
vi.mock("@/lib/server/video-reference-assets", () => ({
  parseVideoReferenceAssets: mocks.parseReferenceAssets,
  validateVideoReferenceProfile: mocks.validateReferenceProfile,
  validateVideoReferenceAssets: mocks.validateReferenceAssets,
  resolveVideoReferenceAssets: mocks.resolveReferenceAssets,
}));
vi.mock("@/lib/server/store", () => ({
  prepareGeneratedAssetRelationStatements: mocks.prepareRelations,
  validateAssetRelationTargets: mocks.validateRelations,
  requireOwnedProject: mocks.requireProject,
  requireOwnedModel: mocks.requireModel,
}));
vi.mock("@/lib/server/asset-generation-jobs", () => ({
  findAssetGenerationByClientRequest: mocks.findByClientRequest,
  listAssetGenerations: mocks.listGenerations,
  getAssetGeneration: mocks.getGeneration,
  serializeAssetGeneration: mocks.serializeGeneration,
  updateGenerationProgress: mocks.updateProgress,
  renewGenerationLease: mocks.renewLease,
  getGenerationStorageKey: mocks.getStorageKey,
  setGenerationStorageKey: mocks.setStorageKey,
  persistGenerationFailure: mocks.persistFailure,
  persistGenerationProviderTask: mocks.persistProviderTask,
  releaseGenerationForPolling: mocks.releaseForPolling,
  generationFailure: mocks.generationFailure,
}));

const generation = {
  id: "gen-1",
  projectId: "project-1",
  clientRequestId: "request-1",
  modelId: "mdl-1",
  modelName: "Seedream",
  mediaType: "image",
  name: "林晚角色概念图",
  category: "character",
  prompt: "电影感角色设定",
  size: null,
  aspectRatio: "9:16",
  options: {},
  providerTaskId: null,
  relations: [{ targetType: "character", targetId: "chr-1" }],
  status: "queued",
  phase: "queued",
  progress: 0,
  attemptCount: 0,
  errorCode: null,
  errorMessage: null,
  retryable: true,
  assetId: null,
  canRun: true,
  createdAt: "2026-08-23T00:00:00.000Z",
  updatedAt: "2026-08-23T00:00:00.000Z",
  startedAt: null,
  completedAt: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  prepared.length = 0;
  mocks.findByClientRequest.mockResolvedValue(null);
  mocks.requireModel.mockResolvedValue({
    id: "mdl-1",
    name: "Seedream",
    enabled: 1,
    api_key_ciphertext: "cipher",
    api_key_iv: "iv",
  });
  mocks.getGeneration.mockResolvedValue(generation);
  mocks.getStorageKey.mockResolvedValue(null);
  mocks.generate.mockResolvedValue({
    bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    mimeType: "image/png",
    sourceUrl: null,
    revisedPrompt: null,
  });
  mocks.createVideoTask.mockResolvedValue({ taskId: "cgt-created" });
  mocks.resolveReferenceAssets.mockResolvedValue([]);
  mocks.getVideoTask.mockResolvedValue({
    status: "succeeded",
    videoUrl: "https://cdn.example.test/generated.mp4?signature=hidden",
    usage: { total_tokens: 123 },
  });
  mocks.downloadVideo.mockResolvedValue({
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109]));
        controller.close();
      },
    }),
    mimeType: "video/mp4",
    sourceUrl: "https://cdn.example.test/generated.mp4?signature=hidden",
    completed: Promise.resolve({ size: 12 }),
  });
  mocks.prepareRelations.mockReturnValue([{ sql: "INSERT relation", values: [] }]);
});

test("创建接口只持久化任务并立即返回 202，不等待模型或 R2", async () => {
  const { POST } = await import("@/app/api/projects/[projectId]/assets/generate/route");
  const response = await POST(new Request("http://localhost/api/projects/project-1/assets/generate", {
    method: "POST",
    headers: { "content-type": "application/json", "Idempotency-Key": "request-1" },
    body: JSON.stringify({
      clientRequestId: "request-1",
      modelId: "mdl-1",
      name: "林晚角色概念图",
      category: "character",
      prompt: "电影感角色设定",
      aspectRatio: "9:16",
      relations: [{ targetType: "character", targetId: "chr-1" }],
    }),
  }), { params: Promise.resolve({ projectId: "project-1" }) });

  expect(response.status).toBe(202);
  expect(mocks.validateRelations).toHaveBeenCalledWith(fakeDb, "project-1", [expect.objectContaining({ targetType: "character", targetId: "chr-1" })]);
  expect(prepared.some((item) => item.sql.includes("INSERT INTO asset_generation_jobs"))).toBe(true);
  expect(mocks.generate).not.toHaveBeenCalled();
  expect(mocks.put).not.toHaveBeenCalled();
});

test("创建视频任务会按选择顺序保存项目参考图，并校验其模型 profile 与资产归属", async () => {
  const referenceImages = [
    { assetId: "asset-street", role: "reference_image" },
    { assetId: "asset-character", role: "reference_image" },
  ] as const;
  const { POST } = await import("@/app/api/projects/[projectId]/assets/generate/route");
  const response = await POST(new Request("http://localhost/api/projects/project-1/assets/generate", {
    method: "POST",
    headers: { "content-type": "application/json", "Idempotency-Key": "video-request-1" },
    body: JSON.stringify({
      modelId: "mdl-1",
      mediaType: "video",
      name: "雨夜长镜头",
      category: "scene",
      prompt: "从参考首帧生成有声视频",
      aspectRatio: "16:9",
      options: {
        resolution: "1080p",
        duration: -1,
        generateAudio: true,
        referenceImages,
      },
    }),
  }), { params: Promise.resolve({ projectId: "project-1" }) });

  expect(response.status).toBe(202);
  expect(mocks.supportsVideos).toHaveBeenCalledOnce();
  expect(mocks.supportsImages).not.toHaveBeenCalled();
  expect(mocks.parseReferenceAssets).toHaveBeenCalledWith(referenceImages);
  expect(mocks.seedanceRequestProfile).toHaveBeenCalledWith(expect.objectContaining({ id: "mdl-1" }));
  expect(mocks.validateReferenceProfile).toHaveBeenCalledWith(
    referenceImages,
    expect.objectContaining({ maxReferenceImages: 30 }),
  );
  expect(mocks.validateReferenceAssets).toHaveBeenCalledWith(fakeDb, "project-1", referenceImages);
  const insert = prepared.find((item) => item.sql.includes("INSERT INTO asset_generation_jobs"));
  expect(insert?.values[6]).toBe("video");
  expect(JSON.parse(String(insert?.values[12]))).toEqual({
    resolution: "1080p",
    duration: -1,
    generateAudio: true,
    referenceImages,
  });
});

test("执行接口更新阶段、写入 R2，并在同一批次完成资产和任务", async () => {
  const { POST } = await import("@/app/api/projects/[projectId]/assets/generate/[generationId]/route");
  const response = await POST(new Request("http://localhost/api/projects/project-1/assets/generate/gen-1", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ retry: false }),
  }), { params: Promise.resolve({ projectId: "project-1", generationId: "gen-1" }) });

  expect(response.status).toBe(200);
  expect(mocks.generate).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({ prompt: "电影感角色设定", aspectRatio: "9:16" }));
  expect(mocks.updateProgress).toHaveBeenCalledWith(fakeDb, "gen-1", expect.stringMatching(/^lease_/), "storage", 82);
  expect(mocks.setStorageKey).toHaveBeenCalledWith(fakeDb, "gen-1", expect.stringMatching(/^lease_/), expect.stringMatching(/^projects\/project-1\/ast_/));
  expect(mocks.put).toHaveBeenCalledWith(expect.stringMatching(/^projects\/project-1\/ast_/), expect.any(Uint8Array), expect.any(Object));
  expect(batch).toHaveBeenCalledWith(expect.arrayContaining([
    expect.objectContaining({ sql: expect.stringContaining("INSERT INTO assets") }),
    expect.objectContaining({ sql: "INSERT relation" }),
    expect.objectContaining({ sql: expect.stringContaining("UPDATE asset_generation_jobs") }),
  ]));
  expect(mocks.persistFailure).not.toHaveBeenCalled();
});

test("执行失败会持久化安全错误，卡片可从数据库恢复", async () => {
  mocks.generate.mockRejectedValueOnce(new Error("provider socket closed"));
  const { POST } = await import("@/app/api/projects/[projectId]/assets/generate/[generationId]/route");
  const response = await POST(new Request("http://localhost/api/projects/project-1/assets/generate/gen-1", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  }), { params: Promise.resolve({ projectId: "project-1", generationId: "gen-1" }) });

  expect(response.status).toBe(500);
  expect(mocks.persistFailure).toHaveBeenCalledWith(fakeDb, "gen-1", expect.stringMatching(/^lease_/), expect.objectContaining({
    code: "IMAGE_PROCESSING_FAILED",
    retryable: true,
  }));
  expect(mocks.put).not.toHaveBeenCalled();
});

test("视频首次执行按序解析项目参考图，只创建一次供应商任务并持久化任务号", async () => {
  const referenceImages = [
    { assetId: "asset-street", role: "reference_image" },
    { assetId: "asset-character", role: "reference_image" },
  ] as const;
  const resolvedReferenceImages = [
    { url: "data:image/png;base64,c3RyZWV0", role: "reference_image" },
    { url: "https://cdn.example.test/character.png", role: "reference_image" },
  ] as const;
  mocks.resolveReferenceAssets.mockResolvedValueOnce(resolvedReferenceImages);
  mocks.getGeneration.mockResolvedValue({
    ...generation,
    mediaType: "video",
    modelName: "Seedance 2.5",
    options: { resolution: "720p", duration: 8, generateAudio: true, referenceImages },
  });
  const { POST } = await import("@/app/api/projects/[projectId]/assets/generate/[generationId]/route");
  const response = await POST(new Request("http://localhost/api/projects/project-1/assets/generate/gen-1", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  }), { params: Promise.resolve({ projectId: "project-1", generationId: "gen-1" }) });

  expect(response.status).toBe(202);
  expect(mocks.resolveReferenceAssets).toHaveBeenCalledWith(
    fakeDb,
    expect.objectContaining({ put: mocks.put }),
    "project-1",
    referenceImages,
  );
  expect(mocks.buildVideoRequest).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({
    prompt: "电影感角色设定",
    resolution: "720p",
    duration: 8,
    generateAudio: true,
    referenceImages: resolvedReferenceImages,
  }));
  expect(mocks.createVideoTask).toHaveBeenCalledOnce();
  expect(mocks.persistProviderTask).toHaveBeenCalledWith(
    fakeDb,
    "gen-1",
    expect.stringMatching(/^lease_/),
    "cgt-created",
    5_000,
  );
  expect(mocks.getVideoTask).not.toHaveBeenCalled();
  expect(mocks.put).not.toHaveBeenCalled();
});

test("视频轮询中的任务释放租约，且不会重复创建供应商任务", async () => {
  const referenceImages = [
    { assetId: "asset-street", role: "reference_image" },
    { assetId: "asset-character", role: "reference_image" },
  ] as const;
  mocks.getGeneration.mockResolvedValue({
    ...generation,
    mediaType: "video",
    providerTaskId: "cgt-existing",
    status: "running",
    progress: 35,
    options: { resolution: "720p", duration: 8, referenceImages },
  });
  mocks.getVideoTask.mockResolvedValueOnce({ status: "running" });
  const { POST } = await import("@/app/api/projects/[projectId]/assets/generate/[generationId]/route");
  const response = await POST(new Request("http://localhost/api/projects/project-1/assets/generate/gen-1", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  }), { params: Promise.resolve({ projectId: "project-1", generationId: "gen-1" }) });

  expect(response.status).toBe(202);
  expect(mocks.resolveReferenceAssets).not.toHaveBeenCalled();
  expect(mocks.buildVideoRequest).not.toHaveBeenCalled();
  expect(mocks.createVideoTask).not.toHaveBeenCalled();
  expect(mocks.getVideoTask).toHaveBeenCalledWith(expect.any(Object), "cgt-existing");
  expect(mocks.releaseForPolling).toHaveBeenCalledWith(
    fakeDb,
    "gen-1",
    expect.stringMatching(/^lease_/),
    50,
    5_000,
  );
  expect(prepared.some((item) => item.sql.includes("CASE WHEN provider_task_id IS NULL THEN 1 ELSE 0 END"))).toBe(true);
});

test("成功视频下载到 R2，并作为 video 资产完成入库", async () => {
  mocks.getGeneration.mockResolvedValue({
    ...generation,
    mediaType: "video",
    providerTaskId: "cgt-existing",
    status: "running",
    progress: 55,
    options: { resolution: "720p", duration: 8, generateAudio: true },
  });
  const { POST } = await import("@/app/api/projects/[projectId]/assets/generate/[generationId]/route");
  const response = await POST(new Request("http://localhost/api/projects/project-1/assets/generate/gen-1", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  }), { params: Promise.resolve({ projectId: "project-1", generationId: "gen-1" }) });

  expect(response.status).toBe(200);
  expect(mocks.createVideoTask).not.toHaveBeenCalled();
  expect(mocks.getVideoTask).toHaveBeenCalledWith(expect.any(Object), "cgt-existing");
  expect(mocks.downloadVideo).toHaveBeenCalledWith(
    "https://cdn.example.test/generated.mp4?signature=hidden",
    fetch,
    expect.any(AbortSignal),
  );
  expect(mocks.put).toHaveBeenCalledWith(
    expect.stringMatching(/\.mp4$/),
    expect.any(ReadableStream),
    expect.objectContaining({ httpMetadata: { contentType: "video/mp4" } }),
  );
  const insert = prepared.find((item) => item.sql.includes("INSERT INTO assets"));
  expect(insert?.values[3]).toBe("video");
});
