import { ApiError, errorResponse, id, jsonText, noContent, nowIso, ok, optionalBoolean, readJsonObject } from "@/lib/server/api";
import { generationFailure, getAssetGeneration, getGenerationStorageKey, persistGenerationFailure, renewGenerationLease, setGenerationStorageKey, updateGenerationProgress } from "@/lib/server/asset-generation-jobs";
import { safeFilename } from "@/lib/server/assets";
import { apiContext, type RouteContext } from "@/lib/server/context";
import { generateImageWithModel } from "@/lib/server/image-generation";
import { mediaBucket } from "@/lib/server/runtime";
import { prepareGeneratedAssetRelationStatements, requireOwnedModel, requireOwnedProject, validateAssetRelationTargets } from "@/lib/server/store";

export const dynamic = "force-dynamic";
const LEASE_MS = 300_000;
const LEASE_HEARTBEAT_MS = 45_000;

export async function GET(request: Request, context: RouteContext<{ projectId: string; generationId: string }>): Promise<Response> {
  try {
    const { projectId, generationId } = await context.params;
    const { db, identity } = await apiContext(request);
    await requireOwnedProject(db, projectId, identity.userId);
    return ok({ generation: await getAssetGeneration(db, projectId, identity.userId, generationId) });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: Request, context: RouteContext<{ projectId: string; generationId: string }>): Promise<Response> {
  try {
    const { projectId, generationId } = await context.params;
    const { db, identity } = await apiContext(request);
    await requireOwnedProject(db, projectId, identity.userId);
    const generation = await getAssetGeneration(db, projectId, identity.userId, generationId);
    if (generation.status !== "failed" && generation.status !== "succeeded") {
      throw new ApiError(409, "GENERATION_DISMISS_NOT_ALLOWED", "只能移除已经成功或失败的生成任务记录。");
    }
    const dismissedAt = nowIso();
    const result = await db.prepare(`UPDATE asset_generation_jobs SET dismissed_at = ?, updated_at = ?
      WHERE id = ? AND project_id = ? AND owner_id = ? AND status = ? AND dismissed_at IS NULL`)
      .bind(dismissedAt, dismissedAt, generationId, projectId, identity.userId, generation.status)
      .run();
    if (!result.meta.changes) throw new ApiError(409, "GENERATION_DISMISS_NOT_ALLOWED", "只能移除已经成功或失败的生成任务记录。");
    if (generation.status === "failed") {
      const storageKey = await getGenerationStorageKey(db, generationId);
      if (storageKey) {
        try {
          await mediaBucket().delete(storageKey);
          await db.prepare(`UPDATE asset_generation_jobs SET storage_key = NULL, updated_at = ?
            WHERE id = ? AND project_id = ? AND owner_id = ? AND dismissed_at = ?`)
            .bind(nowIso(), generationId, projectId, identity.userId, dismissedAt)
            .run();
        } catch (error) {
          await db.prepare(`UPDATE asset_generation_jobs SET dismissed_at = NULL, updated_at = ?
            WHERE id = ? AND project_id = ? AND owner_id = ? AND dismissed_at = ?`)
            .bind(nowIso(), generationId, projectId, identity.userId, dismissedAt)
            .run();
          console.error("Dismissed generation media cleanup failed", { projectId, generationId, error });
          throw new ApiError(503, "GENERATION_CLEANUP_FAILED", "残留媒体文件暂时无法清理，请稍后再移除记录。");
        }
      }
    }
    return noContent();
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request, context: RouteContext<{ projectId: string; generationId: string }>): Promise<Response> {
  let generationId = "";
  let leaseToken = "";
  let db: D1Database | null = null;
  let leaseHeartbeat: ReturnType<typeof setInterval> | null = null;
  let leaseAbortController: AbortController | null = null;
  let providerInvoked = false;
  try {
    const params = await context.params;
    generationId = params.generationId;
    const projectId = params.projectId;
    const api = await apiContext(request);
    db = api.db;
    const { identity } = api;
    await requireOwnedProject(db, projectId, identity.userId);
    const body = await readJsonObject(request);
    const retry = optionalBoolean(body, "retry") ?? false;
    const generation = await getAssetGeneration(db, projectId, identity.userId, generationId);

    if (generation.status === "succeeded") return ok({ generation });
    if (generation.status === "failed" && !retry) {
      throw new ApiError(409, "GENERATION_RETRY_REQUIRED", "该生成任务已失败，请确认后重试。");
    }
    if (generation.status === "failed" && retry && !generation.retryable) {
      throw new ApiError(409, "GENERATION_NOT_RETRYABLE", generation.errorMessage || "当前错误无法通过重复请求解决，请修改模型配置或提示词后新建任务。");
    }
    if (generation.status === "failed" && retry && generation.attemptCount >= 3) {
      throw new ApiError(409, "GENERATION_ATTEMPT_LIMIT", "该任务已达到 3 次尝试上限，请检查模型配置后新建任务。");
    }

    leaseToken = id("lease");
    const now = nowIso();
    const leaseExpiresAt = new Date(Date.now() + LEASE_MS).toISOString();
    const claim = generation.status === "failed"
      ? await db.prepare(`UPDATE asset_generation_jobs SET
          status = 'running', phase = 'model', progress = 15, attempt_count = attempt_count + 1,
          lease_token = ?, lease_expires_at = ?, error_code = NULL, error_message = NULL,
          updated_at = ?, started_at = ?, completed_at = NULL
        WHERE id = ? AND project_id = ? AND owner_id = ? AND status = 'failed'
          AND dismissed_at IS NULL AND attempt_count < 3`)
        .bind(leaseToken, leaseExpiresAt, now, now, generationId, projectId, identity.userId).run()
      : await db.prepare(`UPDATE asset_generation_jobs SET
          status = 'running', phase = 'model', progress = 15, attempt_count = attempt_count + 1,
          lease_token = ?, lease_expires_at = ?, error_code = NULL, error_message = NULL,
          updated_at = ?, started_at = COALESCE(started_at, ?), completed_at = NULL
        WHERE id = ? AND project_id = ? AND owner_id = ?
          AND dismissed_at IS NULL AND attempt_count < 3
          AND (status = 'queued' OR (status = 'running' AND (lease_expires_at IS NULL OR lease_expires_at <= ?)))`)
        .bind(leaseToken, leaseExpiresAt, now, now, generationId, projectId, identity.userId, now).run();

    if (!claim.meta.changes) {
      return ok({ generation: await getAssetGeneration(db, projectId, identity.userId, generationId) }, { status: 202 });
    }
    leaseAbortController = new AbortController();
    leaseHeartbeat = setInterval(() => {
      void renewGenerationLease(db as D1Database, generationId, leaseToken).catch((error) => {
        console.error("Asset generation lease heartbeat failed", { generationId, error });
        if (error instanceof ApiError && error.code === "GENERATION_LEASE_LOST") {
          leaseAbortController?.abort(error);
        }
      });
    }, LEASE_HEARTBEAT_MS);

    const model = await requireOwnedModel(db, generation.modelId || "", identity.userId);
    await validateAssetRelationTargets(db, projectId, generation.relations);
    let bucket: R2Bucket;
    try {
      bucket = mediaBucket();
    } catch (error) {
      console.error("Media bucket binding is unavailable", { projectId, generationId, error });
      throw new ApiError(503, "MEDIA_STORAGE_UNAVAILABLE", "媒体存储尚未配置或暂时不可用，图片模型尚未开始调用。");
    }
    const previousStorageKey = await getGenerationStorageKey(db, generationId, leaseToken);
    if (previousStorageKey) {
      try {
        await bucket.delete(previousStorageKey);
        await setGenerationStorageKey(db, generationId, leaseToken, null);
      } catch (error) {
        console.error("Previous generation media cleanup failed", { projectId, generationId, previousStorageKey, error });
        throw new ApiError(503, "GENERATION_CLEANUP_FAILED", "上一次尝试留下的媒体文件暂时无法清理，图片模型尚未重新调用。");
      }
    }
    providerInvoked = true;
    const generated = await generateImageWithModel(model, {
      prompt: generation.prompt,
      size: generation.size || undefined,
      aspectRatio: generation.aspectRatio || undefined,
      signal: leaseAbortController.signal,
    });
    await updateGenerationProgress(db, generationId, leaseToken, "storage", 82);

    const assetId = id("ast");
    const extension = generated.mimeType === "image/jpeg" ? "jpg" : generated.mimeType === "image/webp" ? "webp" : "png";
    const storageKey = `projects/${projectId}/${assetId}/${safeFilename(generation.name)}.${extension}`;
    await setGenerationStorageKey(db, generationId, leaseToken, storageKey);
    try {
      await bucket.put(storageKey, generated.bytes, {
        httpMetadata: { contentType: generated.mimeType },
        customMetadata: { projectId, assetId, generatedByModelId: generation.modelId || "unknown", generationId },
      });
    } catch (error) {
      console.error("Generated image R2 write failed", { projectId, generationId, assetId, error });
      throw new ApiError(503, "IMAGE_STORAGE_FAILED", "图片已经生成，但媒体存储暂时不可用，未能写入资产库。请稍后重试。");
    }

    try {
      await updateGenerationProgress(db, generationId, leaseToken, "finalize", 94);
      const relationStatements = prepareGeneratedAssetRelationStatements(db, projectId, assetId, generation.relations);
      const completedAt = nowIso();
      const results = await db.batch([
        db.prepare(`INSERT INTO assets (
          id, project_id, name, media_type, category, description, mime_type, size_bytes,
          storage_key, source_url, thumbnail_url, metadata_json, status, created_at, updated_at
        ) SELECT ?, ?, ?, 'image', ?, ?, ?, ?, ?, NULL, NULL, ?, 'ready', ?, ?
          WHERE EXISTS (SELECT 1 FROM asset_generation_jobs
            WHERE id = ? AND status = 'running' AND lease_token = ?)`).bind(
          assetId, projectId, generation.name, generation.category, generation.prompt,
          generated.mimeType, generated.bytes.byteLength, storageKey,
          jsonText({ source: "ai-generation", generationId, modelId: generation.modelId, prompt: generation.prompt,
            size: generation.size, aspectRatio: generation.aspectRatio, revisedPrompt: generated.revisedPrompt }, {}),
          completedAt, completedAt, generationId, leaseToken,
        ),
        ...relationStatements,
        db.prepare(`UPDATE asset_generation_jobs SET
          status = 'succeeded', phase = 'completed', progress = 100, asset_id = ?,
          lease_token = NULL, lease_expires_at = NULL, error_code = NULL, error_message = NULL,
          updated_at = ?, completed_at = ?
          WHERE id = ? AND status = 'running' AND lease_token = ?`)
          .bind(assetId, completedAt, completedAt, generationId, leaseToken),
        db.prepare(`UPDATE projects SET updated_at = ? WHERE id = ?`).bind(completedAt, projectId),
      ]);
      const assetInsert = results[0];
      const jobUpdate = results.at(-2);
      if (!assetInsert?.meta.changes || !jobUpdate?.meta.changes) {
        throw new ApiError(409, "GENERATION_LEASE_LOST", "生成任务执行权已过期，当前结果不会写入资产库。");
      }
    } catch (error) {
      try {
        await bucket.delete(storageKey);
        await setGenerationStorageKey(db, generationId, leaseToken, null);
      } catch (cleanupError) {
        console.error("Generated image cleanup failed", { projectId, generationId, assetId, cleanupError });
      }
      if (error instanceof ApiError) throw error;
      console.error("Generated image database finalization failed", { projectId, generationId, assetId, error });
      throw new ApiError(503, "IMAGE_ASSET_FINALIZE_FAILED", "图片已经生成，但保存资产记录失败，媒体文件已清理。请稍后重试。");
    }

    // Avoid a post-commit relation query here: the previous synchronous route could save the
    // asset successfully and then incorrectly return 500 while serializing that response.
    if (leaseHeartbeat) clearInterval(leaseHeartbeat);
    leaseHeartbeat = null;
    return ok({ generation: { id: generationId, status: "succeeded", phase: "completed", progress: 100, assetId } });
  } catch (error) {
    if (leaseHeartbeat) clearInterval(leaseHeartbeat);
    const failure = generationFailure(error, providerInvoked);
    if (db && generationId && leaseToken) {
      try {
        await persistGenerationFailure(db, generationId, leaseToken, failure);
      } catch (persistError) {
        console.error("Asset generation error state persistence failed", { generationId, code: failure.code, persistError });
      }
    }
    return errorResponse(error instanceof ApiError
      ? error
      : new ApiError(500, failure.code, failure.message));
  }
}
