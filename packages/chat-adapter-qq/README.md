# QQ adapter inbound authentication

`handleWebhook` accepts POST bodies up to 1 MiB (enforced while reading the stream, with a five-second read deadline).
External events require the configured `X-Bot-Appid`, an exactly 64-byte hexadecimal
`X-Signature-Ed25519`, and a ten-digit Unix-seconds `X-Signature-Timestamp` within
300 seconds of the server clock. Ed25519 verification covers the timestamp followed
by the **original body bytes**, using the QQ secret-derived key.

QQ URL registration (`op: 13`) may be unsigned only when both native signature
headers are absent. Partial or invalid signatures are rejected, never downgraded.
It still requires matching app ID,
a fresh ten-digit `event_ts`, and an opaque `plain_token` of 16–128 ASCII letters,
digits, `_` or `-`. JSON, whitespace and punctuation are rejected: the challenge
must not become an oracle that signs event bodies. Registration never dispatches a
message. See QQ's [signature documentation](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/interface-framework/sign.html)
and [webhook registration](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/event-emit/webhook.html).

## Replay protection

Production servers should inject `claimWebhookReplay(key, ttlSeconds)`, implemented
as a shared atomic claim (for example Redis `SET NX EX`). The TTL is 601 seconds to
cover the entire past/future timestamp window. Claims bind app ID, timestamp and
raw body, not URL paths (native QQ signatures do not cover paths, so aliases must
share replay claims). Duplicate claims return 409; storage
errors return 503 without dispatching. Without this callback, the package uses a
**process-local** cache shared by adapter instances, capped at 10,000 live claims.
It fails closed when full, never evicts live claims, and **does not protect across
workers, replicas or process restarts**. This fallback is not distributed protection.

## Internal WebSocket forwarding

Servers can configure `authenticateWebhook(request): Promise<Response | void>` to
select an exclusive internal authentication mode. It runs before body parsing or
registration; any returned response or exception stops processing. There is no
fallback to external signatures. The callback must authenticate the raw body and
scope (platform, app ID, path, timestamp and nonce), claim replays, and read a clone
if it needs to consume the body. Authentication exceptions return 503.

The gateway requires an injected `forwarder(url, body): Promise<Response>`; there
is no unsigned fetch fallback and the package imports no server modules. The server
transport must sign the exact serialized body, disallow redirects and apply a
request timeout. Non-2xx responses are reported through the gateway logger rather
than treated as successful delivery. LobeHub's WS client injects the shared gateway
authenticator/signer; its webhook client injects shared native replay claims.
