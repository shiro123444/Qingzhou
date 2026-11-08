# Kugou catalog in Qingzhou

The existing account-scoped Cordis `music` service routes `music.search` with
`source: "kugou"` to an anonymous Kugou catalog adapter. Omitting the source still
searches owned audio files. Both sources use the persistent AudioEngine and the
same queue. The UI opens the Kugou source by default; uploads switch to local music.

This follows the request flow of [MoeKoeMusic](https://github.com/MoeKoeMusic/MoeKoeMusic)
and the protocol documented in its MIT-licensed backend,
[KuGouMusicApi](https://github.com/MakcRe/KuGouMusicApi): `/search` maps to
`/v2/search/song`, metadata to `/v2/get_res_privilege/lite`, and `/song/url` to
`/v5/url`. Request signing and parameter interoperability are adapted from that
backend; its [MIT notice](licenses/KuGouMusicApi-MIT.txt) is included. No GPL UI code
or third-party desktop runtime is copied into Qingzhou.

Every URL request sets `IsFreePart=1`, as MoeKoeMusic does for unauthenticated
listeners. Kugou decides whether to return a full free track, a preview, or no
playable source. Preview tracks are labelled in the results and player; resolved
clip duration supersedes the catalog duration in the queue and caps playback/seek,
even when a clipped MP3 retains the original recording’s duration header. There is no silent
fallback to another recording, account cookie sharing, entitlement bypass, or
verification/challenge simulation. Kugou account login is not implemented here.

Tracks include real artist, album, and cover metadata. Their cover URL is an
account-authenticated same-origin endpoint, so ordinary `<img>` elements and the
glass snapshot renderer can read the same pixels without a tainted canvas. The
cover proxy accepts no client URL: it resolves a bounded track identifier against
Kugou and accepts JPEG/PNG/WebP from the two Kugou image hosts only. Public metadata
has a bounded five-minute cache. Covers are limited to 3 MiB; JSON to 2 MiB. Media
streams preserve Range/HEAD and stream without buffering. CDN hosts are allowlisted,
HTTP locations are upgraded to HTTPS, redirects are rejected, and upstream signed
media URLs never appear in client track data or error responses. All routes retain
the existing Qingzhou account check and reject cross-site embedding.

Run targeted regressions in `src/server/runtime/music`, `src/services/music`,
`src/features/MusicPlayer/engine.test.ts`, and `src/features/MusicStudio/index.test.tsx`.
An optional `KUGOU_LIVE=1` run of `kugou.live.integration.test.ts` verifies catalog
metadata, actual 206 MP3 bytes, and a real cover. Its report goes under ignored
`.data/kugou-validation/provider-live.json`. This external check is opt-in because
Kugou availability and geographic restrictions can change independently of this app.
