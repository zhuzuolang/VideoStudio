import { callConfiguredModel } from "@/lib/server/agent";
import { ApiError, errorResponse, ok } from "@/lib/server/api";
import { apiContext, type RouteContext } from "@/lib/server/context";
import { generateImageWithModel, modelSupportsImageGeneration } from "@/lib/server/image-generation";
import { requireOwnedModel } from "@/lib/server/store";

export const dynamic = "force-dynamic";

type ModelTestType = "text" | "image";

function compactSummary(value: string, maxLength = 240): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}…` : normalized;
}

export async function POST(request: Request, context: RouteContext<{ modelId: string }>): Promise<Response> {
  const startedAt = Date.now();
  let type: ModelTestType = "text";
  try {
    const { modelId } = await context.params;
    const { db, identity } = await apiContext(request);
    const model = await requireOwnedModel(db, modelId, identity.userId);
    type = modelSupportsImageGeneration(model) ? "image" : "text";
    if (!model.enabled) throw new ApiError(400, "MODEL_DISABLED", "该模型已停用，请启用后再测试。 ");
    if (!model.api_key_ciphertext || !model.api_key_iv) {
      throw new ApiError(400, "MODEL_API_KEY_MISSING", "该模型尚未配置 API Key。 ");
    }

    if (type === "image") {
      const result = await generateImageWithModel(model, {
        prompt: "极简白色背景上的一个蓝色圆点，用于验证图像模型连接",
      });
      const revisedPrompt = result.revisedPrompt ? compactSummary(result.revisedPrompt, 120) : null;
      return ok({
        type,
        status: "success",
        latencyMs: Date.now() - startedAt,
        summary: revisedPrompt
          ? `图像生成成功：${revisedPrompt}`
          : `图像生成成功，已验证 ${result.mimeType} 响应（${Math.max(1, Math.round(result.bytes.byteLength / 1024))} KB），未写入资产库。`,
      });
    }

    const result = await callConfiguredModel(
      model,
      "请只回复“模型连接正常”，不要补充其他内容。",
      "这是连通性测试，请简短作答，不要输出敏感配置。",
      [],
    );
    return ok({
      type,
      status: "success",
      latencyMs: Date.now() - startedAt,
      summary: compactSummary(result.response),
    });
  } catch (error) {
    if (error instanceof ApiError) {
      const providerStatus = error.details && typeof error.details === "object" && !Array.isArray(error.details)
        ? (error.details as Record<string, unknown>).providerStatus
        : undefined;
      return errorResponse(new ApiError(error.status, error.code, error.message, {
        type,
        status: "failed",
        latencyMs: Date.now() - startedAt,
        ...(typeof providerStatus === "number" ? { providerStatus } : {}),
      }));
    }
    return errorResponse(error);
  }
}
