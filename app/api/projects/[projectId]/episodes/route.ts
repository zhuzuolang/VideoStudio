import { ApiError, created, errorResponse, id, nowIso, ok, optionalInteger, optionalString, readJsonObject, requiredString } from "@/lib/server/api";
import { apiContext, type RouteContext } from "@/lib/server/context";
import { episodeSelect } from "@/lib/server/records";
import { allRows, requireOwnedProject, touchProject } from "@/lib/server/store";

export async function GET(request: Request, context: RouteContext<{ projectId: string }>): Promise<Response> {
  try {
    const { projectId } = await context.params; const { db, identity } = await apiContext(request);
    await requireOwnedProject(db, projectId, identity.userId);
    return ok({ episodes: await allRows(db.prepare(`${episodeSelect} WHERE project_id = ? ORDER BY episode_no`).bind(projectId)) });
  } catch (error) { return errorResponse(error); }
}

export async function POST(request: Request, context: RouteContext<{ projectId: string }>): Promise<Response> {
  try {
    const { projectId } = await context.params; const { db, identity } = await apiContext(request);
    const project = await requireOwnedProject(db, projectId, identity.userId); const body = await readJsonObject(request);
    let episodeNo = optionalInteger(body, "episodeNo", 1, 10_000);
    if (episodeNo === undefined) {
      const max = await db.prepare(`SELECT COALESCE(MAX(episode_no), 0) AS value FROM episodes WHERE project_id = ?`).bind(projectId).first<{ value: number }>();
      episodeNo = Number(max?.value ?? 0) + 1;
    }
    const duplicate = await db.prepare(`SELECT id FROM episodes WHERE project_id = ? AND episode_no = ?`).bind(projectId, episodeNo).first();
    if (duplicate) throw new ApiError(409, "EPISODE_NUMBER_EXISTS", "该集数已存在。 ");
    const title = requiredString(body, "title", { max: 200 });
    const summary = optionalString(body, "summary", { max: 50_000 }) || "";
    const hook = optionalString(body, "hook", { max: 20_000 }) || "";
    const duration = optionalInteger(body, "durationSeconds", 5, 7_200) ?? Number(project.singleEpisodeDuration ?? 120);
    const status = optionalString(body, "status", { max: 40 }) || "outline";
    const episodeId = id("ep"); const now = nowIso();
    await db.prepare(`INSERT INTO episodes (id, project_id, episode_no, title, summary, hook, duration_seconds, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(episodeId, projectId, episodeNo, title, summary, hook, duration, status, now, now).run();
    await touchProject(db, projectId);
    const episode = await db.prepare(`${episodeSelect} WHERE id = ?`).bind(episodeId).first<Record<string, unknown>>();
    return created({ episode });
  } catch (error) { return errorResponse(error); }
}
