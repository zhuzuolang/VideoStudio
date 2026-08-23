import { ApiError, created, errorResponse, id, jsonText, nowIso, optionalInteger, optionalString, readJsonObject, requiredString } from "@/lib/server/api";
import { apiContext, type RouteContext } from "@/lib/server/context";
import { sceneSelect, serializeSceneRecord } from "@/lib/server/records";
import { requireOwnedProject, touchProject } from "@/lib/server/store";

export async function POST(request: Request, context: RouteContext<{ projectId: string; scriptId: string }>): Promise<Response> {
  try {
    const { projectId, scriptId } = await context.params; const { db, identity } = await apiContext(request);
    await requireOwnedProject(db, projectId, identity.userId);
    const script = await db.prepare(`SELECT id FROM scripts WHERE id = ? AND project_id = ?`).bind(scriptId, projectId).first();
    if (!script) throw new ApiError(404, "SCRIPT_NOT_FOUND", "剧本不存在。 ");
    const body = await readJsonObject(request);
    let sceneNo = optionalInteger(body, "sceneNo", 1, 100_000);
    if (sceneNo === undefined) {
      const max = await db.prepare(`SELECT COALESCE(MAX(scene_no), 0) AS value FROM scenes WHERE script_id = ?`).bind(scriptId).first<{ value: number }>();
      sceneNo = Number(max?.value ?? 0) + 1;
    }
    const duplicate = await db.prepare(`SELECT id FROM scenes WHERE script_id = ? AND scene_no = ?`).bind(scriptId, sceneNo).first();
    if (duplicate) throw new ApiError(409, "SCENE_NUMBER_EXISTS", "该场次编号已存在。 ");
    const heading = requiredString(body, "heading", { max: 300 });
    const orderIndex = optionalInteger(body, "orderIndex", 0, 100_000) ?? sceneNo - 1;
    const strings = Object.fromEntries(["location", "timeOfDay", "summary", "action"].map((field) => [field, optionalString(body, field, { max: 100_000 }) || ""]));
    const status = optionalString(body, "status", { max: 40 }) || "draft";
    const duration = optionalInteger(body, "durationSeconds", 1, 7_200) ?? 30;
    const structured = structuredFields(body);
    const sceneId = id("scn"); const now = nowIso();
    await db.prepare(`INSERT INTO scenes (id, project_id, script_id, scene_no, order_index, heading, location, time_of_day, summary, action, dialogue_json, characters_json, wardrobe_json, props_json, duration_seconds, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(sceneId, projectId, scriptId, sceneNo, orderIndex, heading, strings.location, strings.timeOfDay, strings.summary, strings.action, jsonText(structured.dialogue, []), jsonText(structured.characters, []), jsonText(structured.wardrobe, []), jsonText(structured.props, []), duration, status, now, now).run();
    await touchProject(db, projectId);
    const row = await db.prepare(`${sceneSelect} WHERE id = ?`).bind(sceneId).first<Record<string, unknown>>();
    return created({ scene: serializeSceneRecord(row!) });
  } catch (error) { return errorResponse(error); }
}

function structuredFields(body: Record<string, unknown>): Record<"dialogue" | "characters" | "wardrobe" | "props", unknown[]> {
  const result = {} as Record<"dialogue" | "characters" | "wardrobe" | "props", unknown[]>;
  for (const field of ["dialogue", "characters", "wardrobe", "props"] as const) {
    const value = body[field] ?? [];
    if (!Array.isArray(value)) throw new ApiError(400, "VALIDATION_ERROR", `${field} 必须是数组。`, { field });
    result[field] = value;
  }
  return result;
}
