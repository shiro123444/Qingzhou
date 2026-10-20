import { createStaticStyles } from 'antd-style';

export const styles = createStaticStyles(({ css, cssVar }) => ({
  workspace: css`
    overflow: hidden;
    display: flex;
    flex: 1;
    flex-direction: column;

    width: 100%;
    min-width: 0;
    height: 100%;
    min-height: 0;

    color: ${cssVar.colorText};

    background: ${cssVar.colorBgContainer};

    @media (width <= 768px) {
      height: 100dvh;
    }
  `,
  workspaceHeader: css`
    gap: 12px;
    min-height: 52px;
    padding-inline: 16px;
    border-block-end: 1px solid ${cssVar.colorBorderSecondary};
  `,
  sidebar: css`
    display: flex;
    flex-direction: column;

    height: 100%;
    min-height: 0;
    padding-block: 2px 0;
  `,
  siteSwitcher: css`
    padding-block: 8px 4px;
    padding-inline: 8px;
  `,
  navItem: css`
    width: 100%;
    border: 0;
    font: inherit;
    text-align: start;

    &:focus-visible {
      outline: 2px solid ${cssVar.colorPrimary};
      outline-offset: 2px;
    }

    &[aria-disabled='true'] {
      cursor: default;
      opacity: 0.5;
    }
  `,
  search: css`
    padding-block: 8px;
    padding-inline: 12px;

    .ant-input-affix-wrapper {
      border-color: transparent;
      background: ${cssVar.colorFillTertiary};
    }
  `,
  sidebarFooter: css`
    flex: none;
    margin-block-start: auto;
    padding: 8px;
    border-block-start: 1px solid ${cssVar.colorBorderSecondary};
  `,
  scrollArea: css`
    scrollbar-gutter: stable;
    overflow: auto;
    flex: 1;
    min-height: 0;
  `,
  paper: css`
    width: 100%;
    max-width: 800px;
    margin-inline: auto;
    padding-block: 48px 72px;
    padding-inline: 40px;

    overflow-wrap: anywhere;

    &&& h2 {
      font-size: 24px;
      font-weight: 500;
      letter-spacing: -0.02em;
    }

    &&& h3 {
      font-size: 20px;
      font-weight: 500;
    }

    @media (width <= 768px) {
      padding-block: 32px 48px;
      padding-inline: 24px;
    }
  `,
  articleMeta: css`
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    align-items: center;

    margin-block-end: 22px;

    font-size: 12px;
    color: ${cssVar.colorTextDescription};
  `,
  state: css`
    margin-inline-start: auto;

    &[data-dirty='true'] {
      color: ${cssVar.colorWarning};
    }
  `,
  articleTitle: css`
    margin-block: 0 28px;
    margin-inline: 0;

    font-size: clamp(28px, 3vw, 36px);
    font-weight: 500;
    line-height: 1.4;
    letter-spacing: -0.03em;
  `,
  titleInput: css`
    height: auto;
    margin-block-end: 24px;
    padding: 0;
    border-radius: 0;

    font-size: clamp(28px, 3vw, 36px);
    font-weight: 500;
    line-height: 1.4;
    letter-spacing: -0.03em;

    &:focus {
      box-shadow: none;
    }
  `,
  bodyInput: css`
    resize: none;

    padding: 0;
    border-radius: 0;

    font-size: 16px;
    line-height: 1.9;

    &:focus {
      box-shadow: none;
    }
  `,
  composerDock: css`
    flex: none;

    width: 100%;
    max-width: 800px;
    margin-inline: auto;
    padding-block: 16px 0;
    padding-inline: 40px;

    @media (width <= 768px) {
      padding-inline: 20px;
    }
  `,
  composer: css`
    form {
      overflow: hidden;

      padding: 12px;
      border: 1px solid ${cssVar.colorBorder};
      border-radius: 16px;

      background: ${cssVar.colorBgContainer};

      transition: border-color 160ms ease;

      &:focus-within {
        border-color: ${cssVar.colorPrimaryBorder};
      }
    }

    textarea {
      padding: 4px;
      font-size: 14px;
      line-height: 1.6;
    }
  `,
  composerActions: css`
    display: flex;
    align-items: center;
    justify-content: space-between;

    margin-block-start: 12px;
    padding-inline-start: 4px;

    span {
      display: inline-flex;
      gap: 6px;
      align-items: center;
    }
  `,
  status: css`
    display: block;

    min-height: 24px;
    padding-block: 4px;

    font-size: 11px;
    color: ${cssVar.colorTextDescription};
    text-align: center;
  `,
  error: css`
    padding-block: 12px;
    padding-inline: 24px;
    font-size: 13px;
    color: ${cssVar.colorError};
  `,
  empty: css`
    display: flex;
    flex-direction: column;
    gap: 20px;
    align-items: center;
    justify-content: center;

    min-height: 100%;
    padding: 40px;

    h1 {
      margin: 0;
      font-size: 24px;
      font-weight: 500;
    }
  `,
  mobileToolbar: css`
    display: flex;
    justify-content: center;
    padding-block: 12px 0;
  `,
  mobileSidebar: css`
    height: min(70dvh, 540px);
  `,
  field: css`
    display: flex;
    flex-direction: column;
    gap: 8px;

    font-size: 13px;
    color: ${cssVar.colorTextSecondary};
  `,
  command: css`
    display: flex;
    gap: 12px;
    align-items: center;

    padding: 16px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 8px;

    background: ${cssVar.colorFillQuaternary};

    code {
      flex: 1;

      min-width: 0;

      font-size: 12px;
      line-height: 1.8;
      overflow-wrap: anywhere;
    }
  `,
  historyRow: css`
    display: flex;
    gap: 16px;
    align-items: center;
    justify-content: space-between;

    padding-block: 12px;
    padding-inline: 0;
    border-block-end: 1px solid ${cssVar.colorBorderSecondary};
  `,
  publicPage: css`
    overflow: auto;
    min-height: 100dvh;
    color: ${cssVar.colorText};
    background: ${cssVar.colorBgContainer};
  `,
  publicInner: css`
    max-width: 1000px;
    margin-inline: auto;
    padding-inline: 24px;
  `,
  publicHeader: css`
    display: flex;
    align-items: center;
    justify-content: space-between;

    padding-block: 24px;
    border-block-end: 1px solid ${cssVar.colorBorderSecondary};

    a {
      font-size: 14px;
      color: ${cssVar.colorTextSecondary};
      text-decoration: none;
    }

    a:first-child {
      font-weight: 500;
      color: ${cssVar.colorText};
    }

    a:hover {
      color: ${cssVar.colorPrimary};
    }
  `,
  blogTitle: css`
    max-width: 720px;
    margin-inline: auto;
    padding-block: 56px 40px;

    h1 {
      margin-block: 0 16px;
      margin-inline: 0;

      font-size: 36px;
      font-weight: 500;
      letter-spacing: -0.03em;
    }
  `,
  publicArticle: css`
    max-width: 720px;
    margin-inline: auto;
    padding-block: 32px 48px;
    border-block-start: 1px solid ${cssVar.colorBorderSecondary};

    overflow-wrap: anywhere;

    &&& h2 {
      margin-block: 0 24px;
      margin-inline: 0;
      font-size: 24px;
      font-weight: 500;
    }
  `,
}));
