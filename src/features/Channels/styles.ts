import { createStaticStyles } from 'antd-style';

export const styles = createStaticStyles(({ css, cssVar }) => ({
  actions: css`
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
  `,
  content: css`
    width: 100%;
    max-width: 1200px;
    margin-inline: auto;
    padding: 24px 32px 48px;
    @media (width <= 720px) {
      padding: 16px;
    }
  `,
  grid: css`
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 16px;
    @media (width <= 900px) {
      grid-template-columns: 1fr;
    }
  `,
  header: css`
    display: flex;
    flex-wrap: wrap;
    gap: 16px;
    align-items: center;
    justify-content: space-between;
    margin-block: 20px 24px;
  `,
  link: css`
    color: inherit;
    text-decoration: none;
  `,
  main: css`
    position: relative;
    overflow: hidden auto;
    flex: 1;
    min-width: 0;
    height: 100%;
    background: ${cssVar.colorBgContainer};
  `,
  muted: css`
    color: ${cssVar.colorTextDescription};
    font-size: 12px;
  `,
  panel: css`
    padding: 20px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadiusLG};
  `,
  section: css`
    margin-block-start: 24px;
  `,
  stat: css`
    font-size: 28px;
    font-weight: 600;
    line-height: 1.3;
  `,
  title: css`
    margin: 0;
    color: ${cssVar.colorText};
    font-size: 22px;
    font-weight: 600;
    line-height: 1.4;
  `,
}));
