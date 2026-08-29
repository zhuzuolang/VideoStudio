import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, test } from "vitest";

const migration = readFileSync(
  resolve(process.cwd(), "drizzle/0005_seed_public_openai_models.sql"),
  "utf8",
);

describe("公网 OpenAI-compatible 模型迁移", () => {
  test("从已加密的首张卡幂等复制其余九张卡", () => {
    const database = new DatabaseSync(":memory:");
    database.exec(`
      CREATE TABLE ai_models (
        id TEXT PRIMARY KEY NOT NULL,
        owner_id TEXT NOT NULL,
        name TEXT NOT NULL,
        provider TEXT NOT NULL,
        model_id TEXT NOT NULL,
        level TEXT NOT NULL,
        endpoint TEXT NOT NULL,
        icon_url TEXT,
        api_key_ciphertext TEXT,
        api_key_iv TEXT,
        api_key_hint TEXT,
        enabled INTEGER NOT NULL,
        parameters_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    database.prepare(`
      INSERT INTO ai_models (
        id, owner_id, name, provider, model_id, level, endpoint, icon_url,
        api_key_ciphertext, api_key_iv, api_key_hint, enabled, parameters_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "mdl_source",
      "owner_test",
      "gpt-5.3-codex-spark",
      "OpenAI-compatible",
      "gpt-5.3-codex-spark",
      "高速",
      "http://8.163.6.244:8317/v1",
      null,
      "v1.encrypted",
      "encrypted-iv",
      "61fd",
      1,
      JSON.stringify({ capabilities: ["text", "analysis", "code-review"] }),
      "2026-08-29T00:00:00.000Z",
      "2026-08-29T00:00:00.000Z",
    );

    database.exec(migration);
    database.exec(migration);

    const rows = database.prepare(`
      SELECT model_id, level, parameters_json, api_key_ciphertext, api_key_iv, api_key_hint
      FROM ai_models
      WHERE owner_id = ? AND endpoint = ?
      ORDER BY model_id
    `).all("owner_test", "http://8.163.6.244:8317/v1") as Array<Record<string, unknown>>;

    expect(rows).toHaveLength(10);
    expect(new Set(rows.map((row) => row.model_id)).size).toBe(10);
    expect(rows.every((row) => row.api_key_ciphertext === "v1.encrypted")).toBe(true);
    expect(rows.every((row) => row.api_key_iv === "encrypted-iv")).toBe(true);
    expect(rows.every((row) => row.api_key_hint === "61fd")).toBe(true);

    const byModel = Object.fromEntries(rows.map((row) => [String(row.model_id), row]));
    expect(byModel["gpt-5.6-sol"]).toMatchObject({ level: "旗舰" });
    expect(JSON.parse(String(byModel["gpt-image-2"].parameters_json))).toEqual({
      capabilities: ["image-generation", "text-to-image"],
    });
    expect(JSON.parse(String(byModel["codex-auto-review"].parameters_json))).toEqual({
      capabilities: ["text", "analysis", "code-review"],
    });
  });
});
