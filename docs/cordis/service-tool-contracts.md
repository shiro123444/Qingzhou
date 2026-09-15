# Cordis 服务与工具接线

这一阶段让通用工具插件使用真实 Cordis 的服务与依赖生命周期。`CordisAtomicHost` 提供 `cordis.tools`，内置工具和 MCP 插件声明依赖后读取该服务，工具的注册与回收跟随原生 Fiber。

## 服务读取与依赖

`CordisServiceContext` 提供 `get()`、`has()` 和带类型的 `cordis.tools` 读取。可扩充 `CordisHostServices` 为其他稳定服务声明类型；动态插件服务仍须在调用边界验证数据，类型断言本身不构成运行时验证。

服务只在提供者 active 后可读。提供者卸载会让依赖者清理资源并转入 pending；在相同隔离域内重新提供服务后，Cordis 自动重新执行依赖者。被显式 dispose 的插件不会复活。异步依赖清理由原生服务撤销流程等待。

`host.mount()` 仍保持原子工具安装契约：返回时插件必须 active，缺少依赖则拒绝并清理候选。它不把首次 pending 的插件当成安装成功。已经安装的插件因依赖撤销转 pending，随后恢复，属于原生依赖生命周期。

## 作用域与授权

构造宿主时通过 `scopedServices` 声明需要隔离的服务名称。`withScope(scopeKey)` 对这些名称使用原生 `Context.isolate(name, label)`；相同 scope 使用相同标签，不同 scope 使用独立标签。派生上下文本身始终是新对象，保留调用者所属的 Fiber。

隔离是按服务名进行的。未声明的服务由宿主共享，`cordis.tools` 固定为宿主级服务，不能配置为隔离服务。作用域标签随宿主销毁而释放；服务提供者应作为作用域内的插件安装，使其资源有明确的 Fiber 所有者。

scope 必须由服务器从已认证的用户及会话生成，并传入工具执行上下文。Bridge 与工具 Capability 的可见性和执行检查使用此可信上下文，工具参数中的 scope 不参与授权。没有 scope 的调用只能访问全局工具；scope 不匹配的已注册工具不能退回 fallback 绕过检查。

通用 Capability 保留服务器的开放业务元数据（例如 `invocation`），同时禁止覆盖派生上下文已有的成员、原型属性及 `policy`，最后写入确认过的 scope。Bridge 使用业务字段白名单。两者都保留宿主原有的 policy 检查。通用工具可使用 symbol 隔离标签，现有内置业务工具只接受字符串会话标识，不能通过字符串化 symbol 混用两种契约。

Cordis 隔离不是不可信代码沙箱。能够拿到原生 root 的受信插件仍有宿主能力；数据库、文件与第三方凭据需要领域服务继续校验用户权限。

## 工具候选与服务替换

工具可以先注册到候选目录，成功后 commit，旧版本卸载不能删除新版本工具。已经 commit 的插件在依赖重启后仍注册为 live 工具，不会重新隐藏为候选。

原生服务没有相同的 staged promotion 操作。适配器明确拒绝 staged 插件调用 `provide()`，错误为 `CORDIS_STAGED_SERVICE_UNSUPPORTED`，包括首次发布一个新服务。不能将工具候选切换描述为任意外部副作用的事务。

MCP 插件会发布客户端服务，因此本阶段支持正常安装与卸载，不支持把它作为 staged 服务替换。服务更新应显式卸载旧提供者，再安装新提供者；这会产生可观察的 pending 窗口。业务调用仍须处理不可用、重试与取消，不能跨窗口继续使用已断开的客户端。

## 通用工具桥接

内置工具和 MCP manifest 通过经过检查的服务读取函数解析 `cordis.tools`，兼容过渡期旧 Context 和真实 Cordis 适配 Context。MCP 客户端的初始化、发现或注册失败必须由其 Fiber 回收连接；短名称别名只有重复冲突可以忽略，其他注册错误必须保留。

`CordisToolBridge` 执行已注册工具需要真实的 RuntimeContext。每次执行都创建新的调用上下文并保留服务器传入的工具字段，不再把普通工具执行参数强转成包含 Fiber 的上下文。未知工具可使用已有 fallback；损坏或截断的 JSON 参数仍返回诊断，不能执行工具。

当前 ToolRegistry 的名称在宿主内唯一。作用域检查不会让相同宿主支持两个同名工具注册。不同租户的 MCP 安装应使用独立宿主或服务器确定的命名空间；不要依靠同名覆盖实现隔离。

## 验证与迁移范围

```bash
bunx vitest run --silent=passed-only src/server/runtime/cordis-services.compat.test.ts src/server/runtime/cordis-atomic-services.test.ts src/server/runtime/cordis-atomic-host.test.ts src/server/runtime/atomic-runtime.test.ts src/server/runtime/tools
bun run type-check
```

这轮验证真实 Cordis 服务契约、宿主适配、内置工具 / MCP 桥接及 PPT 原子运行时回归。MCP 集成测试使用受控客户端，不连接外部服务器。

首页通用 AgentRuntimeService 的默认执行循环、Messenger 注册中心、旧 Facade 和所有领域服务并未因此自动迁移。后续需要把通用 Agent 的规划、工具执行和观察循环接入同一宿主，再处理完整配置装配与 Loader/HMR。PPT 的模型视觉质量和复杂模板还原也需要独立的真实作品验收。
