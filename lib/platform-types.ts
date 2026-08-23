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
