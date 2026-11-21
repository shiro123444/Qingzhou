import { createStaticStyles } from 'antd-style';

export const companionStyles = createStaticStyles(({ css, cssVar }) => ({
  workspace: css`
    position: relative;

    display: flex;
    flex: 1;

    width: 100%;
    min-width: 0;
    height: 100%;
    min-height: 0;

    @media (width <= 900px) {
      flex-direction: column;
    }
  `,
  content: css`
    position: relative;

    overflow: hidden;
    flex: 1;

    min-width: 0;
    min-height: 0;
  `,
  rail: css`
    position: relative;
    z-index: 12;

    display: flex;
    flex: none;
    flex-direction: column;

    overflow: hidden;
    align-self: flex-start;
    width: clamp(300px, 24vw, 364px);
    min-width: 0;
    height: calc(100% - 16px);
    margin-block: 8px;
    margin-inline: 0 8px;
    border-radius: 20px;

    color: ${cssVar.colorText};

    transition:
      width var(--qz-panel-resize),
      height var(--qz-panel-resize);

    &[data-collapsed='true'] {
      width: 52px;
      height: 76px;
    }

    @media (width <= 900px) {
      align-self: flex-end;
      width: calc(100% - 16px);
      height: min(55vh, 500px);
      margin-inline: 8px;

      &[data-collapsed='true'] {
        width: 76px;
        height: 48px;
      }
    }

    @media (prefers-reduced-motion: reduce) {
      transition: none;
    }
  `,
  topbar: css`
    display: flex;
    flex-direction: row-reverse;
    flex: none;
    align-items: center;
    justify-content: space-between;

    padding-block: 12px 0;
    padding-inline: 12px 20px;

    font-size: 11px;
    color: ${cssVar.colorTextTertiary};

    [data-collapsed='true'] & {
      position: absolute;
      z-index: 2;
      inset: 0;
      padding: 0;

      [data-panel-toggle] {
        inline-size: 100% !important;
        block-size: 100% !important;
        border-radius: inherit !important;
        align-items: center;
        justify-content: flex-end;
        padding-block-end: 5px;
        background: transparent;
        flex-direction: column;
      }

      @media (width <= 900px) {
        [data-panel-toggle] {
          flex-direction: row;
          justify-content: flex-end;
          padding-block: 0;
          padding-inline-end: 7px;
        }
      }
    }
  `,
  scroll: css`
    scrollbar-width: thin;

    overflow: auto;
    overscroll-behavior: contain;
    flex: 1;

    min-height: 0;
  `,
  identity: css`
    position: relative;

    display: flex;
    flex-direction: column;
    align-items: center;

    padding-block: 0 18px;
    padding-inline: 20px;

    [data-collapsed='true'] & {
      padding: 0;
      @media (width <= 900px) {
        align-items: flex-start;
      }
    }
  `,
  avatarButton: css`
    cursor: pointer;

    position: relative;

    display: block;

    padding: 0;
    border: 0;
    border-radius: 28px;

    color: inherit;

    background: transparent;

    &:focus-visible {
      outline: 2px solid ${cssVar.colorPrimary};
      outline-offset: 3px;
    }
  `,
  avatar: css`
    pointer-events: none;

    position: relative;

    display: grid;
    place-items: center;

    width: 250px;
    height: 216px;

    &::before {
      content: '';

      position: absolute;
      inset-block: 15% 5%;
      inset-inline: 10%;

      border-radius: 48%;

      background: radial-gradient(ellipse, #79ad9b20, transparent 70%);
    }

    &::after {
      content: '';

      position: absolute;
      inset-block-end: 19px;
      inset-inline: 24%;

      height: 13px;
      border-radius: 50%;

      background: #214a3820;
      filter: blur(8px);
    }

    > div {
      z-index: 1;
    }

    [data-collapsed='true'] & {
      width: 50px;
      height: 52px;
    }

    @media (width <= 900px) {
      width: 180px;
      height: 150px;

      [data-collapsed='true'] & {
        width: 46px;
        height: 46px;
      }
    }
  `,
  avatarHint: css`
    position: absolute;
    inset-block-end: 22px;
    inset-inline-end: 30px;

    display: grid;
    place-items: center;

    width: 28px;
    height: 28px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 10px;

    color: ${cssVar.colorTextSecondary};

    background: color-mix(in srgb, ${cssVar.colorBgElevated} 65%, transparent);
    backdrop-filter: blur(14px);

    [data-collapsed='true'] & {
      display: none;
    }
  `,
  name: css`
    margin: 0;

    font-size: 26px;
    font-weight: 550;
    line-height: 1.3;
    letter-spacing: -0.04em;
  `,
  presence: css`
    margin-block: 9px 0;
    margin-inline: 0;

    font-size: 12px;
    line-height: 1.5;
    color: ${cssVar.colorTextSecondary};
    text-align: center;

    &[data-state='approval'],
    &[data-state='unavailable'] {
      color: ${cssVar.colorWarningText};
    }
  `,
  computerEntry: css`
    cursor: pointer;

    display: flex;
    gap: 12px;
    align-items: center;

    width: calc(100% - 32px);
    margin-block: 0 18px;
    margin-inline: 16px;
    padding: 12px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 18px;

    color: inherit;
    text-align: start;

    background:
      linear-gradient(125deg, #80b49d14, transparent 80%),
      color-mix(in srgb, ${cssVar.colorBgElevated} 60%, transparent);
    box-shadow: inset 0 1px 0 #ffffff24;

    > span:nth-child(2) {
      display: grid;
      flex: 1;
      gap: 4px;
    }

    strong {
      font-size: 12px;
      font-weight: 550;
    }

    small {
      font-size: 10px;
      color: ${cssVar.colorTextTertiary};
    }

    &:hover {
      border-color: color-mix(in srgb, #78a38f 45%, ${cssVar.colorBorderSecondary});
    }

    &:focus-visible {
      outline: 2px solid ${cssVar.colorPrimary};
      outline-offset: 3px;
    }
  `,
  computerGlyph: css`
    display: grid;
    place-items: center;

    width: 38px;
    height: 38px;
    border-radius: 12px;

    color: color-mix(in srgb, #648d7b 65%, ${cssVar.colorText});

    background: linear-gradient(140deg, #accfbd30, #619d8d16);
    box-shadow: inset 0 1px 0 #ffffff30;
  `,
  tabs: css`
    display: flex;
    gap: 3px;

    margin-inline: 16px;
    padding: 4px;
    border-radius: 14px;

    background: ${cssVar.colorFillQuaternary};

    b {
      font-size: 10px;
      font-weight: 500;
    }

    > button {
      cursor: pointer;

      position: relative;

      display: flex;
      flex: 1;
      gap: 6px;
      align-items: center;
      justify-content: center;

      min-width: 0;
      height: 34px;
      padding-inline: 3px;
      border: 0;
      border-radius: 11px;

      font-size: 11px;
      color: ${cssVar.colorTextSecondary};

      background: transparent;

      > span:not(:first-child),
      > b {
        position: relative;
        z-index: 1;
      }

      &[aria-selected='true'] {
        color: ${cssVar.colorText};
      }

      &:focus-visible {
        outline: 2px solid ${cssVar.colorPrimary};
      }
    }
  `,
  tabPlate: css`
    pointer-events: none;

    position: absolute;
    inset: 0;

    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: inherit;

    background: color-mix(in srgb, ${cssVar.colorBgElevated} 82%, transparent);
    box-shadow:
      0 2px 8px #0000000a,
      inset 0 1px 0 #ffffff20;
  `,
  sections: css`
    display: flex;
    flex-direction: column;
    gap: 12px;

    padding-block: 16px 22px;
    padding-inline: 20px;

    a {
      color: inherit;
      text-decoration: none;
    }
  `,
  sectionHeading: css`
    display: flex;
    gap: 12px;
    align-items: center;
    justify-content: space-between;

    min-height: 22px;
    margin-block-start: 3px;

    h3 {
      margin: 0;
      font-size: 12px;
      font-weight: 550;
      color: ${cssVar.colorTextSecondary};
    }

    a {
      display: grid;
      place-items: center;

      width: 24px;
      height: 24px;

      color: ${cssVar.colorTextTertiary};
    }
  `,
  currentTask: css`
    display: flex;
    gap: 10px;
    align-items: center;

    padding-block: 13px;
    padding-inline: 10px;
    border-radius: 16px;

    background: color-mix(in srgb, #81af98 15%, ${cssVar.colorFillQuaternary});

    > span:nth-child(2) {
      display: grid;
      flex: 1;
      gap: 5px;
      min-width: 0;
    }

    strong {
      font-size: 12px;
      font-weight: 500;
      line-height: 1.4;
    }

    small {
      font-size: 10px;
      color: ${cssVar.colorTextTertiary};
    }
  `,
  taskIcon: css`
    display: grid;
    flex: none;
    place-items: center;

    width: 36px;
    height: 36px;
    border-radius: 11px;

    color: color-mix(in srgb, #719c85 70%, ${cssVar.colorText});

    background: #77a69112;
  `,
  taskList: css`
    display: grid;
    gap: 6px;

    > a {
      display: flex;
      gap: 10px;
      align-items: center;

      padding: 8px;
      border-radius: 14px;

      background: ${cssVar.colorFillQuaternary};
    }

    > a > span:last-child {
      display: grid;
      gap: 5px;
      min-width: 0;
    }

    strong {
      overflow: hidden;

      font-size: 12px;
      font-weight: 500;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    small {
      font-size: 10px;
      color: ${cssVar.colorTextTertiary};
    }

    > a:hover {
      background: ${cssVar.colorFillTertiary};
    }
  `,
  emptyTask: css`
    display: flex;
    gap: 10px;
    align-items: center;

    min-height: 52px;
    padding-inline: 12px;
    border: 1px dashed ${cssVar.colorBorderSecondary};
    border-radius: 14px;

    font-size: 12px;
    color: ${cssVar.colorTextSecondary} !important;
  `,
  quiet: css`
    margin: 0;
    padding-block: 4px 10px;

    font-size: 11px;
    line-height: 1.6;
    color: ${cssVar.colorTextTertiary};
  `,
  history: css`
    display: grid;
    gap: 14px;

    margin: 0;
    padding-block: 3px 0;
    padding-inline: 0;

    list-style: none;

    li {
      display: flex;
      gap: 10px;
      align-items: center;
    }

    li > span:nth-child(2) {
      display: grid;
      flex: 1;
      gap: 4px;
      min-width: 0;
    }

    strong {
      font-size: 12px;
      font-weight: 450;
    }

    small,
    time {
      font-size: 10px;
      color: ${cssVar.colorTextTertiary};
    }

    time {
      align-self: flex-start;
      margin-block-start: 3px;
    }
  `,
  receiptIcon: css`
    display: grid;
    flex: none;
    place-items: center;

    width: 30px;
    height: 32px;
    border-radius: 10px;

    color: ${cssVar.colorTextSecondary};

    background: ${cssVar.colorFillQuaternary};

    &[data-uncertain='true'] {
      color: ${cssVar.colorWarningText};
    }
  `,
  reviewPanel: css`
    display: grid;
    gap: 12px;
  `,
  reviewCard: css`
    cursor: pointer;

    display: grid;
    gap: 12px;
    justify-items: start;

    width: 100%;
    padding: 18px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 18px;

    color: inherit;
    text-align: start;

    background: color-mix(in srgb, #c2ae7e 9%, ${cssVar.colorFillQuaternary});

    strong {
      font-size: 13px;
      font-weight: 500;
    }

    > span:last-child {
      font-size: 11px;
      color: ${cssVar.colorTextSecondary};
    }
  `,
  calmState: css`
    display: grid;
    gap: 14px;
    justify-items: start;
    padding-block: 18px;

    > span {
      color: ${cssVar.colorTextTertiary};
    }

    strong {
      font-size: 14px;
      font-weight: 500;
    }

    p {
      margin: 0;
      font-size: 11px;
      line-height: 1.7;
      color: ${cssVar.colorTextTertiary};
    }
  `,
  senses: css`
    display: grid;
    gap: 14px;
  `,
  senseToggle: css`
    cursor: pointer;

    display: flex;
    gap: 12px;
    align-items: center;

    width: 100%;
    padding-block: 12px;
    padding-inline: 0;
    border: 0;

    color: inherit;
    text-align: start;

    background: transparent;

    > span:nth-child(2) {
      display: grid;
      flex: 1;
      gap: 5px;
    }

    strong {
      font-size: 12px;
      font-weight: 500;
    }

    small {
      font-size: 10px;
      color: ${cssVar.colorTextTertiary};
    }

    &:focus-visible {
      outline: 2px solid ${cssVar.colorPrimary};
      outline-offset: 3px;
    }
  `,
  switch: css`
    display: inline-flex;
    align-items: center;

    width: 32px;
    height: 20px;
    padding: 3px;
    border-radius: 7px;

    background: ${cssVar.colorFillSecondary};

    transition: background 200ms;

    i {
      width: 14px;
      height: 14px;
      border-radius: 4px;

      background: ${cssVar.colorBgElevated};
      box-shadow: 0 1px 3px #00000020;

      transition: transform 200ms;
    }

    &[data-on='true'] {
      background: #729b87;

      i {
        transform: translateX(12px);
      }
    }

    [dir='rtl'] &[data-on='true'] i {
      transform: translateX(-12px);
    }

    @media (prefers-reduced-motion: reduce) {
      &,
      i {
        transition: none;
      }
    }
  `,
  senseHelp: css`
    margin: 0;
    font-size: 11px;
    line-height: 1.7;
    color: ${cssVar.colorTextTertiary};
  `,
  attention: css`
    display: grid;
    gap: 7px;

    padding: 14px;
    border-radius: 14px;

    background: ${cssVar.colorFillQuaternary};

    > span {
      font-size: 10px;
      color: ${cssVar.colorTextTertiary};
    }

    strong {
      font-size: 12px;
      font-weight: 500;
    }
  `,
  attentionStrip: css`
    display: flex;
    flex: none;
    gap: 8px;
    align-items: center;

    min-height: 40px;
    margin-inline: 20px;
    padding-block: 10px;
    border-block-start: 1px solid ${cssVar.colorBorderSecondary};

    font-size: 11px;
    color: ${cssVar.colorTextSecondary};
  `,
}));
