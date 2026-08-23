"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { LucideIcon } from "lucide-react";
import {
  AlertCircle,
  BookOpenText,
  Bot,
  Boxes,
  Check,
  CheckCircle2,
  Clapperboard,
  Database,
  FileText,
  LoaderCircle,
  ScanLine,
  Send,
  Sparkles,
  UsersRound,
} from "lucide-react";
import type { AgentRun, AiModel } from "@/lib/platform-types";
import { apiRequest, formatCompactDate, getModelCapabilities, isRecord } from "./platform-client";
import styles from "./StageAgentPanel.module.css";

export type StageAgentStage = "story" | "characters" | "scripts" | "breakdown" | "assets" | "shots";

export type StageAgentAction = {
  id?: string;
  type: string;
  title?: string;
  label?: string;
  summary?: string;
  description?: string;
  payload: Record<string, unknown>;
};

type StageAgentPlanResponse = {
  run?: AgentRun;
  reply?: string;
  message?: string;
  actions?: StageAgentAction[];
};

type StageAgentExecutionResult = {
  actionType?: string;
  success?: boolean;
  message?: string;
  entityId?: string;
};

type StageAgentExecuteResponse = {
  message?: string;
  results?: StageAgentExecutionResult[];
  actions?: StageAgentAction[];
};

type ChatMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt?: string;
  runId?: string;
  actions?: StageAgentAction[];
  executed?: boolean;
};

type StageConfig = {
  title: string;
  role: string;
  description: string;
  greeting: string;
  capability: string;
  icon: LucideIcon;
  prompts: string[];
};

export type StageAgentPanelProps = {
  projectId: string;
  projectName?: string;
  stage: StageAgentStage;
  models: AiModel[];
  runs?: AgentRun[];
  onOpenModels?: () => void;
  onRunRecorded?: (run: AgentRun) => void;
  onExecuted?: () => void | Promise<void>;
};

const STAGE_CONFIG: Record<StageAgentStage, StageConfig> = {
  story: {
    title: "故事策划 Agent",
    role: "STORY ARCHITECT",
    description: "读取故事圣经、项目定位与分集信息",
    greeting: "我会以当前项目的故事数据为准，帮你诊断结构、补全设定，并可把确认后的修改直接写回故事圣经。",
    capability: "可更新故事圣经",
    icon: BookOpenText,
    prompts: ["诊断当前故事结构，给出三项最优先的修改", "根据现有设定补全故事圣经", "整理一句话梗概、核心冲突和主题关键词"],
  },
  characters: {
    title: "人物导演 Agent",
    role: "CHARACTER DIRECTOR",
    description: "读取故事、现有人物卡与人物关系",
    greeting: "我会围绕戏剧功能、人物弧和视觉锚点工作；你确认方案后，我可以直接创建当前项目的人物卡。",
    capability: "可创建人物卡",
    icon: UsersRound,
    prompts: ["为当前故事设计三位核心人物", "检查现有人物弧与关系是否有冲突", "为主角补充外形、性格和声音设定"],
  },
  scripts: {
    title: "编剧 Agent",
    role: "SCRIPT WRITER",
    description: "读取故事、人物、分集与已有剧本",
    greeting: "我会根据当前项目上下文讨论节奏、场面与对白；确认后可直接新建剧本并写入正文草稿。",
    capability: "可创建剧本",
    icon: FileText,
    prompts: ["为下一集设计一份可拍摄的剧本初稿", "检查现有剧本的节奏、钩子和对白", "把当前故事构思整理成一份新剧本"],
  },
  breakdown: {
    title: "制片拆解 Agent",
    role: "PRODUCTION PLANNER",
    description: "读取剧本、场次、人物与制作资产",
    greeting: "我会把创作内容转成可执行的场次、人物、服装、道具与地点清单；确认后可直接创建结构化场次。",
    capability: "可创建场次拆解",
    icon: ScanLine,
    prompts: ["把最新剧本拆成可拍摄场次", "检查生产清单里缺失的服装与道具", "按低成本拍摄原则重新组织场次"],
  },
  assets: {
    title: "资产统筹 Agent",
    role: "ASSET PRODUCER",
    description: "读取人物、剧本、场次与资产关联",
    greeting: "我会识别项目所需的图片、视频、音频和 3D 素材，并建立人物、服装、道具与场景之间的关系；确认后可直接新增资产卡。",
    capability: "可创建关联资产",
    icon: Boxes,
    prompts: ["根据当前剧本补齐一份资产清单", "为核心人物规划形象图与服装资产", "找出场景、道具和人物资产的缺口"],
  },
  shots: {
    title: "分镜导演 Agent",
    role: "PREVIS DIRECTOR",
    description: "读取场次、视觉资产与故事节奏",
    greeting: "我会把场次转换为镜头意图、构图、运动与时长建议；确认后可直接建立分镜资产卡，进入后续视觉生成。",
    capability: "可创建分镜资产",
    icon: Clapperboard,
    prompts: ["为最新场次设计一组竖屏分镜", "检查现有视觉素材是否覆盖关键镜头", "按情绪节奏生成近景、中景和运动镜头方案"],
  },
};

function messageId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function asActions(value: unknown): StageAgentAction[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is StageAgentAction => {
    if (!isRecord(item) || typeof item.type !== "string") return false;
    return isRecord(item.payload);
  });
}

function actionLabel(action: StageAgentAction): string {
  const payloadName = [action.payload.name, action.payload.title, action.payload.heading]
    .find((value) => typeof value === "string" && value.trim());
  return action.label || action.title || action.summary || action.description || (typeof payloadName === "string" ? payloadName : action.type);
}

function runStage(run: AgentRun): string | null {
  const meta = run.requestMeta;
  if (!meta) return null;
  const stage = meta.stage;
  return typeof stage === "string" ? stage : null;
}

function historicalMessages(stage: StageAgentStage, runs: AgentRun[]): ChatMessage[] {
  const relevant = runs
    .filter((run) => runStage(run) === stage && run.status === "completed")
    .slice(0, 4)
    .reverse();
  return relevant.flatMap((run) => {
    const actions = asActions(run.requestMeta?.proposedActions);
    return [
      { id: `${run.id}-prompt`, role: "user" as const, content: run.prompt, createdAt: run.createdAt },
      {
        id: `${run.id}-response`,
        role: "assistant" as const,
        content: run.response || "本次分析已完成。",
        createdAt: run.completedAt || run.createdAt,
        runId: run.id,
        actions,
        executed: typeof run.requestMeta?.executedAt === "string",
      },
    ];
  });
}

export default function StageAgentPanel({
  projectId,
  projectName,
  stage,
  models,
  runs = [],
  onOpenModels,
  onRunRecorded,
  onExecuted,
}: StageAgentPanelProps) {
  const config = STAGE_CONFIG[stage];
  const projectRef = useRef(projectId);
  const requestSequence = useRef(0);
  const threadRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [messages, setMessages] = useState<ChatMessage[]>(() => historicalMessages(stage, runs));
  const [draft, setDraft] = useState("");
  const [modelId, setModelId] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [executingMessageId, setExecutingMessageId] = useState("");
  const [error, setError] = useState("");

  const eligibleModels = useMemo(() => models.filter((model) => {
    if (!model.enabled || !model.hasApiKey) return false;
    const capabilities = getModelCapabilities(model);
    if (capabilities.length === 0) return true;
    return capabilities.some((capability) => /text|chat|reason|analysis|vision|multimodal|文本|分析|理解|推理|写作|创作|剧本|故事|对话|编剧|多模态/i.test(capability));
  }), [models]);

  const effectiveModelId = eligibleModels.some((model) => model.id === modelId) ? modelId : eligibleModels[0]?.id ?? "";
  const selectedModel = eligibleModels.find((model) => model.id === effectiveModelId) ?? null;
  const busy = submitting || Boolean(executingMessageId);

  useLayoutEffect(() => {
    projectRef.current = projectId;
  }, [projectId]);

  useEffect(() => () => {
    requestSequence.current += 1;
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const thread = threadRef.current;
      if (!thread) return;
      if (typeof thread.scrollTo === "function") thread.scrollTo({ top: thread.scrollHeight, behavior: "smooth" });
      else thread.scrollTop = thread.scrollHeight;
    }, 0);
    return () => window.clearTimeout(timer);
  }, [messages, submitting]);

  async function sendMessage(event?: React.FormEvent) {
    event?.preventDefault();
    const content = draft.trim();
    if (!content || busy) return;
    if (!effectiveModelId) {
      setError("请先在模型中心配置并启用一个文本模型。");
      return;
    }

    const requestedProjectId = projectId;
    const sequence = ++requestSequence.current;
    const userMessage: ChatMessage = { id: messageId("user"), role: "user", content };
    const conversation = messages
      .filter((message) => message.role !== "system")
      .slice(-10)
      .map((message) => ({ role: message.role === "assistant" ? "assistant" : "user", content: message.content }));
    setMessages((current) => [...current, userMessage]);
    setDraft("");
    setSubmitting(true);
    setError("");

    try {
      const result = await apiRequest<StageAgentPlanResponse>(`/api/projects/${encodeURIComponent(requestedProjectId)}/stage-agent`, {
        method: "POST",
        body: JSON.stringify({ mode: "plan", stage, modelId: effectiveModelId, message: content, history: conversation }),
      });
      if (projectRef.current !== requestedProjectId || requestSequence.current !== sequence) return;
      const reply = result.reply || result.message || result.run?.response || "分析已完成。";
      const actions = asActions(result.actions ?? result.run?.requestMeta?.proposedActions);
      const assistantMessage: ChatMessage = {
        id: messageId("assistant"),
        role: "assistant",
        content: reply,
        createdAt: result.run?.completedAt || undefined,
        runId: result.run?.id,
        actions,
      };
      setMessages((current) => [...current, assistantMessage]);
      if (result.run) onRunRecorded?.(result.run);
    } catch (reason) {
      if (projectRef.current !== requestedProjectId || requestSequence.current !== sequence) return;
      setError(reason instanceof Error ? reason.message : "Agent 暂时无法完成分析，请稍后重试。");
    } finally {
      if (projectRef.current === requestedProjectId && requestSequence.current === sequence) setSubmitting(false);
    }
  }

  async function executeActions(message: ChatMessage) {
    if (!message.actions?.length || busy) return;
    const requestedProjectId = projectId;
    const sequence = ++requestSequence.current;
    setExecutingMessageId(message.id);
    setError("");
    try {
      const result = await apiRequest<StageAgentExecuteResponse>(`/api/projects/${encodeURIComponent(requestedProjectId)}/stage-agent`, {
        method: "POST",
        body: JSON.stringify({ mode: "execute", stage, runId: message.runId, actions: message.actions }),
      });
      if (projectRef.current !== requestedProjectId || requestSequence.current !== sequence) return;
      setMessages((current) => [
        ...current.map((item) => item.id === message.id ? { ...item, executed: true } : item),
        {
          id: messageId("execution"),
          role: "system",
          content: result.message || `已完成 ${result.results?.filter((item) => item.success !== false).length || message.actions?.length || 0} 项操作，并写入当前项目。`,
        },
      ]);
      await onExecuted?.();
    } catch (reason) {
      if (projectRef.current !== requestedProjectId || requestSequence.current !== sequence) return;
      setError(reason instanceof Error ? reason.message : "写入项目失败，请检查建议内容后重试。");
    } finally {
      if (projectRef.current === requestedProjectId && requestSequence.current === sequence) setExecutingMessageId("");
    }
  }

  const Icon = config.icon;

  return (
    <aside className={styles.panel} aria-label={`${config.title} 对话框`}>
      <header className={styles.header}>
        <div className={styles.agentMark}><Icon size={17} /></div>
        <div className={styles.headerCopy}>
          <span>{config.role}</span>
          <h2>{config.title}</h2>
          <p>{config.description}</p>
        </div>
        <span className={styles.online}><i /> 在线</span>
      </header>

      <div className={styles.contextBar}>
        <span><Database size={12} /> {projectName || "当前项目"}</span>
        <span><CheckCircle2 size={12} /> 自动读取本环节上下文</span>
      </div>

      <div className={styles.thread} ref={threadRef} aria-live="polite">
        <div className={styles.welcome}>
          <Sparkles size={16} />
          <div><b>{config.capability}</b><p>{config.greeting}</p></div>
        </div>

        {messages.length === 0 && (
          <div className={styles.quickStart}>
            <span>你可以直接这样开始</span>
            {config.prompts.map((prompt) => (
              <button key={prompt} type="button" onClick={() => { setDraft(prompt); textareaRef.current?.focus(); }} disabled={busy}>
                <Bot size={13} /><span>{prompt}</span>
              </button>
            ))}
          </div>
        )}

        {messages.map((message) => (
          <article key={message.id} className={`${styles.message} ${styles[message.role]}`}>
            <div className={styles.messageMeta}>
              <span>{message.role === "user" ? "你" : message.role === "assistant" ? config.title : "项目操作"}</span>
              {message.createdAt && <time>{formatCompactDate(message.createdAt)}</time>}
            </div>
            <p>{message.content}</p>
            {message.actions && message.actions.length > 0 && (
              <div className={styles.actionPlan}>
                <div className={styles.planTitle}><Sparkles size={13} /><span>建议执行 {message.actions.length} 项项目操作</span></div>
                <ul>{message.actions.map((action, index) => <li key={action.id || `${action.type}-${index}`}><span>{index + 1}</span><b>{actionLabel(action)}</b></li>)}</ul>
                <button type="button" onClick={() => void executeActions(message)} disabled={busy || message.executed}>
                  {executingMessageId === message.id ? <LoaderCircle className={styles.spin} size={14} /> : message.executed ? <Check size={14} /> : <Database size={14} />}
                  {message.executed ? "已写入项目" : executingMessageId === message.id ? "正在写入…" : `确认并执行 ${message.actions.length} 项操作`}
                </button>
                {!message.executed && <small>执行前由你确认；服务端会再次校验本环节允许的动作。</small>}
              </div>
            )}
          </article>
        ))}

        {submitting && <div className={styles.thinking}><LoaderCircle className={styles.spin} size={14} /><span>{config.title} 正在读取项目并组织操作建议…</span></div>}
      </div>

      <form className={styles.composer} onSubmit={sendMessage}>
        {error && <div className={styles.error} role="alert"><AlertCircle size={13} /><span>{error}</span></div>}
        <label htmlFor={`stage-agent-model-${stage}`}>执行模型</label>
        <select id={`stage-agent-model-${stage}`} value={effectiveModelId} onChange={(event) => { setModelId(event.target.value); setError(""); }} disabled={busy || eligibleModels.length === 0}>
          <option value="">选择文本模型</option>
          {eligibleModels.map((model) => <option key={model.id} value={model.id}>{model.name} · {model.level}</option>)}
        </select>
        {eligibleModels.length === 0 ? (
          <button className={styles.configureModel} type="button" onClick={onOpenModels}><Bot size={14} /> 去配置可用文本模型</button>
        ) : (
          <div className={styles.inputBox}>
            <textarea
              id="stage-agent-input"
              ref={textareaRef}
              rows={3}
              value={draft}
              disabled={busy}
              placeholder={`告诉${config.title}你想分析或创建什么…`}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void sendMessage();
                }
              }}
            />
            <button type="submit" aria-label="发送给 Agent" disabled={busy || !draft.trim() || !selectedModel}>
              {submitting ? <LoaderCircle className={styles.spin} size={16} /> : <Send size={16} />}
            </button>
          </div>
        )}
        <div className={styles.modelNote}><i /><span>{selectedModel ? `${selectedModel.name} · ${selectedModel.modelId}` : "项目数据不会发送给未选择的模型"}</span></div>
      </form>
    </aside>
  );
}
