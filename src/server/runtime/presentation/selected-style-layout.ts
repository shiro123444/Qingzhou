import { getPresentationStylePreset } from '../../../../packages/runtime-contracts/src/presentation-style-presets';
import type { CapabilityCapsule } from './capability-memory';
import type { DeckVisualSystem } from './deck-visual-system';

/** The selected style is executable only with its matching upstream observation. */
export function selectedLayoutStyle(capsule: CapabilityCapsule, system: DeckVisualSystem) {
  const preset = getPresentationStylePreset(system.styleWorkspaceId);
  return preset &&
    capsule.kind === 'style' &&
    capsule.source.workspaceId === preset.id &&
    capsule.designReference?.style?.id === preset.visualStyle
    ? preset
    : undefined;
}
