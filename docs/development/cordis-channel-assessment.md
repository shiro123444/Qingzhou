# Cordis 多平台 Agent 增量改造评估

本文件保留改造前的只读评估快照，不代表运行时渗透测试结果。后续已获授权并完成部分入站安全修复，当前实现与迁移条件见 [第一阶段上线说明](./channel-ingress-security-rollout.md)；下文未更新的风险描述应结合该实现记录阅读，不能视为全部仍未修复或全部已解决。

## 结论

可以改造，且无需重写整套渠道。现有 Agent 执行、工具调用和部分平台注册已接原生 Cordis。要实现更稳定、更快，优先统一可信入站、会话顺序、任务租约与可靠出站，再让 Cordis 管理渠道生命周期；仅替换内核不会自动解决多实例并发和消息丢失。

## 已有基础

- `src/server/services/bot/platforms/index.ts`：Discord、Telegram、Slack、Feishu/Lark、QQ、WeChat、LINE；其中 WeChat 为 **iLink 个人微信路线**，不是企业微信或公众号。
- `src/server/services/messenger/platforms/index.ts`：共享机器人账号绑定目前为 Slack、Telegram、Discord，与 Bot 的平台覆盖不同。
- 主链路：`agent-hono/handlers/platformWebhook.ts` → `BotMessageRouter` → `AgentBridgeService` → `AiAgentService` → `AgentRuntimeService` → `packages/agent-runtime` → `ToolExecutionService`。已有访问控制、配对、topic 持久化、工具鉴权、队列 / 防抖，不应重做。
- `packages/agent-runtime/src/core/cordis-host.ts` 及 `src/server/services/toolExecution/index.ts` 已有真实执行桥接；`messenger/platforms/cordis` 已管理平台插件。
- Chat SDK 已有入站去重，`BotMessageRouter` 给状态存储设置机器人 namespace；不能把系统描述为 “完全没有去重”。`AgentRuntimeService` 也已有 operation/step 锁和 stepCount 重放检查。
- Bot 回复当前主要为 typing/reaction、step 进度和最终回复，不等于网页端 token 流。不同平台编辑消息能力不同。

## 优先风险与证据

### P0：可信入站边界

- `packages/chat-adapter-wechat/src/adapter.ts` 的 `handleWebhook` 直接解析 JSON；`src/server/services/bot/platforms/wechat/client.ts` 内部转发没有认证 header。若公开该入口且攻击者知道 appId，可伪造 sender；后续 allowFrom 不能替代可信 sender 认证。
- `packages/chat-adapter-feishu/src/adapter.ts` 的 verificationToken 仅配置时校验；相关 schema 凭据可选。需区分外部平台请求和内部网关转发，各自验签，不能只信 body token。
- `src/server/services/bot/platforms/telegram/client.ts` 的 secretToken 可选；未配置会关闭 SDK webhook 验证，属于配置 / 默认安全风险，不是所有 Telegram 部署必然不安全。

建议外部 webhook 强制对应平台校验；内部转发独立入口，服务身份 HMAC + 时间窗 + nonce，限制 body 大小。有效事件持久化后再 ACK。

### P1：多实例任务与会话隔离

- `AgentBridgeService` 的静态 activeThreads/activeOperations 等以 thread.id 作为键，进程间不共享，也缺少完整平台 /installation/ 用户维度。
- `AgentStateManager.ts` 锁固定 35 秒，Redis 异常 fail-open、无续租、释放直接 DEL；慢模型 / 工具超过租约后存在并发与旧 worker 删除新锁的窗口。
- SDK 队列有默认上限 / TTL，去重先标记再处理。已有机制不等于持久可靠 inbox，需要结合失败重投与长任务测试。

建议可信 SessionKey 至少包含 tenant/platform/installation/channel/thread/conversationOwner，并明确群聊共享还是逐用户分叉。持久 inbox 唯一键包含 installation + eventId；租约带 owner token、续租、fencing，释放 compare-and-delete，工具外部副作用另有幂等键。

### P1：可靠回调与出站

- `HookDispatcher.ts` 的 QStash 失败降级为普通 fetch，与 `agent-hono/index.ts` 的 bot-callback 必须通过 qstashAuth 冲突；降级可能 401 且不检查非成功状态。
- `BotCallbackService.ts` 缺少持久 operation/step/type 幂等与序号门禁，重复 completion 可能重复发送，迟到事件可能覆盖新状态。
- 微信轮询 cursor 先推进，转发失败仅日志且 cursor 仅内存；飞书网关转发也需检查 HTTP 状态，避免 “请求已发出” 被当作 “已接收”。

建议 outbox 唯一键 `(operationId,eventSeq,destination)`，发送台账、按平台 Retry-After 退避、死信与人工重投；完成态禁止迟到事件回退。取消无签名 fallback 或改为有验证的受信通路。微信 cursor 与 inbox 提交共同保证恢复语义。

## Cordis 化路线

1. **先修安全和可靠性**：上述 P0/P1 保持现有 AgentBridge、权限、DB、Chat SDK、QStash，避免同时替换过多组件。
2. **渠道生命周期插件化**：把既有 PlatformClient 包装成 Cordis plugin；用 `ctx.effect` 拥有连接、计时器、订阅和 stop，卸载时 drain 在途任务。
3. **统一事件与回复适配**：InboundEnvelope 只含验证后的身份 / 消息；统一 RunEvent → ReplySink。能力表覆盖 edit/card/typing/ 长度 /throttle，飞书 / Telegram 节流编辑，微信等按能力最终发送，不强行逐 token 刷屏。
4. **收敛兼容层**：明确原生 Cordis 与 `packages/cordis-kernel` 兼容职责，避免继续扩出第二套生命周期。通用 runtime/v1 路由默认 facade 仍需生产 bootstrap，不能因为 PPT 有独立装配就宣称全部通用 API 已生产启用。

## 验收条件

- 伪造 / 过期 / 重放 webhook 被拒绝，正常平台验证流程不受影响。
- A/B 租户或机器人同 thread ID 不串话、不互相阻塞。
- 两实例执行超过 35 秒的任务，锁超时 / 续租 / Redis 故障不重复工具副作用。
- 重复、乱序回调和进程重启后只回复一次最终结果。
- 平台 429、5xx、断连重试可观测，消息不静默丢弃。
- 微信 cursor 恢复与转发失败可重投，Cordis 卸载能释放资源并安全处理在途任务。
- 再对比首响时间、端到端 P95、重复率 / 丢失率、并发吞吐和恢复耗时；未测量前不宣称 “更快”。
