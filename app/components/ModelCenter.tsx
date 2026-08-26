"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  AlertCircle,
  Bot,
  CheckCircle2,
  Globe2,
  KeyRound,
  LoaderCircle,
  Pencil,
  Plus,
  RefreshCw,
  Settings2,
  Trash2,
  Video,
  X,
} from "lucide-react";
import type { AiModel, AiModelInput } from "@/lib/platform-types";
import { SEEDANCE_MODEL_PRESETS } from "@/lib/seedance-model-presets";
import { apiRequest, getModelCapabilities, isRecord, joinClassNames, PlatformApiError } from "./platform-client";
import styles from "./PlatformModules.module.css";

type ModelCenterProps = {
  className?: string;
  refreshKey?: number;
  onModelsChange?: (models: AiModel[]) => void;
};

type ModelForm = {
  name: string;
  provider: string;
  modelId: string;
  level: string;
  endpoint: string;
  iconUrl: string;
  capabilities: string;
  apiKey: string;
  enabled: boolean;
  clearApiKey: boolean;
};

type ModelFormErrors = Partial<Record<keyof ModelForm, string>>;

type ModelTestResult = {
  status: "success" | "failed";
  type: "text" | "image" | "video" | "unknown";
  latencyMs: number;
  summary: string;
  previewUrl?: string;
};

type SeedanceModelPreset = (typeof SEEDANCE_MODEL_PRESETS)[number];

const SORTED_SEEDANCE_PRESETS = [...SEEDANCE_MODEL_PRESETS].sort(
  (left, right) => left.parameters.sortOrder - right.parameters.sortOrder,
);

const EMPTY_FORM: ModelForm = {
  name: "",
  provider: "",
  modelId: "",
  level: "标准",
  endpoint: "",
  iconUrl: "",
  capabilities: "文本分析, 剧本创作",
  apiKey: "",
  enabled: true,
  clearApiKey: false,
};

function modelToForm(model: AiModel): ModelForm {
  return {
    name: model.name,
    provider: model.provider,
    modelId: model.modelId,
    level: model.level,
    endpoint: model.endpoint,
    iconUrl: model.iconUrl ?? "",
    capabilities: getModelCapabilities(model).join(", "),
    apiKey: "",
    enabled: model.enabled,
    clearApiKey: false,
  };
}

function presetToForm(preset: SeedanceModelPreset): ModelForm {
  return {
    name: preset.name,
    provider: preset.provider,
    modelId: preset.modelId,
    level: preset.level,
    endpoint: preset.endpoint,
    iconUrl: "",
    capabilities: preset.capabilities.join(", "),
    apiKey: "",
    enabled: true,
    clearApiKey: false,
  };
}

function modelMatchesPreset(model: AiModel, preset: SeedanceModelPreset): boolean {
  const configuredPresetKey = model.parameters?.presetKey;
  return typeof configuredPresetKey === "string"
    ? configuredPresetKey === preset.parameters.presetKey
    : model.modelId === preset.modelId;
}

function parseCapabilities(value: string): string[] {
  return Array.from(
    new Set(
      value
        .split(/[,，\n]/)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  );
}

function validateUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}

function ModelAvatar({ model }: { model: AiModel }) {
  const [failedIconVersion, setFailedIconVersion] = useState<string | null>(null);
  const iconUrl = model.iconUrl ?? null;
  const iconVersion = `${iconUrl ?? ""}:${model.updatedAt ?? ""}`;
  const showIcon = Boolean(iconUrl && failedIconVersion !== iconVersion);

  return (
    <div className={styles.modelIcon} aria-hidden="true">
      <Bot size={20} />
      {showIcon && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={iconUrl!} alt="" onError={() => setFailedIconVersion(iconVersion)} />
      )}
    </div>
  );
}

export default function ModelCenter({ className, refreshKey, onModelsChange }: ModelCenterProps) {
  const [models, setModels] = useState<AiModel[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [editing, setEditing] = useState<AiModel | null | undefined>(undefined);
  const [selectedPreset, setSelectedPreset] = useState<SeedanceModelPreset | null>(null);
  const [form, setForm] = useState<ModelForm>(EMPTY_FORM);
  const [formErrors, setFormErrors] = useState<ModelFormErrors>({});
  const [saving, setSaving] = useState(false);
  const [deletingIds, setDeletingIds] = useState<Set<string>>(() => new Set());
  const [testingIds, setTestingIds] = useState<Set<string>>(() => new Set());
  const [testResults, setTestResults] = useState<Record<string, ModelTestResult>>({});
  const [dirty, setDirty] = useState(false);
  const firstFieldRef = useRef<HTMLInputElement>(null);
  const onModelsChangeRef = useRef(onModelsChange);
  const requestSequence = useRef(0);
  const testGeneration = useRef(0);

  useEffect(() => {
    onModelsChangeRef.current = onModelsChange;
  }, [onModelsChange]);

  const loadModels = useCallback(async () => {
    testGeneration.current += 1;
    setTestResults({});
    setTestingIds(new Set<string>());
    const sequence = ++requestSequence.current;
    setLoading(true);
    setError("");
    try {
      const data = await apiRequest<AiModel[] | { models: AiModel[] }>("/api/models", { cache: "no-store" });
      if (sequence !== requestSequence.current) return;
      const nextModels = Array.isArray(data) ? data : Array.isArray(data.models) ? data.models : [];
      setModels(nextModels);
      onModelsChangeRef.current?.(nextModels);
    } catch (requestError) {
      if (sequence !== requestSequence.current) return;
      setError(requestError instanceof Error ? requestError.message : "模型列表加载失败，请重试。");
    } finally {
      if (sequence === requestSequence.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadModels(), 0);
    return () => window.clearTimeout(timer);
  }, [loadModels, refreshKey]);

  useEffect(() => {
    if (!success) return;
    const timer = window.setTimeout(() => setSuccess(""), 3200);
    return () => window.clearTimeout(timer);
  }, [success]);

  useEffect(() => {
    if (editing === undefined) return;
    const timer = window.setTimeout(() => firstFieldRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [editing]);

  useEffect(() => {
    if (editing === undefined) return;
    function handleEscape(event: KeyboardEvent) {
      if (event.key !== "Escape" || saving) return;
      if (!dirty || window.confirm("当前修改尚未保存，确定关闭吗？")) {
        setSelectedPreset(null);
        setEditing(undefined);
      }
    }
    window.addEventListener("keydown", handleEscape);
    return () => {
      window.removeEventListener("keydown", handleEscape);
    };
  }, [dirty, editing, saving]);

  const activeCount = useMemo(() => models.filter((model) => model.enabled).length, [models]);

  function openCreate() {
    setSelectedPreset(null);
    setForm(EMPTY_FORM);
    setFormErrors({});
    setDirty(false);
    setEditing(null);
  }

  function openEdit(model: AiModel) {
    setSelectedPreset(null);
    setForm(modelToForm(model));
    setFormErrors({});
    setDirty(false);
    setEditing(model);
  }

  function openPreset(preset: SeedanceModelPreset, configuredModel?: AiModel) {
    setSelectedPreset(preset);
    setForm(configuredModel
      ? { ...modelToForm(configuredModel), capabilities: preset.capabilities.join(", ") }
      : presetToForm(preset));
    setFormErrors({});
    setDirty(false);
    setEditing(configuredModel ?? null);
  }

  function closeForm() {
    if (saving) return;
    if (dirty && !window.confirm("当前修改尚未保存，确定关闭吗？")) return;
    setSelectedPreset(null);
    setEditing(undefined);
  }

  function updateForm<K extends keyof ModelForm>(key: K, value: ModelForm[K]) {
    setForm((current) => ({ ...current, [key]: value }));
    setFormErrors((current) => ({ ...current, [key]: undefined }));
    setDirty(true);
  }

  function validateForm(): ModelFormErrors {
    const nextErrors: ModelFormErrors = {};
    if (!form.name.trim()) nextErrors.name = "请输入模型显示名称。";
    if (!form.provider.trim()) nextErrors.provider = "请输入模型服务商。";
    if (!form.modelId.trim()) nextErrors.modelId = "请输入服务商提供的模型 ID。";
    if (!form.level.trim()) nextErrors.level = "请输入模型等级。";
    if (!form.endpoint.trim()) nextErrors.endpoint = "请输入 API 地址。";
    else if (!validateUrl(form.endpoint.trim())) nextErrors.endpoint = "请输入有效且不含凭据的 HTTPS 地址。";
    if (form.iconUrl.trim() && !validateUrl(form.iconUrl.trim())) nextErrors.iconUrl = "图标地址必须是有效且不含凭据的 HTTPS 地址。";
    if (parseCapabilities(form.capabilities).length === 0) nextErrors.capabilities = "请至少填写一项能力。";
    return nextErrors;
  }

  async function saveModel(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextErrors = validateForm();
    setFormErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;

    setSaving(true);
    setError("");
    const existingParameters = editing && typeof editing === "object" ? editing.parameters : {};
    const body: AiModelInput = {
      name: form.name.trim(),
      provider: form.provider.trim(),
      modelId: form.modelId.trim(),
      level: form.level.trim(),
      endpoint: form.endpoint.trim(),
      iconUrl: form.iconUrl.trim() || null,
      enabled: form.enabled,
      parameters: {
        ...existingParameters,
        ...(selectedPreset?.parameters ?? {}),
        capabilities: selectedPreset ? [...selectedPreset.capabilities] : parseCapabilities(form.capabilities),
      },
    };
    if (form.apiKey.trim()) body.apiKey = form.apiKey.trim();
    if (editing && form.clearApiKey && !form.apiKey.trim()) body.clearApiKey = true;

    try {
      if (editing) {
        await apiRequest<AiModel>(`/api/models/${encodeURIComponent(editing.id)}`, {
          method: "PATCH",
          body: JSON.stringify(body),
        });
      } else {
        await apiRequest<AiModel>("/api/models", {
          method: "POST",
          body: JSON.stringify(body),
        });
      }
      setSelectedPreset(null);
      setEditing(undefined);
      setDirty(false);
      setSuccess(editing ? "模型配置已更新。" : "模型已添加到全局模型中心。");
      await loadModels();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "模型保存失败，请重试。");
    } finally {
      setSaving(false);
    }
  }

  async function deleteModel(model: AiModel) {
    if (!window.confirm(`确定删除模型“${model.name}”吗？该操作不会删除历史 Agent 运行记录。`)) return;
    setDeletingIds((current) => {
      const next = new Set(current);
      next.add(model.id);
      return next;
    });
    setError("");
    try {
      await apiRequest<unknown>(`/api/models/${encodeURIComponent(model.id)}`, { method: "DELETE" });
      setSuccess(`模型“${model.name}”已删除。`);
      await loadModels();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "模型删除失败，请重试。");
    } finally {
      setDeletingIds((current) => {
        const next = new Set(current);
        next.delete(model.id);
        return next;
      });
    }
  }

  async function testModel(model: AiModel) {
    const startedAt = Date.now();
    const generation = testGeneration.current;
    setTestingIds((current) => {
      const next = new Set(current);
      next.add(model.id);
      return next;
    });
    setTestResults((current) => {
      const next = { ...current };
      delete next[model.id];
      return next;
    });
    try {
      const result = await apiRequest<Omit<ModelTestResult, "status"> & { status: "success" }>(`/api/models/${encodeURIComponent(model.id)}/test`, { method: "POST" });
      if (generation !== testGeneration.current) return;
      setTestResults((current) => ({ ...current, [model.id]: result }));
    } catch (requestError) {
      if (generation !== testGeneration.current) return;
      const details = requestError instanceof PlatformApiError && isRecord(requestError.details) ? requestError.details : null;
      setTestResults((current) => ({
        ...current,
        [model.id]: {
          status: "failed",
          type: details?.type === "text" || details?.type === "image" || details?.type === "video" ? details.type : "unknown",
          latencyMs: typeof details?.latencyMs === "number" ? details.latencyMs : Date.now() - startedAt,
          summary: requestError instanceof Error ? requestError.message : "模型连接测试失败，请重试。",
        },
      }));
    } finally {
      if (generation === testGeneration.current) {
        setTestingIds((current) => {
          const next = new Set(current);
          next.delete(model.id);
          return next;
        });
      }
    }
  }

  return (
    <section className={joinClassNames(styles.moduleRoot, styles.moduleStack, className)} aria-labelledby="model-center-title">
      <div className={styles.toolbar}>
        <div className={styles.headingBlock}>
          <span className={styles.eyebrow}>GLOBAL MODEL REGISTRY</span>
          <h2 id="model-center-title">AI 模型中心</h2>
          <p>跨项目统一管理模型连接。API Key 只会在保存时提交，页面与接口均不返回明文。</p>
        </div>
        <button className={styles.primaryButton} type="button" onClick={openCreate}>
          <Plus size={15} /> 添加模型
        </button>
      </div>

      <div className={styles.statusLine} aria-live="polite">
        {!loading && !error && <span className={styles.runState}><CheckCircle2 size={14} /> 已启用 {activeCount} / {models.length} 个模型</span>}
      </div>

      {error && (
        <div className={joinClassNames(styles.notice, styles.noticeError)} role="alert">
          <AlertCircle size={16} />
          <span>{error}</span>
        </div>
      )}
      {success && (
        <div className={joinClassNames(styles.notice, styles.noticeSuccess)} role="status">
          <CheckCircle2 size={16} />
          <span>{success}</span>
        </div>
      )}

      <section className={styles.presetSection} aria-labelledby="seedance-preset-title">
        <div className={styles.presetHeading}>
          <div>
            <span className={styles.eyebrow}>OFFICIAL VIDEO PRESETS</span>
            <h3 id="seedance-preset-title">Seedance 视频模型</h3>
            <p>按官方产品与价格拆分为独立卡片。选择后会预填对应接口、规格与请求参数。</p>
          </div>
          <span>{SORTED_SEEDANCE_PRESETS.length} 个官方预设</span>
        </div>
        <div className={styles.presetGrid}>
          {SORTED_SEEDANCE_PRESETS.map((preset) => {
            const configuredModel = models.find((model) => modelMatchesPreset(model, preset));
            const stateLabel = loading ? "检查中" : configuredModel ? "已配置" : "未配置";
            return (
              <article
                className={joinClassNames(styles.presetCard, configuredModel && styles.presetCardConfigured)}
                key={preset.presetId}
                aria-labelledby={`seedance-preset-${preset.presetId}`}
              >
                <div className={styles.presetCardTitle}>
                  <span className={styles.presetIcon} aria-hidden="true"><Video size={18} /></span>
                  <div>
                    <h4 id={`seedance-preset-${preset.presetId}`}>{preset.name}</h4>
                    <p title={preset.modelId}>{preset.modelId}</p>
                  </div>
                  <span className={configuredModel ? styles.presetConfiguredBadge : styles.presetPendingBadge}>
                    {configuredModel && <CheckCircle2 size={11} />}{stateLabel}
                  </span>
                </div>
                <div className={styles.presetPrice}>
                  <span>官方参考价格</span>
                  <strong>{preset.priceLabel}</strong>
                  <small>最终费用以火山方舟实际账单为准</small>
                </div>
                <dl className={styles.presetSpecs}>
                  <div><dt>分辨率</dt><dd>{preset.resolutionLabel}</dd></div>
                  <div><dt>时长</dt><dd>{preset.durationLabel}</dd></div>
                  <div><dt>输入方式</dt><dd>{preset.parameters.pricing.withVideoInputLabel ? "文生 / 图生视频" : "视频生成"}</dd></div>
                  <div><dt>API Key</dt><dd>{configuredModel?.hasApiKey ? configuredModel.apiKeyMasked || "已配置" : "逐卡配置"}</dd></div>
                </dl>
                <div className={styles.capabilityList} aria-label={`${preset.name} 模型能力`}>
                  {preset.capabilities.map((capability) => <span className={styles.capability} key={capability}>{capability}</span>)}
                </div>
                <button
                  className={joinClassNames(configuredModel ? styles.secondaryButton : styles.primaryButton, styles.presetAction)}
                  type="button"
                  aria-label={`${configuredModel ? "编辑已配置" : "配置"} Seedance 预设 ${preset.name}`}
                  onClick={() => openPreset(preset, configuredModel)}
                  disabled={loading}
                >
                  {configuredModel ? <Pencil size={13} /> : <Plus size={13} />}
                  {configuredModel ? "编辑已配置卡片" : "配置此模型"}
                </button>
              </article>
            );
          })}
        </div>
      </section>

      {loading ? (
        <div className={styles.stateBox} aria-live="polite">
          <div><LoaderCircle className={styles.spinner} size={25} /><h3>正在读取模型配置</h3><p>正在获取跨项目可用的 AI 模型。</p></div>
        </div>
      ) : error && models.length === 0 ? (
        <div className={styles.stateBox}>
          <div><AlertCircle size={25} /><h3>暂时无法加载模型</h3><p>请检查网络或服务状态后重试。</p><button className={styles.secondaryButton} onClick={() => void loadModels()}><RefreshCw size={14} /> 重新加载</button></div>
        </div>
      ) : models.length === 0 ? (
        <div className={styles.stateBox}>
          <div><Bot size={27} /><h3>还没有配置 AI 模型</h3><p>先添加一个文本或多模态模型，之后所有项目的 Agent 都能选择它。</p><button className={styles.primaryButton} onClick={openCreate}><Plus size={14} /> 添加第一个模型</button></div>
        </div>
      ) : (
        <div className={styles.modelGrid}>
          {models.map((model) => {
            const capabilities = getModelCapabilities(model);
            const isDeleting = deletingIds.has(model.id);
            const isTesting = testingIds.has(model.id);
            const testResult = testResults[model.id];
            return (
              <article key={model.id} className={joinClassNames(styles.modelCard, !model.enabled && styles.modelCardDisabled)}>
                <div className={styles.cardTitle}>
                  <ModelAvatar model={model} />
                  <div>
                    <h3 title={model.name}>{model.name}</h3>
                    <p title={model.modelId}>{model.provider} · {model.modelId}</p>
                  </div>
                  <span className={model.enabled ? styles.enabledDot : styles.disabledDot} title={model.enabled ? "已启用" : "已停用"} />
                </div>
                <dl className={styles.modelMeta}>
                  <div><dt>等级</dt><dd>{model.level || "未设置"}</dd></div>
                  <div><dt>密钥</dt><dd>{model.hasApiKey ? model.apiKeyMasked || "••••••••" : "未配置"}</dd></div>
                  <div><dt>API 地址</dt><dd title={model.endpoint}><Globe2 size={11} /> {model.endpoint}</dd></div>
                  <div><dt>状态</dt><dd>{model.enabled ? "可供 Agent 使用" : "已停用"}</dd></div>
                </dl>
                <div className={styles.capabilityList} aria-label="模型能力">
                  <span className={styles.levelBadge}>{model.level}</span>
                  {capabilities.length > 0 ? capabilities.map((capability) => <span className={styles.capability} key={capability}>{capability}</span>) : <span className={styles.capability}>未标注能力</span>}
                </div>
                <div
                  className={joinClassNames(styles.modelTestResult, !testResult && !isTesting && styles.modelTestIdle, testResult?.status === "success" && styles.modelTestSuccess, testResult?.status === "failed" && styles.modelTestError)}
                  role={isTesting || testResult?.status === "success" ? "status" : testResult?.status === "failed" ? "alert" : undefined}
                  aria-live="polite"
                >
                  {isTesting ? <><div><LoaderCircle className={styles.spinner} size={13} /><b>正在测试</b></div><p>正在向模型服务发送最小连通性请求…</p></> : testResult ? <>
                    <div>
                      {testResult.status === "success" ? <CheckCircle2 size={13} /> : <AlertCircle size={13} />}
                      <b>{testResult.status === "success" ? "连接成功" : "连接失败"}</b>
                      <span>{testResult.type === "image" ? "图像" : testResult.type === "video" ? "视频" : testResult.type === "text" ? "文本" : "模型"} · {testResult.latencyMs} ms</span>
                    </div>
                    <p>{testResult.summary}</p>
                    {testResult.previewUrl && <small>已收到安全的 HTTPS 图像预览地址，本次测试未写入资产库。</small>}
                  </> : <><div><Activity size={13} /><b>尚未测试</b></div><p>运行一次最小请求，验证地址、密钥与模型响应。</p></>}
                </div>
                <div className={styles.cardActions}>
                  <span title={model.endpoint}>{model.endpoint}</span>
                  <div className={styles.inlineActions}>
                    <button className={styles.testButton} type="button" aria-label={`测试模型 ${model.name}`} onClick={() => void testModel(model)} disabled={isDeleting || isTesting}>{isTesting ? <LoaderCircle className={styles.spinner} size={13} /> : <Activity size={13} />}{isTesting ? "测试中" : "测试"}</button>
                    <button className={styles.iconButton} type="button" aria-label={`编辑模型 ${model.name}`} onClick={() => openEdit(model)} disabled={isDeleting || isTesting}><Pencil size={14} /></button>
                    <button className={styles.iconButton} type="button" aria-label={`删除模型 ${model.name}`} onClick={() => void deleteModel(model)} disabled={isDeleting || isTesting}>{isDeleting ? <LoaderCircle className={styles.spinner} size={14} /> : <Trash2 size={14} />}</button>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}

      {editing !== undefined && (
        <div className={styles.dialogBackdrop} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closeForm(); }}>
          <div className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby="model-dialog-title">
            <form onSubmit={saveModel} noValidate aria-busy={saving}>
              <header className={styles.dialogHeader}>
                <div>
                  <h2 id="model-dialog-title">{selectedPreset ? `${editing ? "编辑" : "配置"} Seedance 预设` : editing ? "编辑模型" : "添加 AI 模型"}</h2>
                  <p>{selectedPreset ? `${selectedPreset.name} 的价格档、视频规格与请求 profile 会随模型一起保存；API Key 仅用于当前卡片。` : editing ? "留空 API Key 即保留当前密钥。" : "配置完成后，所有项目都可以选择该模型。"}</p>
                </div>
                <button className={styles.iconButton} type="button" aria-label="关闭模型表单" onClick={closeForm} disabled={saving}><X size={16} /></button>
              </header>
              <div className={styles.dialogBody}>
                <div className={styles.formGrid}>
                  <div className={styles.field}>
                    <label htmlFor="model-name">显示名称<span className={styles.requiredMark}>*</span></label>
                    <input ref={firstFieldRef} id="model-name" value={form.name} onChange={(event) => updateForm("name", event.target.value)} aria-invalid={Boolean(formErrors.name)} aria-describedby={formErrors.name ? "model-name-error" : undefined} placeholder="例如：剧本分析 Pro" disabled={saving} />
                    {formErrors.name && <span className={styles.fieldError} id="model-name-error">{formErrors.name}</span>}
                  </div>
                  <div className={styles.field}>
                    <label htmlFor="model-provider">服务商<span className={styles.requiredMark}>*</span></label>
                    <input id="model-provider" value={form.provider} onChange={(event) => updateForm("provider", event.target.value)} aria-invalid={Boolean(formErrors.provider)} placeholder="例如：OpenAI" disabled={saving} />
                    {formErrors.provider && <span className={styles.fieldError}>{formErrors.provider}</span>}
                  </div>
                  <div className={styles.field}>
                    <label htmlFor="model-id">模型 ID<span className={styles.requiredMark}>*</span></label>
                    <input id="model-id" value={form.modelId} onChange={(event) => updateForm("modelId", event.target.value)} aria-invalid={Boolean(formErrors.modelId)} placeholder="服务商模型标识" autoComplete="off" disabled={saving} />
                    {formErrors.modelId && <span className={styles.fieldError}>{formErrors.modelId}</span>}
                  </div>
                  <div className={styles.field}>
                    <label htmlFor="model-level">等级<span className={styles.requiredMark}>*</span></label>
                    <input id="model-level" list="model-level-options" value={form.level} onChange={(event) => updateForm("level", event.target.value)} aria-invalid={Boolean(formErrors.level)} placeholder="例如：旗舰" disabled={saving} />
                    <datalist id="model-level-options"><option value="轻量" /><option value="标准" /><option value="高级" /><option value="旗舰" /></datalist>
                    {formErrors.level && <span className={styles.fieldError}>{formErrors.level}</span>}
                  </div>
                  <div className={styles.fieldFull}>
                    <label htmlFor="model-endpoint">API 地址<span className={styles.requiredMark}>*</span></label>
                    <input id="model-endpoint" type="url" value={form.endpoint} onChange={(event) => updateForm("endpoint", event.target.value)} aria-invalid={Boolean(formErrors.endpoint)} placeholder="https://api.example.com/v1" autoCapitalize="none" autoCorrect="off" disabled={saving} />
                    {formErrors.endpoint && <span className={styles.fieldError}>{formErrors.endpoint}</span>}
                  </div>
                  <div className={styles.fieldFull}>
                    <label htmlFor="model-icon">图标地址</label>
                    <input id="model-icon" type="url" value={form.iconUrl} onChange={(event) => updateForm("iconUrl", event.target.value)} aria-invalid={Boolean(formErrors.iconUrl)} placeholder="https://…/icon.png" autoCapitalize="none" autoCorrect="off" disabled={saving} />
                    {formErrors.iconUrl && <span className={styles.fieldError}>{formErrors.iconUrl}</span>}
                  </div>
                  <div className={styles.fieldFull}>
                    <label htmlFor="model-capabilities">模型能力<span className={styles.requiredMark}>*</span></label>
                    <input id="model-capabilities" value={form.capabilities} onChange={(event) => updateForm("capabilities", event.target.value)} aria-invalid={Boolean(formErrors.capabilities)} placeholder="文本分析, 图片理解, 视频生成" disabled={saving || Boolean(selectedPreset)} />
                    <span className={styles.fieldHint}>用逗号分隔，Agent 会据此提示模型适用范围。</span>
                    {formErrors.capabilities && <span className={styles.fieldError}>{formErrors.capabilities}</span>}
                  </div>
                  <fieldset className={styles.fieldset}>
                    <legend><KeyRound size={12} /> API Key</legend>
                    <div className={styles.fieldFull}>
                      <input id="model-api-key" aria-label="API Key" type="password" value={form.apiKey} onChange={(event) => { updateForm("apiKey", event.target.value); if (event.target.value) updateForm("clearApiKey", false); }} placeholder={editing?.hasApiKey ? `当前：${editing.apiKeyMasked || "••••••••"}（留空不修改）` : "输入服务商 API Key"} autoComplete="new-password" disabled={saving} />
                      <span className={styles.fieldHint}>密钥不会回显。编辑时留空表示保留原值。</span>
                    </div>
                    {editing?.hasApiKey && (
                      <label className={styles.checkboxLine}>
                        <input type="checkbox" checked={form.clearApiKey} onChange={(event) => updateForm("clearApiKey", event.target.checked)} disabled={saving || Boolean(form.apiKey)} />
                        <span><b>移除当前 API Key</b><small>保存后该模型将无法运行，直到重新配置密钥。</small></span>
                      </label>
                    )}
                  </fieldset>
                  <fieldset className={styles.fieldset}>
                    <legend><Settings2 size={12} /> 使用状态</legend>
                    <div className={styles.toggleRow}>
                      <div className={styles.checkboxLine}><span><b>{form.enabled ? "允许 Agent 选择" : "暂时停用"}</b><small>停用不会影响历史运行记录。</small></span></div>
                      <label className={styles.switch} aria-label="启用模型"><input type="checkbox" checked={form.enabled} onChange={(event) => updateForm("enabled", event.target.checked)} disabled={saving} /><i /></label>
                    </div>
                  </fieldset>
                </div>
              </div>
              <footer className={styles.dialogFooter}>
                <button className={styles.secondaryButton} type="button" onClick={closeForm} disabled={saving}>取消</button>
                <button className={styles.primaryButton} type="submit" disabled={saving}>{saving ? <LoaderCircle className={styles.spinner} size={14} /> : <CheckCircle2 size={14} />}{saving ? "正在保存…" : "保存模型"}</button>
              </footer>
            </form>
          </div>
        </div>
      )}
    </section>
  );
}

export type { ModelCenterProps };
