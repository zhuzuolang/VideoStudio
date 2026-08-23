import { parseJson } from "./api";

export const characterSelect = `SELECT id, project_id AS projectId, name, role, bio, appearance, personality,
  arc, voice, relationships_json AS relationshipsJson, avatar_url AS avatarUrl, status,
  created_at AS createdAt, updated_at AS updatedAt FROM characters`;

export function serializeCharacter(row: Record<string, unknown>): Record<string, unknown> {
  return { ...row, relationships: parseJson(row.relationshipsJson, []), relationshipsJson: undefined };
}

export const episodeSelect = `SELECT id, project_id AS projectId, episode_no AS episodeNo, title, summary, hook,
  duration_seconds AS durationSeconds, status, created_at AS createdAt, updated_at AS updatedAt FROM episodes`;

export const scriptSelect = `SELECT id, project_id AS projectId, episode_id AS episodeId, title, version, status,
  body_text AS bodyText, created_at AS createdAt, updated_at AS updatedAt FROM scripts`;

export const sceneSelect = `SELECT id, project_id AS projectId, script_id AS scriptId, scene_no AS sceneNo,
  order_index AS orderIndex, heading, location, time_of_day AS timeOfDay, summary, action,
  dialogue_json AS dialogueJson, characters_json AS charactersJson, wardrobe_json AS wardrobeJson,
  props_json AS propsJson, duration_seconds AS durationSeconds, status,
  created_at AS createdAt, updated_at AS updatedAt FROM scenes`;

export function serializeSceneRecord(row: Record<string, unknown>): Record<string, unknown> {
  return {
    ...row,
    dialogue: parseJson(row.dialogueJson, []),
    characters: parseJson(row.charactersJson, []),
    wardrobe: parseJson(row.wardrobeJson, []),
    props: parseJson(row.propsJson, []),
    dialogueJson: undefined,
    charactersJson: undefined,
    wardrobeJson: undefined,
    propsJson: undefined,
  };
}
