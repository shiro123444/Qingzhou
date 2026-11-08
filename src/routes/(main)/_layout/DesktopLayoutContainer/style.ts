import { createStaticStyles } from 'antd-style';

export const styles = createStaticStyles(({ css, cssVar }) => ({
  // Inner container
  innerContainer: css`
    position: relative;

    overflow: hidden;

    border: 1px solid var(--qz-glass-border, var(--container-border-color, ${cssVar.colorBorder}));
    border-radius: var(--container-border-radius, ${cssVar.borderRadius});

    background: transparent;
  `,

  // Outer container
  outerContainer: css`
    position: relative;

    overflow: hidden;

    padding-block-start: var(--container-padding-top, 8px);
    padding-inline-start: var(--container-padding-left, 8px);

    background: transparent;
  `,
}));
