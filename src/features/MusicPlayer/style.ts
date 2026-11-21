import { createStaticStyles } from 'antd-style';

export const styles = createStaticStyles(({ css, cssVar }) => ({
  floatingLayer: css`
    pointer-events: none;
    position: fixed;

    /* Above workspace editors; standard menus and modal dialogs retain their own layer. */
    z-index: calc(${cssVar.zIndexPopupBase} - 100);
    inset: 0;
  `,
  shell: css`
    position: relative;

    display: flex;
    flex: 1;
    flex-direction: column;

    min-width: 0;
    height: 100%;
    min-height: 0;
  `,
  content: css`
    position: relative;

    overflow: hidden;
    display: flex;
    flex: 1;
    flex-direction: column;

    min-width: 0;
    min-height: 0;
  `,
}));
