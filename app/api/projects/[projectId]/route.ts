import { ApiError, errorResponse, noContent, nowIso, ok, optionalInteger, optionalString, readJsonObject } from "@/lib/server/api";
import { apiContext, type RouteContext } from "@/lib/server/context";
import { bindings } from "@/lib/server/runtime";
import { listProjects, requireOwnedProject, workspacePayload } from "@/lib/server/store";

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: RouteContext<{ projectId: string }>): Promise<Response> {
  try {
    const { projectId } = await context.params;
    const { db, identity } = await apiContext(request);
    await requireOwnedProject(db, projectId, identity.userId);
    return ok(await workspacePayload(db, identity, projectId));
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
    for (const [field, column, max, nullable] of [
      ["name", "name", 120, false], ["genre", "genre", 80, false], ["description", "description", 2_000, false],
      ["status", "status", 40, false], ["aspectRatio", "aspect_ratio", 20, false],
      ["targetPlatform", "target_platform", 120, false], ["coverUrl", "cover_url", 2_000, true],
    ] as const) {
      const value = optionalString(body, field, { max, nullable });
      if (value !== undefined) { updates.push(`${column} = ?`); values.push(value); }
    }
    for (const [field, column, min, max] of [
      ["episodeCount", "episode_count", 1, 500],
      ["singleEpisodeDuration", "single_episode_duration", 15, 7_200],
    ] as const) {
      const value = optionalInteger(body, field, min, max);
      if (value !== undefined) { updates.push(`${column} = ?`); values.push(value); }
    }
    if (updates.length === 0) throw new ApiError(400, "NO_CHANGES", "没有可保存的项目设置。 ");
    updates.push("updated_at = ?"); values.push(nowIso(), projectId, identity.userId);
    await db.prepare(`UPDATE projects SET ${updates.join(", ")} WHERE id = ? AND owner_id = ?`).bind(...values).run();
    const project = (await listProjects(db, identity.userId)).find((item) => item.id === projectId);
    return ok({ project });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: Request, context: RouteContext<{ projectId: string }>): Promise<Response> {
  try {
    const { projectId } = await context.params;
    const { db, identity } = await apiContext(request);
    await requireOwnedProject(db, projectId, identity.userId);
    const count = await db.prepare(`SELECT COUNT(*) AS total FROM projects WHERE owner_id = ?`).bind(identity.userId).first<{ total: number }>();
    if (Number(count?.total ?? 0) <= 1) throw new ApiError(409, "LAST_PROJECT_REQUIRED", "至少保留一个项目；请先创建新项目再删除当前项目。 ");
    const activeGeneration = await db.prepare(`SELECT id FROM asset_generation_jobs
      WHERE project_id = ? AND owner_id = ? AND status IN ('queued', 'running') AND dismissed_at IS NULL LIMIT 1`)
      .bind(projectId, identity.userId)
      .first<{ id: string }>();
    if (activeGeneration) {
      throw new ApiError(409, "PROJECT_GENERATION_ACTIVE", "当前项目仍有图片生成任务正在执行，请等待任务结束后再删除项目。");
    }
    const stored = await db.prepare(`SELECT storage_key AS storageKey FROM assets
      WHERE project_id = ? AND storage_key IS NOT NULL
      UNION
      SELECT storage_key AS storageKey FROM asset_generation_jobs
      WHERE project_id = ? AND storage_key IS NOT NULL`)
      .bind(projectId, projectId)
      .all<{ storageKey: string }>();
    const keys = (stored.results ?? []).map((item) => item.storageKey);
    const bucket = keys.length > 0 ? bindings().MEDIA : undefined;
    if (keys.length > 0 && !bucket) throw new ApiError(503, "MEDIA_STORAGE_NOT_CONFIGURED", "媒体存储尚未配置，无法安全删除项目文件。 ");
    const next = await db.prepare(`SELECT id FROM projects WHERE owner_id = ? AND id != ? ORDER BY updated_at DESC LIMIT 1`).bind(identity.userId, projectId).first<{ id: string }>();
    const deletion = await db.batch([
      db.prepare(`DELETE FROM projects WHERE id = ? AND owner_id = ?
        AND NOT EXISTS (SELECT 1 FROM asset_generation_jobs
          WHERE project_id = ? AND status IN ('queued', 'running') AND dismissed_at IS NULL)`)
        .bind(projectId, identity.userId, projectId),
      db.prepare(`UPDATE workspaces SET active_project_id = ?, updated_at = ?
        WHERE user_id = ? AND NOT EXISTS (SELECT 1 FROM projects WHERE id = ? AND owner_id = ?)`)
        .bind(next?.id ?? null, nowIso(), identity.userId, projectId, identity.userId),
    ]);
    if (!deletion[0]?.meta.changes) {
      throw new ApiError(409, "PROJECT_GENERATION_ACTIVE", "当前项目出现了新的图片生成任务，请等待任务结束后再删除项目。");
    }
    if (bucket) {
      try {
        for (let offset = 0; offset < keys.length; offset += 1_000) await bucket.delete(keys.slice(offset, offset + 1_000));
      } catch { console.error("Deferred R2 project cleanup is required", { projectId, objectCount: keys.length }); }
    }
    return noContent();
  } catch (error) {
    return errorResponse(error);
  }
}
