const base = process.env.FRAMEFLOW_BASE_URL ?? "http://localhost:3000";
const userA = {
  "oai-authenticated-user-id": "integration-user-a",
  "oai-authenticated-user-email": "a@example.test",
  "oai-authenticated-user-full-name": encodeURIComponent("接口测试用户A"),
  "oai-authenticated-user-full-name-encoding": "percent-encoded-utf-8",
};
const userB = {
  "oai-authenticated-user-id": "integration-user-b",
  "oai-authenticated-user-email": "b@example.test",
};

async function request(path, init = {}, headers = userA) {
  const response = await fetch(base + path, {
    ...init,
    headers: { ...headers, ...(init.headers ?? {}) },
  });
  const text = await response.text();
  return { response, payload: text ? JSON.parse(text) : null };
}

function assert(value, message) {
  if (!value) throw new Error(message);
}

const bootstrapA = await request("/api/bootstrap");
assert(bootstrapA.response.status === 200, `bootstrap A: ${bootstrapA.response.status}`);
assert(bootstrapA.payload.data.projects.length === 2, "A should receive two seeded projects");
const [projectOne, projectTwo] = bootstrapA.payload.data.projects;

const bootstrapB = await request("/api/bootstrap", {}, userB);
assert(bootstrapB.response.status === 200, `bootstrap B: ${bootstrapB.response.status}`);
assert(bootstrapB.payload.data.projects.length === 2, "B should receive two seeded projects");
assert(!bootstrapB.payload.data.projects.some((project) => project.id === projectOne.id), "project IDs leaked across users");

const denied = await request(`/api/projects/${projectOne.id}`, {}, userB);
assert(denied.response.status === 404, `cross-user access should be 404, got ${denied.response.status}`);

const activated = await request(`/api/projects/${projectTwo.id}/activate`, { method: "POST" });
assert(activated.response.status === 200, `activate: ${activated.response.status}`);
const switched = await request(`/api/bootstrap?projectId=${encodeURIComponent(projectTwo.id)}`);
assert(switched.payload.data.activeProjectId === projectTwo.id, "project switch did not persist");

const marker = `本地联调-${Date.now()}`;
const savedStory = await request(`/api/projects/${projectTwo.id}/story`, {
  method: "PATCH",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ logline: marker }),
});
assert(savedStory.response.status === 200, `story patch: ${savedStory.response.status}`);
const story = await request(`/api/projects/${projectTwo.id}/story`);
assert(story.payload.data.story.logline === marker, "story persistence failed");

const modelCreated = await request("/api/models", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    name: "短密钥状态联调",
    provider: "OpenAI-compatible",
    modelId: "gpt-test",
    level: "test",
    endpoint: "https://api.openai.com/v1/chat/completions",
    apiKey: "abc",
    parameters: { temperature: 0.1 },
  }),
});
assert(modelCreated.response.status === 201, `model create: ${modelCreated.response.status} ${JSON.stringify(modelCreated.payload)}`);
const createdModel = modelCreated.payload.data.model;
assert(createdModel.hasApiKey === true, "short encrypted key should still report configured");
assert(createdModel.apiKeyMasked === null, "short key must not be echoed in the mask");

const form = new FormData();
form.set("file", new File([new Uint8Array(2048).fill(7)], "integration.bin", { type: "application/octet-stream" }));
form.set("name", "接口联调资产");
form.set("mediaType", "other");
form.set("category", "reference");
const assetCreated = await request(`/api/projects/${projectTwo.id}/assets`, { method: "POST", body: form });
assert(assetCreated.response.status === 201, `asset upload: ${assetCreated.response.status} ${JSON.stringify(assetCreated.payload)}`);
const asset = assetCreated.payload.data.asset;
assert(asset.mediaType === "other" && asset.category === "reference", "asset dimensions were not persisted independently");
const content = await fetch(`${base}/api/projects/${projectTwo.id}/assets/${asset.id}/content`, { headers: userA });
assert(content.status === 200, `asset content: ${content.status}`);
assert(Number(content.headers.get("content-length")) === 2048, "R2 content size mismatch");
assert((await content.arrayBuffer()).byteLength === 2048, "R2 response body size mismatch");

const relatedAssetCreated = await request(`/api/projects/${projectTwo.id}/assets`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    name: "关联资产联调",
    mediaType: "image",
    category: "storyboard",
    sourceUrl: "https://example.com/storyboard.png",
    relatedAssetIds: [asset.id],
  }),
});
assert(relatedAssetCreated.response.status === 201, `related asset create: ${relatedAssetCreated.response.status}`);
const relatedAsset = relatedAssetCreated.payload.data.asset;
assert(relatedAsset.relations.some((relation) => relation.targetId === asset.id && relation.direction === "outgoing"), "outgoing asset relation was not persisted");
const baseAssetAfterRelation = await request(`/api/projects/${projectTwo.id}/assets/${asset.id}`);
assert(baseAssetAfterRelation.payload.data.asset.relations.some((relation) => relation.targetId === relatedAsset.id && relation.direction === "incoming"), "incoming asset relation was not enriched");

const crossProjectAsset = bootstrapA.payload.data.assets[0];
assert(crossProjectAsset, "expected a seeded asset in the first project");
const isolatedRelation = await request(`/api/projects/${projectTwo.id}/assets`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: "跨项目关系应失败", mediaType: "image", category: "reference", sourceUrl: "https://example.com/reference.png", relatedAssetIds: [crossProjectAsset.id] }),
});
assert(isolatedRelation.response.status === 400, `cross-project asset relation should be 400, got ${isolatedRelation.response.status}`);

const seedModel = switched.payload.data.models.find((model) => !model.hasApiKey);
assert(seedModel, "expected an unconfigured seed model");
const agentFailed = await request(`/api/projects/${projectTwo.id}/agent-runs`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    modelId: seedModel.id,
    prompt: "验证失败运行持久化",
    sources: { includeStory: true, includeEpisodes: false },
  }),
});
assert(agentFailed.response.status === 400, `missing-key Agent call should be 400, got ${agentFailed.response.status}`);
const runId = agentFailed.payload.error.details.runId;
const runs = await request(`/api/projects/${projectTwo.id}/agent-runs`);
assert(runs.payload.data.agentRuns.some((run) => run.id === runId && run.status === "failed"), "failed Agent run was not persisted");

const assetDeleted = await request(`/api/projects/${projectTwo.id}/assets/${asset.id}`, { method: "DELETE" });
assert(assetDeleted.response.status === 204, `asset delete: ${assetDeleted.response.status}`);
const relatedAssetDeleted = await request(`/api/projects/${projectTwo.id}/assets/${relatedAsset.id}`, { method: "DELETE" });
assert(relatedAssetDeleted.response.status === 204, `related asset delete: ${relatedAssetDeleted.response.status}`);
const modelDeleted = await request(`/api/models/${createdModel.id}`, { method: "DELETE" });
assert(modelDeleted.response.status === 204, `model delete: ${modelDeleted.response.status}`);

console.log(JSON.stringify({
  bootstrap: "ok",
  projectIsolation: "ok",
  projectSwitch: "ok",
  storyPersistence: "ok",
  encryptedKeyMask: "ok",
  r2UploadAndRead: "ok",
  agentFailurePersistence: "ok",
  cleanup: "ok",
}, null, 2));
