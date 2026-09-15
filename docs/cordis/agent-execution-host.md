# Agent 默认执行路径的 Cordis 宿主

主页默认对话由浏览器的 `executeClientAgent` 驱动；后台队列由 `AgentRuntimeService.executeStep` 驱动。两者都构造 `packages/agent-runtime` 的 `AgentRuntime`。因此接线放在共享包中，避免只迁移后台、遗漏实际主页入口。

## 本阶段边界

`AgentRuntime` 默认创建 `CordisAgentHost`。Agent 的 runner 与各 instruction executor 是真实 Cordis 插件提供的服务，规划和执行时从原生服务容器读取。默认执行器、调用方执行器、Agent 自带执行器的优先级不变。内置并行工具批次中的单个工具调用也经过宿主。

两类原生 waterfall 事件分别环绕规划和执行：`qingzhou.agent.plan`、`qingzhou.agent.execute`。监听器接收本次调用的 request 对象和无参数 `next()`，可改写 request 中的内容后继续，或抛错拒绝。Cordis 原生 `next()` 不接受替代请求参数；这里不另造分发器。监听器随其所属插件卸载。执行钩子可改写参数但不能改变指令种类，以保留步骤计数和 finish 语义；选择另一种指令应在规划阶段完成。

插件是受信任的应用代码。上述钩子不构成浏览器安全沙箱，也不替代服务端的认证、账户权限或工具审批。

## 生命周期与恢复

- 浏览器宿主归当前对话执行循环所有；完成、异常、取消或等待人工审批后在 `finally` 回收。排队补充消息和审批恢复按原有逻辑建立下一次运行。
- 后台宿主归一次已取得执行锁的 step 所有，回收后仍保证释放执行锁。跨请求状态继续由 coordinator、数据库和队列保存，不能依赖一个进程内 Fiber 保存作品或聊天记录。
- 技能决策和自迭代这两个共享包的后台调用方也显式回收宿主。
- 宿主关闭后拒绝新执行，等待已经接纳的调用结束后卸载插件。用户取消继续使用原有 operation / AbortController；不把 “卸载插件” 冒充 “强制打断任意外部 IO”。取消后的 Agent 清理指令仍可执行，之后才回收宿主。

## 尚未迁移的部分

本阶段把规划与指令执行接入了真实 Cordis，不改变每种工具原来的业务路由。浏览器中的本地工具、服务端 builtin、MCP、Klavis、市场技能和云代理继续由对应 executor 调用。前一阶段 `CordisToolBridge` 的通用目录没有因此自动覆盖主页的所有工具来源。

后续平台 profile /bundle/loader 应负责装配这些插件与工具来源，再提供受控替换。原生服务不支持任意副作用的 staged promotion；不能把工具表的 staging 套用到所有服务和外部资源。

## 真实浏览器验收

在已有登录会话的主页发送搜索请求，实际出现工具调用。服务端日志记录 `GET /trpc/tools/search.webSearch` 200，以及工具后续的 `POST /webapi/chat/nexus` 200；模型读取 `<searchResults>No results found.</searchResults>` 后明确报告空结果。重新打开话题 `tpc_UIpjfaLR0ah4` 后，用户请求、搜索工具记录与最终回复均可恢复。

这证明本次默认路径完成了 “规划 → 工具 → 结果 → 后续回答”，不证明搜索索引质量良好。搜索后端此次没有返回匹配网页；该问题仍需独立诊断。首轮验证期间开发热更新曾重载页面，最终验收使用停止代码编辑后的第二次请求与持久化结果。
