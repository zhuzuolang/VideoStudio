import { describe, expect, test, vi } from "vitest";
import { parseAssetRelations, validateAssetCategory, validateAssetMediaType } from "@/lib/server/assets";

vi.mock("@/lib/server/runtime", () => ({ database: vi.fn() }));

describe("资产双维分类", () => {
  test("介质属性与制作分类独立校验", () => {
    expect(validateAssetMediaType("image")).toBe("image");
    expect(validateAssetCategory("character")).toBe("character");
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
