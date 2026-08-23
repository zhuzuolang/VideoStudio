import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const workspaces = sqliteTable("workspaces", {
  userId: text("user_id").primaryKey(),
  email: text("email").notNull(),
  displayName: text("display_name").notNull(),
  activeProjectId: text("active_project_id"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const workspaceInitializations = sqliteTable("workspace_initializations", {
  userId: text("user_id")
    .primaryKey()
    .references(() => workspaces.userId, { onDelete: "cascade" }),
  initializedAt: text("initialized_at").notNull(),
});

export const projects = sqliteTable(
  "projects",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id").notNull(),
    name: text("name").notNull(),
    genre: text("genre").notNull().default("剧情"),
    description: text("description").notNull().default(""),
    status: text("status").notNull().default("developing"),
    episodeCount: integer("episode_count").notNull().default(12),
    singleEpisodeDuration: integer("single_episode_duration").notNull().default(120),
    aspectRatio: text("aspect_ratio").notNull().default("9:16"),
    targetPlatform: text("target_platform").notNull().default("短视频平台"),
    coverUrl: text("cover_url"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("idx_projects_owner_updated").on(table.ownerId, table.updatedAt),
  ],
);

export const projectStory = sqliteTable("project_story", {
  projectId: text("project_id")
    .primaryKey()
    .references(() => projects.id, { onDelete: "cascade" }),
  title: text("title").notNull().default(""),
  logline: text("logline").notNull().default(""),
  synopsis: text("synopsis").notNull().default(""),
  worldview: text("worldview").notNull().default(""),
  coreConflict: text("core_conflict").notNull().default(""),
  themesJson: text("themes_json").notNull().default("[]"),
  styleReference: text("style_reference").notNull().default(""),
  storyBible: text("story_bible").notNull().default(""),
  status: text("status").notNull().default("draft"),
  updatedAt: text("updated_at").notNull(),
});

export const episodes = sqliteTable(
  "episodes",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    episodeNo: integer("episode_no").notNull(),
    title: text("title").notNull(),
    summary: text("summary").notNull().default(""),
    hook: text("hook").notNull().default(""),
    durationSeconds: integer("duration_seconds").notNull().default(120),
    status: text("status").notNull().default("outline"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("uidx_episodes_project_no").on(table.projectId, table.episodeNo),
    index("idx_episodes_project").on(table.projectId),
  ],
);

export const characters = sqliteTable(
  "characters",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    role: text("role").notNull().default("配角"),
    bio: text("bio").notNull().default(""),
    appearance: text("appearance").notNull().default(""),
    personality: text("personality").notNull().default(""),
    arc: text("arc").notNull().default(""),
    voice: text("voice").notNull().default(""),
    relationshipsJson: text("relationships_json").notNull().default("[]"),
    avatarUrl: text("avatar_url"),
    status: text("status").notNull().default("draft"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [index("idx_characters_project").on(table.projectId)],
);

export const scripts = sqliteTable(
  "scripts",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    episodeId: text("episode_id").references(() => episodes.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    version: integer("version").notNull().default(1),
    status: text("status").notNull().default("draft"),
    bodyText: text("body_text").notNull().default(""),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("idx_scripts_project").on(table.projectId),
    index("idx_scripts_episode").on(table.episodeId),
  ],
);

export const scenes = sqliteTable(
  "scenes",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    scriptId: text("script_id")
      .notNull()
      .references(() => scripts.id, { onDelete: "cascade" }),
    sceneNo: integer("scene_no").notNull(),
    orderIndex: integer("order_index").notNull().default(0),
    heading: text("heading").notNull(),
    location: text("location").notNull().default(""),
    timeOfDay: text("time_of_day").notNull().default(""),
    summary: text("summary").notNull().default(""),
    action: text("action").notNull().default(""),
    dialogueJson: text("dialogue_json").notNull().default("[]"),
    charactersJson: text("characters_json").notNull().default("[]"),
    wardrobeJson: text("wardrobe_json").notNull().default("[]"),
    propsJson: text("props_json").notNull().default("[]"),
    durationSeconds: integer("duration_seconds").notNull().default(30),
    status: text("status").notNull().default("draft"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("uidx_scenes_script_no").on(table.scriptId, table.sceneNo),
    index("idx_scenes_project").on(table.projectId),
  ],
);

export const assets = sqliteTable(
  "assets",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    type: text("type").notNull(),
    description: text("description").notNull().default(""),
    mimeType: text("mime_type"),
    sizeBytes: integer("size_bytes"),
    storageKey: text("storage_key"),
    sourceUrl: text("source_url"),
    thumbnailUrl: text("thumbnail_url"),
    metadataJson: text("metadata_json").notNull().default("{}"),
    status: text("status").notNull().default("ready"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("idx_assets_project_type").on(table.projectId, table.type),
    uniqueIndex("uidx_assets_storage_key").on(table.storageKey),
  ],
);

export const aiModels = sqliteTable(
  "ai_models",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id").notNull(),
    name: text("name").notNull(),
    provider: text("provider").notNull().default("OpenAI-compatible"),
    modelId: text("model_id").notNull(),
    level: text("level").notNull().default("standard"),
    endpoint: text("endpoint").notNull(),
    iconUrl: text("icon_url"),
    apiKeyCiphertext: text("api_key_ciphertext"),
    apiKeyIv: text("api_key_iv"),
    apiKeyHint: text("api_key_hint"),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    parametersJson: text("parameters_json").notNull().default("{}"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [index("idx_ai_models_owner_updated").on(table.ownerId, table.updatedAt)],
);

export const agentRuns = sqliteTable(
  "agent_runs",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    ownerId: text("owner_id").notNull(),
    modelId: text("model_id").references(() => aiModels.id, { onDelete: "set null" }),
    modelName: text("model_name").notNull(),
    prompt: text("prompt").notNull(),
    systemPrompt: text("system_prompt"),
    status: text("status").notNull(),
    response: text("response"),
    errorMessage: text("error_message"),
    usageJson: text("usage_json").notNull().default("{}"),
    requestMetaJson: text("request_meta_json").notNull().default("{}"),
    createdAt: text("created_at").notNull(),
    completedAt: text("completed_at"),
  },
  (table) => [
    index("idx_agent_runs_project_created").on(table.projectId, table.createdAt),
    index("idx_agent_runs_owner").on(table.ownerId),
  ],
);

export const agentRunSources = sqliteTable(
  "agent_run_sources",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    sourceType: text("source_type").notNull(),
    sourceId: text("source_id").notNull(),
    title: text("title").notNull(),
    snapshotJson: text("snapshot_json").notNull(),
  },
  (table) => [index("idx_agent_run_sources_run").on(table.runId)],
);
