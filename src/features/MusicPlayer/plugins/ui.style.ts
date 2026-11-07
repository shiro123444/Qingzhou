import { createStaticStyles } from 'antd-style';

export const styles = createStaticStyles(({ css, cssVar }) => ({
  lyrics: css`
    scrollbar-width: none;

    position: absolute;
    inset-block: 12px 0;
    inset-inline: 0;

    overflow: auto;
    overscroll-behavior: contain;

    box-sizing: border-box;
    padding-block: 100px 180px;
    padding-inline: 16px;

    text-align: center;

    mask-image: linear-gradient(transparent, #000 12%, #000 84%, transparent);

    &::-webkit-scrollbar {
      display: none;
    }

    &[data-empty='true'] {
      display: grid;
      place-items: center;
      padding-block: 50px;
    }

    p {
      scroll-margin-block: 100px;

      margin-block: 0 34px;
      margin-inline: 0;

      font-size: clamp(22px, 2.3vw, 34px);
      font-weight: 500;
      line-height: 1.7;
      color: ${cssVar.colorTextSecondary};
      overflow-wrap: anywhere;

      transition: color 0.3s ease;

      &[aria-current='true'] {
        color: var(--music-accent);
      }
    }

    p > button {
      cursor: pointer;

      width: 100%;
      padding: 0;
      border: 0;

      font: inherit;
      color: inherit;

      background: transparent;

      &:hover {
        color: ${cssVar.colorText};
      }
    }

    @container (width <= 680px) {
      padding-block: 70px 100px;
      padding-inline: 0;

      p {
        margin-block-end: 24px;
        font-size: 23px;
      }
    }

    @media (prefers-reduced-motion: reduce) {
      p {
        transition: none;
      }
    }
  `,
  emptyLyrics: css`
    max-width: 340px;

    p {
      margin-block-end: 18px;
      font-size: clamp(22px, 2.3vw, 32px);
      font-weight: 400;
      color: ${cssVar.colorTextSecondary};
    }

    span {
      display: block;
      font-size: 13px;
      line-height: 1.9;
      color: ${cssVar.colorTextSecondary};
    }
  `,
  settings: css`
    width: 100%;
    max-width: 1040px;
    margin-inline: auto;
    padding-block: 46px 30px;

    @container (width <= 680px) {
      padding-block-start: 30px;
    }
  `,
  heading: css`
    margin: 0;
    font-size: 24px;
    font-weight: 600;
  `,
  plugin: css`
    margin-block-start: 24px;
    padding: 24px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 16px;

    background: color-mix(in srgb, ${cssVar.colorBgContainer} 88%, transparent);

    @container (width <= 600px) {
      padding: 18px;
    }
  `,
  pluginOverview: css`
    display: flex;
    gap: 18px;
    align-items: center;

    @container (width <= 600px) {
      flex-wrap: wrap;
      gap: 14px;
    }
  `,
  pluginIcon: css`
    display: grid;
    flex: none;
    place-items: center;

    width: 48px;
    height: 48px;
    border-radius: 12px;

    color: var(--music-accent);

    background: var(--music-accent-soft);
  `,
  pluginInfo: css`
    flex: 1;
    min-width: 0;

    p {
      margin-block: 7px 0;
      margin-inline: 0;

      font-size: 13px;
      line-height: 1.7;
      color: ${cssVar.colorTextSecondary};
    }
  `,
  pluginTitle: css`
    display: flex;
    gap: 12px;
    align-items: baseline;

    h3 {
      margin: 0;
      font-size: 16px;
      font-weight: 600;
    }

    span {
      padding-block: 2px;
      padding-inline: 7px;
      border-radius: 6px;

      font-size: 11px;
      line-height: 1.6;
      color: ${cssVar.colorTextSecondary};

      background: ${cssVar.colorFillTertiary};
    }
  `,
  pluginControls: css`
    display: flex;
    flex: none;
    gap: 14px;
    align-items: center;

    @container (width <= 600px) {
      justify-content: flex-end;
      width: 100%;
    }
  `,
  pluginStatus: css`
    display: inline-flex;
    gap: 6px;
    align-items: center;

    font-size: 12px;
    color: ${cssVar.colorTextTertiary};

    &::before {
      content: '';

      width: 5px;
      height: 5px;
      border-radius: 50%;

      background: currentcolor;
    }

    &[data-status='enabled'] {
      color: var(--music-accent);
    }

    &[data-status='error'] {
      color: ${cssVar.colorError};
    }
  `,
  permissions: css`
    margin-block-start: 22px;
    margin-inline-start: 66px;
    padding-block-start: 20px;
    border-block-start: 1px solid ${cssVar.colorBorderSecondary};

    h4 {
      margin-block: 0 12px;
      margin-inline: 0;

      font-size: 12px;
      font-weight: 500;
      color: ${cssVar.colorTextSecondary};
    }

    @container (width <= 600px) {
      margin-inline-start: 0;
    }
  `,
  permissionList: css`
    display: flex;
    flex-direction: column;
    gap: 10px;

    margin: 0;
    padding: 0;

    list-style: none;

    li {
      display: flex;
      gap: 10px;
      align-items: center;

      font-size: 12px;
      line-height: 1.7;
      color: ${cssVar.colorTextSecondary};
    }

    svg {
      flex: none;
    }
  `,
  pluginError: css`
    display: flex;
    gap: 14px;
    align-items: center;

    margin-block-start: 20px;
    margin-inline-start: 66px;

    font-size: 12px;
    line-height: 1.7;
    color: ${cssVar.colorError};

    @container (width <= 600px) {
      flex-wrap: wrap;
      margin-inline-start: 0;
    }
  `,
  pluginWarning: css`
    margin-block: 20px 0;
    margin-inline: 66px 0;

    font-size: 12px;
    line-height: 1.7;
    color: ${cssVar.colorWarning};

    @container (width <= 600px) {
      margin-inline-start: 0;
    }
  `,
  emptyAction: css`
    cursor: pointer;

    margin-block-start: 20px;
    padding-block: 8px;
    padding-inline: 14px;
    border: 1px solid ${cssVar.colorBorder};
    border-radius: 8px;

    font-size: 13px;
    color: ${cssVar.colorText};

    background: transparent;

    &:hover {
      background: ${cssVar.colorFillTertiary};
    }
  `,
}));
