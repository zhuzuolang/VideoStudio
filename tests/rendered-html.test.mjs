import assert from "node:assert/strict";
import { access, readFile, stat } from "node:fs/promises";
import { register } from "node:module";
import test from "node:test";

register("./cloudflare-loader.mjs", import.meta.url);

const projectRoot = new URL("../", import.meta.url);

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", {
      headers: {
        accept: "text/html",
        host: "localhost",
        "x-forwarded-host": "localhost",
        "x-forwarded-proto": "http",
      },
    }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the FrameFlow production workspace", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /影序 FrameFlow/);
  assert.match(html, /故事设计/);
  assert.match(html, /AI 创作 Agent/);
  assert.match(html, /AI 模型中心/);
  assert.match(html, /正在连接项目数据库/);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape|react-loading-skeleton/i);
});

test("ships product metadata and removes starter preview assets", async () => {
  const [page, layout, packageJson, schema, agentRoute, ogFile] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/projects/[projectId]/agent-runs/route.ts", import.meta.url), "utf8"),
    stat(new URL("../public/og.png", import.meta.url)),
  ]);

  assert.match(page, /故事设计/);
  assert.match(page, /人物设定/);
  assert.match(page, /剧本工作台/);
  assert.match(page, /生产拆解/);
  assert.match(page, /分镜预演/);
  assert.match(page, /\/api\/bootstrap/);
  assert.match(schema, /aiModels/);
  assert.match(schema, /agentRuns/);
  assert.match(agentRoute, /callConfiguredModel/);
  assert.match(agentRoute, /collectAgentSources/);
  assert.match(layout, /og\.png/);
  assert.match(layout, /summary_large_image/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton|starter/);
  assert.ok(ogFile.size > 100_000);
  await assert.rejects(access(new URL("../app/_sites-preview/", import.meta.url)));
  await access(new URL("../.openai/hosting.json", import.meta.url));
  await access(projectRoot);
});
