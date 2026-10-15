import type { PresentationJob } from '../../../packages/runtime-contracts/src';
import CollaborationControls from './CollaborationControls';
import type { PresentationStudioStoreHook } from './store/presentationStore';

export default function CollaborationPanel({
  job,
  store,
  tabId,
}: {
  job: PresentationJob;
  store: PresentationStudioStoreHook;
  tabId: string;
}) {
  const pending = store((s) => s.pendingActions[job.jobId] === 'decision');
  return (
    <CollaborationControls
      collaboration={job.collaboration}
      pending={pending}
      state={job.state}
      taskId={job.jobId}
      onAnswer={(input) => store.getState().answerDecision(job.jobId, input)}
      onMode={(mode) =>
        store.getState().updatePresence(job.jobId, {
          tabId,
          mode,
          visible: document.visibilityState === 'visible',
          focused: document.hasFocus(),
        })
      }
    />
  );
}
