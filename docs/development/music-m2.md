# 清舟音乐 M2 播放工作台

M2 在 M1 同源鉴权媒体通路上接入 `/music`、常驻悬浮胶囊和共享 AudioEngine。Web SPA 与 Electron 两套路由同步注册；播放器由主布局持有，切换音乐、聊天或 PPT 页面不会卸载音频实例。

## 使用

- 登录后从主侧栏「音乐」、快捷搜索或悬浮播放器进入「清舟音乐」。音乐页使用清舟共享侧栏，页头可展开／收起侧栏，自定义侧栏可调整音乐入口顺序与显示。播放页按 [MoeKoeMusic 全屏播放器](https://github.com/MoeKoeMusic/MoeKoeMusic/blob/main/src/components/PlayerControl.vue) 的实际结构组织：左侧大封面与居中曲名、时间夹细进度条、图标主控、右侧居中大歌词；背景、字色、控件和边框随清舟主题，封面与选中态使用品牌水青色。顶部切换「正在播放」「我的音频」「播放队列」「插件」，曲库与播放界面各占完整视图。无封面元数据时显示音乐符号占位，不虚构专辑信息。
- 点击播放或加入队列；队列支持去重、移除、上下调整，最多 100 首。
- 悬浮胶囊提供播放、暂停、上一首、下一首和进度；更多面板提供音量、循环／随机和队列。上一首在进度超过三秒时先回到本曲开头。
- 胶囊使用参考底栏的封面／曲名／纯图标控件／细进度层次，可收为迷你封面；音乐页默认收起，点击可展开，同一主布局内记住用户选择。收起只改变展示，不暂停、不销毁引擎，也不改变队列。
- 胶囊任意位置均可拖动，包括封面、曲名、播放键；拖动不触发其点击动作，轻点仍可打开播放器或控制播放。进度条短拖调进度，先按住再拖可移动整个胶囊。支持鼠标与触屏；聚焦胶囊本身后可用方向键移动，Home 或设置中的复位按钮恢复默认位置。
- 位置按账号保存在本浏览器中，刷新与跨页导航继续使用；收起／展开保留右下锚点，窄屏和窗口缩放自动限制在可见范围。聊天／PPT 统一输入区通过 `data-music-player-avoid` 标记，播放器自动避让可见输入区；避让和临时缩放不会覆盖用户保存的位置。更多面板依据上下空间展开。
- 为当前曲目导入本地 LRC。支持多个时间戳、毫秒和全局 offset；随媒体时间高亮，点击歌词跳转。限制 128 KiB、4000 个时间点，每行最多 1000 字符，按纯文本呈现。
- 页面刷新恢复队列、曲目、进度、音量、模式及歌词，保持暂停，点击播放后才申请媒体地址。恢复时重新验证曲目归属，移除不可用曲目。

## 生命周期与状态

`MusicPlayerHost → MusicPlayerProvider → PlayerShell` 放在持久主布局中，位于路由 `Outlet` 外。Studio 和 Mini 通过同一个 context 调用 AudioEngine，使用同一个 Zustand vanilla store；引擎按需创建一个 HTMLAudioElement，切歌复用它。

`playing`、`pause`、`waiting`、`loadedmetadata`、`timeupdate` 和 `ended` 来自原生媒体事件。播放承诺被拒绝时显示 blocked/error，可主动重试；不会仅凭点击按钮显示播放成功。每次换源或切换账号取消旧请求并推进 generation，每次播放/暂停单独推进 play intent，过期请求或承诺不改写当前状态。StrictMode 清理与重新挂载可安全重放。

账号切换和登出立即暂停，移除源、监听器及内存队列/歌词。浏览器数据按账号分区，保存的内容仅含曲目 ID、设置及本地歌词文本，不保存媒体地址、签名或凭证。存储失败不影响播放并提示用户；pagehide 和卸载时刷新保存进度。

媒体仍经过 M1 的每请求鉴权代理，Range 与存储签名过期重试继续由服务端处理。媒体报错时 Mini 的重试重新解析播放地址并保留已知进度。

## 范围

歌词是本浏览器、当前账号的本地关联，不上传服务器。服务端 `music.lyric.read`、队列提案和 Agent 调用仍属于后续阶段。跨页连续播放指同一标签页内的 SPA 导航，不承诺刷新、跨标签页或退出应用时连续出声。Electron 复用现有远端音频 API，本地磁盘音频不在本次范围。

MoeKoe 扩展与 Cordis 的兼容边界见 [适配设计](./moekoe-cordis-integration.md)。当前由浏览器原生 Cordis 宿主管理内置歌词插件的生命周期，支持开关、重试与按账号保存偏好；没有安装第三方扩展，尚不支持原 MoeKoe ZIP 或远程插件。

## 验证

```powershell
node node_modules/vitest/vitest.mjs run --silent=passed-only src/features/MusicPlayer/engine.test.ts src/features/MusicPlayer/lyrics.test.ts src/spa/router/desktopRouter.sync.test.tsx
corepack pnpm run type-check
```

可选真实浏览器验收复用 e2e workspace 的 Playwright，需要可执行浏览器和真实 MP3：

```powershell
$env:MUSIC_BROWSER_EXECUTABLE='C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
$env:MUSIC_TEST_MP3='D:/path/to/sample.mp3'
node node_modules/vitest/vitest.mjs run --silent=passed-only src/features/MusicPlayer/browser.integration.test.ts
```

浏览器验收运行真实 Studio、Mini、AudioEngine、MusicClient 和 M1 handler/provider；HTTP 文件记录、对象存储及已登录身份使用隔离 fixture。覆盖上传、解码、播放/暂停、歌词跳转、队列切歌、拖动与键盘移动、收起／展开锚点、跨页保留位置与同一个音频实例、输入区避让、刷新位置与暂停恢复、登出停止，以及 390px 窄屏的胶囊和更多面板边界。截图保存在忽略目录 `.data/music-m2-validation/`。该验收不替代部署环境 BetterAuth/S3 的联调，也不代表独立手机路由已接入音乐。

## 清舟界面融合（2026-11-08）

音乐入口复用共享导航目录、NavItem 与 Music2 图标；Studio、胶囊和插件页统一使用 `@lobehub/ui` 的 Icon 与主题圆角、文字、边框。音乐页恢复标准主侧栏内容，页头切换按钮具备可访问名称，不强制覆盖侧栏展开偏好。播放器主体保留双栏封面／歌词，窄容器自动转为单栏，四个导航标签在窄屏采用等宽排列。

本轮 105 项相关测试通过，包含真实浏览器播放、歌词插件启停、跨页连续播放、胶囊拖动、390px 窄屏、侧栏展开后仅 288px 内容宽度下的队列／插件页，以及侧栏设置回归；全项目类型检查通过。本地预览另验证了展开侧栏、音乐入口选中、从资源页通过快捷搜索返回音乐且播放继续。

## 玻璃材质与光学基础（2026-11-08）

胶囊改为连续圆端、内收控件与细进度的悬浮透镜；视觉探索使用内置 image generation 生成概念稿，实际界面全部由可交互组件实现。主框架、侧栏、聊天输入框、资源页与浮层使用共享材质，延续清舟水青色与统一图标。

`LiquidGlass` 独立管理背景折射：圆角距离场求曲面法线，Snell 折射计算位移，Fresnel 计算边光；Chromium 通过 SVG 采样实时背景。不同组件采用不同厚度与磨砂强度。尺寸、圆角和材质变化更新贴图，移动仅交给合成器；主壳使用独立背景板，保持悬浮播放器固定定位。无支持、减少透明度、高对比及模型无法匹配的非一致圆角保留可读材质。

新增 15 项光学数学测试，连同已有相关用例共 120 项通过。真实浏览器像素检查验证边缘位移、中心稳定、前景不受背景折射影响、实时背景更新、同尺寸圆角／材质失效和偏好降级；项目类型及静态检查通过。三维双界面、多层反射、DOM 纹理与 GPU 管线的研究和具体设计见 [液态玻璃架构](./liquid-glass.md)，三维渲染器尚未接入产品。
