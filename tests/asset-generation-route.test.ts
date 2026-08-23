import { beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  put: vi.fn(), delete: vi.fn(), generate: vi.fn(), prepareRelations: vi.fn(),
  requireProject: vi.fn(), requireModel: vi.fn(), serialize: vi.fn(),
}));

vi.mock("@/lib/server/context", () => ({ apiContext: vi.fn(async () => ({ db: fakeDb, identity: { userId: "user-1" } })) }));
vi.mock("@/lib/server/runtime", () => ({ mediaBucket: () => ({ put: mocks.put, delete: mocks.delete }) }));
vi.mock("@/lib/server/image-generation", () => ({ generateImageWithModel: mocks.generate }));
vi.mock("@/lib/server/store", () => ({
  prepareAssetRelationStatements: mocks.prepareRelations,
  requireOwnedProject: mocks.requireProject,
  requireOwnedModel: mocks.requireModel,
  serializeAssetById: mocks.serialize,
}));

const batch = vi.fn(async () => []);
const bind = vi.fn(function (this: { sql: string }, ...values: unknown[]) { return { sql: this.sql, values }; });
const fakeDb = {
  prepare: vi.fn((sql: string) => ({ sql, bind })),
  batch,
} as unknown as D1Database;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireModel.mockResolvedValue({ id: "mdl-1", enabled: 1, api_key_ciphertext: "cipher", api_key_iv: "iv" });
  mocks.generate.mockResolvedValue({ bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]), mimeType: "image/png", sourceUrl: null, revisedPrompt: null });
  mocks.prepareRelations.mockResolvedValue([{ sql: "DELETE relations", values: [] }]);
  mocks.serialize.mockResolvedValue({ id: "ast-generated", mediaType: "image", category: "character", relations: [] });
});

test("生成路由将 mock 模型响应写入 R2 后入库并保存关系", async () => {
  const { POST } = await import("@/app/api/projects/[projectId]/assets/generate/route");
  const response = await POST(new Request("http://localhost/api/projects/project-1/assets/generate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ modelId: "mdl-1", name: "林晚角色概念图", category: "character", prompt: "电影感角色设定", aspectRatio: "9:16", relatedCharacterIds: ["chr-1"] }),
  }), { params: Promise.resolve({ projectId: "project-1" }) });

  expect(response.status).toBe(201);
  expect(mocks.generate).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({ prompt: "电影感角色设定", aspectRatio: "9:16" }));
  expect(mocks.put).toHaveBeenCalledWith(expect.stringMatching(/^projects\/project-1\/ast_/), expect.any(Uint8Array), expect.objectContaining({ httpMetadata: { contentType: "image/png" } }));
  expect(mocks.prepareRelations).toHaveBeenCalledWith(fakeDb, "project-1", expect.stringMatching(/^ast_/), [{ targetType: "character", targetId: "chr-1" }]);
  expect(batch).toHaveBeenCalledWith(expect.arrayContaining([
    expect.objectContaining({ sql: expect.stringContaining("INSERT INTO assets") }),
    expect.objectContaining({ sql: "DELETE relations" }),
    expect.objectContaining({ sql: expect.stringContaining("UPDATE projects") }),
  ]));
});

test("生成失败时不写 R2 也不创建数据库记录", async () => {
  mocks.generate.mockRejectedValueOnce(new Error("provider failed"));
  const { POST } = await import("@/app/api/projects/[projectId]/assets/generate/route");
  const response = await POST(new Request("http://localhost/api/projects/project-1/assets/generate", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ modelId: "mdl-1", name: "失败资产", category: "prop", prompt: "test" }),
  }), { params: Promise.resolve({ projectId: "project-1" }) });

  expect(response.status).toBe(500);
  expect(mocks.put).not.toHaveBeenCalled();
  expect(batch).not.toHaveBeenCalled();
});
