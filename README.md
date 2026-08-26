# 影序 FrameFlow

面向短剧团队的 AI 制片工作台。当前版本以项目为数据边界，打通故事设计、人物设定、剧本与场次、生产拆解、多媒体资产、AI 模型配置和上下文 Agent 分析。

## 已实现

- Cloudflare D1 持久化项目、故事、分集、人物、剧本、场次、模型配置与 Agent 运行记录
- Cloudflare R2 保存上传的图片、音频、视频、3D 模型和文档等资产
- 项目下拉切换与独立数据空间；模型中心跨项目通用
- OpenAI-compatible Chat Completions 模型接入，模型地址和参数可配置
- 火山方舟 Seedance 视频生成接入：按当前四档价格提供独立模型卡，支持文生/图生视频、异步任务恢复与有声输出
- API Key 使用服务端 AES-GCM 加密，接口只返回掩码
- Agent 可组合故事、分集、人物、剧本、场次和资产发起真实分析，并保存引用快照与结果

## 本地运行

需要 Node.js `>=22.13.0`。

```bash
npm install
npm run db:generate
npm run dev
```

Sites 私有站点会注入当前登录用户身份。直接请求本地 API 时，需要提供 `oai-authenticated-user-id` 与 `oai-authenticated-user-email` 请求头。若要在本地保存模型密钥，请复制 `.dev.vars.example` 为 `.dev.vars`，并换成至少 32 个字符的随机密钥；不要提交该文件。

本地开发连接回环模型服务时，可在 `.dev.vars` 设置 `ALLOW_LOCAL_MODEL_ENDPOINTS=true`。该开关只放行 `localhost`、`127.0.0.1` 与 `::1`，不要配置到部署环境；Sites 云端也无法访问开发电脑上的回环地址。

发布前可运行：

```bash
npm test
```

## AI 模型配置

在“AI 模型中心”新增 OpenAI-compatible 模型，填写模型 ID、HTTPS Chat Completions 地址和 API Key。模型卡对同一用户的所有项目可用，密钥不会返回浏览器。创建模型后，在“AI 创作 Agent”中选择模型与项目资料即可发起分析。

模型中心同时内置四张火山方舟官方 Seedance 价格预设卡：2.5、2.0、2.0 Fast 和 2.0 Mini。每张卡独立保存模型 ID、价格、分辨率、时长、音频与参考图参数，避免不同版本共用错误的请求格式。资产中心会通过官方异步任务 API 创建并轮询视频，保存供应商任务 ID 后再下载到 R2；连接测试只读取任务列表，不会创建计费视频。

当前轮询由打开的资产中心页面驱动；关闭页面不会重复提交任务，下次进入会依据已保存的供应商任务 ID 继续查询。为避免服务商结果过期，视频生成期间建议保持页面打开，或及时重新进入资产中心。

实现依据：[创建视频任务](https://www.volcengine.com/docs/82379/1520757?lang=zh)、[查询视频任务](https://www.volcengine.com/docs/82379/1521309?lang=zh) 与 [豆包模型价格页](https://www.volcengine.com/product/doubao)。卡片中的价格是参考信息，最终以火山方舟实际账单为准。

单文件上传上限为 100MB；更大的原始视频素材需要后续接入分片上传。首位用户会获得两个可编辑的示例项目，便于快速体验项目切换和制作流程。
