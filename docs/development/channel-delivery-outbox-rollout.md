# 渠道可靠性第二批：持久回调收发件与核对 API

本批接续 [租约与 Redis 回调台账](./channel-runtime-reliability-rollout.md)，实现的是 **Bot 回调投递层** 的 SQL inbox/outbox，不是微信、QQ、飞书等平台原始入站事件的完整 inbox。

按用户要求，本批不调用子代理、不执行测试；代码完成不代表已经验收、执行迁移或上线。上一批的 675 项测试结果不能作为本批的验证结果。

本轮静态检查：`bunx tsgo --noEmit`、定向 ESLint 均通过，`git diff --check` 通过；未运行 Vitest、数据库 / Redis 集成测试或平台实网验证。

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

## 后续验收清单（本批未执行）

- 真实 PostgreSQL 的唯一键争抢、SKIP LOCKED、owner CAS、过期回收、跨租户隔离；
- runtime Lua 提交后崩溃、SQL 写入后 Redis ACK 丢失、部分意图交接、坏 progress 不阻断 final；
- SQL/Redis I/O 迟到、消息超时、平台成功后 DB 确认失败；
- 多分片预算让出后续传，进程死亡和达到上限后的 dead；
- 旧 Redis partial/unknown 导入，JSON 字段顺序与首份渲染计划不漂移；
- 人工确认 revision 冲突、活跃租约拒绝、旧 owner 迟到写拒绝、审计与重排原子性；
- 账号删除、bot 禁用 / 转移、Messenger 解绑再绑定后的投递授权；
- 更新旧回调 handler、runtime Lua 参数等已有测试断言，再执行定向及集成回归。

## 未覆盖的边界

- 原始平台入站事件的持久 inbox、跨进程 active-thread 管理和不同 operation 的全局顺序；
- Bridge 独立 local-mode 完成发送路径、自定义外部 webhook 的统一持久台账；
- 核对前端页面、供应商自动结果查询、归档 / 保留期后台任务；
- 所有外部工具副作用的端到端 exactly-once；
- 在非受租约保护的 runtime 提交路径中，直接调用 dispatcher 之前的崩溃缺口。
