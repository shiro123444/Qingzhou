import { createStaticStyles, keyframes } from 'antd-style';

const frostBreathe = keyframes`
  0%,
  100% {
    opacity: 0.76;
  }

  50% {
    opacity: 0.9;
  }
`;

const paintReveal = keyframes`
  from {
    clip-path: inset(0 100% 0 0);
    opacity: 0.35;
  }

  to {
    clip-path: inset(0 0 0 0);
    opacity: 1;
  }
`;

export const styles = createStaticStyles(({ css, cssVar }) => ({
  historyPanel: css`
    overflow-y: auto;

    width: min(360px, calc(100vw - 32px));
    max-height: min(520px, calc(100vh - 96px));
    border-radius: 16px;

    box-shadow: ${cssVar.boxShadowSecondary};
  `,
  bentoCard: css`
    cursor: pointer;

    overflow: hidden;
    display: flex;
    flex-direction: column;
    gap: 8px;

    padding: 10px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 12px;

    background: ${cssVar.colorBgContainer};

    transition:
      transform 200ms ease,
      box-shadow 200ms ease,
      border-color 200ms ease;

    &:hover {
      transform: translateY(-2px);
      border-color: ${cssVar.colorBorder};
      box-shadow: 0 8px 24px rgb(0 0 0 / 12%);
    }
  `,
  bentoCardSelected: css`
    border-color: ${cssVar.colorPrimary} !important;
    box-shadow:
      0 0 0 2px ${cssVar.colorPrimaryBg},
      0 8px 24px rgb(0 0 0 / 12%) !important;
  `,
  bentoFrame: css`
    position: relative;

    overflow: hidden;
    display: flex;
    align-items: center;
    justify-content: center;

    aspect-ratio: 16 / 9;
    width: 100%;
    border-radius: 8px;

    background: #0d0f12;

    &[data-painting='true'] > img {
      transform: scale(1.05);
      filter: blur(6px) saturate(0.88);
    }
  `,
  bentoGrid: css`
    overflow-y: auto;
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 16px;
    align-content: start;

    width: 100%;
    height: 100%;
    padding-block: 8px 16px;
    padding-inline: 4px;

    animation: presentation-fade-in 220ms ease;

    @media (width <= 1200px) {
      grid-template-columns: repeat(3, 1fr);
    }

    @media (width <= 768px) {
      grid-template-columns: repeat(2, 1fr);
    }

    @media (width <= 480px) {
      grid-template-columns: 1fr;
    }
  `,
  bentoImage: css`
    display: block;
    width: 100%;
    height: 100%;
    object-fit: contain;
  `,
  bentoMeta: css`
    display: flex;
    gap: 8px;
    align-items: center;
    justify-content: space-between;
  `,
  bentoTitle: css`
    overflow: hidden;

    font-size: 12px;
    font-weight: 500;
    color: ${cssVar.colorText};
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  commandBar: css`
    display: flex;
    flex-shrink: 0;
    gap: 8px;
    align-items: center;

    width: 100%;
    min-height: 48px;
    padding-block: 0 8px;
    padding-inline: 16px;

    @media (width <= 768px) {
      flex-wrap: wrap;
      justify-content: center;
      padding-inline: 8px;
    }
  `,
  conversationTrigger: css`
    cursor: pointer;

    display: flex;
    flex: 1;
    gap: 10px;
    align-items: center;

    min-width: 120px;
    min-height: 44px;
    padding-block: 8px;
    padding-inline: 16px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 999px;

    font: inherit;
    font-size: 13px;
    color: ${cssVar.colorTextSecondary};

    background: ${cssVar.colorBgElevated};

    &:hover {
      color: ${cssVar.colorText};
      background: ${cssVar.colorFillQuaternary};
    }

    &[aria-pressed='true'] {
      color: ${cssVar.colorText};
      background: ${cssVar.colorFillSecondary};
    }

    &:focus-visible {
      outline: 2px solid ${cssVar.colorPrimary};
      outline-offset: 3px;
    }

    @media (width <= 768px) {
      flex: 1 1 100%;
      order: 3;
    }
  `,
  paginatorGroup: css`
    display: flex;
    flex-shrink: 0;
    gap: 4px;
    align-items: center;
    justify-content: center;

    min-height: 44px;
    padding: 2px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 999px;

    background: ${cssVar.colorBgElevated};
  `,
  capsuleGroupLeft: css`
    overflow: hidden;
    display: flex;
    flex: 1;
    gap: 10px;
    align-items: center;

    min-width: 0;
  `,
  capsuleGroupRight: css`
    display: flex;
    flex-shrink: 0;
    flex-wrap: wrap;
    gap: 4px;
    align-items: center;
  `,
  capsuleHeader: css`
    display: flex;
    flex-shrink: 0;
    gap: 12px;
    align-items: center;
    justify-content: space-between;

    padding-block: 8px;
    padding-inline: 18px 12px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 24px;

    background: ${cssVar.colorBgElevated};
    box-shadow: 0 4px 16px rgb(0 0 0 / 5%);

    @media (width <= 768px) {
      flex-direction: column;
      align-items: stretch;
      padding: 12px;
      border-radius: 20px;
    }
  `,
  capsuleStatus: css`
    cursor: pointer;

    display: inline-flex;
    flex-shrink: 0;
    gap: 4px;
    align-items: center;

    max-width: min(480px, 70vw);
    padding-block: 4px;
    padding-inline: 0;
    border: 0;

    font-size: 11px;
    color: ${cssVar.colorTextDescription};
    white-space: nowrap;

    background: transparent;

    span {
      overflow: hidden;
      text-overflow: ellipsis;
    }
  `,
  capsuleTitle: css`
    overflow: hidden;

    max-width: 260px;

    font-size: 14px;
    font-weight: 600;
    color: ${cssVar.colorText};
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  drawerBody: css`
    overflow-y: auto;
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 18px;

    padding: 16px;
  `,
  drawerEmptyState: css`
    display: flex;
    flex-direction: column;
    gap: 6px;
    align-items: center;
    justify-content: center;

    padding-block: 22px;
    padding-inline: 12px;
    border-radius: 8px;

    font-size: 12px;
    color: ${cssVar.colorTextDescription};
    text-align: center;

    background: ${cssVar.colorFillQuaternary};
  `,
  drawerHeader: css`
    display: flex;
    flex-shrink: 0;
    gap: 8px;
    align-items: center;
    justify-content: space-between;

    padding-block: 12px;
    padding-inline: 16px;
    border-block-end: 1px solid ${cssVar.colorBorderSecondary};
  `,
  drawerRoot: css`
    position: relative;

    overflow: hidden;
    display: flex;
    flex-direction: column;
    flex-shrink: 0;

    height: 100%;
    border-radius: 14px;

    background: ${cssVar.colorBgContainer};
    box-shadow: -4px 0 20px rgb(0 0 0 / 6%);

    transition:
      width 260ms cubic-bezier(0.16, 1, 0.3, 1),
      margin-inline-start 260ms cubic-bezier(0.16, 1, 0.3, 1),
      opacity 200ms ease;
  `,
  drawerSection: css`
    display: flex;
    flex-direction: column;
    gap: 8px;
  `,
  drawerSectionContent: css`
    padding: 12px;
    border-radius: 8px;

    font-size: 12px;
    line-height: 1.6;
    color: ${cssVar.colorTextSecondary};

    background: ${cssVar.colorFillQuaternary};
  `,
  drawerSectionHeader: css`
    display: flex;
    gap: 8px;
    align-items: center;

    font-size: 13px;
    font-weight: 600;
    color: ${cssVar.colorText};
  `,
  exportStatusHint: css`
    display: inline-flex;
    gap: 6px;
    align-items: center;

    font-size: 12px;
    color: ${cssVar.colorTextDescription};
  `,
  exportActions: css`
    margin-inline-start: 4px;
    padding-inline-start: 8px;
    border-inline-start: 1px solid ${cssVar.colorBorderSecondary};
  `,
  iconButton: css`
    && {
      display: inline-flex;
      flex-shrink: 0;
      align-items: center;
      justify-content: center;

      width: 44px;
      min-width: 44px;
      height: 44px;
      padding: 0;
      border-radius: 15px;

      box-shadow: none;
    }

    &[aria-pressed='true'] {
      color: ${cssVar.colorText};
      background: ${cssVar.colorFillSecondary};
    }

    &:focus-visible {
      outline: 2px solid ${cssVar.colorPrimary};
      outline-offset: 3px;
    }
  `,
  filmstripContainer: css`
    position: relative;

    overflow: hidden;
    display: flex;
    flex: 0 0 48px;
    flex-direction: column;

    width: 48px;
    min-width: 0;
    height: 100%;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 12px;

    background: ${cssVar.colorBgContainer};

    transition:
      width 240ms cubic-bezier(0.16, 1, 0.3, 1),
      opacity 200ms ease;

    &[data-open='true'] {
      flex-basis: 176px;
      width: 176px;
    }

    @media (width <= 768px) {
      &[data-open='true'] {
        flex-basis: 104px;
        width: 104px;
      }
    }
  `,
  filmstripBody: css`
    overflow-y: auto;
    flex: 1;

    min-height: 0;
    padding-block: 0 6px;
    padding-inline: 6px;
  `,
  filmstripHeader: css`
    display: flex;
    flex-shrink: 0;
    align-items: center;
    justify-content: flex-end;

    padding: 1px;
  `,
  focusCanvas: css`
    position: relative;

    container-type: size;
    overflow: hidden;
    display: flex;
    flex: 1;
    align-items: center;
    justify-content: center;

    width: 100%;
    min-height: 0;
    padding-block: 12px 4px;
    padding-inline: 16px;

    @media (width <= 768px) {
      padding-block: 6px 2px;
      padding-inline: 6px;
    }
  `,
  focusEmpty: css`
    display: flex;
    flex-direction: column;
    gap: 8px;
    align-items: center;
    justify-content: center;

    padding: 24px;

    font-size: 13px;
    color: ${cssVar.colorTextDescription};
    text-align: center;
  `,
  focusFrame169: css`
    cursor: pointer;

    position: relative;

    overflow: hidden;
    display: flex;
    align-items: center;
    justify-content: center;

    aspect-ratio: var(--slide-aw, 16) / var(--slide-ah, 9);
    width: min(100cqw, calc(100cqh * var(--slide-aw, 16) / var(--slide-ah, 9)));
    max-width: 100%;
    height: min(100cqh, calc(100cqw * var(--slide-ah, 9) / var(--slide-aw, 16)));
    max-height: 100%;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 14px;

    background: ${cssVar.colorBgContainer};
    box-shadow:
      0 8px 28px -12px rgb(0 0 0 / 16%),
      0 1px 4px rgb(0 0 0 / 4%);

    transition:
      transform 200ms ease,
      box-shadow 200ms ease,
      border-color 200ms ease;

    &[data-painting='true'] > img {
      transform: scale(1.045);
      filter: blur(8px) saturate(0.9);
    }

    &:hover {
      border-color: ${cssVar.colorBorder};
      box-shadow:
        0 10px 32px -12px rgb(0 0 0 / 20%),
        0 1px 4px rgb(0 0 0 / 4%);

      [data-role='hover-cue'] {
        opacity: 1;
      }
    }
  `,
  focusImage: css`
    display: block;
    width: 100%;
    height: 100%;
    object-fit: contain;
  `,
  hoverCue: css`
    pointer-events: none;

    position: absolute;
    inset-block-end: 14px;
    inset-inline-end: 16px;

    display: flex;
    gap: 6px;
    align-items: center;

    padding-block: 4px;
    padding-inline: 10px;
    border: 1px solid rgb(255 255 255 / 10%);
    border-radius: 999px;

    font-size: 11px;
    color: #fff;

    opacity: 0;
    background: rgb(0 0 0 / 68%);
    backdrop-filter: blur(8px);

    transition: opacity 180ms ease;
  `,
  mainLayout: css`
    position: relative;

    overflow: hidden;
    display: flex;
    flex: 1;
    gap: 12px;

    width: 100%;
    min-height: 0;
  `,
  paintBrushIcon: css`
    display: grid;
    place-items: center;

    width: 38px;
    height: 38px;
    border: 1px solid rgb(255 255 255 / 74%);
    border-radius: 50%;

    color: #315f62;

    background: rgb(255 255 255 / 82%);
    backdrop-filter: blur(10px);
    box-shadow:
      0 10px 28px rgb(23 62 69 / 16%),
      inset 0 0 0 1px rgb(52 130 132 / 8%);

    svg {
      transform: rotate(-38deg);
    }
  `,
  paintBrushMotion: css`
    pointer-events: none;
    position: absolute;
    z-index: 3;
    translate: -50% -50%;
  `,
  paintCaption: css`
    pointer-events: none;

    position: absolute;
    z-index: 3;
    inset-block-start: 14px;
    inset-inline-start: 14px;

    padding-block: 4px;
    padding-inline: 10px;
    border: 1px solid rgb(30 58 95 / 16%);
    border-radius: 999px;

    font-size: 11px;
    font-weight: 600;
    color: #1e3a5f;

    background: rgb(255 255 255 / 78%);
    box-shadow: 0 6px 16px rgb(30 58 95 / 10%);
  `,
  paintFrost: css`
    position: absolute;
    inset: 0;

    background: rgb(248 251 252 / 44%);
    backdrop-filter: blur(7px) saturate(0.92);

    animation: ${frostBreathe} 2.8s ease-in-out infinite;

    @media (prefers-reduced-motion: reduce) {
      animation: none;
    }
  `,
  paintAssets: css`
    position: absolute;
    inset-block-end: 18px;
    inset-inline-start: 18px;

    display: flex;
    gap: 8px;

    img {
      width: 44px;
      height: 44px;
      border: 1px solid rgb(255 255 255 / 75%);
      border-radius: 10px;

      object-fit: contain;
      background: rgb(255 255 255 / 65%);
      box-shadow: 0 4px 14px rgb(35 72 75 / 10%);

      animation: ${paintReveal} 0.8s ease both;
    }

    @media (prefers-reduced-motion: reduce) {
      img {
        animation: none;
      }
    }
  `,
  paintOverlay: css`
    pointer-events: none;

    position: absolute;
    z-index: 2;
    inset: 0;

    overflow: hidden;

    border-radius: inherit;
  `,
  paintStroke: css`
    pointer-events: none;

    position: absolute;
    inset: 0;

    width: 100%;
    height: 100%;

    color: rgb(59 143 145 / 54%);

    filter: drop-shadow(0 5px 8px rgb(38 105 112 / 10%));
  `,
  pageCounter: css`
    min-width: 64px;

    font-size: 13px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    color: ${cssVar.colorText};
    text-align: center;
  `,
  stageArea: css`
    position: relative;

    overflow: hidden;
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 8px;
    align-items: stretch;
    justify-content: flex-end;

    min-width: 0;
    height: 100%;

    transition: width 240ms cubic-bezier(0.16, 1, 0.3, 1);
  `,
  workspaceRoot: css`
    position: relative;

    overflow: hidden;
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 12px;

    width: 100%;
    height: 100%;
    min-height: 0;

    @keyframes presentation-fade-in {
      from {
        transform: translateY(4px);
        opacity: 0;
      }

      to {
        transform: translateY(0);
        opacity: 1;
      }
    }
  `,
}));
