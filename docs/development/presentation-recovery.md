# Presentation collaboration and recovery

Requirement conversations and deck generation are durable actors. HTTP streams observe their progress; closing a tab or disconnecting a stream does not cancel the actor.

## Requirement conversations

The conversation endpoint supports `turn`, `session`, `presence` and `decision`. Each authenticated thread persists its command, document/brief checkpoints, outline, result, question history and request receipts. A repeated request ID with the same instruction returns the existing session; changing the instruction under that ID returns a conflict.

Both model questions and execution interruptions use the same collaboration controls. The user can answer, retry or defer, and select adaptive, ask or automatic handling. Adaptive handling asks when a recently focused, visible tab is present. Background transient failures get at most two automatic attempts before a durable question. Presence comes from page visibility and focus events, expires after 45 seconds, and does not inspect the user's screen. Presence is local to the Node process; explicit collaboration preferences are durable.

Checkpoint writes finish before document/planning work proceeds. The actor owns tool contexts and disposes them when an attempt ends. A planning timeout produces an actionable question, including when a provider fails to observe cancellation. Late callbacks cannot overwrite the interrupted checkpoint.

## Execution ownership

Set `CORDIS_PRESENTATION_DATA_DIR` to a persistent local directory. Server startup scans queued/running jobs and planning threads, then repeats every 30 seconds. Account scope is stored and verified against its directory hash. Waiting questions remain waiting after restart.

A Python standard-library helper holds an OS file lock for each actor: `msvcrt` on Windows, `fcntl` on POSIX. Its stdin pipe ties ownership to the Node process lifetime. A living worker keeps ownership; another runtime can observe it but cannot overwrite its work. Parent termination closes the pipe and releases the lock. Lock files are never deleted to steal ownership. Use the configured `CORDIS_PPT_PYTHON` executable, or a working system Python.

Graceful shutdown saves queued work and releases ownership. Crash recovery retains draft pages, per-page revision checkpoints and prepared image references. A version ID saved atomically with a composed edit distinguishes “page composed, export pending” from “page still needs composition”; recovery does not replay completed image generation or page edits. More than three repeated takeovers becomes a visible question. Generation attempts also have a bounded execution deadline. Windows snapshot replacement retries brief sharing violations while retaining the previous complete file.

This is a single-host persistent-filesystem design, not a distributed queue. Multiple machines need a shared transactional job store and distributed ownership. Model calls interrupted before their results are persisted can run again; provider idempotency remains relevant for that window.

## Visual planning

The content compiler considers meaningful generated illustrations when an image provider is available. It preserves factual tables, formulas, source figures and photographs. Explicit enrichment can require images on selected pages or disable generation. Long outlines compile in batches of at most four pages; a single-page revision recompiles that page and merges the other content intents unchanged. The shared image allowance spans batches.

Generated assets inherit the deck visual system and remain separate from editable text and tables. Complete collaboration scenes keep their background unless the user requests a cutout; segmentation can otherwise remove important secondary subjects. Explicit no-text requests are reiterated in the image prompt. Required visual slots must resolve to owned assets before publishing.

## Verification

Focused regression suites cover OS ownership, live-worker conflicts, checkpoint takeover, composed-edit recovery, persisted questions, idempotent answers, account isolation, bounded retries, timeouts, batched content compilation and scene preservation. React tests cover restoring the planning session without submitting another turn and sharing the collaboration controls.

The local long-task validation used an existing 18-page report with real providers: two original illustrations were generated and placed, the worker was forcibly terminated after the editable pages and image references were saved, and a new runtime recovered the same job through its startup scan without a retry API call. The takeover retained both prepared image references. Subsequent visual review caught destructive scene segmentation and unwanted labels; additional image corrections produced the complete scenes in the final export. The final file has 18 slides and notes, 296 editable text runs, four byte-identical source figures and two embedded generated illustrations. A browser reload restored a real planning question; selecting its answer persisted the decision and resumed the same conversation.

The affected runtime type-check and focused regression suites passed. The full repository type-check still reports existing cross-checkout dependency type conflicts and missing modules; it is not reported as passing. User documents, credentials, model payloads and local test artifacts are excluded from the source commit.
