import { describe, expect, it } from 'vitest';

import { type RepresentativeTrial, selectRepresentativeTrial } from './representative-trial';

const fingerprint = 'a'.repeat(64);
function variant(id: string, scores = [2, 2, 2, 2]): RepresentativeTrial['candidates'][number] {
  const gate = {
    status: 'passed' as const,
    evidence: 'Checked against the frozen source and render',
  };
  const score = (index: number) => ({
    score: scores[index],
    evidence: `Observed dimension ${index}`,
  });
  return {
    id,
    status: 'completed',
    appliedCapsuleIds: [],
    evaluation: {
      conditionFingerprint: fingerprint,
      evaluatorVersion: 'rubric-v1:model-config-1',
      artifact: { ref: `owned-preview-${id}`, sha256: 'b'.repeat(64) },
      gates: { facts: gate, editability: gate, assets: gate, render: gate, visual: gate },
      quality: {
        readability: score(0),
        hierarchy: score(1),
        composition: score(2),
        styleConsistency: score(3),
      },
    },
  };
}
function trial(candidates = [variant('layout-a')]): RepresentativeTrial {
  return {
    schemaVersion: 1,
    trialId: 'trial-1',
    source: { jobId: 'job-1', versionId: 'v1', slideId: 'slide-3' },
    conditionFingerprint: fingerprint,
    baseline: { ...variant('baseline'), id: 'baseline' },
    candidates,
    rejectedCandidateIds: [],
  };
}

describe('representative page selection', () => {
  it('keeps the original on a tie and leaves the trial untouched', () => {
    const input = trial();
    const before = structuredClone(input);
    expect(selectRepresentativeTrial(input)).toMatchObject({
      selectedId: 'baseline',
      reason: 'no-improvement',
    });
    expect(input).toEqual(before);
  });

  it('recommends a strictly better candidate without sacrificing any dimension', () => {
    expect(selectRepresentativeTrial(trial([variant('a', [3, 2, 2, 2])]))).toMatchObject({
      selectedId: 'a',
      reason: 'strict-improvement',
    });
  });

  it('does not use a higher total score to hide a readability regression', () => {
    expect(selectRepresentativeTrial(trial([variant('a', [1, 4, 4, 4])])).selectedId).toBe(
      'baseline',
    );
  });

  it.each([
    [
      [3, 2, 2, 2],
      [2, 3, 2, 2],
    ],
    [
      [3, 2, 2, 2],
      [3, 2, 2, 2],
    ],
  ])('keeps the original when improvements have a tradeoff or tie', (a, b) => {
    expect(selectRepresentativeTrial(trial([variant('a', a), variant('b', b)]))).toMatchObject({
      selectedId: 'baseline',
      reason: 'ambiguous-improvement',
    });
  });

  it('chooses the sole candidate that dominates both the original and its competitor', () => {
    expect(
      selectRepresentativeTrial(trial([variant('a', [3, 3, 2, 2]), variant('b', [3, 2, 2, 2])]))
        .selectedId,
    ).toBe('a');
  });

  it.each(['facts', 'editability', 'assets', 'render', 'visual'] as const)(
    'blocks a candidate with a failed %s gate even when the user picks it',
    (name) => {
      const input = trial([variant('a', [4, 4, 4, 4])]);
      input.candidates[0].evaluation!.gates[name] = {
        status: 'failed',
        evidence: 'Concrete defect',
      };
      input.userChoice = 'a';
      expect(selectRepresentativeTrial(input)).toMatchObject({
        selectedId: 'baseline',
        reason: 'user-choice-ineligible',
        candidates: [{ exclusion: 'gate-failed' }],
      });
    },
  );

  it('does not waive an unknown gate', () => {
    const input = trial([variant('a', [4, 4, 4, 4])]);
    input.candidates[0].evaluation!.gates.facts.status = 'unknown';
    expect(selectRepresentativeTrial(input).candidates[0].exclusion).toBe('gate-failed');
  });

  it('allows an explicit preference tradeoff only after all gates pass', () => {
    const input = trial([variant('a', [1, 3, 2, 2])]);
    input.userChoice = 'a';
    expect(selectRepresentativeTrial(input)).toMatchObject({
      selectedId: 'a',
      reason: 'user-selected',
    });
    input.userChoice = 'baseline';
    expect(selectRepresentativeTrial(input)).toMatchObject({
      selectedId: 'baseline',
      reason: 'user-kept-baseline',
    });
  });

  it('honors rejection even for an otherwise winning candidate', () => {
    const input = trial([variant('a', [4, 4, 4, 4])]);
    input.rejectedCandidateIds = ['a'];
    expect(selectRepresentativeTrial(input)).toMatchObject({
      selectedId: 'baseline',
      candidates: [{ exclusion: 'user-rejected' }],
    });
  });

  it.each(['failed', 'cancelled'] as const)(
    'treats %s runs as incomplete, not quality failures',
    (status) => {
      const input = trial();
      input.candidates[0].status = status;
      expect(selectRepresentativeTrial(input).candidates[0].exclusion).toBe('incomplete');
    },
  );

  it('requires comparable evidence from both the original and candidate', () => {
    const input = trial([variant('a', [4, 4, 4, 4])]);
    delete input.candidates[0].evaluation;
    expect(selectRepresentativeTrial(input).candidates[0].exclusion).toBe('missing-evidence');
    input.candidates = [variant('a', [4, 4, 4, 4])];
    delete input.baseline.evaluation;
    expect(selectRepresentativeTrial(input)).toMatchObject({
      selectedId: 'baseline',
      reason: 'baseline-unverified',
    });
  });

  it('does not certify an invalid original or let an explicit choice bypass its missing checks', () => {
    const input = trial([variant('a', [4, 4, 4, 4])]);
    input.baseline.evaluation!.gates.render.status = 'failed';
    input.userChoice = 'a';
    expect(selectRepresentativeTrial(input)).toMatchObject({
      selectedId: 'baseline',
      reason: 'baseline-unverified',
      candidates: [{ improvesBaseline: false }],
    });
  });

  it('refuses comparison across frozen configurations or evaluator versions', () => {
    const input = trial([variant('a', [4, 4, 4, 4]), variant('b', [4, 4, 4, 4])]);
    input.candidates[0].evaluation!.conditionFingerprint = 'c'.repeat(64);
    input.candidates[1].evaluation!.evaluatorVersion = 'different-model';
    expect(selectRepresentativeTrial(input)).toMatchObject({
      selectedId: 'baseline',
      candidates: [{ exclusion: 'condition-mismatch' }, { exclusion: 'evaluator-mismatch' }],
    });
    input.baseline.evaluation!.conditionFingerprint = 'c'.repeat(64);
    expect(selectRepresentativeTrial(input).reason).toBe('baseline-unverified');
  });

  it('rejects fabricated scores, blank evidence and missing pixel identities', () => {
    const input = trial();
    input.candidates[0].evaluation!.quality.readability.score = Number.NaN;
    expect(() => selectRepresentativeTrial(input)).toThrow();
    input.candidates[0] = variant('a');
    input.candidates[0].evaluation!.quality.readability.evidence = ' ';
    expect(() => selectRepresentativeTrial(input)).toThrow();
    input.candidates[0] = variant('a');
    input.candidates[0].evaluation!.artifact.sha256 = '';
    expect(() => selectRepresentativeTrial(input)).toThrow();
  });

  it('rejects duplicate IDs, baseline replacement, extra candidates and conflicting user decisions', () => {
    for (const candidates of [
      [variant('a'), variant('a')],
      [variant('baseline')],
      [variant('a'), variant('b'), variant('c')],
    ])
      expect(() => selectRepresentativeTrial(trial(candidates))).toThrow();
    const input = trial();
    input.userChoice = 'unknown';
    expect(() => selectRepresentativeTrial(input)).toThrow();
    input.userChoice = 'layout-a';
    input.rejectedCandidateIds = ['layout-a'];
    expect(() => selectRepresentativeTrial(input)).toThrow();
  });
});

describe('serial incumbent selection', () => {
  it.each([
    [3, 3, 3, 3],
    [2, 2, 2, 2],
    [4, 2, 3, 3],
  ])('retains the incumbent on equal, worse or tradeoff refinement %j', (...scores) => {
    const input = {
      ...trial([variant('incumbent', [3, 3, 3, 3]), variant('new', scores)]),
      incumbentId: 'incumbent',
    };
    expect(selectRepresentativeTrial(input)).toMatchObject({
      policyVersion: 2,
      selectedId: 'incumbent',
      reason: 'incumbent-retained',
    });
  });
  it('replaces the incumbent only on strict improvement within the same anonymous evaluation', () => {
    const input = {
      ...trial([variant('incumbent', [3, 3, 3, 3]), variant('new', [4, 3, 3, 3])]),
      incumbentId: 'incumbent',
    };
    expect(selectRepresentativeTrial(input)).toMatchObject({
      policyVersion: 2,
      selectedId: 'new',
      reason: 'incumbent-improved',
    });
    input.candidates[1].evaluation!.gates.visual.status = 'failed';
    expect(selectRepresentativeTrial(input).selectedId).toBe('incumbent');
    input.candidates[0].evaluation!.gates.visual.status = 'failed';
    expect(selectRepresentativeTrial(input).selectedId).toBe('baseline');
  });
  it('keeps older comparisons on policy version 1 and rejects fabricated incumbent identities', () => {
    expect(selectRepresentativeTrial(trial()).policyVersion).toBe(1);
    expect(() => selectRepresentativeTrial({ ...trial(), incumbentId: 'unknown' })).toThrow();
  });
});
