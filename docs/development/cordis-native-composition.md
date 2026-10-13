# 清舟原生能力装配与小型服务器改造

本轮直接改造清舟的原生插件和生产调用链。模型继续使用外部 API；4 核 4GB、8 核 8GB 是部署验收目标。资源实测、构建失败原因和验证范围见 [资源基线](./qingzhou-resource-baseline.md)。

## 四个开发边界

- **Operation**：一个有独立价值的动作。输入、输出、所属账号、取消与副作用由操作契约明确；可信调用上下文来自宿主。
- **Plugin**：一组共享领域规则或资源生命周期的操作。插件由真实 Cordis 挂载、替换、卸载；同一数据事务不必拆成多个插件。
- **Recipe**：围绕目标组合操作。目前 `skills.catalog` 提供配方目录，`skills.run` 接受具名步骤及 `$ref` 结果引用，`skills.autorun` 在受限目录中选择工具。目录里的步骤名称是配方说明，实际执行仍需完整输入；它们不是未经验证就能执行的任意代码。
- **Profile**：可信宿主选择 bundle 和按 ID 的 add/replace/remove。Profile 可以装配教育、创作、站点等场景；请求和模型不能修改宿主模块、策略或权限。

## 通用组合器

[`AtomicOperation.agent.contexts`](../../src/server/runtime/atomic-runtime.ts) 中的 `skills` 表示插件主动允许该操作参与组合。调用目录从当前实际挂载的插件生成，宿主 `policy` 只能收窄这个集合。通用层不再维护 PPT 名称白名单，不再导入 PPT 提示处理或具体模型实现。

`createSkillsPlugin(runtime, chatSource?, options?)` 的 `options` 接收场景配方、指导词和策略。`chatSource` 可以从本次 `AtomicInvocation.services` 解析账号模型，避免把用户凭据保存在全局站点宿主。PPT 的模板指导和生图请求编号规则位于 [`presentation/recipes.ts`](../../src/server/runtime/presentation/recipes.ts)。

组合步骤最多 16 个；自主组合最多 10 次模型决策、2 次工具失败，并遵守每个操作的 `maxCalls`。整个组合持有参与插件的租约，再核查目录与策略，避免验证和执行之间被热替换。请求取消会传播到每次模型和操作调用。成功写出的产物不会因后续失败自动撤销。

幂等结果缓存最多保留 64 个请求，运行中的请求不被驱逐；容量用尽时明确拒绝新增工作。诊断事件默认最多保留 256 个账号 / 会话范围，每个 200 条；历史淘汰不影响运行中的任务及实时事件。

## 独立教学插件

[`teaching`](../../src/server/runtime/teaching/atomic-plugin.ts) 可以在没有 PPT planner、模板库或渲染 worker 的宿主中挂载。它提供教案规划、修订、校验、公开教学阶段编译，以及账号所属教学记忆检索和组合。

教学输出保留教师目标、阶段和任务的语义；PPT 的教案转页、SVG 与导出检查仍属于演示文稿领域。既有 `presentation.lesson.*` 和教学记忆调用通过 `runtime.invoke()` 转发到教学插件。生产备课 UI 也经过同一插件，卸载后会明确不可用，不回退到绕过宿主的模型直调。

默认 PPT bundle 现在装配 `teaching + presentation + assets + skills`。教学数据仍使用原账号持久化实例；卸载插件不会删除用户记录。

## 原生站点组合

2026-10-11：生产站点宿主新增可信 `education` Profile。设置 `QINGZHOU_SITES_PROFILE=education` 后，首次访问按需装配 `sites + skills + teaching + content`；默认 `sites` Profile 保持两项基础能力。请求不能自行切换 Profile 或加载外部代码。

`lesson-to-article` 配方组合 `teaching.lesson.compile → content.lesson.markdown → sites.edit`，生成带 `draft: true` 的 Markdown。格式化只读取编译后的阶段标题和可见内容，不复制教师提示、隐藏答案或整个教案；发布仍由现有显式发布操作执行。可在前面增加 `teaching.lesson.plan`，模型从本次认证账号的调用上下文解析，不缓存首个账号的模型端口。当前已验证 HTTP 处理器、真实临时文件存储和模拟模型；尚未验证真实模型服务或新增前端配方入口。

站点存储的写入队列按账号隔离，同账号继续检查基准版本；新建时仅统计有效站点文件，避免加载所有正文及发布历史。列表读取逐个处理，降低并发读取和解析的瞬时分配；现有列表仍返回完整站点，不能将此项描述为已经实现轻量摘要分页。该文件存储及队列仍用于单进程部署，多副本需持久化事务支持。

[`createSitesRuntime`](../../src/server/runtime/sites/runtime.ts) 通过同一 Profile resolver 原生装配 `sites + skills`，可以选择可信额外模块。例如在宿主代码中加入教育能力：

```ts
const { runtime } = createSitesRuntime({
  store,
  plugins: { teaching: createTeachingPlugin() },
  profile: {
    bundles: ['sites'],
    patches: [{ op: 'add', entry: { id: 'teaching', use: 'teaching' } }],
  },
});
```

没有提供模型端口时，教学编译、修订检查等本地操作仍可使用；需要模型的教案规划不会出现在目录里。

`sites.edit` 是可组合的草稿编辑操作，只接受字符串内容，不提供删除语义。人工 `sites.change` 保留原有显式 `null` 删除协议；发布与回滚继续作为独立操作，不向自主组合开放。

原 `sites.agent.edit` 现在复用 `skills.autorun`，保持界面的请求和 `{ site, summary }` 响应。宿主在模型调用前检查账号、当前站点和批准的基准版本，全程持有站点租约，禁止模型跨站、删除、发布或自动重基。模型仅得到当前草稿；保存结果使用小型 `SiteEditReceipt`，不会把完整版本历史反复放入上下文。

HTTP 路由继续承担认证和传输。站点与教学组合直接调用原生操作；没有为这条组合链增加站点间 HTTP 适配器。已有文档公开读取协议保持兼容。**Fumadocs 的独立身份、审核与 outbox 仍未全部迁入原生共享领域层**，本轮原生组合测试不能替代那部分迁移和真实跨站验收。

## 资源与启动

`QINGZHOU_SERVER_PROFILE` 选择 `4c4g` 或 `8c8g`，默认 `4c4g`：

- 4c4g：图片处理并发 1、等待队列 16；PPT 生成并发 1、等待队列 4。
- 8c8g：图片处理并发 2、等待队列 32；PPT 生成仍从并发 1 起步、等待队列 8。提高重任务并发应先测实际峰值。

PPT 账号端口与直接生成接口共享同一 composition 的限额。等待时任务保持 `queued`；取消移除等待项，超额工作返回可重试的容量错误。这里是单机宿主的限额，多个进程 / 副本不会自动共享内存队列。

素材插件首次处理图片时才加载 Sharp；仅访问能力目录不会加载它的原生图像处理依赖。共享产物接口移到 [`artifacts/contracts.ts`](../../src/server/runtime/artifacts/contracts.ts)，PPT 旧类型导出保持兼容。部分图片生成实现及产物 URI 仍沿用 PPT 领域实现，尚不代表所有素材实现都已迁出。

Next 默认关闭 `preloadEntriesOnStart`。这减少启动时的路由预加载；已经访问的模块仍受 Node 缓存，不能把插件卸载等同于模块代码从进程中消失。

远端市场 sitemap 默认关闭，避免个人服务器构建时抓取整个上游市场并生成数千个分页。本地页面索引、robots 与 sitemap index 保留。确实运营完整市场 SEO 时，在构建环境显式设置 `QINGZHOU_MARKET_SITEMAPS=1`，并重新构建；这不是运行时开启后就会补齐全部静态分页的功能。

预构建完成后可运行：

```bash
bun run start:compact 4c4g
# 或
bun run start:compact 8c8g
```

启动器复用 Next 的生产环境文件加载，支持普通 Next 产物和 standalone。它检查构建清单，拒绝仅留下 BUILD_ID 的失败构建；standalone 改变工作目录时，两个内容数据根仍固定在项目根目录或用户显式指定的位置。默认 Node old-space 上限分别为 1024 / 2048 MiB，用户显式 `NODE_OPTIONS` 堆配置优先。

2026-10-11：Linux 上检测到 Node 的 `process.execve` 时，启动器直接替换为服务器进程，保留单个服务 PID，释放启动器的堆；其他平台或不支持的 Node 版本继续使用子进程方式。此 Node API 从 22.15 起提供，当前仍标为实验性（见 [Node 官方说明](https://nodejs.org/docs/latest-v22.x/api/process.html#processexecvefile-args-env)）；需要兼容模式时设置 `QINGZHOU_SPAWN_SERVER=1`。PID、持久化目录、堆预算与兼容模式经过回归验证，真实 cgroup 测试检查了停止后服务和端口释放。

构建可运行 `bun run build:compact`，默认采用 `8c8g` 构建预设，完整执行 SPA 与 Webpack Next 构建。它是构建机的内存优化选项，实际占用和更长的构建耗时见资源基线；4GB 服务器采用预构建产物。构建预设与上述生产启动预设分开。

**old-space 不是 RSS 或整机上限。** 原生图像缓冲、导出子进程、数据库和独立子站还需要容器 /cgroup 预算。生产测量记录中的受限公开 Web 测试也不能替代整套数据库、登录、真实模型与 PPT 导出验收。当前没有实施 Go 重写；先依据同工况 CPU 和内存剖析定位需要独立 worker 的热点。

## 本轮验证方式

2026-10-10 本轮统一回归：23 个 Vitest 文件、220 项测试通过；启动器在宿主机的 2 项回归、采样工具的 8 项核算测试通过。`bun run type-check`、改动源文件 ESLint 和 `git diff --check` 通过。启动器测试在沙箱内曾因 Node 子进程标准输出被丢弃失败，最小复现确认后在宿主机通过；未把沙箱失败计为通过。

- 原生插件：独立教学调用、卸载后拒绝、PPT 兼容操作、跨领域组合、策略收窄和账号隔离。
- 站点：真实临时文件存储、草稿读写、版本冲突、原生教学到文章组合、模型与公开发布边界。
- 资源：并发 / 队列上限、等待取消、两个生成入口共用容量、容量失败后重试。
- 构建：默认 sitemap 不加载远端发现服务，显式启用保留原分页逻辑。
- 启动器：失败产物检测、standalone 持久化目录与用户相对路径配置。
- 性能：宿主进程 /cgroup 采样、独立 Node 核心微基准、隔离生产构建及受限 Web 启动。具体结果与限制写在资源基线中。

这批改动不包含前端插件插槽自动装卸、统一运维控制台或多主机调度。现有 Cordis 状态机、租约和 Profile loader 继续复用；后续应将这些真实宿主状态接入管理界面。
