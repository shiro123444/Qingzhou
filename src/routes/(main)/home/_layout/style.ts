import { createStaticStyles } from 'antd-style';

export const styles = createStaticStyles(({ css }) => ({
  // Absolutely positioned container, fills parent
  absoluteContainer: css`
    position: absolute;
    inset: 0;
  `,

  // Content area - dark mode
  contentDark: css`
    overflow: hidden;
    background: transparent;
  `,

  // Content area - light mode
  contentLight: css`
    overflow: hidden;
    background: transparent;
  `,
}));
