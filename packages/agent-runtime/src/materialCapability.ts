/** Serializable provider identity. Implementations and credentials remain in trusted Profiles. */
export interface SkillMaterialManifest {
  cancellation: 'cooperative';
  configurationSchema: { type: 'object'; additionalProperties: false };
  contractVersion: 1;
  effects: 'pure';
  id: string;
  implementationVersion: string;
  kind: 'skill-material';
  replay: 'deterministic';
  surfaces: ['context.skillMaterial'];
  usage: 'local-bytes';
}
export interface SkillMaterialBinding {
  configuration: Record<string, never>;
  manifest: SkillMaterialManifest;
}
export interface SkillMaterialReceipt {
  binding: SkillMaterialBinding;
  inputBytes: number;
  modelCalls: 0;
  outputBytes: number;
  sources: { identifier: string; inputDigest: string; outputDigest: string }[];
}
