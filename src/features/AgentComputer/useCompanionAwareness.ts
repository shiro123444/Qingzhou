import { useMotionValue } from 'motion/react';
import { type RefObject, useEffect } from 'react';

import { useUiAttentionStore } from '@/store/uiAttention';
import { type AttentionArea, attentionAreaSchema } from '@/types/uiAttention';

export function attentionArea(
  target: EventTarget | null,
  pathname: string,
): AttentionArea | undefined {
  if (!(target instanceof Element) || target.closest('input[type="password"], [data-private]'))
    return;
  const tagged = attentionAreaSchema.safeParse(
    target.closest('[data-qz-attention]')?.getAttribute('data-qz-attention'),
  );
  if (tagged.success) return tagged.data;
  if (target.closest('[role="application"]')) return 'computer';
  if (target.closest('[contenteditable="true"], textarea'))
    return /^\/(?:page|resource)/.test(pathname) ? 'documents' : 'compose';
  const link = target.closest<HTMLAnchorElement>('a[href]');
  if (link && link.origin === location.origin) {
    const path = link.pathname;
    if (path.startsWith('/music')) return 'music';
    if (path.startsWith('/presentation')) return 'presentation';
    if (/^\/(?:page|resource)/.test(path)) return 'documents';
    if (/^\/(?:task|agent-tasks)/.test(path)) return 'tasks';
  }
  // Only classify the first-party workspace; never serialize route IDs or page text.
  if (target.closest('[data-companion-content]')) {
    if (pathname.startsWith('/music')) return 'music';
    if (pathname.startsWith('/presentation')) return 'presentation';
    if (/^\/(?:page|resource)/.test(pathname)) return 'documents';
    if (/^\/(?:task|agent-tasks)/.test(pathname)) return 'tasks';
    if (pathname === '/' || pathname.startsWith('/agent/')) return 'conversation';
  }
}

export function useCompanionAwareness({
  ownerId,
  agentId,
  avatar,
  enabled,
}: {
  ownerId: string;
  agentId: string;
  avatar: RefObject<HTMLSpanElement | null>;
  enabled: boolean;
}) {
  const x = useMotionValue(0),
    y = useMotionValue(0);
  useEffect(() => {
    useUiAttentionStore.setState({ ownerId, agentId, enabled, signal: undefined });
    let timer: ReturnType<typeof setTimeout> | undefined,
      candidate: AttentionArea | undefined,
      lastPublished = 0,
      candidateSince = 0;
    const publish = (area: AttentionArea | undefined, evidence: 'focus' | 'dwell') => {
      if (
        useUiAttentionStore.getState().ownerId !== ownerId ||
        useUiAttentionStore.getState().agentId !== agentId
      )
        return;
      lastPublished = Date.now();
      useUiAttentionStore.setState({
        signal: area ? { area, evidence, observedAt: lastPublished } : undefined,
      });
    };
    const reset = () => {
      clearTimeout(timer);
      candidate = undefined;
      x.set(0);
      y.set(0);
      publish(undefined, 'dwell');
    };
    const focus = (event: Event) => {
      const area = attentionArea(event.target, location.pathname);
      if (Date.now() - lastPublished > 1500 || useUiAttentionStore.getState().signal?.area !== area)
        publish(area, 'focus');
    };
    const move = (event: PointerEvent) => {
      if (event.pointerType === 'touch' || document.hidden) return;
      const box = avatar.current?.getBoundingClientRect();
      if (box) {
        x.set(
          Math.max(
            -1,
            Math.min(
              1,
              (event.clientX - box.left - box.width / 2) / Math.max(160, innerWidth * 0.45),
            ),
          ),
        );
        y.set(
          Math.max(
            -1,
            Math.min(
              1,
              (event.clientY - box.top - box.height / 2) / Math.max(160, innerHeight * 0.45),
            ),
          ),
        );
      }
      const next = attentionArea(event.target, location.pathname);
      if (next !== candidate) {
        clearTimeout(timer);
        candidate = next;
        candidateSince = Date.now();
        if (next) timer = setTimeout(() => publish(next, 'dwell'), 1200);
      } else if (next && Date.now() - candidateSince >= 1200 && Date.now() - lastPublished > 5000)
        publish(next, 'dwell');
    };
    const visibility = () => {
      if (document.hidden) reset();
    };
    if (enabled) {
      document.addEventListener('pointermove', move, { passive: true, capture: true });
      document.addEventListener('focusin', focus, true);
      document.addEventListener('input', focus, true);
      document.addEventListener('pointerleave', reset);
      document.addEventListener('visibilitychange', visibility);
      window.addEventListener('blur', reset);
      // Editors may autofocus before this lazy rail mounts. Recover semantic focus only.
      const focused = attentionArea(document.activeElement, location.pathname);
      if (focused) publish(focused, 'focus');
    } else reset();
    return () => {
      clearTimeout(timer);
      document.removeEventListener('pointermove', move, true);
      document.removeEventListener('focusin', focus, true);
      document.removeEventListener('input', focus, true);
      document.removeEventListener('pointerleave', reset);
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('blur', reset);
      x.set(0);
      y.set(0);
      if (
        useUiAttentionStore.getState().ownerId === ownerId &&
        useUiAttentionStore.getState().agentId === agentId
      )
        useUiAttentionStore.setState({ ownerId: undefined, agentId: undefined, signal: undefined });
    };
  }, [enabled, ownerId, agentId, avatar, x, y]);
  return { x, y };
}
