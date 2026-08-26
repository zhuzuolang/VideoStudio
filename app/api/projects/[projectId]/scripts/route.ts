import { ApiError, created, errorResponse, id, nowIso, ok, optionalInteger, optionalString, readJsonObject, requiredString } from "@/lib/server/api";
import { apiContext, type RouteContext } from "@/lib/server/context";
import { sceneSelect, scriptSelect, serializeSceneRecord } from "@/lib/server/records";
import { allRows, requireOwnedProject, touchProject } from "@/lib/server/store";

export async function GET(request: Request, context: RouteContext<{ projectId: string }>): Promise<Response> {
  try {
    const { projectId } = await context.params; const { db, identity } = await apiContext(request);
    await requireOwnedProject(db, projectId, identity.userId);
    const scripts = await allRows(db.prepare(`${scriptSelect} WHERE project_id = ? ORDER BY created_at`).bind(projectId));
    const scenes = await allRows(db.prepare(`${sceneSelect} WHERE project_id = ? ORDER BY script_id, order_index, scene_no`).bind(projectId));
    return ok({ scripts: scripts.map((script) => ({ ...script, scenes: scenes.filter((scene) => scene.scriptId === script.id).map(serializeSceneRecord) })) });
  } catch (error) { return errorResponse(error); }
}

export async function POST(request: Request, context: RouteContext<{ projectId: string }>): Promise<Response> {
  try {
    const { projectId } = await context.params; const { db, identity } = await apiContext(request);
    await requireOwnedProject(db, projectId, identity.userId); const body = await readJsonObject(request);
    const title = requiredString(body, "title", { max: 200 });
    const episodeId = optionalString(body, "episodeId", { max: 100, nullable: true });
    if (episodeId) {
      const episode = await db.prepare(`SELECT id FROM episodes WHERE id = ? AND project_id = ?`).bind(episodeId, projectId).first();
      if (!episode) throw new ApiError(400, "INVALID_EPISODE", "所选分集不属于当前项目。 ");
    }
    let version = optionalInteger(body, "version", 1, 10_000);
    if (version === undefined) {
      if (episodeId) {
        const latest = await db.prepare(`SELECT COALESCE(MAX(version), 0) AS value FROM scripts WHERE project_id = ? AND episode_id = ?`).bind(projectId, episodeId).first<{ value: number }>();
        version = Number(latest?.value ?? 0) + 1;
      } else {
        version = 1;
      }
    }
    const status = optionalString(body, "status", { max: 40 }) || "draft";
    const bodyText = optionalString(body, "bodyText", { max: 500_000 }) || "";
    const scriptId = id("scr"); const now = nowIso();
    await db.prepare(`INSERT INTO scripts (id, project_id, episode_id, title, version, status, body_text, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(scriptId, projectId, episodeId ?? null, title, version, status, bodyText, now, now).run();
    await touchProject(db, projectId);
    const script = await db.prepare(`${scriptSelect} WHERE id = ?`).bind(scriptId).first<Record<string, unknown>>();
    return created({ script: { ...script, scenes: [] } });
  } catch (error) { return errorResponse(error); }
}
