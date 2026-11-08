import { type GlassVolume } from './raytrace';

export interface SceneDepthEntry {
  /** Preferred minimum front Z, including any explicit depth override. */
  front: number;
  kind?: string;
  volume: GlassVolume;
}

export interface SceneDepthOptions {
  /** The page content plane; non-shell glass must sit completely above it. */
  backgroundZ?: number;
  /** Separation between volumes, at least 0.2 to leave room for content planes. */
  gap?: number;
}

export type ResolvedSceneDepth<T extends SceneDepthEntry> = Omit<T, 'front' | 'volume'> & {
  front: number;
  volume: GlassVolume;
};

const DEPTH_EPSILON = 0.001;

/** Conservative XY overlap: corner-only AABB overlaps also receive separate depths. */
const overlaps = (a: GlassVolume, b: GlassVolume) =>
  Math.abs(a.center[0] - b.center[0]) < (a.size[0] + b.size[0]) / 2 &&
  Math.abs(a.center[1] - b.center[1]) < (a.size[1] + b.size[1]) / 2;

/**
 * Input order is the actual browser paint order, back to front. Material presets
 * and data overrides are lower bounds, never a substitute for that ordering.
 * Overlapping projected rectangles get disjoint closed Z intervals; the earlier
 * volume's front and its content plane therefore remain below the later back.
 * Unrelated rectangles may keep the same Z. No DOM reads or input mutation.
 */
export function resolveSceneDepths<T extends SceneDepthEntry>(
  entries: readonly T[],
  { backgroundZ = 8, gap = 0.2 }: SceneDepthOptions = {},
): Array<ResolvedSceneDepth<T>> {
  if (!Number.isFinite(backgroundZ) || !Number.isFinite(gap) || gap < 0) {
    throw new RangeError('Scene background and depth gap must be finite, with a nonnegative gap.');
  }
  const separation = Math.max(0.2, gap) + DEPTH_EPSILON;
  const ids = new Set<string>();
  const resolved: Array<ResolvedSceneDepth<T>> = [];
  for (const entry of entries) {
    const { volume } = entry;
    if (
      !volume.id ||
      ids.has(volume.id) ||
      !Number.isFinite(entry.front) ||
      !volume.center.every(Number.isFinite) ||
      !volume.size.every((value) => Number.isFinite(value) && value > 0)
    ) {
      throw new RangeError(
        'Scene entries require unique IDs, finite positions and positive dimensions.',
      );
    }
    ids.add(volume.id);
    const thickness = volume.size[2];
    let front = Math.max(
      entry.front,
      entry.kind === 'shell' ? Number.NEGATIVE_INFINITY : backgroundZ + separation + thickness,
    );
    for (const lower of resolved) {
      if (overlaps(volume, lower.volume))
        front = Math.max(front, lower.front + separation + thickness);
    }
    const center: GlassVolume['center'] = [
      volume.center[0],
      volume.center[1],
      front - thickness / 2,
    ];
    resolved.push({ ...entry, front, volume: { ...volume, center } });
  }
  return resolved;
}
