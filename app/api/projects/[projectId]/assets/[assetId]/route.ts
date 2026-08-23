import { ApiError, errorResponse, jsonText, noContent, nowIso, ok, optionalString, readJsonObject } from "@/lib/server/api";
import { parseAssetRelations, safeRemoteUrl, validateAssetCategory, validateAssetMediaType } from "@/lib/server/assets";
import { apiContext, type RouteContext } from "@/lib/server/context";
import { bindings } from "@/lib/server/runtime";
import { prepareAssetRelationStatements, requireOwnedProject, serializeAssetById } from "@/lib/server/store";

async function ownedAsset(db: D1Database, projectId: string, assetId: string): Promise<Record<string, unknown>> {
  const row = await db.prepare(`SELECT id, storage_key AS storageKey FROM assets WHERE id = ? AND project_id = ?`).bind(assetId, projectId).first<Record<string, unknown>>();
  if (!row) throw new ApiError(404, "ASSET_NOT_FOUND", "资产不存在。 ");
  return row;
}

export async function GET(request: Request, context: RouteContext<{ projectId: string; assetId: string }>): Promise<Response> {
  try {
    const { projectId, assetId } = await context.params; const { db, identity } = await apiContext(request);
    await requireOwnedProject(db, projectId, identity.userId); await ownedAsset(db, projectId, assetId);
    return ok({ asset: await serializeAssetById(db, assetId) });
  } catch (error) { return errorResponse(error); }
}

export async function PATCH(request: Request, context: RouteContext<{ projectId: string; assetId: string }>): Promise<Response> {
  try {
    const { projectId, assetId } = await context.params; const { db, identity } = await apiContext(request);
    await requireOwnedProject(db, projectId, identity.userId); await ownedAsset(db, projectId, assetId);
    const body = await readJsonObject(request); const updates: string[] = []; const values: unknown[] = [];
    for (const [field, column, max, nullable] of [["name", "name", 240, false], ["description", "description", 20_000, false], ["sourceUrl", "source_url", 4_000, true], ["thumbnailUrl", "thumbnail_url", 4_000, true], ["status", "status", 40, false]] as const) {
      let value = optionalString(body, field, { max, nullable });
      if (value !== undefined) {
        if (field === "sourceUrl" || field === "thumbnailUrl") value = safeRemoteUrl(value, field);
        updates.push(`${column} = ?`); values.push(value);
      }
    }
    if ("mediaType" in body) { updates.push("media_type = ?"); values.push(validateAssetMediaType(body.mediaType)); }
    if ("category" in body) { updates.push("category = ?"); values.push(validateAssetCategory(body.category)); }
    const relations = parseAssetRelations(body);
    if ("metadata" in body) {
      if (!body.metadata || typeof body.metadata !== "object" || Array.isArray(body.metadata)) throw new ApiError(400, "INVALID_METADATA", "metadata 必须是 JSON 对象。 ");
      if (JSON.stringify(body.metadata).length > 100_000) throw new ApiError(413, "METADATA_TOO_LARGE", "metadata 内容过大。 ");
      updates.push("metadata_json = ?"); values.push(jsonText(body.metadata, {}));
    }
    if (!updates.length && relations === undefined) throw new ApiError(400, "NO_CHANGES", "没有可保存的资产信息。 ");
    const statements: D1PreparedStatement[] = [];
    if (updates.length) {
      updates.push("updated_at = ?"); values.push(nowIso(), assetId, projectId);
      statements.push(db.prepare(`UPDATE assets SET ${updates.join(", ")} WHERE id = ? AND project_id = ?`).bind(...values));
    }
    if (relations !== undefined) statements.push(...await prepareAssetRelationStatements(db, projectId, assetId, relations));
    statements.push(db.prepare(`UPDATE projects SET updated_at = ? WHERE id = ?`).bind(nowIso(), projectId));
    await db.batch(statements);
    return ok({ asset: await serializeAssetById(db, assetId) });
  } catch (error) { return errorResponse(error); }
}

export async function DELETE(request: Request, context: RouteContext<{ projectId: string; assetId: string }>): Promise<Response> {
  try {
    const { projectId, assetId } = await context.params; const { db, identity } = await apiContext(request);
    await requireOwnedProject(db, projectId, identity.userId); const asset = await ownedAsset(db, projectId, assetId);
    const bucket = asset.storageKey ? bindings().MEDIA : undefined;
    if (asset.storageKey && !bucket) throw new ApiError(503, "MEDIA_STORAGE_NOT_CONFIGURED", "媒体存储尚未配置，无法安全删除文件。 ");
    const now = nowIso();
    await db.batch([
      db.prepare(`DELETE FROM assets WHERE id = ? AND project_id = ?`).bind(assetId, projectId),
      db.prepare(`UPDATE projects SET updated_at = ? WHERE id = ?`).bind(now, projectId),
    ]);
    if (asset.storageKey && bucket) {
      try { await bucket.delete(String(asset.storageKey)); }
      catch { console.error("Deferred R2 asset cleanup is required", { projectId, assetId }); }
    }
    return noContent();
  } catch (error) { return errorResponse(error); }
}
