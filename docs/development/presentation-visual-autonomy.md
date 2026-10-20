# Autonomous presentation visuals

The earlier image-enriched acceptance deck used two human-selected pages and subjects. It verified generation, placement and restart recovery, not autonomous art direction.

The default creation path now loads the chosen learned capabilities and template profiles, establishes one deck visual system, and plans visuals across the complete outline before compiling small content batches. Each page has a strategy (`native`, `source`, `reuse`, `generate` or `mixed`), reason, content brief, composition intent, priority and offered capability IDs. The plan also defines one shared illustration language and continuity rules. No image page numbers, subjects or coordinates are required from the caller.

The whole-deck planner compares meaningful content uses before spending the image allowance on decoration. Generation may be omitted when it adds no value. Source charts stay original and factual content stays editable. When the deployment allowance is smaller than the proposed artwork set, whole-deck priorities determine which images survive; early batches cannot consume later pages' allocation. Selected image requirements cannot silently disappear in content compilation, and unrelated raster proposals cannot take their budget.

Learned templates supply composable layout and rendering methods. Enabling the shared master no longer hides those capabilities from the page planner. Generated artwork uses the selected illustration language and learned medium rather than a hard-coded business illustration style. All pages and images remain subject to the shared master palette and visual review.

The art-direction checkpoint is persisted before batch compilation. Its fingerprint changes with the brief, source materials, learned capabilities and deck style. Content caches are cleared when direction changes. Retries reuse the selected capability IDs after resolving them through the account's library; they do not independently pick a different style on every retry. Explicit image slots, disabled generation and scoped user edits retain their own intent.

Page artifact metadata includes the Agent's visual decision and shared illustration style. The architecture and assets drawer explains the current page's choice, including pages that reuse source figures or remain native.

Regression coverage checks whole-deck allocation, late-page priority, disabled generation, cached planning and invalidation, original/global batch slide identities, learned-medium image prompts and page-specific decision display. Live acceptance uses the existing source report with no caller-specified image pages, subjects, template IDs or image coordinates. Local acceptance artifacts and private materials are excluded from source commits.
