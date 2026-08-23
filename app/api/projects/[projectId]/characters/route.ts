import { ApiError, created, errorResponse, id, jsonText, nowIso, ok, optionalString, readJsonObject, requiredString } from "@/lib/server/api";
import { apiContext, type RouteContext } from "@/lib/server/context";
import { allRows, requireOwnedProject, touchProject } from "@/lib/server/store";
import { characterSelect, serializeCharacter } from "@/lib/server/records";

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: RouteContext<{ projectId: string }>): Promise<Response> {
  try {
    const { projectId } = await context.params;
    const { db, identity } = await apiContext(request);
    await requireOwnedProject(db, projectId, identity.userId);
    const rows = await allRows(db.prepare(`${characterSelect} WHERE project_id = ? ORDER BY created_at`).bind(projectId));
    return ok({ characters: rows.map(serializeCharacter) });
  } catch (error) { return errorResponse(error); }
}

export async function POST(request: Request, context: RouteContext<{ projectId: string }>): Promise<Response> {
  try {
    const { projectId } = await context.params;
    const { db, identity } = await apiContext(request);
    await requireOwnedProject(db, projectId, identity.userId);
    const body = await readJsonObject(request);
    const name = requiredString(body, "name", { max: 120 });
    const role = optionalString(body, "role", { max: 80 }) || "配角";
    const fields = ["bio", "appearance", "personality", "arc", "voice"] as const;
    const strings = Object.fromEntries(fields.map((field) => [field, optionalString(body, field, { max: 50_000 }) || ""]));
    const avatarUrl = optionalString(body, "avatarUrl", { max: 2_000, nullable: true });
    const status = optionalString(body, "status", { max: 40 }) || "draft";
    const relationships = body.relationships ?? [];
    if (!Array.isArray(relationships)) throw new ApiError(400, "VALIDATION_ERROR", "relationships 必须是数组。 ");
    const characterId = id("chr"); const now = nowIso();
    await db.prepare(`INSERT INTO characters (id, project_id, name, role, bio, appearance, personality, arc, voice, relationships_json, avatar_url, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
      characterId, projectId, name, role, strings.bio, strings.appearance, strings.personality, strings.arc, strings.voice,
      jsonText(relationships, []), avatarUrl ?? null, status, now, now,
    ).run();
    await touchProject(db, projectId);
    const row = await db.prepare(`${characterSelect} WHERE id = ?`).bind(characterId).first<Record<string, unknown>>();
    return created({ character: serializeCharacter(row!) });
  } catch (error) { return errorResponse(error); }
}
