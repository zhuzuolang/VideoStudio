import { ApiError, created, errorResponse, id, jsonText, nowIso, ok, optionalString, readJsonObject, requiredString } from "@/lib/server/api";
import { inferAssetMediaType, parseAssetRelations, safeFilename, safeRemoteUrl, validateAssetCategory, validateAssetMediaType } from "@/lib/server/assets";
import { apiContext, type RouteContext } from "@/lib/server/context";
import { mediaBucket } from "@/lib/server/runtime";
import { allRows, prepareAssetRelationStatements, requireOwnedProject, serializeAssetById } from "@/lib/server/store";

export const dynamic = "force-dynamic";
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

export async function GET(request: Request, context: RouteContext<{ projectId: string }>): Promise<Response> {
  try {
    const { projectId } = await context.params; const { db, identity } = await apiContext(request);
    await requireOwnedProject(db, projectId, identity.userId);
    const rows = await allRows(db.prepare(`SELECT id FROM assets WHERE project_id = ? ORDER BY updated_at DESC`).bind(projectId));
    const assets = (await Promise.all(rows.map((row) => serializeAssetById(db, String(row.id))))).filter(Boolean);
    return ok({ assets });
  } catch (error) { return errorResponse(error); }
}

export async function POST(request: Request, context: RouteContext<{ projectId: string }>): Promise<Response> {
  try {
    const { projectId } = await context.params; const { db, identity } = await apiContext(request);
    await requireOwnedProject(db, projectId, identity.userId);
    const contentType = request.headers.get("content-type") || "";
    return contentType.toLowerCase().startsWith("multipart/form-data")
      ? await uploadAsset(request, db, projectId)
      : await createMetadataAsset(request, db, projectId);
  } catch (error) { return errorResponse(error); }
}

async function createMetadataAsset(request: Request, db: D1Database, projectId: string): Promise<Response> {
  const body = await readJsonObject(request);
  const name = requiredString(body, "name", { max: 240 });
  const mediaType = validateAssetMediaType(body.mediaType);
  const category = validateAssetCategory(body.category);
  const relations = parseAssetRelations(body) ?? [];
  const description = optionalString(body, "description", { max: 20_000 }) || "";
  const sourceUrl = safeRemoteUrl(optionalString(body, "sourceUrl", { max: 4_000, nullable: true }), "sourceUrl");
  const thumbnailUrl = safeRemoteUrl(optionalString(body, "thumbnailUrl", { max: 4_000, nullable: true }), "thumbnailUrl");
  const status = optionalString(body, "status", { max: 40 }) || (sourceUrl ? "ready" : "planned");
  const metadata = validatedMetadata(body.metadata);
  const assetId = id("ast"); const now = nowIso();
  const relationStatements = await prepareAssetRelationStatements(db, projectId, assetId, relations);
  await db.batch([
    db.prepare(`INSERT INTO assets (id, project_id, name, media_type, category, description, mime_type, size_bytes, storage_key, source_url, thumbnail_url, metadata_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?)`).bind(assetId, projectId, name, mediaType, category, description, sourceUrl ?? null, thumbnailUrl ?? null, jsonText(metadata, {}), status, now, now),
    ...relationStatements,
    db.prepare(`UPDATE projects SET updated_at = ? WHERE id = ?`).bind(now, projectId),
  ]);
  return created({ asset: await serializeAssetById(db, assetId) });
}

async function uploadAsset(request: Request, db: D1Database, projectId: string): Promise<Response> {
  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof File)) throw new ApiError(400, "FILE_REQUIRED", "请在 file 字段中上传文件。 ");
  if (file.size <= 0) throw new ApiError(400, "EMPTY_FILE", "不能上传空文件。 ");
  if (file.size > MAX_UPLOAD_BYTES) throw new ApiError(413, "FILE_TOO_LARGE", "单个文件不能超过 100 MB。 ");
  const requestedName = form.get("name");
  const name = typeof requestedName === "string" && requestedName.trim() ? requestedName.trim().slice(0, 240) : safeFilename(file.name);
  const requestedMediaType = form.get("mediaType");
  const mediaType = requestedMediaType ? validateAssetMediaType(requestedMediaType) : inferAssetMediaType(file.type);
  const category = validateAssetCategory(form.get("category") || "other");
  const descriptionValue = form.get("description");
  const description = typeof descriptionValue === "string" ? descriptionValue.trim().slice(0, 20_000) : "";
  const metadataValue = form.get("metadata");
  let metadata: unknown = {};
  if (typeof metadataValue === "string" && metadataValue.trim()) {
    try { metadata = JSON.parse(metadataValue); } catch { throw new ApiError(400, "INVALID_METADATA", "metadata 必须是有效 JSON。 "); }
  }
  metadata = validatedMetadata(metadata);
  let relationBody: Record<string, unknown> = {};
  const relationsValue = form.get("relations");
  if (typeof relationsValue === "string" && relationsValue.trim()) {
    try { relationBody = { relations: JSON.parse(relationsValue) }; } catch { throw new ApiError(400, "INVALID_ASSET_RELATIONS", "relations 必须是有效 JSON。 "); }
  }
  const relations = parseAssetRelations(relationBody) ?? [];
  const assetId = id("ast"); const now = nowIso();
  const storageKey = `projects/${projectId}/${assetId}/${safeFilename(file.name)}`;
  const bucket = mediaBucket();
  await bucket.put(storageKey, file.stream(), { httpMetadata: { contentType: file.type || "application/octet-stream" }, customMetadata: { projectId, assetId } });
  try {
    const relationStatements = await prepareAssetRelationStatements(db, projectId, assetId, relations);
    await db.batch([
      db.prepare(`INSERT INTO assets (id, project_id, name, media_type, category, description, mime_type, size_bytes, storage_key, source_url, thumbnail_url, metadata_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, 'ready', ?, ?)`).bind(assetId, projectId, name, mediaType, category, description, file.type || "application/octet-stream", file.size, storageKey, jsonText(metadata, {}), now, now),
      ...relationStatements,
      db.prepare(`UPDATE projects SET updated_at = ? WHERE id = ?`).bind(now, projectId),
    ]);
  } catch (error) {
    try { await bucket.delete(storageKey); }
    catch (cleanupError) { console.error("R2 upload cleanup failed", { projectId, assetId, cleanupError }); }
    throw error;
  }
  return created({ asset: await serializeAssetById(db, assetId) });
}

function validatedMetadata(value: unknown): Record<string, unknown> {
  const result = value ?? {};
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new ApiError(400, "INVALID_METADATA", "metadata 必须是 JSON 对象。 ");
  if (JSON.stringify(result).length > 100_000) throw new ApiError(413, "METADATA_TOO_LARGE", "metadata 内容过大。 ");
  return result as Record<string, unknown>;
}
