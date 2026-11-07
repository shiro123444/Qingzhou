import { createStaticStyles } from 'antd-style';

export const styles = createStaticStyles(({ css }) => ({
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
