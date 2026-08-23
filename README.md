# 影序 FrameFlow

面向短剧团队的 AI 制片工作台。当前版本以项目为数据边界，打通故事设计、人物设定、剧本与场次、生产拆解、多媒体资产、AI 模型配置和上下文 Agent 分析。

## 已实现

- Cloudflare D1 持久化项目、故事、分集、人物、剧本、场次、模型配置与 Agent 运行记录
- Cloudflare R2 保存上传的图片、音频、视频、3D 模型和文档等资产
- 项目下拉切换与独立数据空间；模型中心跨项目通用
- OpenAI-compatible Chat Completions 模型接入，模型地址和参数可配置
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

发布前可运行：

```bash
npm test
```

## AI 模型配置

在“AI 模型中心”新增 OpenAI-compatible 模型，填写模型 ID、HTTPS Chat Completions 地址和 API Key。模型卡对同一用户的所有项目可用，密钥不会返回浏览器。创建模型后，在“AI 创作 Agent”中选择模型与项目资料即可发起分析。

单文件上传上限为 100MB；更大的原始视频素材需要后续接入分片上传。首位用户会获得两个可编辑的示例项目，便于快速体验项目切换和制作流程。
