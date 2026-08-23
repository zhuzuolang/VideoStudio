"use client";

import { useMemo, useState } from "react";
import type { LucideIcon } from "lucide-react";
import {
  AlertTriangle,
  ArrowRight,
  Bell,
  BookOpenText,
  Box,
  Boxes,
  Camera,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleDotDashed,
  Clapperboard,
  Clock3,
  Download,
  Eye,
  FileText,
  Film,
  LayoutDashboard,
  Link2,
  LockKeyhole,
  Menu,
  MessageSquareText,
  MoreHorizontal,
  Package,
  PanelRight,
  PencilLine,
  Play,
  Plus,
  ScanLine,
  Search,
  Send,
  Shirt,
  Sparkles,
  UsersRound,
  WandSparkles,
  X,
} from "lucide-react";

type StageId =
  | "overview"
  | "story"
  | "characters"
  | "script"
  | "breakdown"
  | "assets"
  | "shots"
  | "delivery";

type Stage = {
  id: StageId;
  label: string;
  icon: LucideIcon;
  progress: number;
  meta: string;
};

const stages: Stage[] = [
  { id: "overview", label: "项目总览", icon: LayoutDashboard, progress: 64, meta: "今日 4 项" },
  { id: "story", label: "故事设计", icon: BookOpenText, progress: 100, meta: "已锁定" },
  { id: "characters", label: "人物设定", icon: UsersRound, progress: 82, meta: "3 / 4" },
  { id: "script", label: "剧本工作台", icon: FileText, progress: 68, meta: "6 / 12 集" },
  { id: "breakdown", label: "生产拆解", icon: ScanLine, progress: 42, meta: "37 场" },
  { id: "assets", label: "视觉资产", icon: Boxes, progress: 31, meta: "24 项" },
  { id: "shots", label: "分镜预演", icon: Clapperboard, progress: 18, meta: "16 镜" },
  { id: "delivery", label: "成片交付", icon: Film, progress: 0, meta: "待开始" },
];

const stageCopy: Record<StageId, { kicker: string; title: string; description: string; version: string }> = {
  overview: {
    kicker: "制片驾驶舱",
    title: "雾港来信",
    description: "把创作决定、制作资产和团队反馈收拢到一条可追踪的流水线。",
    version: "项目进度 64%",
  },
  story: {
    kicker: "前期创作 · 01",
    title: "故事圣经",
    description: "先锁定故事的发动机，再让每一集围绕同一个核心矛盾生长。",
    version: "版本 v3.2",
  },
  characters: {
    kicker: "前期创作 · 02",
    title: "人物设定",
    description: "统一角色动机、关系与可生成的视觉锚点，避免跨集漂移。",
    version: "角色库 v2.6",
  },
  script: {
    kicker: "剧本开发 · 03",
    title: "剧本工作台",
    description: "按集、场、节拍协同写作，并让每一次改动都能被下游感知。",
    version: "第 03 集 · v5",
  },
  breakdown: {
    kicker: "制片筹备 · 04",
    title: "生产拆解",
    description: "从定稿剧本自动识别人、景、服、化、道与拍摄风险。",
    version: "拆解批次 B12",
  },
  assets: {
    kicker: "视觉开发 · 05",
    title: "视觉资产库",
    description: "把定妆、服装、道具和场景做成可复用、可追溯的正式资产。",
    version: "24 项资产",
  },
  shots: {
    kicker: "导演工作台 · 06",
    title: "分镜与预演",
    description: "将文字场景转成镜头语言，提前验证节奏、连续性与制作难度。",
    version: "场 03 · 16 镜",
  },
  delivery: {
    kicker: "后期制作 · 07",
    title: "成片交付",
    description: "集中管理生成、剪辑、声音、审片和多平台交付版本。",
    version: "尚未锁版",
  },
};

const episodes = [
  { id: "01", title: "失踪的渡船", hook: "沈雾收到父亲失踪七年后的第一封信。", status: "已锁定", score: 92 },
  { id: "02", title: "潮汐密码", hook: "旧码头的广播在午夜读出她的童年暗号。", status: "已锁定", score: 88 },
  { id: "03", title: "第二个收信人", hook: "周砚承认自己也收到了同样的信。", status: "待优化", score: 71 },
  { id: "04", title: "雾中灯塔", hook: "一段旧录像把两人的父辈指向同一场事故。", status: "草稿", score: 63 },
];

const scenes = [
  { id: "3-01", slug: "外景 · 雾港旧码头 · 夜", time: "1′20″", cast: "沈雾", status: "已定稿" },
  { id: "3-02", slug: "内景 · 码头值班室 · 夜", time: "2′10″", cast: "沈雾 / 周砚", status: "修改中" },
  { id: "3-03", slug: "外景 · 防波堤 · 夜", time: "1′45″", cast: "沈雾 / 周砚", status: "待审核" },
  { id: "3-04", slug: "内景 · 沈雾家 · 清晨", time: "55″", cast: "沈雾 / 林颂", status: "草稿" },
];

const scriptContent: Record<string, { action: string; speaker: string; dialogue: string; note: string }> = {
  "3-01": {
    action: "雾贴着水面漫进码头。停运的渡船在远处轻轻碰撞栈桥，像有人在敲门。沈雾循着广播里的杂音走向售票窗。",
    speaker: "沈雾（压低声音）",
    dialogue: "七年前，你也是从这里走的吗？",
    note: "建立孤立感；结尾让广播突然报出沈雾的名字。",
  },
  "3-02": {
    action: "值班室只亮着一盏钨丝灯。周砚背对门口拆开一封潮湿的信，信纸边缘沾着蓝色油漆。",
    speaker: "周砚",
    dialogue: "我不是在等你。我在等写信的人。",
    note: "两人首次正面对峙，信息差要大于情绪冲突。",
  },
  "3-03": {
    action: "浪越过防波堤。沈雾抓住周砚的衣袖，发现他的袖口缝着父亲旧制服上的编号。",
    speaker: "沈雾",
    dialogue: "这件衣服，你从哪里拿到的？",
    note: "本集视觉钩子；服装连续性关联 C-07。",
  },
  "3-04": {
    action: "晨光切过餐桌。林颂把一盒没有寄件人的磁带推到沈雾面前，没有解释。",
    speaker: "林颂",
    dialogue: "你父亲最后留下的，不止一封信。",
    note: "尾钩；接第 04 集旧录像线索。",
  },
};

function IconButton({ label, children, onClick }: { label: string; children: React.ReactNode; onClick?: () => void }) {
  return (
    <button className="icon-button" type="button" aria-label={label} onClick={onClick}>
      {children}
    </button>
  );
}

function OverviewView({ navigate, notify }: { navigate: (stage: StageId) => void; notify: (message: string) => void }) {
  const nextTasks = [
    { time: "09:30", title: "第 03 集剧本审读", owner: "你 + 编剧组", stage: "script" as StageId },
    { time: "14:00", title: "周砚定妆方案评审", owner: "美术组", stage: "characters" as StageId },
    { time: "17:30", title: "场 3-03 分镜锁定", owner: "导演组", stage: "shots" as StageId },
  ];

  return (
    <div className="view-stack">
      <section className="metric-grid" aria-label="项目核心指标">
        <article className="metric-card metric-card-accent">
          <span>整体完成度</span>
          <strong>64%</strong>
          <div className="mini-progress"><i style={{ width: "64%" }} /></div>
        </article>
        <article className="metric-card"><span>剧本定稿</span><strong>6<small>/12 集</small></strong><p>第 07 集等待主编审阅</p></article>
        <article className="metric-card"><span>正式资产</span><strong>24<small>项</small></strong><p>3 项存在连续性风险</p></article>
        <article className="metric-card"><span>预计成片</span><strong>21<small>分 40 秒</small></strong><p>符合竖屏短剧节奏</p></article>
      </section>

      <section className="overview-grid">
        <div className="surface production-map">
          <div className="section-heading">
            <div><span className="section-kicker">PRODUCTION MAP</span><h2>制作链路</h2></div>
            <button className="text-button" onClick={() => notify("已同步最新项目进度")}>同步进度 <ArrowRight size={15} /></button>
          </div>
          <div className="pipeline">
            {stages.slice(1).map((stage, index) => (
              <button key={stage.id} className="pipeline-step" onClick={() => navigate(stage.id)}>
                <span className={stage.progress === 100 ? "step-dot complete" : stage.progress > 0 ? "step-dot active" : "step-dot"}>
                  {stage.progress === 100 ? <Check size={13} /> : index + 1}
                </span>
                <span><b>{stage.label}</b><small>{stage.meta}</small></span>
                {index < stages.length - 2 && <i aria-hidden="true" />}
              </button>
            ))}
          </div>
        </div>

        <div className="surface schedule-panel">
          <div className="section-heading"><div><span className="section-kicker">TODAY</span><h2>今日审片桌</h2></div><span className="date-chip">8月23日</span></div>
          <div className="task-list">
            {nextTasks.map((task) => (
              <button key={task.time} className="task-row" onClick={() => navigate(task.stage)}>
                <span className="task-time">{task.time}</span>
                <span className="task-copy"><b>{task.title}</b><small>{task.owner}</small></span>
                <ChevronRight size={16} />
              </button>
            ))}
          </div>
        </div>
      </section>

      <section className="surface risk-board">
        <div className="section-heading"><div><span className="section-kicker">ATTENTION</span><h2>需要主创决定</h2></div><span className="count-badge">3 项</span></div>
        <div className="decision-grid">
          <button onClick={() => navigate("story")}><AlertTriangle size={18} /><span><b>第 03 集中段张力偏低</b><small>AI 建议提前揭示第二封信</small></span><ArrowRight size={16} /></button>
          <button onClick={() => navigate("assets")}><Shirt size={18} /><span><b>周砚服装存在跨场冲突</b><small>场 3-02 与 3-03 袖口编号不一致</small></span><ArrowRight size={16} /></button>
          <button onClick={() => navigate("shots")}><Camera size={18} /><span><b>场 3-03 超出时长预算</b><small>当前预演 1′45″，目标 1′20″</small></span><ArrowRight size={16} /></button>
        </div>
      </section>
    </div>
  );
}

function StoryView({ selectedEpisode, setSelectedEpisode }: { selectedEpisode: string; setSelectedEpisode: (id: string) => void }) {
  const episode = episodes.find((item) => item.id === selectedEpisode) ?? episodes[0];
  return (
    <div className="view-stack">
      <section className="story-premise">
        <div className="premise-index">01</div>
        <div className="premise-copy">
          <span className="section-kicker">CORE PREMISE · 已锁定</span>
          <h2>一个替父亲守着旧邮局的女孩，开始收到来自七年前失踪渡船的信。</h2>
          <p>她必须在雾港下一次大潮前找出写信人，也必须决定是否愿意相信那个隐瞒真相的陌生人。</p>
        </div>
        <button className="quiet-button"><PencilLine size={15} /> 创建修订版</button>
      </section>

      <section className="surface">
        <div className="section-heading">
          <div><span className="section-kicker">STORY SPINE</span><h2>故事脊柱</h2></div>
          <div className="locked-label"><LockKeyhole size={13} /> 世界观已锁定</div>
        </div>
        <div className="beat-track">
          {[
            ["01", "欲望", "证明父亲没有抛弃她"],
            ["02", "阻力", "全镇都在维护同一个谎言"],
            ["03", "代价", "真相会摧毁她仅剩的家人"],
            ["04", "选择", "公开真相，或让雾港继续沉默"],
          ].map(([number, label, copy], index) => (
            <div className="beat" key={number}>
              <div className="beat-number">{number}</div>
              <div><span>{label}</span><p>{copy}</p></div>
              {index < 3 && <ArrowRight className="beat-arrow" size={18} />}
            </div>
          ))}
        </div>
      </section>

      <section className="story-grid">
        <div className="surface episode-panel">
          <div className="section-heading">
            <div><span className="section-kicker">EPISODE ARC</span><h2>分集弧线</h2></div>
            <button className="round-add" aria-label="添加一集"><Plus size={17} /></button>
          </div>
          <div className="episode-list">
            {episodes.map((item) => (
              <button key={item.id} className={`episode-row ${item.id === selectedEpisode ? "selected" : ""}`} onClick={() => setSelectedEpisode(item.id)}>
                <span className="episode-no">EP.{item.id}</span>
                <span className="episode-main"><b>{item.title}</b><small>{item.hook}</small></span>
                <span className={`status-label ${item.status === "待优化" ? "warning" : ""}`}>{item.status}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="surface episode-inspector">
          <div className="episode-score"><span>结构健康度</span><strong>{episode.score}</strong><small>/100</small></div>
          <div className="score-ring" style={{ "--score": `${episode.score * 3.6}deg` } as React.CSSProperties}><span>{episode.id}</span></div>
          <h3>{episode.title}</h3>
          <p>{episode.hook}</p>
          <div className="inspector-facts">
            <span><b>开场钩子</b> 12 秒</span>
            <span><b>情绪峰值</b> 03:10</span>
            <span><b>结尾悬念</b> 强</span>
          </div>
          <button className="block-button">打开本集大纲 <ArrowRight size={15} /></button>
        </div>
      </section>
    </div>
  );
}

function CharactersView({ notify }: { notify: (message: string) => void }) {
  const characters = [
    { initials: "沈雾", role: "女主角 · 邮局代理人", drive: "证明父亲从未抛弃自己", flaw: "用冷静掩盖被遗弃的恐惧", relation: "与周砚：互相试探 → 共同查案", status: "形象已锁定", tone: "coral" },
    { initials: "周砚", role: "男主角 · 海事调查员", drive: "替父亲偿还七年前的错误", flaw: "把保护他人等同于隐瞒真相", relation: "与沈雾：知情者 → 不可靠盟友", status: "待定妆", tone: "blue" },
    { initials: "林颂", role: "关键角色 · 沈雾姨母", drive: "维持雾港脆弱的平静", flaw: "爱得越深，控制得越紧", relation: "与沈雾：养育者 → 真相守门人", status: "设定已锁定", tone: "sand" },
  ];
  return (
    <div className="view-stack">
      <section className="relationship-strip">
        <div><span className="section-kicker">RELATIONSHIP ENGINE</span><h2>所有角色都被同一场旧事故牵引</h2></div>
        <div className="relation-mini"><span>沈雾</span><i>寻找</i><span>真相</span><i>威胁</i><span>雾港</span></div>
      </section>
      <section className="character-grid">
        {characters.map((character) => (
          <article className="character-card" key={character.initials}>
            <div className={`character-portrait ${character.tone}`}><span>{character.initials.slice(0, 1)}</span><small>角色视觉锚点</small></div>
            <div className="character-content">
              <div className="character-title"><div><h2>{character.initials}</h2><p>{character.role}</p></div><MoreHorizontal size={18} /></div>
              <dl><div><dt>核心欲望</dt><dd>{character.drive}</dd></div><div><dt>致命缺口</dt><dd>{character.flaw}</dd></div><div><dt>关系弧</dt><dd>{character.relation}</dd></div></dl>
              <div className="character-footer"><span><LockKeyhole size={12} /> {character.status}</span><button onClick={() => notify(`已打开 ${character.initials} 的人物卡`)}>查看人物卡 <ArrowRight size={14} /></button></div>
            </div>
          </article>
        ))}
        <button className="add-character" onClick={() => notify("已创建一个空白人物卡草稿")}><Plus size={24} /><b>添加角色</b><span>从故事上下文生成，或从空白开始</span></button>
      </section>
    </div>
  );
}

function ScriptView({ selectedScene, setSelectedScene, notify }: { selectedScene: string; setSelectedScene: (id: string) => void; notify: (message: string) => void }) {
  const activeScene = scenes.find((scene) => scene.id === selectedScene) ?? scenes[1];
  const content = scriptContent[activeScene.id];
  return (
    <div className="script-workspace">
      <section className="surface scene-navigator">
        <div className="section-heading"><div><span className="section-kicker">EPISODE 03</span><h2>场次</h2></div><button className="round-add"><Plus size={16} /></button></div>
        <div className="scene-list">
          {scenes.map((scene) => (
            <button key={scene.id} className={scene.id === selectedScene ? "active" : ""} onClick={() => setSelectedScene(scene.id)}>
              <span className="scene-id">{scene.id}</span><span><b>{scene.slug}</b><small>{scene.time} · {scene.cast}</small></span><i className={scene.status === "待审核" ? "review" : ""} />
            </button>
          ))}
        </div>
      </section>
      <section className="script-paper">
        <div className="paper-toolbar"><span><FileText size={15} /> {activeScene.id} · {activeScene.status}</span><div><button onClick={() => notify("已添加行内批注")}><MessageSquareText size={15} /> 批注</button><button onClick={() => notify("该场已标记为待审核")}><CheckCircle2 size={15} /> 提交审核</button></div></div>
        <article className="screenplay">
          <p className="scene-heading-line">{activeScene.slug}</p>
          <p className="action-line">{content.action}</p>
          <p className="speaker-line">{content.speaker}</p>
          <p className="dialogue-line">{content.dialogue}</p>
          <div className="script-note"><Sparkles size={15} /><span><b>导演意图</b>{content.note}</span></div>
        </article>
        <footer className="paper-footer"><span>286 字 · 预计 {activeScene.time}</span><span>自动保存于 14:32</span></footer>
      </section>
    </div>
  );
}

function BreakdownView({ notify }: { notify: (message: string) => void }) {
  const rows = [
    { scene: "3-01", place: "雾港旧码头", cast: "沈雾", costume: "C-03 深灰风衣", props: "旧信封、手电", risk: "低" },
    { scene: "3-02", place: "码头值班室", cast: "沈雾、周砚", costume: "C-03 / C-07", props: "潮湿信件、台灯", risk: "中" },
    { scene: "3-03", place: "防波堤", cast: "沈雾、周砚", costume: "C-03 / C-07", props: "制服编号", risk: "高" },
    { scene: "3-04", place: "沈雾家", cast: "沈雾、林颂", costume: "C-04 / C-11", props: "磁带盒、早餐", risk: "低" },
  ];
  return (
    <div className="view-stack">
      <section className="metric-grid compact">
        <article className="metric-card"><span>已拆解场次</span><strong>37<small>/52</small></strong><p>覆盖前 6 集定稿剧本</p></article>
        <article className="metric-card"><span>独立场景</span><strong>9<small>处</small></strong><p>3 处可复用置景</p></article>
        <article className="metric-card"><span>连续性风险</span><strong>3<small>项</small></strong><p>1 项需要主创决定</p></article>
      </section>
      <section className="surface breakdown-table-wrap">
        <div className="section-heading"><div><span className="section-kicker">SCRIPT BREAKDOWN</span><h2>第 03 集生产清单</h2></div><div className="table-actions"><button><Search size={15} />筛选</button><button onClick={() => notify("生产清单已导出为 CSV")}><Download size={15} />导出</button></div></div>
        <div className="responsive-table">
          <table className="breakdown-table">
            <thead><tr><th>场次</th><th>场景</th><th>人物</th><th>服装</th><th>关键道具</th><th>风险</th></tr></thead>
            <tbody>{rows.map((row) => <tr key={row.scene}><td><b>{row.scene}</b></td><td>{row.place}</td><td>{row.cast}</td><td><Shirt size={14} /> {row.costume}</td><td><Package size={14} /> {row.props}</td><td><span className={`risk-pill ${row.risk === "高" ? "high" : row.risk === "中" ? "mid" : ""}`}>{row.risk}</span></td></tr>)}</tbody>
          </table>
        </div>
        <div className="table-foot"><span><CheckCircle2 size={14} /> AI 已对照剧本 v5 完成拆解</span><button onClick={() => notify("正在重新分析最近的剧本改动…")}>重新分析改动</button></div>
      </section>
    </div>
  );
}

function AssetsView({ notify }: { notify: (message: string) => void }) {
  const assets = [
    { code: "CHAR-01", type: "角色", name: "沈雾 · 标准定妆", meta: "正/侧/背 · 6 表情", status: "已锁定", icon: UsersRound, look: "look-one" },
    { code: "C-07", type: "服装", name: "周砚 · 旧海事制服", meta: "场 3-02 至 3-03", status: "待确认", icon: Shirt, look: "look-two" },
    { code: "SET-03", type: "场景", name: "雾港旧码头 · 夜", meta: "全景/中景参考", status: "已锁定", icon: Box, look: "look-three" },
    { code: "PROP-12", type: "道具", name: "潮湿的第七封信", meta: "英雄道具 · 可读文字", status: "已锁定", icon: Package, look: "look-four" },
    { code: "SET-05", type: "场景", name: "码头值班室", meta: "置景版 v2", status: "修改中", icon: Box, look: "look-five" },
    { code: "PROP-18", type: "道具", name: "蓝色磁带盒", meta: "第 04 集尾钩", status: "草稿", icon: Package, look: "look-six" },
  ];
  return (
    <div className="view-stack">
      <div className="asset-toolbar"><div className="filter-chips"><button className="active">全部 24</button><button>角色 4</button><button>服装 8</button><button>场景 7</button><button>道具 5</button></div><button className="primary-button" onClick={() => notify("已创建新资产草稿")}><Plus size={16} /> 新建资产</button></div>
      <section className="asset-grid">
        {assets.map((asset) => {
          const AssetIcon = asset.icon;
          return <button className="asset-card" key={asset.code} onClick={() => notify(`已打开 ${asset.name}`)}>
            <div className={`asset-visual ${asset.look}`}><AssetIcon size={28} /><span>{asset.type}</span><i /><i /></div>
            <div className="asset-copy"><span className="asset-code">{asset.code}</span><h2>{asset.name}</h2><p>{asset.meta}</p><div><span className={asset.status === "待确认" ? "warning" : ""}><CircleDotDashed size={12} /> {asset.status}</span><ArrowRight size={15} /></div></div>
          </button>;
        })}
      </section>
    </div>
  );
}

function ShotsView({ notify }: { notify: (message: string) => void }) {
  const shots = [
    { no: "03-01", size: "大全景", move: "缓慢推进", time: "6″", note: "雾吞没码头，沈雾从画面右侧进入", look: "shot-one", status: "已通过" },
    { no: "03-02", size: "中近景", move: "手持跟随", time: "4″", note: "跟随手电光扫过停运告示", look: "shot-two", status: "已通过" },
    { no: "03-03", size: "特写", move: "静止", time: "3″", note: "信封水珠滑过父亲的笔迹", look: "shot-three", status: "待调整" },
    { no: "03-04", size: "过肩镜头", move: "轻微横移", time: "5″", note: "广播喇叭在沈雾肩后突然亮起", look: "shot-four", status: "草稿" },
  ];
  return (
    <div className="view-stack">
      <section className="previz-bar">
        <button className="play-button" onClick={() => notify("正在播放场 3-01 动态预演")}><Play size={18} fill="currentColor" /></button>
        <div><span className="section-kicker">SCENE 3-01 PREVIZ</span><h2>旧码头 · 夜</h2></div>
        <div className="previz-time"><b>00:18</b><span>/ 01:20</span></div>
        <div className="previz-line"><i style={{ width: "23%" }} /></div>
        <button className="quiet-button" onClick={() => notify("预演审片链接已复制")}><Link2 size={15} /> 分享审片</button>
      </section>
      <section className="shot-list">
        {shots.map((shot) => <article key={shot.no} className="shot-row">
          <div className={`shot-frame ${shot.look}`}><span>{shot.no}</span><Camera size={24} /><i className="frame-corner one" /><i className="frame-corner two" /></div>
          <div className="shot-copy"><div><span>镜头 {shot.no}</span><span className={shot.status === "待调整" ? "warning" : ""}>{shot.status}</span></div><h2>{shot.note}</h2><p>{shot.size} · {shot.move}</p></div>
          <div className="shot-duration"><Clock3 size={14} /><b>{shot.time}</b></div>
          <button className="icon-button" aria-label={`编辑镜头 ${shot.no}`} onClick={() => notify(`已打开镜头 ${shot.no}`)}><ChevronRight size={17} /></button>
        </article>)}
        <button className="add-shot" onClick={() => notify("已在场 3-01 末尾添加空白镜头")}><Plus size={18} /> 添加镜头</button>
      </section>
    </div>
  );
}

function DeliveryView({ notify }: { notify: (message: string) => void }) {
  const jobs = [
    { name: "场 3-01 · 雾港建立镜头", type: "视频生成", progress: 100, status: "已完成" },
    { name: "周砚 · 台词音色测试", type: "声音生成", progress: 76, status: "生成中" },
    { name: "第 01 集 · 竖屏粗剪", type: "自动剪辑", progress: 38, status: "排队中" },
  ];
  return (
    <div className="view-stack">
      <section className="delivery-hero">
        <div><span className="section-kicker">PRODUCTION QUEUE</span><h2>从已批准的镜头开始生产</h2><p>所有生成任务都会自动携带已锁定的人物、服装、场景和镜头参数。</p></div>
        <button className="primary-button" onClick={() => notify("已打开新的生成任务配置")}><Sparkles size={16} /> 新建生成任务</button>
      </section>
      <section className="surface job-panel">
        <div className="section-heading"><div><span className="section-kicker">ACTIVE JOBS</span><h2>生产队列</h2></div><span className="live-label"><i /> 2 个任务运行中</span></div>
        <div className="job-list">
          {jobs.map((job) => <div className="job-row" key={job.name}><div className="job-icon">{job.type === "声音生成" ? <MessageSquareText size={18} /> : <Film size={18} />}</div><div className="job-copy"><div><b>{job.name}</b><span>{job.status}</span></div><p>{job.type}</p><div className="job-progress"><i style={{ width: `${job.progress}%` }} /></div></div><strong>{job.progress}%</strong></div>)}
        </div>
      </section>
      <section className="empty-timeline"><div className="timeline-track"><span>V1</span><i /><i /><i /></div><div><Clapperboard size={28} /><h2>剪辑时间线将在首批镜头完成后解锁</h2><p>届时可以在这里完成粗剪、配音、音乐和交付版本管理。</p></div></section>
    </div>
  );
}

function AssistantPanel({
  activeStage,
  tab,
  setTab,
  isBusy,
  applied,
  onRun,
  onApply,
  onClose,
  notify,
}: {
  activeStage: StageId;
  tab: string;
  setTab: (tab: string) => void;
  isBusy: boolean;
  applied: string[];
  onRun: () => void;
  onApply: (id: string) => void;
  onClose: () => void;
  notify: (message: string) => void;
}) {
  const [prompt, setPrompt] = useState("");
  const currentLabel = stages.find((stage) => stage.id === activeStage)?.label ?? "当前页面";
  const suggestions = [
    { id: "tension", icon: AlertTriangle, type: "节奏提醒", title: "第 03 集中段缺少主动选择", body: "周砚揭示第二封信后，沈雾连续 42 秒只在接收信息。可让她主动销毁一条线索，再被迫追回。", action: "插入大纲草稿" },
    { id: "continuity", icon: Shirt, type: "连续性", title: "服装编号存在冲突", body: "场 3-03 特写要求出现袖口编号，但当前 C-07 的正式版本未包含该细节。", action: "创建资产修订" },
    { id: "hook", icon: Sparkles, type: "备选方案", title: "强化本集尾钩", body: "磁带播放前先出现沈雾童年的声音，比直接揭示父亲录音更能制造身份悬念。", action: "加入备选" },
  ];

  return (
    <aside className="assistant-panel">
      <div className="assistant-head">
        <div className="ai-mark"><Sparkles size={17} /></div>
        <div><b>AI 创作搭档</b><span>正在理解「{currentLabel}」</span></div>
        <IconButton label="收起 AI 面板" onClick={onClose}><X size={17} /></IconButton>
      </div>
      <div className="assistant-tabs" role="tablist" aria-label="AI助手视图">
        {[['ideas', '建议'], ['continuity', '连续性'], ['context', '上下文']].map(([id, label]) => <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? "active" : ""} onClick={() => setTab(id)}>{label}{id === "continuity" && <i>1</i>}</button>)}
      </div>
      <div className="assistant-body">
        {tab === "ideas" && <>
          <div className="assistant-summary"><span><WandSparkles size={15} /> 本轮创作观察</span><p>已读取故事圣经、人物卡与第 03 集剧本，共发现 <b>3 个可行动建议</b>。</p></div>
          <div className="suggestion-list">
            {suggestions.map((suggestion) => {
              const SuggestionIcon = suggestion.icon;
              const isApplied = applied.includes(suggestion.id);
              return <article className="suggestion" key={suggestion.id}><div className="suggestion-type"><SuggestionIcon size={14} /><span>{suggestion.type}</span></div><h3>{suggestion.title}</h3><p>{suggestion.body}</p><button disabled={isApplied} onClick={() => onApply(suggestion.id)}>{isApplied ? <><Check size={14} /> 已应用</> : <>{suggestion.action} <ArrowRight size={14} /></>}</button></article>;
            })}
          </div>
        </>}
        {tab === "continuity" && <div className="continuity-list">
          <div className="continuity-warning"><AlertTriangle size={17} /><div><b>1 个需要处理的问题</b><p>周砚的制服袖口编号尚未进入锁定资产。</p></div></div>
          {[['人物形象', '3 位角色已锁定'], ['服装版本', 'C-07 待修订'], ['关键道具', '5 项一致'], ['时空信息', '夜 → 清晨 连贯']].map(([label, value], index) => <div className="check-row" key={label}>{index === 1 ? <CircleDotDashed size={15} /> : <CheckCircle2 size={15} />}<span><b>{label}</b><small>{value}</small></span></div>)}
        </div>}
        {tab === "context" && <div className="context-stack">
          <div className="context-card"><BookOpenText size={16} /><span><b>故事圣经 v3.2</b><small>最后更新：今天 10:18</small></span><LockKeyhole size={13} /></div>
          <div className="context-card"><UsersRound size={16} /><span><b>3 张人物卡</b><small>沈雾、周砚、林颂</small></span><LockKeyhole size={13} /></div>
          <div className="context-card"><Boxes size={16} /><span><b>12 项关联资产</b><small>服装 4 · 场景 3 · 道具 5</small></span><ChevronRight size={14} /></div>
          <p className="context-note">AI 只使用当前项目已批准的内容，不会把草稿当成正式设定。</p>
        </div>}
      </div>
      <div className="assistant-composer">
        <button className={`ai-audit ${isBusy ? "busy" : ""}`} onClick={onRun} disabled={isBusy}><Sparkles size={15} />{isBusy ? "正在检查整条创作链…" : "重新进行 AI 体检"}</button>
        <label htmlFor="ai-prompt">向创作搭档提问</label>
        <div className="prompt-box"><textarea id="ai-prompt" rows={2} placeholder="例如：给第 03 集设计一个更强的尾钩" value={prompt} onChange={(event) => setPrompt(event.target.value)} /><button aria-label="发送提问" disabled={!prompt.trim()} onClick={() => { notify("AI 已收到问题，正在生成建议"); setPrompt(""); }}><Send size={16} /></button></div>
        <span className="model-note"><i /> 已连接 StoryCraft · VisionFrame · VoiceLab</span>
      </div>
    </aside>
  );
}

export default function Home() {
  const [activeStage, setActiveStage] = useState<StageId>("story");
  const [selectedEpisode, setSelectedEpisode] = useState("03");
  const [selectedScene, setSelectedScene] = useState("3-02");
  const [assistantTab, setAssistantTab] = useState("ideas");
  const [assistantOpen, setAssistantOpen] = useState(true);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [isAiBusy, setIsAiBusy] = useState(false);
  const [appliedSuggestions, setAppliedSuggestions] = useState<string[]>([]);
  const [toast, setToast] = useState("");

  const current = stageCopy[activeStage];
  const currentIndex = stages.findIndex((stage) => stage.id === activeStage);
  const todayLabel = useMemo(() => new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric", weekday: "short" }).format(new Date()), []);

  function notify(message: string) {
    setToast(message);
    window.setTimeout(() => setToast(""), 2600);
  }

  function navigate(stage: StageId) {
    setActiveStage(stage);
    setMobileNavOpen(false);
  }

  function runAiAudit() {
    if (isAiBusy) return;
    setIsAiBusy(true);
    window.setTimeout(() => {
      setIsAiBusy(false);
      setAssistantTab("ideas");
      notify("AI 体检完成：发现 3 个可行动建议");
    }, 1100);
  }

  function applySuggestion(id: string) {
    setAppliedSuggestions((items) => [...items, id]);
    notify("建议已作为草稿加入，正式内容尚未被覆盖");
  }

  return (
    <div className="app-shell">
      <div className={`mobile-scrim ${mobileNavOpen ? "visible" : ""}`} onClick={() => setMobileNavOpen(false)} />
      <aside className={`sidebar ${mobileNavOpen ? "open" : ""}`}>
        <div className="brand-lockup">
          <div className="brand-mark"><span /><span /></div>
          <div><b>影序</b><small>FRAMEFLOW</small></div>
          <button className="sidebar-close" aria-label="关闭菜单" onClick={() => setMobileNavOpen(false)}><X size={18} /></button>
        </div>
        <button className="project-switcher">
          <span className="project-avatar">雾</span>
          <span><b>雾港来信</b><small>竖屏短剧 · 12 集</small></span>
          <ChevronDown size={15} />
        </button>
        <div className="nav-label">制作流程</div>
        <nav className="stage-nav" aria-label="项目制作阶段">
          {stages.map((stage, index) => {
            const StageIcon = stage.icon;
            const isActive = stage.id === activeStage;
            return <button key={stage.id} className={isActive ? "active" : ""} onClick={() => navigate(stage.id)} aria-current={isActive ? "page" : undefined}>
              <span className="nav-icon"><StageIcon size={17} /></span>
              <span className="nav-copy"><b>{stage.label}</b><small>{stage.meta}</small></span>
              {stage.progress === 100 ? <CheckCircle2 className="nav-state complete" size={15} /> : stage.progress > 0 ? <span className="nav-progress">{stage.progress}</span> : <CircleDotDashed className="nav-state" size={15} />}
              {index > 0 && index < stages.length - 1 && <i className="nav-rail" />}
            </button>;
          })}
        </nav>
        <div className="sidebar-spacer" />
        <div className="project-health">
          <div><span>项目完整度</span><b>64%</b></div>
          <div className="health-bar"><i /></div>
          <p>再完成人物定妆即可进入正式分镜。</p>
        </div>
        <div className="sidebar-user"><span className="user-avatar">林</span><span><b>林制片</b><small>项目所有者</small></span><button><MoreHorizontal size={17} /></button></div>
      </aside>

      <div className="app-stage">
        <header className="topbar">
          <div className="topbar-left">
            <button className="mobile-menu" aria-label="打开项目导航" onClick={() => setMobileNavOpen(true)}><Menu size={19} /></button>
            <div className="breadcrumb"><span>雾港来信</span><ChevronRight size={13} /><b>{stages[currentIndex]?.label}</b></div>
          </div>
          <div className="topbar-center"><Search size={15} /><input aria-label="搜索项目内容" placeholder="搜索场次、人物或资产" /><kbd>⌘ K</kbd></div>
          <div className="topbar-right"><span className="today-label">{todayLabel}</span><IconButton label="通知"><Bell size={17} /><i className="notification-dot" /></IconButton><span className="team-avatars"><i>李</i><i>周</i><i>林</i></span></div>
        </header>

        <div className={`workspace-layout ${assistantOpen ? "" : "assistant-hidden"}`}>
          <main className="main-workspace">
            <div className="page-heading">
              <div><span className="page-kicker">{current.kicker}</span><div className="title-row"><h1>{current.title}</h1><span className="version-badge">{current.version}</span></div><p>{current.description}</p></div>
              <div className="heading-actions">
                {!assistantOpen && <button className="quiet-button" onClick={() => setAssistantOpen(true)}><PanelRight size={15} /> AI 搭档</button>}
                <button className="quiet-button" onClick={() => notify("已创建一个不影响正式内容的新版本")}><Plus size={15} /> 新建版本</button>
                <button className="primary-button" onClick={runAiAudit}><Sparkles size={15} /> AI 体检</button>
              </div>
            </div>

            {activeStage === "overview" && <OverviewView navigate={navigate} notify={notify} />}
            {activeStage === "story" && <StoryView selectedEpisode={selectedEpisode} setSelectedEpisode={setSelectedEpisode} />}
            {activeStage === "characters" && <CharactersView notify={notify} />}
            {activeStage === "script" && <ScriptView selectedScene={selectedScene} setSelectedScene={setSelectedScene} notify={notify} />}
            {activeStage === "breakdown" && <BreakdownView notify={notify} />}
            {activeStage === "assets" && <AssetsView notify={notify} />}
            {activeStage === "shots" && <ShotsView notify={notify} />}
            {activeStage === "delivery" && <DeliveryView notify={notify} />}
          </main>

          {assistantOpen && <AssistantPanel activeStage={activeStage} tab={assistantTab} setTab={setAssistantTab} isBusy={isAiBusy} applied={appliedSuggestions} onRun={runAiAudit} onApply={applySuggestion} onClose={() => setAssistantOpen(false)} notify={notify} />}
        </div>
      </div>
      {toast && <div className="toast" role="status"><CheckCircle2 size={17} />{toast}</div>}
    </div>
  );
}
