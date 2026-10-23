# 清舟音乐 M2 播放工作台

M2 在 M1 同源鉴权媒体通路上接入 `/music`、常驻 Mini 播放栏和共享 AudioEngine。Web SPA 与 Electron 两套路由同步注册；播放器由主布局持有，切换音乐、聊天或 PPT 页面不会卸载音频实例。

## 使用

- 登录后从底部「清舟音乐」进入工作台，上传音频或按文件名搜索自己的文件库。
- 点击播放或加入队列；队列支持去重、移除、上下调整，最多 100 首。
- Mini 栏提供播放、暂停、上一首、下一首、进度、音量、顺序播放、列表循环、单曲循环和随机播放。上一首在进度超过三秒时先回到本曲开头。
- 为当前曲目导入本地 LRC。支持多个时间戳、毫秒和全局 offset；随媒体时间高亮，点击歌词跳转。限制 128 KiB、4000 个时间点，每行最多 1000 字符，按纯文本呈现。
- 页面刷新恢复队列、曲目、进度、音量、模式及歌词，保持暂停，点击播放后才申请媒体地址。恢复时重新验证曲目归属，移除不可用曲目。

## 生命周期与状态

`MusicPlayerHost → MusicPlayerProvider → PlayerShell` 放在持久主布局中，位于路由 `Outlet` 外。Studio 和 Mini 通过同一个 context 调用 AudioEngine，使用同一个 Zustand vanilla store；引擎按需创建一个 HTMLAudioElement，切歌复用它。

`playing`、`pause`、`waiting`、`loadedmetadata`、`timeupdate` 和 `ended` 来自原生媒体事件。播放承诺被拒绝时显示 blocked/error，可主动重试；不会仅凭点击按钮显示播放成功。每次换源或切换账号取消旧请求并推进 generation，每次播放/暂停单独推进 play intent，过期请求或承诺不改写当前状态。StrictMode 清理与重新挂载可安全重放。

账号切换和登出立即暂停，移除源、监听器及内存队列/歌词。浏览器数据按账号分区，保存的内容仅含曲目 ID、设置及本地歌词文本，不保存媒体地址、签名或凭证。存储失败不影响播放并提示用户；pagehide 和卸载时刷新保存进度。

媒体仍经过 M1 的每请求鉴权代理，Range 与存储签名过期重试继续由服务端处理。媒体报错时 Mini 的重试重新解析播放地址并保留已知进度。

## 范围

歌词是本浏览器、当前账号的本地关联，不上传服务器。服务端 `music.lyric.read`、队列提案和 Agent 调用仍属于后续阶段。跨页连续播放指同一标签页内的 SPA 导航，不承诺刷新、跨标签页或退出应用时连续出声。Electron 复用现有远端音频 API，本地磁盘音频不在本次范围。

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

浏览器验收运行真实 Studio、Mini、AudioEngine、MusicClient 和 M1 handler/provider；HTTP 文件记录、对象存储及已登录身份使用隔离 fixture。覆盖上传、解码、播放/暂停、歌词跳转、队列切歌、跨页共用一个实例、刷新暂停恢复、登出停止及窄屏溢出检查。截图保存在忽略目录 `.data/music-m2-validation/`。该验收不替代部署环境 BetterAuth/S3 的联调。
