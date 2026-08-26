import { ApiError, errorResponse, id, jsonText, nowIso, ok, optionalString, readJsonObject, requiredString } from "@/lib/server/api";
import { findAssetGenerationByClientRequest, listAssetGenerations, serializeAssetGeneration } from "@/lib/server/asset-generation-jobs";
import { parseAssetRelations, safeRemoteUrl, validateAssetCategory } from "@/lib/server/assets";
import { apiContext, type RouteContext } from "@/lib/server/context";
import { modelSupportsImageGeneration } from "@/lib/server/image-generation";
import { modelSupportsVideoGeneration } from "@/lib/server/video-generation";
import { requireOwnedModel, requireOwnedProject, validateAssetRelationTargets } from "@/lib/server/store";
import type { VideoGenerationOptions } from "@/lib/platform-types";

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: RouteContext<{ projectId: string }>): Promise<Response> {
  try {
    const { projectId } = await context.params;
    const { db, identity } = await apiContext(request);
    await requireOwnedProject(db, projectId, identity.userId);
    return ok({ generations: await listAssetGenerations(db, projectId, identity.userId) });
  } catch (error) {
    return errorResponse(error instanceof ApiError ? error : new ApiError(503, "GENERATION_STATUS_UNAVAILABLE", "暂时无法读取媒体生成状态，请稍后重试。"));
  }
}

export async function POST(request: Request, context: RouteContext<{ projectId: string }>): Promise<Response> {
  try {
    const { projectId } = await context.params;
    const { db, identity } = await apiContext(request);
    await requireOwnedProject(db, projectId, identity.userId);
    const body = await readJsonObject(request);
    const modelId = requiredString(body, "modelId", { max: 240 });
    const mediaType = body.mediaType === "video" ? "video" : body.mediaType === undefined || body.mediaType === "image"
      ? "image"
      : (() => { throw new ApiError(400, "INVALID_GENERATION_MEDIA_TYPE", "AI 生成目前只支持图片或视频资产。"); })();
    const name = requiredString(body, "name", { max: 240 });
    const category = validateAssetCategory(body.category);
    const prompt = requiredString(body, "prompt", { max: 8_000 });
    const size = optionalString(body, "size", { max: 40 }) || null;
    const aspectRatio = optionalString(body, "aspectRatio", { max: 20 }) || null;
    const rawOptions = body.options === undefined ? {} : body.options;
    if (!rawOptions || typeof rawOptions !== "object" || Array.isArray(rawOptions)) {
      throw new ApiError(400, "INVALID_GENERATION_OPTIONS", "生成选项必须是 JSON 对象。");
    }
    const optionInput = rawOptions as Record<string, unknown>;
    const rawGenerateAudio = optionInput.generateAudio;
    if (rawGenerateAudio !== undefined && typeof rawGenerateAudio !== "boolean") {
      throw new ApiError(400, "INVALID_VIDEO_AUDIO_OPTION", "有声视频选项必须是布尔值。");
    }
    const options: VideoGenerationOptions = mediaType === "video" ? {
      resolution: optionalString(optionInput, "resolution", { max: 20 }) || undefined,
      duration: optionInput.duration === undefined ? undefined : Number(optionInput.duration),
      generateAudio: rawGenerateAudio,
      referenceImageUrl: safeRemoteUrl(optionalString(optionInput, "referenceImageUrl", { max: 2_000, nullable: true }), "referenceImageUrl") || undefined,
      referenceImageRole: optionInput.referenceImageRole === undefined ? undefined : String(optionInput.referenceImageRole) as VideoGenerationOptions["referenceImageRole"],
    } : {};
    if (options.duration !== undefined && (!Number.isInteger(options.duration)
      || (options.duration !== -1 && (options.duration < 1 || options.duration > 30)))) {
      throw new ApiError(400, "INVALID_VIDEO_DURATION", "视频时长必须是 -1（智能）或 1 到 30 秒之间的整数。");
    }
    if (options.referenceImageRole !== undefined && !["first_frame", "last_frame", "reference_image"].includes(String(options.referenceImageRole))) {
      throw new ApiError(400, "INVALID_VIDEO_REFERENCE_ROLE", "参考图角色无效。");
    }
    const relations = parseAssetRelations(body) ?? [];
    const requestKey = request.headers.get("Idempotency-Key")?.trim()
      || optionalString(body, "clientRequestId", { max: 160 })
      || id("req");
    if (requestKey.length > 160) throw new ApiError(400, "INVALID_IDEMPOTENCY_KEY", "生成请求标识过长。");

    const existing = await findAssetGenerationByClientRequest(db, projectId, identity.userId, requestKey);
    if (existing) {
      if (existing.dismissedAt) {
        throw new ApiError(409, "GENERATION_REQUEST_ALREADY_USED", "该生成请求标识已经使用并被移除，请重新发起一次新的生成任务。");
      }
      return ok({ generation: existing }, { status: 202 });
    }

    const model = await requireOwnedModel(db, modelId, identity.userId);
    if (!model.enabled) throw new ApiError(400, "MODEL_DISABLED", "所选模型已停用。");
    if (!model.api_key_ciphertext || !model.api_key_iv) throw new ApiError(400, "MODEL_API_KEY_MISSING", "所选模型尚未配置 API Key。");
    if (mediaType === "video") {
      if (!modelSupportsVideoGeneration(model)) throw new ApiError(400, "MODEL_VIDEO_UNSUPPORTED", "所选模型未声明视频生成能力。");
    } else if (!modelSupportsImageGeneration(model)) {
      throw new ApiError(400, "MODEL_IMAGE_UNSUPPORTED", "所选模型未声明图像生成能力。");
    }
    await validateAssetRelationTargets(db, projectId, relations);

    const generationId = id("gen");
    const now = nowIso();
    const row = {
      id: generationId,
      projectId,
      ownerId: identity.userId,
      clientRequestId: requestKey,
      modelId,
      modelName: String(model.name),
      mediaType,
      name,
      category,
      prompt,
      size,
      aspectRatio,
      optionsJson: jsonText(options, {}),
      providerTaskId: null,
      nextPollAt: null,
      relationsJson: jsonText(relations, []),
      status: "queued",
      phase: "queued",
      progress: 0,
      attemptCount: 0,
      leaseToken: null,
      leaseExpiresAt: null,
      errorCode: null,
      errorMessage: null,
      retryable: 1,
      assetId: null,
      storageKey: null,
      dismissedAt: null,
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      completedAt: null,
    };
    try {
      await db.prepare(`INSERT INTO asset_generation_jobs (
        id, project_id, owner_id, client_request_id, model_id, model_name, media_type, name, category,
        prompt, size, aspect_ratio, options_json, provider_task_id, next_poll_at, relations_json, status, phase, progress, attempt_count,
        lease_token, lease_expires_at, error_code, error_message, retryable, asset_id, storage_key, dismissed_at,
        created_at, updated_at, started_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, 'queued', 'queued', 0, 0, NULL, NULL, NULL, NULL, 1, NULL, NULL, NULL, ?, ?, NULL, NULL)`)
        .bind(generationId, projectId, identity.userId, requestKey, modelId, String(model.name), mediaType, name, category,
          prompt, size, aspectRatio, jsonText(options, {}), jsonText(relations, []), now, now)
        .run();
    } catch (error) {
      if (error instanceof Error && /(?:UNIQUE|PRIMARY KEY) constraint failed/i.test(error.message)) {
        const raced = await findAssetGenerationByClientRequest(db, projectId, identity.userId, requestKey);
        if (raced?.dismissedAt) {
          throw new ApiError(409, "GENERATION_REQUEST_ALREADY_USED", "该生成请求标识已经使用并被移除，请重新发起一次新的生成任务。");
        }
        if (raced) return ok({ generation: raced }, { status: 202 });
      }
      console.error("Asset generation job creation failed", { projectId, generationId, error });
      throw new ApiError(503, "GENERATION_JOB_CREATE_FAILED", "无法创建媒体生成任务，请稍后重试。");
    }
    return ok({ generation: serializeAssetGeneration(row) }, { status: 202 });
  } catch (error) {
    return errorResponse(error instanceof TypeError
      ? new ApiError(400, "INVALID_GENERATION_REQUEST", "生成参数无效。")
      : error);
  }
}
