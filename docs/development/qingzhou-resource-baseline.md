# 清舟资源基线与小型服务器目标

本轮部署范围：**模型使用外部 API**；服务器承担清舟、文档、博客、持久化，以及本地 PPT 导出。4 核 4GB 和 8 核 8GB 是改造后的部署目标，下面的预算不是已经通过的容量认证。

## 2026-10-10 当前宿主机实测

采样时间为北京时间 **10:44:32–10:44:47**，实际相邻观测覆盖 **14.996 秒**，共 16 个采样点。使用宿主机 `/proc` 与 cgroup v2 原始计数器，没有启停既有服务或容器，没有发起业务负载。

原始记录：[2026-10-10-host-idle.json](../../scripts/performance/baselines/2026-10-10-host-idle.json)。这份记录保留容器、PID、采样时段、可读性、Swap、cgroup 限制与每个区间的 CPU 数据，不含命令行参数、环境变量或容器配置凭据。

**采样时清舟、文档站和博客站 Web 服务均未运行，整站启动 / 运行内存尚无有效测量。** 不能把未启动记成 “运行占用 0”，也不能把配套容器总量当成整个产品总量。

- 清舟工作区里主要是 Codex、Herdr、Claude 和 shell 等开发工具，已在原始记录中列明排除项。CWD 继承还命中一个 `node` 进程（PID 2368744）；独立核对其进程链为 `herdr → bash → node → .cline`，属于开发工具启动器，其 RSS/PSS 不计入清舟 Web 服务。
- 文档站 `/home/shiro/Projects/fumadocs/shiro` 和博客站 `/home/shiro/Projects/blog-replica` 没有匹配的运行进程。
- 3210 虽有 TCP 监听，但发布端口的是 `lobe-network` 占位容器。一次本地主页请求得到连接重置、HTTP 状态 `000`，未获得 Web 响应。端口占用本身不是服务已启动的证据。
- 宿主机为 16 逻辑核、约 31.06 GiB 物理内存，运行桌面与开发工具；它不是已限为 4 核 4GB 或 8 核 8GB 的测试环境。采样可见约 610 个 PID，PID 1 为 `systemd`；部分其他用户进程的 CWD/PSS 不可读，记录保留这种缺失。

已有配套容器的测量以 **cgroup `memory.current`** 为准，包含该组的匿名内存、文件缓存与相关内核记账。CPU 由相邻 `cpu.stat usage_usec` 差分计算，**100% = 占满一个逻辑核**，不是占满整台机器。

- `lobe-postgres`：平均驻留约 **59.05 MiB**，采样峰值约 **60.13 MiB**；Swap **30.30 MiB**；平均 CPU **0.754%**。
- `lobe-redis`：平均驻留约 **9.55 MiB**，采样峰值约 **10.07 MiB**；Swap **2.19 MiB**；平均 CPU **0.701%**。
- `lobe-network`：驻留约 **0.69 MiB**；Swap **0.03 MiB**；平均 CPU **0.005%**。
- `lobe-searxng`：驻留约 **15.74 MiB**；Swap **119.66 MiB**；采样期 CPU **0.000%**。

四组同一采样点相加，平均驻留 **85.03 MiB**、峰值 **86.28 MiB**，Swap 合计 **152.18 MiB**，平均 CPU 合计 **1.459%**。这些容器已经运行数周，部分页面被换出；低驻留不能推导出冷启动、访问后或搜索工作负载的内存需求。容器进程的 PSS 不可读，完整 PSS 明确记录为 `null`，没有用 0 代替。

四个容器当前均未设置自身 CPU 配额和内存上限：`cpu.max = max 100000`，`memory.max = max`，Docker 中相应配置值为 0。这不是将来的小型服务器部署配置；祖先 cgroup 还可能施加另外的限制。

## 生产构建、冷启动与业务负载

<!-- production-measurement:start -->

已在 `/tmp/qingzhou-production-baseline-20261010-head` 建立固定到 `076b84a24b1e20f750a09e76f41f4a06ff004991` 的独立源码快照，工作区依赖链接指向该快照，第三方包复用既有安装；未复制真实 `.env`，未连接真实数据库或模型，也未启动机器人。原版生产构建诊断记录见 [2026-10-10-head-production-attempts.json](../../scripts/performance/baselines/2026-10-10-head-production-attempts.json)。工具版本为 Node 22.23.1、Bun 1.3.14、pnpm 10.33.0、Next 16.2.6。

**HEAD 的 Next 编译通过，但完整生产构建尚未成功，生产 Web 服务没有启动。** 排除沙箱 IPC 与依赖链接边界问题后，编译分别在 86 秒、74 秒完成；随后默认远端市场站点地图生成了 3,225 个静态页面任务，最后在 `assistants-2649.xml` 超时重试后失败。最后一次 Next 阶段持续 914.48 秒，日志最后显示 1,953/3,225；不能把阶段进度当成可部署产物。

原始市场目录行为未修改，也没有创建空市场 fixture。源码中的分页先取得完整标识列表，每个 sitemap 分页又重复取得完整列表后截取 100 项；这使构建依赖远端目录规模和响应时间。后续改造版将另行记录，不能覆盖原版失败证据。

为排除隔离环境问题，仅在 `/tmp` 快照设置 `turbopack.root = '/'`，覆盖快照与共享依赖的共同父目录；在页面数据收集阶段使用指向关闭的本地端口的数据库占位地址，并用已有 `VERCEL_ENV` 条件禁止机器人自启。这些环境差异在 JSON 中列明。临时 systemd 用户单元已验证可以设置 4 CPU 配额、0–3 CPU 范围与 4 GiB 上限，并能读到快照；它们只是立即退出的权限 / 路径探针，尚不是 Web 服务在此限额下运行的证明。

构建时 Linux `RUSAGE_CHILDREN.ru_maxrss` 记录到单个最大子进程约 **9.12 GiB**。此值不是并发进程树内存总和，更不是服务运行内存；构建期间还与其他开发工具共享宿主机。当前 `.next` 开发缓存未被改动，没有启停任何既有服务或容器。

文档站现成的生产 BUILD_ID 时间为 2026-09-20，早于当前代码；博客有 2026-10-09 静态 `dist`。核查时两站 HEAD 分别为 `140266d` 和 `7cd47e1`，本轮尚未用它们验证完整三站运行容量。

<!-- production-measurement:end -->

### 2026-10-11 复核昨日改造版

上面的失败记录属于原始 HEAD。复核昨日后续原始文件后，**改造版已经完整生产构建成功**：114.18 秒，单个最大子进程 9,440,300 KiB（约 9.00 GiB）。本轮将复核结果归档为 [改造版构建与公开 Web 基线](../../scripts/performance/baselines/2026-10-10-refactor-public-web.json)，保留原始失败记录。

同一产物在真实 cgroup 配额下完成公开入口测试，路径仅包括 `/signin`、`/manifest.webmanifest`、`/favicon.ico`，每组 150 请求均为 200：4c4g 关闭预加载后就绪 1.324 秒、平均空载 RSS 252.1 MiB、请求期峰值 RSS 284.4 MiB；8c8g 就绪 1.281 秒、平均空载 RSS 276.0 MiB、请求期峰值 RSS 291 MiB。4c4g 开启预加载的对照平均空载 RSS 554.0 MiB、请求期峰值 606.7 MiB。

这些是新进程、已预热文件缓存；CPU 配额分别为 400%/800%，内存上限 4/8 GiB，Swap 上限 0。数据库仍是关闭端口上的占位地址，没有真实模型、机器人或 PPT 导出，没有认证用户工作负载。**不能将约 252 MiB 当作完整三站、数据库与重任务的总内存。**

9 GiB 是已复现的编译峰值，不能据此推断生产常驻内存。Node 的 old-space 参数只限制 V8 堆，Turbopack、图像库等原生分配和子进程另计。本轮开始逐阶段采样编译进程树，并检查日志中的宽泛文件追踪；仅缩小堆参数曾导致 Webpack 内存不足，因此失败构建不作为低内存优化通过的证据。

### 2026-10-11 构建内存优化实测

[逐阶段构建记录](../../scripts/performance/baselines/2026-10-11-build-memory.json) 保留失败尝试和成功结果。Turbopack 的高峰在 `next_compile` 阶段，发生在静态页面生成之前；将 JavaScript 堆限制为 1536 MiB、减少页面处理进程并设置原生缓存目标后，单进程采样峰值仍达约 9.38 GiB。不能把这些参数当作进程 RSS 硬限制。

修复 PPT 账号历史迁移的动态路径追踪，消除了约 5.3 万文件匹配与意外扫描整个项目的警告；这项修复并未解决主要内存峰值。修复后的 Turbopack Next 阶段完整通过，72.58 秒，单进程采样峰值仍为 8.76 GiB。该轮复用了已生成的 SPA 产物，不能与包含 SPA 的总构建耗时直接比较。

新增 `bun run build:compact` 完整执行 SPA、模板生成与 Webpack Next 构建：启用 Webpack build worker /memory optimizations、关闭构建缓存、降低模块处理并发、使用 4 个页面处理进程，默认 JavaScript 堆 4096 MiB。Markdown 规则与原 Turbopack 配置一致；Discord 适配器作为服务端外部依赖，保留其可选原生压缩依赖的运行时处理。生产构建不再启用开发用代码检查插件。

**完整构建成功，耗时 280.57 秒，进程树采样峰值 4.31 GiB，最大单进程采样峰值 4.04 GiB。** 昨日改造版最大子进程约 9.00 GiB，单进程峰值下降约 55%，但总构建耗时从 114.18 秒增至 280.57 秒。该路径降低内存，不能描述为编译更快；没有修改生产启动的运行时堆预算。

默认低内存构建预设为 `8c8g`，4c4g 仅提供运行预设；先在 CI 或构建机产出，再向 4GB 服务器部署。仅构建 Next 时可用 `bun run build:compact --next-only`，前提是 SPA 与模板已生成。用户显式 `NODE_OPTIONS` 堆配置与 `RAYON_NUM_THREADS` 优先。构建采样没有施加 8GB cgroup 硬上限，因此它也不是 8GB 整机容量认证。1536/2560 MiB 的失败 Webpack 尝试保留在记录中，不作为可用预设交付。

计量采用宿主机 `/proc`、200ms 采样与 Linux `RUSAGE_CHILDREN`。RSS 求和可能重复统计共享页，采样会漏过短峰值；内核最大子进程计数可能遗漏脱离直接父进程等待链的子进程。比较时以记录中的采样单进程峰值与明确的阶段、构建范围为准。所有构建使用隔离源码与数据库占位地址，没有复制真实 `.env` 或启用机器人。

### 新产物受限启动与启动器常驻进程优化

[新 Webpack 产物的公开 Web 实测](../../scripts/performance/baselines/2026-10-11-compact-public-web.json) 使用真实 `startCompact.mjs`，在 4 个 CPU 配额和亲和性、4 GiB 内存上限、Swap 上限 0 的临时 systemd 单元中运行。同一产物分别验证了原有子进程启动方式和 Linux 直接替换方式。新进程运行于已预热文件缓存；两组均仅访问登录 HTML、manifest、favicon，150 次请求全部成功，未出现 OOM 或 Swap 使用，测试后服务和端口均已释放。

Linux 单进程模式就绪 **1.844 秒**，平均空载 RSS **310.9 MiB**、PSS **287.5 MiB**，请求期 RSS 峰值 **330.6 MiB**；整个 cgroup 的 `memory.peak` **278.0 MiB**。与同产物的双进程启动器对照，平均 RSS 减少约 **55 MiB**，PSS 减少约 **13 MiB**。RSS 包含共享页，不能把 55 MiB 当作独占物理内存的节省；cgroup 的文件页记账也受此前缓存归属影响。

这是新 Webpack 产物的公开入口测试，不是三站、数据库、账号工作台和真实 PPT 任务的总容量认证。与昨日 Turbopack 的 252 MiB 空载测量使用不同产物和启动方式，不能直接宣称生产运行内存全面下降。4GB 部署仍以预构建、外部模型和有界重任务为起点，真实业务验收保持独立。

构建与运行必须分别测量。当前 [package.json](../../package.json) 为 SPA 构建配置了 8192 MiB 的 Node old-space 上限，为 Next 构建配置了 7168 MiB；[Dockerfile](../../Dockerfile) 的构建阶段也使用 8192 MiB。**这些是堆上限，不是已观测到的内存，也不是进程 RSS 上限。** 小型服务器优先拉取预构建产物；依赖安装、类型检查和生产构建由开发机或 CI 完成。

## 复用采样工具

脚本：[sample-resources.py](../../scripts/performance/sample-resources.py)，Linux + Python 3.9 以上，仅使用标准库；选择 Docker 容器时另需本机 Docker CLI。它只读服务状态，不负责启动、重启、压测、GC 或配置修改。

在实际部署宿主机执行，例如：

```bash
python3 -B scripts/performance/sample-resources.py \
  --project qingzhou=/srv/qingzhou \
  --project docs=/srv/qingzhou-docs \
  --project blog=/srv/qingzhou-blog \
  --container qingzhou-postgres \
  --container qingzhou-redis \
  --duration 15 --interval 1 \
  --output /tmp/qingzhou-resources.json
```

容器名和目录要替换成当前部署的实际值。开发机混有工具进程时，优先用 `--pid web=实际服务PID` 精确选择一个服务及其子进程；也可用 `--exclude-pid` 或 `--exclude-comm` 排除已核实的工具。排除只针对该 PID / 进程名，不自动排除子进程，避免漏掉工具启动的真正服务。容器未运行或本地 cgroup 不可读会标记 `unavailable`，不能将这样的输出用于验收。

核算规则：

- 每个 PID 只属于一组，优先级是容器、指定服务 PID 树、最接近的项目 CWD / 祖先进程。容器用完整 ID 对照本机 cgroup，避免把远程 Docker 的 PID 误认为本地服务。
- RSS 求和可能重复计算共享页；只有所有成员 PSS 可读时才提供完整 PSS。不要再把容器的 RSS/PSS 加到同一容器 `memory.current` 上。
- 进程 CPU 通过 PID 与启动时钟共同确认身份，并取区间增量，不使用 `ps %CPU` 的进程生存期平均值。首个采样没有 CPU 区间，记为 `null`；汇总 CPU 平均值按区间时长加权。
- `/proc` 采样会漏掉两次采样之间结束的短任务，以及首次出现前的进程 CPU，因此进程 CPU 是下界。容器 CPU 用组累计计数器，可覆盖短生命周期子进程。采样峰值也可能漏掉短于采样间隔的内存尖峰。
- 在沙箱或另一个容器里运行只能看到其命名空间；需要在宿主机执行，或明确把可见性不足作为测量限制。脚本不宣称能自动突破权限或证明全局可见。

验证命令：

```bash
python3 -B -m unittest discover -s scripts/performance -p 'test_*.py' -v
```

本轮 8 项核算测试通过，覆盖 CPU 差分、PID 复用、容器优先归组、CWD 边界、嵌套项目、PSS 缺失、特殊进程名解析和短末尾区间加权。另对自行创建的 32 MiB 分配与单忙线程探针采样 1 秒，得到 RSS 43.65 MiB、PSS 38.10 MiB、CPU 98.96%；探针随后退出。它验证计量方法，不是清舟性能测试。

## 部署预算与验收目标

以下为待实现和实测校正的**工程预算**，采用 1 GiB = 1024 MiB。云服务标称 GB 可能与实际可用 GiB 不同，最终按 `/proc/meminfo` 和容器配额验收。

4 核 4GB 的起点是单机、外部模型、单个 PPT 导出任务、按需加载重能力。可暂按以下总额分配：系统与反向代理 384 MiB，清舟及 Cordis 常驻宿主 768 MiB，PostgreSQL 512 MiB，可选 Redis 64 MiB，PPT worker 1024 MiB，其余约 1344 MiB 留给安全余量与缓存。公开文档、博客页面尽量作为静态前端产物提供，原生业务插件共享宿主。**若仍启动独立文档 SSR 等进程，要额外计入预算，不能算进静态托管的成本。**

8 核 8GB 可暂按系统与反向代理 512 MiB，宿主 1536 MiB，PostgreSQL 1024 MiB，可选 Redis 128 MiB，PPT worker 总额 2048 MiB 分配，其余保留。仍从 1 个导出任务开始；只有实际重负载峰值与响应延迟过关，才考虑同时运行 2 个。SearXNG、额外数据库扩展和其他可选能力启用时另计资源。

这些分配不保证任意规模 PPT、上传文件或无限并发。页面数量、图片像素、解压后大小与并发数需要显式边界；超过预算应排队或给出可恢复的容量错误。Swap 仅作应急余量，不能用持续换页维持宣称的正常容量。

部署验收至少需要下列独立记录：

1. **冷启动**：新进程到健康端点可用的时间、期间 CPU 时间与峰值内存；记录产物版本、启动配置、CPU / 内存限制。不要把开发服务器编译时间当成生产启动。
2. **预热与常驻**：访问清舟主页、登录路径、文档、博客及能力目录后，持续采样；列出激活的 Profile/Plugin，观察是否有无任务仍常驻的 worker。
3. **真实任务**：外部模型调用加固定输入的 PPT 生成 / 导出、文档写入与博客草稿；记录产物正确性、吞吐、延迟、排队、失败与取消。对外部 API 等待时间单列，避免归为本机执行成本。
4. **卸载与恢复**：任务结束 / 取消后，检查活动句柄、连接、子进程和内存是否收敛；连续装卸和热替换不能累积资源。运行中的旧调用要有明确的排空或取消策略。
5. **受限环境**：在实际 4 核 / 4GB 与 8 核 / 8GB cgroup 配额下重复以上流程，监测 OOM、CPU throttling、Swap 增长和可用内存。直到这里通过，才能说整站部署目标被验证。

## 轻量化优先级与 TypeScript / Go 的判断

目前没有整站运行或语言对照基准支持 “TypeScript 已经是性能瓶颈”。先减少常驻服务、重复宿主与 eager import，让未启用插件不创建连接池、定时器或 renderer；重导出工作与常驻 Web 宿主隔离，并设置有界队列与并发。

插件 dispose 可以释放其资源，但 Node 的模块缓存不会因插件卸载自动清空。需要让大块原生内存确定归还操作系统时，可由按需 worker 的进程生命周期承接；不能把 “已从目录隐藏” 或 “disposer 已调用” 直接等同于内存已回收。

本轮已阅读当前安装的 Next.js 指南 `node_modules/next/dist/docs/01-app/02-guides/memory-usage.md` 和 `self-hosting.md`。其中 `experimental.preloadEntriesOnStart = false` 可降低启动时预加载，但所有路由最终访问后内存仍可能追平；默认页面缓存和依赖数量也应量化。只降低 old-space 上限不能限制原生图像缓冲、子进程或整个容器的内存。

Go 可以作为后续已确认的 CPU 热点或 worker 的候选实现，保持 Operation/Plugin 契约一致。选择依据应是相同输入、相同产物与取消语义下的 CPU 时间、峰值 RSS/PSS、p95 延迟、冷启动和运维成本；不能用空载 Go 程序对比加载全站依赖的 Node 进程。外部 API 等待、数据库缓冲和图片 / PPT 原生库的内存，不会仅靠改写调度层自动消失。

Core 的装配微基准可与整站测试并行，但单独标注：新进程加载最小 Profile，测量目录注册、首次能力激活、纯内存 Operation 调用，再连续执行装卸 / 替换循环并观察资源收敛；记录实际参与插件与零 I/O 探针。它用于排查内核与装配成本，不能替代 Next、数据库、真实导出和三站业务的生产启动 / 容量证据。
