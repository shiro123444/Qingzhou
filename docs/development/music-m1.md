# 清舟音乐 M1 媒体通路

M1 实现音频上传客户端、账户音频搜索、Cordis 工具、鉴权媒体代理、单 Range 和一次签名过期恢复。复用现有文件表、上传服务、文件配额及 S3 配置，不新增数据库迁移。音乐页、常驻播放器、歌词和 Agent 队列属于后续 M2/M3。

## 调用入口

```ts
import { musicClient } from '@/services/music/client';

const track = await musicClient.uploadAudio(file, signal);
const matches = await musicClient.search('雨夜', 20, signal);
const playback = await musicClient.resolve(track.id, signal);
// M2 的共享 AudioEngine 将消费此地址；此处仅说明原生媒体接口。
const audio = new Audio(playback.src);
await audio.play();
```

上传先检查大小和真实文件特征，生成 SHA-256，通过已有 uploadService 上传到 music 目录，再通过 fileService.createFile 登记普通文件，最后读回归属当前账户的曲目。不会触发文档切片或嵌入。浏览器提交的 MIME 不作为特征识别结果；上传使用检测到的类型。客户端单文件限制为 64 MiB，服务器配额和已有上传策略仍由原文件接口负责，不能把客户端限制当成全局服务端上传限制。

上传中取消会中止 XHR；上传完成后的迟到回执不会继续登记。若对象上传成功而文件登记失败，调用会失败，不自动重传或删除未经登记的存储对象；其清理由存储运维策略处理。

`POST /api/runtime/music` 接收 `{ operation, input }`，仅允许：

- `music.search`：`{ query?: string, limit?: number }`，最多 50 首，数据库查询直接限制数量，按当前账户与 audio MIME 过滤；搜索中的 `%`、`_` 和反斜杠按字面处理。
- `music.track.get`：`{ trackId }`，返回无存储位置的曲目 DTO。
- `music.playback.resolve`：`{ trackId }`，返回曲目及新的同源 stream 地址。不会进入 skills 模型目录。
- `skills.catalog`：发现可组合的搜索、曲目读取操作。本期未开放公开 skills.run/autorun 请求入口。

输入严格校验，JSON 请求体上限 16 KiB，对无 Content-Length 的请求同样逐块计数。接口拒绝跨源写入和伪造用户/服务字段。服务对象按认证请求创建，共享 runtime 不缓存用户身份。

## 媒体代理与过期恢复

`GET/HEAD /api/runtime/music/tracks/:id/stream` 使用既有 checkAuth。每次读取用户文件模型验证归属，其他账户、缺失记录及非音频记录统一不可用；不使用公开的 `/f/:id` 查询。

GET 先取得真实对象长度，支持 `bytes=start-end`、`bytes=start-` 和 `bytes=-suffix`。仅接纳单范围，返回正确的 206、Content-Range、Content-Length 和 Accept-Ranges；越界或无效范围返回 416 及 `bytes */size`。If-Range 透传，存储因版本变化回退完整 200 时保持其标准语义。

媒体直接转发上游 ReadableStream，取消信号传到 fetch，不将完整音频读进 Node 内存。GET 签名只用于 GET；HEAD 直接从对象元数据生成头部。拒绝外部重定向、压缩传输及不一致的范围/长度；不透传 Cookie、Location 或供应商错误正文。

签名地址只在服务器内使用。每次媒体请求重新签名；存储返回 401/403 时，关闭失败响应流并再签名一次，保留同一个范围和取消信号。第二次仍失败则停止。普通网络错误、账户认证失败、文件不存在不会自动重试。`Cache-Control: private, no-store` 保证媒体响应不进入共享缓存。

公开错误为 MUSIC_INVALID、MUSIC_FORBIDDEN、MUSIC_TRACK_UNAVAILABLE、MUSIC_RANGE_INVALID、MUSIC_STORAGE_UNAVAILABLE、MUSIC_CANCELLED。对象存储的 key、签名、错误正文和凭证不进入 DTO 或事件。已有文件系统的公开分享语义未改变，音乐代理校验不能被当成对全站文件分享模型的修改。

## 验证

定向测试覆盖真实 Cordis 装配、工具发现与租约、schema、请求体上限、认证路由接线、账户隔离、真实数据库的字面搜索、上传失败与取消、范围归一化、错误范围、If-Range、HEAD、签名更新和最大重试次数。

`media.integration.test.ts` 启动本地 HTTP 存储适配器和媒体入口，上传实际 PCM WAV 字节，逐字节检查下载和 Range 返回，注入一次过期回执并确认恢复，同时验证匿名/其他账户/删除后请求。该适配器不是生产 S3 或真实 BetterAuth，会明确区分协议回归与部署验收。

真实浏览器测试需要显式提供浏览器和 MP3 文件，默认单测不启动浏览器。此次使用本机 Edge 和 FFmpeg 生成的 8 秒纯音 MP3，验证实际解码、播放、跳至 2 秒、206 范围及一次过期恢复。可复核：

```powershell
$env:MUSIC_BROWSER_EXECUTABLE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
$env:MUSIC_TEST_MP3 = 'D:/absolute/path/tone.mp3'
node node_modules/vitest/vitest.mjs run --silent=passed-only src/server/runtime/music/media.integration.test.ts
```

数据库测试使用 PGlite 和现有迁移；正常生产 PostgreSQL/S3、真实登录页面及线上部署仍需独立验收。本机 Docker daemon 未运行，本轮不声称已完成该部署组合的端到端验收。

2026-10-22 本轮结果：音乐和相关运行时共 10 个文件 124 项、完整文件模型 1 个文件 59 项通过，共 183 项，包含上述显式启用的 Edge/MP3 验证；全仓类型检查及改动代码 ESLint、Prettier、差异空白检查通过。超限请求还覆盖 checkAuth 的 Request.clone 分支，避免等待另一条未读取的 tee 分支而挂起。
