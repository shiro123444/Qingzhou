import { createStaticStyles } from 'antd-style';

export const styles = createStaticStyles(({ css, cssVar }) => ({
  form: css`
    display: flex;
    flex-direction: column;
    gap: 12px;
  `,
  body: css`
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 16px;

    padding: 20px;
  `,
  filters: css`
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  `,
  list: css`
    display: flex;
    flex-direction: column;
    gap: 12px;

    margin: 0;
    padding: 0;

    list-style: none;
  `,
  card: css`
    display: flex;
    flex-direction: column;
    gap: 10px;

    padding: 16px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 16px;

    background: ${cssVar.colorBgContainer};
  `,
  heading: css`
    display: flex;
    gap: 12px;
    align-items: center;
    justify-content: space-between;
  `,
  title: css`
    margin: 0;
    font-size: 14px;
    font-weight: 600;
    overflow-wrap: anywhere;
  `,
  detail: css`
    margin: 0;

    font-size: 12px;
    line-height: 1.7;
    color: ${cssVar.colorTextSecondary};
    overflow-wrap: anywhere;
    white-space: pre-wrap;
  `,
  actions: css`
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    align-items: center;
  `,
}));
