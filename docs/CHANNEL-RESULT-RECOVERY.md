# Channel reply budgets and result recovery

Managed WeChat, QQ and Feishu/Lark tasks persist their terminal text and verified artifact IDs before attempting delivery. Results are available under Channels → Platform → Bot → Activity → Task. The page uses Qingzhou's navigation, components and theme tokens.

## Reply budgets

- QQ acknowledgements, command responses, text chunks, attachments and new native streams share an atomic Redis counter scoped to application, conversation and inbound message. Stream continuation frames reuse the original sequence. No process-local counter fallback is used when Redis is unavailable.
- QQ C2C replies allow four sends within 60 minutes; group replies allow five within five minutes. Native C2C stream frames retain the existing five-minute guard. Private file upload does not consume a send; the visible file message does. Allocated slots are not refunded after errors.
- WeChat resolves the newest shared conversation token before every visible text/file send. A managed text effect is at most 2,000 characters and corresponds to one request. No fixed token validity duration is assumed. Explicit API rejection is distinguished from a connection failure with uncertain receipt.
- Existing callback worker budgets, frozen payloads, transport receipts and unknown-outcome quarantine remain in effect. Unknown delivery is never automatically treated as permission to append a replacement message.

QQ limits were checked against the [official message overview](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/overview.html) on 2026-11-07. WeChat integration uses the existing iLink protocol; [Tencent's adapter source](https://github.com/Tencent/openclaw-weixin) is the upstream reference.

## Stored results and retrieval

Task records use a separate `channel-task` namespace in `bot_delivery_ledgers`. They cannot overlap callback send leases. The existing owner foreign key deletes them when the account is deleted; no new migration is required. The first terminal result is immutable, including across retries and late progress callbacks.

The management APIs check the authenticated owner and current provider/agent assignment. List responses omit content and sender identifiers. Task detail responses omit platform credentials and external sender identifiers.

`/result` returns the latest completed result in the current conversation for the original sender. `/result <task-id>` selects a specific result with the same checks. Retrieval sends a bounded preview and an authenticated Qingzhou detail link; attachments remain accessible through the linked Qingzhou conversation. The command works while another task occupies the conversation. It uses the new inbound message's reply context and allowance.

The task UI distinguishes pending, submitted to platform, retained, and uncertain delivery. “Submitted” means the API acknowledged the send, not that a human saw it. Known-unsent terminal callbacks are ended as `dead / result_retained` in the existing queue, with no automatic replay and no delivered timestamp; their full results remain in the task record.

## Live verification

Use a dedicated test agent and account. In its channel configuration, connect personal WeChat through iLink QR authorization. After connection:

1. Send a unique short test marker and verify the inbound record, completed task, reply and visible marker on the phone.
2. Send `/result` and verify retrieval is scoped to that sender and conversation.
3. Test a longer response and a generated attachment; compare the task result with the platform's visible messages.
4. Reconnect after a server restart and verify no previously confirmed message is resent.

Record observed outcomes rather than treating HTTP success as end-to-end verification. QQ and Feishu live account verification is deferred until the user supplies their test accounts. A local `localhost` result URL is only accessible on the development machine; deployments must set their own reachable `APP_URL`.

Development worktrees that share package dependencies must keep Vite's optimized cache separate. This worktree uses `.data/vite-cache`; Next can use `QINGZHOU_DEV_WORKSPACE_ROOT` to cover the shared dependency location.

### Local verification status (2026-11-07)

- 476 distinct relevant tests passed, including database isolation, terminal result immutability, uncertain delivery, QR lifecycle and reply-window expiry during budget allocation.
- The latest full type check reports 130 diagnostics outside the changed channel paths. Compared with the earlier 129-diagnostic baseline, the additional diagnostic is a duplicate `UIChatMessage` export in the shared base worktree's context-engine package. The task detail UI test passes.
- The authenticated QR endpoint responds through both the backend and SPA proxy. The configuration page renders the QR dialog and its expiry/refresh state.
- Personal WeChat phone authorization completed. Both the configuration page and runtime status report connected. The user reported a missing-key failure on the phone: inspection found that `/help` had not been registered and was falling through to model execution. A standalone localized `/help` command now uses the normal access gates and works while a model task holds the conversation. Its focused routing, template and control tests pass (165 checks). On the real account, the user confirmed receiving both the command list from `/help` and the stored test marker from `/result`; both inbound commands were processed once without creating a model task.
- A transport reconnect returned to connected. A subsequent full local backend restart also restored the WeChat connection automatically. At 15:55 local time, all six inbound records and ten callback queue rows matched the pre-restart snapshot, including attempt counts and update timestamps; no replay was observed during this check.
- The user's compatible model service is saved through Qingzhou's encrypted provider settings. The configured order is DeepSeek V4.1 Flash, Gemini 3.8 Flash High, GPT-6 Luna. DeepSeek remains the general default, but the upstream returns HTTP 429 with a monthly-quota exhaustion error. Gemini and GPT passed connectivity checks. With the user's authorization, the WeChat test agent now uses Gemini 3.8 Flash High. At 15:52 local time, the real inbound marker request produced `QZ-WX-1107-OK` using that model; the complete result is persisted and marked submitted, and callback jobs are delivered. The user subsequently confirmed `/result` retrieved that marker on the phone.
- At the user's request, the logged-in desktop WeChat client was used directly for the long-response test. The request produced a 4,347-character result, persisted as task `8aa978cd4b0b496b333f93bc4785358082846c0969f45756f351225a1c1fe51b`. All three completion chunks are confirmed delivered in the ledger. Both `QZ-LONG-START` and `QZ-LONG-END` were observed in the actual WeChat conversation. A subsequent `/result` sent through desktop WeChat returned a bounded preview and the full-result link for that same task. Attachment generation/delivery remains unverified; this test agent currently has no file-generation tools enabled.
- The connected channel's activity and successful task detail pages were checked visually. Task section headings sit below the page title in size. Task references use short IDs, with the execution identifier available on hover.
- QQ and Feishu account verification remains deferred as requested.
