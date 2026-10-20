# QQ、微信真实联调：从零配置

本文对应当前仓库的「智能体 → 渠道」功能。建议先完成微信扫码，再接 QQ 测试机器人。首次测试使用单独智能体、单独测试群/私聊，并关闭有外部副作用的工具。代码和数据库集成测试已可在本地执行；真实平台结果需登录账号后记录。

## 1. 准备本机服务

需要 Node.js、pnpm 10.33.0、Bun、支持 pgvector 的 PostgreSQL、Redis 和 S3 兼容对象存储。文字消息启动模型时也会初始化文件服务，因此对象存储配置同样必需。Docker Desktop 需要先启动到引擎可用；只安装 Docker 命令行还不够。当前测试用的内嵌数据库只包含隔离测试表，不能用于运行完整应用。

在 `D:\project\Qingzhou` 执行：

```powershell
npm install --global pnpm@10.33.0 bun@1.4.2
pnpm install
```

当前机器的 `bun` 尚未加入命令路径，`pnpm` 默认入口也不是项目要求的版本。上面的安装用于补齐命令；安装后重新打开终端，再执行后续命令。如果不希望安装全局命令，可以把 `pnpm ...` 替换成 `npx --yes pnpm@10.33.0 ...`，把 `bun ...` 替换成 `npx --yes bun@1.4.2 ...`。

使用项目已有的开发数据库配置时，先在本地编辑 `docker-compose/dev/.env`（可参考同目录 `.env.example`），再启动 PostgreSQL 和 Redis。这个命令会启动服务并保留已有数据：

```powershell
docker compose --env-file docker-compose/dev/.env -f docker-compose/dev/docker-compose.yml up -d --wait postgresql redis
```

若已有独立 PostgreSQL/Redis，可直接使用。新建专门的测试数据库，不要把迁移指向生产库。数据库须支持项目现有迁移中的 vector 扩展。

在仓库根目录创建 `.env.development.local`，填入本机实际配置：

```dotenv
APP_URL=http://localhost:3010
DATABASE_DRIVER=node
DATABASE_URL=postgres://postgres:替换为本地数据库密码@127.0.0.1:5432/替换为测试数据库名
REDIS_URL=redis://127.0.0.1:6379
KEY_VAULTS_SECRET=替换为随机32字节Base64
AUTH_SECRET=替换为另一份随机32字节Base64
CRON_SECRET=替换为第三份随机32字节Base64
AGENT_RUNTIME_MODE=local
S3_ACCESS_KEY_ID=替换为本地对象存储访问标识
S3_SECRET_ACCESS_KEY=替换为本地对象存储密钥
S3_ENDPOINT=http://127.0.0.1:59000
S3_BUCKET=qingzhou-wechat-dev
S3_ENABLE_PATH_STYLE=1
S3_REGION=us-east-1
S3_SET_ACL=0
```

对象存储可使用仓库已有 RustFS 方案，启动服务后创建对应私有存储桶；端口须与 `S3_ENDPOINT` 一致。本机这次联调的独立配置在 `.data/wechat-dev/compose.yaml`，重启命令与实际端口记录在同目录 `README.txt`。S3 服务与数据库一样只绑定本机，不公开存储桶。

可以用 `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"` 分别生成三次密钥。仅保存到本地文件，不贴到聊天、截图或 Git。数据库密码含特殊字符时需 URL 编码。`KEY_VAULTS_SECRET` 用于已有加密数据，不要随意更换已在使用的值。

运行配置检查，再迁移测试数据库、启动完整应用：

```powershell
node scripts/botChannels/check.mjs
bun run db:migrate
bun run dev
```

迁移包含 `0108_bot_delivery_queues`、`0109_bot_inbound_sessions`。检查脚本只输出变量是否存在，不输出值。这里需要本地完整前后端；仅运行 `dev:spa` 并连接生产 Debug Proxy 会把配置写入另外一个后端。

浏览器打开 `http://localhost:3010`，注册/登录自己的测试用户。创建「渠道联调测试」智能体，选择已配置且可正常对话的模型。先在网页中发送“只回复：网页模型正常”，确认模型配置有效。模型密钥在应用的模型服务设置中填写。

另开一个终端，保持投递恢复进程运行：

```powershell
node scripts/botChannels/worker.mjs
```

这个进程调用受 `CRON_SECRET` 保护的投递接口；普通消息与 `/stop` 使用两个独立循环。关闭终端可停止它。配置缺失时它会退出，不会访问外部平台。

本地 WebSocket/微信长轮询还需要启动网关。修改渠道后页面会触发连接管理；若始终显示断开，可从当前本地环境调用启动接口（脚本不会打印密钥）：

```powershell
node scripts/botChannels/start-gateway.mjs
```

## 2. 配置微信：使用页面扫码

1. 打开测试智能体的「渠道」页面，选择「微信」。
2. 点击「扫码连接」，用计划参加测试的微信扫码并确认授权。二维码过期就刷新。
3. 登录成功后页面自动填写 `botId`、`botToken`、`userId`，保存并启用渠道。不要手工复制或公开登录令牌。
4. 等到运行状态显示已连接，在微信打开这次授权生成的机器人会话，发送“只回复：微信联调成功”。
5. 核对只收到一份最终回复；初始“正在处理”提示属于独立确认消息。到「设置 → 机器人投递诊断」检查原始收件为“已处理”，回复发送收件箱为“已送达”。

当前代码使用微信 iLink 扫码和长轮询，账号能否出现授权入口取决于微信服务端开放情况。扫码授权被拒绝时记录页面错误即可，不能靠伪造 `botToken` 绕过。此接入不需要先申请公众号 AppID。腾讯官方实现也采用扫码、自动保存凭证与长轮询：[Tencent/openclaw-weixin](https://github.com/Tencent/openclaw-weixin)。本项目已有对应页面，无需另装 OpenClaw。

测试中重启网关后，微信游标从 PostgreSQL 读取；只有本批消息已被应用持久接收，游标才会前进。若接口不可达，先检查 `APP_URL` 是否是网关进程能够访问的应用地址。

## 3. 配置 QQ：先创建测试机器人

1. 打开 [QQ 开放平台](https://q.qq.com/)，用你的账号登录，在控制台创建 QQ 机器人应用，按控制台要求完成开发者信息。
2. 从应用的开发配置中取得 **AppID** 和 **AppSecret/clientSecret**。AppID 填本项目「应用 ID」，AppSecret 填「应用密钥」。无需手工填写 access token。
3. 在官方控制台配置测试成员/测试群或可用的沙箱目标，并把机器人加入该目标。权限、测试资格和页面名称以当前控制台为准；不要先拉进日常工作群。
4. 选择 QQ 消息接入方式。本项目默认 **WebSocket**，适合保持运行的本机测试服务；出站网络需能访问 QQ API。若你的应用权限只允许 Webhook，则使用下一节的 HTTPS 回调方式。
5. 在测试智能体「渠道 → QQ」填写凭证、保存并启用，等到状态已连接。
6. 在指定测试群 **@机器人** 发送“只回复：QQ 联调成功”，或从官方允许的测试私聊入口发送同一条消息。

QQ 官方在 2026-08-10 将接口域名统一为 `https://api.bot.qq.com`；本项目的网关发现与消息发送使用该域名，获取 access token 仍使用 `https://bots.qq.com/app/getAppAccessToken`。以[官方 API 调用指南](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/api-call-guide.html)和[变更记录](https://bot.q.qq.com/wiki/develop/api-v2/changelog.html)为准。

AstrBot 也可以接 QQ：它同时支持官方机器人和 OneBot v11（例如 NapCat）。清舟当前 QQ 渠道仅支持官方 AppID/AppSecret，不能直接填写 AstrBot 或 OneBot 服务地址。如果采用 AstrBot，需要另行实现清舟桥接插件，让消息、交互回答和文件回送继续走清舟的执行与投递链路；仅配置相同模型服务不会自动获得清舟系统能力。参考 [AstrBot 接入文档](https://docs.astrbot.app/platform/aiocqhttp.html)。

初始设置建议保留队列策略、关闭工具执行详情。持久收件模式对 QQ、微信和飞书逐条按线程处理，避免 SDK 的内存队列丢弃消息；停止命令可并行进入权限校验。

「负责人 ID / 允许用户」比较的是平台事件的发送者 ID。QQ 群/私聊通常传 openid，不能假定它等于普通 QQ 号码。初次仅限官方控制台配置的测试目标；取得真实平台 ID 后再收紧本项目白名单。不要为了验证连接而把机器人开放到所有群。

### QQ Webhook 模式

需要一个可以从公网访问的 HTTPS 应用地址，例如你已有的测试域名或临时隧道。把 `APP_URL` 改为该地址、重启应用，然后：

1. 在本项目 QQ 渠道选「Webhook」。
2. 把页面显示的回调地址填入 QQ 控制台。路径格式为 `https://你的测试地址/api/agent/webhooks/qq/你的AppID`。
3. 完成官方回调校验并订阅你测试场景需要的消息事件。
4. 如果控制台要求 IP 白名单，填写服务器真实出站公网 IP；不能用 `127.0.0.1`。

回调验签成功后先落库，再返回 HTTP 202。持久化不可用时返回 503，不能把它当成已经处理成功。QQ 不同应用可用的接入模式须按控制台实际权限确认。官方文档入口：[QQ 机器人开发文档](https://bot.q.qq.com/wiki/)。

## 4. 真实测试顺序与记录

| 测试      | 操作                                         | 应观察到的结果                         |
| --------- | -------------------------------------------- | -------------------------------------- |
| 基础文字  | 分别发送唯一文字测试编号                     | 每条事件一条原始收件；最终回复一份     |
| 连续消息  | 第一条生成中紧接着发第二条                   | 第二条等待会话，不静默丢失             |
| 停止      | 生成中发送 `/stop`，QQ群中按渠道规则 @机器人 | 停止当前会话；随后新消息可处理         |
| 图片/文件 | 一次一项，发送非敏感小文件                   | 能读取或清楚提示模型/权限限制          |
| 重启      | 一条已确认落库后重启应用和网关               | 未处理记录可恢复；已处理记录不重复执行 |
| 平台故障  | 仅对测试环境断开平台网络                     | 不确定结果进入诊断，避免盲目重复发送   |
| 权限      | 用未获允许的测试账号发指令                   | 不启动模型、不停止其他人的任务         |

每项记录测试编号、时间、平台、事件编号、执行编号、收到的最终回复数量、诊断状态与结论。不记录密钥、完整私聊内容或未经同意的联系人信息。首次真实消息仍由你从已配置的测试目标发送。

## 5. 诊断与恢复

「已连接」只证明平台连接建立，不证明模型和回送都成功。原始收件的“已处理”表示已完成路由/移交；最终发送结果看回复收件箱与投递账本。

2026-10-01 本机 QQ-006 已验证真实 `GROUP_MESSAGE_CREATE` 入库、`mentions[].is_you` 识别、智能体执行启动和错误回复投递。此前群消息不回复的原因是未接收全量群事件，以及用数字机器人 ID 比较提及 OpenID。修复后 QQ 投递账本为 delivered，但 TiniModel 模型请求返回 `401 auth_unavailable`（上游 OAuth 授权失效），独立模型连通性检查也失败；这次不能计为模型回复成功。需要配置可用模型服务后继续验证最终文字回复、原子能力和渠道交互；QQ 私聊尚未实测。

随后按用户选择保留 TiniModel 地址，改用服务真实模型列表中的 `deepseek-v4.1-flash`，启用已实测的工具调用能力。QQ-007 已通过：真实群 @ 消息启动智能体，调用 `lobe-calculator.calculate`，参数为 `17*23`，工具结果为 `391`；执行状态 done，1 次工具调用、2 次模型调用，最终回复为“QQ联调成功 / 计算器调用已完成：17 × 23 = 391”。投递账本的最终文字效果为 delivered，用户确认成功。微信和 QQ 共用该智能体，模型切换对两边生效；这个结果尚不能替代 QQ 私聊、Cordis 原子调用、交互暂停恢复或文件附件测试。

- `pending/running`：检查恢复进程、数据库、模型；不要反复重发相同测试消息。
- `session_busy`：上一个执行尚未释放会话，会自动延后；可用 `/stop` 请求中断。
- `unknown/unknown_delivery`：可能已启动工具或已送达，先核对平台会话和执行历史。确认后填写证据、原因，勾选风险确认，再人工恢复。人工操作保留审计且检查记录版本；旧页面会被拒绝。
- `dead`：重试次数耗尽，修复错误后使用诊断页面重试。

启动中的会话租约过期可被接管；已绑定执行编号的会话不会仅因租约到期被自动偷走，防止重复工具执行。数据库确认执行已经终止后，过期会话会由恢复任务释放。仍在运行或等待审批的执行不会被自动释放；孤立执行先核对状态，再通过停止或终态回调处理。已处理原始消息正文与已送达回复载荷会清除；未决载荷保留供恢复。

正式部署需将普通投递与控制通道调度独立于用户消息流量，保持 Redis 持久化。单机 local 模式进程退出会终止尚未完成的模型执行；它并不使模型运行本身具备崩溃后续跑能力。多实例或无常驻进程部署应配置 `AGENT_RUNTIME_MODE=queue` 与已有 QStash/Redis 执行基础设施，再运行两实例真实测试。不要只依赖 Next.js `after()`。

调度端点：`POST /api/agent/delivery/cron`（普通）及 `POST /api/agent/delivery/cron?lane=control`（停止命令），均需 Bearer `CRON_SECRET`。可以用随附 worker 常驻，或由部署平台独立调度。诊断页面显示每种回复状态的数量与最早记录时间，可据此监控积压；配置检查成功不代表平台账号已登录。

## 6. 通过微信调用系统能力

模型必须实际支持 tool calling，并在模型配置中开启 `functionCall`；只声明视觉能力不能保证工具调用。测试智能体需启用所需工具。目前 `qingzhou-system-capabilities` 通过智能体配置的 `plugins` 字段显式启用，提供 `catalog`、`invoke` 和 `ask`，尚无独立工具选择页面。普通对话配置不会自动获得这些能力。

执行链为微信收件 → 已认证的智能体执行器 → 系统能力工具 → Cordis `AtomicRuntime` → 现有系统服务。`userId`、账号工作区和工具权限来自服务端；模型参数不能覆盖执行身份。工具结果包含真实执行编号以及 started/completed 事件，业务失败仍报告失败。取消和执行租约检查会传递到原子调用；已提交的创建操作不会因后续取消自动撤销。

基础目录包括 `system.agents.list`、`tasks.list`、`tasks.create`、公式/图表的 measure/render。任务创建复用现有任务服务，保存为待处理任务，不自动开始执行。公式/图表渲染复用 PPT 工作台的向量引擎；SVG 写入当前账号文件存储并返回文件编号，`localhost` 文件链接只能在本机访问。微信发送器支持真实文件附件：从账号文件存储读取字节，经 AES 加密上传微信 CDN，再发送文件消息。渲染生成的文件可随最终回复自动回送；`files.deliver` 可以登记已有账号文件。当前实现限制单文件 1 字节至 25 MiB。工具登记成功与平台发送成功分别记录，不能把本地链接或登记成功当成附件已送达。其他平台须实现各自的附件传输接口后才能使用同样的回送流程。

完整 PPT 与素材能力复用工作台的生产装配和账号存储。主机配置好真实 `CORDIS_PPT_MASTER_ROOT` 与可用的 `CORDIS_PPT_PYTHON` 后，目录才展示对应公共原子操作和 `presentation.create`。创建 PPT 返回排队 jobId，需继续查询任务状态确认完成；私有 runtime 操作不会暴露给渠道。根目录必须包含 `skills/ppt-master/scripts/svg_quality_checker.py` 和 `svg_to_pptx.py`；缺少脚本时目录返回 `presentationReady: false`。完整生成管线直接调用校验器和转换器；`CORDIS_PPT_RUNNER` 仅供旧 JSONL 二进制端口使用，基础系统、任务和向量操作仍可用。

可按以下顺序测试，每条都必须核对工具历史及实际产物：

| 编号    | 微信指令                                                                                       | 核对证据                                                           |
| ------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| CAP-002 | 实际调用工具，创建测试任务，随后查看它并返回真实编号                                           | 创建、查询工具均成功；数据库有对应任务；最终回复已送达             |
| CAP-004 | catalog 查询 `presentation.formula.render` 参数，invoke 渲染 `x^2+y^2=z^2`，返回执行和文件编号 | Cordis completed 事件、账号所属文件及真实 SVG 内容；最终回复已送达 |

2026-10-01 本机微信 CAP-002 已验证创建和查询真实任务 `T-1`；应用内 CAP-003 已验证系统查询及公式测量；微信 CAP-004 已验证目录查询、Cordis 渲染和回复送达，用户确认收到执行及文件编号。独立 SVG 根节点封装已修复并重新验证原文件链接的真实内容。微信 FILE-001 已完成真实文件消息投递，账本中对应 file effect 为 delivered；手机能否打开 SVG 还需客户端确认。这些向量与附件测试不能替代完整 PPT 生成测试。

### 动态工具与渠道交互

2026-10-01 本机完整 PPT 生成联调已通过。使用 `hugohe3/ppt-master` 的真实脚本（版本 `44c10ed0bc3a9e1df7a25aa179ae7c26db09469b`）与本地 Python；主页面配置 `gemini-3.8-flash-high`，渠道机器人保持 `deepseek-v4.1-flash`。认证后的 readiness 返回 `available: true`。任务 `presentation-56d15a32-fbd2-4b9a-9432-c3b411aedfe7` 已完成，产出两页 PPTX、两份 SVG 预览和演讲备注；实际 PPTX 下载、原生文本、包结构校验及两页渲染检查通过。修复了模型服务成功响应包装的解析，以及原生导出要求的 `spec_lock.md` 字体角色元数据。排队与完成状态仍分别记录。这是应用服务端完整管线验证；QQ 读取该任务的真实渠道测试另行核对。

### PNG、文件与网络搜索

| 操作                           | 行为                                                                                                                                                                                                                             |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `images.render`                | 参数为 `block`（同公式/图表的语义源）、`scale`、`background`、`transparent`。复用 Cordis 向量引擎，生成真实 PNG 并存入账号文件；最大边长 4096 像素、总面积 800 万像素。只接受语义数据，不接受任意 SVG、外部图片 URL 或文件路径。 |
| `files.list` / `files.inspect` | 分页搜索当前账号文件并返回元数据。                                                                                                                                                                                               |
| `files.readText`               | 读取至多 1 MiB 的 UTF-8 文本，支持纯文本、Markdown、CSV、JSON，返回截断标记。                                                                                                                                                    |
| `files.createText`             | 新建文件，保留原文件；不接收本机路径。                                                                                                                                                                                           |
| `files.copy` / `files.rename`  | 复制为新文件编号，或仅修改已有文件名。                                                                                                                                                                                           |
| `files.importPresentation`     | 把同账号的 ready PPTX/SVG/PDF 产物转为应用文件，以便渠道回送。                                                                                                                                                                   |
| `web.search`                   | 调用现有搜索服务，返回至多 10 条标题、来源链接、摘要和日期。失败不伪装成空结果。                                                                                                                                                 |

创建、复制、PNG 渲染及 PPT 产物导入都会记录服务端附件回送意图；实际发送仍以投递账本为准。文件和网页内容是数据，不是改变工具权限的指令。电脑磁盘访问继续通过原生设备工具及其审批流程；本机联调账号当前没有连接设备。

搜索配置复用 `SEARCH_PROVIDERS` 和 `SEARXNG_URL`。本机已按 [SearXNG 容器文档](https://docs.searxng.org/admin/installation-docker) 部署服务，监听 `127.0.0.1:58080`，启用 JSON 输出和已实测能返回相关官方来源的 Yahoo。Bing 曾返回无关内容，Google 随后要求 CAPTCHA，当前不启用这两个引擎。Docker Compose 与随机服务密钥保存在忽略目录 `.data/search-dev`；重启命令为 `docker compose -p qingzhou-search-dev -f .data/search-dev/compose.yaml up -d`。机器人已启用 `lobe-web-browsing`，也可使用原生搜索与网页阅读工具。

QQ 群聊与 C2C 已接入 [腾讯新版 SDK 的富媒体接口](https://github.com/tencent-connect/qqbot-agent-sdk/blob/main/src/qqbot_agent_sdk/api_client.py)：私下上传账号文件字节，再用 `file_info` 单独发送，保留原 `msg_id` 和 Redis `msg_seq`。PNG/JPEG 按图片发送，其他文件按文件发送；本实现直接上传上限为 10 MiB。频道/DMS 未接入该回送方式。QQ 平台和机器人账号的实际允许类型仍需真实投递测试确认。

应用内 SKILL-001 已通过：DeepSeek 实际执行 12 次工具调用，生成 1280×320 PNG（9328 字节），创建文本“清舟小技能联调成功”，读取、复制并重命名，随后调用网络搜索。PNG 下载后通过格式、尺寸与视觉检查；原文本和复制件的真实下载内容一致。搜索返回资料时须继续检查相关性，不能仅因有 URL 就认定资料正确。QQ 的 SKILL-QQ-002 真实图片及文本文件投递正在等待用户发送测试消息。

`catalog` 同时提供公共 Cordis 原子操作和当前执行器允许发现的原生 Agent 工具。`agentTools` 每页最多 12 组；使用 `nextOffset` 查询下一页。传入 `agent.<identifier>` 查询组内函数，传入 `agent.<identifier>.<apiName>` 查询完整参数。原生工具通过 `lobe-activator.activateTools` 按需激活，再由已有 Agent runner 执行；不能通过 `invoke` 嵌套调用而绕过工具审批、设备策略或账号隔离。未配置服务、未连接设备和客户端专用工具仍受现有可用性限制。“可发现”不代表所有服务都已配置。

微信 CAP-006 应用内目录实测发现 16 组原生工具；CAP-007 已从目录发现并激活原先未选中的文档工具，真实执行只读 `listDocuments`。目录依赖执行上下文，其他账号、设备状态或渠道的结果可能不同。

需要用户补充信息时，模型调用 `ask`。机器人在微信发出问题并暂停原执行；原请求者可直接回答文本，或使用 `/answer <编号> <回答>`。自然回答仅接受同一账号、机器人、会话和发送者在本次暂停后收到的消息，旧队列消息不会自动作为新问题的答案。原生问卷支持 JSON 回答并验证字段、必填项和选项。

需要人工审批的原生工具会发出 `/confirm <编号>` 和 `/reject <编号>` 提示，仅机器人负责人可处理；普通“是/同意”不会自动批准工具。`/status` 查询当前执行和待响应交互；`/stop` 取消执行。模型不能替用户回答或自行审批。回答写入真实工具消息及 runner 上下文，再恢复同一执行；不会重新执行提问工具。local 队列也传递恢复输入，暂停不销毁完成回调。

文件字节来自账号所属文件，回送意图来自服务端落库的成功工具状态，并绑定原执行编号。系统不会从模型回复中的任意 URL 或文件编号解析并自动下载附件。CDN 上传准备失败可重试；已投递文本和文件不会重复发送；平台发送结果不确定时保留 unknown_delivery，须核对后恢复。

2026-10-01 微信 INT-002 已验证：原请求者直接回答 A，服务器写入 ask 工具结果并恢复同一执行，随后真实调用 `lobe-calculator.calculate` 计算 `17*23` 得到 391。提问通知和最终回复的投递账本均为 delivered，用户确认收到结果。INT-001 曾暴露自然回答路由及缺失 runner 工具结果的缺口；修复后使用新测试验证，未把旧答案自动用于新问题。手机客户端能否打开 SVG 附件尚未收到确认。

SKILL-001B 已验证 files.list 返回真实原文件与重命名复制件，files.importPresentation 转存完整 PPTX（23621 字节）。切换 Yahoo 后，SKILL-SEARCH-003 通过机器人实际检索命中 cordiverse/cordis 官方仓库及官方组织页。QQ 官方群聊接口已分别接受 PNG 与文本文件的私下上传并返回 file_info（srv_send_msg=false，未发送群消息）；最终可见图片和文件消息仍须核对 SKILL-QQ-002。微信、QQ runtime 状态均为 connected。
