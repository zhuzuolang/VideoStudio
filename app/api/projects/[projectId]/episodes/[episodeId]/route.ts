import { ApiError, errorResponse, noContent, nowIso, ok, optionalInteger, optionalString, readJsonObject } from "@/lib/server/api";
import { apiContext, type RouteContext } from "@/lib/server/context";
import { episodeSelect } from "@/lib/server/records";
import { requireOwnedProject, touchProject } from "@/lib/server/store";

export async function PATCH(request: Request, context: RouteContext<{ projectId: string; episodeId: string }>): Promise<Response> {
  try {
    const { projectId, episodeId } = await context.params; const { db, identity } = await apiContext(request);
    await requireOwnedProject(db, projectId, identity.userId);
    const exists = await db.prepare(`SELECT id FROM episodes WHERE id = ? AND project_id = ?`).bind(episodeId, projectId).first();
    if (!exists) throw new ApiError(404, "EPISODE_NOT_FOUND", "分集不存在。 ");
    const body = await readJsonObject(request); const updates: string[] = []; const values: unknown[] = [];
    for (const [field, column, max] of [["title", "title", 200], ["summary", "summary", 50_000], ["hook", "hook", 20_000], ["status", "status", 40]] as const) {
      const value = optionalString(body, field, { max }); if (value !== undefined) { updates.push(`${column} = ?`); values.push(value); }
    }
    for (const [field, column, min, max] of [["episodeNo", "episode_no", 1, 10_000], ["durationSeconds", "duration_seconds", 5, 7_200]] as const) {
      const value = optionalInteger(body, field, min, max);
      if (value !== undefined) {
        if (field === "episodeNo") {
          const duplicate = await db.prepare(`SELECT id FROM episodes WHERE project_id = ? AND episode_no = ? AND id != ?`).bind(projectId, value, episodeId).first();
          if (duplicate) throw new ApiError(409, "EPISODE_NUMBER_EXISTS", "该集数已存在。 ");
        }
        updates.push(`${column} = ?`); values.push(value);
      }
    }
    if (!updates.length) throw new ApiError(400, "NO_CHANGES", "没有可保存的分集内容。 ");
    updates.push("updated_at = ?"); values.push(nowIso(), episodeId, projectId);
    await db.prepare(`UPDATE episodes SET ${updates.join(", ")} WHERE id = ? AND project_id = ?`).bind(...values).run();
    await touchProject(db, projectId);
    const episode = await db.prepare(`${episodeSelect} WHERE id = ?`).bind(episodeId).first<Record<string, unknown>>();
    return ok({ episode });
  } catch (error) { return errorResponse(error); }
}

export async function DELETE(request: Request, context: RouteContext<{ projectId: string; episodeId: string }>): Promise<Response> {
  try {
    const { projectId, episodeId } = await context.params; const { db, identity } = await apiContext(request);
    await requireOwnedProject(db, projectId, identity.userId);
    const result = await db.prepare(`DELETE FROM episodes WHERE id = ? AND project_id = ?`).bind(episodeId, projectId).run();
    if (!result.meta.changes) throw new ApiError(404, "EPISODE_NOT_FOUND", "分集不存在。 ");
    await touchProject(db, projectId); return noContent();
  } catch (error) { return errorResponse(error); }
}
