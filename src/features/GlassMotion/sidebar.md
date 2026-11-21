# Workspace sidebars

Use `NavPanelPortal` and `SidebarReopenButton` for features that occupy the app’s main navigation slot. The user’s navigation width and shortcut belong to the shell.

For an independent panel (a filmstrip, inspector, or companion), keep the open state in its workspace. Render `PanelToggle` with the physical side, a translated action label, `expanded`, `onToggle`, and an `aria-controls` pointing to the panel body. Leave that toggle mounted across state changes. If a second close button is inside the panel, return focus to the outside trigger before hiding its contents. Make hidden content inert or use the native hidden attribute.

Use `RightPanel` for a resizable inspector. For a custom layout, apply `panelMotionStyle` to the panel or its parent and transition the actual layout dimension with `width var(--qz-panel-resize)` (or height for a stacked layout). Avoid separately snapping flex-basis or min-width. Disable the transition under `prefers-reduced-motion: reduce` and during direct manipulation.

When the collapsed state only offers one action, size its glass surface to that action. The companion preserves its avatar as the reopen target; reopening the rail does not open its computer.
