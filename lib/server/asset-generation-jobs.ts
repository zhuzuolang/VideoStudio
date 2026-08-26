import type { AssetGenerationJob, AssetRelationInput } from "../platform-types";
import { ApiError, nowIso, parseJson } from "./api";
import { allRows } from "./store";

const generationSelect = `SELECT id, project_id AS projectId, owner_id AS ownerId,
  client_request_id AS clientRequestId, model_id AS modelId, model_name AS modelName,
  media_type AS mediaType,
  name, category, prompt, size, aspect_ratio AS aspectRatio, relations_json AS relationsJson,
  options_json AS optionsJson, provider_task_id AS providerTaskId, next_poll_at AS nextPollAt,
  status, phase, progress, attempt_count AS attemptCount,
  lease_token AS leaseToken, lease_expires_at AS leaseExpiresAt,
  error_code AS errorCode, error_message AS errorMessage, retryable,
  asset_id AS assetId, storage_key AS storageKey, dismissed_at AS dismissedAt,
  created_at AS createdAt, updated_at AS updatedAt,
  started_at AS startedAt, completed_at AS completedAt
  FROM asset_generation_jobs`;

export type GenerationFailure = {
  code: string;
  message: string;
  retryable: boolean;
};

export function serializeAssetGeneration(row: Record<string, unknown>): AssetGenerationJob {
  const status = String(row.status) as AssetGenerationJob["status"];
  const attemptCount = Math.max(0, Number(row.attemptCount) || 0);
  const leaseExpiresAt = typeof row.leaseExpiresAt === "string" ? row.leaseExpiresAt : null;
  const leaseExpired = !leaseExpiresAt || Date.parse(leaseExpiresAt) <= Date.now();
  const nextPollAt = typeof row.nextPollAt === "string" ? row.nextPollAt : null;
  const pollDue = !nextPollAt || Date.parse(nextPollAt) <= Date.now();
  const dismissedAt = typeof row.dismissedAt === "string" ? row.dismissedAt : null;
  const providerTaskId = typeof row.providerTaskId === "string" && row.providerTaskId ? row.providerTaskId : null;
  const submissionStateUnknown = row.mediaType === "video"
    && status === "running"
    && attemptCount > 0
    && !providerTaskId
    && leaseExpired;
  return {
    id: String(row.id),
    projectId: String(row.projectId),
    clientRequestId: String(row.clientRequestId),
    modelId: typeof row.modelId === "string" ? row.modelId : null,
    modelName: String(row.modelName),
    mediaType: row.mediaType === "video" ? "video" : "image",
    name: String(row.name),
    category: String(row.category) as AssetGenerationJob["category"],
    prompt: String(row.prompt),
    size: typeof row.size === "string" && row.size ? row.size : null,
    aspectRatio: typeof row.aspectRatio === "string" && row.aspectRatio ? row.aspectRatio : null,
    options: parseJson(row.optionsJson, {}),
    providerTaskId,
    nextPollAt,
    relations: parseJson<AssetRelationInput[]>(row.relationsJson, []),
    status,
    phase: String(row.phase) as AssetGenerationJob["phase"],
    progress: Math.max(0, Math.min(100, Number(row.progress) || 0)),
    attemptCount,
    errorCode: typeof row.errorCode === "string" ? row.errorCode : null,
    errorMessage: typeof row.errorMessage === "string" ? row.errorMessage : null,
    retryable: Boolean(row.retryable) && attemptCount < 3,
    assetId: typeof row.assetId === "string" ? row.assetId : null,
    canRun: !dismissedAt && !submissionStateUnknown && attemptCount < 3 && pollDue
      && (status === "queued" || (status === "running" && leaseExpired)),
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
    startedAt: typeof row.startedAt === "string" ? row.startedAt : null,
    completedAt: typeof row.completedAt === "string" ? row.completedAt : null,
    dismissedAt,
  };
}

export async function listAssetGenerations(
  db: D1Database,
  projectId: string,
  ownerId: string,
): Promise<AssetGenerationJob[]> {
  const now = nowIso();
  // If a worker vanished after beginning a paid video submission but before saving
  // the provider task id, automatically resubmitting could charge the user twice.
  await db.prepare(`UPDATE asset_generation_jobs SET
      status = 'failed', phase = 'failed', retryable = 0,
      error_code = 'VIDEO_SUBMISSION_STATE_UNKNOWN',
      error_message = '视频任务提交状态无法确认。为避免重复计费，系统不会自动重提；请先在服务商控制台核对后再新建任务。',
      lease_token = NULL, lease_expires_at = NULL, next_poll_at = NULL,
      updated_at = ?, completed_at = ?
    WHERE project_id = ? AND owner_id = ? AND dismissed_at IS NULL
      AND media_type = 'video' AND status = 'running' AND provider_task_id IS NULL
      AND attempt_count > 0 AND (lease_expires_at IS NULL OR lease_expires_at <= ?)`)
    .bind(now, now, projectId, ownerId, now)
    .run();
  await db.prepare(`UPDATE asset_generation_jobs SET
      status = 'failed', phase = 'failed', retryable = 0,
      error_code = 'GENERATION_ATTEMPT_LIMIT',
      error_message = '任务在执行中断后已达到 3 次自动恢复上限，请检查模型配置后新建任务。',
      lease_token = NULL, lease_expires_at = NULL, updated_at = ?, completed_at = ?
    WHERE project_id = ? AND owner_id = ? AND dismissed_at IS NULL
      AND status = 'running' AND attempt_count >= 3
      AND (lease_expires_at IS NULL OR lease_expires_at <= ?)`)
    .bind(now, now, projectId, ownerId, now)
    .run();
  const rows = await allRows<Record<string, unknown>>(
    db.prepare(`${generationSelect} WHERE project_id = ? AND owner_id = ? AND dismissed_at IS NULL
      ORDER BY CASE WHEN status IN ('queued', 'running') THEN 0 ELSE 1 END, created_at DESC LIMIT 200`)
      .bind(projectId, ownerId),
  );
  return rows.map(serializeAssetGeneration);
}

export async function getGenerationStorageKey(
  db: D1Database,
  generationId: string,
  leaseToken?: string,
): Promise<string | null> {
  const row = await db.prepare(`SELECT storage_key AS storageKey FROM asset_generation_jobs
    WHERE id = ?${leaseToken ? " AND status = 'running' AND lease_token = ?" : ""}`)
    .bind(...(leaseToken ? [generationId, leaseToken] : [generationId]))
    .first<{ storageKey: string | null }>();
  return typeof row?.storageKey === "string" && row.storageKey ? row.storageKey : null;
}

export async function setGenerationStorageKey(
  db: D1Database,
  generationId: string,
  leaseToken: string,
  storageKey: string | null,
): Promise<void> {
  const result = await db.prepare(`UPDATE asset_generation_jobs SET storage_key = ?, updated_at = ?
    WHERE id = ? AND status = 'running' AND lease_token = ?`)
    .bind(storageKey, nowIso(), generationId, leaseToken)
    .run();
  if (!result.meta.changes) throw new ApiError(409, "GENERATION_LEASE_LOST", "生成任务执行权已过期。");
}

export async function persistGenerationProviderTask(
  db: D1Database,
  generationId: string,
  leaseToken: string,
  providerTaskId: string,
  pollAfterMs = 5_000,
): Promise<void> {
  const now = nowIso();
  const result = await db.prepare(`UPDATE asset_generation_jobs SET
      provider_task_id = ?, status = 'running', phase = 'model', progress = 25,
      next_poll_at = ?, lease_token = NULL, lease_expires_at = NULL, updated_at = ?
    WHERE id = ? AND status = 'running' AND lease_token = ? AND provider_task_id IS NULL`)
    .bind(providerTaskId, new Date(Date.now() + pollAfterMs).toISOString(), now, generationId, leaseToken)
    .run();
  if (!result.meta.changes) throw new ApiError(409, "GENERATION_LEASE_LOST", "生成任务执行权已过期，供应商任务编号未能保存。 ");
}

export async function releaseGenerationForPolling(
  db: D1Database,
  generationId: string,
  leaseToken: string,
  progress: number,
  pollAfterMs = 5_000,
): Promise<void> {
  const result = await db.prepare(`UPDATE asset_generation_jobs SET
      status = 'running', phase = 'model', progress = ?, next_poll_at = ?,
      lease_token = NULL, lease_expires_at = NULL, updated_at = ?
    WHERE id = ? AND status = 'running' AND lease_token = ? AND provider_task_id IS NOT NULL`)
    .bind(Math.max(25, Math.min(75, progress)), new Date(Date.now() + pollAfterMs).toISOString(), nowIso(), generationId, leaseToken)
    .run();
  if (!result.meta.changes) throw new ApiError(409, "GENERATION_LEASE_LOST", "生成任务执行权已过期。 ");
}

export async function getAssetGeneration(
  db: D1Database,
  projectId: string,
  ownerId: string,
  generationId: string,
): Promise<AssetGenerationJob> {
  const row = await db.prepare(`${generationSelect} WHERE id = ? AND project_id = ? AND owner_id = ? AND dismissed_at IS NULL`)
    .bind(generationId, projectId, ownerId)
    .first<Record<string, unknown>>();
  if (!row) throw new ApiError(404, "ASSET_GENERATION_NOT_FOUND", "媒体生成任务不存在或你无权访问。");
  return serializeAssetGeneration(row);
}

export async function findAssetGenerationByClientRequest(
  db: D1Database,
  projectId: string,
  ownerId: string,
  clientRequestId: string,
): Promise<AssetGenerationJob | null> {
  const row = await db.prepare(`${generationSelect} WHERE project_id = ? AND owner_id = ? AND client_request_id = ?`)
    .bind(projectId, ownerId, clientRequestId)
    .first<Record<string, unknown>>();
  return row ? serializeAssetGeneration(row) : null;
}

export async function updateGenerationProgress(
  db: D1Database,
  generationId: string,
  leaseToken: string,
  phase: "model" | "storage" | "finalize",
  progress: number,
): Promise<void> {
  const result = await db.prepare(`UPDATE asset_generation_jobs
    SET phase = ?, progress = ?, lease_expires_at = ?, updated_at = ?
    WHERE id = ? AND status = 'running' AND lease_token = ?`)
    .bind(phase, progress, new Date(Date.now() + 300_000).toISOString(), nowIso(), generationId, leaseToken)
    .run();
  if (!result.meta.changes) throw new ApiError(409, "GENERATION_LEASE_LOST", "生成任务执行权已过期，当前结果不会写入资产库。");
}

export async function renewGenerationLease(
  db: D1Database,
  generationId: string,
  leaseToken: string,
): Promise<void> {
  const result = await db.prepare(`UPDATE asset_generation_jobs
    SET lease_expires_at = ?, updated_at = ?
    WHERE id = ? AND status = 'running' AND lease_token = ?`)
    .bind(new Date(Date.now() + 300_000).toISOString(), nowIso(), generationId, leaseToken)
    .run();
  if (!result.meta.changes) throw new ApiError(409, "GENERATION_LEASE_LOST", "生成任务执行权已过期。");
}

export async function persistGenerationFailure(
  db: D1Database,
  generationId: string,
  leaseToken: string,
  failure: GenerationFailure,
): Promise<void> {
  const now = nowIso();
  const result = await db.prepare(`UPDATE asset_generation_jobs
    SET status = 'failed', phase = 'failed', error_code = ?, error_message = ?,
      retryable = CASE WHEN attempt_count >= 3 THEN 0 ELSE ? END,
      lease_token = NULL, lease_expires_at = NULL, next_poll_at = NULL, updated_at = ?, completed_at = ?
    WHERE id = ? AND status = 'running' AND lease_token = ?`)
    .bind(failure.code, failure.message.slice(0, 800), failure.retryable ? 1 : 0, now, now, generationId, leaseToken)
    .run();
  if (!result.meta.changes) {
    console.error("Asset generation failure could not be persisted because the lease changed", {
      generationId,
      code: failure.code,
    });
  }
}

export function generationFailure(
  error: unknown,
  providerInvoked = false,
  mediaType: "image" | "video" = "image",
): GenerationFailure {
  if (error instanceof ApiError) {
    const nonRetryable = new Set([
      "MODEL_DISABLED",
      "MODEL_NOT_FOUND",
      "MODEL_API_KEY_MISSING",
      "MODEL_IMAGE_UNSUPPORTED",
      "MODEL_VIDEO_UNSUPPORTED",
      "MODEL_API_KEY_DECRYPT_FAILED",
      "INVALID_IMAGE_PROMPT",
      "INVALID_IMAGE_SIZE",
      "IMAGE_AUTH_FAILED",
      "IMAGE_INVALID_REQUEST",
      "IMAGE_CONTENT_POLICY",
      "IMAGE_MODEL_TIMEOUT",
      "IMAGE_MODEL_NETWORK_ERROR",
      "IMAGE_MODEL_REDIRECT_REJECTED",
      "INVALID_IMAGE_MODEL_RESPONSE",
      "IMAGE_PROVIDER_UNAVAILABLE",
      "IMAGE_GENERATION_FAILED",
      "IMAGE_RESULT_MISSING",
      "IMAGE_DOWNLOAD_FAILED",
      "IMAGE_DOWNLOAD_REDIRECT_REJECTED",
      "INVALID_IMAGE_CONTENT_TYPE",
      "IMAGE_RESPONSE_TOO_LARGE",
      "IMAGE_RESPONSE_STREAM_FAILED",
      "INVALID_IMAGE_BASE64",
      "INVALID_IMAGE_BYTES",
      "IMAGE_STORAGE_FAILED",
      "IMAGE_ASSET_FINALIZE_FAILED",
      "VIDEO_REQUEST_PROFILE_MISSING",
      "VIDEO_MODEL_ID_MISSING",
      "INVALID_VIDEO_TASK_ID",
      "INVALID_VIDEO_PROMPT",
      "INVALID_VIDEO_RESOLUTION",
      "INVALID_VIDEO_ASPECT_RATIO",
      "INVALID_VIDEO_DURATION",
      "INVALID_VIDEO_REFERENCE_ROLE",
      "INVALID_VIDEO_REFERENCE_URL",
      "INVALID_VIDEO_REFERENCE_ASSETS",
      "INVALID_VIDEO_REFERENCE_MODE",
      "DUPLICATE_VIDEO_REFERENCE_ASSET",
      "VIDEO_REFERENCE_TOO_LARGE",
      "VIDEO_REFERENCE_ASSET_TOO_LARGE",
      "VIDEO_REFERENCE_ASSETS_TOO_LARGE",
      "VIDEO_REFERENCE_ASSET_NOT_FOUND",
      "VIDEO_REFERENCE_ASSET_NOT_IMAGE",
      "VIDEO_REFERENCE_ASSET_NOT_READY",
      "VIDEO_REFERENCE_ASSET_CONTENT_MISSING",
      "VIDEO_REFERENCE_ASSET_TYPE_UNSUPPORTED",
      "TOO_MANY_VIDEO_REFERENCES",
      "DUPLICATE_VIDEO_REFERENCE_ROLE",
      "VIDEO_AUDIO_UNSUPPORTED",
      "INVALID_VIDEO_SEED",
      "INVALID_VIDEO_EXPIRY",
      "INVALID_VIDEO_SAFETY_IDENTIFIER",
      "INVALID_VIDEO_CALLBACK_URL",
      "VIDEO_AUTH_FAILED",
      "VIDEO_INVALID_REQUEST",
      "VIDEO_CONTENT_POLICY",
      "VIDEO_TASK_NOT_FOUND",
      "VIDEO_TASK_FAILED",
      "VIDEO_TASK_CANCELLED",
      "VIDEO_TASK_EXPIRED",
      "VIDEO_RESULT_MISSING",
      "VIDEO_MODEL_REDIRECT_REJECTED",
      "INVALID_VIDEO_CONTENT_TYPE",
      "INVALID_VIDEO_BYTES",
      "VIDEO_RESPONSE_TOO_LARGE",
      "VIDEO_SUBMISSION_STATE_UNKNOWN",
      "INVALID_ASSET_RELATION",
      "GENERATION_LEASE_LOST",
    ]);
    const ambiguousPaidSubmission = providerInvoked && [
      "VIDEO_MODEL_TIMEOUT",
      "VIDEO_MODEL_NETWORK_ERROR",
      "VIDEO_PROVIDER_UNAVAILABLE",
      "INVALID_VIDEO_TASK_RESPONSE",
      "VIDEO_RESPONSE_STREAM_FAILED",
      "VIDEO_GENERATION_FAILED",
    ].includes(error.code);
    return { code: error.code, message: error.message, retryable: !nonRetryable.has(error.code) && !ambiguousPaidSubmission };
  }
  console.error("Unhandled asset generation error", error);
  return {
    code: mediaType === "video" ? "VIDEO_PROCESSING_FAILED" : "IMAGE_PROCESSING_FAILED",
    message: `${mediaType === "video" ? "视频" : "图片"}生成处理发生内部错误，请稍后重试。`,
    retryable: !providerInvoked,
  };
}
