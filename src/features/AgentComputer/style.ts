import { createStaticStyles } from 'antd-style';

export const styles = createStaticStyles(({ css, cssVar }) => ({
  window: css`
    overflow: hidden;
    border: 1px solid
      color-mix(in srgb, ${cssVar.colorBgElevated} 75%, ${cssVar.colorBorderSecondary});
    border-radius: 32px;
    box-shadow:
      0 32px 120px #071b1929,
      inset 0 1px 0 #ffffff70;
  `,
  surface: css`
    overflow: hidden;
    border-radius: inherit;
    background:
      radial-gradient(ellipse at 100% 0%, #9ed3be26, transparent 52%),
      color-mix(in srgb, ${cssVar.colorBgElevated} 94%, transparent) !important;
    backdrop-filter: blur(32px) saturate(1.2);
  `,
  windowHeader: css`
    min-height: 48px;
    padding-block: 12px !important;
    padding-inline: 26px 112px !important;
    border: 0 !important;
  `,
  drawerBody: css`
    scrollbar-width: thin;
  `,
  drawerContent: css`
    min-height: 0 !important;
  `,
  windowTitle: css`
    display: flex;
    gap: 9px;
    align-items: center;

    min-width: 0;

    font-size: 12px;
    font-weight: 500;
    color: ${cssVar.colorTextSecondary};
  `,
  body: css`
    display: flex;
    flex-direction: column;
    gap: 18px;

    min-height: 0;
    padding-block: 12px 24px;
    padding-inline: 26px;

    @media (width <= 600px) {
      gap: 14px;
      padding-block: 6px 16px;
      padding-inline: 14px;
    }
  `,
  presence: css`
    --computer-accent: #438c73;

    position: relative;

    display: flex;
    gap: 20px;
    align-items: center;
    justify-content: space-between;

    min-height: 132px;
    padding-block: 0 10px;
    padding-inline: 8px;

    &[data-computer-presence='busy'] {
      --computer-accent: #8572b6;
    }

    &[data-computer-presence='unknown'],
    &[data-computer-presence='unavailable'] {
      --computer-accent: #bc945a;
    }

    @media (width <= 600px) {
      gap: 10px;
      min-height: 112px;
      padding-inline: 4px;
    }
  `,
  presenceCopy: css`
    position: relative;
    z-index: 1;
    min-width: 0;
  `,
  headlineSlot: css`
    margin-block-start: 0;
  `,
  headline: css`
    margin: 0;

    font-size: clamp(38px, 5.1vw, 76px);
    font-weight: 650;
    line-height: 1.06;
    color: ${cssVar.colorText};
    text-wrap: balance;
    letter-spacing: -0.055em;
    overflow-wrap: anywhere;

    @media (width <= 600px) {
      font-size: clamp(32px, 8.5vw, 48px);
    }
  `,
  emptyStage: css`
    isolation: isolate;
    position: relative;

    overflow: hidden;
    display: flex;
    flex-direction: column;
    gap: 16px;
    align-items: center;
    justify-content: center;

    min-height: 400px;
    padding-block: 8px 28px;
    padding-inline: 20px;
    border-radius: 24px;

    background:
      radial-gradient(ellipse at 50% 40%, #94c8af22, transparent 66%),
      linear-gradient(150deg, ${cssVar.colorFillQuaternary}, transparent);

    p {
      z-index: 1;

      margin: 0;

      font-size: 12px;
      color: ${cssVar.colorTextSecondary};
      text-align: center;
    }

    @media (width <= 600px) {
      min-height: 350px;
    }
  `,
  launchButton: css`
    z-index: 1;

    gap: 16px !important;

    height: 52px !important;
    padding-inline: 26px !important;
    border-radius: 999px !important;

    font-size: 14px !important;
    font-weight: 500;

    box-shadow: 0 8px 24px #0e30201a;
  `,
  computerSculpture: css`
    pointer-events: none;

    position: relative;

    display: grid;
    flex-shrink: 0;
    place-items: center;

    width: min(100%, 460px);
    height: 280px;

    perspective: 1000px;

    @media (width <= 600px) {
      height: 240px;
    }
  `,
  lightField: css`
    position: absolute;
    inset-block: 15px;
    inset-inline: -15%;

    border-radius: 50%;

    background:
      radial-gradient(ellipse at 35% 30%, #b5e5b755, transparent 60%),
      radial-gradient(ellipse at 65% 65%, #6cbdc044, transparent 55%);
    filter: blur(20px);

    animation: qz-computer-light 9s ease-in-out infinite alternate;

    @keyframes qz-computer-light {
      to {
        transform: translate(15px, -10px) scale(1.12);
      }
    }

    @media (prefers-reduced-motion: reduce) {
      animation: none;
    }
  `,
  sculptureMonitor: css`
    position: relative;
    transform: rotateX(8deg) rotateY(-18deg) rotateZ(-5deg) translateY(-10px);

    width: 310px;
    height: 200px;
    padding-block: 9px 24px;
    padding-inline: 9px;
    border: 1px solid #effff7a0;
    border-radius: 20px;

    background: linear-gradient(135deg, #e9f6efb0, #81b6a68a 60%, #e2f6eea0);
    box-shadow:
      inset 0 2px 1px #ffffffd0,
      inset -4px -1px 3px #235d4a40,
      16px 22px 40px #123a3220;

    @media (width <= 600px) {
      width: 250px;
      height: 164px;
    }
  `,
  sculptureScreen: css`
    position: relative;

    overflow: hidden;
    display: grid;
    place-items: center;

    height: 100%;
    border: 1px solid #132f2940;
    border-radius: 12px;

    color: #d7ffe9;

    background:
      radial-gradient(ellipse at 25% 15%, #4c9986, transparent 80%),
      linear-gradient(150deg, #254d43, #102f29 70%);
    box-shadow: inset 0 1px 4px #00000030;

    &::after {
      content: '';
      position: absolute;
      inset: 0;
      background: linear-gradient(135deg, #ffffff24, transparent 45%, #ffffff0a);
    }
  `,
  screenCursor: css`
    transform: rotate(-10deg);

    width: 58px;
    height: 70px;

    background: linear-gradient(140deg, #f0fff8, #8bc4b0 65%, #417d6a);
    clip-path: polygon(8% 0, 100% 53%, 60% 60%, 42% 100%);
  `,
  sculptureStem: css`
    position: absolute;
    inset-block-start: 100%;
    inset-inline-start: calc(50% - 24px);
    transform: skewX(-12deg);

    width: 48px;
    height: 32px;
    border-inline: 1px solid #d5f4eabb;

    background: linear-gradient(90deg, #84b6a790, #c6e8ddb0 50%, #66998b90);
  `,
  sculptureFoot: css`
    position: absolute;
    inset-block-start: calc(100% + 26px);
    inset-inline-start: calc(50% - 60px);
    transform: skewX(-15deg);

    width: 120px;
    height: 12px;
    border: 1px solid #daf6ed80;
    border-radius: 8px;

    background: linear-gradient(180deg, #c7e7dc, #7daa9e);
    box-shadow: 6px 8px 10px #214f3920;
  `,
  console: css`
    display: flex;
    flex-direction: column;
    gap: 10px;
    min-width: 0;
  `,
  browserShell: css`
    overflow: hidden;

    width: min(100%, max(340px, calc((100dvh - 430px) * 11 / 7)));
    margin-inline: auto;
    padding: 8px;
    border: 1px solid #e8fff12a;
    border-radius: 24px;

    background: #152c26;
    box-shadow:
      0 20px 44px #092b2124,
      inset 0 1px 0 #ffffff25;

    @media (width <= 600px) {
      width: 100%;
      padding: 5px;
      border-radius: 18px;
    }
  `,
  address: css`
    display: flex;
    gap: 10px;
    align-items: center;

    padding-block: 2px 8px;
    padding-inline: 12px 4px;

    color: #d2e5dc;

    > input {
      min-width: 0;
      font-size: 12px;
      color: #d2e5dc;

      &::placeholder {
        color: #b9d1c7;
      }

      &:disabled {
        color: #b9d1c7;
      }
    }

    > button {
      color: #d2e5dc;
    }

    > svg {
      flex-shrink: 0;
      opacity: 0.65;
    }
  `,
  viewport: css`
    position: relative;

    overflow: hidden;
    overscroll-behavior: contain;

    aspect-ratio: 11/7;
    width: 100%;
    border: 1px solid #ffffff14;
    border-radius: 16px;

    background: ${cssVar.colorBgContainer};
    outline-offset: -4px;

    img {
      pointer-events: none;
      user-select: none;

      display: block;

      width: 100%;
      height: 100%;
    }

    @media (width <= 600px) {
      border-radius: 12px;
    }
  `,
  browserEmpty: css`
    display: flex;
    flex-direction: column;
    gap: 16px;
    align-items: center;
    justify-content: center;

    height: min(60dvh, 520px);
    min-height: 220px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 16px;

    color: ${cssVar.colorTextTertiary};

    background: ${cssVar.colorFillQuaternary};

    span {
      font-size: 12px;
    }
  `,
  controlBar: css`
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    align-items: center;
    justify-content: center;

    min-height: 60px;
    padding-block-start: 6px;

    > div {
      margin: 0;
      box-shadow:
        inset 0 1px 0 #ffffff50,
        0 8px 28px #0b352014;
    }
  `,
  handoffButton: css`
    gap: 12px !important;

    height: 48px !important;
    padding-inline: 22px !important;
    border-radius: 999px !important;

    font-size: 13px !important;

    box-shadow: 0 8px 24px #0b352012;
  `,
  entryForm: css`
    display: flex;
    gap: 6px;
    align-items: center;

    width: min(100%, 620px);
    margin-inline: auto;
    padding: 5px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 16px;

    background: color-mix(in srgb, ${cssVar.colorBgElevated} 65%, transparent);

    > input {
      min-width: 0;
      border: 0;
      background: transparent;
      box-shadow: none;
    }

    > button {
      border: 0;
      border-radius: 10px;
      box-shadow: none;
    }
  `,
  frameStatus: css`
    position: absolute;
    inset-block-start: 10px;
    inset-inline-start: 10px;

    padding-block: 5px;
    padding-inline: 9px;
    border-radius: 10px;

    font-size: 11px;
    color: ${cssVar.colorTextSecondary};

    background: ${cssVar.colorBgElevated};
  `,
  notice: css`
    margin: 0;
    font-size: 11px;
    color: ${cssVar.colorTextSecondary};
  `,
  taskArea: css`
    display: flex;
    flex-direction: column;
    gap: 8px;
    align-items: flex-start;

    padding-block-start: 8px;
    border-block-start: 1px solid ${cssVar.colorBorderSecondary};

    a {
      font-size: 11px;
      color: ${cssVar.colorTextSecondary};
    }
  `,
  taskComposer: css`
    display: flex;
    gap: 8px;
    align-items: flex-end;
    width: 100%;
  `,
  details: css`
    display: flex;
    flex-direction: column;
    gap: 12px;

    padding: 14px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 14px;

    background: ${cssVar.colorFillQuaternary};
  `,
  detailHeading: css`
    display: flex;
    align-items: center;
    justify-content: space-between;

    font-size: 12px;
    font-weight: 500;
  `,
  detail: css`
    margin: 0;

    font-size: 11px;
    line-height: 1.6;
    color: ${cssVar.colorTextTertiary};
    overflow-wrap: anywhere;
  `,
  list: css`
    display: flex;
    flex-direction: column;
    gap: 12px;

    margin: 0;
    padding: 0;

    list-style: none;
  `,
  receipt: css`
    display: flex;
    gap: 12px;
    align-items: center;
    justify-content: space-between;

    font-size: 11px;

    small {
      display: block;
      margin-block-start: 4px;
      font-size: 10px;
      color: ${cssVar.colorTextTertiary};
    }
  `,
}));
