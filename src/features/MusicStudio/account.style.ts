import { createStaticStyles } from 'antd-style';

export const styles = createStaticStyles(({ css, cssVar }) => ({
  entry: css`
    max-width: 180px;
    color: ${cssVar.colorTextSecondary};

    > span:last-child {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
  `,
  body: css`
    display: flex;
    flex-direction: column;
    gap: 14px;
    align-items: center;

    padding-block: 18px 12px;

    text-align: center;

    h3 {
      margin: 0;
      font-size: 18px;
      font-weight: 600;
    }

    p {
      max-width: 290px;
      margin: 0;

      font-size: 13px;
      line-height: 1.7;
      color: ${cssVar.colorTextSecondary};
    }
  `,
  qr: css`
    display: grid;
    flex: none;
    place-items: center;

    box-sizing: border-box;
    width: 244px;
    height: 244px;
    padding: 14px;
    border: 1px solid rgb(0 0 0 / 6%);
    border-radius: 20px;

    color: #54565a;

    background: #fff;
    box-shadow: 0 4px 24px rgb(0 0 0 / 6%);
  `,
  accountIcon: css`
    display: grid;
    place-items: center;

    width: 64px;
    height: 64px;
    border: 1px solid var(--qz-glass-border);
    border-radius: 50%;

    color: var(--music-accent);

    background: var(--qz-glass-surface);
  `,
  error: css`
    color: ${cssVar.colorError} !important;
  `,
}));
