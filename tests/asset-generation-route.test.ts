import { beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  put: vi.fn(),
  delete: vi.fn(),
  generate: vi.fn(),
  supportsImages: vi.fn(() => true),
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
  generationFailure: vi.fn(() => ({ code: "IMAGE_PROCESSING_FAILED", message: "图片生成处理发生内部错误，请稍后重试。", retryable: true })),
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
  generationFailure: mocks.generationFailure,
}));

const generation = {
  id: "gen-1",
  projectId: "project-1",
  clientRequestId: "request-1",
  modelId: "mdl-1",
  modelName: "Seedream",
  name: "林晚角色概念图",
  category: "character",
  prompt: "电影感角色设定",
  size: null,
  aspectRatio: "9:16",
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
