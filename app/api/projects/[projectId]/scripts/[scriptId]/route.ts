import { ApiError, errorResponse, noContent, nowIso, ok, optionalInteger, optionalString, readJsonObject } from "@/lib/server/api";
import { apiContext, type RouteContext } from "@/lib/server/context";
import { sceneSelect, scriptSelect, serializeSceneRecord } from "@/lib/server/records";
import { allRows, requireOwnedProject, touchProject } from "@/lib/server/store";

export async function PATCH(request: Request, context: RouteContext<{ projectId: string; scriptId: string }>): Promise<Response> {
  try {
    const { projectId, scriptId } = await context.params; const { db, identity } = await apiContext(request);
    await requireOwnedProject(db, projectId, identity.userId);
    const exists = await db.prepare(`SELECT id FROM scripts WHERE id = ? AND project_id = ?`).bind(scriptId, projectId).first();
    if (!exists) throw new ApiError(404, "SCRIPT_NOT_FOUND", "剧本不存在。 ");
    const body = await readJsonObject(request); const updates: string[] = []; const values: unknown[] = [];
    for (const [field, column, max, nullable] of [["title", "title", 200, false], ["status", "status", 40, false], ["bodyText", "body_text", 500_000, false], ["episodeId", "episode_id", 100, true]] as const) {
      const value = optionalString(body, field, { max, nullable });
      if (value !== undefined) {
        if (field === "episodeId" && value) {
          const episode = await db.prepare(`SELECT id FROM episodes WHERE id = ? AND project_id = ?`).bind(value, projectId).first();
          if (!episode) throw new ApiError(400, "INVALID_EPISODE", "所选分集不属于当前项目。 ");
        }
        updates.push(`${column} = ?`); values.push(value);
      }
    }
    const version = optionalInteger(body, "version", 1, 10_000);
    if (version !== undefined) { updates.push("version = ?"); values.push(version); }
    if (!updates.length) throw new ApiError(400, "NO_CHANGES", "没有可保存的剧本内容。 ");
    updates.push("updated_at = ?"); values.push(nowIso(), scriptId, projectId);
    await db.prepare(`UPDATE scripts SET ${updates.join(", ")} WHERE id = ? AND project_id = ?`).bind(...values).run();
    await touchProject(db, projectId);
    const script = await db.prepare(`${scriptSelect} WHERE id = ?`).bind(scriptId).first<Record<string, unknown>>();
    const scenes = await allRows(db.prepare(`${sceneSelect} WHERE script_id = ? ORDER BY order_index, scene_no`).bind(scriptId));
    return ok({ script: { ...script, scenes: scenes.map(serializeSceneRecord) } });
  } catch (error) { return errorResponse(error); }
}

export async function DELETE(request: Request, context: RouteContext<{ projectId: string; scriptId: string }>): Promise<Response> {
  try {
    const { projectId, scriptId } = await context.params; const { db, identity } = await apiContext(request);
    await requireOwnedProject(db, projectId, identity.userId);
    const result = await db.prepare(`DELETE FROM scripts WHERE id = ? AND project_id = ?`).bind(scriptId, projectId).run();
    if (!result.meta.changes) throw new ApiError(404, "SCRIPT_NOT_FOUND", "剧本不存在。 ");
    await touchProject(db, projectId); return noContent();
  } catch (error) { return errorResponse(error); }
}
