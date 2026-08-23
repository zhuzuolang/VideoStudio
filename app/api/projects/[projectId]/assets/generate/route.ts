import { ApiError, errorResponse, id, jsonText, nowIso, ok, optionalString, readJsonObject, requiredString } from "@/lib/server/api";
import { findAssetGenerationByClientRequest, listAssetGenerations, serializeAssetGeneration } from "@/lib/server/asset-generation-jobs";
import { parseAssetRelations, validateAssetCategory } from "@/lib/server/assets";
import { apiContext, type RouteContext } from "@/lib/server/context";
import { modelSupportsImageGeneration } from "@/lib/server/image-generation";
import { requireOwnedModel, requireOwnedProject, validateAssetRelationTargets } from "@/lib/server/store";

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: RouteContext<{ projectId: string }>): Promise<Response> {
  try {
    const { projectId } = await context.params;
    const { db, identity } = await apiContext(request);
    await requireOwnedProject(db, projectId, identity.userId);
    return ok({ generations: await listAssetGenerations(db, projectId, identity.userId) });
  } catch (error) {
    return errorResponse(error instanceof ApiError ? error : new ApiError(503, "GENERATION_STATUS_UNAVAILABLE", "暂时无法读取图片生成状态，请稍后重试。"));
  }
}

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
    const size = optionalString(body, "size", { max: 40 }) || null;
    const aspectRatio = optionalString(body, "aspectRatio", { max: 20 }) || null;
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
    if (!modelSupportsImageGeneration(model)) throw new ApiError(400, "MODEL_IMAGE_UNSUPPORTED", "所选模型未声明图像生成能力。");
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
      name,
      category,
      prompt,
      size,
      aspectRatio,
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
        id, project_id, owner_id, client_request_id, model_id, model_name, name, category,
        prompt, size, aspect_ratio, relations_json, status, phase, progress, attempt_count,
        lease_token, lease_expires_at, error_code, error_message, retryable, asset_id, storage_key, dismissed_at,
        created_at, updated_at, started_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 'queued', 0, 0, NULL, NULL, NULL, NULL, 1, NULL, NULL, NULL, ?, ?, NULL, NULL)`)
        .bind(generationId, projectId, identity.userId, requestKey, modelId, String(model.name), name, category,
          prompt, size, aspectRatio, jsonText(relations, []), now, now)
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
      throw new ApiError(503, "GENERATION_JOB_CREATE_FAILED", "无法创建图片生成任务，请稍后重试。");
    }
    return ok({ generation: serializeAssetGeneration(row) }, { status: 202 });
  } catch (error) {
    return errorResponse(error instanceof TypeError
      ? new ApiError(400, "INVALID_GENERATION_REQUEST", "生成参数无效。")
      : error);
  }
}
