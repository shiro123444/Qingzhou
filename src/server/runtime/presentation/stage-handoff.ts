import { designFingerprint } from './design-evidence';

type Stage =
  'compatibility' | 'diagnosis' | 'content' | 'storyboard' | 'image' | 'page' | 'review' | 'export';

export interface PresentationStageHandoff {
  readonly assetDigests?: Readonly<Record<string, string>>;
  readonly inputVersion: string;
  readonly outputVersion: string;
  readonly routeVersion?: string;
  readonly schemaVersion: 1;
  readonly stage: Stage;
  readonly subject: string;
}

export function presentationStageHandoff(
  stage: Stage,
  subject: string,
  inputVersion: string,
  output: unknown,
  routeVersion?: string,
  assetDigests?: Readonly<Record<string, string>>,
): PresentationStageHandoff {
  return {
    schemaVersion: 1,
    stage,
    subject,
    inputVersion,
    outputVersion: designFingerprint(output),
    ...(routeVersion ? { routeVersion } : {}),
    ...(assetDigests ? { assetDigests } : {}),
  };
}
