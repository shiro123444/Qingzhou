# Mac 本地 PPT 环境与验收

2026-11-17 在本机完成真实账号模型调用、登录后创建、三页预览、PPTX 导出和文件保存。配置保存在忽略的 `.env.development.local` 中，不含在本文中。

## 本机配置

```dotenv
CORDIS_PPT_MASTER_ROOT=/Users/july/.local/share/qingzhou/ppt-master
CORDIS_PPT_PYTHON=/Users/july/.local/share/qingzhou/presentation-venv/bin/python
CORDIS_PRESENTATION_DATA_DIR="/Users/july/Library/Application Support/Qingzhou/presentation"
CORDIS_PPT_AUTHORING_MODE=quick
```

PPT Master 来源为 <https://github.com/hugohe3/ppt-master>，本次固定检出的提交为 `3af3e8ef774c4d67ee57e1306d9256d08c9ee1bf`。它保存在仓库外部，未修改上游源码。Python 使用本机 Codex 配套的 3.12.14 创建独立虚拟环境，并复用其现有包；新增安装 PyYAML、skia-pathops 和 uharfbuzz，另安装 PyMuPDF 用于文档能力及核验。实际包版本保存在本地验收目录。

`QINGZHOU_PLUGINS` 未设置，沿用默认启用 `music,presentation,sites` 的行为。PPT 主模型复用登录账号保存的配置，本次实际使用 `nexus / deepseek-v4.1-flash`；真实文字和红色色块视觉问答均成功。未写入或更换账号密钥、供应商及模型选择。

本机原有开发依赖继续使用：55432 端口的 PGlite PostgreSQL 兼容服务、16379 端口的 Redis、19000 端口的本地 S3 服务。它们用于开发验收，不等同生产 PostgreSQL 部署。

## 启动与检查

依赖服务运行后，在仓库根目录执行：

```sh
node node_modules/tsx/dist/cli.mjs scripts/devStartupSequence.mts
```

本机已有启动辅助脚本 `.data/local-preview/start-web.py`，本次重启复用了它；Web 日志位于 `.data/local-preview/web.log`。不要在 3010 和 9876 端口已有服务时重复启动。更改 PPT 环境变量后须重启服务，PPT composition 在首次使用后会缓存。

打开 <http://localhost:3010/presentation>。登录后的 `/api/runtime/presentation/readiness` 返回 200、`available: true`、`provider: ppt-master`。这个端点检查装配和账号配置，不代替真实供应商调用及文件导出验收。

## 实际验收

- 通过本地保存的既有账号重新调用邮件密码登录端点，返回 200；浏览器工作台使用其既有有效登录会话。
- 在工作台的“直接创建”表单输入三页中文文稿，经过真实内容规划、原生流程图与清单生成、视觉复核、质量检查、Python 转换后进入 `completed`。
- 在浏览器逐页查看 1–3 页；刷新后恢复同一已完成任务，无需重新生成。
- 导出接口和原始文件接口均返回 200。PPTX 的类型与 `Content-Disposition: attachment; filename="presentation.pptx"` 均正确。
- 从已认证页面的导出链接，通过浏览器工具公开的 `downloadMedia` 能力保存到 `/Users/july/Downloads/presentation.pptx`，25,874 字节。下载字节与持久化产物完全一致。
- 文件包含三页、三页中文备注、23 个原生可编辑文字节点。LibreOffice 26.8.1.1 成功渲染全部三页，逐页检查未见文字裁切或流程图丢失。未以 PowerPoint 进行检查。

任务：`presentation-7bf0ae3c-4d27-488e-abcb-530fac647e78`。

成品页面：<http://localhost:3010/presentation?jobId=presentation-7bf0ae3c-4d27-488e-abcb-530fac647e78>。

本地证据在 `.data/ppt-mac-acceptance/`：`verification.json`、完成页截图、逐页 SVG 预览、下载文件副本、Office 渲染图和依赖版本。配置变更前的备份在 `.data/local-preview/backups/ppt-mac-20261117-083229/`。这些目录及原始配置均不提交。

## 已知边界

当前 Chrome 的普通链接点击下载曾显示“贵组织屏蔽了此文件，因为它不符合安全政策”。本次没有改变安全策略，也不能把普通点击下载报告为通过；成功落盘使用的是同一导出链接的浏览器工具下载能力。日常 Chrome 点击下载仍需由用户或管理员处理其组织策略。

此次验证使用原生文字与图形，不包含外部图片生成或 rembg 抠图；它们仍需独立配置图像供应商或分割模型。旧设备的模板语料没有自动迁移至本机。

本机没有 Microsoft YaHei，LibreOffice 使用了本地替代字体；版式与文字可读，但不能声称字体外观与 SVG 预览完全一致。未运行整仓构建或整仓类型检查；本次没有改动应用源码。

## 生图服务地址更新（2026-11-17）

按用户提供的服务地址，在本机忽略的 `.env.development.local` 保存：

```dotenv
OPENAI_BASE_URL=https://o10.top/v1
OPENAI_MODEL_CATALOG_URL=https://o10.top/v1/models
OPENAI_IMAGE_MODEL=gpt-image-2.6-sunburst
```

模型名采用本地 ppt-master 当前 OpenAI 后端的默认 2.6 标识，尚未通过该服务的已认证目录核实。未认证访问模型目录返回 HTTP 401；本机未配置此服务的 `OPENAI_API_KEY`，因此图片能力仍未启用，不能把保存配置或 PPT readiness 成功当作在线生图通过。

`OPENAI_MODEL_CATALOG_URL` 保存为后续模型发现和核对使用；当前图片生成端口不会自动同步目录。生成端点由 `OPENAI_BASE_URL` 规范化为 `/v1/images/generations`，参考图编辑使用 `/v1/images/edits`。未更换账号内文字/视觉模型，也未改动 Codex 全局服务配置。配置写入后重启本地开发服务，实际核对记录位于 `.data/local-preview/image26-config-verification.json`。

### 同日认证与模型名核验

随后按用户提供的密钥配置本机私有 `OPENAI_API_KEY`（文件权限 0600，不写入本文或版本控制）。认证访问 o10 模型目录返回 200，目前目录仅列出 `gpt-image-2`。`gpt-image-2.6-sunburst` 实际调用返回 404，因此有效配置改为 `OPENAI_IMAGE_MODEL=gpt-image-2`。通过插件自己的图片适配器真实生成并下载 1024×1024 图片成功，结果与图片保存在 `.data/ppt-image26/`。目录与响应没有证明该别名的底层版本为 2.6，不能仅凭保存配置宣称版本已验证。

当前账号文字服务的真实目录列出 `deepseek-v4.1-flash` 与 `glm-5.3-flash`；配置列表内的 Gemini / Claude 名称在该连接上返回 400，未作为默认角色启用。已为账号单独登记并启用 GLM 视觉模型，主聊天选择保留 DeepSeek。PPT 角色通过服务器私有 `CORDIS_PRESENTATION_AGENT_MODELS` 显式选择账号已有供应商及已启用模型；图片服务继续使用独立配置。当前分工为内容 DeepSeek，其余视觉专业角色 GLM，审核有独立上下文及只读输出合同。不是每个角色都强制使用不同模型。
