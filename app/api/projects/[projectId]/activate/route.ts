import { errorResponse, nowIso, ok } from "@/lib/server/api";
import { apiContext, type RouteContext } from "@/lib/server/context";
import { requireOwnedProject } from "@/lib/server/store";

export async function POST(request: Request, context: RouteContext<{ projectId: string }>): Promise<Response> {
  try {
    const { projectId } = await context.params;
    const { db, identity } = await apiContext(request);
    await requireOwnedProject(db, projectId, identity.userId);
    await db.prepare(`UPDATE workspaces SET active_project_id = ?, updated_at = ? WHERE user_id = ?`).bind(projectId, nowIso(), identity.userId).run();
    return ok({ activeProjectId: projectId });
  } catch (error) {
    return errorResponse(error);
  }
}
