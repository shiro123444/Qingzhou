import { createStaticStyles } from 'antd-style';

export const { glassComposer } = createStaticStyles(({ css, cssVar }) => ({
  glassComposer: css`
    && {
      border: 1px solid var(--qz-glass-border);
      border-radius: 24px;

      background: var(--qz-glass-strong);
      backdrop-filter: var(--qz-glass-filter);
      box-shadow:
        inset 0 1px 0 var(--qz-glass-highlight),
        inset 0 -1px 0 color-mix(in srgb, ${cssVar.colorText} 5%, transparent),
        var(--qz-glass-shadow);
    }

    &:focus-within {
      border-color: color-mix(in srgb, var(--qz-glass-tint) 38%, var(--qz-glass-border));
    }
  `,
}));
