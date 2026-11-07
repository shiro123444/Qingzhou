# 清舟音乐最小闭环落地方案

状态：M1 媒体通路与 M2 播放界面已实现，M3 Agent 尚待实施。初始方案基线为 `eb04cb1b1`，整理日期为 2026-10-19；实现与验证记录见 [M1 音乐媒体通路](../development/music-m1.md) 和 [M2 播放工作台](../development/music-m2.md)。M2 歌词采用按账号保存的浏览器本地 LRC，服务端歌词读取接口留待后续。

一期采用“用户已有音频文件库 + 单个 music 原子插件 + 每标签页一个浏览器播放器”。交付目标是：导入音频、搜索、加入队列、播放、暂停、跳转、切歌、可选 LRC 同步，以及在音乐页、聊天页和 PPT 页之间切换时继续播放。自然语言入口可以准备播放队列，实际播放由当前客户端执行并反馈结果。

## 1. 一期范围和默认选择

- 音源：已登录用户上传到清舟文件库的音频。复用现有上传、存储配额和文件记录；不读取服务器任意目录或接收外部播放 URL。先验收 MP3，再验证其他浏览器可解码格式；不把 MIME 标签视为解码成功。
- 界面：`/music` 工作台与常驻 Mini 播放栏共享同一个播放器。覆盖现有 Web SPA 和 desktop 路由配置；Electron 本地文件访问需要后续独立适配。
- 播放：原生 `HTMLAudioElement`，先不引入第二个播放引擎。Zustand 存储可序列化状态，AudioEngine 单独拥有音频实例、监听器和请求取消控制器。
- 歌词：可选用户上传的 LRC，先支持行级同步；没有歌词时仍可正常播放。逐字歌词、AMLL 流体背景和频谱是后续增强。
- 恢复：同一浏览器、同一账户恢复队列、当前曲目、音量和位置，刷新后等待用户点击继续。跨设备同步、后台远程控制、云歌单、AI 作曲和歌单封面生成不进入一期。
- 多标签页：各标签页独立控制播放，不广播自动播放指令。跨标签页独占播放和设备接管另作产品设计。

## 2. 复用现有架构的边界

`AtomicRuntime` 负责 schema 校验、调用事件、scope 传递、取消与插件租约。通过 `createAtomicRuntimeFromProfile` 装配 `music`、`skills`；不增加新的内核或任意路径插件加载器。

插件 ID 使用 `music`。操作名可以是 `music.track.get`，但不能把 `music.source.local` 当作独立 AtomicPlugin ID：当前运行时使用操作名第一个点前的字符串解析所有者。

组合操作使用 `agent: { contexts: ['skills'], maxCalls: ... }` 显式加入目录。`skills.run` 是最多 16 步的顺序组合；`skills.autorun` 复用现有有界模型循环。需要音乐领域限制时，在音乐 composition 中配置 policy、instructions 和 prepareInput，不修改全局发现规则。

运行时可以跨请求共享，但用户文件模型和模型配置必须从每次可信调用的 `services` 获取。禁止将首个用户的数据库对象、provider 或凭证保存在共享插件闭包中。HTTP 路由使用 `checkAuth`，在服务端构造 `{ userId, sessionId: 'music-account:<userId>' }`；工具参数不能设置 scope。

音频播放属于客户端生命周期。服务器插件租约只覆盖本次查询、解析或组合，不覆盖整首歌。替换发生时有活动调用则返回 `PLUGIN_BUSY`，待释放后重试；不承诺当前 AtomicRuntime 同时运行新旧代。已开始的媒体传输不依赖一个长时间存活的原子工具调用。

## 3. 模块和文件划分

M1 已新增服务端 contracts、provider、runtime、原子插件、API 和客户端。M2 已在 MusicPlayer feature 中实现共享引擎、store、歌词解析和 Mini，MusicStudio 实现工作台。下面保留完整方案的模块划分；服务端歌词、composition 和 Agent 仍是后续位置。

```text
src/types/music.ts                         曲目与播放 DTO、Zod 校验
src/server/runtime/music/
  contracts.ts                             provider 端口和错误码
  atomic-plugin.ts                         music 操作及发现元数据
  owned-file-provider.ts                   用户音频查询、播放解析和流式代理
  composition.ts                           待实施：音乐 skills policy 与模型配置解析
  runtime.ts                               music/skills bundle 和 profile
src/app/(backend)/api/runtime/music/
  route.ts                                 受鉴权的目录及操作入口
  tracks/[id]/stream/route.ts               每请求鉴权的媒体流与 Range 代理
src/services/music/client.ts               HTTP DTO 客户端
src/features/MusicPlayer/
  engine.ts                                单一 HTMLAudioElement、store、队列与账号持久化
  context.tsx                              共享引擎、账户切换、资源回收
  PlayerShell.tsx                          路由内容容器与常驻播放栏
  lyrics.ts                                有界 LRC 解析、时间索引
  MiniPlayer.tsx                            全局控制栏
  index.tsx                                主布局 Host 与登录账号绑定
src/features/MusicStudio/
  index.tsx                                搜索、导入、队列和歌词
src/routes/(main)/music/index.tsx           薄路由，导入 MusicStudio
```

在 `src/routes/(main)/_layout/index.tsx` 的持久布局中组合 MusicPlayer Host，放在会随路由切换的 `Outlet` 外；业务实现留在 features。Host 在退出登录或账户变化时停止播放并清理状态，不因离开 `/music` 而卸载。

同时更新 `desktopRouter.config.tsx` 和 `desktopRouter.config.desktop.tsx`，运行现有路由同步测试。新增界面使用 `@lobehub/ui`、`createStaticStyles` 与 `cssVar`；添加 default、zh-CN 和 en-US 的音乐文案及所需命名空间登记。

## 4. 首批操作契约

| 操作                     | 输入要点                         | 输出与职责                                                               | skills 可见 |
| ------------------------ | -------------------------------- | ------------------------------------------------------------------------ | ----------- |
| `music.search`           | `query`、`limit`，限制长度与数量 | 返回当前用户的音频曲目 DTO，不返回内部存储 key 或签名地址                | 是          |
| `music.track.get`        | `trackId`                        | 读取归属当前用户的音频记录；不存在或不可访问统一返回曲目不可用           | 是          |
| `music.lyric.read`       | `trackId`、可选 `lyricFileId`    | 校验两份文件归属，返回 LRC 行或 missing；限制文件大小、行数和时间值      | 是          |
| `music.queue.prepare`    | 有序 `trackIds`，最多 100 首     | 批量验证归属和音频类型，返回全量有效的队列提案，不修改客户端播放状态     | 是          |
| `music.playback.resolve` | `trackId`                        | 返回同源受鉴权 stream 路径、MIME 和版本信息；不将原始签名 URL 提供给模型 | 否          |

所有输入使用 `.strict()`；操作输出也声明 schema。`trackId` 一期直接使用已有文件 ID，`source` 固定为 `library`，无需新增曲目表。展示名回退到文件名；艺术家、封面、时长等未知字段可空，时长以媒体 `loadedmetadata` 为准。

歌词与曲目的配对由用户在当前账户中选择，一期只在本地保存文件 ID 关联。读取歌词前分别执行归属校验，不根据同名文件猜测来源。解析多时间标签、偏移和无效行后，输出有序的 `{ startMs, text }`；行号通过播放器位置计算，不另起歌词时钟。

`music.queue.prepare` 保留用户指定顺序，返回稳定的曲目引用。该操作是准备提案，不是“服务器已经播放”。无效曲目使提案失败并明确指出需重新选择，不默默放入不可播放项。

## 5. 文件权限与媒体通路

现有 `FileModel(db, userId).query/findById/findByIds` 有用户过滤，且查询已有 Audios 分类。音乐 provider 复用这些入口。现有 `/f/:id` 使用不带用户过滤的静态查询并公开重定向，不能直接当作音乐的鉴权入口。

具体链路：

1. 上传使用现有 upload/file 服务保存音频，确认文件记录创建成功后刷新曲库。歌词按普通文件上传；音乐入口不触发文档切片或嵌入任务。
2. `POST /api/runtime/music` 只接收固定操作集合和 input，校验登录、同源写请求及有界请求体，再调用 music runtime。服务实例和用户标识由路由注入。
3. `music.playback.resolve` 校验文件所有权和音频类型，返回 `/api/runtime/music/tracks/<fileId>/stream`。M1 采用同源流式代理：stream 路由再次验证当前登录身份、记录归属和类型，通过 `FileService.createPreSignedUrlForPreview` 取得短期地址，在服务端请求存储并直接转发流；响应不共享缓存，签名地址不发送给浏览器。
4. 代理规范化并转发单个 Range，验证实际存储响应的 `206`、`Content-Range` 和长度。存储忽略 Range 或返回不一致范围时明确失败；不使用 `getFileByteArray` 全量缓冲长音频。HEAD 读取存储元数据，不将 GET 签名误用于 HEAD。
5. 每次 seek 或重连仍访问同源鉴权入口。存储返回 401/403 时，代理重新签名并按原 Range 自动重试一次；失败后返回固定错误。账户认证失败或曲目不可访问不重试。浏览器无需从过期的远端 URL 切换源或丢失播放位置；后续 M2 再提供网络错误的手动恢复界面。

原始存储 key、签名 URL 和凭证不进入 skills 结果、诊断事件或持久化播放器状态。媒体解析是短请求，不能把一次授权视为永久访问权。现有公开文件分享语义保持不变；音乐入口的校验不意味着文件系统已提供严格私密存储。

## 6. 客户端状态和资源所有权

AudioEngine 在每个标签页中只创建一个音频实例。Studio、MiniPlayer 和自然语言入口都调用同一个 controller，组件不自行创建播放器。

状态至少包含 `idle / loading / playing / paused / buffering / blocked / error / ended`，以及 queue、activeTrackId、positionMs、durationMs、volume、repeatMode、shuffle 和错误码。

- `playing`、`pause`、`waiting`、`loadedmetadata`、`timeupdate`、`ended`、`error` 驱动实际状态；不能在发出 play 请求时直接显示播放成功。
- `play()` 拒绝且为 `NotAllowedError` 时进入 blocked，展示用户可点击的播放按钮。脚本点歌同样受浏览器播放策略约束。
- 快速切歌使用递增的 source generation 和 AbortController。迟到的地址解析、歌词结果、play Promise 和媒体回调不得覆盖当前曲目。
- seek 以有限的毫秒值为输入，转换为秒后约束在已知时长和可 seek 范围内；元数据尚未就绪时保留待恢复位置。
- 顺序播放末尾停止；单曲循环、列表循环和随机模式通过统一队列 reducer 实现。解码错误停在可见错误状态，不自动无限跳过曲目。
- 进度更新节流；歌词在必要时随音频时钟更新。频谱等高频数据未来在 animation frame 中处理，不逐帧写 Zustand。
- 本地持久化按账户分区，只保存文件 ID、歌词关联、队列顺序、音量、模式和位置；登出清理当前会话数据，切换账户先清空再恢复目标账户。恢复后重新校验引用，并保持 paused。
- Host 卸载时暂停音频、移除监听器、取消未完成请求、释放临时 Object URL 并清空媒体源。React StrictMode 的重复挂载不能造成两个可播放实例或重复监听。

浏览器依据见 [HTMLMediaElement.play](https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/play) 和 [HTTP Range requests](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Range_requests)。

## 7. 自然语言入口的最小闭环

一期将 Agent 定义为“查找和准备队列”。音乐工作台提交指令，可信路由为本次调用解析用户当前模型，`skills.autorun` 可以调用 music 搜索、曲目读取和队列准备，最后返回成功调用产生的提案。结构化提案从执行结果中提取，不能解析模型总结来恢复文件 ID。

例如“找两首名称含雨夜的音乐”只能按现有文件名和已提供的元数据筛选；未接入音频分析前，不声称已识别音色情绪。

当前标签页展示候选曲目，由“替换队列并播放”按钮触发共享 controller，再根据实际媒体事件显示结果。服务器接受、队列准备成功和浏览器开始播放是三个不同结果。这样无需为第一版增加 SSE 播放命令总线或持久消息队列。

若后续需要“对话直接控制已打开的播放器”，再增加独立的目标标签页绑定、commandId、过期时间、去重、播放器回执和重连快照。原子调用的 started/completed 事件不能充当播放成功回执。

## 8. 实施顺序与完成条件

| 阶段        | 可独立交付的内容                                                       | 进入下一阶段的条件                                              |
| ----------- | ---------------------------------------------------------------------- | --------------------------------------------------------------- |
| M1 媒体通路 | music contracts/provider/runtime、鉴权 API、上传音频搜索和播放地址解析 | 两账户隔离、真实 MP3 播放和 Range seek 通过；过期地址能有界恢复 |
| M2 播放器   | AudioEngine、store、MiniPlayer、MusicStudio、双路由注册和文案          | 播放控制、队列、可选 LRC、刷新恢复及跨页不断播通过              |
| M3 Agent    | 复用用户模型的音乐 composition、队列提案展示与确认播放                 | 真实指令经过 Cordis 工具产生可播放队列；模型异常不影响手动播放  |

每阶段只新增必要验证，不写 UI 样式快照或复述实现的测试。M1 必须完成真实存储验收，M2 必须完成真实浏览器播放，M3 必须完成一次真实模型调用；测试替身通过不替代这些检查。

关键回归：

- 其他账户的 trackId/lyricFileId、伪造 scope、未知输入字段、非音频记录和任意 URL 被拒绝。
- 文件在队列准备后删除，播放时再次鉴权并显示不可用；不存在的资源和其他账户资源使用相同公开错误。
- 搜索或 skills 执行中 replace 返回 `PLUGIN_BUSY`，完成或取消后可以替换，失败候选保留旧版；目录不会泄露 `playback.resolve` 给模型。
- A 曲地址晚于 B 曲返回、play Promise 迟到、快速连续切歌时，界面和音频均保持当前选择。
- 自播放被拒绝时没有虚假的 playing；真实媒体结束只推进一次；LRC 使用音频位置同步。
- `/music → 聊天 → PPT → /music` 只保留一个音频实例；登出立即停止播放，账户之间不恢复对方队列。
- 刷新恢复队列但不自动发声；歌词缺失、格式不支持和网络错误均保留手动恢复入口。
- 双路由同步测试、相关定向 Vitest、全仓 `type-check`、改动代码 ESLint 与格式检查通过。

## 9. 当前基线修复和验证

本轮修复的是已有检查问题：kernel 演示文稿测试的临时工作区和 input.json 路径不再硬编码 POSIX 路径；runtime store 测试补齐 `answerPresentationDecision`、`updatePresentationPresence` 两个必需客户端方法。

`pdf-lib` 原本已在 package.json 声明，缺失来自本机安装。已使用项目指定的 pnpm 10.33.0 补齐依赖；仓库现有 `.npmrc` 禁用锁文件且 `.gitignore` 排除 pnpm-lock.yaml，因此不新增被强行跟踪的锁文件，也不重复修改依赖声明。

本轮全仓 `type-check` 通过。定向验证覆盖根项目 13 个文件 122 项、cordis-kernel 17 个文件 174 项、cordis-runtime 3 个文件 12 项，以及 agent-runtime 的 Cordis 相关 3 个文件 17 项，共 36 个文件 325 项通过。这些结果验证现有基线，不表示音乐播放已实现或验收。

## 10. 2026-10-22 上游整合与设计借鉴

本次已将 `origin/main` 的 `f05be3d8c` 整合到当前开发分支，包含 `4adc64f9a` 的代表页试跑、匿名评价、能力证据与确定性文本修复。`origin/codex/representative-page-trials` 另有 `8068a7d57` 的 Harness 演进，尚未合入此次使用的 main；以下分别标明可复用的现有能力和后续接入条件，不将远端开发分支当作本机已启用功能。

### 已整合的代表页试跑

`trial-runner.ts` 冻结原始任务、配置、插件版本和素材摘要，在独立工作区执行最多两个候选。`trial-evaluation.ts` 分离真实身份与匿名评价标签；`representative-trial.ts` 在缺证据、门槛未过或没有严格改善时保留 baseline。推荐不覆盖原稿，默认生产生成链仍保持原接线。

`trial-text-layout.ts` 的主要价值是将模型提案与确定性验证分开：保留完整文字，通过真实字体度量完成换行，再检查容器、画布边界及重叠。模型的 passed 不能豁免几何失败。字体解析依赖 `fc-match`；本机 Windows/MiKTeX 首次冷启动超出其 1 秒上限，完成字体初始化后以单 worker 复测通过，未修改运行时超时或几何门槛。后续部署需要把字体工具与字体集作为运行环境依赖验证。

音乐可以沿用这一原则：队列候选先检查文件归属、可解码性、数量、重复曲目及用户约束，再展示用户选择；未读取音频或没有用户反馈时，不以模型的情绪判断证明推荐质量。LRC 时间戳和顺序同样先做确定性检查，保留原文本和文件引用。

### 未合并 Harness 分支中的可借鉴设计

阅读 `8068a7d57` 的公共契约、生产装配、发布事务、维护服务及相关实现记录后，可提炼出以下接入方向；本次未在当前分支执行该提交的迁移、后台 worker 或真实模型验收。

| 机制                            | 音乐后续接入方式                                                                 | 接入边界                                                           |
| ------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| 行为版本与运行快照分离          | 固定推荐策略版本，另存本次曲目引用、来源版本、队列顺序与用户指令                 | 播放签名地址和凭证不属于可复用快照                                 |
| 共同父子预算和稳定 attempt 身份 | 将一次点歌任务的搜索推理、策展及可选封面调用放在同一父预算下                     | 本地播放不产生模型预算；未知派发结果不能自动退款并重试             |
| 提案、验证、明确采用与 CAS 发布 | Agent 先生成队列提案；显式确认后才替换队列，持久歌单未来使用 revision 比较后提交 | 单次接受队列不等于永久学习用户偏好                                 |
| 原生 Cordis 维护服务            | 通过 ctx.effect 管理后续任务、订阅和后台清理，卸载时等待在途工作                 | 浏览器 AudioEngine 仍由客户端 Host 管理，不能套用服务端文件锁      |
| 持久 outbox 与发布代数          | 未来跨设备点歌使用命令身份、去重、过期和播放器回执                               | 服务端提交或投递成功不等于实际发声；一期仍用本地 controller        |
| 所有者索引、封写与资料清理      | 曲库及学习材料使用可验证账户归属；删除时取消任务、等待租约、拒绝迟到写入         | 新分支的 POSIX 生命周期与同机验收不能直接证明 Windows 或多主机支持 |

该分支的 `LearningSubject` 当前仅有 agent 和 presentation。音乐工作台若没有真实 Agent 绑定，需要先扩展 music 主体契约、预算身份和验证，再使用共同预算；不得伪造 Agent ID 借用其他领域的命名空间。

M1/M2 继续按现有方案实施。M3 先交付有界的自然语言队列提案；当 Harness 分支完成合并和本机验证后，再决定预算与经验服务的具体复用，不为普通播放引入实验数据库迁移或自动付费学习。

整合后的全仓 `type-check` 通过；根项目 12 个定向文件 195 项与 cordis-kernel 17 个文件 174 项通过，共 29 个文件 369 项。根项目批次使用单 worker，以避免本机字体工具冷启动和并发初始化干扰；未修改测试时限或生产门槛。
