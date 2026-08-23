"use client";

/* eslint-disable @next/next/no-img-element -- project assets can use authenticated or user-configured URLs. */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LucideIcon } from "lucide-react";
import {
  AlertCircle,
  ArrowRight,
  Bell,
  BookOpenText,
  Bot,
  Boxes,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleDotDashed,
  Clapperboard,
  Cpu,
  Database,
  FileAudio,
  FileText,
  Film,
  Image as ImageIcon,
  Layers3,
  LayoutDashboard,
  LoaderCircle,
  Menu,
  MoreHorizontal,
  PencilLine,
  Plus,
  RefreshCw,
  ScanLine,
  Search,
  Sparkles,
  UsersRound,
  Video,
  X,
} from "lucide-react";
import AgentStudio from "./components/AgentStudio";
import AssetManager from "./components/AssetManager";
import ModelCenter from "./components/ModelCenter";
import { apiRequest } from "./components/platform-client";
import type {
  AgentRun,
  AiModel,
  Project,
  ProjectAsset,
  ProjectScript,
  ScriptScene,
  WorkspaceBootstrap,
} from "@/lib/platform-types";

type ViewId =
  | "overview"
  | "story"
  | "characters"
  | "scripts"
  | "breakdown"
  | "assets"
  | "shots"
  | "agent"
  | "delivery"
  | "models";

type NavItem = {
  id: ViewId;
  label: string;
  icon: LucideIcon;
  global?: boolean;
};

type StoryRecord = {
  projectId: string;
  title: string;
  logline: string;
  synopsis: string;
  worldview: string;
  coreConflict: string;
  themes: string[];
  styleReference: string;
  storyBible: string;
  status: string;
  updatedAt: string;
};

type EpisodeRecord = {
  id: string;
  episodeNo: number;
  title: string;
  summary: string;
  hook: string;
  durationSeconds: number;
  status: string;
};

type CharacterRecord = {
  id: string;
  name: string;
  role: string;
  bio: string;
  appearance: string;
  personality: string;
  arc: string;
  voice: string;
  relationships?: Array<{ name?: string; relation?: string }>;
  avatarUrl?: string | null;
  status: string;
};

type SceneRecord = ScriptScene & {
  sceneNo?: number;
  heading?: string;
  location?: string;
  timeOfDay?: string;
  summary?: string;
  action?: string;
  dialogue?: Array<{ character?: string; line?: string; emotion?: string }>;
  characters?: string[];
  wardrobe?: string[];
  props?: string[];
  durationSeconds?: number;
  status?: string;
};

type SearchResult = {
  id: string;
  view: ViewId;
  title: string;
  detail: string;
  agentRunId?: string;
};

function storyToDraft(story: StoryRecord | null) {
  return {
    title: story?.title ?? "",
    logline: story?.logline ?? "",
    synopsis: story?.synopsis ?? "",
    worldview: story?.worldview ?? "",
    coreConflict: story?.coreConflict ?? "",
    themes: story?.themes?.join("、") ?? "",
    styleReference: story?.styleReference ?? "",
    storyBible: story?.storyBible ?? "",
    status: story?.status ?? "draft",
  };
}

const productionNav: NavItem[] = [
  { id: "overview", label: "项目总览", icon: LayoutDashboard },
  { id: "story", label: "故事设计", icon: BookOpenText },
  { id: "characters", label: "人物设定", icon: UsersRound },
  { id: "scripts", label: "剧本工作台", icon: FileText },
  { id: "breakdown", label: "生产拆解", icon: ScanLine },
  { id: "assets", label: "资产中心", icon: Boxes },
  { id: "shots", label: "分镜预演", icon: Clapperboard },
  { id: "agent", label: "AI 创作 Agent", icon: Bot },
  { id: "delivery", label: "成片交付", icon: Film },
];

const globalNav: NavItem[] = [{ id: "models", label: "AI 模型中心", icon: Cpu, global: true }];

const viewCopy: Record<ViewId, { kicker: string; title: string; description: string }> = {
  overview: { kicker: "PROJECT CONTROL", title: "项目制片驾驶舱", description: "当前项目的内容、资产和 Agent 记录全部来自持久化数据库。" },
  story: { kicker: "STORY BIBLE", title: "故事设计", description: "编辑并保存当前项目的核心命题、世界观、冲突与故事圣经。" },
  characters: { kicker: "CHARACTER SYSTEM", title: "人物设定", description: "项目角色独立存储，切换项目时人物与关系会随之切换。" },
  scripts: { kicker: "SCRIPT ROOM", title: "剧本工作台", description: "以剧本和场次为结构组织正文、对白与制作信息。" },
  breakdown: { kicker: "PRODUCTION BREAKDOWN", title: "生产拆解", description: "从数据库中的场次汇总人物、服装、道具、地点和时长。" },
  assets: { kicker: "ASSET LIBRARY", title: "资产中心", description: "统一管理图片、视频、音频、3D 模型及传统制片资产。" },
  shots: { kicker: "PREVIS", title: "分镜与预演", description: "把剧本场次和多媒体资产组合为可进入制作的镜头上下文。" },
  agent: { kicker: "CONTEXTUAL AGENT", title: "AI 创作 Agent", description: "选择模型、故事、人物、剧本与资产，发起真实分析并保存运行记录。" },
  delivery: { kicker: "DELIVERY", title: "成片交付", description: "追踪模型分析、视频与音频资产，为剪辑和交付准备完整材料。" },
  models: { kicker: "GLOBAL MODEL REGISTRY", title: "AI 模型中心", description: "跨项目管理模型地址、等级、能力和加密保存的 API Key。" },
};

function projectProgress(data: WorkspaceBootstrap): number {
  const story = data.story as StoryRecord | null;
  const checks = [
    Boolean(story?.logline),
    data.characters.length > 0,
    data.scripts.length > 0,
    data.scripts.some((script) => script.scenes.length > 0),
    data.assets.length > 0,
    data.agentRuns.some((run) => run.status === "completed"),
  ];
  return Math.round((checks.filter(Boolean).length / checks.length) * 100);
}

function stageMeta(item: NavItem, data: WorkspaceBootstrap): { value: string; progress: number } {
  const story = data.story as StoryRecord | null;
  const scenes = data.scripts.flatMap((script) => script.scenes);
  switch (item.id) {
    case "overview": return { value: `${projectProgress(data)}%`, progress: projectProgress(data) };
    case "story": return { value: story?.status === "locked" ? "已锁定" : "编辑中", progress: story?.logline ? 88 : 20 };
    case "characters": return { value: `${data.characters.length} 人`, progress: Math.min(100, data.characters.length * 25) };
    case "scripts": return { value: `${data.scripts.length} 份`, progress: Math.min(100, data.scripts.length * 30) };
    case "breakdown": return { value: `${scenes.length} 场`, progress: scenes.length ? 65 : 0 };
    case "assets": return { value: `${data.assets.length} 项`, progress: Math.min(100, data.assets.length * 10) };
    case "shots": return { value: `${data.assets.filter((asset) => asset.type === "image" || asset.type === "video").length} 个`, progress: Math.min(100, data.assets.filter((asset) => asset.type === "image" || asset.type === "video").length * 14) };
    case "agent": return { value: `${data.agentRuns.length} 次`, progress: data.agentRuns.length ? 55 : 0 };
    case "delivery": return { value: `${data.assets.filter((asset) => asset.type === "video" || asset.type === "audio").length} 项`, progress: Math.min(100, data.assets.filter((asset) => asset.type === "video" || asset.type === "audio").length * 18) };
    default: return { value: `${data.models.length} 个`, progress: data.models.some((model) => model.hasApiKey) ? 100 : 40 };
  }
}

function LoadingWorkspace() {
  return (
    <div className="platform-state" role="status">
      <LoaderCircle className="spin" size={24} />
      <div><b>正在连接项目数据库</b><span>加载项目、剧本、资产与 Agent 记录…</span></div>
    </div>
  );
}

function OverviewView({ data, navigate, onOpenRun }: { data: WorkspaceBootstrap; navigate: (view: ViewId) => void; onOpenRun: (runId: string) => void }) {
  const project = data.project;
  const story = data.story as StoryRecord | null;
  const episodes = data.episodes as EpisodeRecord[];
  const completedRuns = data.agentRuns.filter((run) => run.status === "completed");
  const readyModels = data.models.filter((model) => model.enabled && model.hasApiKey);

  return (
    <div className="view-stack">
      <section className="metric-grid">
        <article className="metric-card metric-card-accent"><span>项目完整度</span><strong>{projectProgress(data)}%</strong><div className="mini-progress"><i style={{ width: `${projectProgress(data)}%` }} /></div></article>
        <article className="metric-card"><span>数据库内容</span><strong>{episodes.length}<small>集 · {data.scripts.length} 份剧本</small></strong><p>所有内容已按项目隔离保存</p></article>
        <article className="metric-card"><span>多媒体资产</span><strong>{data.assets.length}<small>项</small></strong><p>{new Set(data.assets.map((asset) => asset.type)).size} 种资产类型</p></article>
        <article className="metric-card"><span>可用模型</span><strong>{readyModels.length}<small>个</small></strong><p>{completedRuns.length} 次真实分析已完成</p></article>
      </section>

      <section className="database-hero">
        <div className="database-hero-copy">
          <span className="section-kicker">CURRENT PROJECT · D1</span>
          <h2>{project?.name}</h2>
          <p>{story?.logline || project?.description || "为这个项目补充一句核心故事命题。"}</p>
          <div className="project-facts"><span>{project?.genre}</span><span>{project?.episodeCount} 集</span><span>单集 {project?.singleEpisodeDuration} 秒</span><span>{project?.aspectRatio}</span><span>{project?.targetPlatform}</span></div>
        </div>
        <button className="continue-button" onClick={() => navigate("agent")}><Sparkles size={17} /><span><b>让 Agent 分析当前项目</b><small>选择模型与项目上下文</small></span><ArrowRight size={17} /></button>
      </section>

      <section className="overview-grid">
        <div className="surface production-map">
          <div className="section-heading"><div><span className="section-kicker">LIVE PIPELINE</span><h2>数据库驱动的制作链路</h2></div><span className="database-status"><i /> 实时数据</span></div>
          <div className="pipeline">
            {productionNav.slice(1, 9).map((item, index) => {
              const meta = stageMeta(item, data);
              return <button className="pipeline-step" key={item.id} onClick={() => navigate(item.id)}><span className={`step-dot ${meta.progress >= 80 ? "complete" : meta.progress > 0 ? "active" : ""}`}>{meta.progress >= 80 ? <Check size={13} /> : index + 1}</span><span><b>{item.label}</b><small>{meta.value}</small></span>{index < 7 && <i />}</button>;
            })}
          </div>
        </div>
        <div className="surface recent-runs">
          <div className="section-heading"><div><span className="section-kicker">AGENT HISTORY</span><h2>最近分析</h2></div><button className="round-add" aria-label="进入 Agent" onClick={() => navigate("agent")}><ArrowRight size={16} /></button></div>
          <div className="run-compact-list">
            {data.agentRuns.slice(0, 4).map((run) => <button key={run.id} onClick={() => onOpenRun(run.id)}><span className={`run-dot ${run.status}`} /><span><b>{run.modelName}</b><small>{run.prompt}</small></span><em>{run.status === "completed" ? "已完成" : run.status === "failed" ? "失败" : "运行中"}</em></button>)}
            {data.agentRuns.length === 0 && <div className="compact-empty"><Bot size={20} /><span>还没有 Agent 运行记录</span></div>}
          </div>
        </div>
      </section>
    </div>
  );
}

function StoryView({ projectId, story, episodes, onSaved }: { projectId: string; story: StoryRecord | null; episodes: EpisodeRecord[]; onSaved: () => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [draft, setDraft] = useState(() => storyToDraft(story));

  function cancelEditing() {
    setDraft(storyToDraft(story));
    setMessage("");
    setEditing(false);
  }

  async function save() {
    setSaving(true);
    setMessage("");
    try {
      await apiRequest(`/api/projects/${encodeURIComponent(projectId)}/story`, {
        method: "PATCH",
        body: JSON.stringify({ ...draft, themes: draft.themes.split(/[、,，]/).map((item) => item.trim()).filter(Boolean) }),
      });
      await onSaved();
      setEditing(false);
      setMessage("故事圣经已保存到数据库");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "保存失败");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="view-stack">
      <section className="story-editor surface">
        <div className="section-heading">
          <div><span className="section-kicker">SAVED STORY STATE</span><h2>{story?.title || "未命名故事"}</h2></div>
          <div className="heading-actions"><span className="persisted-label"><Database size={13} /> 已持久化</span>{editing ? <><button className="quiet-button" onClick={cancelEditing} disabled={saving}>取消</button><button className="primary-button" onClick={save} disabled={saving}>{saving ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />} 保存</button></> : <button className="quiet-button" onClick={() => { setDraft(storyToDraft(story)); setMessage(""); setEditing(true); }}><PencilLine size={15} /> 编辑故事</button>}</div>
        </div>
        {message && <div className="inline-message" role="status">{message}</div>}
        <div className="story-form-grid">
          <label className="field wide"><span>核心命题</span>{editing ? <textarea rows={3} value={draft.logline} onChange={(event) => setDraft((current) => ({ ...current, logline: event.target.value }))} /> : <strong>{story?.logline || "尚未填写"}</strong>}</label>
          <label className="field wide"><span>故事梗概</span>{editing ? <textarea rows={5} value={draft.synopsis} onChange={(event) => setDraft((current) => ({ ...current, synopsis: event.target.value }))} /> : <p>{story?.synopsis || "尚未填写"}</p>}</label>
          <label className="field"><span>世界观</span>{editing ? <textarea rows={5} value={draft.worldview} onChange={(event) => setDraft((current) => ({ ...current, worldview: event.target.value }))} /> : <p>{story?.worldview || "尚未填写"}</p>}</label>
          <label className="field"><span>核心冲突</span>{editing ? <textarea rows={5} value={draft.coreConflict} onChange={(event) => setDraft((current) => ({ ...current, coreConflict: event.target.value }))} /> : <p>{story?.coreConflict || "尚未填写"}</p>}</label>
          <label className="field"><span>主题关键词</span>{editing ? <input value={draft.themes} onChange={(event) => setDraft((current) => ({ ...current, themes: event.target.value }))} /> : <div className="theme-tags">{story?.themes?.map((theme) => <i key={theme}>{theme}</i>)}</div>}</label>
          <label className="field"><span>视觉风格</span>{editing ? <textarea rows={3} value={draft.styleReference} onChange={(event) => setDraft((current) => ({ ...current, styleReference: event.target.value }))} /> : <p>{story?.styleReference || "尚未填写"}</p>}</label>
          <label className="field wide"><span>硬性设定 / 故事圣经</span>{editing ? <textarea rows={4} value={draft.storyBible} onChange={(event) => setDraft((current) => ({ ...current, storyBible: event.target.value }))} /> : <p>{story?.storyBible || "尚未填写"}</p>}</label>
        </div>
      </section>
      <section className="surface">
        <div className="section-heading"><div><span className="section-kicker">EPISODE DATA</span><h2>分集大纲</h2></div><span className="count-badge">{episodes.length} 集</span></div>
        <div className="episode-list database-list">{episodes.map((episode) => <article className="episode-row" key={episode.id}><span className="episode-no">EP.{String(episode.episodeNo).padStart(2, "0")}</span><span className="episode-main"><b>{episode.title}</b><small>{episode.hook || episode.summary || "待补充本集钩子"}</small></span><span className="status-label">{episode.status}</span></article>)}</div>
      </section>
    </div>
  );
}

function CharactersView({ projectId, characters, onSaved }: { projectId: string; characters: CharacterRecord[]; onSaved: () => Promise<void> }) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [form, setForm] = useState({ name: "", role: "", bio: "", appearance: "", personality: "", arc: "", voice: "" });
  const nameInputRef = useRef<HTMLInputElement>(null);

  const resetForm = useCallback(() => {
    setForm({ name: "", role: "", bio: "", appearance: "", personality: "", arc: "", voice: "" });
    setError("");
  }, []);

  const closeDialog = useCallback(() => {
    if (saving) return;
    setDialogOpen(false);
    resetForm();
  }, [resetForm, saving]);

  useEffect(() => {
    if (!dialogOpen) return;
    const focusTimer = window.setTimeout(() => nameInputRef.current?.focus(), 0);
    function handleEscape(event: KeyboardEvent) {
      if (event.key === "Escape" && !saving) closeDialog();
    }
    window.addEventListener("keydown", handleEscape);
    return () => {
      window.clearTimeout(focusTimer);
      window.removeEventListener("keydown", handleEscape);
    };
  }, [closeDialog, dialogOpen, saving]);

  function openDialog() {
    resetForm();
    setMessage("");
    setDialogOpen(true);
  }

  async function createCharacter(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      await apiRequest(`/api/projects/${encodeURIComponent(projectId)}/characters`, { method: "POST", body: JSON.stringify(form) });
      setDialogOpen(false);
      resetForm();
      setMessage("人物已保存，正在刷新人物列表。");
      try {
        await onSaved();
        setMessage("人物已保存到当前项目。");
      } catch {
        setMessage("人物已保存，但列表刷新失败；请使用顶栏刷新按钮重试。");
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "人物保存失败");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="view-stack">
      <div className="view-toolbar"><div><Database size={15} /><span>{characters.length} 张人物卡来自当前项目数据库</span></div><button className="primary-button" onClick={openDialog}><Plus size={15} /> 新增人物</button></div>
      {message && <div className="inline-message" role="status">{message}</div>}
      <section className="character-grid">
        {characters.map((character, index) => <article className="character-card" key={character.id}><div className={`character-portrait ${["coral", "blue", "sand"][index % 3]}`}><span>{character.name.slice(0, 1)}</span><small>{character.status}</small></div><div className="character-content"><div className="character-title"><div><h2>{character.name}</h2><p>{character.role}</p></div><MoreHorizontal size={17} /></div><dl><div><dt>人物小传</dt><dd>{character.bio || "待补充"}</dd></div><div><dt>视觉锚点</dt><dd>{character.appearance || "待补充"}</dd></div><div><dt>人物弧</dt><dd>{character.arc || "待补充"}</dd></div></dl><div className="character-footer"><span><Database size={12} /> {character.status}</span><span>{character.relationships?.length ?? 0} 条关系</span></div></div></article>)}
        {characters.length === 0 && <button className="add-character" onClick={openDialog}><Plus size={24} /><b>创建第一位角色</b><span>角色会被保存到当前项目</span></button>}
      </section>
      {dialogOpen && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) closeDialog(); }}><form className="modal-card" role="dialog" aria-modal="true" aria-labelledby="character-dialog-title" onSubmit={createCharacter}><div className="modal-head"><div><span className="section-kicker">NEW CHARACTER</span><h2 id="character-dialog-title">新增人物卡</h2></div><button type="button" className="icon-button" aria-label="关闭" onClick={closeDialog} disabled={saving}><X size={17} /></button></div><div className="modal-fields"><label><span>姓名 *</span><input ref={nameInputRef} required value={form.name} onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))} /></label><label><span>角色定位</span><input value={form.role} onChange={(event) => setForm((current) => ({ ...current, role: event.target.value }))} placeholder="主角 / 反派 / 关键角色" /></label><label className="wide"><span>人物小传</span><textarea rows={3} value={form.bio} onChange={(event) => setForm((current) => ({ ...current, bio: event.target.value }))} /></label><label><span>外形与视觉锚点</span><textarea rows={3} value={form.appearance} onChange={(event) => setForm((current) => ({ ...current, appearance: event.target.value }))} /></label><label><span>性格</span><textarea rows={3} value={form.personality} onChange={(event) => setForm((current) => ({ ...current, personality: event.target.value }))} /></label><label><span>人物弧</span><textarea rows={3} value={form.arc} onChange={(event) => setForm((current) => ({ ...current, arc: event.target.value }))} /></label><label><span>声音设定</span><textarea rows={3} value={form.voice} onChange={(event) => setForm((current) => ({ ...current, voice: event.target.value }))} /></label></div>{error && <div className="form-error"><AlertCircle size={14} />{error}</div>}<div className="modal-actions"><button type="button" className="quiet-button" onClick={closeDialog} disabled={saving}>取消</button><button type="submit" className="primary-button" disabled={saving}>{saving ? <LoaderCircle className="spin" size={15} /> : <Database size={15} />} 保存人物</button></div></form></div>}
    </div>
  );
}

function ScriptsView({ scripts, onOpenAgent }: { scripts: ProjectScript[]; onOpenAgent: () => void }) {
  const [selectedId, setSelectedId] = useState(scripts[0]?.id ?? "");
  const effectiveSelectedId = scripts.some((item) => item.id === selectedId) ? selectedId : scripts[0]?.id ?? "";
  const script = scripts.find((item) => item.id === effectiveSelectedId) ?? scripts[0];
  const scenes = (script?.scenes ?? []) as SceneRecord[];
  if (!script) return <div className="platform-state"><FileText size={24} /><div><b>当前项目还没有剧本</b><span>可从分集大纲创建第一份剧本。</span></div></div>;
  return (
    <div className="script-workspace">
      <section className="surface scene-navigator"><div className="section-heading"><div><span className="section-kicker">DATABASE SCRIPTS</span><h2>剧本</h2></div><span className="count-badge">{scripts.length}</span></div><div className="scene-list">{scripts.map((item) => <button key={item.id} className={item.id === script.id ? "active" : ""} onClick={() => setSelectedId(item.id)}><span className="scene-id">v{String(item.version ?? 1)}</span><span><b>{item.title}</b><small>{item.status} · {item.scenes.length} 场</small></span><i className={item.status === "review" ? "review" : ""} /></button>)}</div></section>
      <section className="script-paper"><div className="paper-toolbar"><span><Database size={15} /> {script.title} · v{String(script.version ?? 1)}</span><button className="quiet-button" onClick={onOpenAgent}><Sparkles size={14} /> 交给 Agent</button></div><article className="screenplay"><p className="scene-heading-line">{scenes[0]?.heading || script.title}</p><p className="action-line">{scenes[0]?.action || String(script.bodyText ?? script.content ?? "尚未填写剧本正文。")}</p>{scenes[0]?.dialogue?.map((line, index) => <div className="dialogue-block" key={`${line.character}-${index}`}><p className="speaker-line">{line.character}</p><p className="dialogue-line">{line.line}</p></div>)}<div className="script-note"><Database size={15} /><span><b>持久化状态</b>正文、版本与 {scenes.length} 个场次已保存在当前项目中。</span></div></article><footer className="paper-footer"><span>{scenes.reduce((total, scene) => total + Number(scene.durationSeconds ?? 0), 0)} 秒预估时长</span><span>{script.status}</span></footer></section>
    </div>
  );
}

function BreakdownView({ scripts }: { scripts: ProjectScript[] }) {
  const rows = scripts.flatMap((script) => (script.scenes as SceneRecord[]).map((scene) => ({ script, scene })));
  return (
    <div className="view-stack"><section className="metric-grid compact"><article className="metric-card"><span>已拆解场次</span><strong>{rows.length}<small>场</small></strong><p>来自数据库中的结构化场次</p></article><article className="metric-card"><span>涉及角色</span><strong>{new Set(rows.flatMap(({ scene }) => scene.characters ?? [])).size}<small>人</small></strong><p>自动汇总人物引用</p></article><article className="metric-card"><span>制片要素</span><strong>{rows.reduce((total, { scene }) => total + (scene.props?.length ?? 0) + (scene.wardrobe?.length ?? 0), 0)}<small>项</small></strong><p>服装与道具引用</p></article></section><section className="surface breakdown-table-wrap"><div className="section-heading"><div><span className="section-kicker">LIVE BREAKDOWN</span><h2>场次生产清单</h2></div><span className="database-status"><i /> D1 查询结果</span></div><div className="responsive-table"><table className="breakdown-table"><thead><tr><th>剧本 / 场次</th><th>地点</th><th>人物</th><th>服装</th><th>道具</th><th>时长</th></tr></thead><tbody>{rows.map(({ script, scene }) => <tr key={scene.id}><td><b>{script.title}</b><br />#{scene.sceneNo} {scene.heading}</td><td>{scene.location || "—"} · {scene.timeOfDay || "—"}</td><td>{scene.characters?.join("、") || "—"}</td><td>{scene.wardrobe?.join("、") || "—"}</td><td>{scene.props?.join("、") || "—"}</td><td>{scene.durationSeconds ?? 0}s</td></tr>)}</tbody></table></div>{rows.length === 0 && <div className="compact-empty"><ScanLine size={20} /><span>创建场次后会自动形成拆解表</span></div>}</section></div>
  );
}

function ShotsView({ scripts, assets, onAssets }: { scripts: ProjectScript[]; assets: ProjectAsset[]; onAssets: () => void }) {
  const visualAssets = assets.filter((asset) => asset.type === "image" || asset.type === "video" || asset.type === "model3d" || asset.type === "scene");
  const scenes = scripts.flatMap((script) => script.scenes as SceneRecord[]);
  const icons: Record<string, LucideIcon> = { image: ImageIcon, video: Video, model3d: Layers3, scene: Clapperboard };
  return <div className="view-stack"><section className="previz-bar"><div className="play-button"><Clapperboard size={18} /></div><div><span className="section-kicker">PREVIS SOURCES</span><h2>{scenes.length} 场剧本 · {visualAssets.length} 项视觉资产</h2></div><div className="previz-time"><b>{visualAssets.length}</b><span>可用素材</span></div><div className="previz-line"><i style={{ width: `${Math.min(100, visualAssets.length * 18)}%` }} /></div><button className="quiet-button" onClick={onAssets}><Plus size={15} /> 添加素材</button></section><section className="visual-source-grid">{visualAssets.map((asset) => { const Icon = icons[asset.type] ?? Boxes; return <article key={asset.id}><div className={`visual-source-preview type-${asset.type}`}>{asset.thumbnailUrl || asset.sourceUrl ? <img src={asset.thumbnailUrl || asset.sourceUrl || ""} alt="" /> : <Icon size={28} />}<span>{asset.type.toUpperCase()}</span></div><div><b>{asset.name}</b><small>{asset.description || "暂无描述"}</small></div></article>; })}{visualAssets.length === 0 && <button className="add-character" onClick={onAssets}><Plus size={24} /><b>添加首个视觉资产</b><span>支持图片、视频、3D 模型和场景资产</span></button>}</section></div>;
}

function DeliveryView({ assets, runs, onAgent }: { assets: ProjectAsset[]; runs: AgentRun[]; onAgent: () => void }) {
  const counts = { video: assets.filter((asset) => asset.type === "video").length, audio: assets.filter((asset) => asset.type === "audio").length, image: assets.filter((asset) => asset.type === "image").length, model3d: assets.filter((asset) => asset.type === "model3d").length };
  return <div className="view-stack"><section className="delivery-hero"><div><span className="section-kicker">PERSISTENT PRODUCTION STATE</span><h2>项目生产材料已集中管理</h2><p>Agent 分析、上传素材和外部资产均保留在项目中，可继续接入生成任务与剪辑服务。</p></div><button className="primary-button" onClick={onAgent}><Bot size={16} /> 发起生产分析</button></section><section className="delivery-type-grid">{[[Video, "视频", counts.video], [FileAudio, "音频", counts.audio], [ImageIcon, "图片", counts.image], [Layers3, "3D 模型", counts.model3d]].map(([Icon, label, count]) => { const AssetIcon = Icon as LucideIcon; return <article key={String(label)}><AssetIcon size={19} /><span>{String(label)}</span><strong>{String(count)}</strong></article>; })}</section><section className="surface job-panel"><div className="section-heading"><div><span className="section-kicker">AGENT OUTPUTS</span><h2>最近分析记录</h2></div><span className="count-badge">{runs.length}</span></div><div className="job-list">{runs.slice(0, 8).map((run) => <div className="job-row" key={run.id}><div className="job-icon"><Bot size={18} /></div><div className="job-copy"><div><b>{run.prompt}</b><span>{run.status}</span></div><p>{run.modelName} · {run.sources.length} 个来源</p><div className="job-progress"><i style={{ width: run.status === "completed" ? "100%" : run.status === "failed" ? "18%" : "62%" }} /></div></div><strong>{run.status === "completed" ? "完成" : run.status}</strong></div>)}</div></section></div>;
}

function NewProjectDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (projectId: string) => Promise<void> }) {
  const [form, setForm] = useState({ name: "", genre: "都市悬疑", description: "", episodeCount: "12", singleEpisodeDuration: "120", aspectRatio: "9:16", targetPlatform: "抖音 / 快手" });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const nameInputRef = useRef<HTMLInputElement>(null);

  const closeDialog = useCallback(() => {
    if (!saving) onClose();
  }, [onClose, saving]);

  useEffect(() => {
    const focusTimer = window.setTimeout(() => nameInputRef.current?.focus(), 0);
    function handleEscape(event: KeyboardEvent) {
      if (event.key === "Escape" && !saving) closeDialog();
    }
    window.addEventListener("keydown", handleEscape);
    return () => {
      window.clearTimeout(focusTimer);
      window.removeEventListener("keydown", handleEscape);
    };
  }, [closeDialog, saving]);

  async function submit(event: React.FormEvent) {
    event.preventDefault(); setSaving(true); setError("");
    try {
      const result = await apiRequest<{ project: Project; activeProjectId: string }>("/api/projects", { method: "POST", body: JSON.stringify({ ...form, episodeCount: Number(form.episodeCount), singleEpisodeDuration: Number(form.singleEpisodeDuration) }) });
      onClose();
      void onCreated(result.project.id);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "项目创建失败"); } finally { setSaving(false); }
  }
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) closeDialog(); }}><form className="modal-card project-modal" role="dialog" aria-modal="true" aria-labelledby="new-project-dialog-title" onSubmit={submit}><div className="modal-head"><div><span className="section-kicker">NEW PROJECT</span><h2 id="new-project-dialog-title">创建短剧项目</h2><p>项目创建后将自动拥有独立的故事、剧本和资产空间。</p></div><button type="button" className="icon-button" aria-label="关闭" onClick={closeDialog} disabled={saving}><X size={17} /></button></div><div className="modal-fields"><label><span>项目名称 *</span><input ref={nameInputRef} required value={form.name} onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))} placeholder="例如：雾港来信" /></label><label><span>题材</span><input value={form.genre} onChange={(event) => setForm((current) => ({ ...current, genre: event.target.value }))} /></label><label className="wide"><span>项目简介</span><textarea rows={3} value={form.description} onChange={(event) => setForm((current) => ({ ...current, description: event.target.value }))} /></label><label><span>集数</span><input type="number" min="1" max="500" required value={form.episodeCount} onChange={(event) => setForm((current) => ({ ...current, episodeCount: event.target.value }))} /></label><label><span>单集时长（秒）</span><input type="number" min="15" required value={form.singleEpisodeDuration} onChange={(event) => setForm((current) => ({ ...current, singleEpisodeDuration: event.target.value }))} /></label><label><span>画幅</span><select value={form.aspectRatio} onChange={(event) => setForm((current) => ({ ...current, aspectRatio: event.target.value }))}><option>9:16</option><option>16:9</option><option>1:1</option></select></label><label><span>目标平台</span><input value={form.targetPlatform} onChange={(event) => setForm((current) => ({ ...current, targetPlatform: event.target.value }))} /></label></div>{error && <div className="form-error"><AlertCircle size={14} />{error}</div>}<div className="modal-actions"><button type="button" className="quiet-button" onClick={closeDialog} disabled={saving}>取消</button><button type="submit" className="primary-button" disabled={saving}>{saving ? <LoaderCircle className="spin" size={15} /> : <Plus size={15} />} 创建并进入</button></div></form></div>;
}

export default function Home() {
  const [data, setData] = useState<WorkspaceBootstrap | null>(null);
  const [activeView, setActiveView] = useState<ViewId>("overview");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [switchingProject, setSwitchingProject] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [selectedAgentRunId, setSelectedAgentRunId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const workspaceRequestSequence = useRef(0);
  const workspaceTargetProjectId = useRef<string | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const loadWorkspace = useCallback(async (projectId?: string, quiet = false) => {
    if (projectId && workspaceTargetProjectId.current && projectId !== workspaceTargetProjectId.current) return false;
    const sequence = ++workspaceRequestSequence.current;
    if (quiet) setRefreshing(true);
    else setLoading(true);
    setError("");
    try {
      const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
      const workspace = await apiRequest<WorkspaceBootstrap>(`/api/bootstrap${query}`, { cache: "no-store" });
      if (sequence !== workspaceRequestSequence.current) return false;
      if (projectId && workspaceTargetProjectId.current && projectId !== workspaceTargetProjectId.current) return false;
      setData(workspace);
      workspaceTargetProjectId.current = workspace.activeProjectId;
      setRefreshKey((current) => current + 1);
      return true;
    } catch (reason) {
      if (sequence !== workspaceRequestSequence.current) return false;
      setError(reason instanceof Error ? reason.message : "无法加载项目数据库");
      return false;
    } finally {
      if (sequence === workspaceRequestSequence.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadWorkspace(), 0);
    return () => window.clearTimeout(timer);
  }, [loadWorkspace]);

  const navigate = useCallback((view: ViewId) => {
    if (view === "agent") setSelectedAgentRunId(null);
    setActiveView(view);
    setMobileNavOpen(false);
    setSearchOpen(false);
    setNotificationsOpen(false);
    setUserMenuOpen(false);
  }, []);
  const currentCopy = viewCopy[activeView];
  const project = data?.project ?? null;
  const userInitial = data?.workspace.displayName?.slice(0, 1) || "影";

  const searchResults = useMemo<SearchResult[]>(() => {
    const needle = search.trim().toLocaleLowerCase("zh-CN");
    if (!needle || !data) return [];
    const results: SearchResult[] = [];
    const add = (result: SearchResult, haystack: string) => {
      if (haystack.toLocaleLowerCase("zh-CN").includes(needle)) results.push(result);
    };
    for (const character of data.characters) {
      add({ id: `character-${character.id}`, view: "characters", title: character.name || "未命名人物", detail: "人物卡" }, `${character.name ?? ""} ${String(character.role ?? "")} ${String(character.bio ?? "")}`);
    }
    for (const script of data.scripts) {
      add({ id: `script-${script.id}`, view: "scripts", title: script.title || "未命名剧本", detail: `剧本 · ${script.scenes?.length ?? 0} 场` }, `${script.title ?? ""} ${script.status ?? ""} ${String(script.bodyText ?? script.content ?? "")}`);
    }
    for (const asset of data.assets) {
      add({ id: `asset-${asset.id}`, view: "assets", title: asset.name, detail: `资产 · ${asset.type}` }, `${asset.name} ${asset.description ?? ""} ${asset.type}`);
    }
    for (const run of data.agentRuns) {
      add({ id: `run-${run.id}`, view: "agent", title: run.prompt || "未命名分析", detail: `Agent · ${run.modelName}`, agentRunId: run.id }, `${run.prompt} ${run.modelName} ${run.response ?? ""}`);
    }
    return results.slice(0, 10);
  }, [data, search]);

  const openAgentRun = useCallback((runId: string) => {
    setSelectedAgentRunId(runId);
    setActiveView("agent");
    setMobileNavOpen(false);
    setSearchOpen(false);
  }, []);

  function openSearchResult(result: SearchResult) {
    setSearch("");
    if (result.agentRunId) openAgentRun(result.agentRunId);
    else navigate(result.view);
  }

  useEffect(() => {
    function handleGlobalKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase("en-US") === "k") {
        event.preventDefault();
        searchInputRef.current?.focus();
        setSearchOpen(true);
      } else if (event.key === "Escape") {
        setSearchOpen(false);
        setNotificationsOpen(false);
        setUserMenuOpen(false);
      }
    }
    window.addEventListener("keydown", handleGlobalKeyDown);
    return () => window.removeEventListener("keydown", handleGlobalKeyDown);
  }, []);

  async function switchProject(projectId: string) {
    if (!projectId || projectId === data?.activeProjectId || switchingProject || refreshing) return;
    setSwitchingProject(true);
    setSelectedAgentRunId(null);
    workspaceTargetProjectId.current = projectId;
    try {
      await apiRequest(`/api/projects/${encodeURIComponent(projectId)}/activate`, { method: "POST" });
      await loadWorkspace(projectId, true);
    } catch (reason) {
      workspaceTargetProjectId.current = data?.activeProjectId ?? null;
      setError(reason instanceof Error ? reason.message : "项目切换失败");
    } finally {
      setSwitchingProject(false);
    }
  }

  return (
    <div className="app-shell">
      <div className={`mobile-scrim ${mobileNavOpen ? "visible" : ""}`} onClick={() => setMobileNavOpen(false)} />
      <aside className={`sidebar ${mobileNavOpen ? "open" : ""}`}>
        <div className="brand-lockup"><div className="brand-mark"><span /><span /></div><div><b>影序</b><small>FRAMEFLOW</small></div><button className="sidebar-close" aria-label="关闭菜单" onClick={() => setMobileNavOpen(false)}><X size={18} /></button></div>
        <div className="db-project-switcher">
          <label htmlFor="project-switcher">当前项目</label>
          <div><span className="project-avatar">{project?.name?.slice(0, 1) || "项"}</span><select id="project-switcher" value={data?.activeProjectId ?? ""} disabled={!data || switchingProject || refreshing} onChange={(event) => void switchProject(event.target.value)}>{data?.projects.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select>{switchingProject || refreshing ? <LoaderCircle className="spin" size={15} /> : <ChevronDown size={15} />}</div>
          <button type="button" onClick={() => setNewProjectOpen(true)} disabled={switchingProject || refreshing}><Plus size={14} /> 新建项目</button>
        </div>
        <div className="nav-label">项目制作流程</div>
        <nav className="stage-nav" aria-label="项目制作阶段">
          {productionNav.map((item, index) => { const Icon = item.icon; const meta = data ? stageMeta(item, data) : { value: "—", progress: 0 }; const active = activeView === item.id; return <button key={item.id} className={active ? "active" : ""} aria-current={active ? "page" : undefined} onClick={() => navigate(item.id)}><span className="nav-icon"><Icon size={17} /></span><span className="nav-copy"><b>{item.label}</b><small>{meta.value}</small></span>{meta.progress >= 90 ? <CheckCircle2 className="nav-state complete" size={15} /> : meta.progress > 0 ? <span className="nav-progress">{meta.progress}</span> : <CircleDotDashed className="nav-state" size={15} />}{index > 0 && index < productionNav.length - 1 && <i className="nav-rail" />}</button>; })}
        </nav>
        <div className="nav-label global-label">跨项目设置</div>
        <nav className="stage-nav global-stage-nav" aria-label="跨项目设置">{globalNav.map((item) => { const Icon = item.icon; return <button key={item.id} className={activeView === item.id ? "active" : ""} onClick={() => navigate(item.id)}><span className="nav-icon"><Icon size={17} /></span><span className="nav-copy"><b>{item.label}</b><small>{data?.models.length ?? 0} 个配置</small></span><Database className="nav-state" size={15} /></button>; })}</nav>
        <div className="sidebar-spacer" />
        <div className="backend-health"><div><Database size={15} /><span><b>后端服务</b><small>D1 数据库 · R2 资产存储</small></span><i /></div><p>项目数据、模型配置和 Agent 记录均由服务端管理。</p></div>
        <div className="sidebar-user"><span className="user-avatar">{userInitial}</span><span><b>{data?.workspace.displayName || "正在认证"}</b><small>{data?.workspace.email || "私密工作区"}</small></span><button type="button" aria-label="打开用户信息" aria-expanded={userMenuOpen} aria-controls="user-info-panel" onClick={() => { setUserMenuOpen((current) => !current); setNotificationsOpen(false); }}><MoreHorizontal size={17} /></button>{userMenuOpen && <div id="user-info-panel" className="shell-popover sidebar-popover" role="dialog" aria-label="用户信息"><div><b>{data?.workspace.displayName || "当前用户"}</b><small>{data?.workspace.email || "私密工作区"}</small></div><p>当前为私密工作区，项目数据按账户隔离。</p><button type="button" className="quiet-button" onClick={() => setUserMenuOpen(false)}>关闭</button></div>}</div>
      </aside>

      <div className="app-stage">
        <header className="topbar"><div className="topbar-left"><button className="mobile-menu" aria-label="打开项目导航" onClick={() => setMobileNavOpen(true)}><Menu size={19} /></button><div className="breadcrumb"><span>{activeView === "models" ? "跨项目" : project?.name || "项目"}</span><ChevronRight size={13} /><b>{currentCopy.title}</b></div></div><div className="topbar-center" onFocus={() => setSearchOpen(true)} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setSearchOpen(false); }}><Search size={15} /><input ref={searchInputRef} role="combobox" aria-autocomplete="list" aria-haspopup="listbox" value={search} onChange={(event) => { setSearch(event.target.value); setSearchOpen(true); }} aria-label="搜索项目内容" aria-controls="workspace-search-results" aria-expanded={searchOpen && Boolean(search.trim())} placeholder="搜索人物、剧本、资产或 Agent 记录" /><kbd>⌘ K</kbd>{searchOpen && search.trim() && <div id="workspace-search-results" className="search-results" role="listbox" aria-label="搜索结果">{searchResults.length > 0 ? searchResults.map((result) => <button type="button" role="option" aria-selected="false" key={result.id} onClick={() => openSearchResult(result)}><span><b>{result.title}</b><small>{result.detail}</small></span><ChevronRight size={14} /></button>) : <div className="search-empty" role="status">当前项目没有匹配内容</div>}</div>}</div><div className="topbar-right"><span className="database-pill"><Database size={12} /> {refreshing ? "正在同步" : "数据已持久化"}</span><button className="icon-button" aria-label={refreshing ? "正在刷新数据" : "刷新数据"} onClick={() => void loadWorkspace(workspaceTargetProjectId.current ?? data?.activeProjectId ?? undefined, true)} disabled={loading || refreshing || switchingProject}>{refreshing ? <LoaderCircle className="spin" size={16} /> : <RefreshCw size={16} />}</button><div className="notification-control"><button className="icon-button" type="button" aria-label="查看通知" aria-expanded={notificationsOpen} aria-controls="notification-panel" onClick={() => { setNotificationsOpen((current) => !current); setUserMenuOpen(false); }}><Bell size={16} /></button>{notificationsOpen && <div id="notification-panel" className="shell-popover notification-popover" role="dialog" aria-label="通知"><div><b>工作区状态</b><button type="button" className="popover-close" aria-label="关闭通知" onClick={() => setNotificationsOpen(false)}><X size={14} /></button></div><p>{error ? `最近一次同步失败：${error}` : `当前项目有 ${data?.agentRuns.length ?? 0} 条 Agent 记录、${data?.assets.length ?? 0} 项资产。`}</p><small>{refreshing ? "正在获取最新数据…" : "暂无其他未读通知"}</small></div>}</div></div></header>
        <main className="main-workspace full-width-workspace">
          {loading ? <LoadingWorkspace /> : error && !data ? <div className="platform-state error-state"><AlertCircle size={24} /><div><b>无法连接后端</b><span>{error}</span><button className="quiet-button" onClick={() => void loadWorkspace()}><RefreshCw size={14} /> 重试</button></div></div> : data && project ? <>
            <div className="page-heading"><div><span className="page-kicker">{currentCopy.kicker}</span><div className="title-row"><h1>{currentCopy.title}</h1><span className="version-badge">{activeView === "models" ? "跨项目通用" : project.name}</span></div><p>{currentCopy.description}</p></div><div className="heading-actions">{activeView !== "agent" && activeView !== "models" && <button className="quiet-button" onClick={() => navigate("agent")}><Bot size={15} /> 交给 Agent</button>}{activeView !== "models" && activeView !== "assets" && <button className="primary-button" onClick={() => navigate("assets")}><Plus size={15} /> 添加资产</button>}</div></div>
            {error && <div className="workspace-alert"><AlertCircle size={15} />{error}<button onClick={() => setError("")}><X size={14} /></button></div>}
            {activeView === "overview" && <OverviewView data={data} navigate={navigate} onOpenRun={openAgentRun} />}
            {activeView === "story" && <StoryView key={`${project.id}-${String((data.story as StoryRecord | null)?.updatedAt ?? "new")}`} projectId={project.id} story={data.story as StoryRecord | null} episodes={data.episodes as EpisodeRecord[]} onSaved={async () => { await loadWorkspace(project.id, true); }} />}
            {activeView === "characters" && <CharactersView key={project.id} projectId={project.id} characters={data.characters as CharacterRecord[]} onSaved={async () => { if (!await loadWorkspace(project.id, true)) throw new Error("人物列表刷新失败"); }} />}
            {activeView === "scripts" && <ScriptsView key={project.id} scripts={data.scripts} onOpenAgent={() => navigate("agent")} />}
            {activeView === "breakdown" && <BreakdownView scripts={data.scripts} />}
            {activeView === "assets" && <AssetManager key={project.id} refreshKey={refreshKey} projectId={project.id} projectName={project.name} onAssetsChange={(assets) => setData((current) => current?.project?.id === project.id ? { ...current, assets } : current)} />}
            {activeView === "shots" && <ShotsView scripts={data.scripts} assets={data.assets} onAssets={() => navigate("assets")} />}
            {activeView === "agent" && <AgentStudio key={project.id} refreshKey={refreshKey} initialRunId={selectedAgentRunId ?? undefined} projectId={project.id} projectName={project.name} onOpenModels={() => navigate("models")} onRunComplete={(run) => setData((current) => current?.project?.id === project.id && run.projectId === project.id ? { ...current, agentRuns: [run, ...current.agentRuns.filter((item) => item.id !== run.id)] } : current)} />}
            {activeView === "delivery" && <DeliveryView assets={data.assets} runs={data.agentRuns} onAgent={() => navigate("agent")} />}
            {activeView === "models" && <ModelCenter refreshKey={refreshKey} onModelsChange={(models: AiModel[]) => setData((current) => current ? { ...current, models } : current)} />}
          </> : null}
        </main>
      </div>
      {newProjectOpen && <NewProjectDialog onClose={() => setNewProjectOpen(false)} onCreated={async (projectId) => { workspaceTargetProjectId.current = projectId; await loadWorkspace(projectId, true); }} />}
    </div>
  );
}
