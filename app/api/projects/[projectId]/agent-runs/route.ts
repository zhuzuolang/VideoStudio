import { ApiError, created, errorResponse, id, jsonText, nowIso, ok, optionalString, readJsonObject, requiredString } from "@/lib/server/api";
import { callConfiguredModel, collectAgentSources, parseSourceSelection } from "@/lib/server/agent";
import { apiContext, type RouteContext } from "@/lib/server/context";
import { allRows, requireOwnedModel, requireOwnedProject, serializeAgentRun, touchProject } from "@/lib/server/store";

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: RouteContext<{ projectId: string }>): Promise<Response> {
  try {
    const { projectId } = await context.params; const { db, identity } = await apiContext(request);
    await requireOwnedProject(db, projectId, identity.userId);
    return ok({ agentRuns: await listRuns(db, projectId, identity.userId) });
  } catch (error) { return errorResponse(error); }
}

export async function POST(request: Request, context: RouteContext<{ projectId: string }>): Promise<Response> {
  let runId: string | undefined; let db: D1Database | undefined;
  try {
    const { projectId } = await context.params; const api = await apiContext(request); db = api.db;
    await requireOwnedProject(db, projectId, api.identity.userId);
    const body = await readJsonObject(request);
    const modelId = requiredString(body, "modelId", { max: 100 });
    const prompt = requiredString(body, "prompt", { max: 20_000 });
    const systemPrompt = optionalString(body, "systemPrompt", { max: 20_000, nullable: true }) ?? null;
    const model = await requireOwnedModel(db, modelId, api.identity.userId);
    const sources = await collectAgentSources(db, projectId, parseSourceSelection(body.sources));
    runId = id("run"); const createdAt = nowIso();
    await db.batch([
      db.prepare(`INSERT INTO agent_runs (id, project_id, owner_id, model_id, model_name, prompt, system_prompt, status, response, error_message, usage_json, request_meta_json, created_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'running', NULL, NULL, '{}', ?, ?, NULL)`).bind(runId, projectId, api.identity.userId, modelId, String(model.name), prompt, systemPrompt, jsonText({ sourceCount: sources.length }, {}), createdAt),
      ...sources.map((source) => db!.prepare(`INSERT INTO agent_run_sources (id, run_id, source_type, source_id, title, snapshot_json) VALUES (?, ?, ?, ?, ?, ?)`).bind(id("src"), runId!, source.sourceType, source.sourceId, source.title, jsonText(source.snapshot, {}))),
    ]);
    try {
      const result = await callConfiguredModel(model, prompt, systemPrompt, sources);
      const completedAt = nowIso();
      await db.prepare(`UPDATE agent_runs SET status = 'completed', response = ?, usage_json = ?, request_meta_json = ?, completed_at = ? WHERE id = ? AND owner_id = ?`).bind(result.response, jsonText(result.usage, {}), jsonText(result.requestMeta, {}), completedAt, runId, api.identity.userId).run();
      await touchProject(db, projectId);
      const run = (await listRuns(db, projectId, api.identity.userId)).find((item) => item.id === runId);
      return created({ run });
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 2_000) : "模型调用失败";
      await db.prepare(`UPDATE agent_runs SET status = 'failed', error_message = ?, completed_at = ? WHERE id = ? AND owner_id = ?`).bind(message, nowIso(), runId, api.identity.userId).run();
      if (error instanceof ApiError) throw new ApiError(error.status, error.code, error.message, { ...(typeof error.details === "object" && !Array.isArray(error.details) ? error.details : {}), runId });
      throw new ApiError(502, "MODEL_REQUEST_FAILED", "模型调用失败，请检查模型配置后重试。", { runId });
    }
  } catch (error) {
    return errorResponse(error);
  }
}

async function listRuns(db: D1Database, projectId: string, ownerId: string): Promise<Record<string, unknown>[]> {
  const rows = await allRows(db.prepare(`SELECT id, project_id AS projectId, model_id AS modelId, model_name AS modelName,
    prompt, system_prompt AS systemPrompt, status, response, error_message AS errorMessage,
    usage_json AS usageJson, request_meta_json AS requestMetaJson, created_at AS createdAt, completed_at AS completedAt
    FROM agent_runs WHERE project_id = ? AND owner_id = ? ORDER BY created_at DESC LIMIT 50`).bind(projectId, ownerId));
  if (!rows.length) return [];
  const placeholders = rows.map(() => "?").join(", ");
  const sourceRows = await allRows(db.prepare(`SELECT id, run_id AS runId, source_type AS sourceType, source_id AS sourceId,
    title, snapshot_json AS snapshotJson FROM agent_run_sources WHERE run_id IN (${placeholders}) ORDER BY rowid`).bind(...rows.map((row) => String(row.id))));
  return rows.map((row) => serializeAgentRun(row, sourceRows.filter((source) => source.runId === row.id).map((source) => ({ id: source.id, sourceType: source.sourceType, sourceId: source.sourceId, title: source.title, snapshot: JSON.parse(String(source.snapshotJson)) }))));
}
