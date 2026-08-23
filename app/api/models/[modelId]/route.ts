import { ApiError, errorResponse, jsonText, noContent, nowIso, optionalBoolean, optionalString, readJsonObject } from "@/lib/server/api";
import { apiContext, type RouteContext } from "@/lib/server/context";
import { encryptApiKey } from "@/lib/server/crypto";
import { safeRemoteUrl } from "@/lib/server/assets";
import { validateModelEndpoint } from "@/lib/server/outbound";
import { listModels, requireOwnedModel } from "@/lib/server/store";
import { ok } from "@/lib/server/api";

export const dynamic = "force-dynamic";

export async function PATCH(request: Request, context: RouteContext<{ modelId: string }>): Promise<Response> {
  try {
    const { modelId } = await context.params;
    const { db, identity } = await apiContext(request);
    await requireOwnedModel(db, modelId, identity.userId);
    const body = await readJsonObject(request);
    const updates: string[] = [];
    const values: unknown[] = [];
    for (const [field, column, max] of [
      ["name", "name", 100], ["provider", "provider", 100], ["modelId", "model_id", 200],
      ["level", "level", 50],
    ] as const) {
      const value = optionalString(body, field, { max });
      if (value !== undefined) { updates.push(`${column} = ?`); values.push(value); }
    }
    if ("iconUrl" in body) {
      const value = safeRemoteUrl(optionalString(body, "iconUrl", { max: 2_000, nullable: true }), "iconUrl");
      updates.push("icon_url = ?"); values.push(value ?? null);
    }
    if ("endpoint" in body) {
      const value = optionalString(body, "endpoint", { max: 2_000 });
      if (!value) throw new ApiError(400, "VALIDATION_ERROR", "endpoint 不能为空。 ");
      updates.push("endpoint = ?"); values.push(await validateModelEndpoint(value));
    }
    const enabled = optionalBoolean(body, "enabled");
    if (enabled !== undefined) { updates.push("enabled = ?"); values.push(enabled ? 1 : 0); }
    if ("parameters" in body) {
      if (!body.parameters || typeof body.parameters !== "object" || Array.isArray(body.parameters)) {
        throw new ApiError(400, "VALIDATION_ERROR", "parameters 必须是 JSON 对象。 ");
      }
      updates.push("parameters_json = ?"); values.push(jsonText(body.parameters, {}));
    }
    const clearApiKey = optionalBoolean(body, "clearApiKey");
    const apiKey = optionalString(body, "apiKey", { max: 10_000 });
    if (clearApiKey && apiKey) throw new ApiError(400, "VALIDATION_ERROR", "apiKey 与 clearApiKey 不能同时提交。 ");
    if (clearApiKey) {
      updates.push("api_key_ciphertext = NULL", "api_key_iv = NULL", "api_key_hint = NULL");
    } else if (apiKey) {
      const encrypted = await encryptApiKey(apiKey);
      updates.push("api_key_ciphertext = ?", "api_key_iv = ?", "api_key_hint = ?");
      values.push(encrypted.ciphertext, encrypted.iv, encrypted.hint);
    }
    if (updates.length === 0) throw new ApiError(400, "NO_CHANGES", "没有可保存的模型配置。 ");
    updates.push("updated_at = ?"); values.push(nowIso(), modelId, identity.userId);
    await db.prepare(`UPDATE ai_models SET ${updates.join(", ")} WHERE id = ? AND owner_id = ?`).bind(...values).run();
    const model = (await listModels(db, identity.userId)).find((item) => item.id === modelId);
    return ok({ model });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: Request, context: RouteContext<{ modelId: string }>): Promise<Response> {
  try {
    const { modelId } = await context.params;
    const { db, identity } = await apiContext(request);
    await requireOwnedModel(db, modelId, identity.userId);
    await db.prepare(`DELETE FROM ai_models WHERE id = ? AND owner_id = ?`).bind(modelId, identity.userId).run();
    return noContent();
  } catch (error) {
    return errorResponse(error);
  }
}
