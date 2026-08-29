import { describe, expect, test, vi } from "vitest";
import { parseAssetRelations, validateAssetCategory, validateAssetMediaType } from "@/lib/server/assets";

vi.mock("@/lib/server/runtime", () => ({ database: vi.fn() }));

const assetRow = {
  id: "asset-1",
  projectId: "project-1",
  name: "角色图",
  mediaType: "image",
  category: "character",
  description: "",
  metadataJson: "{}",
  storageKey: null,
  status: "ready",
  createdAt: "2026-08-23T00:00:00.000Z",
  updatedAt: "2026-08-23T00:00:00.000Z",
};

describe("资产双维分类", () => {
  test("介质属性与制作分类独立校验", () => {
    expect(validateAssetMediaType("image")).toBe("image");
    expect(validateAssetCategory("character")).toBe("character");
    expect(validateAssetCategory("final")).toBe("final");
    expect(() => validateAssetMediaType("character")).toThrow(/介质属性/);
    expect(() => validateAssetCategory("image")).toThrow(/制作分类/);
  });

  test("兼容 ID 数组与结构化关系并去重", () => {
    expect(parseAssetRelations({
      relatedAssetIds: ["ast-2"],
      relatedCharacterIds: ["chr-1"],
      relations: [{ targetType: "asset", targetId: "ast-2" }, { targetType: "asset", targetId: "ast-3", relationType: "reference", note: "构图参考" }],
    })).toEqual([
      { targetType: "asset", targetId: "ast-2", relationType: "related", note: "" },
      { targetType: "character", targetId: "chr-1" },
      { targetType: "asset", targetId: "ast-3", relationType: "reference", note: "构图参考" },
    ]);
  });
});

describe("资产关系项目隔离与持久化", () => {
  test("复合关系查询显式声明排序列，兼容 SQLite compound SELECT", async () => {
    let capturedSql = "";
    const db = {
      prepare(sql: string) {
        capturedSql = sql;
        return {
          bind() { return this; },
          async all() { return { results: [] }; },
        };
      },
    } as unknown as D1Database;
    const { listAssetRelations } = await import("@/lib/server/store");

    await expect(listAssetRelations(db, "project-1", "asset-1")).resolves.toEqual([]);
    expect(capturedSql).toMatch(/SELECT r\.id AS id,/);
    expect(capturedSql).toMatch(/UNION ALL\s+SELECT r\.id AS id,/);
    expect(capturedSql).toMatch(/ORDER BY id/);
  });

  test("关联 enrichment 异常时保留资产主体，避免阻断工作台", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const db = {
      prepare() {
        return {
          bind() { return this; },
          async all() { throw new Error("relation query unavailable"); },
        };
      },
    } as unknown as D1Database;
    const { serializeProjectAssets } = await import("@/lib/server/store");

    await expect(serializeProjectAssets(db, "project-1", [assetRow])).resolves.toEqual([
      expect.objectContaining({ id: "asset-1", name: "角色图", relations: [], relationsLoaded: false }),
    ]);
    expect(errorLog).toHaveBeenCalledWith("Project asset relation enrichment failed", expect.objectContaining({ projectId: "project-1" }));
    errorLog.mockRestore();
  });

  test("关系查询成功时显式标记关系已加载", async () => {
    const db = {
      prepare() {
        return {
          bind() { return this; },
          async all() { return { results: [] }; },
        };
      },
    } as unknown as D1Database;
    const { serializeProjectAssets } = await import("@/lib/server/store");

    await expect(serializeProjectAssets(db, "project-1", [assetRow])).resolves.toEqual([
      expect.objectContaining({ id: "asset-1", relations: [], relationsLoaded: true }),
    ]);
  });

  test("单资产关系查询失败时显式标记关系未加载", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let prepareCount = 0;
    const db = {
      prepare() {
        prepareCount += 1;
        return {
          bind() { return this; },
          async first() { return assetRow; },
          async all() { throw new Error("relation query unavailable"); },
        };
      },
    } as unknown as D1Database;
    const { serializeAssetById } = await import("@/lib/server/store");

    await expect(serializeAssetById(db, "asset-1")).resolves.toEqual(
      expect.objectContaining({ id: "asset-1", relations: [], relationsLoaded: false }),
    );
    expect(prepareCount).toBe(2);
    expect(errorLog).toHaveBeenCalledWith("Asset relation enrichment failed", expect.objectContaining({
      projectId: "project-1",
      assetId: "asset-1",
    }));
    errorLog.mockRestore();
  });

  test("单资产关系查询成功时显式标记关系已加载", async () => {
    const db = {
      prepare(sql: string) {
        return {
          bind() { return this; },
          async first() { return assetRow; },
          async all() {
            return { results: sql.includes("FROM asset_relations") ? [{
              id: "relation-1",
              targetType: "character",
              targetId: "character-1",
              targetName: "林晚",
              targetMediaType: null,
              targetCategory: null,
              relationType: "belongs_to",
              note: "角色设定",
              direction: "outgoing",
            }] : [] };
          },
        };
      },
    } as unknown as D1Database;
    const { serializeAssetById } = await import("@/lib/server/store");

    await expect(serializeAssetById(db, "asset-1")).resolves.toEqual(
      expect.objectContaining({
        id: "asset-1",
        relations: [expect.objectContaining({ id: "relation-1", relationType: "belongs_to" })],
        relationsLoaded: true,
      }),
    );
  });

  test("只为当前项目中的目标生成批处理写入", async () => {
    const batched: Array<{ sql: string; values: unknown[] }> = [];
    const db = {
      prepare(sql: string) {
        return {
          sql,
          values: [] as unknown[],
          bind(...values: unknown[]) { this.values = values; return this; },
          async first() { return this.values[1] === "project-1" ? { id: this.values[0] } : null; },
        };
      },
      async batch(statements: Array<{ sql: string; values: unknown[] }>) { batched.push(...statements); return []; },
    } as unknown as D1Database;
    const { replaceAssetRelations } = await import("@/lib/server/store");

    await replaceAssetRelations(db, "project-1", "ast-1", [
      { targetType: "asset", targetId: "ast-2", relationType: "reference" },
      { targetType: "character", targetId: "chr-1" },
    ]);

    expect(batched).toHaveLength(3);
    expect(batched[0].sql).toMatch(/DELETE FROM asset_relations/);
    expect(batched.slice(1).every((statement) => statement.sql.includes("INSERT INTO asset_relations"))).toBe(true);
  });

  test("拒绝跨项目关系且不执行批处理", async () => {
    const batch = vi.fn();
    const db = {
      prepare(sql: string) { return { sql, bind() { return this; }, async first() { return null; } }; },
      batch,
    } as unknown as D1Database;
    const { replaceAssetRelations } = await import("@/lib/server/store");

    await expect(replaceAssetRelations(db, "project-1", "ast-1", [{ targetType: "asset", targetId: "other-project-asset" }])).rejects.toMatchObject({ code: "INVALID_ASSET_RELATION" });
    expect(batch).not.toHaveBeenCalled();
  });
});
