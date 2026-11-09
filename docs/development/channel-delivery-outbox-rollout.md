# 渠道可靠性第二批：持久回调收发件与核对 API

本批接续 [租约与 Redis 回调台账](./channel-runtime-reliability-rollout.md)，实现的是 **Bot 回调投递层** 的 SQL inbox/outbox，不是微信、QQ、飞书等平台原始入站事件的完整 inbox。

初始实现批次按当时要求未执行测试。2026-11-03 已补充隔离 PostgreSQL、Redis 和恢复扫描器验收，结果见本文末节。开发业务库迁移、生产调度配置及供应商实网验证仍需分别验收。

初始批次静态检查通过 `bunx tsgo --noEmit`、定向 ESLint 和 `git diff --check`。以下各节保留该批次的实现与部署边界，末节记录后续实际验证。

## 数据路径

```text
Agent step 执行结果
  └─ 带 owner 校验的 Redis Lua 提交
       ├─ 运行状态、步骤历史、元数据
       └─ 回调意图 + ready set（不继承运行状态 TTL）
            └─ 扫描器逐条写入 PostgreSQL outbox
                 └─ 确认 SQL 提交后 CAS 移除已交接的 Redis 意图
                      └─ SQL 事务：outbox → inbox
                           └─ worker + SQL operation/effect 台账
                                └─ 平台消息 API

旧 QStash 回调 → 原签名验证 → SQL inbox → 同一 worker
```

- 正常执行直接将内置 Bot callback 写入 SQL outbox，并用 Next.js `after()` 唤醒处理，降低延迟。
- 新版本进程在运行状态提交后、写 SQL 前死亡时，独立扫描器可以从 Redis 意图恢复，不依赖旧 run 请求再次投递。旧版本未记录的意图不能凭空补造。
- SQL 故障不把已经提交的工具步骤改成失败；意图保留到恢复。单条无效进度意图不能挡住同组最终回复；部分交接逐条移除，避免时间预算耗尽后永远重做数组前几项。
- Redis ready set 使用 SSCAN，不全库 KEYS。删除 / 缩减意图时比较原始值，不能删掉并发提交的新内容。
- 内置回调识别路径是 `/api/agent/webhooks/bot-callback`；自定义外部 webhook 仍使用原有 fetch/QStash 交付，不自动纳入本发件箱。

**提交域边界：** outbox→inbox 是 SQL 事务；运行状态和意图是 Redis 同次 Lua 提交；Redis→SQL 是 “先写 SQL、后确认 Redis” 的可重复交接。没有宣称 Redis 与 PostgreSQL 存在一个跨库事务。Redis 持久化、备份和不淘汰策略仍是丢失恢复信息前的必要条件。

## 数据库变更

新增 `0108_bot_delivery_queues.sql`，同步维护 schema 与迁移 journal：

| 表                     | 职责                                                                           |
| ---------------------- | ------------------------------------------------------------------------------ |
| `bot_delivery_jobs`    | 回调 outbox/inbox、唯一事件键、状态、退避、尝试次数、worker owner / 期限       |
| `bot_delivery_ledgers` | operation 内步骤高水位、completion 标记、逐分片效果、冻结计划、revision、owner |
| `bot_delivery_audits`  | 人工确认、死信重试、显式导入旧台账的用户审计记录                               |

- `(role, event_key)` 唯一。事件身份绑定平台 / 应用或安装实例、用户、thread、operation，再区分 stepIndex / 真正 completion。
- 正文以运行时提交时的 JSON 快照为准，后置通知 hook 不改变它；首份 payload 不被重试覆盖；意图哈希规范化对象键序，忽略 duration、elapsedMs、executionTimeMs 及 hook 运输标识。
- 运输 payload 使用 **JSON wire text**，并约束其为有效 JSON 对象，避免数据库或代理 JSON 解码器重排旧 Redis 指纹所依赖的字段顺序；台账使用 JSONB。入站校验不重排原始 payload。
- outbox 成功转交即清正文；inbox 完成后清正文，保留去重标记。未知、部分投递和死信保留恢复所需数据。
- 三表用户外键级联删除；扫描器确认用户已不存在时丢弃其 Redis 待交接内容。旧 Redis 台账仍需纳入隐私 / 保留期治理，不会因 SQL 外键而自动删除。
- 未生成 Drizzle 全量快照：仓库已有迁移与快照缺口，本批不借生成器重写旧迁移。

## Worker 和恢复

- 每次只 claim 一个工作项，使用 `FOR UPDATE SKIP LOCKED`；不预领一批后任其排队过期。
- job 租约 60 秒，15 秒续租；台账租约 30 秒，10 秒续租。SQL 消息效果写入同时检查台账 owner 和对应 job owner。
- 失去 job 或台账所有权即停止后续效果。SQL/Redis 控制 I/O 有 5 秒等待上界，迟到响应不能重新授予调用方发送许可。超时不是回滚确认，迟到 SQL 仍可能提交，重试以持久状态为准。
- 过期 running 项由扫描器回收，指数退避；达到 8 次上限进入 `dead`。普通可重试错误同样退避，有上限而不无限热循环。
- 最终回复优先于旧进度。逐分片发送保留先写 unknown、确认后 delivered 的规则。
- SQL worker 每轮最多开始 16 个新消息效果，并在约 20 秒预算后在分片之间让出；预算让出不消耗失败重试次数。
- 每个消息效果最多等待 30 秒。底层 SDK 若不能取消，请求仍可能晚到；这种情况保持 unknown，不擅自假定失败。
- unknown/payload conflict 进入人工处理状态；不会因定时器、租约超时、重复 QStash 或重启而被自动清空。
- worker 领取回调后读取当前绑定和启用状态，拒绝已关闭 / 转移的专属 bot 或已解绑的共享 Messenger；这不是对已开始请求的即时撤销。新 Messenger 回调携带原发送者平台身份，防止解绑再绑后把旧回复送到旧账号。

回调中的 typing、reaction、标题仍是可选 UX，不保证 exactly-once。外部平台已经接受的请求不能被 SQL 租约撤回。

## 调度入口

新增：

```text
GET  /api/agent/delivery/cron
POST /api/agent/delivery/cron
Authorization: Bearer <CRON_SECRET>
```

缺少 secret 返回 503，错误凭证返回 401。入口不接收用户 ID、正文、目的地址或绕过状态的参数，响应禁止缓存。

**必须配置独立调度器** 定期访问入口，建议从每分钟一次开始并根据积压调整。可以使用部署平台 cron 或自托管定时任务；本批没有替用户创建供应商调度、修改套餐或执行实网请求。`after()` 只是即时唤醒，不是无人值守恢复的替代品。

响应计数包括 `staged`、`stagingErrors`、`transferred`、`delivered`、`deferred`、`recovered`、`discardedDeletedUsers`。监控 stagingErrors、dead/unknown 数量、待处理年龄、租约丢失与数据库容量；不能只看 HTTP 200。

原 `/api/agent/webhooks/bot-callback` 仍由 QStash 签名保护。旧请求必须具备 userId、operationId 和有效 stepIndex（step 类型）；极旧的缺字段请求不会被自动猜测身份，需要从拥有者记录核对后重新签名重放：

- 202 accepted：SQL 已收件，**不等于平台已送达**；
- 200 skipped：人工确认暂停等不需要最终投递；
- 400/413：无效身份 / 步骤信息或过大正文；
- 409：同一事件的业务正文冲突；
- 503：未确认收件，发送方应重试。

队列步骤调度本身仍使用 QStash，本批并未移除其 token / 签名配置要求。

## 人工核对入口

新增受登录保护的 tRPC `botDelivery` router，所有数据库查询和修改都使用 `ctx.userId`，客户端不能指定他人 userId：

| 方法           | 用途                                                                     |
| -------------- | ------------------------------------------------------------------------ |
| `list`         | 按状态筛选，按时间和 ID 分页；不返回完整投递正文                         |
| `inspect`      | 查看本人 scope 的台账、revision、目标摘要、工作项与最近审计              |
| `importLegacy` | 核验本人 operation，将无活跃旧 owner 的旧 Redis 台账导入 SQL；不发送消息 |
| `reconcile`    | 对具体 unknown effect 人工确认已送达或确实未送达                         |
| `retryDead`    | 修复配置等问题后重新激活本人 dead 工作项，并记审计                       |

`reconcile` 需要：

- `scopeKey`、`effectId`、`expectedRevision`；
- `resolution = confirmed_delivered | confirmed_not_delivered`；
- 实际核对说明 `note`、证据引用 `evidence`；
- 显式 `acknowledgeDuplicateRisk: true`。

操作必须没有活跃租约 / 工作项，台账至少静置 60 秒，且 revision 与读取时一致。修改效果、清除旧 owner 和记录审计在一个 SQL 事务中完成，旧 worker 不能把人工结果覆写回去。

### 核对顺序

1. 先确认旧 worker / 平台请求已停止或已经得到确定结果；必要时排空处理进程。
2. 到平台核对实际消息和对应分片，保存消息 ID / 查询结果引用；不要把秘密令牌写进 evidence。
3. 若已送达，确认该 effect 为 delivered；若确实没送达，再确认 not-delivered。
4. unknown 投递工作项可重新入队，仍受终态、步骤高水位与分片标记保护；旧 progress 不会被强制重新展示。
5. 如果工作项已进入 dead，还需单独调用 `retryDead`。payload conflict 不会被 “重试死信” 自动消除，本批也不提供强制覆盖已投递正文的 API。

这是人工声明与审计，不是服务端已经查询并核实了供应商。静置 60 秒本身也不是 “外部请求绝不晚到” 的证明。盲目确认 not-delivered 仍可能导致重复消息。

`importLegacy` 的输入是本人 operation 及完整目标作用域，不接受任意现成 hash。旧记录没有原始收件工作项时，导入只提供核对能力，不凭渲染文本伪造新 callback；恢复投递需要原始、重新通过鉴权的回调重放。

## 升级与回滚

1. 备份 PostgreSQL 和 Redis；检查 Redis 持久化、不淘汰策略、容量及单分片部署条件。七键 Lua 提交包含全局 ready set，不能只给 operation key 加标签就认定支持 Redis Cluster。
2. 暂停新任务，排空旧运行 / 回调 worker，避免旧 Redis writer 与新 SQL writer 混跑。
3. 按项目迁移流程应用 0108。**本轮未执行该迁移。**
4. 协调更新 API、runtime worker、回调 receiver，并配置独立 cron。
5. 旧 Redis 台账按 scope 首次使用时只读导入；有旧 owner 或无法读取 Redis 时拒绝凭空建立 “全新、未发送” 历史。旧 key 暂不删除。
6. 大规模开放前执行下一节验收，观察 staged→transferred→delivered、unknown 和 dead。
7. 回滚必须先排空新版 worker。旧 Redis 台账不会持续同步 SQL 的新效果，**不能直接回滚到只读旧 Redis 的发送代码**，否则可能重复发送；需先核对 / 迁回效果状态或暂停投递。

本批没有运行迁移、没有创建线上 cron、没有提交 Git，也没有调用实际平台账号。

## 初始批次待验收清单

- 真实 PostgreSQL 的唯一键争抢、SKIP LOCKED、owner CAS、过期回收、跨租户隔离；
- runtime Lua 提交后崩溃、SQL 写入后 Redis ACK 丢失、部分意图交接、坏 progress 不阻断 final；
- SQL/Redis I/O 迟到、消息超时、平台成功后 DB 确认失败；
- 多分片预算让出后续传，进程死亡和达到上限后的 dead；
- 旧 Redis partial/unknown 导入，JSON 字段顺序与首份渲染计划不漂移；
- 人工确认 revision 冲突、活跃租约拒绝、旧 owner 迟到写拒绝、审计与重排原子性；
- 账号删除、bot 禁用 / 转移、Messenger 解绑再绑定后的投递授权；
- 更新旧回调 handler、runtime Lua 参数等已有测试断言，再执行定向及集成回归。

## 初始批次范围边界

原始平台入站 inbox 和会话恢复已在后续实现，2026-11-03 的测试覆盖见末节。以下记录初始投递层批次的边界，其他路径仍需单独验证。

- 原始平台入站事件的持久 inbox、跨进程 active-thread 管理和不同 operation 的全局顺序；
- Bridge 独立 local-mode 完成发送路径、自定义外部 webhook 的统一持久台账；
- 核对前端页面、供应商自动结果查询、归档 / 保留期后台任务；
- 所有外部工具副作用的端到端 exactly-once；
- 在非受租约保护的 runtime 提交路径中，直接调用 dispatcher 之前的崩溃缺口。

## 2026-11-03 恢复链路验收

使用临时 PostgreSQL 17 与 Redis 7 容器。数据库限定为本机 `qingzhou_channel_test`，每个测试套件创建随机 schema 并在结束时删除。Redis 使用独立本地端口的数据库 15，测试拒绝默认 6379 端口，未使用应用 `REDIS_URL`，未清空开发业务数据。0108、0109 仅应用于隔离 schema。

本次共通过 138 项聚焦检查，其中 34 项连接真实数据库或 Redis。

| 范围 | 通过数量 | 验证内容 |
| --- | --- | --- |
| `botDelivery.integration.test.ts` | 10 | 收件去重、竞争领取、SKIP LOCKED、outbox 事务、旧 owner 拒绝、unknown 隔离、人工核对与审计 |
| `botInbound.integration.test.ts` | 12 | 原始入站去重、会话顺序、dispatch 前后崩溃恢复、控制通道、游标恢复、会话 owner 与停止传播 |
| `BotDeliveryService.integration.test.ts` | 7 | Redis 意图经 SQL outbox/inbox 恢复、SQL 写失败保留、迟到 ACK 的 CAS、无效进度不阻断 final、unknown 隔离、账号删除、跨 worker 分片续传 |
| `redisLease.integration.test.ts` | 5 | Lua 租约竞争、过期 owner 拒绝、运行状态原子提交、跨实例 completion 去重、未知投递保留 |
| `BotCallbackService.test.ts`、`callbackLedger.test.ts`、`BotInboundService.test.ts`、`deliveryEnvelope.test.ts` | 104 | 平台投递、台账、入站 worker 和回调身份的聚焦单元回归 |

新增扫描器测试使用真实 PostgreSQL、Redis、SQL 台账和 worker。平台回调入口由测试替身承接，其中分片恢复用例通过真实 `PostgresCallbackLedger` 记录效果，模拟第一次已发送、第二次尚未发送时中断，重建 worker 后仅发送剩余分片。SQL 故障与并发更新在明确的边界注入。测试没有调用真实平台消息 API，也没有模拟整台数据库断电。

修复了既有台账测试的异步时序假设。测试现在等待发送函数实际进入后再推进时钟，并检查超时后 `unknown_delivery` 标记保留，避免由微任务数量变化产生假失败和未处理拒绝。

### 复现入口

给隔离容器分配临时本地端口，将 `CHANNEL_TEST_DATABASE_URL` 指向专用测试库，将 `CHANNEL_TEST_REDIS_URL` 指向临时 Redis 的 `/15`。两个地址均有本地测试限定检查。既有 UNIX socket 入口 `AGENT_TEST_REDIS_SOCKET` 继续可用，且不能与 URL 同时提供。

```powershell
# 在 packages/database 中执行
bunx vitest run --silent=passed-only src/models/__tests__/botDelivery.integration.test.ts src/models/__tests__/botInbound.integration.test.ts

# 在仓库根目录执行
bunx vitest run --silent=passed-only src/server/services/bot/__tests__/BotDeliveryService.integration.test.ts src/server/modules/AgentRuntime/__tests__/redisLease.integration.test.ts src/server/services/bot/__tests__/BotCallbackService.test.ts src/server/services/bot/__tests__/callbackLedger.test.ts src/server/services/bot/__tests__/BotInboundService.test.ts src/server/services/bot/__tests__/deliveryEnvelope.test.ts
```

本次改动文件的定向 ESLint 通过。全仓类型检查沿用当前工作区基线诊断，需在发布前处理。剩余验收包括真实供应商发送与结果核对、部署环境独立 cron、开发/生产迁移、数据库断电持久化，以及服务实例整进程终止和网络分区故障演练。

2026-11-03 渠道管理页联调时，已备份本机开发库，并通过项目迁移入口补齐 0108、0109。上文“未执行迁移”记录的是初始实现批次。生产迁移与独立恢复调度仍需分别验收。

## 2026-11-09 群聊摘要增量

QQ（官方机器人和个人 NapCat）、飞书/Lark 可在「通道 → 机器人 → 活动」逐群开启文本采集和每日摘要。默认关闭；只允许选择当前账号、当前机器人已收到过消息的群。接收方必须已开通平台的相应全量群消息权限，否则摘要只能覆盖实际收到的消息。微信个人聊天全量同步不属于这一增量。

- 验签后的新入站事件与摘要原文在同一个 SQL 事务保存。重复回调不重复采集，启用前已收到的消息不回填。采集使用当前群策略及发言人白名单，与 @/关键词唤醒独立，不为每条消息调用模型。
- 每日时间采用北京时间。数据库保存到期时间、修订号、单次执行租约和已处理消息游标。每个 worker 请求最多生成一份摘要；没有新文本时跳过模型。启用摘要时需为机器人明确选择模型/provider。
- 每次最多 200 条 / 40,000 字符；单条保存前 2,000 字符。超额消息留待后续每日计划，摘要明确标示遗漏和裁剪。原文保留 7 天，因此持续超额可能导致未处理原文过期；不能把摘要当作完整群历史。
- 摘要使用独立的无工具结构化模型调用，消息仅为不可信引用材料。模型等待最多 45 秒，任务租约为 90 秒；失败/进程中断不在本次计划中自动重放，后续每日计划继续处理仍在保留期内的未读消息。
- 摘要结果、游标推进与可选 outbox 意图同事务提交。NapCat、飞书/Lark 可选择发回原群，复用现有发送台账，每次外发重新检查计划修订、当前账号/机器人、启用状态、群权限、目标和完整内容。改变规则会撤销旧待发送意图。官方 QQ 通道要求近期被动回复上下文，只保存摘要；个人 NapCat 使用 OneBot 主动发送接口，二者独立配置。
- 禁用停止新采集；删除计划会清理原文、历史摘要和队列中的待发送正文。已经提交给平台的消息不会被撤回。摘要保存 30 天；过期清理随摘要 worker 分批执行。

### 部署

1. 先按项目原迁移流程执行 `0113_channel_digests.sql`，再启用新版接收入口。迁移新增三个表，不更改已有消息。本机开发库已在停库备份后完成迁移；生产库仍须单独执行。
2. 保留原 `/api/agent/delivery/cron` 发送/接收恢复调度，另每分钟调用一次 `/api/agent/delivery/cron?lane=digest`，使用相同 `Authorization: Bearer <CRON_SECRET>`。摘要不加入实时消息唤醒路径，也不阻塞 control lane。部署平台请求时限应至少 60 秒；单实例一分钟一份摘要的吞吐不足时，可增加独立调度频率/并发，数据库领取会隔离任务。
3. 登录通道页面选择已出现的群，设置每日时间，按需启用「发回原群」。不需要新建聊天路由。未部署独立调度时，仅保存规则不会自行运行定时任务。

验证使用隔离的内存 PostgreSQL（PGlite）执行真实 0108/0109/0113 迁移，覆盖新事件与采集事务回滚、去重、账号隔离、空消息窗口、容量限制、租约过期、配置撤销、原子 outbox、删除和保留期。它不代替生产 PostgreSQL 多连接锁竞争、真实供应商模型计费及飞书/QQ 账号联调；本次未调用真实平台发送 API。


## 2026-11-09 本机运行与个人 QQ

- 本机 PGlite 已备份并应用 0113，Redis 仅监听 `127.0.0.1:16379`。本地密钥、数据库、备份与状态均不进 Git。
- `node scripts/botChannels/install-local-worker.mjs` 为 macOS 安装当前用户的 LaunchAgent；需先启动应用、数据库并配置 `.env.development.local`。它独立运行 regular（10 秒）、control（2 秒）、digest（60 秒）与 gateway（60 秒）四条通道，防止模型等待堵住停止指令。它不会代替应用和数据库的启动管理。
- 健康文件为 `.data/bot-channels/worker-status.json`，只含进程与最近检查结果；停止后台服务可运行 `launchctl bootout gui/$(id -u)/com.qingzhou.local-channel-worker`。登录后自动启动，机器休眠或应用关闭期间不能接收实时消息。
- 在 QQ 通道新增机器人时选择「个人 QQ / NapCat」。填入实际登录 QQ 号、Universal 正向 WebSocket 地址和 OneBot Token。QQ 号通过 `get_login_info` 再核对；本机 `ws://127.0.0.1:3001/`，远程须 `wss://`，URL 不携带 Token。
- NapCat 消息上报格式必须选 Array；默认私聊关闭、群聊白名单，未选群在保存入站事件前过滤。只采集文本段，图片、语音、文件、转发内容暂不解析。自发消息忽略，避免摘要回群再次触发自身。
- Socket 受 Cordis 生命周期与 Redis 单实例租约约束，断线采用有上限的退避，销毁时关闭连接、心跳与待请求。对平台发送不自动重试；不明确的发送结果交由已有台账标记，防止重复回群。输出使用纯文本消息段，模型产生的 CQ 码不会成为群操作。
- OneBot 正向 WebSocket 没有消费确认或离线游标。本实现对已接收事件的数据库落盘做有限重试与去重，但断线、队列溢出或长时间数据库不可用仍可能漏采，不能承诺完整聊天备份。
- 配置白名单后，由另一位成员向测试群发送普通文本，使群出现在活动页；选择该群、每日北京时间和「发回原群」。这条链路不要求每条消息 @机器人，也不会为每条普通聊天启动模型。
- 微信现有 iLink 通道仍是机器人会话，不代表个人微信所有会话或群同步；扫码连接需要用户完成，不能用 QQ 验证代替。

协议参考：[NapCat 配置](https://napneko.github.io/config/basic)、[macOS 安装器](https://github.com/NapNeko/NapCat-Mac-Installer)、[OneBot 正向 WebSocket](https://github.com/botuniverse/onebot-11/blob/master/communication/ws.md)。自动测试用本机 OneBot 服务验证鉴权、账号核对、会话过滤、主动回群和销毁，并用 PGlite 验证采集—摘要—outbox 与撤销。真实账号验收必须另外核对实际收件群和发送结果。


本机端到端补充验收：使用隔离 SQL schema、本机鉴权 OneBot WebSocket 服务和当前账号配置的真实模型，输入 4 次事件（含 1 次重复），采集 3 条文本；生成摘要后通过正式 outbox 转 inbox、SQL 发送台账、BotCallbackService 和 NapCat messenger 回送 1 条，结果为 delivered，第二次摘要扫描为空。测试 schema 随后清理。它验证真实模型和完整应用发送路径，但发送终点是本机协议测试服务；真实 QQ 群尚需完成本机 NapCat 授权、提供测试群并核对群内收件。微信扫码与群同步能力须另行验收。
