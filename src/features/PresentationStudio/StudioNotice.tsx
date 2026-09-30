import { memo, type ReactNode, useEffect, useRef, useState } from 'react';

import { styles } from './style';

export type StudioNoticeTone = 'error' | 'success' | 'warning';

export interface StudioNoticeProps {
  action?: ReactNode;
  description?: ReactNode;
  durationMs?: number;
  onClose: () => void;
  /** A new notification restarts its lifetime even when its type/file is unchanged. */
  resetKey?: object | string | number;
  role?: 'alert' | 'status';
  testId: string;
  title: ReactNode;
  tone: StudioNoticeTone;
}

const DEFAULT_DURATION: Record<StudioNoticeTone, number> = {
  error: 8000,
  success: 5000,
  warning: 8000,
};

export const StudioNotice = memo<StudioNoticeProps>(
  ({ action, description, durationMs, onClose, resetKey, role, testId, title, tone }) => {
    const timeout = durationMs ?? DEFAULT_DURATION[tone];
    const onCloseRef = useRef(onClose);
    const [elapsed, setElapsed] = useState(false);
    onCloseRef.current = onClose;

    useEffect(() => {
      setElapsed(false);
      const frame = window.requestAnimationFrame(() => setElapsed(true));
      const id = window.setTimeout(() => onCloseRef.current(), timeout);
      return () => {
        window.cancelAnimationFrame(frame);
        window.clearTimeout(id);
      };
    }, [timeout, resetKey]);

    return (
      <div
        data-testid={testId}
        role={role ?? (tone === 'success' ? 'status' : 'alert')}
        className={`${styles.notice} ${
          tone === 'success'
            ? styles.noticeSuccess
            : tone === 'warning'
              ? styles.noticeWarning
              : styles.noticeError
        }`}
      >
        <span
          aria-hidden
          className={styles.noticeTimer}
          style={{
            transform: elapsed ? 'scaleX(0)' : 'scaleX(1)',
            transitionDuration: `${timeout}ms`,
          }}
        />
        <button
          aria-label="Close notice"
          className={styles.noticeClose}
          type="button"
          onClick={onClose}
        >
          ×
        </button>
        <div className={styles.noticeTitle}>{title}</div>
        {description ? <div className={styles.noticeDescription}>{description}</div> : null}
        {action ? <div className={styles.noticeAction}>{action}</div> : null}
      </div>
    );
  },
);

StudioNotice.displayName = 'StudioNotice';
