import type { ComputerView } from '@/types/agentComputer';

export type CompanionState =
  'idle' | 'working' | 'thinking' | 'queued' | 'approval' | 'human' | 'sleeping' | 'unavailable';
export function companionState(view: ComputerView | undefined, failed = false): CompanionState {
  if (failed || !view?.enabled || view.bindingChanged || view.session?.state === 'unknown')
    return 'unavailable';
  if (view.session?.control === 'human') return 'human';
  if (view.activity?.phase === 'approval') return 'approval';
  if (
    view.activity?.phase === 'working' ||
    (view.session?.busy &&
      view.commands.some((c) => c.actor === 'agent' && c.status === 'dispatched'))
  )
    return 'working';
  if (view.botActivity)
    return view.botActivity.phase === 'working' ? 'thinking' : view.botActivity.phase;
  if (view.session?.state === 'sleeping') return 'sleeping';
  return 'idle';
}
