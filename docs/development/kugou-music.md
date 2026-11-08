# Kugou music in Qingzhou

The account-scoped Cordis `music` service routes `music.search` with
`source: "kugou"` to the public Kugou catalog. Omitting the source still searches
owned audio files. Both sources use the persistent AudioEngine and the same queue.
The music library opens the Kugou source by default; uploads switch to owned audio.

This follows [MoeKoeMusic](https://github.com/MoeKoeMusic/MoeKoeMusic) and the protocol
in its MIT-licensed backend [KuGouMusicApi](https://github.com/MakcRe/KuGouMusicApi):
search uses `/v2/search/song`, metadata `/v2/get_res_privilege/lite`, playback
`/v5/url`, and QR login `/v2/qrcode` plus `/v2/get_userinfo_qrcode`. Protocol signing
and parameters are adapted from that backend; its [MIT notice](licenses/KuGouMusicApi-MIT.txt)
is included. No GPL UI code or third-party desktop runtime is copied into Qingzhou.

## Account linking and persistence

The account panel creates an official Kugou QR URL and renders it with the existing
Ant Design QR component. The listener scans and confirms in Kugou. Like MoeKoe's
`platform=lite` configuration, the linked session uses appid 3116; login and signed
playback use that same profile. The adapter does not switch profiles to try to
obtain additional rights. The existing anonymous catalog/preview profile remains
unchanged.

`POST /api/runtime/music/account` provides `status`, `start`, `poll`, `cancel`, and
`disconnect`. Every command runs through Qingzhou authentication, rejects cross-site
writes, and has a strict bounded input. The account API is separate from the Cordis
agent tools. Tokens, provider user IDs, device identifiers, and raw upstream login
responses are never returned to the client. Only display name, account state,
revision, timestamps, and the scan URL are public. The scan URL necessarily contains
the nonce encoded by the QR; polling and cancellation use a separate opaque ID.

Migration `0112_music_accounts` adds one row per Qingzhou user with cascading account
deletion. The entire state, including pending QR keys and linked tokens, is encrypted
with the existing `KeyVaultsGateKeeper` AES-GCM key. The authenticated encrypted
payload includes its Qingzhou owner, so swapping ciphertext between users fails
closed. It is not stored in user settings/key-vault structures returned to clients.
Apply normal database migrations before deploying the account UI. A configured
`KEY_VAULTS_SECRET` is required; there is no plaintext fallback.

A three-minute pending challenge and two-second server polling interval bound the
QR flow. Revision-based compare-and-swap checks reject late creation or approval
responses after cancel/disconnect and survive process restarts. Account display
revision changes only when the linked account changes or expires; ordinary QR
polling does not invalidate audio. Disconnect deletes the token and pending challenge
from the encrypted record. An upstream absolute token expiry is honored, otherwise
there is a local 30-day ceiling. Explicit token rejection expires the linked account;
verification challenges are surfaced without simulation or automatic authorization.

## Playback rights and source changes

Anonymous playback asks for Kugou's normal free/preview source (`IsFreePart=1`). A
linked account first requests the full source with its own token (`IsFreePart=0`).
Kugou decides whether that account has rights. If no full source is granted, only the
same recording's normal anonymous preview is attempted. There is no alternate
recording/quality/provider bypass, shared account, or fabricated VIP state. HTTP
authentication rejection and verification challenges are not retried as privileged
requests. Connecting an account does not guarantee every recording is playable.

Resolved tracks distinguish full songs from previews. A preview's granted duration
caps native playback and seeking even if its MP3 header retains the original
recording's duration. Its start offset aligns full-song lyrics with the clipped
audio. A finished preview restored after reload starts at zero on the first Play
click, while ordinary restoration stays paused.

The same-origin stream URL includes an account revision. Every new media request
reads current credentials, rejects a stale revision, and rechecks a linked session
after acquiring upstream bytes. Disconnecting or changing accounts cannot reuse a
cached privileged source URL. The UI immediately invalidates active Kugou audio
before refreshing the source, without recreating the shared audio element. Already
delivered browser media bytes cannot be revoked server-side.

## Personal music library

The Kugou library separates public search from the linked account's liked songs,
created playlists, collected playlists, and collected albums. The read-only
`library` and `playlist` account commands use the current server-side credentials;
the client never supplies a Kugou user ID or token. Each page contains at most 100
items and exposes `hasMore`, so collections and tracks can be loaded progressively.
Selecting or queuing a song uses the same AudioEngine, current playback-rights
resolution, artwork, and automatic Cordis lyrics as public search.

Playlist playback retains its signed account revision and full track count, while
loading metadata in 100-song pages. The engine keeps at most three adjacent pages,
prefetches near the current page boundary, and resolves audio only for the selected
song. An unloaded page is not treated as the end of the playlist. Sequence, previous,
repeat, shuffle, and retry use the full playlist position. Reload restores the
active page and saved position in a paused state instead of resolving every song.
Switching Qingzhou/Kugou accounts cancels pending pages and invalidates the source.

Manual queues remain bounded to 1,000 tracks. Songs queued during playlist playback
are kept separately and play after the playlist, so adding a song never silently
replaces the remaining playlist with the current cache window. Long library and
queue views render only visible rows. Browsing/loading more pages does not itself
load audio or add songs to the queue.

The request shapes follow KuGouMusicApi's
[`user_playlist.js`](https://github.com/MakcRe/KuGouMusicApi/blob/main/module/user_playlist.js)
and [`playlist_track_all_new.js`](https://github.com/MakcRe/KuGouMusicApi/blob/main/module/playlist_track_all_new.js):
`/v7/get_all_list` enumerates the account's collections and
`/v4/get_list_all_file_v3` reads a selected account playlist. This supports private
liked-song collections without substituting a public playlist search. Playlist
names and contents stay account-scoped and are not stored in the shared public
track metadata cache. The feature reads existing collections; it does not create,
delete, follow, subscribe to, or otherwise modify the listener's Kugou library.

Collection artwork is resolved server-side from a verified playlist ID through an
authenticated same-origin cover endpoint. The client cannot submit an arbitrary
image URL. Account revisions bind returned collections and cover requests to the
linked session; switching or disconnecting accounts clears the previous view and
prevents late requests from repopulating it.

## Artwork and lyrics

Tracks include real artist, album, and cover metadata. Covers use an authenticated
same-origin endpoint, so `<img>` and the glass renderer read the same untainted
pixels. The proxy accepts no client URL: it resolves a bounded track identifier,
accepts JPEG/PNG/WebP from the Kugou image hosts, and limits artwork to 3 MiB. Public
metadata has a bounded five-minute cache. JSON responses are bounded; media preserves
Range/HEAD and streams without buffering. CDN hosts are allowlisted and redirects
are rejected. Upstream signed URLs never appear in public DTOs or error messages.

The official concept-client hosts `fs.youthandroid.kugou.com` and
`fs.youthandroid2.kugou.com` currently issue HTTP media URLs and present mismatched
HTTPS certificates. Only these two exact hosts retain the protocol issued by the
HTTPS playback API, matching MoeKoe's original-source handling. This is a server-to-CDN
HTTP transport limitation: those media bytes and their short-lived media ticket are
not encrypted in transit. Account tokens/cookies are never forwarded to these media
requests. QR login, token-bearing API calls, artwork, and all other media hosts keep
HTTPS; no certificate validation is disabled and no HTTPS URL is automatically
retried over HTTP. The browser continues to use the same-origin authenticated proxy,
without mixed-content permissions or disabled web security.

`music.lyrics.get` obtains lyrics for the exact Kugou hash, preferring the original
KRC word timings. The server decodes the documented krc1/XOR/zlib wire format with
limits on both compressed and decoded content, validates UTF-8 and timing bounds,
and falls back to LRC only when word-timed lyrics are unavailable. It never invents
word durations by splitting a line evenly. Decoded lyrics are limited to 128 KiB;
at most 64 public results are cached for ten minutes. The Cordis lyric
plugin uses its active-track capability, cancels work on track/account changes or
plugin stop, and applies preview offsets. No title-based substitute lyric is silently
selected. Local LRC remains available for owned audio.

The Cordis player capability exposes a read-only native audio clock to the lyric
view. Only the visible lyric panel samples that clock per animation frame; it does
not publish frame-rate updates to the global player store. KRC words fill according
to their real start/duration, while LRC uses line-level highlighting. Spring scrolling
keeps the active line centered, pauses following on manual scroll, and supports
explicit resume, reverse seeking, hidden tabs, and reduced motion.

## Verification

Targeted tests cover account isolation, real encryption and migration schema, atomic
cancel/disconnect races, expiry, source revisions, actual-rights full/preview branches,
lyrics, and player continuity. Optional `KUGOU_LIVE=1` runs
`kugou.live.integration.test.ts` against real catalog/audio/artwork. Optional
`KUGOU_LOGIN_LIVE=1` runs `account-live.integration.test.ts` to create an actual QR
and observe waiting. Reports under ignored `.data/kugou-validation/` contain no QR
keys or tokens. QR creation/waiting is not proof of a completed user login or VIP
playback: those require the listener's scan/confirmation and the actual account's
rights. Upstream availability and regional restrictions can change independently.
