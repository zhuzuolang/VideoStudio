import type { WorkspaceIdentity } from "./auth";
import type { AssetRelationInput } from "../platform-types";
import { ApiError, id, nowIso, parseJson } from "./api";
import { maskedApiKey } from "./crypto";
import { database } from "./runtime";

const schemaStatements = [
  `CREATE TABLE IF NOT EXISTS workspaces (
    user_id TEXT PRIMARY KEY NOT NULL,
    email TEXT NOT NULL,
    display_name TEXT NOT NULL,
    active_project_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS workspace_initializations (
    user_id TEXT PRIMARY KEY NOT NULL REFERENCES workspaces(user_id) ON DELETE CASCADE,
    initialized_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY NOT NULL,
    owner_id TEXT NOT NULL,
    name TEXT NOT NULL,
    genre TEXT NOT NULL DEFAULT '剧情',
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'developing',
    episode_count INTEGER NOT NULL DEFAULT 12,
    single_episode_duration INTEGER NOT NULL DEFAULT 120,
    aspect_ratio TEXT NOT NULL DEFAULT '9:16',
    target_platform TEXT NOT NULL DEFAULT '短视频平台',
    cover_url TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_projects_owner_updated ON projects(owner_id, updated_at)`,
  `CREATE TABLE IF NOT EXISTS project_story (
    project_id TEXT PRIMARY KEY NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title TEXT NOT NULL DEFAULT '',
    logline TEXT NOT NULL DEFAULT '',
    synopsis TEXT NOT NULL DEFAULT '',
    worldview TEXT NOT NULL DEFAULT '',
    core_conflict TEXT NOT NULL DEFAULT '',
    themes_json TEXT NOT NULL DEFAULT '[]',
    style_reference TEXT NOT NULL DEFAULT '',
    story_bible TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'draft',
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS episodes (
    id TEXT PRIMARY KEY NOT NULL,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    episode_no INTEGER NOT NULL,
    title TEXT NOT NULL,
    summary TEXT NOT NULL DEFAULT '',
    hook TEXT NOT NULL DEFAULT '',
    duration_seconds INTEGER NOT NULL DEFAULT 120,
    status TEXT NOT NULL DEFAULT 'outline',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uidx_episodes_project_no ON episodes(project_id, episode_no)`,
  `CREATE INDEX IF NOT EXISTS idx_episodes_project ON episodes(project_id)`,
  `CREATE TABLE IF NOT EXISTS characters (
    id TEXT PRIMARY KEY NOT NULL,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT '配角',
    bio TEXT NOT NULL DEFAULT '',
    appearance TEXT NOT NULL DEFAULT '',
    personality TEXT NOT NULL DEFAULT '',
    arc TEXT NOT NULL DEFAULT '',
    voice TEXT NOT NULL DEFAULT '',
    relationships_json TEXT NOT NULL DEFAULT '[]',
    avatar_url TEXT,
    status TEXT NOT NULL DEFAULT 'draft',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_characters_project ON characters(project_id)`,
  `CREATE TABLE IF NOT EXISTS scripts (
    id TEXT PRIMARY KEY NOT NULL,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    episode_id TEXT REFERENCES episodes(id) ON DELETE SET NULL,
    title TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'draft',
    body_text TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_scripts_project ON scripts(project_id)`,
  `CREATE INDEX IF NOT EXISTS idx_scripts_episode ON scripts(episode_id)`,
  `CREATE TABLE IF NOT EXISTS scenes (
    id TEXT PRIMARY KEY NOT NULL,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    script_id TEXT NOT NULL REFERENCES scripts(id) ON DELETE CASCADE,
    scene_no INTEGER NOT NULL,
    order_index INTEGER NOT NULL DEFAULT 0,
    heading TEXT NOT NULL,
    location TEXT NOT NULL DEFAULT '',
    time_of_day TEXT NOT NULL DEFAULT '',
    summary TEXT NOT NULL DEFAULT '',
    action TEXT NOT NULL DEFAULT '',
    dialogue_json TEXT NOT NULL DEFAULT '[]',
    characters_json TEXT NOT NULL DEFAULT '[]',
    wardrobe_json TEXT NOT NULL DEFAULT '[]',
    props_json TEXT NOT NULL DEFAULT '[]',
    duration_seconds INTEGER NOT NULL DEFAULT 30,
    status TEXT NOT NULL DEFAULT 'draft',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uidx_scenes_script_no ON scenes(script_id, scene_no)`,
  `CREATE INDEX IF NOT EXISTS idx_scenes_project ON scenes(project_id)`,
  `CREATE TABLE IF NOT EXISTS assets (
    id TEXT PRIMARY KEY NOT NULL,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    media_type TEXT NOT NULL DEFAULT 'other',
    category TEXT NOT NULL DEFAULT 'other',
    description TEXT NOT NULL DEFAULT '',
    mime_type TEXT,
    size_bytes INTEGER,
    storage_key TEXT,
    source_url TEXT,
    thumbnail_url TEXT,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'ready',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_assets_project_media_type ON assets(project_id, media_type)`,
  `CREATE INDEX IF NOT EXISTS idx_assets_project_category ON assets(project_id, category)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uidx_assets_storage_key ON assets(storage_key)`,
  `CREATE TABLE IF NOT EXISTS asset_relations (
    id TEXT PRIMARY KEY NOT NULL,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    source_asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
    target_asset_id TEXT REFERENCES assets(id) ON DELETE CASCADE,
    target_character_id TEXT REFERENCES characters(id) ON DELETE CASCADE,
    relation_type TEXT NOT NULL DEFAULT 'related',
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    CHECK ((target_asset_id IS NOT NULL) != (target_character_id IS NOT NULL))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_asset_relations_project ON asset_relations(project_id)`,
  `CREATE INDEX IF NOT EXISTS idx_asset_relations_source ON asset_relations(source_asset_id)`,
  `CREATE INDEX IF NOT EXISTS idx_asset_relations_target_asset ON asset_relations(target_asset_id)`,
  `CREATE INDEX IF NOT EXISTS idx_asset_relations_target_character ON asset_relations(target_character_id)`,
  `CREATE TABLE IF NOT EXISTS ai_models (
    id TEXT PRIMARY KEY NOT NULL,
    owner_id TEXT NOT NULL,
    name TEXT NOT NULL,
    provider TEXT NOT NULL DEFAULT 'OpenAI-compatible',
    model_id TEXT NOT NULL,
    level TEXT NOT NULL DEFAULT 'standard',
    endpoint TEXT NOT NULL,
    icon_url TEXT,
    api_key_ciphertext TEXT,
    api_key_iv TEXT,
    api_key_hint TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    parameters_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_ai_models_owner_updated ON ai_models(owner_id, updated_at)`,
  `CREATE TABLE IF NOT EXISTS asset_generation_jobs (
    id TEXT PRIMARY KEY NOT NULL,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    owner_id TEXT NOT NULL,
    client_request_id TEXT NOT NULL,
    model_id TEXT REFERENCES ai_models(id) ON DELETE SET NULL,
    model_name TEXT NOT NULL,
    name TEXT NOT NULL,
    category TEXT NOT NULL,
    prompt TEXT NOT NULL,
    size TEXT,
    aspect_ratio TEXT,
    relations_json TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'queued',
    phase TEXT NOT NULL DEFAULT 'queued',
    progress INTEGER NOT NULL DEFAULT 0,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    lease_token TEXT,
    lease_expires_at TEXT,
    error_code TEXT,
    error_message TEXT,
    retryable INTEGER NOT NULL DEFAULT 1,
    asset_id TEXT REFERENCES assets(id) ON DELETE SET NULL,
    storage_key TEXT,
    dismissed_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    started_at TEXT,
    completed_at TEXT
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uidx_asset_generation_client_request ON asset_generation_jobs(project_id, owner_id, client_request_id)`,
  `CREATE INDEX IF NOT EXISTS idx_asset_generation_project_updated ON asset_generation_jobs(project_id, updated_at)`,
  `CREATE INDEX IF NOT EXISTS idx_asset_generation_status_lease ON asset_generation_jobs(status, lease_expires_at)`,
  `CREATE TABLE IF NOT EXISTS agent_runs (
    id TEXT PRIMARY KEY NOT NULL,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    owner_id TEXT NOT NULL,
    model_id TEXT REFERENCES ai_models(id) ON DELETE SET NULL,
    model_name TEXT NOT NULL,
    prompt TEXT NOT NULL,
    system_prompt TEXT,
    status TEXT NOT NULL,
    response TEXT,
    error_message TEXT,
    usage_json TEXT NOT NULL DEFAULT '{}',
    request_meta_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    completed_at TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_agent_runs_project_created ON agent_runs(project_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_agent_runs_owner ON agent_runs(owner_id)`,
  `CREATE TABLE IF NOT EXISTS agent_run_sources (
    id TEXT PRIMARY KEY NOT NULL,
    run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
    source_type TEXT NOT NULL,
    source_id TEXT NOT NULL,
    title TEXT NOT NULL,
    snapshot_json TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_agent_run_sources_run ON agent_run_sources(run_id)`,
  `PRAGMA optimize`,
];

let schemaReady: Promise<void> | undefined;

export async function getStore(): Promise<D1Database> {
  const db = database();
  if (!schemaReady) {
    schemaReady = db
      .batch(schemaStatements.map((statement) => db.prepare(statement)))
      .then(() => undefined)
      .catch((error) => {
        schemaReady = undefined;
        throw error;
      });
  }
  await schemaReady;
  return db;
}

export async function ensureWorkspace(db: D1Database, identity: WorkspaceIdentity): Promise<void> {
  const now = nowIso();
  await db
    .prepare(
      `INSERT INTO workspaces (user_id, email, display_name, active_project_id, created_at, updated_at)
       VALUES (?, ?, ?, NULL, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET email = excluded.email, display_name = excluded.display_name, updated_at = excluded.updated_at`,
    )
    .bind(identity.userId, identity.email, identity.displayName, now, now)
    .run();

  const [count, initialized] = await Promise.all([
    db.prepare(`SELECT COUNT(*) AS total FROM projects WHERE owner_id = ?`).bind(identity.userId).first<{ total: number }>(),
    db.prepare(`SELECT user_id AS userId FROM workspace_initializations WHERE user_id = ?`).bind(identity.userId).first<{ userId: string }>(),
  ]);
  if (Number(count?.total ?? 0) > 0) {
    if (!initialized) {
      await db.prepare(`INSERT OR IGNORE INTO workspace_initializations (user_id, initialized_at) VALUES (?, ?)`).bind(identity.userId, now).run();
    }
    return;
  }
  if (initialized) return;

  try {
    await seedWorkspace(db, identity.userId);
  } catch (error) {
    // D1 serializes the transactional seed batch. A concurrent first request can win
    // the initialization claim, so confirm its committed result before surfacing an error.
    const after = await db.prepare(`SELECT COUNT(*) AS total FROM projects WHERE owner_id = ?`).bind(identity.userId).first<{ total: number }>();
    if (Number(after?.total ?? 0) === 0) throw error;
  }
}

async function seedWorkspace(db: D1Database, ownerId: string): Promise<void> {
  const now = nowIso();
  const fog = id("prj");
  const memory = id("prj");
  const fogEpisodes = [id("ep"), id("ep"), id("ep")];
  const memoryEpisodes = [id("ep"), id("ep")];
  const fogScript = id("scr");
  const memoryScript = id("scr");
  const statements: D1PreparedStatement[] = [
    db.prepare(`INSERT INTO workspace_initializations (user_id, initialized_at) VALUES (?, ?)`).bind(ownerId, now),
    db.prepare(`INSERT INTO projects (id, owner_id, name, genre, description, status, episode_count, single_episode_duration, aspect_ratio, target_platform, cover_url, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(fog, ownerId, "雾港来信", "悬疑爱情", "一封迟到十五年的信，把失忆的声音修复师带回故乡雾港。", "developing", 12, 120, "9:16", "抖音 / 快手", null, now, now),
    db.prepare(`INSERT INTO project_story (project_id, title, logline, synopsis, worldview, core_conflict, themes_json, style_reference, story_bible, status, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(fog, "雾港来信", "失忆的声音修复师收到亡母来信，必须在港口拆除前找回一段被抹去的真相。", "林晚回到终年多雾的海港，循着旧磁带中的声音碎片调查母亲当年的失踪。她与守塔人周屿结盟，却发现每恢复一段录音，自己的记忆就少一块。", "近未来沿海小城，声音可以被保存、修复，也可能被篡改。雾潮会干扰一切数字设备。", "林晚必须在保住自我记忆与还原母亲真相之间作出选择。", JSON.stringify(["记忆与身份", "亲情", "真相的代价"]), "冷青海雾、钨丝暖光、克制的东方悬疑", "雾港每晚 23:17 起雾；灯塔磁带不得离港；声音修复会产生等量记忆损耗。", "locked", now),
    db.prepare(`INSERT INTO projects (id, owner_id, name, genre, description, status, episode_count, single_episode_duration, aspect_ratio, target_platform, cover_url, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(memory, ownerId, "记忆典当行", "都市奇幻", "城市角落的典当行收购记忆，也替人赎回不敢面对的人生。", "planning", 8, 180, "16:9", "B站 / 小红书", null, now, now),
    db.prepare(`INSERT INTO project_story (project_id, title, logline, synopsis, worldview, core_conflict, themes_json, style_reference, story_bible, status, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(memory, "记忆典当行", "能看见记忆价格的店员，发现自己最珍贵的童年早已被别人典当。", "新人店员许愿替客人整理被典当的记忆，在一次次交易中追查自己空白的童年，逐渐发现老板收藏着一段足以改变城市的共同记忆。", "记忆可凝结为琥珀色胶片，价格由情感强度决定；被典当者仍保留事实，却失去对应情绪。", "许愿要解放所有被囚禁的记忆，老板则认为遗忘是城市维持秩序的必要代价。", JSON.stringify(["遗忘", "选择", "情感价值"]), "午夜蓝与琥珀金、雨夜霓虹、温暖奇幻", "典当契约不可销毁；赎回必须支付等价情绪；店门只为真正想遗忘的人出现。", "draft", now),
  ];

  const episodeSeeds = [
    [fogEpisodes[0], fog, 1, "潮声里的名字", "林晚收到无寄件人的旧磁带，听见亡母呼唤她的乳名。", "磁带末尾出现本不该存在的第二个呼吸声。", 120, "scripted"],
    [fogEpisodes[1], fog, 2, "灯塔禁区", "林晚进入废弃灯塔，遇到守塔人周屿。", "周屿拿出一张林晚从未拍过的童年合影。", 120, "outline"],
    [fogEpisodes[2], fog, 3, "被剪掉的七秒", "两人寻找每盘磁带都会缺失的七秒声音。", "被剪掉的声音来自十五年后的林晚。", 120, "outline"],
    [memoryEpisodes[0], memory, 1, "没有眼泪的告别", "许愿接待一位想典当悲伤的父亲。", "交易完成后，父亲忘记了女儿笑起来的样子。", 180, "scripted"],
    [memoryEpisodes[1], memory, 2, "零号柜", "许愿发现只有自己能打开的零号记忆柜。", "柜中胶片标着她自己的名字。", 180, "outline"],
  ] as const;
  for (const episode of episodeSeeds) {
    statements.push(db.prepare(`INSERT INTO episodes (id, project_id, episode_no, title, summary, hook, duration_seconds, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(...episode, now, now));
  }

  const charactersSeed = [
    [id("chr"), fog, "林晚", "主角", "27岁，声音修复师，因童年事故失去部分记忆。", "黑色短发，常戴银色监听耳机，左眉有浅疤。", "冷静敏锐，对声音极度敏感，不愿承认脆弱。", "从执着于客观真相，到接受记忆中的情感同样真实。", "语速偏慢，紧张时会无意识数拍。", JSON.stringify([{ name: "周屿", relation: "旧友 / 调查搭档" }]), null, "locked"],
    [id("chr"), fog, "周屿", "男主角", "30岁，雾港最后一任守塔人，守着林晚母亲留下的磁带。", "深色旧风衣，海风吹乱的卷发，右手戴旧皮手套。", "寡言、可靠，习惯用行动隐瞒愧疚。", "从独自守密到允许林晚共同承担真相。", "低沉、句子短，避开关键问题时会重复对方最后一个词。", JSON.stringify([{ name: "林晚", relation: "童年旧友" }]), null, "locked"],
    [id("chr"), fog, "陈渡", "反派", "港口改造负责人，也是十五年前声音实验的研究员。", "剪裁利落的灰色西装，金丝眼镜。", "温和有礼，却把人的记忆视为可计算数据。", "他的控制最终被自己删除的记忆反噬。", "语调稳定，从不提高音量。", JSON.stringify([{ name: "林晚", relation: "母亲旧同事之女" }]), null, "draft"],
    [id("chr"), memory, "许愿", "主角", "24岁，能看见每段记忆的情感价格。", "齐肩发，琥珀色围巾，随身携带拍立得。", "好奇、善良、冲动，不接受善意的遗忘。", "理解遗忘并非背叛，并重新选择自己的记忆。", "明快直接，独白像写给未来自己的便签。", JSON.stringify([{ name: "沈默", relation: "老板 / 监护人" }]), null, "locked"],
    [id("chr"), memory, "沈默", "关键角色", "典当行老板，外表四十岁，实际年龄未知。", "深蓝马甲、金色怀表，永远戴白手套。", "优雅克制，对每份契约保持近乎残酷的尊重。", "从维护规则到承认自己也在借规则逃避。", "温和，常用反问句。", JSON.stringify([{ name: "许愿", relation: "店员 / 被保护者" }]), null, "draft"],
  ] as const;
  for (const character of charactersSeed) {
    statements.push(db.prepare(`INSERT INTO characters (id, project_id, name, role, bio, appearance, personality, arc, voice, relationships_json, avatar_url, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(...character, now, now));
  }

  statements.push(
    db.prepare(`INSERT INTO scripts (id, project_id, episode_id, title, version, status, body_text, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(fogScript, fog, fogEpisodes[0], "第1集 潮声里的名字", 3, "review", "雨夜。林晚的修复室里，一盘没有寄件人的磁带自行转动。", now, now),
    db.prepare(`INSERT INTO scenes (id, project_id, script_id, scene_no, order_index, heading, location, time_of_day, summary, action, dialogue_json, characters_json, wardrobe_json, props_json, duration_seconds, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(id("scn"), fog, fogScript, 1, 0, "内景·声音修复室·夜", "声音修复室", "夜", "林晚修复神秘磁带，第一次听到母亲的声音。", "雨点敲击窗户。频谱上的噪声忽然排列成心跳形状。林晚停住呼吸，按下播放。", JSON.stringify([{ character: "母亲（录音）", line: "晚晚，如果你听见这封信，灯塔就快熄灭了。", emotion: "急促而克制" }, { character: "林晚", line: "妈？", emotion: "失声" }]), JSON.stringify(["林晚"]), JSON.stringify(["林晚-黑色针织衫-v1"]), JSON.stringify(["无标签磁带", "银色监听耳机"]), 42, "review", now, now),
    db.prepare(`INSERT INTO scenes (id, project_id, script_id, scene_no, order_index, heading, location, time_of_day, summary, action, dialogue_json, characters_json, wardrobe_json, props_json, duration_seconds, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(id("scn"), fog, fogScript, 2, 1, "外景·雾港码头·清晨", "雾港码头", "清晨", "林晚循地址回到雾港，与周屿重逢。", "渡船刺破浓雾。周屿站在系缆柱旁，没有挥手。", JSON.stringify([{ character: "周屿", line: "你比信晚到了十五年。", emotion: "平静" }]), JSON.stringify(["林晚", "周屿"]), JSON.stringify(["林晚-灰色风衣-v1", "周屿-旧风衣-v1"]), JSON.stringify(["旧信封", "旅行箱"]), 38, "draft", now, now),
    db.prepare(`INSERT INTO scripts (id, project_id, episode_id, title, version, status, body_text, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(memoryScript, memory, memoryEpisodes[0], "第1集 没有眼泪的告别", 1, "draft", "午夜，典当行的门铃第一次为许愿响起。", now, now),
    db.prepare(`INSERT INTO scenes (id, project_id, script_id, scene_no, order_index, heading, location, time_of_day, summary, action, dialogue_json, characters_json, wardrobe_json, props_json, duration_seconds, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(id("scn"), memory, memoryScript, 1, 0, "内景·记忆典当行·午夜", "记忆典当行", "午夜", "许愿第一次目睹悲伤被抽离成胶片。", "男人掌心的泪光凝成一截琥珀胶片。许愿看到价签从零跳到无法读出的数字。", JSON.stringify([{ character: "许愿", line: "如果连悲伤都没有了，你还怎么记得爱过她？", emotion: "急切" }, { character: "沈默", line: "事实会留下，疼痛不会。客人买的正是这个。", emotion: "克制" }]), JSON.stringify(["许愿", "沈默"]), JSON.stringify(["许愿-琥珀围巾-v1", "沈默-深蓝马甲-v1"]), JSON.stringify(["记忆胶片", "金色怀表", "典当契约"]), 55, "draft", now, now),
  );

  const assetSeeds = [
    [id("ast"), fog, "雾港灯塔概念图", "image", "scene", "灯塔与冷青色海雾的主视觉参考", "image/jpeg", null, null, "https://images.unsplash.com/photo-1507525428034-b723cf961d3e", null, JSON.stringify({ tags: ["场景", "氛围"] }), "ready"],
    [id("ast"), fog, "港口雾笛氛围", "audio", "environment", "低频雾笛与远处浪声的声音参考", "audio/mpeg", null, null, null, null, JSON.stringify({ duration: 48, tags: ["环境音"] }), "planned"],
    [id("ast"), fog, "旧灯塔结构", "model3d", "scene", "用于预演的灯塔粗模", "model/gltf-binary", null, null, null, null, JSON.stringify({ format: "glb", lod: "proxy" }), "planned"],
    [id("ast"), memory, "典当行室内概念图", "image", "scene", "午夜蓝与琥珀金的空间设定", "image/jpeg", null, null, "https://images.unsplash.com/photo-1518005020951-eccb494ad742", null, JSON.stringify({ tags: ["场景", "美术"] }), "ready"],
    [id("ast"), memory, "记忆胶片旋转测试", "video", "prop", "琥珀胶片悬浮旋转的特效参考", "video/mp4", null, null, null, null, JSON.stringify({ duration: 6, loop: true }), "planned"],
  ] as const;
  for (const asset of assetSeeds) {
    statements.push(db.prepare(`INSERT INTO assets (id, project_id, name, media_type, category, description, mime_type, size_bytes, storage_key, source_url, thumbnail_url, metadata_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(...asset, now, now));
  }

  statements.push(
    db.prepare(`INSERT INTO ai_models (id, owner_id, name, provider, model_id, level, endpoint, icon_url, api_key_ciphertext, api_key_iv, api_key_hint, enabled, parameters_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?, ?)`).bind(id("mdl"), ownerId, "OpenAI 创作模型", "OpenAI-compatible", "gpt-4.1", "professional", "https://api.openai.com/v1/chat/completions", null, 1, JSON.stringify({ temperature: 0.7, max_tokens: 4096 }), now, now),
    db.prepare(`UPDATE workspaces SET active_project_id = ?, updated_at = ? WHERE user_id = ?`).bind(fog, now, ownerId),
  );

  await db.batch(statements);
}

export async function requireOwnedProject(db: D1Database, projectId: string, ownerId: string): Promise<Record<string, unknown>> {
  const project = await db
    .prepare(`${projectSelect} WHERE id = ? AND owner_id = ?`)
    .bind(projectId, ownerId)
    .first<Record<string, unknown>>();
  if (!project) throw new ApiError(404, "PROJECT_NOT_FOUND", "项目不存在或你无权访问。 ");
  return project;
}

export async function requireOwnedModel(db: D1Database, modelId: string, ownerId: string): Promise<Record<string, unknown>> {
  const model = await db
    .prepare(`SELECT * FROM ai_models WHERE id = ? AND owner_id = ?`)
    .bind(modelId, ownerId)
    .first<Record<string, unknown>>();
  if (!model) throw new ApiError(404, "MODEL_NOT_FOUND", "模型不存在或你无权访问。 ");
  return model;
}

export async function touchProject(db: D1Database, projectId: string): Promise<void> {
  await db.prepare(`UPDATE projects SET updated_at = ? WHERE id = ?`).bind(nowIso(), projectId).run();
}

const projectSelect = `SELECT id, owner_id AS ownerId, name, genre, description, status,
  episode_count AS episodeCount, single_episode_duration AS singleEpisodeDuration,
  aspect_ratio AS aspectRatio, target_platform AS targetPlatform, cover_url AS coverUrl,
  created_at AS createdAt, updated_at AS updatedAt FROM projects`;

export async function listProjects(db: D1Database, ownerId: string): Promise<Record<string, unknown>[]> {
  return allRows(db.prepare(`${projectSelect} WHERE owner_id = ? ORDER BY updated_at DESC`).bind(ownerId));
}

export async function listModels(db: D1Database, ownerId: string): Promise<Record<string, unknown>[]> {
  const rows = await allRows<Record<string, unknown>>(
    db.prepare(`SELECT id, name, provider, model_id AS modelId, level, endpoint, icon_url AS iconUrl,
      api_key_hint AS apiKeyHint, CASE WHEN api_key_ciphertext IS NOT NULL THEN 1 ELSE 0 END AS hasApiKey,
      enabled, parameters_json AS parametersJson,
      created_at AS createdAt, updated_at AS updatedAt
      FROM ai_models WHERE owner_id = ? ORDER BY updated_at DESC`).bind(ownerId),
  );
  return rows.map(serializeModel);
}

export function serializeModel(row: Record<string, unknown>): Record<string, unknown> {
  const hint = row.apiKeyHint ?? row.api_key_hint;
  const hasApiKey = Boolean(row.hasApiKey ?? row.api_key_ciphertext);
  return {
    id: row.id,
    name: row.name,
    provider: row.provider,
    modelId: row.modelId ?? row.model_id,
    level: row.level,
    endpoint: row.endpoint,
    iconUrl: row.iconUrl ?? row.icon_url ?? null,
    enabled: Boolean(row.enabled),
    parameters: parseJson(row.parametersJson ?? row.parameters_json, {}),
    hasApiKey,
    apiKeyMasked: hasApiKey ? maskedApiKey(hint) : null,
    createdAt: row.createdAt ?? row.created_at,
    updatedAt: row.updatedAt ?? row.updated_at,
  };
}

export async function serializeAssetById(db: D1Database, assetId: string): Promise<Record<string, unknown> | null> {
  const row = await db.prepare(`${assetSelect} WHERE id = ?`).bind(assetId).first<Record<string, unknown>>();
  if (!row) return null;
  try {
    return serializeAsset(row, await listAssetRelations(db, String(row.projectId), assetId));
  } catch (error) {
    console.error("Asset relation enrichment failed", { projectId: row.projectId, assetId, error });
    return serializeAsset(row, []);
  }
}

export async function listAssetRelations(db: D1Database, projectId: string, assetId: string): Promise<Record<string, unknown>[]> {
  const rows = await allRows<Record<string, unknown>>(db.prepare(`SELECT r.id AS id,
    CASE WHEN r.target_asset_id IS NOT NULL THEN 'asset' ELSE 'character' END AS targetType,
    COALESCE(r.target_asset_id, r.target_character_id) AS targetId,
    COALESCE(a.name, c.name) AS targetName,
    a.media_type AS targetMediaType, a.category AS targetCategory,
    r.relation_type AS relationType, r.note, 'outgoing' AS direction
    FROM asset_relations r
    LEFT JOIN assets a ON a.id = r.target_asset_id AND a.project_id = r.project_id
    LEFT JOIN characters c ON c.id = r.target_character_id AND c.project_id = r.project_id
    WHERE r.project_id = ? AND r.source_asset_id = ?
    UNION ALL
    SELECT r.id AS id, 'asset' AS targetType, r.source_asset_id AS targetId, source.name AS targetName,
      source.media_type AS targetMediaType, source.category AS targetCategory,
      r.relation_type AS relationType, r.note, 'incoming' AS direction
    FROM asset_relations r JOIN assets source ON source.id = r.source_asset_id AND source.project_id = r.project_id
    WHERE r.project_id = ? AND r.target_asset_id = ?
    ORDER BY id`).bind(projectId, assetId, projectId, assetId));
  return rows.filter((row) => row.targetName);
}

async function listProjectAssetRelations(db: D1Database, projectId: string): Promise<Record<string, unknown>[]> {
  const rows = await allRows<Record<string, unknown>>(db.prepare(`SELECT r.source_asset_id AS ownerAssetId, r.id AS id,
    CASE WHEN r.target_asset_id IS NOT NULL THEN 'asset' ELSE 'character' END AS targetType,
    COALESCE(r.target_asset_id, r.target_character_id) AS targetId,
    COALESCE(a.name, c.name) AS targetName,
    a.media_type AS targetMediaType, a.category AS targetCategory,
    r.relation_type AS relationType, r.note, 'outgoing' AS direction
    FROM asset_relations r
    LEFT JOIN assets a ON a.id = r.target_asset_id AND a.project_id = r.project_id
    LEFT JOIN characters c ON c.id = r.target_character_id AND c.project_id = r.project_id
    WHERE r.project_id = ?
    UNION ALL
    SELECT r.target_asset_id AS ownerAssetId, r.id AS id, 'asset' AS targetType,
      r.source_asset_id AS targetId, source.name AS targetName,
      source.media_type AS targetMediaType, source.category AS targetCategory,
      r.relation_type AS relationType, r.note, 'incoming' AS direction
    FROM asset_relations r
    JOIN assets source ON source.id = r.source_asset_id AND source.project_id = r.project_id
    WHERE r.project_id = ? AND r.target_asset_id IS NOT NULL
    ORDER BY ownerAssetId, id`).bind(projectId, projectId));
  return rows.filter((row) => row.ownerAssetId && row.targetName);
}

export async function serializeProjectAssets(
  db: D1Database,
  projectId: string,
  existingRows?: Record<string, unknown>[],
): Promise<Record<string, unknown>[]> {
  const assetRows = existingRows ?? await allRows<Record<string, unknown>>(
    db.prepare(`${assetSelect} WHERE project_id = ? ORDER BY updated_at DESC`).bind(projectId),
  );
  let relationRows: Record<string, unknown>[];
  try {
    relationRows = await listProjectAssetRelations(db, projectId);
  } catch (error) {
    console.error("Project asset relation enrichment failed", { projectId, error });
    return assetRows.map((row) => serializeAsset(row, []));
  }
  const relationsByAsset = new Map<string, Record<string, unknown>[]>();
  for (const relation of relationRows) {
    const ownerAssetId = String(relation.ownerAssetId);
    const serializedRelation = { ...relation };
    delete serializedRelation.ownerAssetId;
    relationsByAsset.set(ownerAssetId, [...(relationsByAsset.get(ownerAssetId) ?? []), serializedRelation]);
  }
  return assetRows.map((row) => serializeAsset(row, relationsByAsset.get(String(row.id)) ?? []));
}

export async function replaceAssetRelations(
  db: D1Database,
  projectId: string,
  sourceAssetId: string,
  relations: AssetRelationInput[],
): Promise<void> {
  await db.batch(await prepareAssetRelationStatements(db, projectId, sourceAssetId, relations));
}

export async function prepareAssetRelationStatements(
  db: D1Database,
  projectId: string,
  sourceAssetId: string,
  relations: AssetRelationInput[],
): Promise<D1PreparedStatement[]> {
  const statements: D1PreparedStatement[] = [
    db.prepare(`DELETE FROM asset_relations WHERE project_id = ? AND source_asset_id = ?`).bind(projectId, sourceAssetId),
  ];
  await validateAssetRelationTargets(db, projectId, relations, sourceAssetId);
  for (const relation of relations) {
    statements.push(db.prepare(`INSERT INTO asset_relations (
      id, project_id, source_asset_id, target_asset_id, target_character_id, relation_type, note, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).bind(
      id("rel"), projectId, sourceAssetId,
      relation.targetType === "asset" ? relation.targetId : null,
      relation.targetType === "character" ? relation.targetId : null,
      relation.relationType?.trim() || "related", relation.note?.trim() || "", nowIso(),
    ));
  }
  return statements;
}

export function prepareGeneratedAssetRelationStatements(
  db: D1Database,
  projectId: string,
  sourceAssetId: string,
  relations: AssetRelationInput[],
): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [
    db.prepare(`DELETE FROM asset_relations WHERE project_id = ? AND source_asset_id = ?`).bind(projectId, sourceAssetId),
  ];
  for (const relation of relations) {
    const relationId = id("rel");
    const relationType = relation.relationType?.trim() || "related";
    const note = relation.note?.trim() || "";
    if (relation.targetType === "asset") {
      statements.push(db.prepare(`INSERT INTO asset_relations (
        id, project_id, source_asset_id, target_asset_id, target_character_id, relation_type, note, created_at
      ) SELECT ?, ?, ?, ?, NULL, ?, ?, ?
        WHERE EXISTS (SELECT 1 FROM assets WHERE id = ? AND project_id = ?)`).bind(
        relationId, projectId, sourceAssetId, relation.targetId, relationType, note, nowIso(),
        relation.targetId, projectId,
      ));
    } else {
      statements.push(db.prepare(`INSERT INTO asset_relations (
        id, project_id, source_asset_id, target_asset_id, target_character_id, relation_type, note, created_at
      ) SELECT ?, ?, ?, NULL, ?, ?, ?, ?
        WHERE EXISTS (SELECT 1 FROM characters WHERE id = ? AND project_id = ?)`).bind(
        relationId, projectId, sourceAssetId, relation.targetId, relationType, note, nowIso(),
        relation.targetId, projectId,
      ));
    }
  }
  return statements;
}

export async function validateAssetRelationTargets(
  db: D1Database,
  projectId: string,
  relations: AssetRelationInput[],
  sourceAssetId?: string,
): Promise<void> {
  for (const relation of relations) {
    if (sourceAssetId && relation.targetType === "asset" && relation.targetId === sourceAssetId) {
      throw new ApiError(400, "INVALID_ASSET_RELATION", "资产不能关联自身。 ");
    }
    const table = relation.targetType === "asset" ? "assets" : "characters";
    const target = await db.prepare(`SELECT id FROM ${table} WHERE id = ? AND project_id = ?`)
      .bind(relation.targetId, projectId)
      .first();
    if (!target) throw new ApiError(400, "INVALID_ASSET_RELATION", "关联目标不存在或不属于当前项目。 ");
  }
}

const assetSelect = `SELECT id, project_id AS projectId, name, media_type AS mediaType, category, description, mime_type AS mimeType,
  size_bytes AS sizeBytes, storage_key AS storageKey, source_url AS sourceUrl,
  thumbnail_url AS thumbnailUrl, metadata_json AS metadataJson, status,
  created_at AS createdAt, updated_at AS updatedAt FROM assets`;

function serializeAsset(row: Record<string, unknown>, relations: Record<string, unknown>[] = []): Record<string, unknown> {
  return {
    ...row,
    metadata: parseJson(row.metadataJson, {}),
    hasContent: Boolean(row.storageKey),
    contentUrl: row.storageKey ? `/api/projects/${row.projectId}/assets/${row.id}/content` : null,
    relations,
    metadataJson: undefined,
    storageKey: undefined,
  };
}

export async function workspacePayload(
  db: D1Database,
  identity: WorkspaceIdentity,
  requestedProjectId?: string | null,
): Promise<Record<string, unknown>> {
  const projects = await listProjects(db, identity.userId);
  const workspace = await db
    .prepare(`SELECT user_id AS userId, email, display_name AS displayName, active_project_id AS activeProjectId FROM workspaces WHERE user_id = ?`)
    .bind(identity.userId)
    .first<Record<string, unknown>>();

  let activeProjectId = requestedProjectId || (workspace?.activeProjectId as string | null) || (projects[0]?.id as string | undefined);
  if (activeProjectId && !projects.some((project) => project.id === activeProjectId)) {
    if (requestedProjectId) throw new ApiError(404, "PROJECT_NOT_FOUND", "项目不存在或你无权访问。 ");
    activeProjectId = projects[0]?.id as string | undefined;
  }
  if (!activeProjectId) throw new ApiError(500, "PROJECT_BOOTSTRAP_FAILED", "无法初始化示例项目。 ");

  if (workspace?.activeProjectId !== activeProjectId) {
    await db.prepare(`UPDATE workspaces SET active_project_id = ?, updated_at = ? WHERE user_id = ?`).bind(activeProjectId, nowIso(), identity.userId).run();
  }
  const project = projects.find((item) => item.id === activeProjectId) ?? null;

  const [story, episodeRows, characterRows, scriptRows, sceneRows, assetRows, models, agentRows, sourceRows] = await Promise.all([
    db.prepare(`SELECT project_id AS projectId, title, logline, synopsis, worldview, core_conflict AS coreConflict,
      themes_json AS themesJson, style_reference AS styleReference, story_bible AS storyBible, status, updated_at AS updatedAt
      FROM project_story WHERE project_id = ?`).bind(activeProjectId).first<Record<string, unknown>>(),
    allRows<Record<string, unknown>>(db.prepare(`SELECT id, project_id AS projectId, episode_no AS episodeNo, title, summary, hook,
      duration_seconds AS durationSeconds, status, created_at AS createdAt, updated_at AS updatedAt
      FROM episodes WHERE project_id = ? ORDER BY episode_no`).bind(activeProjectId)),
    allRows<Record<string, unknown>>(db.prepare(`SELECT id, project_id AS projectId, name, role, bio, appearance, personality, arc, voice,
      relationships_json AS relationshipsJson, avatar_url AS avatarUrl, status, created_at AS createdAt, updated_at AS updatedAt
      FROM characters WHERE project_id = ? ORDER BY created_at`).bind(activeProjectId)),
    allRows<Record<string, unknown>>(db.prepare(`SELECT id, project_id AS projectId, episode_id AS episodeId, title, version, status,
      body_text AS bodyText, created_at AS createdAt, updated_at AS updatedAt
      FROM scripts WHERE project_id = ? ORDER BY created_at`).bind(activeProjectId)),
    allRows<Record<string, unknown>>(db.prepare(`SELECT id, project_id AS projectId, script_id AS scriptId, scene_no AS sceneNo,
      order_index AS orderIndex, heading, location, time_of_day AS timeOfDay, summary, action,
      dialogue_json AS dialogueJson, characters_json AS charactersJson, wardrobe_json AS wardrobeJson,
      props_json AS propsJson, duration_seconds AS durationSeconds, status,
      created_at AS createdAt, updated_at AS updatedAt
      FROM scenes WHERE project_id = ? ORDER BY script_id, order_index, scene_no`).bind(activeProjectId)),
    allRows<Record<string, unknown>>(db.prepare(`${assetSelect} WHERE project_id = ? ORDER BY updated_at DESC`).bind(activeProjectId)),
    listModels(db, identity.userId),
    allRows<Record<string, unknown>>(db.prepare(`SELECT id, project_id AS projectId, model_id AS modelId, model_name AS modelName,
      prompt, system_prompt AS systemPrompt, status, response, error_message AS errorMessage,
      usage_json AS usageJson, request_meta_json AS requestMetaJson, created_at AS createdAt, completed_at AS completedAt
      FROM agent_runs WHERE project_id = ? AND owner_id = ? ORDER BY created_at DESC LIMIT 30`).bind(activeProjectId, identity.userId)),
    allRows<Record<string, unknown>>(db.prepare(`SELECT ars.id, ars.run_id AS runId, ars.source_type AS sourceType,
      ars.source_id AS sourceId, ars.title, ars.snapshot_json AS snapshotJson
      FROM agent_run_sources ars JOIN agent_runs ar ON ar.id = ars.run_id
      WHERE ar.project_id = ? AND ar.owner_id = ? ORDER BY ars.rowid`).bind(activeProjectId, identity.userId)),
  ]);

  const scenesByScript = new Map<string, Record<string, unknown>[]>();
  for (const row of sceneRows) {
    const scene = serializeScene(row);
    const scriptId = String(row.scriptId);
    scenesByScript.set(scriptId, [...(scenesByScript.get(scriptId) ?? []), scene]);
  }
  const sourcesByRun = new Map<string, Record<string, unknown>[]>();
  for (const row of sourceRows) {
    const runId = String(row.runId);
    sourcesByRun.set(runId, [
      ...(sourcesByRun.get(runId) ?? []),
      { id: row.id, sourceType: row.sourceType, sourceId: row.sourceId, title: row.title, snapshot: parseJson(row.snapshotJson, {}) },
    ]);
  }

  return {
    workspace: { ...workspace, activeProjectId },
    projects,
    activeProjectId,
    project,
    story: story ? { ...story, themes: parseJson(story.themesJson, []), themesJson: undefined } : null,
    episodes: episodeRows,
    characters: characterRows.map((row) => ({ ...row, relationships: parseJson(row.relationshipsJson, []), relationshipsJson: undefined })),
    scripts: scriptRows.map((script) => ({ ...script, scenes: scenesByScript.get(String(script.id)) ?? [] })),
    assets: await serializeProjectAssets(db, activeProjectId, assetRows),
    models,
    agentRuns: agentRows.map((row) => serializeAgentRun(row, sourcesByRun.get(String(row.id)) ?? [])),
  };
}

export function serializeScene(row: Record<string, unknown>): Record<string, unknown> {
  return {
    ...row,
    dialogue: parseJson(row.dialogueJson ?? row.dialogue_json, []),
    characters: parseJson(row.charactersJson ?? row.characters_json, []),
    wardrobe: parseJson(row.wardrobeJson ?? row.wardrobe_json, []),
    props: parseJson(row.propsJson ?? row.props_json, []),
    dialogueJson: undefined,
    charactersJson: undefined,
    wardrobeJson: undefined,
    propsJson: undefined,
  };
}

export function serializeAgentRun(row: Record<string, unknown>, sources: Record<string, unknown>[] = []): Record<string, unknown> {
  return {
    id: row.id,
    projectId: row.projectId ?? row.project_id,
    modelId: row.modelId ?? row.model_id ?? null,
    modelName: row.modelName ?? row.model_name,
    prompt: row.prompt,
    systemPrompt: row.systemPrompt ?? row.system_prompt ?? null,
    status: row.status,
    response: row.response ?? null,
    errorMessage: row.errorMessage ?? row.error_message ?? null,
    usage: parseJson(row.usageJson ?? row.usage_json, {}),
    requestMeta: parseJson(row.requestMetaJson ?? row.request_meta_json, {}),
    sources,
    createdAt: row.createdAt ?? row.created_at,
    completedAt: row.completedAt ?? row.completed_at ?? null,
  };
}

export async function allRows<T extends Record<string, unknown> = Record<string, unknown>>(
  statement: D1PreparedStatement,
): Promise<T[]> {
  const result = await statement.all<T>();
  return result.results ?? [];
}
