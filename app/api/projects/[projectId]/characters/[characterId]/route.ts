import { ApiError, errorResponse, jsonText, noContent, nowIso, ok, optionalString, readJsonObject } from "@/lib/server/api";
import { apiContext, type RouteContext } from "@/lib/server/context";
import { requireOwnedProject, touchProject } from "@/lib/server/store";
import { characterSelect, serializeCharacter } from "@/lib/server/records";

export async function PATCH(request: Request, context: RouteContext<{ projectId: string; characterId: string }>): Promise<Response> {
  try {
    const { projectId, characterId } = await context.params;
    const { db, identity } = await apiContext(request);
    await requireOwnedProject(db, projectId, identity.userId);
    const exists = await db.prepare(`SELECT id FROM characters WHERE id = ? AND project_id = ?`).bind(characterId, projectId).first();
    if (!exists) throw new ApiError(404, "CHARACTER_NOT_FOUND", "人物不存在。 ");
    const body = await readJsonObject(request); const updates: string[] = []; const values: unknown[] = [];
    for (const [field, column, max, nullable] of [
      ["name", "name", 120, false], ["role", "role", 80, false], ["bio", "bio", 50_000, false],
      ["appearance", "appearance", 50_000, false], ["personality", "personality", 50_000, false],
      ["arc", "arc", 50_000, false], ["voice", "voice", 50_000, false],
      ["avatarUrl", "avatar_url", 2_000, true], ["status", "status", 40, false],
    ] as const) {
      const value = optionalString(body, field, { max, nullable });
      if (value !== undefined) { updates.push(`${column} = ?`); values.push(value); }
    }
    if ("relationships" in body) {
      if (!Array.isArray(body.relationships)) throw new ApiError(400, "VALIDATION_ERROR", "relationships 必须是数组。 ");
      updates.push("relationships_json = ?"); values.push(jsonText(body.relationships, []));
    }
    if (updates.length === 0) throw new ApiError(400, "NO_CHANGES", "没有可保存的人物信息。 ");
    updates.push("updated_at = ?"); values.push(nowIso(), characterId, projectId);
    await db.prepare(`UPDATE characters SET ${updates.join(", ")} WHERE id = ? AND project_id = ?`).bind(...values).run();
    await touchProject(db, projectId);
    const row = await db.prepare(`${characterSelect} WHERE id = ? AND project_id = ?`).bind(characterId, projectId).first<Record<string, unknown>>();
    return ok({ character: serializeCharacter(row!) });
  } catch (error) { return errorResponse(error); }
}

export async function DELETE(request: Request, context: RouteContext<{ projectId: string; characterId: string }>): Promise<Response> {
  try {
    const { projectId, characterId } = await context.params; const { db, identity } = await apiContext(request);
    await requireOwnedProject(db, projectId, identity.userId);
    const result = await db.prepare(`DELETE FROM characters WHERE id = ? AND project_id = ?`).bind(characterId, projectId).run();
    if (!result.meta.changes) throw new ApiError(404, "CHARACTER_NOT_FOUND", "人物不存在。 ");
    await touchProject(db, projectId); return noContent();
  } catch (error) { return errorResponse(error); }
}
