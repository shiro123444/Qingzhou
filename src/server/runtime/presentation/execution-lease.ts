import { acquireAccountDataLease } from '../learning-lifecycle/files';
import { acquireFileExecutionLease, type FileExecutionLease } from '../file-lease';

export type PresentationExecutionLease = FileExecutionLease;

export async function acquirePresentationExecutionLease(
  filename: string,
  signal?: AbortSignal,
): Promise<PresentationExecutionLease | null> {
  const account = await acquireAccountDataLease(filename, signal);
  try {
    const lease = await acquireFileExecutionLease(filename, signal);
    if (!lease) {
      await account?.release();
      return null;
    }
    return {
      signal: AbortSignal.any([lease.signal, ...(account ? [account.signal] : [])]),
      release: async () => {
        try {
          await lease.release();
        } finally {
          await account?.release();
        }
      },
    };
  } catch (error) {
    await account?.release();
    throw error;
  }
}
