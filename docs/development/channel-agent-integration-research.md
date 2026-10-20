# 微信、QQ、飞书：接入方式与 Agent 能力调研

调研日期：2026-09-29。结论用于清舟改造设计，不等同于三平台账号已经开通或完成实网验收。

本轮通过联网检索核对官方文档、官方实现仓库，并只读检查当前项目。平台文档存在更新与旧页面并存，具体配额、灰度资格、账号可见功能以测试应用后台及实测为准；搜索摘录不是完整接口合同。

配套：[改造流程草案](./cordis-channel-rollout-plan.md)。

## 一、先给结论

- **飞书应用机器人**：最适合先做完整协作 Agent 样板，覆盖双向会话、图片 / 文件、任务进度、交互审批、文档 / 表格 / 日历工具。关键是应用权限、资源权限和用户身份，而不只是填一个 App Secret。
- **QQ 官方机器人**：适合个人助手与群社区助手。必须区分 C2C、群、频道；官方已经有 C2C 流式接口，不能把仓库的 `supportsMessageEdit: false` 当成 QQ 全平台能力上限。
- **个人微信 iLink**：适合熟悉微信的用户与个人助手私聊，扫码路径与现有项目最贴近；先做可靠对话、图片 / 文件任务、最终结果交付。不能承诺普通微信群、群管理、任意联系人主动触达。
- **企业微信智能机器人**：是另一条正式企业协作路线，有单独的 Bot ID/Secret、长连接和流式能力；不能直接复用个人微信 iLink 凭证。需要时新增独立渠道。

模型推理和工具编排可以复用同一个清舟 Agent 内核；差异主要是输入媒体、身份 / 权限、回复窗口与输出呈现。**收到图片不代表模型有视觉，收到音频不代表已转写，模型能读图也不代表能生图。**

## 二、微信：必须区分三种接入

### 2.1 个人微信 iLink / ClawBot

**来源与可信范围**

腾讯维护的 [Tencent/openclaw-weixin](https://github.com/Tencent/openclaw-weixin) 及其 [协议说明](https://github.com/Tencent/openclaw-weixin/blob/main/docs/protocol.md) 可作为一手实现参考。[OpenClaw 渠道文档](https://docs.openclaw.ai/zh-CN/channels/wechat) 也明确它是外部插件。它们不应被扩大解释成 “任意微信账号、所有场景都有开放平台 SLA”。

**怎么接**

1. 确认目标微信账号 / 客户端可使用对应入口，准备一个长驻网关服务。
2. 发起二维码授权，用户在微信扫码确认；获得 bot token、bot ID 及服务端返回的连接信息，服务端加密保存。
3. 使用 `getupdates` 长轮询收件，携带并保存同步 cursor；它不是 WebSocket，也不是用户需要配置的公网微信 webhook。
4. 保存入站会话对应的 `context_token`，调用 `sendmessage` 回复；媒体走协议的下载 / 解密、上传流程。
5. 绑定清舟用户 / Agent 并做白名单、预算和工具授权。长轮询进程与 Web/API 进程可以分开，但内部转发不能裸露无认证。

**官方实现可见的能力**

- 私聊、文本、图片、语音、文件、视频、输入状态提示、多账号接入。
- 协议类型含 `group_id`，但官方文档明确字段存在不等于功能支持；当前公开插件能力元数据不声明群聊。
- 回复推荐回传入站 `context_token`；协议没有提供可据此承诺的统一官方有效期。不能将缓存 24 小时等同于 “24 小时一定可发”。
- 社区 issue 中 context 失效时间存在差异，只能作为测试线索，不是配额或 TTL 依据。不能保证长时间无用户互动后仍可主动定时推送。
- 文本的 `message_state` 不是 “已有可编辑 token 流 UI” 的证明。首轮按 typing + 最终消息设计。

**清舟已有代码**

- 平台定义：`src/server/services/bot/platforms/wechat/definition.ts`，`connectionMode: 'polling'`，不支持消息编辑。
- 扫码 UI：`src/routes/(main)/agent/channel/platform/wechat/QrCodeAuth.tsx`；服务端入口在 `src/server/routers/lambda/agentBotProvider.ts`。
- `client.ts` 已长轮询、处理 context token、转发消息和恢复媒体；`packages/chat-adapter-wechat/src` 有协议、下载 / 解密和消息适配。
- `service.ts` 的消息工具目前主要支持发送；读历史、搜索、编辑、群 / 频道管理等明确抛出不支持。

这些是静态代码能力，不意味着所有媒体格式都已实网跑通。尤其当前聊天最终回复与 message tool 主要是文本出口，不能因为入站能收文件就宣称 PPT 文件已能完整回传。

**能做到何种智能**

- 近期：私聊连续问答、截图 / 照片理解、文件摘要、基于授权知识库检索；先把图片与文件端到端链路验证好。
- 改造后：在微信发需求 → 清舟执行 PPT / 资料整理 → 查询任务进度、取消或继续 → 返回结果 / 受保护的任务链接；直接文件回传需补对应媒体出口。
- 有条件：语音助理需要转写，语音回复需要 TTS / 支持的音频封装；视频理解取决于实际模型及媒体处理，不自动继承。
- 不承诺：普通微信群助手、聊天历史全量读取、任意好友 / 群操作、无限主动消息。

**必须补齐**

认证内部转发；入站持久化与 cursor 提交顺序；连接单实例租约；完善 context 失效后的任务 / 投递状态处理；媒体安全与出站文件能力。现有 API 已有业务错误检查，重点是把错误接到可恢复任务与投递状态，而非重复造一套错误判断。长任务通知失败仍需保留结果，等待用户下一次交互查询，而非静默丢弃。

### 2.2 企业微信智能机器人 / 自建应用

**怎么接**

- 智能机器人 API 模式：后台创建机器人，按选定连接模式获取 **Bot ID + Secret** 或配置回调；长连接使用官方文档的 WebSocket 协议或官方 SDK。
- 长连接需鉴权、心跳、重连和连接归属管理；文档说明同一机器人同一时刻只能有一条有效长连接，不能多副本无协调地同时订阅。
- Webhook 模式需要公网入口及平台要求的签名 / 加解密；不能照搬 iLink 的轮询协议。
- 若需要组织身份 / 其他业务 API，还可能需要企业自建应用的权限与 access token；它与机器人连接凭证是两套授权边界。

官方来源：[智能机器人长连接](https://developer.work.weixin.qq.com/document/path/101463)、[接收消息](https://developer.work.weixin.qq.com/document/path/100719)、[自建应用与智能机器人的对接](https://developer.work.weixin.qq.com/document/path/101521)、[官方 Node SDK](https://github.com/WecomTeam/aibot-node-sdk)。

**可以做**

内部单聊 / 群 @ 的办公助手、流式 Markdown、任务状态和模板卡片、受权的知识检索 / 业务调用。长连接支持主动推送，但需满足会话前置条件和限额；不等于向任意客户无限发送。

流式回复有 stream ID、关联请求及结束语义；官方文档对单次流式生命周期有上限。任务执行寿命应与卡片 / 消息流寿命解耦，长任务结束后再走合规通知或任务页。

**不可混淆**

企业微信群不等于外部联系人群或客户群。当前调研不足以把机器人群能力扩展为任意外部群能力；部署前还须核对产品帮助中心、后台准入和具体群类型。企业会话存档、客户联系等也不是启用机器人后自动获得。

**项目状态**

当前 `wechat` 实现是 iLink，不是企业微信。建议另建 `wecom` 渠道、凭证 schema 和连接适配；不改名覆盖已有微信用户数据。

### 2.3 微信公众号

适合面向关注用户的咨询 / 客服入口，而不是直接替代个人助手或企业群协作。

典型接法为公众号开发者配置 AppID / 密钥、回调 URL 与签名 / 加解密，接收消息后快速应答，再按接口资格和交互窗口使用客服消息发送结果。

官方 [被动回复文档](https://developers.weixin.qq.com/doc/subscription/guide/product/message/Passive_user_reply_message.html) 要求在短时间内响应；异步长任务应与被动应答解耦。[客服接口说明](https://developers.weixin.qq.com/doc/subscription/guide/product/kf/intro.html) 的交互窗口与条数限制不能拿来套到 iLink 或企业微信。

不纳入首轮改造，除非产品明确需要公众号客服场景。

## 三、QQ：官方机器人按场景接入

### 3.1 接入步骤

1. 在 [QQ 开放平台](https://bot.q.qq.com/wiki/bot_new_product-intro/) 确认个人 / 企业主体、创建机器人并获取 AppID、AppSecret。不要把 “可注册” 当作所有接口 / 公开服务已获批。
2. 配置测试 / 沙箱账号、群或频道，确认服务范围、权限、所需正式环境 IP 白名单与审核流程。
3. AppID/AppSecret 换 access token，业务请求使用 `Authorization: QQBot ...`，实现缓存和刷新。
4. 配置 WebSocket 或 Webhook 接收事件。两种路线都见于当前官方文档；部署选型不能仅凭旧博客断言某一种已全面停用。
5. 按实际场景订阅 C2C、群 @、频道等事件。若希望接收更多群消息，必须验证相应权限，不默认采集全群消息。
6. 在清舟 Agent 渠道设置填入应用信息，选择连接方式、单聊 / 群准入与白名单，再进行双向消息测试。
7. 审核、上线和服务范围确认后才扩展到真实用户。

官方来源：[API 调用指南](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/api-call-guide.html)、[WebSocket](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/event-emit/websocket.html)、[Webhook](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/event-emit/webhook.html)、[消息收发概述](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/overview.html)。

### 3.2 一个需要优先处理的版本差异

官方 [变更记录](https://bot.q.qq.com/wiki/develop/api-v2/changelog.html) 的 20260810 条目说明 API 域名统一到 `api.bot.qq.com`。

仓库 `packages/chat-adapter-qq/src/api.ts` 仍使用 `bots.qq.com` 获取 token、`api.sgroup.qq.com` 调业务接口；仓库 `qq/protocol-spec.md` 也保留旧地址。部分官方旧页面仍列旧域名及沙箱地址。

因此应做当前账号的端点兼容测试、迁移计划和契约测试；**没有证据说明旧地址现在必然失效，也不能继续把旧文档当作最新唯一规范**。生产与沙箱分别核验，不机械替换所有 URL。

### 3.3 官方能力与项目差距

**C2C 单聊**

官方 [流式发送单聊消息](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_openid_stream_messages.post.html) 提供 `/v2/users/{user_openid}/stream_messages`，有 stream ID、片段顺序、生成 / 结束等状态。可以做更自然的实时 AI 助手，但仍需账号权限与实际联调。

**群聊**

群 @ 问答、按开通能力提供 Markdown、富媒体、交互入口；不要把 C2C 流式参数用于群接口。官方新增群管理接口说明它可以进一步成为社区助理，但禁言 / 入群审批等是高权限工具，必须有实际权限和人工确认 / 明确策略，不应默认交给任何发消息者。

**频道**

消息、频道私信、线程 / 历史等能力与 C2C / 群并不一致。会话和权限模型分别验证，避免同一格式的 message ID 被错误复用。

**主动消息与长任务**

被动回复窗口、次数、主动消息资格与频控按场景不同。必须保存来源 msg/event ID、回复预算与截止信息；不把 “工具执行还没结束” 当作平台允许继续回消息。最终通知需要合规出口；否则保留清舟任务页结果供用户查询。

**清舟已有代码**

- `qq/schema.ts` 已支持 AppID/AppSecret、WS/Webhook、队列 / 防抖、DM / 群策略和白名单。
- `qq/definition.ts` 当前整体声明不支持 Markdown / 编辑；`client.ts` 有附件提取与消息出口，`packages/chat-adapter-qq/src` 有协议和事件处理。
- 本轮源码检索未发现 `stream_messages` 接入；“官方支持 C2C 流式” 不等于当前 QQ 机器人已流式回复。
- 平台级布尔能力需要升级为按 C2C / 群 / 频道及权限细分的能力描述。Markdown 的官方能力也不能仅靠打开布尔值就完成格式、权限与失败降级适配。

### 3.4 智能体验建议

- 近期：个人问答、群 @ 答疑、图片理解、授权知识库检索、任务查询。
- 改造后：单聊原生流式、文件 / 创作任务、社区知识整理和有限主动通知。
- 后续可选：受权限控制的群管理工具；先仅生成建议，再对实际操作加确认和审计。
- 不承诺：任意 QQ 用户 / 群触达、无限主动发送、无权限全群监听、群内原生流式与 C2C 同等体验。

## 四、飞书：用应用机器人，不用群通知机器人代替

### 4.1 选对机器人形态

官方 [机器人概述](https://open.feishu.cn/document/client-docs/bot-v3/bot-overview?lang=zh-CN) 区分：

- **群自定义 Webhook 机器人**：主要用于指定群通知，不能作为接收用户消息并调用 Agent 的完整双向入口。
- **应用机器人**：企业自建或应用商店应用，可申请权限并订阅事件，适合清舟双向交互。

首轮推荐企业自建应用。若要做跨客户 SaaS 应用商店发布，需要单独设计安装授权、租户 token、回调和审核，不应假定长连接方案可原样覆盖。

### 4.2 接入步骤

1. 在 [飞书开发者后台](https://open.feishu.cn/app) 创建企业自建应用，开启机器人能力，取得 App ID、App Secret。
2. 最小申请消息接收、发送 / 回复及需要的资源权限；先开单聊与群 @，不默认申请全群消息读取。
3. 订阅 `im.message.receive_v1`；要交互卡片则配置对应回调，如 `card.action.trigger`。
4. 长驻服务推荐官方 SDK 长连接；无需为了外部事件暴露公网 webhook，但内部转发仍需认证。Webhook 模式则按官方流程做验证、签名 / 解密与快速 ACK。
5. 配置应用可见范围并发布生效，将机器人加入测试群，在清舟填入应用配置并选择连接模式。
6. 单聊 / 群 @、图片和文件下载、消息回复、断线恢复分别测试，再接卡片和业务工具。

官方来源：[接收消息事件](https://open.feishu.cn/document/server-docs/im-v1/message/events/receive?lang=zh-CN)、[长连接接收事件](https://open.feishu.cn/document/server-docs/event-subscription-guide/event-subscription-configure-/request-url-configuration-case?lang=zh-CN)、[交互机器人教程](https://open.feishu.cn/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/quick-start/develop-a-card-interactive-bot?lang=zh-CN)。

### 4.3 流式卡片与操作确认

官方 [流式更新卡片](https://open.feishu.cn/document/cardkit-v1/streaming-updates-openapi-overview?lang=zh-CN) 和 [流式更新文本 API](https://open.feishu.cn/document/cardkit-v1/card-element/content?lang=zh-CN) 提供适合 AI 输出的能力。

- 开启流式模式，创建 / 发送卡片实体后更新目标元素；保存 card ID 与单调递增的 `sequence`，按接口支持使用幂等标识。
- 不把模型每个 token 都对应一次 API 调用：服务端合并 / 节流，再由客户端打字机效果显示。
- 卡片更新与交互有状态约束。首轮用 “执行进度流式卡片 → 结束流式 → 确认 / 取消卡片” 减少状态冲突。
- 官方指南与具体 API 页的限频表述存在不同层次，不宜据一句 “流式不触发 QPS” 就设计无限更新；采用可配置限速并在测试应用验证。

### 4.4 能做到的智能上限

- 双向多模态助手：理解消息 / 图片，下载用户发来的可访问文件进行检索和分析。
- 协作型任务助手：汇报任务进度、展示待确认操作、允许取消 / 继续、交付文档 / PPT 产物。
- 办公 Agent：检索知识库、读取文档 / 多维表格，确认后创建或更新文档、创建日程等 —— 这些需要额外实现工具，不是机器人一接上就自动有。

**权限必须分三层**：平台消息访问、业务 API 应用 scope、具体文档 / 日历资源 ACL。`tenant_access_token` 代表应用身份，`user_access_token` 代表授权用户身份；收到某用户发来的文档链接，不表示应用或其他群成员有权读取。

官方来源：[云文档权限概述](https://open.feishu.cn/document/server-docs/docs/permission/overview?lang=zh-CN)、[如何选择 token](https://open.feishu.cn/document/faq/trouble-shooting/how-to-choose-which-type-of-token-to-use?lang=zh-CN)、[日历资源与权限](https://open.feishu.cn/document/server-docs/calendar-v4/calendar/introduction?lang=zh-CN)。

### 4.5 清舟已有与待改

- `src/server/services/bot/platforms/feishu/definitions/schema.ts` 已有 App ID/App Secret、WS/Webhook、访问策略；默认连接方式来自 `const.ts`。
- `gateway.ts`、`client.ts`、`packages/chat-adapter-feishu/src` 已有事件接收、消息操作与媒体下载；队列序列化后通过原始媒体标识重新下载附件。
- 本轮源码检索未发现 CardKit 流式 API / 卡片动作 Agent 审批闭环；已有消息编辑或进度回复不等于完整卡片工作台。
- 外部 webhook 与内部网关转发认证需要区分；可选 verificationToken 不能替代所有模式的安全边界。
- 文档 / 日历工具、用户 OAuth、卡片 action 绑定用户 / 任务的审计流程需要单独设计。

## 五、清舟共用能力底座的实际情况

`AgentBridgeService` 已把平台附件交给 `client.extractFiles`，再进入 `AiAgentService`。`ingestAttachment.ts` 有下载、图片压缩、上传、文件记录和图片 / 视频 URL 处理，因此不必为每个平台另造一套视觉消息通道。

但 “可上传到存储” 不等于 “已解析为模型可理解内容”。需要逐项验证：

- 图片：读取权限、格式、大小、压缩、模型 vision 配置、供应商真实图片推理。
- PDF/Office：文件解析 / 索引与检索是否完成，不能只给模型一个不可读文件 ID。
- 语音：是否有可用转写；是否保留原文件；不能把只有文本 / 视觉能力的模型当作语音模型。
- 视频：模型 / 端点是否支持、长度和体积限制；否则提取可用信息或明确不支持。
- 产物：谁可下载、链接多久有效、撤销后如何处理，平台是否支持该文件格式 / 大小。

Bot 当前复用 Agent 执行和工具系统，但 shared Messenger 的账号绑定覆盖范围不同。三平台能进 Bot 流程，不表示三平台都已具备 “每个外部用户绑定自己的清舟账号并切换 Agent” 的完整产品流程。

## 六、建议落地顺序与验收场景

**顺序**：三平台先补共享安全 / 可靠性 → 飞书完整纵向样板 → QQ 按场景升级 → 个人微信以稳定和长任务兜底为核心。企业微信有明确需求再加独立渠道。

建议用同一组真实测试任务比较，而不是只看机器人能否回一句话：

1. 连续两轮问答，A/B 用户不串上下文。
2. 发同一张截图，模型确实读到图而非只读文件名。
3. 发一份文档，回答包含可核对的来源内容；无权限文件拒绝读取。
4. 创建 PPT 长任务，收到受理反馈，断线后可查询，结果可受权下载。
5. 取消 / 重试操作不造成重复工具副作用。
6. 请求创建飞书文档或管理 QQ 群时，没有权限或没有确认则不执行。
7. 模型超时、平台限流、context / 回复窗口过期时给出明确状态，不伪装成功。

本轮尚未执行上述实网验收，没有使用用户平台凭证。流程草案将每项能力的开发与验收放到对应阶段，而非把官方 API 列表直接计为已交付功能。
