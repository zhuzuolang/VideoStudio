import { errorResponse, ok } from "@/lib/server/api";
import { apiContext } from "@/lib/server/context";
import { workspacePayload } from "@/lib/server/store";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    const { db, identity } = await apiContext(request);
    const projectId = new URL(request.url).searchParams.get("projectId");
    return ok(await workspacePayload(db, identity, projectId));
  } catch (error) {
    return errorResponse(error);
  }
}
