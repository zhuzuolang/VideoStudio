import { created, errorResponse, id, jsonText, nowIso, ok, optionalBoolean, optionalString, readJsonObject, requiredString, ApiError } from "@/lib/server/api";
import { apiContext } from "@/lib/server/context";
import { encryptApiKey } from "@/lib/server/crypto";
import { safeRemoteUrl } from "@/lib/server/assets";
import { validateModelEndpoint } from "@/lib/server/outbound";
import { listModels } from "@/lib/server/store";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    const { db, identity } = await apiContext(request);
    return ok({ models: await listModels(db, identity.userId) });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const { db, identity } = await apiContext(request);
    const body = await readJsonObject(request);
    const name = requiredString(body, "name", { max: 100 });
    const modelId = requiredString(body, "modelId", { max: 200 });
    const endpoint = await validateModelEndpoint(requiredString(body, "endpoint", { max: 2_000 }));
    const provider = optionalString(body, "provider", { max: 100 }) || "OpenAI-compatible";
    const level = optionalString(body, "level", { max: 50 }) || "standard";
    const iconUrl = safeRemoteUrl(optionalString(body, "iconUrl", { max: 2_000, nullable: true }), "iconUrl");
    const enabled = optionalBoolean(body, "enabled") ?? true;
    const apiKey = optionalString(body, "apiKey", { max: 10_000 });
    const parameters = body.parameters ?? {};
    if (!parameters || typeof parameters !== "object" || Array.isArray(parameters)) {
      throw new ApiError(400, "VALIDATION_ERROR", "parameters 必须是 JSON 对象。", { field: "parameters" });
    }
    const encrypted = apiKey ? await encryptApiKey(apiKey) : null;
    const modelRecordId = id("mdl");
    const now = nowIso();
    await db.prepare(`INSERT INTO ai_models (
      id, owner_id, name, provider, model_id, level, endpoint, icon_url,
      api_key_ciphertext, api_key_iv, api_key_hint, enabled, parameters_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
      modelRecordId, identity.userId, name, provider, modelId, level, endpoint, iconUrl ?? null,
      encrypted?.ciphertext ?? null, encrypted?.iv ?? null, encrypted?.hint ?? null,
      enabled ? 1 : 0, jsonText(parameters, {}), now, now,
    ).run();
    const model = (await listModels(db, identity.userId)).find((item) => item.id === modelRecordId);
    return created({ model });
  } catch (error) {
    return errorResponse(error);
  }
}
