# 清舟统一模型配置入口

## 本轮实现

- 主聊天恢复使用用户启用的模型目录，不再只展示固定 Jumi 模型，也不再在挂载组件时覆盖 Agent 已保存的 provider/model。
- PPT 的 `ppt-agent` 只是 UI 标识：模型选择器读写真实 inbox Agent；PPT 服务端也读取该用户的 inbox 选型。**在 PPT 切换模型会同步改变主页面模型**，不是另存一份 PPT 配置。
- 服务端 `src/server/services/modelProvider/index.ts` 复用 ModelRuntime 的 SDK 解析及密钥 / 地址优先级；使用认证用户 ID 读取、解密对应配置，并校验 provider/model 是否启用、模型类型和视觉能力。
- PPT 的 scope-dispatched port 每次推理读取最新选型，不在全局 composition 中保存用户密钥，不接受请求覆盖模型，不跨用户缓存响应。原有图片来源与作用域校验、超时、取消仍保留。
- 默认 readiness 检查当前用户配置；缺少配置或视觉能力时不报告 ready。没有联网试调用，因此 ready 仅代表本地配置完备，不保证供应商可用。
- 移除 Nexus 在有 `ANTHROPIC_AUTH_TOKEN` 时偷偷覆盖用户 key/baseURL/model 的行为；PPT 默认路由不再使用该环境变量作为独立聊天配置。
- 通用聊天请求不再给所有供应商强塞 DeepSeek 的 `thinking` 字段；网关错误正文不透传给客户端，避免回显凭证或提示词。

## Tini 接入

1. 在现有模型服务设置中添加自定义 Provider，例如 `tini`，SDK 选择 **OpenAI**。
2. Base URL：`https://cli.tinimodel.com/v1`。API Key 在自己的设置中配置，不要贴到聊天或提交到仓库。
3. 使用现有获取远端模型列表功能，选择网关实际返回的准确 ID；可手动添加供应商确认的 ID。显示名称和 API ID 不必相同。
4. 启用目标模型并根据供应商能力说明配置 `vision: true`；模型列表接口不一定包含能力描述，不能只凭模型名称自动推断。
5. 在主页面或 PPT 选择该模型。PPT 对应请求发往 `/v1/chat/completions`。

用户提到的 Claude、Gemini 3.8、DeepSeek v4.1、GPT Luna6 的准确网关 ID 与实际视觉能力**尚未在线验证**。本次联网搜索工具返回认证失败；代码中的历史模型名称或测试 fixture 不构成供应商支持证据。本次不新增猜测的模型目录，也不声称已经通过真实图片推理测试。

## 当前边界与迁移提醒

- PPT 本轮支持 OpenAI SDK（包括自定义 OpenAI 兼容 Provider）；原生 Anthropic/Google/Bedrock 等协议明确拒绝，不会把其密钥发送给 OpenAI 兼容端点。Claude/Gemini 等如果经 Tini 提供 OpenAI 兼容协议，则使用自定义 OpenAI Provider。
- PPT 要求 HTTPS、无 URL 内凭证 /query/hash；保留自定义网关路径前缀。该校验不是完整的网络出站 / SSRF 防护；私网访问应由部署出站策略统一约束。
- 视觉理解不等于生图：PPT 图片生成与可选音频转写仍使用已有独立配置，没有假定这些聊天模型支持 `/images/generations` 或转写接口。此轮统一的是聊天 / 视觉模型配置，不是全模态供应商注册系统。
- 旧环境变量聊天部署须迁移到模型服务设置并保存 inbox 选型；旧独立生产配置模块保留兼容导出，默认 PPT 路由不再依赖它。
- 每次推理解析选型，长任务执行中改模型会影响后续推理。后续可按 job 固化非敏感 provider/model/config revision，配合凭证轮换；本轮没有实现任务级模型快照。
- 新增 PPT 接入不下发密钥；旧主聊天 runtimeState 为支持客户端直连仍可能返回用户自己的解密 keyVaults，本轮没有迁移这套客户端直连架构，不能宣称全平台已无前端密钥。
- 这是共享配置与认证来源的统一，主聊天仍使用 ModelRuntime，PPT 保留适配其合同的多模态 port；不是全平台推理 / 计费 / 重试实现已合并为一个 runtime。

## 验证

针对性测试覆盖：目录恢复、不覆盖已选模型、PPT/inbox 同步、延迟初始化、多用户并发隔离、配置更新、SDK 限制、模型启用与视觉元数据、环境优先级、请求模型覆盖拒绝、可信图片作用域、取消、URL 规范化、错误脱敏及既有路由回归。

真实供应商验收还需：获取 `/v1/models` 准确 ID，对每个模型做文本及图片问答，验证权限、限流、超时与任务恢复；不要以单元测试代替外部联通验证。
