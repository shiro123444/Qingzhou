import { createStaticStyles } from 'antd-style';

export const textStyles = createStaticStyles(({ css, cssVar }) => ({
  wave: css`
    display: inline;
    font-weight: var(--wave-weight, 450);

    [data-wave-letter] {
      display: inline-block;
      white-space: pre;
    }
  `,
  waveRun: css`
    display: inline-block;
    white-space: pre;
  `,
  accessible: css`
    position: absolute;

    overflow: hidden;

    width: 1px;
    height: 1px;
    padding: 0;
    border: 0;

    white-space: nowrap;

    clip-path: inset(50%);
  `,
  readingRoot: css`
    isolation: isolate;
    position: relative;
  `,
  readingPill: css`
    pointer-events: none;

    position: absolute;
    z-index: -1;
    inset-block-start: 0;
    inset-inline-start: 0;

    border-radius: 0.34em;

    opacity: 0;
    background: color-mix(in srgb, ${cssVar.colorText} 10%, transparent);
  `,
}));
