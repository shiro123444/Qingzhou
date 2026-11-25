import { createStaticStyles, keyframes } from 'antd-style';

const watercolorWash = keyframes`
  0%, 10% {
    clip-path: inset(0 100% 0 0);
    opacity: 0;
  }
  48%, 88% {
    clip-path: inset(0 0 0 0);
    opacity: 1;
  }
  100% {
    clip-path: inset(0 0 0 0);
    opacity: 0;
  }
`;

export const styles = createStaticStyles(({ css, cssVar }) => ({
  bentoCard: css`
    cursor: pointer;

    overflow: hidden;
    display: flex;
    flex-direction: column;
    gap: 8px;

    padding: 10px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 12px;

    background: var(--qz-glass-sheen), var(--qz-glass-strong);
    backdrop-filter: var(--qz-glass-filter);

    transition:
      transform var(--qz-panel-resize),
      box-shadow 200ms ease,
      border-color 200ms ease;

    &:hover {
      transform: translateY(-2px);
      border-color: ${cssVar.colorBorder};
      box-shadow: 0 8px 24px rgb(0 0 0 / 12%);
    }

    @media (prefers-reduced-motion: reduce) {
      transition: none;
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
    pointer-events: none;

    position: absolute;
    z-index: 7;
    inset-block-end: 12px;
    inset-inline: 16px;

    display: flex;
    flex-shrink: 0;
    gap: 8px;
    align-items: center;

    min-height: 44px;

    > * {
      pointer-events: auto;
    }

    @media (width <= 768px) {
      inset-inline: 8px;
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
    border: 1px solid var(--qz-glass-border, ${cssVar.colorBorderSecondary});
    border-radius: 999px;

    background: transparent;
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

    @media (width <= 768px) {
      scrollbar-width: thin;
      overflow-x: auto;
      flex-wrap: nowrap;
      gap: 2px;

      button {
        flex-shrink: 0;
      }
    }
  `,
  exportButton: css`
    &&:not(:disabled) {
      border: 1px solid var(--qz-glass-border, ${cssVar.colorBorderSecondary});
      color: ${cssVar.colorText};
      background: var(--qz-glass-selection, color-mix(in srgb, #74948c 14%, transparent));
      box-shadow: inset 0 1px 0 var(--qz-glass-highlight);
    }
  `,
  capsuleHeader: css`
    position: absolute;
    z-index: 12;
    inset-block-start: 12px;
    inset-inline: 12px;

    display: flex;
    flex-shrink: 0;
    gap: 12px;
    align-items: center;
    justify-content: space-between;

    min-height: 48px;
    padding-block: 6px;
    padding-inline: 10px 8px;
    border: 1px solid var(--qz-glass-border, ${cssVar.colorBorderSecondary});
    border-radius: 18px;

    background: transparent;

    @media (width <= 768px) {
      gap: 6px;
      padding: 6px;
      border-radius: 16px;
    }
  `,
  capsuleStatus: css`
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

    background: var(--qz-glass-surface);
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
    border-radius: 2px;

    background: var(--qz-glass-sheen), var(--qz-glass-strong);
    backdrop-filter: var(--qz-glass-filter);
    box-shadow: -4px 0 20px rgb(0 0 0 / 6%);

    transition:
      width var(--qz-panel-resize),
      margin-inline-start var(--qz-panel-resize),
      opacity 150ms ease;

    @media (prefers-reduced-motion: reduce) {
      transition: none;
    }
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

    background: var(--qz-glass-surface);
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

    @media (width <= 768px) {
      && {
        width: 36px;
        min-width: 36px;
        height: 36px;
        border-radius: 12px;
      }
    }

    &[aria-pressed='true'] {
      color: ${cssVar.colorText};
      background: var(--qz-glass-selection);
    }

    &:focus-visible {
      outline: 2px solid ${cssVar.colorPrimary};
      outline-offset: 3px;
    }
  `,
  filmstripContainer: css`
    position: absolute;
    z-index: 8;
    inset-block-start: 76px;
    inset-inline-start: 12px;

    overflow: hidden;
    display: flex;
    flex: none;
    flex-direction: column;

    width: 44px;
    min-width: 0;
    height: calc(100% - 164px);
    max-height: 640px;
    border: 1px solid var(--qz-glass-border, ${cssVar.colorBorderSecondary});
    border-radius: 14px;

    background: transparent;

    transition:
      width var(--qz-panel-resize),
      height var(--qz-panel-resize);

    &[data-open='false'] {
      height: 40px;
    }

    &[data-open='true'] {
      width: 176px;
    }

    @media (prefers-reduced-motion: reduce) {
      transition: none;
    }

    @media (width <= 768px) {
      inset-inline-start: 8px;
      width: 38px;

      &[data-open='true'] {
        width: 124px;
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

    padding-block: 3px;
    padding-inline: 6px;
  `,
  canvasTools: css`
    position: absolute;
    z-index: 3;
    inset-block-start: 76px;
    inset-inline-start: 50%;
    transform: translateX(-50%);

    width: max-content;
    max-width: calc(100% - 20px);

    @container (width < 430px) {
      inset-inline: auto 10px;
      transform: none;
      max-width: calc(100% - 56px);

      [role='toolbar'] {
        gap: 1px;
        padding: 4px;
      }

      button {
        width: 32px;
        height: 34px;
      }
    }
  `,
  objectBar: css`
    position: absolute;
    z-index: 3;
    inset-block-end: 12px;
    inset-inline-start: 50%;
    transform: translateX(-50%);

    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    align-items: center;
    justify-content: center;

    width: max-content;
    max-width: calc(100% - 28px);
    padding-block: 6px;
    padding-inline: 10px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 12px;

    background: transparent;
    box-shadow: var(--qz-glass-shadow);

    select {
      max-width: min(160px, 32vw);
      padding: 2px;
      border: 0;

      font: inherit;
      font-size: 12px;
      color: ${cssVar.colorText};

      background: transparent;
    }

    label {
      display: inline-flex;
      gap: 3px;
      align-items: center;

      font-size: 11px;
      color: ${cssVar.colorTextSecondary};
    }

    label .ant-input-number {
      width: 60px;
    }

    [role='alert'] {
      flex-basis: 100%;
      font-size: 12px;
      color: ${cssVar.colorError};
      text-align: center;
    }
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
    padding: 0;

    [data-testid='spatial-canvas'] {
      border: 0;
      border-radius: 0;
      background: transparent;
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
    border: 0;
    border-radius: 0;

    background: transparent;
    box-shadow: none;
  `,
  dragImage: css`
    pointer-events: none;

    position: absolute;
    inset: 0;

    width: 100%;
    height: 100%;

    visibility: hidden;
    object-fit: contain;

    [data-moving='true'] > & {
      visibility: visible;
    }
  `,
  focusImage: css`
    display: block;
    width: 100%;
    height: 100%;
    object-fit: contain;

    [data-moving='true'] > & {
      visibility: hidden;
    }
  `,
  mainLayout: css`
    position: relative;

    overflow: hidden;
    display: flex;
    flex: 1;
    gap: 0;

    width: 100%;
    min-height: 0;
  `,
  generationOverlay: css`
    pointer-events: none;

    position: absolute;
    z-index: 2;
    inset-block-end: 16px;
    inset-inline-start: 16px;

    display: flex;
    gap: 14px;
    align-items: center;

    max-width: calc(100% - 32px);
    padding: 10px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 16px;

    color: ${cssVar.colorText};

    background: var(--qz-glass-sheen), var(--qz-glass-strong);
    backdrop-filter: var(--qz-glass-filter);
    box-shadow: var(--qz-glass-shadow);

    &[data-empty='true']:not([data-compact='true']) {
      inset-block: 50% auto;
      inset-inline-start: 50%;
      translate: -50% -50%;

      flex-direction: column;

      width: min(260px, calc(100% - 32px));
      padding: 16px;

      text-align: center;

      svg {
        width: 100%;
      }
    }

    &[data-compact='true'] {
      inset-block-end: 8px;
      inset-inline-start: 8px;

      max-width: calc(100% - 16px);
      padding-block: 4px;
      padding-inline: 8px;
      border-radius: 8px;
    }

    &[data-state='interrupted'] svg g {
      animation: none;
    }

    @media (prefers-reduced-motion: reduce) {
      svg g {
        animation: none;
      }
    }

    @media (width <= 680px) {
      gap: 8px;
      padding: 7px;
      border-radius: 12px;
    }
  `,
  generationWatercolor: css`
    overflow: hidden;
    flex-shrink: 0;

    width: 112px;
    height: auto;
    border-radius: 10px;

    @media (width <= 680px) {
      width: 72px;
    }
  `,
  generationPaper: css`
    fill: color-mix(in srgb, ${cssVar.colorBgContainer} 85%, #c9ddd1);
  `,
  generationSky: css`
    animation: ${watercolorWash} 18s ease-in-out infinite both;
  `,
  generationRiver: css`
    animation: ${watercolorWash} 18s ease-in-out 1.5s infinite both;
  `,
  generationBoat: css`
    animation: ${watercolorWash} 18s ease-in-out 3s infinite both;
  `,
  generationReeds: css`
    animation: ${watercolorWash} 18s ease-in-out 2s infinite both;
  `,
  generationCopy: css`
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding-inline-end: 6px;
  `,
  generationCaption: css`
    font-size: 12px;
    font-weight: 600;
    line-height: 1.5;
  `,
  generationHint: css`
    font-size: 11px;
    line-height: 1.5;
    color: ${cssVar.colorTextSecondary};
  `,
  pageCounter: css`
    min-width: 64px;

    font-size: 13px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    color: ${cssVar.colorText};
    text-align: center;
  `,
  syncState: css`
    pointer-events: none;

    position: absolute;
    z-index: 5;
    inset-block-start: 8px;
    inset-inline-end: 8px;

    display: flex;
    gap: 8px;
    align-items: center;

    max-width: calc(100% - 16px);
    padding-block: 4px;
    padding-inline: 10px;
    border-radius: 12px;

    font-size: 12px;

    button {
      pointer-events: auto;
    }
  `,
  stageArea: css`
    position: relative;

    overflow: hidden;
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 0;
    align-items: stretch;
    justify-content: flex-end;

    min-width: 0;
    min-height: 0;

    transition: width var(--qz-panel-resize);
  `,
  editorColumn: css`
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 0;

    min-width: 0;
    min-height: 0;
  `,
  workspaceMount: css`
    display: flex;
    flex: 1;

    width: 100%;
    min-width: 0;
    height: 100%;
    min-height: 0;
  `,
  collaborationSlot: css`
    pointer-events: none;

    position: absolute;
    z-index: 20;
    inset-block-start: 68px;
    inset-inline: 0;
  `,
  workspaceRoot: css`
    position: relative;

    overflow: hidden;
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 0;

    width: 100%;
    height: 100%;
    min-height: 0;

    &[data-focused='true'] {
      position: fixed;
      z-index: 800;
      inset: 0;

      box-sizing: border-box;
      width: 100vw;
      height: 100dvh;
      padding: 0;

      background: ${cssVar.colorBgLayout};
    }

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
