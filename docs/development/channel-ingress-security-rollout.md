# 三平台入站安全：第一阶段实现与上线说明

本轮是 [整体改造草案](./cordis-channel-rollout-plan.md) 的第一批代码，不代表持久 inbox/outbox、分布式任务租约、Cordis 渠道生命周期或流式 UI 已完成。

## 已实现的边界

### 内部长连接 / 轮询转发

微信 iLink、QQ WebSocket、飞书 / Lark WebSocket 使用共享 `src/server/services/bot/security/gatewayAuth.ts`：

- 使用已有安装实例凭证（微信 bot token，QQ / 飞书 app secret）派生专用 HMAC 密钥；不新增一套前端密钥入口，不发送原始凭证。
- 签名绑定协议版本、platform、applicationId、POST、路径 /query、原始正文摘要、秒级时间戳和随机 nonce。
- 五分钟时钟容差；共享 Redis `SET NX EX` 原子占用 nonce，TTL 601 秒覆盖前后时间窗。
- Redis 缺失 / 异常 / 超时拒绝处理，返回 503，不自动退回内存缓存。
- 签名错误返回 401；已占用 nonce 返回 409；正文实际读取上限 1 MiB，超限 413；读取总时限 5 秒；只接受 POST。
- 转发禁用 HTTP 重定向，保留超时；非 2xx 不再当成已送达。微信只在本批转发成功后推进内存 cursor，失败会保留原 cursor 重试。

**认证模式来自服务器创建的 client，不由请求头选择。** 客户端自己添加 `x-internal` 或 `x-qingzhou-*` 无法获得内部信任；内部验签失败也不会回退到原生平台鉴权。

URL 保持原有 `/api/agent/webhooks/:platform/:appId`，避免改变已注册的 webhook 地址；隔离的是鉴权模式与安装实例，不是把一个未经保护的 URL 改名为 “内部” 就视为安全。同一个安装实例由持久配置明确选择 WS / 轮询或外部 webhook 模式，不同时开放弱认证后门。

### QQ 外部 Webhook

- 必须匹配配置的 `X-Bot-Appid`。
- Ed25519 校验 `X-Signature-Timestamp + 原始正文 bytes`；严格校验签名格式、时间窗与共享 Redis 重放记录。
- 原生签名不覆盖 URL，因此防重放键不依赖调用者可更换的 URL/path。
- 保留官方 `op:13` 无签名注册握手，但要求应用 ID、新鲜时间戳、有限长度且仅安全字符的 opaque token；不能通过把 JSON 事件当作 plain_token 来获得可伪造事件的签名。
- 只在原生签名头全部缺失时允许无签名握手；部分头或错误签名不降级。握手不触发 Agent。
- 修复空 client secret 导致签名种子生成死循环的问题。

协议依据：[QQ 签名校验](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/interface-framework/sign.html)、[Webhook 握手](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/event-emit/webhook.html)。

### 飞书 / Lark 外部 Webhook

- 真实事件要求 Encrypt Key，验证 `SHA256(timestamp + nonce + encryptKey + 原始正文 bytes)`，先验签再解密。
- 校验时间窗、nonce / 签名格式、事件 `header.app_id`；配置 Verification Token 时仍同时校验 token。
- 外部 client 注入共享 Redis 原子重放检查；缺少 Encrypt Key 或重放存储不可用时拒绝，不把缺配置解释为 “跳过校验”。
- 仅允许带正确 Verification Token 的明文 `url_verification` 在三个签名头全部缺失时完成注册挑战；这条分支不能派发事件。加密挑战要求合法签名。
- Webhook 模式的凭证验证返回缺失 Encrypt Key 的字段错误；WebSocket 模式无需配置该平台 Encrypt Key / Verification Token。

协议依据：[飞书 Encrypt Key 与签名](https://open.feishu.cn/document/server-docs/event-subscription-guide/event-subscription-configure-/encrypt-key-encryption-configuration-case?lang=en-US)、[回调地址配置](https://open.feishu.cn/document/event-subscription-guide/callback-subscription/step-1-choose-a-subscription-mode/send-callbacks-to-developers-server?lang=en-US)。

## 上线前必须准备

1. **共享 Redis**：Web/API 的所有副本使用同一可用实例和命名空间；不要只给网关配置 Redis 而漏掉接收 API。防重放记录使用 `bot:webhook:replay:v1:` 前缀，建议配置可靠持久化及不淘汰安全记录的内存策略。清空 / 丢失 Redis 记录会削弱时间窗内的重放防护，不能用本轮代替后续持久事件 inbox。
2. **时钟同步**：网关与接收 API 的时钟应同步；超出五分钟会拒绝请求。不要为了绕过问题无限放宽窗口。
3. **完整凭证**：微信 bot token、QQ / 飞书 app secret 必须一致且有效。飞书 HTTP 模式另外在平台和清舟配置同一 Encrypt Key，并保留正确 Verification Token（如果启用）。已有 token-only HTTP 事件部署需要迁移配置，不能继续无签名收真实事件。
4. **网络与代理**：跨主机使用 HTTPS 或可信加密通道；HMAC 只保证认证 / 完整性，不加密聊天正文。代理不能改写已签名路径 /query、丢弃鉴权头或重新序列化原始 JSON。对 body 大小 / 速率也建议设置入口层限制。
5. **QQ 挑战**：测试当前应用后台的挑战格式与 `X-Bot-Appid`；本轮没有真实账号联调，不以单元测试代替平台注册验证。

## 建议部署顺序

- 先在测试环境同时部署 Web/API 与长驻网关，确认签名、Redis、时钟和代理配置。
- 生产升级先暂停目标安装实例新收件，升级接收端与发送端，再重启相应连接；不要让旧裸转发进程长期对着新验签端重试。
- 微信 / QQ / 飞书按安装实例逐个白名单验证：一条文本、一张图片、重复事件、重启后接收。飞书 / Lark 及 QQ 外部 webhook 另做 URL 注册挑战和真实签名事件验证。
- 观察 401/409/413/503、转发错误和平台重推。不要记录原始密钥、完整请求正文或平台错误原文到客户端。
- 回滚应暂停受影响渠道，修复后恢复，或保留认证补丁的兼容版本；不要为了 “恢复可用” 重新开放裸转发 / 免验签。

## 适配器作为独立包使用时

QQ / 飞书适配器在未注入 `claimWebhookReplay` 时有容量受限的本进程 TTL 缓存，满时拒绝而不驱逐未过期记录。这只保护同一进程，不能覆盖重启、多副本或多 worker。清舟正式 Webhook client 已强制注入共享 Redis 实现。

微信适配器没有原生公网 webhook 协议；未配置服务器端 `authenticateWebhook` 回调时拒绝 HTTP 消息，不再默认信任任意 JSON。回调必须认证请求并保护重放，读取正文时自行 clone，不能消费适配器后续要解析的原始流。

## 已覆盖的测试场景

- 合法签名的内部转发和原生事件；微信 / QQ / 飞书 / Lark 实际 client factory → adapter 链路。
- 伪造内部标记、错误凭证、正文改动、跨平台 / 安装实例、路径改动、过期 / 未来时间戳、nonce / 签名格式错误。
- 同一签名在不同 adapter 实例重放；共享 Redis 缺失、错误与超时；原生 QQ 的路径别名不绕过重放。
- QQ 安全注册挑战与 JSON 签名 oracle 负例；飞书 token-only 挑战、错误 token、部分 / 错误签名、先验签后解密。
- 实际分块正文超限、伪造 Content-Length、无限慢流超时与取消。
- 微信转发 503 不推进 cursor、重试使用新签名 nonce；网关非 2xx 不伪装成功。

具体测试结果以本轮执行报告为准；未进行真实供应商联通测试。

## 仍未解决，不应误认为本轮已完成

- 重放拒绝是安全门禁，不是可靠队列 ACK。认证占用 nonce 后若业务处理失败，不能依赖同一原始请求无限重放来恢复；尚需下一阶段的持久 inbox、处理状态与可恢复 ACK。
- 微信 cursor 仅改了失败时的推进顺序，仍不是跨进程 / 重启持久化 cursor；部分批次转发成功后的重投仍依赖既有消息去重。
- QQ 网关记录转发失败不等于持久重投保证；飞书 SDK 如何重投亦需真实测试，不能据抛错就承诺不丢消息。
- 本阶段未改会话 guard、35 秒任务锁与回调幂等。后续已补 owner-token 租约及 Redis 回调台账，见 [可靠性首批说明](./channel-runtime-reliability-rollout.md)；跨进程会话 guard 与原始入站事件持久化仍需后续实施。回调级 SQL 收发件和核对 API 的未验收代码进展见 [第二批说明](./channel-delivery-outbox-rollout.md)。
- 本轮没有迁移 QQ API 域名，没有实现 QQ 原生流式、飞书 CardKit、企业微信、OAuth 或完整跨平台账号绑定。
- 路由可能在验证请求前加载 / 初始化目标 bot；本轮限制正文与读取时间，但完整入口限流、预鉴权加载优化和所有附件下载的 SSRF 防护仍需后续工作。
