import { ApiError, errorResponse, jsonText, nowIso, ok, optionalString, readJsonObject } from "@/lib/server/api";
import { apiContext, type RouteContext } from "@/lib/server/context";
import { requireOwnedProject, touchProject } from "@/lib/server/store";

export const dynamic = "force-dynamic";

const selectStory = `SELECT project_id AS projectId, title, logline, synopsis, worldview,
  core_conflict AS coreConflict, themes_json AS themesJson, style_reference AS styleReference,
  story_bible AS storyBible, status, updated_at AS updatedAt FROM project_story WHERE project_id = ?`;

export async function GET(request: Request, context: RouteContext<{ projectId: string }>): Promise<Response> {
  try {
    const { projectId } = await context.params;
    const { db, identity } = await apiContext(request);
    await requireOwnedProject(db, projectId, identity.userId);
    const row = await db.prepare(selectStory).bind(projectId).first<Record<string, unknown>>();
    return ok({ story: serializeStory(row) });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PATCH(request: Request, context: RouteContext<{ projectId: string }>): Promise<Response> {
  try {
    const { projectId } = await context.params;
    const { db, identity } = await apiContext(request);
    await requireOwnedProject(db, projectId, identity.userId);
    const body = await readJsonObject(request);
    const updates: string[] = [];
    const values: unknown[] = [];
    for (const [field, column, max] of [
      ["title", "title", 200], ["logline", "logline", 2_000], ["synopsis", "synopsis", 50_000],
      ["worldview", "worldview", 50_000], ["coreConflict", "core_conflict", 20_000],
      ["styleReference", "style_reference", 20_000], ["storyBible", "story_bible", 100_000],
      ["status", "status", 40],
    ] as const) {
      const value = optionalString(body, field, { max });
      if (value !== undefined) { updates.push(`${column} = ?`); values.push(value); }
    }
    if ("themes" in body) {
      if (!Array.isArray(body.themes) || body.themes.some((theme) => typeof theme !== "string")) {
        throw new ApiError(400, "VALIDATION_ERROR", "themes 必须是字符串数组。", { field: "themes" });
      }
      updates.push("themes_json = ?"); values.push(jsonText(body.themes, []));
    }
    if (updates.length === 0) throw new ApiError(400, "NO_CHANGES", "没有可保存的故事内容。 ");
    updates.push("updated_at = ?"); values.push(nowIso(), projectId);
    await db.prepare(`UPDATE project_story SET ${updates.join(", ")} WHERE project_id = ?`).bind(...values).run();
    await touchProject(db, projectId);
    const row = await db.prepare(selectStory).bind(projectId).first<Record<string, unknown>>();
    return ok({ story: serializeStory(row) });
  } catch (error) {
    return errorResponse(error);
  }
}

function serializeStory(row: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!row) return null;
  let themes: unknown[] = [];
  try { themes = JSON.parse(String(row.themesJson)); } catch { themes = []; }
  return { ...row, themes, themesJson: undefined };
}
