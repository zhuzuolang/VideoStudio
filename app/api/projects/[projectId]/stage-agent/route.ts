import { ApiError, created, errorResponse, ok, optionalString, readJsonObject, requiredString } from "@/lib/server/api";
import { apiContext, type RouteContext } from "@/lib/server/context";
import {
  executeStageAgentActions,
  parseStageAgentHistory,
  parseStageAgentStage,
  planStageAgent,
} from "@/lib/server/stage-agent";

export const dynamic = "force-dynamic";

export async function POST(request: Request, context: RouteContext<{ projectId: string }>): Promise<Response> {
  try {
    const { projectId } = await context.params;
    const { db, identity } = await apiContext(request);
    const body = await readJsonObject(request);
    const mode = optionalString(body, "mode", { max: 20 }) || "plan";
    const stage = parseStageAgentStage(body.stage);

    if (mode === "plan") {
      const modelId = requiredString(body, "modelId", { max: 100 });
      const message = requiredString(body, "message", { max: 8_000 });
      const result = await planStageAgent({
        db,
        projectId,
        ownerId: identity.userId,
        stage,
        modelId,
        message,
        history: parseStageAgentHistory(body.history),
      });
      return created(result);
    }

    if (mode === "execute") {
      const runId = optionalString(body, "runId", { max: 100, nullable: true });
      return ok(await executeStageAgentActions({
        db,
        projectId,
        ownerId: identity.userId,
        stage,
        actions: body.actions,
        runId,
      }));
    }

    throw new ApiError(400, "INVALID_STAGE_AGENT_MODE", "mode 只能是 plan 或 execute。");
  } catch (error) {
    return errorResponse(error);
  }
}
