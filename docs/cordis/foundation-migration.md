# Cordis 地基迁移

目标是让通用能力和后续插件共用真实 Cordis 的生命周期、服务和事件机制。当前 PPT 原子工具、默认 Agent 规划执行、通用工具入口与 Messenger 平台注册已经接入；任务协议、资产版本、对话队列与恢复路径继续由业务层负责。

## 分层职责

- `cordis-foundation`：固定来源的 Cordis 4.0.2 与 Cosmokit 1.8.3 原样源码、许可证及独立声明构建。上游补丁和哈希见 `PROVENANCE.md`。
- `cordis-runtime`：可信模块的 profile /bundle/patch 装配、独立原生 Context 的代际替换，以及具体工具服务目录。
- `CordisAgentHost`：默认 Agent runner /executors 的原生服务与类型化 waterfall，浏览器和服务端共用。
- `CordisAtomicHost`：把现有工具注册契约接到真实 Cordis Fiber；不重写状态机或事件分发。
- `AtomicRuntime`：输入校验、可信调用上下文、工具发现、调用事件与运行中的版本锁。
- PPT 插件：规划、视觉模板学习、资产处理、渲染、导出和作品恢复。业务状态仍由领域层持久化。

生成中追加指令、页级修改和资产重用继续使用原有业务协议。迁移工具宿主本身不会提升模型的视觉判断，也不会把现有生成编排自动变成自主 Agent loop。

## 迁移契约

候选工具在启动成功前不可见；启动失败必须清除候选并保留旧实现。成功切换后旧插件卸载不能删除新工具。同一任务持有插件版本锁，活动任务结束或取消前不混用新旧实现。

服务器提供用户及会话上下文，每次调用独立创建上下文对象。Cordis Context 的派生不等于业务授权或自动租户隔离；数据服务仍须校验可信 scope。安装的插件必须是宿主信任的代码。

基础包使用正式 workspace 包声明解析。类型检查先生成 vendor 声明，再在根严格配置下检查清舟代码。格式化工具排除 vendor，避免无意改变上游实现。

## 迁移状态与兼容边界

旧 `cordis-kernel` 的 Context、PluginManager、Facade 尚有调用者。旧资源清理缺口由独立回归测试约束并作过渡修补，不能以添加基础包代替全平台迁移验收。

已完成的生产接线：

1. 迁移通用服务和工具桥接。服务读取、按名称隔离、依赖重启与通用工具的宿主接线见[服务与工具契约](./service-tool-contracts.md)；其余领域服务逐个迁移，不能以桥接通过代替默认调用链验收。
2. Agent 的 runner 与 executors 注册为可替换插件，默认生产调用经过 profile 解析；计划和执行使用类型化 waterfall。消息、工具结果和循环状态仍遵循 AgentRuntime 契约。
3. 引入 profile、bundle、按 ID 覆盖，以及受控的原生代际 loader。开发文件更新由 Next/Vite HMR 处理，未增加任意路径插件加载器或文件监听器。
4. Messenger 的真实默认 registry 接入原生 Context，保留同步注册读取，增加串行挂载、卸载、失败回滚与关闭回收。已建立的外部 Binder 连接不在平台定义重载的回收范围内。

后续新增领域按相同契约接入，不能以现有域通过推导任意第三方项目可以无适配热插拔。产品界面选择自定义 profile、第三方代码沙盒、跨进程宿主与复杂模板视觉质量是独立工作范围。详细装配契约见[场景装配与工具执行](./profile-tool-assembly.md)。

## 验证入口

```bash
pnpm --filter @lobechat/cordis-foundation run build:types
bunx vitest run --silent=passed-only src/server/runtime/cordis-atomic-host.test.ts src/server/runtime/atomic-runtime.test.ts
bunx vitest run --silent=passed-only --root packages/cordis-kernel
bunx vitest run --silent=passed-only src/server/runtime/presentation/atomic-recovery.test.ts src/server/runtime/presentation/public-atomic-api.test.ts
bun run type-check
```

声明构建、单测和类型检查分别验证不同契约。真实模型生成的质量、图像服务和办公软件导出需要另作端到端验收。

## 本轮实测记录（2026-09-13）

- 旧内核：17 个测试文件、174 项通过，包含原先失败的 4 项清理回归，以及共享异步 disposer 的顺序与完整等待。
- 运行时与 PPT 集成：10 个测试文件、95 项通过，覆盖真实 Cordis 宿主、候选切换、根卸载、公开接口、任务恢复和 SSE。
- `bun run type-check`、本次生产代码 ESLint、`git diff --check` 均退出 0。格式化后再次核对，上游 17 个源码与许可证文件仍与固定 Git 对象逐字节一致。
- 真实登录后的工具目录：29 个公开工具、39 个运行时工具、3 个已挂载插件。
- 验收任务：`presentation-7c2883ec-7ab2-4c44-ab81-6d0a514efe13`。生成 3 页可编辑 PPTX，含 1 张真实生成 PNG 与 3 页讲者备注；LibreOffice 成功打开并转成 PDF。
- 开发热更新期间任务曾被恢复逻辑标记为中断；通过同一任务的 retry 完成恢复。随后使用公开原子操作 `presentation.job.message` 只修改第 1 页。最终版本 `e8f8b7ef-6b8b-42ea-93f6-a02ca39acb81` 中，第 2、3 页的 PPTX XML 及图片字节与修改前一致。

本机验收文件位于 `/tmp/qz-cordis-acceptance/deck.pptx` 和 `deck.pdf`。这些结果确认本轮接线与回归范围，不代表任意插件的热更、复杂模板还原或所有视觉问题已解决。

## 第二阶段实测记录（2026-09-14）

通过 Herdr 分派两个限定任务：cmd 编写原生服务契约测试并只读审核；agy 修改通用工具模块；主审负责宿主接线、逐项 review、边界修正与最终验收。vendor 与旧 kernel 生产代码未改动。

- 宿主新增类型化服务读取、原生按名称隔离，以及 staged 服务发布的明确拒绝。补齐已提交工具在依赖重启后保持 live、值为 undefined 的已提供服务可被 has 识别等边界。
- 内置工具、MCP、Bridge 与工具 Capability 使用真实运行时上下文。覆盖 scope 校验、不能绕过至 fallback、保留宿主 policy、保护宿主内部字段，以及 MCP 客户端迟到时的清理。
- 主审最终定向检查：12 个测试文件、76 项通过；`bun run type-check`、改动代码 ESLint 和 `git diff --check` 通过。
- 启动 Next.js 3010 与 Vite 9876。发现旧开发编译缓存导致路由重定向循环，保留旧缓存并重启后恢复。登录态 `/presentation`、工具目录、任务读取和 PPTX 下载均返回 200。
- 在线目录为 29 个公开工具、39 个运行时工具、3 个插件。读回上一阶段任务 `presentation-7c2883ec-7ab2-4c44-ab81-6d0a514efe13`，状态 completed、版本不变。下载 PPTX 为 1,359,178 字节，包含 3 页、1 张图片、3 页讲者备注，与上一阶段验收文件 SHA-256 一致。

本轮没有重新生成视觉内容；在线检查验证的是当前宿主下已有作品的读取和导出。通用 AgentRuntimeService 的默认执行循环尚未切到新 Bridge，Messenger、领域服务及 Loader/HMR 仍按后续阶段逐步迁移。详见[服务与工具契约](./service-tool-contracts.md)。

## 第三阶段：默认 Agent 规划与执行（2026-09-14）

主页默认对话实际使用浏览器 `AgentRuntime`，后台队列使用 `AgentRuntimeService`；共享包默认接入 `CordisAgentHost`，两者均走真实 Cordis runner /executor 服务与原生 waterfall。浏览器循环、后台 step、技能决策与自迭代四个生产调用入口统一在 finally 回收。状态恢复继续由原来的消息、coordinator 与队列负责。

详细边界见 [默认执行宿主](./agent-execution-host.md)。本阶段不宣称所有工具来源已统一进入通用 ToolRegistry，也不包含 profile /loader。

主审验证：

- `bunx vitest run --silent=passed-only --root packages/agent-runtime`：11 个文件、271 项通过。
- 主页 streamingExecutor /cancel-functionality、服务端 AgentRuntimeService /executeStep/hooksIntegration /agentSignalHooks、技能决策和自迭代：8 个文件共 166 项。首次并发运行有一项动态 import 冷加载超过 20 秒；单独重跑对应文件 3 项通过，未提高超时或修改行为断言。
- 全仓 `bun run type-check`、全部改动 TypeScript 的 ESLint、`git diff --check` 通过。
- Herdr：agy 实现限定的宿主与测试，经主审修正启动回滚、类型、测试回收和执行钩子边界；cmd 只读追踪真实默认入口。主审负责共享运行时与生产调用方接线。
- 真实浏览器：主页已登录，会话 `tpc_UIpjfaLR0ah4` 完成搜索工具调用、空结果回传及模型后续回答；重新打开恢复成功。搜索后端本次返回空结果，因此未把搜索质量标为通过。

## 第四阶段：场景装配与真实入口（2026-09-15）

默认 Agent 与 PPT 集合使用共同的 profile resolver。新的 `cordis-runtime` 为可信模块提供 bundle 引用、按 ID 覆盖、原生依赖激活等待、候选失败保留旧代和已接受调用的回收等待。主页、服务端工具入口使用请求独立的原生工具服务；模型工具的启用目录仍由既有 manifest 规则决定。

Herdr 分工：cmd 迁移真实 Messenger registry、只读审核生产适配并修复搜索聚合；agy 修复 SearXNG HTTP、结果过滤与失败识别。主审负责装配层、Agent/PPT/ 工具生产接线、交叉审核及真实浏览器验收。PPT 预览任务经 agy 只读定位后交回，最终由主审完成 store 与轮询接线及回归。

- AgentRuntime：12 个文件、272 项通过；装配层：3 个文件、12 项通过。覆盖三级异步服务依赖、嵌套提供者、按 ID 替换 executor、失败候选回滚和代际回收。
- Messenger、SearXNG、服务端工具入口与 PPT profile：6 个文件、36 项通过。
- 全仓类型检查与 54 个改动 TypeScript 文件 ESLint 退出 0；固定上游的 17 个源码与许可证再次逐字节比对一致。
- 真实生成任务 `presentation-137f8364-b9b6-4f7d-b0dd-05a3aa1b1bae` 在约 138 秒内完成。PPTX 为 1,834,938 字节，含 3 页、1 张真实生成图片和 3 页讲者备注；LibreOffice 成功打开并转 PDF，逐页检查可正常显示文字与图片。
- 本机文件：`/tmp/qz-cordis-stage4-real.pptx`，渲染结果在 `/tmp/qz-cordis-stage4-render/`。这是生成链路与导出的实证，不把验收文稿中的模型宣传文案当作平台能力承诺。
- 当前测试账号为 Probe。它可恢复上一阶段作品；与其他浏览器账号的作品列表独立，不能把账号差异误判为跨会话丢失。
- 真实主页调用搜索时，上游搜索引擎仍有 timeout/CAPTCHA，模型后续回答又遇到 503 容量不足。外部搜索质量和模型稳定性不标为通过。

验收暴露并闭环的两处生产问题：

1. 聚合服务曾在各搜索源失败后丢弃错误、返回成功空结果。现在保留现有重试顺序，有真实结果仍返回；全部无结果且有失败时返回固定 `SEARCH_INCOMPLETE`，合法零结果保持可区分。空 Error 消息同样被识别。登录态公开 `search.webSearch` 实测返回 HTTP 503 / SERVICE_UNAVAILABLE，未回显上游错误体。
2. SSE 中没有 URI 的局部 ready 产物曾阻止后续补取完整预览。现在缺 URI 的就绪图片 / SVG 会补取，局部事件保留已取得的地址与元数据，并保护请求期间更新的状态和另一个任务的选择。实时流每页产出后即可触发补取，完成与恢复路径共用相同规则；带 artifactIds 的顶层 job 快照也正确更新状态。浏览器重新打开真实任务后，页面预览和标注入口恢复可用。

最终新增收尾验证：PPT store / 流恢复与搜索共 12 个文件、117 项通过；全仓 `bun run type-check` 退出 0，59 个改动 TypeScript 文件 ESLint 退出 0（9 条既有告警），`git diff --check` 通过。本阶段未 commit 或 push。
