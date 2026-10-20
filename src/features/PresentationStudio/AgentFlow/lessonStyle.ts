import { createStaticStyles } from 'antd-style';

export const lessonStyles = createStaticStyles(({ css, cssVar }) => ({
  workspace: css`
    width: 100%;
    max-width: 1120px;
    margin: auto;
    padding-block: 16px 32px;
  `,
  intro: css`
    margin: 0;
    font-size: 22px;
    font-weight: 500;
    color: ${cssVar.colorText};
  `,
  muted: css`
    font-size: 13px;
    line-height: 1.7;
    color: ${cssVar.colorTextSecondary};
  `,
  composer: css`
    position: sticky;
    z-index: 2;
    inset-block-end: 12px;

    padding: 14px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 20px;

    background: ${cssVar.colorBgContainer};
  `,
  timeline: css`
    display: flex;
    flex-direction: column;
    gap: 28px;
    padding-block: 20px;
  `,
  beat: css`
    padding-inline-start: 18px;
    border-inline-start: 2px solid ${cssVar.colorBorderSecondary};
  `,
  beatTitle: css`
    cursor: pointer;

    padding: 0;
    border: 0;

    font-size: 17px;
    color: ${cssVar.colorText};
    text-align: start;

    background: none;

    &:focus-visible {
      outline: 2px solid ${cssVar.colorPrimary};
    }
  `,
  frames: css`
    overflow-x: auto;
    display: flex;
    gap: 10px;
    padding-block: 12px;
  `,
  frame: css`
    cursor: pointer;

    flex: 0 0 210px;

    min-height: 118px;
    padding: 14px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 12px;

    color: ${cssVar.colorText};
    text-align: start;

    background: ${cssVar.colorBgContainer};

    &[aria-pressed='true'] {
      border-color: ${cssVar.colorPrimary};
      background: ${cssVar.colorPrimaryBg};
    }

    &:focus-visible {
      outline: 2px solid ${cssVar.colorPrimary};
    }
  `,
  frameTitle: css`
    display: block;
    margin-block: 8px;
    font-size: 15px;
    line-height: 1.5;
  `,
  preview: css`
    padding-block: 12px;
    line-height: 1.8;
    color: ${cssVar.colorText};
  `,
  changes: css`
    padding-block: 12px;
    padding-inline: 0;
    border-block: 1px solid ${cssVar.colorBorderSecondary};
  `,
}));
