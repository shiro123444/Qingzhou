# MoeKoe 插件与清舟 Cordis 的适配设计

状态：已在浏览器中接入真实 Cordis 宿主、受控播放器端口和内置歌词插件，并提供按账户保存的插件开关。以下保留 MoeKoe 源码研究及后续兼容设计。**本次不支持直接运行 MoeKoe 原 ZIP，也未接入插件市场、远程安装或本地程序启动。**

核对基线：MoeKoeMusic `16e61ea71518d17aa384adda1ec0e4750a358ecf`；MoeKoeMusic-Plugins `56cb2e6d09083b93ac690faf5cec89d0f2fe1ca9`。参考仓库位于忽略目录 `.data/references/`，未执行其中的第三方插件。

## 结论

Cordis 适合统一拥有音乐适配器的生命周期、依赖服务和资源清理。MoeKoe 原插件包不能直接作为清舟 Cordis 模块载入：其执行格式是 Chrome Manifest V3 扩展，宿主是 Electron 的持久 session，并依赖 Chrome API、MoeKoe 的 Vue 页面、预加载桥或本机 API。把 manifest 改名、包装一个 `apply()`，不会补齐这些运行条件。

当前已沿最小路线实现清舟自己的播放器服务端口和受信任的原生 Cordis 歌词模块，继续使用现有 AudioEngine 和鉴权 MusicProvider。这里复用了 Cordis 的真实依赖与生命周期机制；原 ZIP 兼容仍是独立的桌面专项。

## MoeKoe 的真实执行链路

1. [ExtensionManager.vue](https://github.com/MoeKoeMusic/MoeKoeMusic/blob/16e61ea71518d17aa384adda1ec0e4750a358ecf/src/components/ExtensionManager.vue#L269) 仅在 Electron 环境显示。市场读取 `plugins.json`，安装按钮调用 `window.electronAPI.installPluginFromUrl()`；它本身不执行插件。
2. [preload.cjs](https://github.com/MoeKoeMusic/MoeKoeMusic/blob/16e61ea71518d17aa384adda1ec0e4750a358ecf/electron/preload.cjs#L3) 暴露 `electron`、`electronAPI` 和 `kugouapi`。除插件管理和 nativeHost 方法外，还有通用 IPC 方法与酷狗请求入口。这些对象不等同于清舟现有的 preload 契约。
3. [extensionManager.js](https://github.com/MoeKoeMusic/MoeKoeMusic/blob/16e61ea71518d17aa384adda1ec0e4750a358ecf/electron/extensions/extensionManager.js#L23) 扫描扩展目录，通过 `session.defaultSession.extensions.loadExtension(path, { allowFileAccess: true })` 加载解包扩展。安装链验证 Manifest V3；ZIP 安装、下载和 Chromium 加载是另外一套机制，并非 Node/Cordis 模块加载。
4. [utils.js](https://github.com/MoeKoeMusic/MoeKoeMusic/blob/16e61ea71518d17aa384adda1ec0e4750a358ecf/electron/extensions/utils.js#L6) 分离 Chrome 权限与 `moekoe:apiMode`、`moekoe:nativeHost`。`moekoe: true` 是适配声明，`minversion` 指 MoeKoe 应用版本，都不是 Cordis 的依赖注入或兼容协议。
5. [extensionIPC.js](https://github.com/MoeKoeMusic/MoeKoeMusic/blob/16e61ea71518d17aa384adda1ec0e4750a358ecf/electron/extensions/extensionIPC.js#L23) 处理管理、弹窗和 native host IPC。native host 请求从 `senderFrame.url` 的 `chrome-extension:` 来源识别扩展；授权管理另有来源检查。弹窗加载 `chrome-extension://<id>/<popup>`，使用 MoeKoe preload。
6. [nativeHostManager.js](https://github.com/MoeKoeMusic/MoeKoeMusic/blob/16e61ea71518d17aa384adda1ec0e4750a358ecf/electron/extensions/nativeHostManager.js#L17) 另外管理本地程序。manifest 声明平台路径、参数、自动启动和隐藏 bridge 页；程序权限持久化在应用配置中，进程以 JSON Lines 交换消息。隐藏扩展页连接 `chrome.runtime` 与 Electron preload。卸载需要停止进程并关闭 bridge，单纯移除工具注册不够。
7. [apiService.js](https://github.com/MoeKoeMusic/MoeKoeMusic/blob/16e61ea71518d17aa384adda1ec0e4750a358ecf/electron/services/apiService.js#L22) 还有本机 HTTP/WebSocket 服务，广播歌词及 `playerState`，接收 `toggle`、`next`、`prev`。它将命令发送回主窗口；音乐并非由这个服务另建一个播放器播放。

Electron 官方也明确仅实现 Chrome 扩展 API 的一个子集，扩展必须解包并在持久 session 中加载；因此即使新增 Electron 加载器，也不能承诺任意 Chrome 或 MoeKoe 插件兼容。[Electron 扩展支持](https://www.electronjs.org/docs/latest/api/extensions)

## 市场与实际插件证明了哪些依赖

[MoeKoeMusic-Plugins](https://github.com/MoeKoeMusic/MoeKoeMusic-Plugins/tree/56cb2e6d09083b93ac690faf5cec89d0f2fe1ca9) 是登记、审核快照与索引仓库，不是统一插件实现。非编译包固定到 commit，编译包记录发行附件；权限标签由 manifest 和源码静态分析生成。标签可供清舟展示来源和能力，不能直接变成清舟授予的能力。

| 已核对的市场快照                                                                                                                                                                                                                                                                          | 实际依赖                                                                                                                | 对清舟的含义                                                                                                          |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| [歌词悬浮面板 manifest](https://github.com/gaozil996/MoeKoeMusic-LyricPanel/blob/b042dd537fc187dfa6ee7fd303ec2be5e28c75e3/manifest.json) 与 [queue-main.js](https://github.com/gaozil996/MoeKoeMusic-LyricPanel/blob/b042dd537fc187dfa6ee7fd303ec2be5e28c75e3/queue-main.js#L43)          | `file:///*` 内容脚本、ISOLATED/MAIN world；查找 `#app.__vue_app__` 并操作 Vue RecycleScroller 内部实例和 `.queue-*` DOM | 清舟为 React，路由与 DOM 均不同；即使脚本加载成功，功能也不会自动成立。应将队列和歌词 UI 改写为清舟组件或受控扩展槽。 |
| [评论面板 manifest](https://github.com/MoeKoeMusic/moekoe-comments-panel/blob/aef8c14d81163fc7370177e58abea8d09317ff4f/manifest.json) 与 [content.js](https://github.com/MoeKoeMusic/moekoe-comments-panel/blob/aef8c14d81163fc7370177e58abea8d09317ff4f/content.js#L134)                 | Chrome storage/background、`#/playlistdetail` 参数、`.detail-page` 与 `.track-list-container`；本机 API                 | 清舟没有对应实体、页面或接口。需要先有明确的歌单/专辑数据契约，不能只模拟 Chrome storage。                            |
| [Windows 桌面歌词 manifest](https://github.com/MoeKoeMusic/moekoe-lyric-desktop/blob/f4b755b034e3797efa901d3e459909a6093b918b/manifest.json) 与 [native-bridge.js](https://github.com/MoeKoeMusic/moekoe-lyric-desktop/blob/f4b755b034e3797efa901d3e459909a6093b918b/native-bridge.js#L1) | `moekoe:nativeHost`、Windows EXE、扩展 bridge、两个本机 WebSocket 端点                                                  | 属于桌面和特定平台能力。Cordis 可以管理其适配进程，但云端 Node 运行时与浏览器 SPA 无法原样提供这些条件。              |

这些是已查看样本的结论，不是对所有市场插件逐个完成兼容性审计。

## 清舟已有的可复用边界

| 当前文件                                                                                                                       | 已有能力                                                                     | 适配时应保持的职责                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| [music/contracts.ts](../../src/server/runtime/music/contracts.ts)                                                              | `MusicProvider.search/track/resolve/stream`，显式 `userId`                   | 数据源与鉴权媒体入口；不承担浏览器播放状态。                                                                          |
| [music/production.ts](../../src/server/runtime/music/production.ts)                                                            | 每请求创建账户范围的 OwnedFileMusicProvider                                  | 不在共享 Cordis 实例上缓存登录身份或外部账户凭证。                                                                    |
| [music/atomic-plugin.ts](../../src/server/runtime/music/atomic-plugin.ts)                                                      | 三个有输入/输出 schema 的音乐原子操作；校验 provider 与调用 scope 的用户一致 | 受信任的能力调用入口，使用调用方注入的服务。新增操作需显式注册。                                                      |
| [music/runtime.ts](../../src/server/runtime/music/runtime.ts)                                                                  | music + skills 的固定 profile                                                | 当前模块表为应用内受信任工厂，不接受 ZIP、manifest 或远程代码地址。                                                   |
| [atomic-runtime.ts](../../src/server/runtime/atomic-runtime.ts)                                                                | 真实 Cordis 宿主、工具租约、调用取消、替换时 staging、账户/会话诊断 scope    | 适用于受信任操作模块。`AtomicPlugin` 只有操作清单，不是 Chrome 扩展入口；模块本身含 Node 依赖，不应导入播放器客户端。 |
| [cordis-atomic-host.ts](../../src/server/runtime/cordis-atomic-host.ts)                                                        | 原生 Cordis Fiber、`effect/on/provide/inject` 适配、资源随 Fiber 清理        | 可拥有宿主资源；它不是浏览器/进程隔离边界，也不生成 Chrome API。                                                      |
| [cordis-runtime/loader.ts](../../packages/cordis-runtime/src/loader.ts)                                                        | 受信任原生插件 profile、候选代准备、旧调用排空后释放                         | 若后续需要服务型插件，用这一层或原生 Cordis 服务生命周期；不要把服务发布伪装成原子工具的 staging。                    |
| [MusicPlayer/engine.ts](../../src/features/MusicPlayer/engine.ts) 与 [context.tsx](../../src/features/MusicPlayer/context.tsx) | 共享 AudioEngine、可订阅 Zustand store、播放命令、账户切换清理               | UI、Agent 及桌面适配器应控制同一个引擎，不创建第二个 HTMLAudioElement。                                               |

当前媒体 DTO 的 `source` 固定为 `library`，播放地址限制为 `/api/runtime/music/tracks/…`（[types/music.ts](../../src/types/music.ts)）。加入酷狗或其他数据源会涉及曲目身份、服务凭证、schema 和媒体代理变更，不能通过让插件直接返回任意 URL 绕过现有约束。

## 已落地的最小实现

1. [ports.ts](../../src/features/MusicPlayer/ports.ts) 实现账户会话范围的 `MusicPlayerPort`。`getSnapshot()` 返回当前曲目元数据、播放状态、进度、时长、音量、模式、账户与当前歌词的深冻结副本；`getPositionMs()` 只读原生音频时钟，账户切换后立即撤销；`subscribe(listener)` 返回取消函数；`command()` 严格校验 `play/pause/previous/next/seek/setVolume` 及其字段。端口不暴露媒体地址、完整队列、HTMLAudioElement 或可变 store，命令直接交给同一个 AudioEngine。账户往返也不会恢复旧端口权限。
2. [plugins/runtime.ts](../../src/features/MusicPlayer/plugins/runtime.ts) 的 `MusicPluginHost` 直接使用 `@lobechat/cordis-foundation` 导出的真实 `Context`。每次激活创建独立上下文，提供 `music.player`、`music.lyrics` 与 `music.lyricsSource`，再加载固定、随应用打包的歌词插件，等待原生 Fiber 完成并校验激活状态。歌词插件获得的播放器命令能力仍仅为 `seek`；歌词读取能力只能请求当前账号会话的当前酷狗歌曲，不能读取任意曲目、媒体地址或登录凭据。没有远程插件地址或任意模块执行入口。
3. [plugins/lyrics-plugin.ts](../../src/features/MusicPlayer/plugins/lyrics-plugin.ts) 声明上述服务依赖，通过 `ctx.effect()` 拥有端口订阅和自动歌词请求，向 `LyricsViewSlot` 发布不可变歌词视图。换歌时通过 `music.lyrics.get` 优先获取带真实逐词时间的 KRC，没有逐词歌词时回退 LRC；不通过均分时长伪造词时间。每次插件激活的缓存最多 32 首、1 MiB，单份歌词限制 128 KiB；缓存不跨账号或插件生命周期。换歌取消旧请求，账号切换/卸载同步撤销能力和取消请求，迟到结果不能覆盖新歌。界面分别显示加载中、无歌词与可重试的失败状态。[LyricsPanel.tsx](../../src/features/MusicPlayer/plugins/LyricsPanel.tsx) 用 React 渲染正式歌词槽，可见时局部逐帧读取受限时钟并更新词内填色和弹簧滚动，不向全局 store 写入高频进度。手动滚动暂停跟随，支持按钮/超时恢复、反向跳转、隐藏停帧和减少动态效果；不访问 MoeKoe DOM 或框架私有实例。
4. [MusicPlayer/context.tsx](../../src/features/MusicPlayer/context.tsx) 在常驻 MusicPlayerProvider 中持有宿主与现有引擎。插件启停和 SPA 页面切换不创建第二个媒体元素；禁用插件清空歌词展示并释放插件订阅，保留引擎中的歌词和正在进行的播放。插件依赖订阅与端口自身的账户监视订阅分别清理：端口会话在禁用、换号或宿主停止时同步撤销。
5. [MusicPluginSettings.tsx](../../src/features/MusicPlayer/plugins/MusicPluginSettings.tsx) 提供内置歌词插件开关、读取/歌词跳转能力说明、启动失败重试与存储失败提示。开关保存在 `qingzhou:music:plugins:v1:<编码后的账户 ID>`，默认启用；账号切换后读取对应账户的设置。启动失败时可通过新的 Fiber 重试。
6. 换号、关闭或停止宿主时，先同步撤销旧端口和激活权限，再让 Cordis 异步完成资源清理。旧视图、端口、迟到启动和槽位回调不能写入新激活。Cordis 根 Fiber 的 `dispose()` 实际具有重启语义，因此宿主清理后丢弃旧 Context；React StrictMode 的 cleanup/setup 可在同一宿主上重新启动。媒体停止与账户数据清理仍由 `AudioEngine.setAccount()` 负责。

酷狗在线歌曲自动获取歌词，常规播放无需导入；本地上传文件仍可使用手动 LRC。试听源的 `offsetMs` 把完整歌词时间转换为片段内时间，保留跨越片段起点的歌词，只显示可播放片段内的后续行；点击跳转前再次核对当前曲目、片段范围与歌词视图。暂停恢复保存有界的片段起点和时长，刷新后无需先播放就能对齐歌词。账号权限改变时先清掉酷狗缓存媒体，再重新解析音源并保持暂停，本地文件播放不受影响。服务端数据源仍沿 `MusicProvider`、受信任 modules/profile、认证 scope 与取消信号接入；长连接或桌面资源应由各自进程中的 Cordis Fiber 拥有，跨进程传带 schema 的消息，不能传递 Context 或函数。

自动歌词回归覆盖 HTTP 客户端的曲目匹配和 UTF-8 体积上限、Cordis 请求取消/重试/缓存/权限边界、暂停试听恢复、片段内点击跳转，以及真实浏览器的在线曲库 → 歌词命令 → Cordis 视图链路。该浏览器正确性测试使用隔离的目录与媒体夹具；上游真实歌词可用性单独验证，不把夹具通过当作账号全曲权限验证。

## 若以后明确要求运行原插件 ZIP

这应单独建立桌面兼容项目，最少包括以下工作；本次不实施。

- 在 `apps/desktop` 新建扩展宿主，而不是给 `src/server/runtime/music` 增加 `eval/import(zipPath)`。使用专用持久 session 和独立 WebContents，隔离清舟聊天页面及其认证 Cookie；账户切换后停止旧会话。仅换 session 并不能生成 MoeKoe 的 DOM，因此内容脚本仍需逐个适配或专用兼容页面。
- 定义专用、最小 preload 与 IPC schema，仅桥接已授权的播放器端口。根据真实 sender frame/session 识别插件和账户，不信任包内提交的 `pluginId/userId`。不复制 MoeKoe 的通用 IPC、任意酷狗请求入口或关闭 `webSecurity` 的窗口配置。
- 先对选定快照做能力清单：content script、MAIN world、Chrome storage、background、popup、网络端点、native host、操作系统。未实现的能力明确显示为不支持，不能根据 `moekoe: true` 判定兼容。
- Cordis 的宿主适配插件可在 `apply()` 中加载扩展并登记资源清理。卸载顺序为拒绝新命令、终止请求/订阅、停止并等待本地进程、关闭 bridge/popup、移除该扩展、撤销相关 IPC。取消/升级失败保留旧版本；工具 staging 无法自动回滚 Chromium 会话或 EXE 的副作用。
- 安装还需要独立的快照和包校验、解压路径/体积限制、允许来源、版本回滚。市场 `networkAccess/fileAccess/binaryContent/storageAccess` 是静态识别结果，不是运行时隔离保证。native host 需单独的平台支持及用户授予能力，不能在云端服务器替代用户桌面执行。

## 验收记录与后续边界

2026-11-08 本轮定向验证：受控端口测试 10 项、原生 Cordis 宿主/歌词运行时测试 6 项、Studio UI 测试 2 项通过。覆盖深只读投影、严格命令、账户往返永久撤销、订阅清理、插件卸载不停止播放、权限收窄、开关分账户持久化、StrictMode 式重启、旧账户延迟启动隔离，以及启动失败重试与存储异常。

真实 Chrome 回归已通过：浏览器直接加载 Cordis，真实音频播放时关闭插件不中断且 audio 实例仍为 1；跨页保留开关；重新启用恢复歌词；刷新恢复停用偏好；退出账号清空插件状态。同时复验既有拖动、队列、歌词跳转、播放恢复和窄屏布局。合计 81 项相关测试通过，另通过全项目类型检查、ESLint、Stylelint 与格式检查。

本地 `localhost:3010/music` 使用已登录账号与现有试听片段完成页面验证：歌词插件启停、停用时胶囊继续播放、重新启用后点击歌词跳至 0:08 均正常；保留播放器预览。此结论适用于本地预览与本轮测试环境，未执行生产部署或独立手机路由联调。

- 对原生端口：两个订阅者共用一个 audio 实例；跨页播放不中断；移除扩展后监听/定时器归零且核心播放继续；账号切换和取消后迟到消息失效；真实媒体事件与端口状态一致。
- 对服务端适配器：沿用用户隔离、输入/输出 schema、调用取消与插件租约测试；新增源另外验证代理的 Range、身份和凭证不泄露。
- 对原 ZIP 宿主：每个选定插件独立验收 API 子集、页面/路由依赖、隔离会话、重启恢复、卸载清理及目标操作系统。仅看到插件“已加载”不能算功能兼容。

现有音乐 UI 与播放器验收记录见 [music-m2.md](./music-m2.md)。原 ZIP 宿主部分仍为后续设计，没有实现或兼容性验收结论。
