# MoeKoe 插件与清舟 Cordis 的适配设计

状态：源码研究与后续实施方案，**尚未接入 MoeKoe 插件运行时或插件市场**。当前改动聚焦音乐工作台和常驻胶囊；本设计不增加远程安装、扩展执行或本地程序启动能力。

核对基线：MoeKoeMusic `16e61ea71518d17aa384adda1ec0e4750a358ecf`；MoeKoeMusic-Plugins `56cb2e6d09083b93ac690faf5cec89d0f2fe1ca9`。参考仓库位于忽略目录 `.data/references/`，未执行其中的第三方插件。

## 结论

Cordis 适合统一拥有音乐适配器的生命周期、依赖服务和资源清理。MoeKoe 原插件包不能直接作为清舟 Cordis 模块载入：其执行格式是 Chrome Manifest V3 扩展，宿主是 Electron 的持久 session，并依赖 Chrome API、MoeKoe 的 Vue 页面、预加载桥或本机 API。把 manifest 改名、包装一个 `apply()`，不会补齐这些运行条件。

最小可落实路线是先定义清舟自己的播放器服务端口，将需要的插件功能改写成受信任的 Cordis 模块，继续使用现有 AudioEngine 和鉴权 MusicProvider。原 ZIP 兼容应作为独立的桌面专项，不能由当前 UI 重构顺带完成。

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

## 最小实施方案：先适配功能

以下均为拟议文件和接口，当前尚不存在对应实现。

1. 在 `src/features/MusicPlayer/ports.ts` 定义 `MusicPlayerPort`，由 `AudioEngine` 的薄适配器实现。`snapshot()` 只返回当前曲目、播放状态、进度、时长、音量、模式和当前歌词；`subscribe(listener)` 返回取消函数；`command()` 使用严格枚举 `play/pause/previous/next/seek/setVolume`。命令直接调用现有 engine，播放成功仍由媒体事件决定。端口不暴露 HTMLAudioElement、整个 store 或任意执行函数。
2. 从一个受信任、无原生程序依赖的功能开始，例如歌词展示或听歌时长。新组件订阅上述端口，用 React 正式槽位渲染；不访问 MoeKoe CSS 类名或 React/Vue 私有实例。扩展卸载仅取消订阅并移除自己的界面，保持主播放器继续播放。
3. 如果该功能需要服务端能力，写应用内受信任的 `create…Plugin()`，沿现有 music runtime 的固定 modules/profile 装配。数据源适配继续实现 `MusicProvider`；调用级凭证和 user scope 由认证入口提供，取消信号一直传到底层请求。首个验证仍用现有账户音频库，避免同时引入新音乐源。
4. 需要原生 Cordis 服务的长连接适配器用 `ctx.effect()` 注册取消函数、事件监听移除和连接关闭。服务端 Fiber、浏览器引擎和 Electron 主进程分别在自己的进程中拥有资源；跨进程采用带 schema 的消息，不能跨进程传 Cordis Context 或函数。
5. 账号改变时撤销旧端口会话、停止其订阅/连接并递增 generation；迟到命令和事件不得作用于新账号。前端已有 `AudioEngine.setAccount()` 继续作为媒体停止与清理的唯一入口。

这一步可复用 Cordis 生命周期和清舟的媒体能力，交付的是清舟原生插件功能。它不宣称兼容原 MoeKoe ZIP，也不需要先建设插件市场。

## 若以后明确要求运行原插件 ZIP

这应单独建立桌面兼容项目，最少包括以下工作；本次不实施。

- 在 `apps/desktop` 新建扩展宿主，而不是给 `src/server/runtime/music` 增加 `eval/import(zipPath)`。使用专用持久 session 和独立 WebContents，隔离清舟聊天页面及其认证 Cookie；账户切换后停止旧会话。仅换 session 并不能生成 MoeKoe 的 DOM，因此内容脚本仍需逐个适配或专用兼容页面。
- 定义专用、最小 preload 与 IPC schema，仅桥接已授权的播放器端口。根据真实 sender frame/session 识别插件和账户，不信任包内提交的 `pluginId/userId`。不复制 MoeKoe 的通用 IPC、任意酷狗请求入口或关闭 `webSecurity` 的窗口配置。
- 先对选定快照做能力清单：content script、MAIN world、Chrome storage、background、popup、网络端点、native host、操作系统。未实现的能力明确显示为不支持，不能根据 `moekoe: true` 判定兼容。
- Cordis 的宿主适配插件可在 `apply()` 中加载扩展并登记资源清理。卸载顺序为拒绝新命令、终止请求/订阅、停止并等待本地进程、关闭 bridge/popup、移除该扩展、撤销相关 IPC。取消/升级失败保留旧版本；工具 staging 无法自动回滚 Chromium 会话或 EXE 的副作用。
- 安装还需要独立的快照和包校验、解压路径/体积限制、允许来源、版本回滚。市场 `networkAccess/fileAccess/binaryContent/storageAccess` 是静态识别结果，不是运行时隔离保证。native host 需单独的平台支持及用户授予能力，不能在云端服务器替代用户桌面执行。

## 后续验收边界

- 对原生端口：两个订阅者共用一个 audio 实例；跨页播放不中断；移除扩展后监听/定时器归零且核心播放继续；账号切换和取消后迟到消息失效；真实媒体事件与端口状态一致。
- 对服务端适配器：沿用用户隔离、输入/输出 schema、调用取消与插件租约测试；新增源另外验证代理的 Range、身份和凭证不泄露。
- 对原 ZIP 宿主：每个选定插件独立验收 API 子集、页面/路由依赖、隔离会话、重启恢复、卸载清理及目标操作系统。仅看到插件“已加载”不能算功能兼容。

本研究未运行新增测试，也没有将上述方案标记为已实现。现有音乐 UI 与播放器验收记录见 [music-m2.md](./music-m2.md)。
