import { ApiError, created, errorResponse, id, nowIso, ok, optionalInteger, optionalString, readJsonObject, requiredString } from "@/lib/server/api";
import { apiContext } from "@/lib/server/context";
import { listProjects } from "@/lib/server/store";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    const { db, identity } = await apiContext(request);
    const workspace = await db.prepare(`SELECT active_project_id AS activeProjectId FROM workspaces WHERE user_id = ?`).bind(identity.userId).first<Record<string, unknown>>();
    return ok({ projects: await listProjects(db, identity.userId), activeProjectId: workspace?.activeProjectId ?? null });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const { db, identity } = await apiContext(request);
    const body = await readJsonObject(request);
    const name = requiredString(body, "name", { max: 120 });
    const genre = optionalString(body, "genre", { max: 80 }) || "剧情";
    const description = optionalString(body, "description", { max: 2_000 }) || "";
    const status = optionalString(body, "status", { max: 40 }) || "planning";
    const episodeCount = optionalInteger(body, "episodeCount", 1, 500) ?? 12;
    const duration = optionalInteger(body, "singleEpisodeDuration", 15, 7_200) ?? 120;
    const aspectRatio = optionalString(body, "aspectRatio", { max: 20 }) || "9:16";
    const targetPlatform = optionalString(body, "targetPlatform", { max: 120 }) || "短视频平台";
    const coverUrl = optionalString(body, "coverUrl", { max: 2_000, nullable: true });
    const projectId = id("prj");
    const now = nowIso();
    await db.batch([
      db.prepare(`INSERT INTO projects (id, owner_id, name, genre, description, status, episode_count, single_episode_duration, aspect_ratio, target_platform, cover_url, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(projectId, identity.userId, name, genre, description, status, episodeCount, duration, aspectRatio, targetPlatform, coverUrl ?? null, now, now),
      db.prepare(`INSERT INTO project_story (project_id, title, logline, synopsis, worldview, core_conflict, themes_json, style_reference, story_bible, status, updated_at) VALUES (?, ?, '', '', '', '', '[]', '', '', 'draft', ?)`).bind(projectId, name, now),
      db.prepare(`UPDATE workspaces SET active_project_id = ?, updated_at = ? WHERE user_id = ?`).bind(projectId, now, identity.userId),
    ]);
    const project = (await listProjects(db, identity.userId)).find((item) => item.id === projectId);
    if (!project) throw new ApiError(500, "PROJECT_CREATE_FAILED", "项目创建后无法读取。 ");
    return created({ project, activeProjectId: projectId });
  } catch (error) {
    return errorResponse(error);
  }
}
