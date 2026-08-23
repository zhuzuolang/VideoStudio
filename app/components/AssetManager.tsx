"use client";

/* eslint-disable @next/next/no-img-element -- project assets use authenticated and user-provided URLs. */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LucideIcon } from "lucide-react";
import {
  AlertCircle,
  Box,
  CheckCircle2,
  FileText,
  Image as ImageIcon,
  Link2,
  LoaderCircle,
  MapPin,
  Music2,
  Package,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Shirt,
  Sparkles,
  Trash2,
  Upload,
  UserRound,
  Video,
  WandSparkles,
  X,
} from "lucide-react";
import {
  ASSET_CATEGORIES,
  ASSET_MEDIA_TYPES,
  type AiModel,
  type AssetGenerationJob,
  type AssetCategory,
  type AssetMediaType,
  type AssetRelationInput,
  type ProjectAsset,
  type ProjectAssetInput,
} from "@/lib/platform-types";
import {
  apiRequest,
  PlatformApiError,
  getModelCapabilities,
  formatCompactDate,
  joinClassNames,
} from "./platform-client";
import styles from "./PlatformModules.module.css";

type AssetManagerProps = {
  projectId: string;
  projectName?: string;
  className?: string;
  refreshKey?: number;
  onAssetsChange?: (assets: ProjectAsset[]) => void;
};
type CharacterOption = { id: string; name: string };
type SourceMode = "file" | "url";
type DialogMode = "asset" | "generate" | null;
type AssetForm = {
  name: string;
  mediaType: AssetMediaType;
  category: AssetCategory;
  description: string;
  sourceUrl: string;
  thumbnailUrl: string;
  relatedAssetIds: string[];
  relatedCharacterIds: string[];
};
type GenerateForm = {
  modelId: string;
  name: string;
  category: AssetCategory;
  prompt: string;
  aspectRatio: string;
  size: string;
  relatedAssetIds: string[];
  relatedCharacterIds: string[];
};

const MEDIA_META: Record<AssetMediaType, { label: string; icon: LucideIcon }> =
  {
    image: { label: "图片", icon: ImageIcon },
    video: { label: "视频", icon: Video },
    audio: { label: "音频", icon: Music2 },
    model3d: { label: "3D", icon: Box },
    document: { label: "文档", icon: FileText },
    other: { label: "其他", icon: Package },
  };
const CATEGORY_META: Record<
  AssetCategory,
  { label: string; icon: LucideIcon }
> = {
  character: { label: "人物", icon: UserRound },
  costume: { label: "服装", icon: Shirt },
  prop: { label: "道具", icon: Package },
  scene: { label: "场景", icon: MapPin },
  environment: { label: "环境", icon: MapPin },
  vehicle: { label: "载具", icon: Package },
  storyboard: { label: "故事板", icon: FileText },
  reference: { label: "参考", icon: ImageIcon },
  other: { label: "其他", icon: Package },
};
const EMPTY_ASSET: AssetForm = {
  name: "",
  mediaType: "image",
  category: "reference",
  description: "",
  sourceUrl: "",
  thumbnailUrl: "",
  relatedAssetIds: [],
  relatedCharacterIds: [],
};
const EMPTY_GENERATE: GenerateForm = {
  modelId: "",
  name: "",
  category: "character",
  prompt: "",
  aspectRatio: "1:1",
  size: "",
  relatedAssetIds: [],
  relatedCharacterIds: [],
};

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}
function relationInputs(
  form: Pick<AssetForm, "relatedAssetIds" | "relatedCharacterIds">,
): AssetRelationInput[] {
  return [
    ...form.relatedAssetIds.map((targetId) => ({
      targetType: "asset" as const,
      targetId,
    })),
    ...form.relatedCharacterIds.map((targetId) => ({
      targetType: "character" as const,
      targetId,
    })),
  ];
}
function isImageModel(model: AiModel): boolean {
  const capabilities = getModelCapabilities(model).map((value) =>
    value.trim().toLowerCase(),
  );
  return (
    model.enabled &&
    model.hasApiKey &&
    (capabilities.some((value) =>
      [
        "image-generation",
        "image_generation",
        "text-to-image",
        "图片生成",
        "图像生成",
      ].includes(value),
    ) ||
      /seedream|dall-e|image[-_ ]?(?:gen|generation)|text[-_ ]?to[-_ ]?image|图片生成|图像生成/i.test(
        `${model.name} ${model.modelId}`,
      ))
  );
}

function isDefinitiveGenerationSubmissionFailure(reason: unknown): boolean {
  return reason instanceof PlatformApiError && new Set([
    "VALIDATION_ERROR",
    "INVALID_JSON",
    "INVALID_BODY",
    "INVALID_GENERATION_REQUEST",
    "INVALID_IDEMPOTENCY_KEY",
    "INVALID_ASSET_CATEGORY",
    "INVALID_ASSET_RELATION",
    "INVALID_ASSET_RELATIONS",
    "AUTH_REQUIRED",
    "PROJECT_NOT_FOUND",
    "MODEL_NOT_FOUND",
    "MODEL_DISABLED",
    "MODEL_API_KEY_MISSING",
    "MODEL_IMAGE_UNSUPPORTED",
    "GENERATION_REQUEST_ALREADY_USED",
  ]).has(reason.code);
}

function AssetPreview({ asset }: { asset: ProjectAsset }) {
  const Icon = MEDIA_META[asset.mediaType]?.icon ?? Package;
  const imageSource =
    asset.mediaType === "image"
      ? asset.contentUrl || asset.thumbnailUrl || asset.sourceUrl
      : asset.thumbnailUrl;
  return (
    <div className={styles.assetPreview}>
      <Icon size={30} aria-hidden="true" />
      {imageSource && (
        <img
          key={imageSource}
          src={imageSource}
          alt={`${asset.name}预览`}
          onError={(event) => {
            event.currentTarget.style.display = "none";
          }}
        />
      )}
      <span className={styles.typeBadge}>
        <Icon size={11} /> {MEDIA_META[asset.mediaType].label}
      </span>
    </div>
  );
}

const GENERATION_PHASE_LABEL: Record<AssetGenerationJob["phase"], string> = {
  queued: "等待生成服务",
  model: "模型正在生成图片",
  storage: "正在写入媒体存储",
  finalize: "正在建立资产记录",
  completed: "图片已生成并入库",
  failed: "生成流程已停止",
};

function generationStatusLabel(status: AssetGenerationJob["status"]): string {
  if (status === "submitting") return "正在创建任务";
  if (status === "queued") return "排队中";
  if (status === "running") return "生成中";
  if (status === "succeeded") return "生成成功";
  return "生成失败";
}

function assetStatusLabel(asset: ProjectAsset): string {
  if (asset.status === "ready" && asset.metadata?.source === "ai-generation") return "生成成功";
  if (asset.status === "ready") return "已就绪";
  if (asset.status === "planned") return "规划中";
  return asset.status;
}

function GenerationCard({
  generation,
  processing,
  onRetry,
  onDismiss,
}: {
  generation: AssetGenerationJob;
  processing: boolean;
  onRetry: (generation: AssetGenerationJob) => void;
  onDismiss: (generation: AssetGenerationJob) => void;
}) {
  const failed = generation.status === "failed";
  const active = generation.status === "submitting" || generation.status === "queued" || generation.status === "running";
  const submissionUnconfirmed = generation.status === "submitting"
    && generation.errorCode === "GENERATION_SUBMISSION_UNCONFIRMED";
  return (
    <article
      className={joinClassNames(styles.assetCard, styles.generationCard, failed && styles.generationCardFailed)}
    >
      <div className={styles.generationPreview}>
        {failed ? <AlertCircle size={30} /> : active ? <LoaderCircle className={styles.spinner} size={30} /> : <CheckCircle2 size={30} />}
        <span className={styles.typeBadge}><ImageIcon size={11} /> AI 图片</span>
      </div>
      <div className={styles.assetBody}>
        <h3>{generation.name}</h3>
        <div className={styles.assetDimensions}>
          <span className={styles.sourceBadge}>图片</span>
          <span className={styles.levelBadge}>{CATEGORY_META[generation.category].label}</span>
        </div>
        <p>{generation.prompt}</p>
        <div className={styles.generationStatusRow}>
          <span role={failed ? undefined : "status"} aria-live={failed ? undefined : "polite"} className={joinClassNames(
            styles.statusBadge,
            active && styles.statusBadgeWarning,
            failed && styles.statusBadgeError,
          )}>
            {generationStatusLabel(generation.status)}
          </span>
          <span>{GENERATION_PHASE_LABEL[generation.phase]}</span>
        </div>
        <div
          className={styles.generationProgress}
          role="progressbar"
          aria-label="生成流程进度"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={generation.progress}
        >
          <div><i style={{ width: `${generation.progress}%` }} /></div>
          <span>{generation.progress}%</span>
        </div>
        {active && generation.errorMessage && (
          <div className={styles.generationPendingNote} role="status">
            {generation.errorMessage}
          </div>
        )}
        {failed && generation.errorMessage && (
          <div className={styles.generationError} role="alert">
            <b>{generation.errorMessage}</b>
            {generation.errorCode && <code>{generation.errorCode}</code>}
          </div>
        )}
        <div className={styles.assetFoot}>
          <time>{formatCompactDate(generation.updatedAt || generation.createdAt)}</time>
          {failed || submissionUnconfirmed ? (
            <div className={styles.generationActions}>
              {(generation.retryable || submissionUnconfirmed) && (
                <button
                  type="button"
                  className={styles.textButton}
                  onClick={() => onRetry(generation)}
                  disabled={processing}
                >
                  {processing ? <LoaderCircle className={styles.spinner} size={12} /> : <RefreshCw size={12} />}
                  {submissionUnconfirmed ? "重新确认任务" : "重试生成"}
                </button>
              )}
              <button type="button" className={styles.textButton} onClick={() => onDismiss(generation)} disabled={processing}>
                <X size={12} /> 移除记录
              </button>
            </div>
          ) : (
            <small>第 {Math.max(1, generation.attemptCount)} 次尝试</small>
          )}
        </div>
      </div>
    </article>
  );
}

type RelationFieldsProps = {
  characters: CharacterOption[];
  assets: ProjectAsset[];
  value: Pick<AssetForm, "relatedAssetIds" | "relatedCharacterIds">;
  onToggle: (
    kind: "asset" | "character",
    targetId: string,
    checked: boolean,
  ) => void;
};

function RelationFields({
  characters,
  assets,
  value,
  onToggle,
}: RelationFieldsProps) {
  return (
    <fieldset className={styles.fieldset}>
      <legend>关联人物与资产</legend>
      <div className={styles.relationPicker}>
        <div>
          <b>人物</b>
          {characters.length ? (
            characters.map((character) => (
              <label className={styles.checkboxLine} key={character.id}>
                <input
                  type="checkbox"
                  checked={value.relatedCharacterIds.includes(character.id)}
                  onChange={(event) =>
                    onToggle("character", character.id, event.target.checked)
                  }
                />
                <span>{character.name}</span>
              </label>
            ))
          ) : (
            <small>当前项目暂无人物</small>
          )}
        </div>
        <div>
          <b>已有资产</b>
          {assets.length ? (
            assets.map((asset) => (
              <label className={styles.checkboxLine} key={asset.id}>
                <input
                  type="checkbox"
                  checked={value.relatedAssetIds.includes(asset.id)}
                  onChange={(event) =>
                    onToggle("asset", asset.id, event.target.checked)
                  }
                />
                <span>{asset.name}</span>
              </label>
            ))
          ) : (
            <small>暂无其他资产</small>
          )}
        </div>
      </div>
    </fieldset>
  );
}

export default function AssetManager({
  projectId,
  projectName,
  className,
  refreshKey,
  onAssetsChange,
}: AssetManagerProps) {
  const [assets, setAssets] = useState<ProjectAsset[]>([]);
  const [generations, setGenerations] = useState<AssetGenerationJob[]>([]);
  const [characters, setCharacters] = useState<CharacterOption[]>([]);
  const [models, setModels] = useState<AiModel[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [formError, setFormError] = useState("");
  const [characterLoadError, setCharacterLoadError] = useState("");
  const [modelLoadError, setModelLoadError] = useState("");
  const [generationLoadError, setGenerationLoadError] = useState("");
  const [search, setSearch] = useState("");
  const [mediaFilter, setMediaFilter] = useState<"all" | AssetMediaType>("all");
  const [categoryFilter, setCategoryFilter] = useState<"all" | AssetCategory>(
    "all",
  );
  const [dialog, setDialog] = useState<DialogMode>(null);
  const [editing, setEditing] = useState<ProjectAsset | null>(null);
  const [sourceMode, setSourceMode] = useState<SourceMode>("file");
  const [form, setForm] = useState<AssetForm>(EMPTY_ASSET);
  const [generateForm, setGenerateForm] =
    useState<GenerateForm>(EMPTY_GENERATE);
  const [file, setFile] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);
  const [deletingIds, setDeletingIds] = useState<Set<string>>(() => new Set());
  const [dirty, setDirty] = useState(false);
  const requestSequence = useRef(0);
  const generationRequestSequence = useRef(0);
  const characterRequestSequence = useRef(0);
  const modelRequestSequence = useRef(0);
  const previousRefreshKey = useRef(refreshKey);
  const activeProjectRef = useRef(projectId);
  const processingGenerationIds = useRef<Set<string>>(new Set());
  const dismissingGenerationIds = useRef<Set<string>>(new Set());
  const nameInputRef = useRef<HTMLInputElement>(null);
  const onAssetsChangeRef = useRef(onAssetsChange);
  useEffect(() => {
    onAssetsChangeRef.current = onAssetsChange;
  }, [onAssetsChange]);
  useEffect(() => {
    activeProjectRef.current = projectId;
  }, [projectId]);

  const loadCharacters = useCallback(async () => {
    const sequence = ++characterRequestSequence.current;
    if (!projectId) {
      setCharacters([]);
      setCharacterLoadError("");
      return;
    }
    setCharacterLoadError("");
    try {
      const data = await apiRequest<
        CharacterOption[] | { characters: CharacterOption[] }
      >(`/api/projects/${encodeURIComponent(projectId)}/characters`, {
        cache: "no-store",
      });
      if (sequence !== characterRequestSequence.current) return;
      setCharacters(Array.isArray(data) ? data : (data.characters ?? []));
    } catch (reason) {
      if (sequence !== characterRequestSequence.current) return;
      setCharacters([]);
      setCharacterLoadError(
        reason instanceof Error ? reason.message : "人物关联选项加载失败。",
      );
    }
  }, [projectId]);

  const loadModels = useCallback(async () => {
    const sequence = ++modelRequestSequence.current;
    if (!projectId) {
      setModels([]);
      setModelLoadError("");
      return;
    }
    setModelLoadError("");
    try {
      const data = await apiRequest<AiModel[] | { models: AiModel[] }>(
        "/api/models",
        { cache: "no-store" },
      );
      if (sequence !== modelRequestSequence.current) return;
      setModels(Array.isArray(data) ? data : (data.models ?? []));
    } catch (reason) {
      if (sequence !== modelRequestSequence.current) return;
      setModels([]);
      setModelLoadError(
        reason instanceof Error ? reason.message : "图像模型选项加载失败。",
      );
    }
  }, [projectId]);

  const loadAssets = useCallback(async (silent = false) => {
    const sequence = ++requestSequence.current;
    if (!projectId) {
      setAssets([]);
      setLoading(false);
      return;
    }
    if (!silent) setLoading(true);
    if (!silent) setError("");
    try {
      const assetData = await apiRequest<
        ProjectAsset[] | { assets: ProjectAsset[] }
      >(`/api/projects/${encodeURIComponent(projectId)}/assets`, {
        cache: "no-store",
      });
      if (sequence !== requestSequence.current) return;
      const nextAssets = Array.isArray(assetData)
        ? assetData
        : (assetData.assets ?? []);
      setAssets(nextAssets);
      onAssetsChangeRef.current?.(nextAssets);
    } catch (reason) {
      if (sequence === requestSequence.current) {
        setError(
          reason instanceof Error ? reason.message : "资产加载失败，请重试。",
        );
      }
    } finally {
      if (!silent && sequence === requestSequence.current) setLoading(false);
    }
  }, [projectId]);

  const loadGenerations = useCallback(async (silent = false) => {
    const sequence = ++generationRequestSequence.current;
    if (!projectId) {
      setGenerations([]);
      setGenerationLoadError("");
      return;
    }
    if (!silent) setGenerationLoadError("");
    try {
      const data = await apiRequest<{ generations: AssetGenerationJob[] }>(
        `/api/projects/${encodeURIComponent(projectId)}/assets/generate`,
        { cache: "no-store" },
      );
      if (sequence !== generationRequestSequence.current || activeProjectRef.current !== projectId) return;
      const serverGenerations = (data.generations ?? []).filter(
        (generation) => !dismissingGenerationIds.current.has(generation.id),
      );
      setGenerations((current) => {
        const confirmedRequestIds = new Set(serverGenerations.map((generation) => generation.clientRequestId));
        const localPending = current.filter((generation) =>
          generation.id.startsWith("local:") && !confirmedRequestIds.has(generation.clientRequestId),
        );
        return [...localPending, ...serverGenerations];
      });
      setGenerationLoadError("");
    } catch (reason) {
      if (sequence !== generationRequestSequence.current || activeProjectRef.current !== projectId) return;
      setGenerationLoadError(reason instanceof Error ? reason.message : "生成任务状态加载失败。");
    }
  }, [projectId]);

  const runGeneration = useCallback(async (generationId: string, retry = false) => {
    const requestId = `${projectId}:${generationId}`;
    if (processingGenerationIds.current.has(requestId)) return;
    processingGenerationIds.current.add(requestId);
    if (activeProjectRef.current === projectId) {
      setGenerations((current) => current.map((generation) => generation.id === generationId
        ? { ...generation, status: "running", phase: "model", progress: Math.max(15, generation.progress), errorCode: null, errorMessage: null, canRun: false }
        : generation));
    }
    try {
      await apiRequest(`/api/projects/${encodeURIComponent(projectId)}/assets/generate/${encodeURIComponent(generationId)}`, {
        method: "POST",
        body: JSON.stringify({ retry }),
      });
    } catch {
      // The runner persists its safe error on the job. Refreshing below makes the card
      // authoritative even when the long-running HTTP response itself was interrupted.
    } finally {
      processingGenerationIds.current.delete(requestId);
      if (activeProjectRef.current === projectId) {
        await Promise.all([loadGenerations(true), loadAssets(true)]);
      }
    }
  }, [loadAssets, loadGenerations, projectId]);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setSearch("");
      setMediaFilter("all");
      setCategoryFilter("all");
      setDialog(null);
      setCharacters([]);
      setModels([]);
      setGenerations([]);
      setGenerationLoadError("");
      processingGenerationIds.current.clear();
      dismissingGenerationIds.current.clear();
      void loadCharacters();
      void loadModels();
      void loadAssets();
      void loadGenerations();
    }, 0);
    return () => clearTimeout(timer);
  }, [loadAssets, loadCharacters, loadGenerations, loadModels]);
  useEffect(() => {
    if (Object.is(previousRefreshKey.current, refreshKey)) return;
    previousRefreshKey.current = refreshKey;
    const timer = window.setTimeout(() => {
      void loadCharacters();
      void loadModels();
      void loadAssets();
      void loadGenerations();
    }, 0);
    return () => clearTimeout(timer);
  }, [loadAssets, loadCharacters, loadGenerations, loadModels, refreshKey]);
  useEffect(() => {
    for (const generation of generations) {
      if (generation.canRun && (generation.status === "queued" || generation.status === "running")) {
        void runGeneration(generation.id);
      }
    }
  }, [generations, runGeneration]);
  const hasActiveGenerations = generations.some((generation) =>
    generation.status === "submitting" || generation.status === "queued" || generation.status === "running",
  );
  useEffect(() => {
    if (!hasActiveGenerations || !projectId) return;
    let stopped = false;
    let timer: number | undefined;
    const poll = async () => {
      await Promise.all([loadGenerations(true), loadAssets(true)]);
      if (!stopped) timer = window.setTimeout(poll, document.hidden ? 6_000 : 2_500);
    };
    timer = window.setTimeout(poll, 1_200);
    return () => {
      stopped = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [hasActiveGenerations, loadAssets, loadGenerations, projectId]);
  useEffect(() => {
    if (!success) return;
    const timer = window.setTimeout(() => setSuccess(""), 3200);
    return () => clearTimeout(timer);
  }, [success]);
  useEffect(() => {
    if (!dialog) return;
    const timer = window.setTimeout(() => nameInputRef.current?.focus(), 0);
    return () => clearTimeout(timer);
  }, [dialog]);
  useEffect(() => {
    if (!dialog) return;
    const listener = (event: KeyboardEvent) => {
      if (
        event.key === "Escape" &&
        !saving &&
        (!dirty || window.confirm("当前修改尚未保存，确定关闭吗？"))
      )
        setDialog(null);
    };
    addEventListener("keydown", listener);
    return () => removeEventListener("keydown", listener);
  }, [dialog, dirty, saving]);

  const eligibleModels = useMemo(() => models.filter(isImageModel), [models]);
  const visibleAssets = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return assets.filter(
      (asset) =>
        (mediaFilter === "all" || asset.mediaType === mediaFilter) &&
        (categoryFilter === "all" || asset.category === categoryFilter) &&
        (!needle ||
          `${asset.name} ${asset.description ?? ""} ${MEDIA_META[asset.mediaType].label} ${CATEGORY_META[asset.category].label}`
            .toLowerCase()
            .includes(needle)),
    );
  }, [assets, mediaFilter, categoryFilter, search]);
  const generationCards = useMemo(() => {
    const candidates = generations.filter((generation) => !(
      generation.status === "succeeded"
      && generation.assetId
      && assets.some((asset) => asset.id === generation.assetId)
    ));
    const active = candidates.filter((generation) =>
      generation.status === "submitting" || generation.status === "queued" || generation.status === "running",
    );
    const history = candidates.filter((generation) => !active.includes(generation)).slice(0, 12);
    return [...active, ...history];
  }, [assets, generations]);
  const selectableAssets = (currentId?: string) =>
    assets.filter((asset) => asset.id !== currentId);

  function openCreate() {
    setEditing(null);
    setForm(EMPTY_ASSET);
    setFile(null);
    setSourceMode("file");
    setFormError("");
    setDirty(false);
    setDialog("asset");
  }
  function openEdit(asset: ProjectAsset) {
    setEditing(asset);
    setSourceMode("url");
    setFile(null);
    setForm({
      name: asset.name,
      mediaType: asset.mediaType,
      category: asset.category,
      description: asset.description ?? "",
      sourceUrl: asset.sourceUrl ?? "",
      thumbnailUrl: asset.thumbnailUrl ?? "",
      relatedAssetIds: asset.relations
        .filter((r) => r.direction === "outgoing" && r.targetType === "asset")
        .map((r) => r.targetId),
      relatedCharacterIds: asset.relations
        .filter(
          (r) => r.direction === "outgoing" && r.targetType === "character",
        )
        .map((r) => r.targetId),
    });
    setFormError("");
    setDirty(false);
    setDialog("asset");
  }
  function openGenerate() {
    setGenerateForm({
      ...EMPTY_GENERATE,
      modelId: eligibleModels[0]?.id ?? "",
    });
    setFormError("");
    setDirty(false);
    setDialog("generate");
  }
  function closeDialog() {
    if (saving || (dirty && !window.confirm("当前修改尚未保存，确定关闭吗？")))
      return;
    setDialog(null);
  }
  function updateForm<K extends keyof AssetForm>(key: K, value: AssetForm[K]) {
    setForm((current) => ({ ...current, [key]: value }));
    setDirty(true);
    setFormError("");
  }
  function updateGenerate<K extends keyof GenerateForm>(
    key: K,
    value: GenerateForm[K],
  ) {
    setGenerateForm((current) => ({ ...current, [key]: value }));
    setDirty(true);
    setFormError("");
  }
  function selectFile(nextFile: File | null) {
    setFile(nextFile);
    setDirty(true);
    setFormError(
      nextFile && nextFile.size > 100 * 1024 * 1024
        ? "单个文件不能超过 100 MB。"
        : "",
    );
    if (nextFile && !form.name.trim())
      setForm((current) => ({
        ...current,
        name: nextFile.name.replace(/\.[^.]+$/, ""),
      }));
  }
  function toggleRelation(
    kind: "asset" | "character",
    targetId: string,
    checked: boolean,
    generation = false,
  ) {
    const key = kind === "asset" ? "relatedAssetIds" : "relatedCharacterIds";
    if (generation)
      setGenerateForm((current) => ({
        ...current,
        [key]: checked
          ? [...current[key], targetId]
          : current[key].filter((id) => id !== targetId),
      }));
    else
      setForm((current) => ({
        ...current,
        [key]: checked
          ? [...current[key], targetId]
          : current[key].filter((id) => id !== targetId),
      }));
    setDirty(true);
  }

  async function saveAsset(event: React.FormEvent) {
    event.preventDefault();
    if (!form.name.trim()) return setFormError("请输入资产名称。");
    if (!editing && sourceMode === "file" && !file)
      return setFormError("请选择要上传的文件。");
    if (
      !editing &&
      sourceMode === "file" &&
      file &&
      file.size > 100 * 1024 * 1024
    )
      return setFormError("单个文件不能超过 100 MB。");
    if (!editing && sourceMode === "url" && !isHttpUrl(form.sourceUrl.trim()))
      return setFormError("请输入有效的 HTTPS 外部地址。");
    if (form.thumbnailUrl.trim() && !isHttpUrl(form.thumbnailUrl.trim()))
      return setFormError("缩略图地址必须是有效的 HTTPS 地址。");
    setSaving(true);
    setFormError("");
    try {
      const endpoint = `/api/projects/${encodeURIComponent(projectId)}/assets`;
      const relations = relationInputs(form);
      if (editing) {
        const body = {
          name: form.name.trim(),
          mediaType: form.mediaType,
          category: form.category,
          description: form.description.trim(),
          sourceUrl: form.sourceUrl.trim() || null,
          thumbnailUrl: form.thumbnailUrl.trim() || null,
          relations,
        };
        await apiRequest(`${endpoint}/${encodeURIComponent(editing.id)}`, {
          method: "PATCH",
          body: JSON.stringify(body),
        });
      } else if (sourceMode === "file" && file) {
        const body = new FormData();
        body.set("file", file);
        body.set("name", form.name.trim());
        body.set("mediaType", form.mediaType);
        body.set("category", form.category);
        body.set("description", form.description.trim());
        body.set("relations", JSON.stringify(relations));
        await apiRequest(endpoint, { method: "POST", body });
      } else {
        const body: ProjectAssetInput = {
          name: form.name.trim(),
          mediaType: form.mediaType,
          category: form.category,
          description: form.description.trim(),
          sourceUrl: form.sourceUrl.trim(),
          thumbnailUrl: form.thumbnailUrl.trim() || undefined,
          status: "ready",
          relations,
        };
        await apiRequest(endpoint, {
          method: "POST",
          body: JSON.stringify(body),
        });
      }
      setDialog(null);
      setSuccess(`资产“${form.name.trim()}”已保存。`);
      await loadAssets();
    } catch (reason) {
      setFormError(reason instanceof Error ? reason.message : "资产保存失败。");
    } finally {
      setSaving(false);
    }
  }
  async function generateAsset(event: React.FormEvent) {
    event.preventDefault();
    if (!generateForm.modelId) return setFormError("请选择已配置的图像模型。");
    if (!generateForm.name.trim() || !generateForm.prompt.trim())
      return setFormError("请填写资产名称与提示词。");
    const snapshot = {
      ...generateForm,
      name: generateForm.name.trim(),
      prompt: generateForm.prompt.trim(),
      size: generateForm.size.trim(),
    };
    const clientRequestId = crypto.randomUUID();
    const submissionProjectId = projectId;
    const now = new Date().toISOString();
    const optimistic: AssetGenerationJob = {
      id: `local:${clientRequestId}`,
      projectId,
      clientRequestId,
      modelId: snapshot.modelId,
      modelName: eligibleModels.find((model) => model.id === snapshot.modelId)?.name ?? "图像模型",
      name: snapshot.name,
      category: snapshot.category,
      prompt: snapshot.prompt,
      size: snapshot.size || null,
      aspectRatio: snapshot.aspectRatio || null,
      relations: relationInputs(snapshot),
      status: "submitting",
      phase: "queued",
      progress: 0,
      attemptCount: 0,
      errorCode: null,
      errorMessage: null,
      retryable: true,
      assetId: null,
      canRun: false,
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      completedAt: null,
    };
    setGenerations((current) => [optimistic, ...current]);
    setDialog(null);
    setDirty(false);
    setMediaFilter("all");
    setCategoryFilter("all");
    setSaving(true);
    setFormError("");
    const enqueue = () => apiRequest<{ generation: AssetGenerationJob }>(
      `/api/projects/${encodeURIComponent(submissionProjectId)}/assets/generate`,
      {
        method: "POST",
        headers: { "Idempotency-Key": clientRequestId },
        body: JSON.stringify({
          ...snapshot,
          clientRequestId,
          size: snapshot.size || undefined,
          relations: relationInputs(snapshot),
        }),
      },
    );
    try {
      let data: { generation: AssetGenerationJob };
      try {
        data = await enqueue();
      } catch (firstReason) {
        const definitive = isDefinitiveGenerationSubmissionFailure(firstReason);
        if (definitive) throw firstReason;
        // A response can be lost after D1 committed the job. Retrying with the same key
        // is safe and recovers the already-created task instead of creating a duplicate.
        data = await enqueue();
      }
      if (activeProjectRef.current === submissionProjectId) {
        setGenerations((current) => [
          data.generation,
          ...current.filter((generation) => generation.clientRequestId !== clientRequestId),
        ]);
        setSuccess(`AI 资产“${snapshot.name}”已进入生成队列。`);
      }
      void runGeneration(data.generation.id);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "无法创建 AI 资产生成任务。";
      const code = reason instanceof PlatformApiError ? reason.code : "GENERATION_JOB_CREATE_FAILED";
      const definitive = isDefinitiveGenerationSubmissionFailure(reason);
      if (activeProjectRef.current === submissionProjectId) {
        setGenerations((current) => current.map((generation) => generation.clientRequestId === clientRequestId
          ? definitive
            ? { ...generation, status: "failed", phase: "failed", errorCode: code, errorMessage: message,
                retryable: false, updatedAt: new Date().toISOString() }
            : { ...generation, status: "submitting", phase: "queued", errorCode: "GENERATION_SUBMISSION_UNCONFIRMED",
                errorMessage: "网络中断，正在用同一请求标识确认任务是否已创建。请勿重复提交。",
                retryable: true, updatedAt: new Date().toISOString() }
          : generation));
      }
    } finally {
      setSaving(false);
    }
  }

  async function confirmUncertainGeneration(generation: AssetGenerationJob) {
    if (!generation.id.startsWith("local:") || !generation.modelId) return;
    const submissionProjectId = generation.projectId;
    setGenerations((current) => current.map((item) => item.id === generation.id
      ? { ...item, errorMessage: "正在使用原请求标识确认任务，请稍候。", updatedAt: new Date().toISOString() }
      : item));
    try {
      const data = await apiRequest<{ generation: AssetGenerationJob }>(
        `/api/projects/${encodeURIComponent(submissionProjectId)}/assets/generate`,
        {
          method: "POST",
          headers: { "Idempotency-Key": generation.clientRequestId },
          body: JSON.stringify({
            clientRequestId: generation.clientRequestId,
            modelId: generation.modelId,
            name: generation.name,
            category: generation.category,
            prompt: generation.prompt,
            size: generation.size || undefined,
            aspectRatio: generation.aspectRatio || undefined,
            relations: generation.relations,
          }),
        },
      );
      if (activeProjectRef.current !== submissionProjectId) return;
      setGenerations((current) => [
        data.generation,
        ...current.filter((item) => item.clientRequestId !== generation.clientRequestId),
      ]);
      void runGeneration(data.generation.id);
    } catch (reason) {
      const definitive = isDefinitiveGenerationSubmissionFailure(reason);
      if (activeProjectRef.current !== submissionProjectId) return;
      setGenerations((current) => current.map((item) => item.id === generation.id
        ? definitive
          ? { ...item, status: "failed", phase: "failed", retryable: false,
              errorCode: reason instanceof PlatformApiError ? reason.code : "GENERATION_JOB_CREATE_FAILED",
              errorMessage: reason instanceof Error ? reason.message : "无法确认图片生成任务。",
              updatedAt: new Date().toISOString() }
          : { ...item, errorMessage: "仍未收到服务器确认；可以再次安全确认，或移除这条本地记录。",
              updatedAt: new Date().toISOString() }
        : item));
    }
  }
  function retryGeneration(generation: AssetGenerationJob) {
    if (generation.id.startsWith("local:")) {
      void confirmUncertainGeneration(generation);
      return;
    }
    if (!generation.retryable) return;
    void runGeneration(generation.id, true);
  }
  async function dismissGeneration(generation: AssetGenerationJob) {
    generationRequestSequence.current += 1;
    dismissingGenerationIds.current.add(generation.id);
    setGenerations((current) => current.filter((item) => item.id !== generation.id));
    if (generation.id.startsWith("local:")) {
      dismissingGenerationIds.current.delete(generation.id);
      return;
    }
    try {
      await apiRequest(
        `/api/projects/${encodeURIComponent(projectId)}/assets/generate/${encodeURIComponent(generation.id)}`,
        { method: "DELETE" },
      );
      await loadGenerations(true);
      dismissingGenerationIds.current.delete(generation.id);
    } catch (reason) {
      dismissingGenerationIds.current.delete(generation.id);
      setError(reason instanceof Error ? reason.message : "生成任务记录移除失败。");
      await loadGenerations(true);
    }
  }
  async function deleteAsset(asset: ProjectAsset) {
    if (!confirm(`确定删除资产“${asset.name}”吗？`)) return;
    setDeletingIds((current) => new Set(current).add(asset.id));
    try {
      await apiRequest(
        `/api/projects/${encodeURIComponent(projectId)}/assets/${encodeURIComponent(asset.id)}`,
        { method: "DELETE" },
      );
      await loadAssets();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "资产删除失败。");
    } finally {
      setDeletingIds((current) => {
        const next = new Set(current);
        next.delete(asset.id);
        return next;
      });
    }
  }

  return (
    <section
      className={joinClassNames(
        styles.moduleRoot,
        styles.moduleStack,
        className,
      )}
      aria-labelledby="asset-manager-title"
    >
      <div className={styles.toolbar}>
        <div className={styles.headingBlock}>
          <span className={styles.eyebrow}>PROJECT ASSET LIBRARY</span>
          <h2 id="asset-manager-title">
            项目资产库{projectName ? ` · ${projectName}` : ""}
          </h2>
          <p>
            先按介质属性管理文件，再按人物、服装、道具、场景等制作分类组织生产资产。
          </p>
        </div>
        <div className={styles.assetHeaderActions}>
          <button
            className={styles.secondaryButton}
            type="button"
            onClick={openGenerate}
            disabled={!projectId}
          >
            <WandSparkles size={15} /> AI 创建资产
          </button>
          <button
            className={styles.primaryButton}
            type="button"
            onClick={openCreate}
            disabled={!projectId}
          >
            <Plus size={15} /> 新增资产
          </button>
        </div>
      </div>
      {error && (
        <div
          className={joinClassNames(styles.notice, styles.noticeError)}
          role="alert"
        >
          <AlertCircle size={16} />
          <span>{error}</span>
          <button
            className={styles.textButton}
            type="button"
            onClick={() => void loadAssets()}
          >
            <RefreshCw size={13} /> 重试资产列表
          </button>
        </div>
      )}
      {characterLoadError && (
        <div
          className={joinClassNames(styles.notice, styles.noticeError)}
          role="alert"
        >
          <AlertCircle size={16} />
          <span>人物关联选项加载失败：{characterLoadError}</span>
          <button
            className={styles.textButton}
            type="button"
            onClick={() => void loadCharacters()}
          >
            <RefreshCw size={13} /> 重试人物选项
          </button>
        </div>
      )}
      {modelLoadError && (
        <div
          className={joinClassNames(styles.notice, styles.noticeError)}
          role="alert"
        >
          <AlertCircle size={16} />
          <span>图像模型选项加载失败：{modelLoadError}</span>
          <button
            className={styles.textButton}
            type="button"
            onClick={() => void loadModels()}
          >
            <RefreshCw size={13} /> 重试模型选项
          </button>
        </div>
      )}
      {generationLoadError && (
        <div
          className={joinClassNames(styles.notice, styles.noticeError)}
          role="alert"
        >
          <AlertCircle size={16} />
          <span>生成任务状态暂时无法更新：{generationLoadError}</span>
          <button
            className={styles.textButton}
            type="button"
            onClick={() => void loadGenerations()}
          >
            <RefreshCw size={13} /> 重试状态同步
          </button>
        </div>
      )}
      {success && (
        <div
          className={joinClassNames(styles.notice, styles.noticeSuccess)}
          role="status"
        >
          <CheckCircle2 size={16} />
          {success}
        </div>
      )}
      {loading ? (
        <div className={styles.stateBox}>
          <div>
            <LoaderCircle className={styles.spinner} size={25} />
            <h3>正在加载项目资产</h3>
            <p>正在读取介质、制作分类与项目关系。</p>
          </div>
        </div>
      ) : (
        <>
          {generationCards.length > 0 && (
            <section className={styles.generationQueue} aria-labelledby="asset-generation-queue-title">
              <div className={styles.generationQueueHeader}>
                <div>
                  <span className={styles.eyebrow}>AI GENERATION QUEUE</span>
                  <h3 id="asset-generation-queue-title">AI 生成队列</h3>
                </div>
                <small>任务状态独立于下方资产筛选；中断后再次进入会自动恢复。</small>
              </div>
              <div className={styles.assetGrid}>
                {generationCards.map((generation) => (
                  <GenerationCard
                    key={generation.id}
                    generation={generation}
                    processing={generation.status === "running"}
                    onRetry={retryGeneration}
                    onDismiss={(generation) => void dismissGeneration(generation)}
                  />
                ))}
              </div>
            </section>
          )}
          <div className={styles.assetFilters}>
            <div className={styles.searchWrap}>
              <Search size={14} />
              <label className={styles.srOnly} htmlFor="asset-search">
                搜索资产
              </label>
              <input
                id="asset-search"
                className={styles.searchInput}
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="搜索资产"
              />
            </div>
            <fieldset className={styles.filterGroup}>
              <legend className={styles.filterLegend}>介质属性</legend>
              <div
                className={styles.filterBar}
                role="group"
                aria-label="按介质属性筛选"
              >
                <button
                  type="button"
                  aria-pressed={mediaFilter === "all"}
                  className={joinClassNames(
                    styles.segmentedButton,
                    mediaFilter === "all" && styles.segmentedButtonActive,
                  )}
                  onClick={() => setMediaFilter("all")}
                >
                  全部
                </button>
                {ASSET_MEDIA_TYPES.map((type) => (
                  <button
                    type="button"
                    key={type}
                    aria-pressed={mediaFilter === type}
                    className={joinClassNames(
                      styles.segmentedButton,
                      mediaFilter === type && styles.segmentedButtonActive,
                    )}
                    onClick={() => setMediaFilter(type)}
                  >
                    {MEDIA_META[type].label}
                  </button>
                ))}
              </div>
            </fieldset>
            <fieldset className={styles.filterGroup}>
              <legend className={styles.filterLegend}>制作分类</legend>
              <div
                className={styles.filterBar}
                role="group"
                aria-label="按制作分类筛选"
              >
                <button
                  type="button"
                  aria-pressed={categoryFilter === "all"}
                  className={joinClassNames(
                    styles.segmentedButton,
                    categoryFilter === "all" && styles.segmentedButtonActive,
                  )}
                  onClick={() => setCategoryFilter("all")}
                >
                  全部
                </button>
                {ASSET_CATEGORIES.map((category) => (
                  <button
                    type="button"
                    key={category}
                    aria-pressed={categoryFilter === category}
                    className={joinClassNames(
                      styles.segmentedButton,
                      categoryFilter === category &&
                        styles.segmentedButtonActive,
                    )}
                    onClick={() => setCategoryFilter(category)}
                  >
                    {CATEGORY_META[category].label}
                  </button>
                ))}
              </div>
            </fieldset>
          </div>
          {!assets.length ? (
            <div className={styles.stateBox}>
              <div>
                <Upload size={27} />
                <h3>{generationCards.length ? "当前项目还没有已入库资产" : "当前项目还没有资产"}</h3>
                <p>
                  上传文件、登记外部
                  URL，或使用已配置的图像模型创建首个生产资产。
                </p>
                <div className={styles.assetHeaderActions}>
                  <button
                    type="button"
                    className={styles.primaryButton}
                    onClick={openCreate}
                  >
                    新增第一个资产
                  </button>
                  <button
                    type="button"
                    className={styles.secondaryButton}
                    onClick={openGenerate}
                  >
                    <WandSparkles size={14} /> AI 创建
                  </button>
                </div>
              </div>
            </div>
          ) : !visibleAssets.length ? (
            <div className={styles.stateBox}>
              <div>
                <Search size={25} />
                <h3>没有匹配的资产</h3>
                <p>尝试清空搜索词或切换介质、制作分类。</p>
              </div>
            </div>
          ) : (
            <div className={styles.assetGrid}>
              {visibleAssets.map((asset) => (
                <article className={styles.assetCard} key={asset.id}>
                  <AssetPreview asset={asset} />
                  <div className={styles.assetMenu}>
                    <button
                      type="button"
                      className={styles.iconButton}
                      aria-label={`编辑资产 ${asset.name}`}
                      onClick={() => openEdit(asset)}
                      disabled={deletingIds.has(asset.id)}
                    >
                      <Pencil size={14} />
                    </button>
                    <button
                      type="button"
                      className={styles.iconButton}
                      aria-label={`删除资产 ${asset.name}`}
                      onClick={() => void deleteAsset(asset)}
                      disabled={deletingIds.has(asset.id)}
                    >
                      {deletingIds.has(asset.id) ? (
                        <LoaderCircle className={styles.spinner} size={14} />
                      ) : (
                        <Trash2 size={14} />
                      )}
                    </button>
                  </div>
                  <div className={styles.assetBody}>
                    <h3>{asset.name}</h3>
                    <div className={styles.assetDimensions}>
                      <span className={styles.sourceBadge}>
                        {MEDIA_META[asset.mediaType].label}
                      </span>
                      <span className={styles.levelBadge}>
                        {CATEGORY_META[asset.category].label}
                      </span>
                    </div>
                    <p>{asset.description || "暂无描述"}</p>
                    {asset.relations.length > 0 && (
                      <div className={styles.relationChips}>
                        {asset.relations.slice(0, 4).map((relation) => (
                          <span key={`${relation.id}:${relation.direction}`}>
                            {relation.direction === "incoming"
                              ? "被关联"
                              : "关联"}{" "}
                            · {relation.targetName}
                          </span>
                        ))}
                        {asset.relations.length > 4 && (
                          <span>另有 {asset.relations.length - 4} 条</span>
                        )}
                      </div>
                    )}
                    <div className={styles.assetFoot}>
                      <span className={styles.statusBadge}>{assetStatusLabel(asset)}</span>
                      <time>
                        {formatCompactDate(asset.updatedAt || asset.createdAt)}
                      </time>
                    </div>
                  </div>
                </article>
              ))}
            </div>
          )}
        </>
      )}
      {dialog === "asset" && (
        <div
          className={styles.dialogBackdrop}
          role="presentation"
          onMouseDown={(event) =>
            event.target === event.currentTarget && closeDialog()
          }
        >
          <div
            className={styles.dialog}
            role="dialog"
            aria-modal="true"
            aria-labelledby="asset-dialog-title"
          >
            <form onSubmit={saveAsset}>
              <header className={styles.dialogHeader}>
                <div>
                  <h2 id="asset-dialog-title">
                    {editing ? "编辑项目资产" : "新增项目资产"}
                  </h2>
                  <p>介质属性与制作分类彼此独立，可关联项目人物和其他资产。</p>
                </div>
                <button
                  className={styles.iconButton}
                  type="button"
                  aria-label="关闭资产表单"
                  onClick={closeDialog}
                  disabled={saving}
                >
                  <X size={16} />
                </button>
              </header>
              <div className={styles.dialogBody}>
                {!editing && (
                  <div className={styles.uploadMode}>
                    <button
                      type="button"
                      aria-pressed={sourceMode === "file"}
                      onClick={() => setSourceMode("file")}
                      disabled={saving}
                    >
                      <Upload size={15} /> 上传文件
                    </button>
                    <button
                      type="button"
                      aria-pressed={sourceMode === "url"}
                      onClick={() => setSourceMode("url")}
                      disabled={saving}
                    >
                      <Link2 size={15} /> 外部 URL
                    </button>
                  </div>
                )}
                <fieldset
                  className={joinClassNames(styles.formGrid, styles.formShell)}
                  disabled={saving}
                >
                  <div className={styles.field}>
                    <label htmlFor="asset-name">资产名称 *</label>
                    <input
                      ref={nameInputRef}
                      id="asset-name"
                      value={form.name}
                      onChange={(event) =>
                        updateForm("name", event.target.value)
                      }
                    />
                  </div>
                  <div className={styles.field}>
                    <label htmlFor="asset-media-type">介质属性 *</label>
                    <select
                      id="asset-media-type"
                      value={form.mediaType}
                      onChange={(event) =>
                        updateForm(
                          "mediaType",
                          event.target.value as AssetMediaType,
                        )
                      }
                    >
                      {ASSET_MEDIA_TYPES.map((type) => (
                        <option key={type} value={type}>
                          {MEDIA_META[type].label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className={styles.field}>
                    <label htmlFor="asset-category">制作分类 *</label>
                    <select
                      id="asset-category"
                      value={form.category}
                      onChange={(event) =>
                        updateForm(
                          "category",
                          event.target.value as AssetCategory,
                        )
                      }
                    >
                      {ASSET_CATEGORIES.map((category) => (
                        <option key={category} value={category}>
                          {CATEGORY_META[category].label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className={styles.fieldFull}>
                    <label htmlFor="asset-description">用途与描述</label>
                    <textarea
                      id="asset-description"
                      value={form.description}
                      onChange={(event) =>
                        updateForm("description", event.target.value)
                      }
                    />
                  </div>
                  {!editing && sourceMode === "file" ? (
                    <label
                      className={joinClassNames(
                        styles.dropZone,
                        styles.fieldFull,
                      )}
                    >
                      <input
                        type="file"
                        onChange={(event) =>
                          selectFile(event.target.files?.[0] ?? null)
                        }
                      />
                      <Upload size={22} />
                      <strong>{file?.name || "点击选择文件"}</strong>
                    </label>
                  ) : (
                    <>
                      <div className={styles.fieldFull}>
                        <label htmlFor="asset-source-url">外部地址</label>
                        <input
                          id="asset-source-url"
                          value={form.sourceUrl}
                          onChange={(event) =>
                            updateForm("sourceUrl", event.target.value)
                          }
                        />
                      </div>
                      <div className={styles.fieldFull}>
                        <label htmlFor="asset-thumbnail-url">缩略图地址</label>
                        <input
                          id="asset-thumbnail-url"
                          value={form.thumbnailUrl}
                          onChange={(event) =>
                            updateForm("thumbnailUrl", event.target.value)
                          }
                        />
                      </div>
                    </>
                  )}
                  <RelationFields
                    characters={characters}
                    assets={selectableAssets(editing?.id)}
                    value={form}
                    onToggle={(kind, targetId, checked) =>
                      toggleRelation(kind, targetId, checked)
                    }
                  />
                </fieldset>
                {formError && (
                  <div
                    className={joinClassNames(
                      styles.notice,
                      styles.noticeError,
                    )}
                    role="alert"
                  >
                    {formError}
                  </div>
                )}
              </div>
              <footer className={styles.dialogFooter}>
                <button
                  className={styles.secondaryButton}
                  type="button"
                  onClick={closeDialog}
                  disabled={saving}
                >
                  取消
                </button>
                <button
                  className={styles.primaryButton}
                  type="submit"
                  disabled={saving}
                >
                  {saving ? (
                    <LoaderCircle className={styles.spinner} size={14} />
                  ) : (
                    <Upload size={14} />
                  )}
                  保存资产
                </button>
              </footer>
            </form>
          </div>
        </div>
      )}
      {dialog === "generate" && (
        <div
          className={styles.dialogBackdrop}
          role="presentation"
          onMouseDown={(event) =>
            event.target === event.currentTarget && closeDialog()
          }
        >
          <div
            className={styles.dialog}
            role="dialog"
            aria-modal="true"
            aria-labelledby="generate-asset-title"
          >
            <form onSubmit={generateAsset}>
              <header className={styles.dialogHeader}>
                <div>
                  <h2 id="generate-asset-title">AI 创建资产</h2>
                  <p>提交后会立即建立任务卡片；页面中断时任务会保留，再次进入资产中心后自动恢复。</p>
                </div>
                <button
                  className={styles.iconButton}
                  type="button"
                  aria-label="关闭 AI 创建资产"
                  onClick={closeDialog}
                  disabled={saving}
                >
                  <X size={16} />
                </button>
              </header>
              <div className={styles.dialogBody}>
                <fieldset
                  className={joinClassNames(styles.formGrid, styles.formShell)}
                  disabled={saving}
                >
                  <div className={styles.fieldFull}>
                    <label htmlFor="generate-model">图像模型 *</label>
                    <select
                      id="generate-model"
                      value={generateForm.modelId}
                      onChange={(event) =>
                        updateGenerate("modelId", event.target.value)
                      }
                    >
                      <option value="">请选择模型</option>
                      {eligibleModels.map((model) => (
                        <option key={model.id} value={model.id}>
                          {model.name}
                        </option>
                      ))}
                    </select>
                    {!eligibleModels.length && (
                      <small className={styles.fieldError}>
                        没有已启用、配置密钥且支持图像生成的模型。
                      </small>
                    )}
                  </div>
                  <div className={styles.field}>
                    <label htmlFor="generate-name">资产名称 *</label>
                    <input
                      ref={nameInputRef}
                      id="generate-name"
                      value={generateForm.name}
                      onChange={(event) =>
                        updateGenerate("name", event.target.value)
                      }
                    />
                  </div>
                  <div className={styles.field}>
                    <label htmlFor="generate-category">制作分类 *</label>
                    <select
                      id="generate-category"
                      value={generateForm.category}
                      onChange={(event) =>
                        updateGenerate(
                          "category",
                          event.target.value as AssetCategory,
                        )
                      }
                    >
                      {ASSET_CATEGORIES.map((category) => (
                        <option key={category} value={category}>
                          {CATEGORY_META[category].label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className={styles.fieldFull}>
                    <label htmlFor="generate-prompt">生成提示词 *</label>
                    <textarea
                      id="generate-prompt"
                      value={generateForm.prompt}
                      onChange={(event) =>
                        updateGenerate("prompt", event.target.value)
                      }
                    />
                  </div>
                  <div className={styles.field}>
                    <label htmlFor="generate-ratio">画幅</label>
                    <select
                      id="generate-ratio"
                      value={generateForm.aspectRatio}
                      onChange={(event) =>
                        updateGenerate("aspectRatio", event.target.value)
                      }
                    >
                      {["1:1", "9:16", "16:9", "3:4", "4:3"].map((ratio) => (
                        <option key={ratio}>{ratio}</option>
                      ))}
                    </select>
                  </div>
                  <div className={styles.field}>
                    <label htmlFor="generate-size">自定义尺寸</label>
                    <input
                      id="generate-size"
                      placeholder="例如 1024x1024"
                      value={generateForm.size}
                      onChange={(event) =>
                        updateGenerate("size", event.target.value)
                      }
                    />
                  </div>
                  <RelationFields
                    characters={characters}
                    assets={selectableAssets()}
                    value={generateForm}
                    onToggle={(kind, targetId, checked) =>
                      toggleRelation(kind, targetId, checked, true)
                    }
                  />
                </fieldset>
                {formError && (
                  <div
                    className={joinClassNames(
                      styles.notice,
                      styles.noticeError,
                    )}
                    role="alert"
                  >
                    {formError}
                  </div>
                )}
              </div>
              <footer className={styles.dialogFooter}>
                <button
                  className={styles.secondaryButton}
                  type="button"
                  onClick={closeDialog}
                  disabled={saving}
                >
                  取消
                </button>
                <button
                  className={styles.primaryButton}
                  type="submit"
                  disabled={saving || !eligibleModels.length}
                >
                  {saving ? (
                    <LoaderCircle className={styles.spinner} size={14} />
                  ) : (
                    <Sparkles size={14} />
                  )}
                  创建生成任务
                </button>
              </footer>
            </form>
          </div>
        </div>
      )}
    </section>
  );
}

export type { AssetManagerProps };
