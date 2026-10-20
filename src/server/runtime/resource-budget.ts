export type ServerProfile = '4c4g' | '8c8g';

export interface ResourceBudget {
  assetConcurrency: number;
  assetQueue: number;
  generationConcurrency: number;
  generationQueue: number;
  profile: ServerProfile;
}

/** Host configuration, never an operation argument or model-controlled value. */
export function getResourceBudget(
  profile = process.env.QINGZHOU_SERVER_PROFILE ?? '4c4g',
): ResourceBudget {
  if (profile === '4c4g')
    return {
      profile,
      assetConcurrency: 1,
      assetQueue: 16,
      generationConcurrency: 1,
      generationQueue: 4,
    };
  if (profile === '8c8g')
    return {
      profile,
      assetConcurrency: 2,
      assetQueue: 32,
      generationConcurrency: 1,
      generationQueue: 8,
    };
  throw new Error('QINGZHOU_SERVER_PROFILE must be 4c4g or 8c8g');
}
