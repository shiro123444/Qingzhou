/** Code is supplied by the application; a profile only selects registered module names. */
export interface ProfileEntry {
  config?: Record<string, unknown>;
  id: string;
  use: string;
}

export interface PluginBundle {
  entries: readonly ProfileEntry[];
  includes?: readonly string[];
}

export type ProfilePatch =
  | { entry: ProfileEntry; op: 'add' | 'replace' }
  | { id: string; op: 'remove' };

export interface PluginProfile {
  bundles: readonly string[];
  patches?: readonly ProfilePatch[];
}

/** Deterministic, immutable bundle expansion followed by explicit ID-based patches. */
export function resolveProfile(
  profile: PluginProfile,
  bundles: Readonly<Record<string, PluginBundle>>,
): ProfileEntry[] {
  const entries = new Map<string, ProfileEntry>();
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const add = (entry: ProfileEntry, replace = false) => {
    if (!entry.id.trim() || !entry.use.trim()) throw new Error('CORDIS_PROFILE_INVALID_ENTRY');
    if (replace !== entries.has(entry.id)) {
      throw new Error(
        replace ? `CORDIS_PROFILE_MISSING: ${entry.id}` : `CORDIS_PROFILE_DUPLICATE: ${entry.id}`,
      );
    }
    entries.set(entry.id, structuredClone(entry));
  };
  const visit = (name: string) => {
    if (visiting.has(name)) throw new Error(`CORDIS_PROFILE_CYCLE: ${name}`);
    if (visited.has(name)) return;
    const bundle = Object.hasOwn(bundles, name) ? bundles[name] : undefined;
    if (!bundle) throw new Error(`CORDIS_PROFILE_BUNDLE_NOT_FOUND: ${name}`);
    visiting.add(name);
    for (const included of bundle.includes ?? []) visit(included);
    for (const entry of bundle.entries) add(entry);
    visiting.delete(name);
    visited.add(name);
  };
  for (const bundle of profile.bundles) visit(bundle);
  for (const patch of profile.patches ?? []) {
    if (patch.op === 'remove') {
      if (!entries.delete(patch.id)) throw new Error(`CORDIS_PROFILE_MISSING: ${patch.id}`);
    } else {
      add(patch.entry, patch.op === 'replace');
    }
  }
  return [...entries.values()];
}
