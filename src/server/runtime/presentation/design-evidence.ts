import { createHash } from 'node:crypto';

import type { CapabilityCapsule } from './capability-memory';

/** Actual indexed observations delivered to design stages; never source example facts. */
export const designReferencePayload = (capsules: CapabilityCapsule[]) =>
  capsules.map(({ id, kind, name, rules, layout, recipe, designReference, source }) => ({
    id,
    kind,
    name,
    rules,
    layout,
    recipe,
    designReference,
    source: {
      workspaceKind: source.workspaceKind,
      workspaceId: source.workspaceId,
      sourceDigest: source.sourceDigest,
      templateId: source.templateId,
      versionId: source.versionId,
      evidencePages: source.evidencePages,
    },
  }));

export const designFingerprint = (value: unknown) =>
  createHash('sha256')
    .update(JSON.stringify(value) ?? 'null')
    .digest('hex');

export function designCompilationEvidence(input: {
  capsules: CapabilityCapsule[];
  stage: 'author' | 'repair' | 'pre-review' | 'post-repair' | 'export';
  svg: string;
  compiled?: {
    receipt: {
      layoutCapsuleId: string;
      sourceDigest?: string;
      styleCapsuleId?: string;
      slotIds: string[];
    };
  };
  skipReason?: string;
}) {
  return {
    schemaVersion: 1,
    compilerVersion: 15,
    stage: input.stage,
    status: input.compiled ? 'applied' : 'skipped',
    reason: input.compiled ? undefined : (input.skipReason ?? 'outside-supported-layout-capacity'),
    sourceFingerprint: designFingerprint(designReferencePayload(input.capsules)),
    svgFingerprint: designFingerprint(input.svg),
    layoutCapsuleId: input.compiled?.receipt.layoutCapsuleId,
    styleCapsuleId: input.compiled?.receipt.styleCapsuleId,
    sourceDigest: input.compiled?.receipt.sourceDigest,
    slotIds: input.compiled?.receipt.slotIds,
  };
}

export function appendDesignEvidence(
  previous: unknown,
  evidence: ReturnType<typeof designCompilationEvidence>,
) {
  const entries = Array.isArray(previous) ? previous : [];
  return [
    ...entries.filter((entry) => JSON.stringify(entry) !== JSON.stringify(evidence)).slice(-7),
    evidence,
  ];
}
