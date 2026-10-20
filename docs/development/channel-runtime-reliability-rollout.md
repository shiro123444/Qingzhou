# 渠道可靠性：租约、续排队与回调台账

这是在 [入站安全第一阶段](./channel-ingress-security-rollout.md) 之后，经用户授权实施的可靠性首批代码。它不是完整的 SQL inbox/outbox，也不提供端到端 exactly-once。

本文保留首批实现快照；后续 SQL 回调收发件与核对入口的代码进展见 [可靠性第二批](./channel-delivery-outbox-rollout.md)。第二批按用户要求暂未执行测试，不继承本文的测试结论。

## 本批已经实现

### 1. 长步骤使用有所有权的租约

- 删除原来的 `tryClaimStep` / 无条件 `DEL` 解锁接口；获取成功返回随机 owner token，竞争返回 `null`，Redis 错误不再放行执行。
- Redis 与内存实现均按 token 校验续租、释放；旧 worker 不能删除新 worker 的租约。
- 租期保持 35 秒，每 10 秒续租，Redis 租约命令有 5 秒上界。保守本地截止时间从命令发起时计算，迟到响应不能恢复已失效的所有权。
- 失租向执行器传播 AbortSignal，阻止之后的模型 / 工具调用、重试和结果写入。模型调用、流读取及客户端工具等待接入取消；清理流 reader、buffer timer 和专用连接。
- 每个 hook 调用前后也检查所有权，不能在第一个 hook 等待期间失租后继续发第二个。QStash 动态导入后、第一次发布前再次检查。
- 状态、运行元数据、步骤历史及事件在同一个 Redis Lua 操作中检查 owner 后提交；拒绝步骤倒退及过期步骤覆盖已推进状态。

这不是所有下游系统都支持的 fencing：已经开始的数据库写、模型请求或外部工具副作用不能撤回。工具层接收 signal 与所有权检查，但并非每个工具的底层网络库都支持取消。

### 2. 已提交的工具步骤与后续通知 / 排队分离

- `_stepTracking` 与 `_pendingNextStep` 随同步骤状态一次提交，不再在提交之后无保护地回写运行状态。
- 下一步排队失败时保留已成功状态。原步骤重试若发现已推进，只恢复待排下一步，不重新调用旧工具。
- 恢复排队再次失败，也不能把已提交状态改成 error。
- 提交成功后的 terminal stream 通知失败，不再让调用方误认为步骤没有提交。
- 错误路径仍必须成功完成带租约的状态提交，才能发送 completion；失去所有权不能绕过此约束。错误路径重新读取失败时保留已知消息及元数据，不用空状态覆盖原操作。

**恢复的触发条件是原请求重试或显式恢复调用。** 本批没有独立扫描器。待排信息仍在现有 Redis 运行状态内，继承其 TTL；旧版本已经提交的步骤没有这条记录。重复排队仍可能产生多个队列任务，由步骤租约与已完成步骤检查消化，不等于消息队列只收一次。

### 3. Hook 交付失败变得明确

- QStash 缺凭证或发布失败，不再降级成无法通过接收端鉴权的裸 fetch。
- fetch 有 10 秒超时、禁止重定向、检查非 2xx；未知网络结果不自动重发。
- QStash 单次逻辑发布最多三个网络尝试，共用该次发布的 deduplication ID。它不是跨 dispatch 的永久去重；已开始的 SDK 发布内部重试也不等于可以撤销。
- `operationId`、`hookId`、`hookType` 不允许被自定义 body 覆盖。
- dispatcher 返回独立的安全失败信息，记录固定错误码，不打印凭证、完整 URL、响应正文或原始供应商错误。
- runtime 在成功结果中返回 `hookDeliveryFailures`，而不是把通知失败当成工具失败重跑。QStash 发布成功只表示队列接受，**不代表下游平台已经收到消息**。

没有持久 outbox 时，失败日志和结果不是自动重投保证。自定义 webhook 接收方仍需实现自身的业务幂等；内置 Bot 回调的保护见下节。

### 4. Bot 回调增加 Redis 投递台账

作用域包含 platform、安装实例 / 应用、用户、平台 thread 与 operation；内部按步骤记录进度，按 operation 归一真正的最终 completion。

- operation 内使用带 owner 的 30 秒租约，10 秒单飞续租；Redis 命令有 5 秒上界。所有台账写入与释放都校验 owner。
- completion 开始后，迟到 step 不再编辑进度或重新触发 typing/reaction；重复 completion 不重发已确认分片。
- 消息 create/edit 前持久记录 `unknown_delivery`，得到成功响应后再确认 delivered。超时、响应丢失、确认前崩溃不能被当成 “没发过”。
- 已确认分片不会重发；尚未尝试的分片可以继续。实际渲染的分片计划被冻结，重试时 duration 或格式配置变化不能把新旧文本拼在一起；改变已开始投递的正文会报冲突。
- typing、reaction、标题等可选 UX 操作保持 best-effort，不因它们失败而阻止最终正文。
- 如果旧进度 edit 的结果不明，保留其未知记录并停止后续进度编辑；真正最终回复改为 **create 独立消息**，不复用可能仍被旧请求修改的 progress message。可能留下旧进度消息，但它不能覆盖独立最终消息。
- 最终消息本身结果不明时，不自动 edit→create 或整条重发；必须核对平台实际投递。
- `waiting_for_human` 不是终态 completion：跳过该最终回复分支，不写永久完成标记，不清理 active-thread，从而允许同 operation 批准后继续。本批不新增平台审批卡，进度仍由 afterStep 处理。

台账状态没有自动 TTL：已完成事件删除渲染正文，只保留必要标记 / 摘要；未知或部分投递保留计划用于恢复和核对。队列模式使用共享 Redis，缺失 / 故障时拒绝，不能隐式退回进程内存。非队列模式显式使用共享进程内存，重启会失去其记录。

## HTTP 状态与恢复含义

| 结果                                    | 状态 | 含义                                       |
| --------------------------------------- | ---- | ------------------------------------------ |
| delivered / skipped                     | 200  | 已处理，或重复 / 过期 / 非终态回调无需投递 |
| invalid_callback                        | 400  | 缺少有效身份或步骤索引，修复发送方         |
| busy / lease_lost / backend_unavailable | 503  | 暂不可处理，带 Retry-After                 |
| unknown_delivery                        | 409  | 平台结果不明，不允许盲目重发               |
| payload_conflict                        | 409  | 已开始投递后业务正文发生冲突，先核对       |

`retryable:false` 是接收端给出的诊断信息，不承诺 QStash 自动读取这个 JSON 字段停止重试。即使供应商再次投递，台账也不能把未知状态当成重新发送的许可。

## 上线顺序与必要条件

1. **先暂停新执行并排空旧 worker，再协调升级。不能新旧 worker 混跑。** 旧代码持有固定 35 秒锁并无条件删除，可能误删新版 owner 的锁；新版单靠 compare-and-delete 无法约束仍在运行的旧进程。Web、执行 worker、hook 发布端与回调接收端应同步更新。
2. 运行时目前使用既有无 hash-tag 的多 Redis key 原子提交，要求这些 key 位于同一逻辑 Redis 分片。**不能直接按原键布局部署到 Redis Cluster**；CROSSSLOT 会拒绝提交，而不是安全降级。回调台账自身已使用同 slot 标签，但不代表完整 runtime 支持 Cluster。
3. 开启 Redis 持久化与备份，配置不淘汰安全记录的内存策略并监控容量。断电、清库、淘汰或未持久化重启会丢失运行恢复信息和去重记录；不能把 Redis 台账当成 PostgreSQL outbox。
4. 确认 QStash 发布 token、接收端签名验证和访问保护配置可用。不会再为了兼容错误配置而做未认证降级。
5. 验证一条超过 35 秒的模型 / 工具调用、一次重复任务、一次排队发布故障、一次重复 completion、暂停后批准继续，以及中间分片响应不明。
6. 观察 owner loss、Redis timeout、hook failure code、callback 409/503 和台账容量。不要仅依据 agent 已完成或 QStash 已接受，就认定平台消息已送达。
7. 回滚前同样暂停并排空 worker。不要清理 unknown 台账来 “强制恢复”；先核对平台消息，再决定如何人工恢复。当前没有自动 reconciliation 或管理界面。

本批不新增数据库迁移，也不新增生产签名凭证。测试用 `AGENT_TEST_REDIS_SOCKET` 只用于隔离的临时 Redis UNIX socket，绝不使用应用的 `REDIS_URL` 做集成测试。

## 验证范围

已加入并运行：

- owner 竞争、过期替换、旧 owner 续租 / 释放失败、Redis 挂起与迟到响应；
- 慢步骤跨过旧 TTL、失租后不接受迟到结果、不发送后续 hook；
- 状态成功提交后通知失败 / 排队连续失败，成功状态不被覆写；
- 逐分片重复、未知投递、进度乱序、暂停恢复、渲染计划漂移；
- 真实隔离 Redis 上的 Lua 竞争、过期、状态 / 元数据 / 历史提交、跨实例 completion 与未知投递台账。

本批汇总验证：25 个测试文件、675 项测试通过，其中 5 项连接隔离的真实 Redis 6.2.14；全仓 `bun run type-check` 通过，定向 ESLint 无错误，`git diff --check` 通过。

单元测试使用 mock 平台接口，不等于供应商实网验证。真实 Redis 测试也不等于 Redis Cluster、断电持久化或供应商端故障演练。

## 下一批仍需实施

- PostgreSQL durable inbox/outbox、独立重投扫描器、退避 / DLQ、unknown 的人工核对流程与保留期管理。
- 明确 Redis 权威状态与 PostgreSQL 审计 / 发件箱之间的提交域：把审计表和 outbox 放入一个 SQL 事务，仍不自动等于 Redis 状态和发件原子提交。
- 外部工具与平台 API 的幂等键 / 结果查询。租约失效、进程死亡或提交结果不明时，已发出的外部副作用仍可能发生；不能承诺绝不重复。
- 跨进程 active-thread 管理、完整渠道 inbox，以及 Bridge 独立 local-mode completion 发送路径的台账统一。
- Cordis 渠道生命周期、QQ / 飞书流式展示及平台审批交互；本批未改这些功能。
