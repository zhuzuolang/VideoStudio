import { ApiError, created, errorResponse, id, jsonText, nowIso, optionalString, readJsonObject, requiredString } from "@/lib/server/api";
import { parseAssetRelations, safeFilename, validateAssetCategory } from "@/lib/server/assets";
import { apiContext, type RouteContext } from "@/lib/server/context";
import { generateImageWithModel } from "@/lib/server/image-generation";
import { mediaBucket } from "@/lib/server/runtime";
import { prepareAssetRelationStatements, requireOwnedModel, requireOwnedProject, serializeAssetById } from "@/lib/server/store";

export const dynamic = "force-dynamic";

export async function POST(request: Request, context: RouteContext<{ projectId: string }>): Promise<Response> {
  try {
    const { projectId } = await context.params;
    const { db, identity } = await apiContext(request);
    await requireOwnedProject(db, projectId, identity.userId);
    const body = await readJsonObject(request);
    const modelId = requiredString(body, "modelId", { max: 240 });
    const name = requiredString(body, "name", { max: 240 });
    const category = validateAssetCategory(body.category);
    const prompt = requiredString(body, "prompt", { max: 8_000 });
    const size = optionalString(body, "size", { max: 40 }) || undefined;
    const aspectRatio = optionalString(body, "aspectRatio", { max: 20 }) || undefined;
    const relations = parseAssetRelations(body) ?? [];
    const model = await requireOwnedModel(db, modelId, identity.userId);
    const generated = await generateImageWithModel(model, { prompt, size, aspectRatio });
    const assetId = id("ast");
    const extension = generated.mimeType === "image/jpeg" ? "jpg" : generated.mimeType === "image/webp" ? "webp" : "png";
    const storageKey = `projects/${projectId}/${assetId}/${safeFilename(name)}.${extension}`;
    const bucket = mediaBucket();
    await bucket.put(storageKey, generated.bytes, {
      httpMetadata: { contentType: generated.mimeType },
      customMetadata: { projectId, assetId, generatedByModelId: modelId },
    });
    const now = nowIso();
    try {
      const relationStatements = await prepareAssetRelationStatements(db, projectId, assetId, relations);
      await db.batch([
        db.prepare(`INSERT INTO assets (
          id, project_id, name, media_type, category, description, mime_type, size_bytes,
          storage_key, source_url, thumbnail_url, metadata_json, status, created_at, updated_at
        ) VALUES (?, ?, ?, 'image', ?, ?, ?, ?, ?, NULL, NULL, ?, 'ready', ?, ?)`).bind(
          assetId, projectId, name, category, prompt, generated.mimeType, generated.bytes.byteLength, storageKey,
          jsonText({ source: "ai-generation", modelId, prompt, size: size ?? null, aspectRatio: aspectRatio ?? null, providerSourceUrl: generated.sourceUrl, revisedPrompt: generated.revisedPrompt }, {}), now, now,
        ),
        ...relationStatements,
        db.prepare(`UPDATE projects SET updated_at = ? WHERE id = ?`).bind(now, projectId),
      ]);
    } catch (error) {
      try { await bucket.delete(storageKey); }
      catch (cleanupError) { console.error("R2 generation cleanup failed", { projectId, assetId, cleanupError }); }
      throw error;
    }
    return created({ asset: await serializeAssetById(db, assetId) });
  } catch (error) {
    return errorResponse(error instanceof TypeError ? new ApiError(400, "INVALID_GENERATION_REQUEST", "生成参数无效。 ") : error);
  }
}
