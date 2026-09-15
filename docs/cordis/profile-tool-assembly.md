# 场景装配与工具执行

`@lobechat/cordis-runtime` 是清舟的应用装配层，依赖原样保留的 `cordis-foundation`。它不修改上游源码，不实现另一套 Fiber 状态机。

## 配置组成

- bundle 收集具名插件项，可 include 其他 bundle；共享依赖只展开一次，循环与重复 ID 显式报错。
- profile 选择 bundle，再按 ID 顺序执行 add /replace/remove。config 在装配前复制，未知模块不能触发路径导入或代码执行。
- module 是宿主代码登记的 Cordis 插件。业务输入或模型参数不能注册模块、改变服务授权或注入执行上下文。

`AgentRuntime` 的默认 runner 和 executors 已通过这套装配创建。`RuntimeConfig.composition` 支持加入可信模块和 hooks，或通过 patch 替换某个 executor。`createPresentationAtomicRuntime` 的 presentation /assets/skills 集合也经相同 resolver 装配；原子插件配置仍由可信工厂提供，profile 不改插件命名空间。

## 加载、替换与释放

`LoadedProfile` 创建独立的原生 Context，并等待整个 bundle 的依赖激活稳定。稳定后仍缺依赖的插件使启动失败，候选实例被清理。单次 await 不能代表多层异步依赖已经全部启动。

`CordisProfileLoader.reload()` 按顺序建立新代，完成启动后切换选择指针。新调用使用新代，旧调用继续读取旧代服务；旧调用结束后，原生 Fiber 释放旧代资源。关闭后拒绝新调用，dispose 返回同一个清理 Promise。

这是隔离 Context 的代际切换，不是原生 provide 的事务化 staging。可信插件启动时产生的外部网络或文件副作用不会自动回滚；需要独占外部资源的插件必须自行实现接管与清理。任意第三方代码的沙盒、桌面跨进程 Loader 和文件监听器不在该契约中。开发代码更新由现有 Next/Vite HMR 处理。

## 工具目录与生产入口

`CordisToolRuntime` 把每个具体工具注册为原生服务，目录只投影已激活服务的元数据。`qingzhou.tools.execute` 使用原生 waterfall，可修改输入或阻止执行；执行仍必须命中本代已经注册的工具。目录替换复用同一 loader，并等待旧调用释放。

主页浏览器的 `internal_invokeDifferentTypePlugin` 与服务端 `ToolExecutionService.executeTool` 已默认通过 `invokeNativeTool` 执行。兼容接线每次请求拥有独立的具体工具实例；原有 builtin、MCP、云端代理、附件处理、操作取消与消息持久化继续由各自适配器负责。认证上下文保存在服务端闭包，不从工具参数恢复。

模型看到的工具集合仍由现有 manifest / ToolNameResolver 生成，动态技能激活仍经原来的启用规则。这里统一的是原生执行和可查询的目录契约，没有把所有账号的工具合成一个全局目录，也没有让模型越过能力启用规则。PPT 的原子目录、资产权限和运行中版本锁继续由 AtomicRuntime 管理。

## 验收与边界

定向验证覆盖：bundle 覆盖、未知模块拒绝、多层异步依赖、失败候选保留旧代、旧调用 drain、按 ID 替换 Agent executor、PPT 模块版本选择、真实服务端工具入口，以及默认浏览器插件交互。

AgentHost 按一次运行独立隔离。生产入口在 step 结束后 finally dispose；若可信外部代码提前关闭 host，再从尚未完成的 batch 新发起嵌套调用，新调用会被关闭检查拒绝。序列化业务状态不包含 Context 或 Fiber。

真实搜索质量与模型生成质量需要单独验收，单测通过不代表上游搜索引擎或图像服务可用。
