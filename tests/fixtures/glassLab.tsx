/** Deterministic live backdrop for pixel-level optical checks; never shipped as a product route. */
import { createStaticStyles } from 'antd-style';

const styles = createStaticStyles(({ css }) => ({
  glass: css`
    background: var(--qz-glass-surface);
    backdrop-filter: var(--qz-glass-filter);
  `,
}));

export default function GlassLab() {
  return (
    <div
      data-glass-lab
      style={{
        position: 'relative',
        width: 560,
        height: 300,
        background: 'repeating-linear-gradient(90deg, #16b8cb 0 8px, #ef665c 8px 16px)',
      }}
    >
      <div
        data-glass-probe
        className={styles.glass}
        data-qz-glass="capsule"
        style={{
          position: 'absolute',
          left: 100,
          top: 80,
          width: 320,
          height: 100,
          borderRadius: 50,
        }}
      >
        <span
          data-glass-foreground
          style={{
            position: 'absolute',
            left: 140,
            top: 3,
            width: 40,
            height: 6,
            background: '#5518ce',
          }}
        />
      </div>
    </div>
  );
}
