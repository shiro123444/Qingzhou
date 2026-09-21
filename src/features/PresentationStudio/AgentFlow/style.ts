import { createStaticStyles } from 'antd-style';

export const styles = createStaticStyles(({ css, cssVar }) => ({
  capabilityBar: css`
    position: sticky;
    z-index: 4;
    inset-block-start: 0;

    display: flex;
    flex: none;
    align-items: center;
    justify-content: flex-end;

    box-sizing: border-box;
    width: 100%;
    min-height: 34px;
    padding-block: 4px;
    padding-inline: 16px;

    color: ${cssVar.colorTextSecondary};

    background: linear-gradient(
      to bottom,
      color-mix(in srgb, ${cssVar.colorBgLayout} 90%, transparent),
      transparent
    );
  `,
  interactiveCardGroup: css`
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
    gap: 10px;

    width: 100%;
    margin-block-start: 6px;
  `,
  optionCard: css`
    cursor: pointer;

    display: flex;
    flex-direction: column;
    gap: 4px;

    padding-block: 12px;
    padding-inline: 14px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 10px;

    background: ${cssVar.colorBgElevated};

    transition: all 0.2s ease-in-out;

    &:hover {
      transform: translateY(-1px);
      border-color: ${cssVar.colorPrimary};
      background: ${cssVar.colorFillQuaternary};
    }

    &:focus-visible {
      outline: 2px solid ${cssVar.colorPrimary};
      outline-offset: 2px;
    }
  `,
  optionCardActive: css`
    border-color: ${cssVar.colorPrimary} !important;
    background: ${cssVar.colorFillAlter} !important;
    box-shadow: 0 0 0 1px ${cssVar.colorPrimary};
  `,
  optionCardDesc: css`
    font-size: 12px;
    color: ${cssVar.colorTextSecondary};
  `,
  optionCardTitle: css`
    font-size: 14px;
    font-weight: 600;
    color: ${cssVar.colorText};
  `,
  outlineCard: css`
    display: flex;
    flex-direction: column;
    gap: 12px;

    padding-block: 16px;
    padding-inline: 20px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 12px;

    background: ${cssVar.colorBgContainer};
  `,
  outlineHeader: css`
    display: flex;
    align-items: center;
    justify-content: space-between;

    padding-block-end: 8px;
    border-block-end: 1px solid ${cssVar.colorBorderSecondary};
  `,
  outlineIndex: css`
    padding-block: 2px;
    padding-inline: 6px;
    border-radius: 4px;

    font-size: 12px;
    font-weight: 700;
    color: ${cssVar.colorPrimary};

    background: ${cssVar.colorFillTertiary};
  `,
  outlineItem: css`
    display: flex;
    gap: 10px;
    align-items: center;

    padding-block: 6px;
    padding-inline: 0;
  `,
  outlineList: css`
    display: flex;
    flex-direction: column;
    gap: 6px;
  `,
  outlineOverview: css`
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
    gap: 8px;

    padding: 12px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 10px;

    background: ${cssVar.colorFillQuaternary};
  `,
  outlineOverviewItem: css`
    cursor: pointer;

    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    gap: 2px 8px;
    align-items: center;

    padding-block: 9px;
    padding-inline: 10px;
    border: 1px solid transparent;
    border-radius: 8px;

    color: ${cssVar.colorText};
    text-align: start;

    background: ${cssVar.colorBgContainer};

    &:hover {
      border-color: ${cssVar.colorPrimary};
    }
  `,
  outlineOverviewIndex: css`
    grid-row: span 2;
    font-size: 12px;
    font-weight: 700;
    color: ${cssVar.colorPrimary};
  `,
  outlineOverviewTitle: css`
    overflow: hidden;

    font-size: 12px;
    font-weight: 600;
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  outlineOverviewMeta: css`
    font-size: 11px;
    color: ${cssVar.colorTextDescription};
  `,
  outlinePointItem: css`
    display: flex;
    gap: 8px;
    align-items: center;
    width: 100%;
  `,
  outlineSlideCard: css`
    display: flex;
    flex-direction: column;
    gap: 14px;

    padding-block: 16px;
    padding-inline: 18px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 12px;

    background: ${cssVar.colorBgContainer};
    box-shadow: 0 2px 8px rgb(0 0 0 / 2%);

    transition: all 0.2s ease-in-out;

    &:hover {
      border-color: ${cssVar.colorPrimaryBorder};
      box-shadow: 0 4px 14px rgb(0 0 0 / 4%);
    }
  `,
  outlineSlideCardBody: css`
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding-inline-start: 36px;

    @media (width <= 768px) {
      padding-inline-start: 0;
    }
  `,
  outlineSlideCardHeader: css`
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    align-items: center;

    width: 100%;
  `,
  outlineTitle: css`
    font-size: 13px;
    color: ${cssVar.colorText};
  `,
  outlineWorkspace: css`
    display: flex;
    flex-direction: column;
    gap: 20px;

    box-sizing: border-box;
    width: 100%;
    max-width: 1080px;
    margin-block: 0;
    margin-inline: auto;
    padding-block: 24px 48px;
    padding-inline: 20px;
  `,
  outlineWorkspaceFooter: css`
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    align-items: center;
    justify-content: space-between;

    padding-block-start: 16px;
    border-block-start: 1px solid ${cssVar.colorBorderSecondary};
  `,
  outlineWorkspaceHeader: css`
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    align-items: center;
    justify-content: space-between;

    padding-block-end: 16px;
    border-block-end: 1px solid ${cssVar.colorBorderSecondary};
  `,
  summaryCard: css`
    display: flex;
    flex-direction: column;
    gap: 12px;

    padding-block: 16px;
    padding-inline: 20px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 12px;

    background: ${cssVar.colorFillQuaternary};
  `,
  summaryItem: css`
    display: flex;
    gap: 12px;
    align-items: center;
    font-size: 13px;
  `,
  summaryLabel: css`
    flex-shrink: 0;
    width: 76px;
    color: ${cssVar.colorTextSecondary};
  `,
  summaryValue: css`
    font-weight: 500;
    color: ${cssVar.colorText};
  `,
  flowComposer: css`
    position: relative;
    z-index: 1;

    flex-shrink: 0;

    box-sizing: border-box;
    width: min(100%, 920px);
    margin-inline: auto;
    padding-block: 20px 28px;
    padding-inline: 16px;
  `,
  flowMessageRow: css`
    width: 100%;

    &[data-message-role='user'] {
      display: flex;
      justify-content: flex-end;

      > * {
        width: 100%;
      }
    }
  `,
  planningShelf: css`
    position: relative;
    z-index: 2;

    flex: none;

    width: 100%;
    padding-block-start: 10px;
  `,
  flowRoot: css`
    display: flex;
    flex: 1;
    flex-direction: column;

    width: 100%;
    height: 100%;
    min-height: 0;

    > * {
      display: flex;
      flex: 1;
      flex-direction: column;

      width: 100%;
      height: 100%;
      min-height: 0;
    }
  `,
  flowShell: css`
    isolation: isolate;
    position: relative;

    overflow: clip;
    display: flex;
    flex: 1;
    flex-direction: column;

    width: 100%;
    height: 100%;
    min-height: 0;
  `,
  flowThread: css`
    position: relative;
    z-index: 1;

    overflow: hidden;
    display: flex;
    flex: 1;
    flex-direction: column;

    min-width: 0;
    min-height: 0;
  `,
  flowScroller: css`
    scrollbar-gutter: stable;

    overflow: hidden auto;
    display: flex;
    flex: 1;
    flex-direction: column;

    width: 100%;
    min-height: 0;
    padding-block-end: 16px;
  `,
  flowWelcome: css`
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 16px;
    align-items: stretch;
    justify-content: flex-end;

    box-sizing: border-box;
    width: 100%;
    min-height: 100%;
    margin-inline: 0;
    padding-block: 24px 8px;
    padding-inline: 0;

    text-align: start;
  `,
  flowWelcomeCopy: css`
    margin: 0;
    font-size: 14px;
    line-height: 1.6;
    color: ${cssVar.colorTextDescription};
  `,
  flowWelcomeHint: css`
    margin-block: 0 10px;
    font-size: 13px;
    line-height: 1.5;
    color: ${cssVar.colorTextDescription};
  `,
  thinkingBubble: css`
    display: flex;
    gap: 10px;
    align-items: center;

    box-sizing: border-box;
    width: 100%;
    max-width: 720px;
    margin-inline: auto;
    padding-block: 12px;
    padding-inline: 14px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 12px;

    font-size: 14px;
    color: ${cssVar.colorTextDescription};

    background: ${cssVar.colorFillQuaternary};
  `,
  thinkingDot: css`
    --presentation-dot-offset: 0px;

    display: block;

    width: 4px;
    height: 4px;
    border-radius: 50%;

    background: currentcolor;

    animation: presentation-thinking 1.15s infinite cubic-bezier(0.45, 0, 0.55, 1);

    &:nth-child(1) {
      --presentation-dot-offset: 2px;

      animation-delay: -0.32s;
    }

    &:nth-child(2) {
      --presentation-dot-offset: -2px;

      animation-delay: -0.16s;
    }

    &:nth-child(3) {
      --presentation-dot-offset: 1px;

      animation-delay: 0s;
    }

    @keyframes presentation-thinking {
      0%,
      100% {
        transform: translateY(calc(var(--presentation-dot-offset) + 2px));
        opacity: 0.35;
      }

      50% {
        transform: translateY(calc(var(--presentation-dot-offset) - 3px));
        opacity: 1;
      }
    }

    @media (prefers-reduced-motion: reduce) {
      animation: none;
    }
  `,
  thinkingText: css`
    overflow: hidden;
    display: inline-flex;
    align-items: center;

    min-width: 0;

    color: ${cssVar.colorTextDescription};
    white-space: nowrap;

    &::after {
      content: '';

      width: 1px;
      height: 1em;
      margin-inline-start: 3px;

      background: currentcolor;

      animation: presentation-thinking-caret 0.9s steps(1, end) infinite;
    }

    @keyframes presentation-thinking-caret {
      0%,
      45% {
        opacity: 0.7;
      }

      50%,
      100% {
        opacity: 0;
      }
    }

    @media (prefers-reduced-motion: reduce) {
      &::after {
        opacity: 0.45;
        animation: none;
      }
    }
  `,
  thinkingWave: css`
    display: inline-flex;
    flex-shrink: 0;
    gap: 3px;
    align-items: center;

    width: 18px;
    height: 16px;

    color: ${cssVar.colorTextDescription};
  `,
  realtimeTranscript: css`
    display: flex;
    flex-direction: column;
    gap: 10px;

    box-sizing: border-box;
    width: min(100%, 720px);
    margin-inline: auto;
    padding-block: 8px 16px;
    padding-inline: 16px;
  `,
  realtimeMessage: css`
    max-width: 86%;
    padding-block: 11px;
    padding-inline: 14px;
    border-radius: 14px;

    font-size: 14px;
    line-height: 1.6;
    white-space: pre-wrap;
  `,
  realtimeMessageAgent: css`
    align-self: flex-start;
    border: 1px solid ${cssVar.colorBorderSecondary};
    color: ${cssVar.colorText};
    background: ${cssVar.colorBgContainer};
  `,
  realtimeMessageUser: css`
    align-self: flex-end;
    color: ${cssVar.colorTextLightSolid};
    background: ${cssVar.colorPrimary};
  `,
}));
