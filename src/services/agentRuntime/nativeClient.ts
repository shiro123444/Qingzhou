import type { AgentStreamEvent } from '@lobechat/agent-gateway-client';
import { fetchEventSource } from '@lobechat/utils/client';

import { aiAgentService } from '@/services/aiAgent';

/** The existing remote-chat UI over same-origin SSE. Disconnecting only detaches the viewer. */
export class NativeStreamClient {
  private listeners = new Map<string, Set<(...args: any[]) => void>>();
  private controller?: AbortController;
  private retry?: ReturnType<typeof setTimeout>;
  private poll?: ReturnType<typeof setInterval>;
  private cursor = '0';
  private minimumStep = 0;
  private settled = false;
  private checking = false;
  constructor(private readonly operationId: string) {}
  on(event: string, listener: (...args: any[]) => void) {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
  }
  private emit(event: string, ...args: any[]) {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }
  connect() {
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    this.settled = false;
    this.emit('status_changed', 'connecting');
    const check = async () => {
      if (this.checking || controller.signal.aborted) return;
      this.checking = true;
      try {
        const snapshot = await aiAgentService.getOperationStatus(this.operationId);
        if (controller.signal.aborted || this.settled) return;
        if (!snapshot) {
          this.emit('auth_failed', 'Operation unavailable');
          this.disconnect();
          return;
        }
        const state = snapshot.currentState;
        if (
          ['done', 'error', 'interrupted', 'waiting_for_human'].includes(state.status) &&
          !snapshot.pendingIntervention
        ) {
          this.accept(
            {
              type: 'agent_runtime_end',
              data: { finalState: state, reason: state.status },
              operationId: this.operationId,
              stepIndex: state.stepCount,
              timestamp: Date.now(),
            },
            true,
          );
        }
        return state.stepCount;
      } finally {
        this.checking = false;
      }
    };
    const open = async () => {
      if (controller.signal.aborted || this.settled) return;
      try {
        const step = await check();
        if (step !== undefined) this.minimumStep = Math.max(this.minimumStep, step);
      } catch {
        /* A temporary status outage must not cancel the background operation. */
      }
      if (controller.signal.aborted || this.settled) return;
      await fetchEventSource(
        `/api/agent/stream?${new URLSearchParams({ operationId: this.operationId, lastEventId: this.cursor })}`,
        {
          signal: controller.signal,
          onopen: async (response) => {
            if ([401, 403, 404].includes(response.status)) {
              this.emit('auth_failed', 'Operation unavailable');
              this.disconnect();
              throw new Error('Native stream unavailable');
            }
            if (!response.ok) throw new Error('Native stream unavailable');
            this.emit('status_changed', 'connected');
          },
          onmessage: (message) => {
            if (controller.signal.aborted || this.settled) return;
            const event = JSON.parse(message.data);
            if (event.id && /^\d+-\d+$/.test(event.id)) this.cursor = event.id;
            if (event.type === 'connected' || event.type === 'heartbeat') return;
            this.accept(event);
          },
          onerror: () => {},
        },
      );
      if (!controller.signal.aborted && !this.settled) {
        this.emit('status_changed', 'reconnecting');
        this.retry = setTimeout(() => void open(), 1_000);
      }
    };
    clearInterval(this.poll);
    this.poll = setInterval(() => void check().catch(() => {}), 5_000);
    void open();
  }
  private accept(event: AgentStreamEvent, snapshot = false) {
    if (this.settled) return;
    if (!snapshot && event.stepIndex < this.minimumStep) return;
    if (
      !snapshot &&
      event.type === 'agent_runtime_end' &&
      event.data?.finalState?.status === 'waiting_for_human' &&
      event.data.finalState.stepCount <= this.minimumStep
    )
      return;
    this.emit('agent_event', event);
    if (event.type === 'agent_runtime_end') {
      this.settled = true;
      this.emit('session_complete');
      this.disconnect();
    }
  }
  disconnect() {
    this.controller?.abort();
    clearTimeout(this.retry);
    clearInterval(this.poll);
    this.emit('status_changed', 'disconnected');
    this.emit('disconnected');
  }
  async reconnect() {
    this.disconnect();
    this.connect();
  }
  sendInterrupt() {
    void aiAgentService
      .interruptTask({ operationId: this.operationId })
      .catch(() => console.error('[Native chat] Interrupt could not be delivered'));
  }
  sendToolResult() {
    return false;
  }
  updateToken() {} // Native streams use the authenticated application session.
}
