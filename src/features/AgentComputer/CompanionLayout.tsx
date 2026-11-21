import { type PropsWithChildren, type ReactNode } from 'react';

import { companionStyles as styles } from './companion.style';

/** The rail owns layout space. Absolute route layouts stay inside the content frame. */
export function CompanionLayout({ children, rail }: PropsWithChildren<{ rail?: ReactNode }>) {
  return (
    <div data-companion-layout className={styles.workspace}>
      <div data-companion-content className={styles.content}>
        {children}
      </div>
      {rail}
    </div>
  );
}
