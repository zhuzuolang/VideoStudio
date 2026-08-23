import { ApiError, errorResponse, jsonText, noContent, nowIso, ok, optionalInteger, optionalString, readJsonObject } from "@/lib/server/api";
import { apiContext, type RouteContext } from "@/lib/server/context";
import { sceneSelect, serializeSceneRecord } from "@/lib/server/records";
import { requireOwnedProject, touchProject } from "@/lib/server/store";

export async function PATCH(request: Request, context: RouteContext<{ projectId: string; scriptId: string; sceneId: string }>): Promise<Response> {
  try {
    const { projectId, scriptId, sceneId } = await context.params; const { db, identity } = await apiContext(request);
    await requireOwnedProject(db, projectId, identity.userId);
    const exists = await db.prepare(`SELECT id FROM scenes WHERE id = ? AND script_id = ? AND project_id = ?`).bind(sceneId, scriptId, projectId).first();
    if (!exists) throw new ApiError(404, "SCENE_NOT_FOUND", "场次不存在。 ");
    const body = await readJsonObject(request); const updates: string[] = []; const values: unknown[] = [];
    for (const [field, column, max] of [["heading", "heading", 300], ["location", "location", 500], ["timeOfDay", "time_of_day", 100], ["summary", "summary", 100_000], ["action", "action", 200_000], ["status", "status", 40]] as const) {
      const value = optionalString(body, field, { max }); if (value !== undefined) { updates.push(`${column} = ?`); values.push(value); }
    }
    for (const [field, column, min, max] of [["sceneNo", "scene_no", 1, 100_000], ["orderIndex", "order_index", 0, 100_000], ["durationSeconds", "duration_seconds", 1, 7_200]] as const) {
      const value = optionalInteger(body, field, min, max);
      if (value !== undefined) {
        if (field === "sceneNo") {
          const duplicate = await db.prepare(`SELECT id FROM scenes WHERE script_id = ? AND scene_no = ? AND id != ?`).bind(scriptId, value, sceneId).first();
          if (duplicate) throw new ApiError(409, "SCENE_NUMBER_EXISTS", "该场次编号已存在。 ");
        }
        updates.push(`${column} = ?`); values.push(value);
      }
    }
    for (const [field, column] of [["dialogue", "dialogue_json"], ["characters", "characters_json"], ["wardrobe", "wardrobe_json"], ["props", "props_json"]] as const) {
      if (field in body) {
        if (!Array.isArray(body[field])) throw new ApiError(400, "VALIDATION_ERROR", `${field} 必须是数组。`, { field });
        updates.push(`${column} = ?`); values.push(jsonText(body[field], []));
      }
    }
    if (!updates.length) throw new ApiError(400, "NO_CHANGES", "没有可保存的场次内容。 ");
    updates.push("updated_at = ?"); values.push(nowIso(), sceneId, scriptId, projectId);
    await db.prepare(`UPDATE scenes SET ${updates.join(", ")} WHERE id = ? AND script_id = ? AND project_id = ?`).bind(...values).run();
    await touchProject(db, projectId);
    const row = await db.prepare(`${sceneSelect} WHERE id = ?`).bind(sceneId).first<Record<string, unknown>>();
    return ok({ scene: serializeSceneRecord(row!) });
  } catch (error) { return errorResponse(error); }
}

export async function DELETE(request: Request, context: RouteContext<{ projectId: string; scriptId: string; sceneId: string }>): Promise<Response> {
  try {
    const { projectId, scriptId, sceneId } = await context.params; const { db, identity } = await apiContext(request);
    await requireOwnedProject(db, projectId, identity.userId);
    const result = await db.prepare(`DELETE FROM scenes WHERE id = ? AND script_id = ? AND project_id = ?`).bind(sceneId, scriptId, projectId).run();
    if (!result.meta.changes) throw new ApiError(404, "SCENE_NOT_FOUND", "场次不存在。 ");
    await touchProject(db, projectId); return noContent();
  } catch (error) { return errorResponse(error); }
}
