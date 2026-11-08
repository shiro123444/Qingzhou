'use client';

import { useEffect, useRef, useState } from 'react';

import { musicAccountClient } from '@/services/music-account';
import { type MusicAccountStatus } from '@/types/music-account';

type Challenge = Awaited<ReturnType<typeof musicAccountClient.start>>;
type Phase = 'idle' | 'starting' | 'waiting' | 'scanned' | 'expired' | 'error';
interface ViewState {
  account?: MusicAccountStatus;
  busy: boolean;
  challenge?: Challenge;
  open: boolean;
  phase: Phase;
  userId: string | null;
}
interface Session {
  account?: MusicAccountStatus;
  challenge?: Challenge;
  controller?: AbortController;
  open: boolean;
  sequence: number;
  statusController?: AbortController;
  timer?: ReturnType<typeof setTimeout>;
  userId: string;
}
const initial = (userId: string | null): ViewState => ({
  busy: false,
  open: false,
  phase: 'idle',
  userId,
});

/** Owns one bounded QR attempt; late responses cannot bind a different Qingzhou account. */
export function useKugouAccount({
  onBeforeDisconnect,
  onChanged,
  userId,
}: {
  onBeforeDisconnect: () => void;
  onChanged: () => void;
  userId: string | null;
}) {
  const [view, setView] = useState<ViewState>(() => initial(userId));
  const current = useRef<Session | null>(null);
  const callbacks = useRef({ onBeforeDisconnect, onChanged });
  callbacks.current = { onBeforeDisconnect, onChanged };
  const identity = useRef(userId);
  identity.current = userId;

  const isCurrent = (session: Session, sequence = session.sequence) =>
    current.current === session &&
    identity.current === session.userId &&
    sequence === session.sequence;
  const patch = (session: Session, update: Partial<ViewState>) => {
    if (isCurrent(session))
      setView((previous) => ({ ...previous, ...update, userId: session.userId }));
  };
  const applyAccount = (session: Session, account: MusicAccountStatus, notify = false) => {
    if (!isCurrent(session)) return;
    const changed = session.account && session.account.revision !== account.revision;
    session.account = account;
    patch(session, { account });
    if (changed || notify) callbacks.current.onChanged();
  };
  const clearAttempt = (session: Session, remote: boolean, reconcile = false) => {
    clearTimeout(session.timer);
    session.controller?.abort();
    session.sequence++;
    const challenge = session.challenge;
    session.challenge = undefined;
    const sequence = session.sequence;
    if (remote && challenge)
      void musicAccountClient
        .cancel(challenge.challengeId)
        .then((account) => {
          // The server may have committed phone confirmation before close reached it.
          if (!reconcile || !isCurrent(session, sequence)) return;
          session.statusController?.abort();
          applyAccount(session, account, !session.account && account.state === 'connected');
        })
        .catch(() => undefined);
  };
  const refresh = async (session: Session) => {
    session.statusController?.abort();
    const controller = new AbortController();
    session.statusController = controller;
    const sequence = session.sequence;
    try {
      const account = await musicAccountClient.status(controller.signal);
      if (isCurrent(session, sequence) && !controller.signal.aborted)
        applyAccount(session, account);
    } catch {
      // A closed account entry must not interrupt music when its status cannot be refreshed.
      if (
        isCurrent(session, sequence) &&
        session.open &&
        !session.challenge &&
        !controller.signal.aborted
      )
        patch(session, { phase: 'error' });
    }
  };

  useEffect(() => {
    if (!userId) {
      current.current = null;
      setView(initial(null));
      return;
    }
    const session: Session = { open: false, sequence: 0, userId };
    current.current = session;
    setView(initial(userId));
    void refresh(session);
    const focus = () => void refresh(session);
    window.addEventListener('focus', focus);
    return () => {
      session.statusController?.abort();
      clearAttempt(session, true);
      if (current.current === session) current.current = null;
      window.removeEventListener('focus', focus);
    };
    // A session is replaced only when the authenticated Qingzhou account changes.
  }, [userId]);

  const start = async () => {
    const session = current.current;
    if (!session || !isCurrent(session)) return;
    clearAttempt(session, true);
    session.open = true;
    patch(session, { busy: false, challenge: undefined, open: true, phase: 'starting' });
    const sequence = session.sequence;
    const controller = new AbortController();
    session.controller = controller;
    try {
      const challenge = await musicAccountClient.start(controller.signal);
      if (!isCurrent(session, sequence) || controller.signal.aborted) return;
      session.challenge = challenge;
      patch(session, { challenge, phase: 'waiting' });
      const deadline = Math.min(challenge.expiresAt, Date.now() + 5 * 60_000);
      const schedule = (delay: number) => {
        session.timer = setTimeout(() => void poll(), Math.max(2000, Math.min(10_000, delay)));
      };
      const poll = async () => {
        if (!isCurrent(session, sequence) || !session.open || controller.signal.aborted) return;
        if (Date.now() >= deadline) {
          clearAttempt(session, true);
          patch(session, { challenge: undefined, phase: 'expired' });
          return;
        }
        try {
          const result = await musicAccountClient.poll(challenge.challengeId, controller.signal);
          if (!isCurrent(session, sequence) || controller.signal.aborted) return;
          if (result.state === 'connected' && result.account) {
            clearAttempt(session, false);
            applyAccount(session, result.account, true);
            patch(session, { challenge: undefined, phase: 'idle' });
          } else if (result.state === 'expired' || result.state === 'cancelled') {
            clearAttempt(session, false);
            patch(session, { challenge: undefined, phase: 'expired' });
          } else {
            patch(session, { phase: result.state === 'scanned' ? 'scanned' : 'waiting' });
            schedule(result.pollAfterMs);
          }
        } catch {
          if (isCurrent(session, sequence) && !controller.signal.aborted) {
            clearAttempt(session, true);
            patch(session, { challenge: undefined, phase: 'error' });
          }
        }
      };
      schedule(challenge.pollAfterMs);
    } catch {
      if (isCurrent(session, sequence) && !controller.signal.aborted)
        patch(session, { challenge: undefined, phase: 'error' });
    }
  };

  const show = () => {
    const session = current.current;
    if (!session || !isCurrent(session)) return;
    session.open = true;
    patch(session, { open: true, phase: 'idle' });
    if (session.account?.state === 'connected') void refresh(session);
    else void start();
  };
  const close = () => {
    const session = current.current;
    if (!session || !isCurrent(session)) return;
    session.open = false;
    clearAttempt(session, true, true);
    patch(session, { busy: false, challenge: undefined, open: false, phase: 'idle' });
  };
  const disconnect = async () => {
    const session = current.current;
    if (!session || !isCurrent(session)) return;
    clearAttempt(session, true);
    callbacks.current.onBeforeDisconnect();
    patch(session, { busy: true, challenge: undefined, phase: 'idle' });
    const sequence = session.sequence;
    const controller = new AbortController();
    session.controller = controller;
    try {
      const account = await musicAccountClient.disconnect(controller.signal);
      if (isCurrent(session, sequence) && !controller.signal.aborted)
        applyAccount(session, account, true);
    } catch {
      if (isCurrent(session, sequence) && !controller.signal.aborted)
        patch(session, { phase: 'error' });
    } finally {
      if (isCurrent(session, sequence)) patch(session, { busy: false });
    }
  };

  return { ...(view.userId === userId ? view : initial(userId)), close, disconnect, show, start };
}
