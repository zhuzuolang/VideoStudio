"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  BookOpenText,
  Bot,
  Boxes,
  CheckCircle2,
  ChevronRight,
  Clock3,
  FileText,
  History,
  LoaderCircle,
  RefreshCw,
  Sparkles,
  UsersRound,
} from "lucide-react";
import type {
  AgentRun,
  AgentRunInput,
  AiModel,
  ProjectAsset,
  ProjectScript,
  WorkspaceBootstrap,
} from "@/lib/platform-types";
import { apiRequest, formatCompactDate, getModelCapabilities, joinClassNames } from "./platform-client";
import styles from "./PlatformModules.module.css";

type AgentStudioProps = {
  projectId: string;
  projectName?: string;
  className?: string;
  initialGoal?: string;
  onOpenModels?: () => void;
  onRunComplete?: (run: AgentRun) => void;
};

type SourceState = {
  includeStory: boolean;
  includeEpisodes: boolean;
  characterIds: string[];
  scriptIds: string[];
  assetIds: string[];
};

const EMPTY_SOURCES: SourceState = {
  includeStory: true,
  includeEpisodes: false,
  characterIds: [],
  scriptIds: [],
  assetIds: [],
};

function normalizeStatus(status: string): string {
  return status.toLocaleLowerCase("en-US");
}

function isPending(run: AgentRun | null): boolean {
  if (!run) return false;
  const status = normalizeStatus(run.status);
  return status === "queued" || status === "running" || status === "processing";
}

function isComplete(run: AgentRun): boolean {
  const status = normalizeStatus(run.status);
  return status === "completed" || status === "complete" || status === "succeeded" || status === "success";
}

function isFailed(run: AgentRun): boolean {
  const status = normalizeStatus(run.status);
  return status === "failed" || status === "error";
}

function statusLabel(run: AgentRun): string {
  if (isComplete(run)) return "已完成";
  if (isFailed(run)) return "失败";
  if (isPending(run)) return normalizeStatus(run.status) === "queued" ? "排队中" : "分析中";
  return run.status || "未知状态";
}

function usageLabel(usage: Record<string, unknown> | null): string | null {
  if (!usage) return null;
  const total = usage.totalTokens ?? usage.total_tokens;
  const input = usage.inputTokens ?? usage.promptTokens ?? usage.input_tokens ?? usage.prompt_tokens;
  const output = usage.outputTokens ?? usage.completionTokens ?? usage.output_tokens ?? usage.completion_tokens;
  if (typeof total === "number") return `${total.toLocaleString("zh-CN")} tokens`;
  if (typeof input === "number" || typeof output === "number") {
    return `输入 ${typeof input === "number" ? input.toLocaleString("zh-CN") : "—"} · 输出 ${typeof output === "number" ? output.toLocaleString("zh-CN") : "—"}`;
  }
  return null;
}

function toggleId(values: string[], id: string): string[] {
  return values.includes(id) ? values.filter((value) => value !== id) : [...values, id];
}

export default function AgentStudio({
  projectId,
  projectName,
  className,
  initialGoal = "",
  onOpenModels,
  onRunComplete,
}: AgentStudioProps) {
  const [models, setModels] = useState<AiModel[]>([]);
  const [scripts, setScripts] = useState<ProjectScript[]>([]);
  const [assets, setAssets] = useState<ProjectAsset[]>([]);
  const [characters, setCharacters] = useState<Array<{ id: string; name?: string; [key: string]: unknown }>>([]);
  const [hasStory, setHasStory] = useState(false);
  const [episodeCount, setEpisodeCount] = useState(0);
  const [runs, setRuns] = useState<AgentRun[]>([]);
  const [activeRun, setActiveRun] = useState<AgentRun | null>(null);
  const [modelId, setModelId] = useState("");
  const [goal, setGoal] = useState(initialGoal);
  const [systemPrompt, setSystemPrompt] = useState("");
  const [sources, setSources] = useState<SourceState>(EMPTY_SOURCES);
  const [loading, setLoading] = useState(true);
  const [refreshingHistory, setRefreshingHistory] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [formError, setFormError] = useState("");
  const requestSequence = useRef(0);

  const eligibleModels = useMemo(() => models.filter((model) => model.enabled && model.hasApiKey), [models]);
  const selectedModel = useMemo(() => models.find((model) => model.id === modelId) ?? null, [modelId, models]);

  const sortedRuns = useMemo(
    () => [...runs].sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime()),
    [runs],
  );

  const selectedSourceCount = useMemo(
    () => Number(sources.includeStory) + Number(sources.includeEpisodes) + sources.characterIds.length + sources.scriptIds.length + sources.assetIds.length,
    [sources],
  );

  const loadWorkspace = useCallback(async () => {
    const sequence = ++requestSequence.current;
    if (!projectId) {
      setModels([]);
      setScripts([]);
      setAssets([]);
      setCharacters([]);
      setRuns([]);
      setActiveRun(null);
      setLoading(false);
      setError("");
      return;
    }

    setLoading(true);
    setError("");
    try {
      const data = await apiRequest<WorkspaceBootstrap>(`/api/bootstrap?projectId=${encodeURIComponent(projectId)}`, { cache: "no-store" });
      if (sequence !== requestSequence.current) return;
      const nextModels = Array.isArray(data.models) ? data.models : [];
      const nextScripts = Array.isArray(data.scripts) ? data.scripts : [];
      const nextAssets = Array.isArray(data.assets) ? data.assets : [];
      const nextRuns = Array.isArray(data.agentRuns) ? data.agentRuns : [];
      setModels(nextModels);
      setScripts(nextScripts);
      setAssets(nextAssets);
      setCharacters(Array.isArray(data.characters) ? data.characters : []);
      setHasStory(Boolean(data.story));
      setEpisodeCount(Array.isArray(data.episodes) ? data.episodes.length : 0);
      setRuns(nextRuns);
      setActiveRun(null);
      const firstEligible = nextModels.find((model) => model.enabled && model.hasApiKey);
      setModelId(firstEligible?.id ?? "");
      setSources({ ...EMPTY_SOURCES, includeStory: Boolean(data.story) });
      setGoal(initialGoal);
      setSystemPrompt("");
      setFormError("");
    } catch (requestError) {
      if (sequence !== requestSequence.current) return;
      setError(requestError instanceof Error ? requestError.message : "Agent 工作区加载失败，请重试。");
    } finally {
      if (sequence === requestSequence.current) setLoading(false);
    }
  }, [initialGoal, projectId]);

  const refreshRuns = useCallback(async (silent = false) => {
    if (!projectId) return;
    if (!silent) setRefreshingHistory(true);
    try {
      const data = await apiRequest<AgentRun[] | { runs?: AgentRun[]; agentRuns?: AgentRun[] }>(`/api/projects/${encodeURIComponent(projectId)}/agent-runs`, { cache: "no-store" });
      const nextRuns = Array.isArray(data) ? data : Array.isArray(data.runs) ? data.runs : Array.isArray(data.agentRuns) ? data.agentRuns : [];
      setRuns(nextRuns);
      setActiveRun((current) => current ? nextRuns.find((run) => run.id === current.id) ?? current : current);
      setError("");
    } catch (requestError) {
      if (!silent) setError(requestError instanceof Error ? requestError.message : "历史记录刷新失败，请重试。");
    } finally {
      if (!silent) setRefreshingHistory(false);
    }
  }, [projectId]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadWorkspace(), 0);
    return () => window.clearTimeout(timer);
  }, [loadWorkspace]);

  useEffect(() => {
    if (!isPending(activeRun) || submitting) return;
    const timer = window.setTimeout(() => void refreshRuns(true), 2200);
    return () => window.clearTimeout(timer);
  }, [activeRun, refreshingHistory, refreshRuns, submitting]);

  function setAllScripts(selected: boolean) {
    setSources((current) => ({ ...current, scriptIds: selected ? scripts.map((script) => script.id) : [] }));
  }

  function setAllAssets(selected: boolean) {
    setSources((current) => ({ ...current, assetIds: selected ? assets.map((asset) => asset.id) : [] }));
  }

  function setAllCharacters(selected: boolean) {
    setSources((current) => ({ ...current, characterIds: selected ? characters.map((character) => character.id) : [] }));
  }

  async function runAgent(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError("");
    if (!projectId) {
      setFormError("请先选择一个项目。");
      return;
    }
    if (!modelId) {
      setFormError("请选择一个已启用且已配置 API Key 的模型。");
      return;
    }
    if (!selectedModel?.enabled || !selectedModel.hasApiKey) {
      setFormError("所选模型不可用，请在模型中心检查启用状态和 API Key。");
      return;
    }
    if (!goal.trim()) {
      setFormError("请填写本次分析目标。");
      return;
    }
    if (selectedSourceCount === 0) {
      setFormError("请至少选择一项故事、剧本、人物或资产作为分析依据。");
      return;
    }

    setSubmitting(true);
    setError("");
    const body: AgentRunInput = {
      modelId,
      prompt: goal.trim(),
      sources: {
        includeStory: sources.includeStory,
        includeEpisodes: sources.includeEpisodes,
        characterIds: sources.characterIds,
        scriptIds: sources.scriptIds,
        assetIds: sources.assetIds,
      },
    };
    if (systemPrompt.trim()) body.systemPrompt = systemPrompt.trim();

    try {
      const data = await apiRequest<AgentRun | { run: AgentRun }>(`/api/projects/${encodeURIComponent(projectId)}/agent-runs`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      const run = "run" in data ? data.run : data;
      setActiveRun(run);
      setRuns((current) => [run, ...current.filter((item) => item.id !== run.id)]);
      onRunComplete?.(run);
    } catch (requestError) {
      setFormError(requestError instanceof Error ? requestError.message : "Agent 运行失败，请重试。");
    } finally {
      setSubmitting(false);
    }
  }

  const resultUsage = activeRun ? usageLabel(activeRun.usage) : null;

  return (
    <section className={joinClassNames(styles.moduleRoot, styles.moduleStack, className)} aria-labelledby="agent-studio-title">
      <div className={styles.toolbar}>
        <div className={styles.headingBlock}>
          <span className={styles.eyebrow}>CONTEXT-AWARE CREATIVE AGENT</span>
          <h2 id="agent-studio-title">AI 创作搭档{projectName ? ` · ${projectName}` : ""}</h2>
          <p>明确选择模型与项目素材后发起真实分析。Agent 只引用本次勾选的上下文，并保留运行与引用快照。</p>
        </div>
        <span className={styles.runState}>{isPending(activeRun) || submitting ? <LoaderCircle className={styles.spinner} size={14} /> : <Bot size={14} />}{isPending(activeRun) || submitting ? "Agent 正在运行" : "等待创作任务"}</span>
      </div>

      {error && <div className={joinClassNames(styles.notice, styles.noticeError)} role="alert"><AlertCircle size={16} /><span>{error}</span></div>}

      {!projectId ? (
        <div className={styles.stateBox}><div><Bot size={27} /><h3>请先选择项目</h3><p>Agent 的剧本、人物、资产与运行历史均按项目隔离。</p></div></div>
      ) : loading ? (
        <div className={styles.stateBox} aria-live="polite"><div><LoaderCircle className={styles.spinner} size={25} /><h3>正在准备 Agent 工作区</h3><p>正在读取当前项目可用的模型、剧本和资产。</p></div></div>
      ) : error && models.length === 0 ? (
        <div className={styles.stateBox}><div><AlertCircle size={25} /><h3>暂时无法加载 Agent 工作区</h3><p>请检查网络或服务状态后重试。</p><button className={styles.secondaryButton} onClick={() => void loadWorkspace()}><RefreshCw size={14} /> 重新加载</button></div></div>
      ) : (
        <div className={styles.agentLayout}>
          <form className={joinClassNames(styles.panel, styles.agentConfig)} onSubmit={runAgent} noValidate>
            <div className={styles.panelHeading}>
              <div><h3>本次创作任务</h3><p>配置不会修改正式项目内容</p></div>
              <Sparkles size={17} />
            </div>

            <div className={styles.fieldFull}>
              <label htmlFor="agent-model">执行模型<span className={styles.requiredMark}>*</span></label>
              <select id="agent-model" value={modelId} onChange={(event) => { setModelId(event.target.value); setFormError(""); }} disabled={eligibleModels.length === 0 || submitting}>
                <option value="">选择 AI 模型</option>
                {models.map((model) => <option key={model.id} value={model.id} disabled={!model.enabled || !model.hasApiKey}>{model.name} · {model.level}{!model.enabled ? "（已停用）" : !model.hasApiKey ? "（未配置 Key）" : ""}</option>)}
              </select>
              {selectedModel && <span className={styles.fieldHint}>{selectedModel.provider} · {selectedModel.modelId} · {getModelCapabilities(selectedModel).join(" / ") || "未标注能力"}</span>}
              {eligibleModels.length === 0 && <div className={joinClassNames(styles.notice, styles.noticeError)}><AlertCircle size={15} /><span>没有已启用且已配置 API Key 的模型。请先在模型中心完成配置。</span>{onOpenModels && <button type="button" className={styles.textButton} onClick={onOpenModels}>前往模型中心 <ChevronRight size={13} /></button>}</div>}
            </div>

            <div className={styles.fieldFull}>
              <label htmlFor="agent-goal">分析目标<span className={styles.requiredMark}>*</span></label>
              <textarea id="agent-goal" value={goal} onChange={(event) => { setGoal(event.target.value); setFormError(""); }} disabled={submitting} placeholder="例如：分析第 3 集的节奏断点，并结合人物卡与关键道具给出三条可执行修改建议。" />
            </div>

            <div className={styles.fieldFull}>
              <label htmlFor="agent-system-prompt">执行约束（可选）</label>
              <textarea id="agent-system-prompt" value={systemPrompt} onChange={(event) => setSystemPrompt(event.target.value)} disabled={submitting} placeholder="例如：不改变世界观设定；建议控制在单集 3 分钟内。" />
            </div>

            <div className={styles.sourcePicker}>
              <div className={styles.sectionTitle}><h3>项目基础信息</h3><span>选择引用范围</span></div>
              <label className={styles.checkCard}>
                <input type="checkbox" checked={sources.includeStory} onChange={(event) => setSources((current) => ({ ...current, includeStory: event.target.checked }))} disabled={!hasStory || submitting} />
                <span><b><BookOpenText size={12} /> 故事设定</b><small>{hasStory ? "引用当前项目故事圣经" : "当前项目尚无故事设定"}</small></span>
              </label>
              <label className={styles.checkCard}>
                <input type="checkbox" checked={sources.includeEpisodes} onChange={(event) => setSources((current) => ({ ...current, includeEpisodes: event.target.checked }))} disabled={episodeCount === 0 || submitting} />
                <span><b><FileText size={12} /> 分集大纲</b><small>{episodeCount > 0 ? `引用 ${episodeCount} 集大纲` : "当前项目尚无分集大纲"}</small></span>
              </label>
            </div>

            {scripts.length > 0 && (
              <div className={styles.sourcePicker}>
                <div className={styles.sectionTitle}><h3>剧本</h3><button type="button" className={styles.textButton} onClick={() => setAllScripts(sources.scriptIds.length !== scripts.length)} disabled={submitting}>{sources.scriptIds.length === scripts.length ? "清空" : "全选"}</button></div>
                <div className={styles.checkList}>
                  {scripts.map((script) => (
                    <label className={styles.checkCard} key={script.id}>
                      <input type="checkbox" checked={sources.scriptIds.includes(script.id)} onChange={() => setSources((current) => ({ ...current, scriptIds: toggleId(current.scriptIds, script.id) }))} disabled={submitting} />
                      <span><b>{script.title || `第 ${script.episodeNumber ?? "—"} 集剧本`}</b><small>{script.scenes?.length ?? 0} 场 · {script.status || "未标注状态"}</small></span>
                    </label>
                  ))}
                </div>
              </div>
            )}

            {characters.length > 0 && (
              <div className={styles.sourcePicker}>
                <div className={styles.sectionTitle}><h3>人物卡</h3><button type="button" className={styles.textButton} onClick={() => setAllCharacters(sources.characterIds.length !== characters.length)} disabled={submitting}>{sources.characterIds.length === characters.length ? "清空" : "全选"}</button></div>
                <div className={styles.checkList}>
                  {characters.map((character) => (
                    <label className={styles.checkCard} key={character.id}>
                      <input type="checkbox" checked={sources.characterIds.includes(character.id)} onChange={() => setSources((current) => ({ ...current, characterIds: toggleId(current.characterIds, character.id) }))} disabled={submitting} />
                      <span><b><UsersRound size={12} /> {character.name || "未命名人物"}</b><small>引用人物设定快照</small></span>
                    </label>
                  ))}
                </div>
              </div>
            )}

            {assets.length > 0 && (
              <div className={styles.sourcePicker}>
                <div className={styles.sectionTitle}><h3>资产</h3><button type="button" className={styles.textButton} onClick={() => setAllAssets(sources.assetIds.length !== assets.length)} disabled={submitting}>{sources.assetIds.length === assets.length ? "清空" : "全选"}</button></div>
                <div className={styles.checkList}>
                  {assets.map((asset) => (
                    <label className={styles.checkCard} key={asset.id}>
                      <input type="checkbox" checked={sources.assetIds.includes(asset.id)} onChange={() => setSources((current) => ({ ...current, assetIds: toggleId(current.assetIds, asset.id) }))} disabled={submitting} />
                      <span><b><Boxes size={12} /> {asset.name}</b><small>{asset.type} · {asset.status || "已入库"}</small></span>
                    </label>
                  ))}
                </div>
              </div>
            )}

            <div className={styles.selectionSummary} aria-live="polite">
              <span className={styles.sourceBadge}>{selectedSourceCount} 项上下文</span>
              <span className={styles.fieldHint}>实际用量以模型服务返回结果为准</span>
            </div>
            {formError && <div className={joinClassNames(styles.notice, styles.noticeError)} role="alert"><AlertCircle size={15} /><span>{formError}</span></div>}
            <button className={joinClassNames(styles.primaryButton, styles.runButton)} type="submit" disabled={submitting || eligibleModels.length === 0}>
              {submitting ? <LoaderCircle className={styles.spinner} size={15} /> : <Sparkles size={15} />}
              {submitting ? "正在调用模型分析…" : "运行 AI 创作分析"}
            </button>
          </form>

          <div className={styles.moduleStack}>
            <section className={joinClassNames(styles.panel, styles.agentOutput)} aria-labelledby="agent-result-title">
              <div className={styles.panelHeading}>
                <div><h3 id="agent-result-title">分析结果</h3><p>{activeRun ? `运行 ID · ${activeRun.id}` : "尚未调用模型"}</p></div>
                {activeRun && <span className={isFailed(activeRun) ? joinClassNames(styles.statusBadge, styles.statusBadgeError) : isPending(activeRun) ? joinClassNames(styles.statusBadge, styles.statusBadgeWarning) : styles.statusBadge}>{statusLabel(activeRun)}</span>}
              </div>
              <div className={styles.resultHero} aria-live="polite">
                {!activeRun && !submitting ? (
                  <div className={styles.resultEmpty}><Bot size={28} /><h3>等待真实分析结果</h3><p>选择模型与项目上下文，填写目标并运行后，模型返回内容和引用来源会显示在这里。</p></div>
                ) : submitting && !activeRun ? (
                  <div className={styles.resultEmpty}><LoaderCircle className={styles.spinner} size={28} /><h3>模型正在分析</h3><p>请求已提交，返回前不会展示预设或模拟结论。</p></div>
                ) : activeRun ? (
                  <div>
                    <div className={styles.resultMeta}>
                      <span className={styles.sourceBadge}><Bot size={11} /> {activeRun.modelName || selectedModel?.name || "AI 模型"}</span>
                      <span className={styles.sourceBadge}><Clock3 size={11} /> {formatCompactDate(activeRun.completedAt || activeRun.createdAt)}</span>
                      {resultUsage && <span className={styles.sourceBadge}>{resultUsage}</span>}
                    </div>
                    {isPending(activeRun) ? (
                      <div className={styles.resultEmpty}><LoaderCircle className={styles.spinner} size={25} /><h3>{statusLabel(activeRun)}</h3><p>正在等待模型完成，页面会自动刷新运行状态。</p></div>
                    ) : isFailed(activeRun) ? (
                      <div className={joinClassNames(styles.resultContent, styles.resultError)}><AlertCircle size={18} /> {activeRun.errorMessage || "模型运行失败，服务端未提供更多信息。"}</div>
                    ) : (
                      <div className={styles.resultContent}>{activeRun.response?.trim() || "本次运行已完成，但模型没有返回文本内容。"}</div>
                    )}
                    {Array.isArray(activeRun.sources) && activeRun.sources.length > 0 && (
                      <div className={styles.references}>
                        <h4>本次引用来源 · {activeRun.sources.length}</h4>
                        <div className={styles.referenceList}>
                          {activeRun.sources.map((source) => <span className={styles.sourceBadge} key={source.id || `${source.sourceType}-${source.sourceId}`}><FileText size={11} /> {source.title || `${source.sourceType} · ${source.sourceId}`}</span>)}
                        </div>
                      </div>
                    )}
                  </div>
                ) : null}
              </div>
            </section>

            <section className={joinClassNames(styles.panel, styles.agentOutput)} aria-labelledby="agent-history-title">
              <div className={styles.panelHeading}>
                <div><h3 id="agent-history-title">运行历史</h3><p>{runs.length} 次项目内分析</p></div>
                <button className={styles.iconButton} type="button" aria-label="刷新运行历史" onClick={() => void refreshRuns()} disabled={refreshingHistory}>{refreshingHistory ? <LoaderCircle className={styles.spinner} size={14} /> : <RefreshCw size={14} />}</button>
              </div>
              {sortedRuns.length === 0 ? (
                <div className={styles.resultEmpty}><History size={23} /><h3>还没有运行记录</h3><p>完成第一次分析后，模型、目标、结果与引用快照会保存在这里。</p></div>
              ) : (
                <div className={styles.historyList}>
                  {sortedRuns.map((run) => (
                    <button type="button" key={run.id} className={joinClassNames(styles.historyItem, activeRun?.id === run.id && styles.historyItemActive)} onClick={() => setActiveRun(run)} aria-pressed={activeRun?.id === run.id}>
                      <span className={joinClassNames(styles.historyStatus, isComplete(run) && styles.historyStatusSuccess, isFailed(run) && styles.historyStatusError)}>{isPending(run) ? <LoaderCircle className={styles.spinner} size={15} /> : isComplete(run) ? <CheckCircle2 size={15} /> : isFailed(run) ? <AlertCircle size={15} /> : <Bot size={15} />}</span>
                      <span className={styles.historyCopy}><b>{run.prompt || "未命名分析任务"}</b><small>{run.modelName || "未知模型"} · {statusLabel(run)} · {Array.isArray(run.sources) ? run.sources.length : 0} 项引用</small></span>
                      <time dateTime={run.createdAt}>{formatCompactDate(run.createdAt)}</time>
                    </button>
                  ))}
                </div>
              )}
            </section>
          </div>
        </div>
      )}
    </section>
  );
}

export type { AgentStudioProps };
