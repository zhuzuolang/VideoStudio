import { ApiError, errorResponse, id, jsonText, noContent, nowIso, ok, optionalBoolean, readJsonObject } from "@/lib/server/api";
import {
  generationFailure,
  getAssetGeneration,
  getGenerationStorageKey,
  isSafePreProviderRetryCode,
  markGenerationProviderSubmissionStarted,
  persistGenerationFailure,
  persistGenerationProviderTask,
  releaseGenerationForPolling,
  renewGenerationLease,
  setGenerationStorageKey,
  updateGenerationProgress,
} from "@/lib/server/asset-generation-jobs";
import { safeFilename } from "@/lib/server/assets";
import { apiContext, type RouteContext } from "@/lib/server/context";
import { generateImageWithModel } from "@/lib/server/image-generation";
import { imageTransformationBinding, mediaBucket } from "@/lib/server/runtime";
import { prepareGeneratedAssetRelationStatements, requireOwnedModel, requireOwnedProject, validateAssetRelationTargets } from "@/lib/server/store";
import {
  buildVideoGenerationRequest,
  createVideoGenerationTask,
  getVideoGenerationTask,
  MAX_GENERATED_VIDEO_BYTES,
  openGeneratedVideoStream,
} from "@/lib/server/video-generation";
import { parseVideoReferenceAssets, resolveVideoReferenceAssets } from "@/lib/server/video-reference-assets";
import { storeGeneratedVideoStream } from "@/lib/server/video-storage";

export const dynamic = "force-dynamic";
const LEASE_MS = 300_000;
const LEASE_HEARTBEAT_MS = 45_000;
const VIDEO_POLL_AFTER_MS = 5_000;
const VIDEO_POLL_RETRY_AFTER_MS = 15_000;
const TRANSIENT_VIDEO_TASK_QUERY_CODES = new Set([
  "VIDEO_MODEL_TIMEOUT",
  "VIDEO_MODEL_NETWORK_ERROR",
  "VIDEO_RATE_LIMITED",
  "VIDEO_PROVIDER_UNAVAILABLE",
  "INVALID_VIDEO_TASK_RESPONSE",
  "VIDEO_RESPONSE_STREAM_FAILED",
]);
const VIDEO_TASK_RESTART_CODES = new Set([
  "VIDEO_TASK_NOT_FOUND",
  "VIDEO_TASK_FAILED",
  "VIDEO_TASK_CANCELLED",
  "VIDEO_TASK_EXPIRED",
]);

function shouldContinueVideoTaskPolling(error: unknown): error is ApiError {
  return error instanceof ApiError && TRANSIENT_VIDEO_TASK_QUERY_CODES.has(error.code);
}

type StoredVideoCheckpoint = {
  assetId: string;
  storageKey: string;
  mimeType: "video/mp4" | "video/quicktime";
  size: number;
};

function reusableStoredVideo(
  object: R2Object | null,
  storageKey: string,
  projectId: string,
  generationId: string,
): StoredVideoCheckpoint | null {
  if (!object || !Number.isSafeInteger(object.size) || object.size <= 0 || object.size > MAX_GENERATED_VIDEO_BYTES) return null;
  const prefix = `projects/${projectId}/`;
  if (!storageKey.startsWith(prefix)) return null;
  const [assetId, filename, ...extra] = storageKey.slice(prefix.length).split("/");
  if (!assetId?.startsWith("ast_") || !filename || extra.length > 0) return null;
  const mimeType = object.httpMetadata?.contentType;
  if (mimeType !== "video/mp4" && mimeType !== "video/quicktime") return null;
  const metadata = object.customMetadata;
  if (metadata?.projectId !== projectId
    || metadata.assetId !== assetId
    || metadata.generationId !== generationId) return null;
  return { assetId, storageKey, mimeType, size: object.size };
}

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
  let generationMediaType: "image" | "video" = "image";
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
    const confirmedRetry = optionalBoolean(body, "confirmedRetry") ?? false;
    const generation = await getAssetGeneration(db, projectId, identity.userId, generationId);
    generationMediaType = generation.mediaType;
    if (confirmedRetry && (!retry || generation.status !== "failed")) {
      throw new ApiError(400, "INVALID_GENERATION_RETRY", "确认重试只能用于已经失败的生成任务。");
    }
    const restartProviderTask = confirmedRetry
      && generation.mediaType === "video"
      && Boolean(generation.providerTaskId)
      && VIDEO_TASK_RESTART_CODES.has(generation.errorCode || "");
    const canResumeProviderTask = generation.mediaType === "video"
      && Boolean(generation.providerTaskId)
      && !VIDEO_TASK_RESTART_CODES.has(generation.errorCode || "");
    const safePreProviderRetry = generation.mediaType === "video"
      && !generation.providerTaskId
      && generation.progress < 15
      && isSafePreProviderRetryCode(generation.errorCode);

    if (generation.status === "succeeded") return ok({ generation });
    if (generation.status === "failed" && !retry) {
      throw new ApiError(409, "GENERATION_RETRY_REQUIRED", "该生成任务已失败，请确认后重试。");
    }
    if (generation.status === "failed" && retry
      && !generation.retryable && !confirmedRetry && !canResumeProviderTask && !safePreProviderRetry) {
      throw new ApiError(409, "GENERATION_NOT_RETRYABLE", generation.errorMessage || "当前错误无法通过重复请求解决，请修改模型配置或提示词后新建任务。");
    }
    // The three-attempt cap guards automatic retries. Owner-confirmed retries may
    // proceed after the cap, as may failures proven to occur before provider dispatch.
    if (generation.status === "failed" && retry && !confirmedRetry && !safePreProviderRetry
      && !generation.providerTaskId && generation.attemptCount >= 3) {
      throw new ApiError(409, "GENERATION_ATTEMPT_LIMIT", "该任务已达到 3 次尝试上限，请检查模型配置后新建任务。");
    }

    leaseToken = id("lease");
    const now = nowIso();
    const leaseExpiresAt = new Date(Date.now() + LEASE_MS).toISOString();
    const claim = generation.status === "failed"
      ? await db.prepare(`UPDATE asset_generation_jobs SET
          status = 'running', phase = 'model',
          progress = CASE WHEN media_type = 'video' AND (provider_task_id IS NULL OR ? = 1) THEN 10 ELSE 15 END,
          attempt_count = attempt_count + CASE WHEN provider_task_id IS NULL OR ? = 1 THEN 1 ELSE 0 END,
          provider_task_id = CASE WHEN ? = 1 THEN NULL ELSE provider_task_id END,
          lease_token = ?, lease_expires_at = ?, error_code = NULL, error_message = NULL,
          next_poll_at = NULL, updated_at = ?, started_at = ?, completed_at = NULL
        WHERE id = ? AND project_id = ? AND owner_id = ? AND status = 'failed'
          AND dismissed_at IS NULL
          AND (? = 1 OR ? = 1 OR provider_task_id IS NOT NULL OR attempt_count < 3)`)
        .bind(
          restartProviderTask ? 1 : 0,
          restartProviderTask ? 1 : 0,
          restartProviderTask ? 1 : 0,
          leaseToken,
          leaseExpiresAt,
          now,
          now,
          generationId,
          projectId,
          identity.userId,
          confirmedRetry ? 1 : 0,
          safePreProviderRetry ? 1 : 0,
        ).run()
      : await db.prepare(`UPDATE asset_generation_jobs SET
          status = 'running', phase = 'model',
          progress = CASE WHEN media_type = 'video' AND provider_task_id IS NULL
            THEN MAX(progress, 10) ELSE MAX(progress, 15) END,
          attempt_count = attempt_count + CASE WHEN provider_task_id IS NULL THEN 1 ELSE 0 END,
          lease_token = ?, lease_expires_at = ?, error_code = NULL, error_message = NULL,
          next_poll_at = NULL, updated_at = ?, started_at = COALESCE(started_at, ?), completed_at = NULL
        WHERE id = ? AND project_id = ? AND owner_id = ?
          AND dismissed_at IS NULL AND (provider_task_id IS NOT NULL OR attempt_count < 3)
          AND (status = 'queued' OR (status = 'running'
            AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
            AND (next_poll_at IS NULL OR next_poll_at <= ?)
            AND NOT (media_type = 'video' AND provider_task_id IS NULL
              AND attempt_count > 0 AND progress >= 15)))`)
        .bind(leaseToken, leaseExpiresAt, now, now, generationId, projectId, identity.userId, now, now).run();

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

    await validateAssetRelationTargets(db, projectId, generation.relations);
    let bucket: R2Bucket;
    try {
      bucket = mediaBucket();
    } catch (error) {
      console.error("Media bucket binding is unavailable", { projectId, generationId, error });
      throw new ApiError(503, "MEDIA_STORAGE_UNAVAILABLE", "媒体存储尚未配置或暂时不可用，生成模型尚未开始调用。");
    }
    const previousStorageKey = await getGenerationStorageKey(db, generationId, leaseToken);
    let storedVideo: StoredVideoCheckpoint | null = null;
    if (previousStorageKey) {
      try {
        storedVideo = generation.mediaType === "video"
          ? reusableStoredVideo(
              await bucket.head(previousStorageKey),
              previousStorageKey,
              projectId,
              generationId,
            )
          : null;
        if (!storedVideo) {
          await bucket.delete(previousStorageKey);
          await setGenerationStorageKey(db, generationId, leaseToken, null);
        }
      } catch (error) {
        console.error("Previous generation media recovery failed", {
          projectId,
          generationId,
          previousStorageKey,
          errorName: error instanceof Error ? error.name : typeof error,
          errorMessage: (error instanceof Error ? error.message : String(error)).slice(0, 500),
        });
        throw new ApiError(503, "GENERATION_CLEANUP_FAILED", "上一次尝试保留的媒体文件暂时无法核验或清理，生成模型尚未重新调用。");
      }
    }
    let generatedBytes: Uint8Array | null = null;
    let generatedVideoStream: Awaited<ReturnType<typeof openGeneratedVideoStream>> | null = null;
    let generatedMimeType: string = storedVideo?.mimeType ?? "";
    let generatedSize = storedVideo?.size ?? 0;
    let revisedPrompt: string | null = null;
    let providerUsage: Record<string, unknown> | null = null;
    let resolvedProviderTaskId = restartProviderTask ? null : generation.providerTaskId ?? null;
    let assetId = storedVideo?.assetId ?? "";
    let storageKey = storedVideo?.storageKey ?? "";

    if (!storedVideo) {
      const model = await requireOwnedModel(db, generation.modelId || "", identity.userId);
      if (generation.mediaType === "video") {
        if (!resolvedProviderTaskId) {
          const referenceImages = await resolveVideoReferenceAssets(
            db,
            bucket,
            projectId,
            parseVideoReferenceAssets(generation.options.referenceImages),
            imageTransformationBinding(),
          );
          const videoInput = {
            prompt: generation.prompt,
            resolution: generation.options.resolution,
            aspectRatio: generation.aspectRatio || undefined,
            duration: generation.options.duration,
            generateAudio: generation.options.generateAudio,
            referenceImages,
            referenceImageUrl: generation.options.referenceImageUrl,
            referenceImageRole: generation.options.referenceImageRole,
            signal: leaseAbortController.signal,
          };
          // Validate the model-specific profile before marking the call as potentially billable.
          buildVideoGenerationRequest(model, videoInput);
          const created = await createVideoGenerationTask(model, videoInput, fetch, {
            beforeDispatch: async () => {
              await markGenerationProviderSubmissionStarted(db as D1Database, generationId, leaseToken);
              providerInvoked = true;
            },
          });
          resolvedProviderTaskId = created.taskId;
          await persistGenerationProviderTask(
            db,
            generationId,
            leaseToken,
            resolvedProviderTaskId,
            VIDEO_POLL_AFTER_MS,
          );
          if (leaseHeartbeat) clearInterval(leaseHeartbeat);
          leaseHeartbeat = null;
          leaseToken = "";
          return ok({ generation: await getAssetGeneration(db, projectId, identity.userId, generationId) }, { status: 202 });
        }

        let task: Awaited<ReturnType<typeof getVideoGenerationTask>>;
        try {
          task = await getVideoGenerationTask(model, resolvedProviderTaskId, fetch, leaseAbortController.signal);
        } catch (error) {
          if (!shouldContinueVideoTaskPolling(error)) throw error;
          await releaseGenerationForPolling(
            db,
            generationId,
            leaseToken,
            Math.max(25, generation.progress),
            VIDEO_POLL_RETRY_AFTER_MS,
            {
              code: "VIDEO_STATUS_SYNC_DELAYED",
              message: "官方视频任务状态暂时未同步，系统会继续查询，不会停止生成。",
            },
          );
          if (leaseHeartbeat) clearInterval(leaseHeartbeat);
          leaseHeartbeat = null;
          leaseToken = "";
          return ok({ generation: await getAssetGeneration(db, projectId, identity.userId, generationId) }, { status: 202 });
        }
        if (task.status === "queued" || task.status === "running") {
          const progress = task.status === "queued"
            ? Math.max(35, generation.progress)
            : Math.max(50, generation.progress);
          await releaseGenerationForPolling(db, generationId, leaseToken, progress, VIDEO_POLL_AFTER_MS);
          if (leaseHeartbeat) clearInterval(leaseHeartbeat);
          leaseHeartbeat = null;
          leaseToken = "";
          return ok({ generation: await getAssetGeneration(db, projectId, identity.userId, generationId) }, { status: 202 });
        }
        if (task.status === "failed") {
          throw new ApiError(422, "VIDEO_TASK_FAILED", task.errorMessage || "视频生成任务执行失败，请调整素材或参数后新建任务。");
        }
        if (task.status === "cancelled") {
          throw new ApiError(409, "VIDEO_TASK_CANCELLED", "视频生成任务已由服务商取消，请新建任务后重试。");
        }
        if (task.status === "expired") {
          throw new ApiError(410, "VIDEO_TASK_EXPIRED", "视频生成任务及结果已过期，请新建任务后重试。");
        }
        await updateGenerationProgress(db, generationId, leaseToken, "storage", 82);
        generatedVideoStream = await openGeneratedVideoStream(task.videoUrl as string, fetch, leaseAbortController.signal);
        generatedMimeType = generatedVideoStream.mimeType;
        providerUsage = task.usage ?? null;
      } else {
        providerInvoked = true;
        const generated = await generateImageWithModel(model, {
          prompt: generation.prompt,
          size: generation.size || undefined,
          aspectRatio: generation.aspectRatio || undefined,
          signal: leaseAbortController.signal,
        });
        generatedBytes = generated.bytes;
        generatedMimeType = generated.mimeType;
        generatedSize = generated.bytes.byteLength;
        revisedPrompt = generated.revisedPrompt;
        await updateGenerationProgress(db, generationId, leaseToken, "storage", 82);
      }
    }

    if (!storedVideo) {
      assetId = id("ast");
      const extension = generatedMimeType === "video/quicktime"
        ? "mov"
        : generatedMimeType === "video/mp4"
          ? "mp4"
          : generatedMimeType === "image/jpeg"
            ? "jpg"
            : generatedMimeType === "image/webp"
              ? "webp"
              : "png";
      storageKey = `projects/${projectId}/${assetId}/${safeFilename(generation.name)}.${extension}`;
      try {
        await setGenerationStorageKey(db, generationId, leaseToken, storageKey);
      } catch (error) {
        await generatedVideoStream?.body.cancel(error).catch(() => undefined);
        throw error;
      }
      try {
        const putOptions = {
          httpMetadata: { contentType: generatedMimeType },
          customMetadata: { projectId, assetId, generatedByModelId: generation.modelId || "unknown", generationId },
        };
        if (generatedVideoStream) {
          generatedSize = await storeGeneratedVideoStream(bucket, storageKey, generatedVideoStream, putOptions);
        } else {
          await bucket.put(storageKey, generatedBytes as Uint8Array, putOptions);
        }
      } catch (error) {
        await generatedVideoStream?.body.cancel(error).catch(() => undefined);
        if (error instanceof ApiError) throw error;
        console.error("Generated media R2 write failed", {
          projectId,
          generationId,
          assetId,
          mediaType: generation.mediaType,
          errorName: error instanceof Error ? error.name : typeof error,
          errorMessage: (error instanceof Error ? error.message : String(error)).slice(0, 500),
        });
        throw new ApiError(
          503,
          generation.mediaType === "video" ? "VIDEO_STORAGE_FAILED" : "IMAGE_STORAGE_FAILED",
          `${generation.mediaType === "video" ? "视频" : "图片"}已经生成，但媒体存储暂时不可用，未能写入资产库。请稍后重试。`,
        );
      }
    }

    try {
      await updateGenerationProgress(db, generationId, leaseToken, "finalize", 94);
      const relationStatements = prepareGeneratedAssetRelationStatements(db, projectId, assetId, generation.relations);
      const completedAt = nowIso();
      const results = await db.batch([
        db.prepare(`INSERT INTO assets (
          id, project_id, name, media_type, category, description, mime_type, size_bytes,
          storage_key, source_url, thumbnail_url, metadata_json, status, created_at, updated_at
        ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, 'ready', ?, ?
          WHERE EXISTS (SELECT 1 FROM asset_generation_jobs
            WHERE id = ? AND status = 'running' AND lease_token = ?)`).bind(
          assetId, projectId, generation.name, generation.mediaType, generation.category, generation.prompt,
          generatedMimeType, generatedSize, storageKey,
          jsonText({ source: "ai-generation", generationId, modelId: generation.modelId, prompt: generation.prompt,
            mediaType: generation.mediaType, size: generation.size, aspectRatio: generation.aspectRatio,
            options: generation.options, revisedPrompt, providerTaskId: resolvedProviderTaskId, usage: providerUsage }, {}),
          completedAt, completedAt, generationId, leaseToken,
        ),
        ...relationStatements,
        db.prepare(`UPDATE asset_generation_jobs SET
          status = 'succeeded', phase = 'completed', progress = 100, asset_id = ?,
          lease_token = NULL, lease_expires_at = NULL, error_code = NULL, error_message = NULL,
          next_poll_at = NULL, updated_at = ?, completed_at = ?
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
      // Keep the object and storage_key until the job state is known. A D1 batch can
      // commit and still lose its response; deleting here could leave a succeeded
      // asset pointing at a missing R2 object. A retry verifies and reuses this object.
      if (error instanceof ApiError) throw error;
      console.error("Generated media database finalization failed", { projectId, generationId, assetId, mediaType: generation.mediaType, error });
      throw new ApiError(
        503,
        generation.mediaType === "video" ? "VIDEO_ASSET_FINALIZE_FAILED" : "IMAGE_ASSET_FINALIZE_FAILED",
        `${generation.mediaType === "video" ? "视频" : "图片"}已经生成，但保存资产记录的结果暂时无法确认。系统已保留媒体文件供安全恢复。`,
      );
    }

    // Avoid a post-commit relation query here: the previous synchronous route could save the
    // asset successfully and then incorrectly return 500 while serializing that response.
    if (leaseHeartbeat) clearInterval(leaseHeartbeat);
    leaseHeartbeat = null;
    return ok({ generation: { id: generationId, status: "succeeded", phase: "completed", progress: 100, assetId } });
  } catch (error) {
    if (leaseHeartbeat) clearInterval(leaseHeartbeat);
    const failure = generationFailure(error, providerInvoked, generationMediaType);
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
