export type ApiSuccess<T> = { data: T };

export type ApiFailure = {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
};

export type ApiEnvelope<T> = ApiSuccess<T> | ApiFailure;

export type ModelCapability =
  | "text"
  | "image"
  | "video"
  | "audio"
  | "model3d"
  | "analysis"
  | string;

export type AiModelParameters = Record<string, unknown> & {
  capabilities?: ModelCapability[];
};

export type AiModel = {
  id: string;
  name: string;
  provider: string;
  modelId: string;
  level: string;
  endpoint: string;
  iconUrl: string | null;
  enabled: boolean;
  parameters: AiModelParameters;
  hasApiKey: boolean;
  apiKeyMasked: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AiModelInput = {
  name: string;
  provider: string;
  modelId: string;
  level: string;
  endpoint: string;
  iconUrl: string | null;
  enabled: boolean;
  parameters: AiModelParameters;
  apiKey?: string;
  clearApiKey?: boolean;
};

export const ASSET_MEDIA_TYPES = [
  "image",
  "video",
  "audio",
  "model3d",
  "document",
  "other",
] as const;

export type AssetMediaType = (typeof ASSET_MEDIA_TYPES)[number];

export const ASSET_CATEGORIES = [
  "character",
  "costume",
  "prop",
  "scene",
  "environment",
  "vehicle",
  "storyboard",
  "reference",
  "other",
] as const;

export type AssetCategory = (typeof ASSET_CATEGORIES)[number];

export type AssetRelation = {
  id: string;
  targetType: "asset" | "character";
  targetId: string;
  targetName: string;
  targetMediaType: AssetMediaType | null;
  targetCategory: AssetCategory | null;
  relationType: string;
  note: string;
  direction: "outgoing" | "incoming";
};

export type AssetRelationInput = {
  targetType: "asset" | "character";
  targetId: string;
  relationType?: string;
  note?: string;
};

export type ProjectAsset = {
  id: string;
  projectId: string;
  name: string;
  mediaType: AssetMediaType;
  category: AssetCategory;
  description: string | null;
  mimeType?: string | null;
  sizeBytes?: number | null;
  hasContent?: boolean;
  contentUrl?: string | null;
  sourceUrl: string | null;
  thumbnailUrl: string | null;
  status: string;
  metadata: Record<string, unknown> | null;
  relations: AssetRelation[];
  relationsLoaded: boolean;
  createdAt: string;
  updatedAt: string;
};

export type ProjectAssetInput = {
  name: string;
  mediaType: AssetMediaType;
  category: AssetCategory;
  description?: string;
  sourceUrl?: string;
  thumbnailUrl?: string;
  metadata?: Record<string, unknown>;
  status?: string;
  relations?: AssetRelationInput[];
  relatedAssetIds?: string[];
  relatedCharacterIds?: string[];
};

export type Project = {
  id: string;
  name: string;
  genre?: string | null;
  status?: string | null;
  description?: string | null;
  episodeCount?: number | null;
  singleEpisodeDuration?: number | null;
  aspectRatio?: string | null;
  targetPlatform?: string | null;
  coverUrl?: string | null;
  updatedAt?: string;
};

export type ScriptScene = {
  id: string;
  scriptId: string;
  title?: string | null;
  slugline?: string | null;
  content?: string | null;
  sceneNumber?: string | number | null;
  [key: string]: unknown;
};

export type ProjectScript = {
  id: string;
  projectId: string;
  title: string;
  episodeNumber?: number | null;
  status?: string | null;
  content?: string | null;
  scenes: ScriptScene[];
  [key: string]: unknown;
};

export type AgentSourceSelection = {
  includeStory?: boolean;
  includeEpisodes?: boolean;
  characterIds?: string[];
  scriptIds?: string[];
  sceneIds?: string[];
  assetIds?: string[];
};

export type AgentRunSource = {
  id: string;
  sourceType: string;
  sourceId: string;
  title: string;
  snapshot: unknown;
};

export type AgentRunStatus = "queued" | "running" | "completed" | "failed" | string;

export type AgentRun = {
  id: string;
  projectId: string;
  modelId: string;
  modelName: string;
  status: AgentRunStatus;
  prompt: string;
  systemPrompt: string | null;
  response: string | null;
  errorMessage: string | null;
  usage: Record<string, unknown> | null;
  requestMeta: Record<string, unknown> | null;
  sources: AgentRunSource[];
  createdAt: string;
  completedAt: string | null;
};

export type AgentRunInput = {
  modelId: string;
  prompt: string;
  systemPrompt?: string;
  sources?: AgentSourceSelection;
};

export const STAGE_AGENT_STAGES = [
  "story",
  "characters",
  "scripts",
  "breakdown",
  "assets",
  "shots",
] as const;

export type StageAgentStage = (typeof STAGE_AGENT_STAGES)[number];

export const STAGE_AGENT_ACTION_TYPES = [
  "update_story",
  "create_character",
  "create_script",
  "create_scene",
  "create_asset",
  "create_storyboard_asset",
] as const;

export type StageAgentActionType = (typeof STAGE_AGENT_ACTION_TYPES)[number];

export type StageAgentAction = {
  type: StageAgentActionType;
  label: string;
  payload: Record<string, unknown>;
};

export type StageAgentHistoryMessage = {
  role: "user" | "assistant";
  content: string;
};

export type StageAgentActionResult = {
  index: number;
  type: StageAgentActionType;
  status: "completed";
  entityType: "story" | "character" | "script" | "scene" | "asset";
  entityId: string;
  message: string;
  entity: Record<string, unknown> | null;
};

export type AssetGenerationStatus =
  | "submitting"
  | "queued"
  | "running"
  | "succeeded"
  | "failed";

export type AssetGenerationPhase =
  | "queued"
  | "model"
  | "storage"
  | "finalize"
  | "completed"
  | "failed";

export type AssetGenerationJob = {
  id: string;
  projectId: string;
  clientRequestId: string;
  modelId: string | null;
  modelName: string;
  name: string;
  category: AssetCategory;
  prompt: string;
  size: string | null;
  aspectRatio: string | null;
  relations: AssetRelationInput[];
  status: AssetGenerationStatus;
  phase: AssetGenerationPhase;
  progress: number;
  attemptCount: number;
  errorCode: string | null;
  errorMessage: string | null;
  retryable: boolean;
  assetId: string | null;
  canRun: boolean;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  dismissedAt?: string | null;
};

export type StageAgentPlanResponse = {
  run: AgentRun;
  reply: string;
  actions: StageAgentAction[];
};

export type StageAgentExecuteResponse = {
  message: string;
  actions: StageAgentAction[];
  results: StageAgentActionResult[];
};

export type WorkspaceBootstrap = {
  workspace: {
    userId: string;
    email: string;
    displayName: string;
    activeProjectId: string | null;
  };
  projects: Project[];
  activeProjectId: string | null;
  project: Project | null;
  story: unknown;
  episodes: unknown[];
  characters: Array<{ id: string; name?: string; [key: string]: unknown }>;
  scripts: ProjectScript[];
  assets: ProjectAsset[];
  models: AiModel[];
  agentRuns: AgentRun[];
};
