import { createStaticStyles, keyframes } from 'antd-style';

const turn = keyframes`to { transform: rotate(360deg); }`;
const cabinSwing = keyframes`
  0%, 100% { transform: rotate(-2deg); }
  50% { transform: rotate(2deg); }
`;
const counterTurn = keyframes`to { transform: rotate(-360deg); }`;
const boatDrift = keyframes`
  0%, 100% { transform: translateY(0) rotate(-2deg); }
  50% { transform: translateY(-2px) rotate(2deg); }
`;
const settle = keyframes`
  0% { transform: rotate(-12deg); }
  35% { transform: rotate(6deg); }
  70% { transform: rotate(-3deg); }
  100% { transform: rotate(0); }
`;
const ripple = keyframes`
  0%, 18% { opacity: 0; transform: scale(.72); }
  42% { opacity: .42; }
  100% { opacity: 0; transform: scale(1.24); }
`;

export const styles = createStaticStyles(({ css, cssVar }) => ({
  wordmark: css`
    user-select: none;

    display: flex;
    flex: none;
    flex-direction: column;
    align-items: center;

    width: 136px;
    margin-block-end: 24px;

    img {
      display: block;
      width: 100%;
      height: auto;
    }

    span {
      margin-block-start: 6px;
      font-size: 9px;
      color: ${cssVar.colorTextSecondary};
      letter-spacing: 0.42em;
    }

    &[data-compact='true'] {
      width: 62px;
      margin: 0;
    }

    @media (width <= 600px) {
      width: 108px;
      margin-block-end: 20px;
    }
  `,
  sidebarBrand: css`
    display: flex;
    gap: 12px;
    align-items: center;

    padding-block: 8px 4px;
    padding-inline: 20px;

    font-size: 9px;
    color: ${cssVar.colorTextTertiary};
    letter-spacing: 0.28em;
  `,
  home: css`
    isolation: isolate;
    position: relative;
    width: 100%;
    min-width: 0;
  `,
  homeContent: css`
    position: relative;
    z-index: 1;
  `,
  scenery: css`
    pointer-events: none;

    position: absolute;
    z-index: 0;
    inset-block: -40px 0;
    inset-inline: 0 -24px;

    overflow: hidden;

    min-height: 560px;

    mask-image: linear-gradient(to bottom, #000 65%, transparent 100%);

    @media (width <= 600px) {
      inset-block: -10px 0;
      inset-inline: 0;
      min-height: 300px;
    }
  `,
  ferris: css`
    --qz-wheel-duration: 96s;
    --qz-wheel-surface: ${cssVar.colorBgContainer};

    position: absolute;
    inset-block-start: 0;
    inset-inline-end: -52px;

    width: min(64%, 460px);

    opacity: 0.58;

    mask-image: linear-gradient(to right, transparent, #000 35%);

    svg {
      display: block;
      width: 100%;
      height: auto;
    }

    &[data-moving='false'] * {
      animation-play-state: paused;
    }

    &[data-variant='presentation'] {
      --qz-wheel-duration: 112s;

      inset-block-start: clamp(10px, 3vh, 34px);
      inset-inline-end: clamp(28px, 7vw, 112px);

      width: min(58vw, 820px);

      opacity: 0.55;
      filter: saturate(0.9);

      mask-image: linear-gradient(to bottom, #000 0%, #000 74%, transparent 100%);
    }

    @media (width <= 600px) {
      inset-block-start: 5px;
      inset-inline-end: -30px;
      width: 220px;
      opacity: 0.25;

      * {
        animation: none !important;
      }
    }

    @media (prefers-reduced-motion: reduce) {
      * {
        animation: none !important;
      }
    }

    @media (width <= 720px) {
      &[data-variant='presentation'] {
        inset-block-start: 12px;
        inset-inline-end: -86px;

        width: 350px;

        opacity: 0.13;

        mask-image: linear-gradient(to bottom, #000 0%, #000 70%, transparent 100%);
      }
    }
  `,
  rotor: css`
    transform-origin: 320px 278px;
    animation: ${turn} var(--qz-wheel-duration) linear infinite;
  `,
  cabin: css`
    transform-origin: 0 0;
    animation: ${counterTurn} var(--qz-wheel-duration) linear infinite;
  `,
  cabinSwing: css`
    transform-origin: 0 0;
    animation: ${cabinSwing} 7s ease-in-out var(--qz-cabin-delay, 0s) infinite;
  `,
  presentationMist: css`
    position: absolute;
    inset-block: 0;
    inset-inline: 0;

    width: 100%;
    height: 100%;

    color: ${cssVar.colorTextSecondary};

    opacity: 0.46;
    object-fit: cover;
    object-position: center bottom;

    mask-image: linear-gradient(to bottom, transparent 0%, #000 22%, #000 100%);
  `,
  presentationRipple: css`
    position: absolute;
    inset-block-start: min(57%, 440px);
    inset-inline-end: clamp(60px, 14vw, 230px);

    aspect-ratio: 3.2;
    width: min(40vw, 540px);

    span {
      position: absolute;
      inset: 18%;

      border: 1px solid rgb(62 175 179 / 26%);
      border-radius: 50%;

      opacity: 0;

      animation: ${ripple} 10s ease-out infinite;
    }

    span:nth-child(2) {
      animation-delay: 3.2s;
    }

    span:nth-child(3) {
      animation-delay: 6.4s;
    }
  `,
  presentationScene: css`
    pointer-events: none;
    user-select: none;

    position: absolute;
    z-index: 0;
    inset: 0;

    overflow: hidden;

    opacity: 1;

    transition:
      opacity 0.8s ease,
      visibility 0.8s ease;

    &[data-active='true'] [data-qz-ferris] {
      opacity: 0.62;
    }

    &[data-stage='intake'] {
      opacity: 0.62;
    }

    &[data-stage='outline'],
    &[data-stage='summary'] {
      visibility: hidden;
      opacity: 0;
    }

    @media (width <= 720px) {
      opacity: 0.68;

      * {
        animation: none !important;
      }
    }

    @media (prefers-reduced-motion: reduce) {
      * {
        animation: none !important;
      }
    }
  `,
  composer: css`
    position: relative;
    min-width: 0;

    &:focus-within [data-qz-leaf] {
      animation: ${settle} 1.4s ease-out both;
    }

    &:focus-within [data-testid='chat-input'] {
      box-shadow:
        0 0 0 1px rgb(77 169 164 / 20%),
        0 10px 28px rgb(69 150 160 / 5%);
    }
  `,
  ornaments: css`
    pointer-events: none;
    user-select: none;

    position: absolute;
    z-index: 2;
    inset: 0;

    svg {
      display: block;
      width: 100%;
      height: auto;
    }

    @media (prefers-reduced-motion: reduce) {
      * {
        animation: none !important;
      }
    }
  `,
  leafPendant: css`
    position: absolute;
    inset-block-start: -18px;
    inset-inline-end: 24px;
    transform-origin: 50% 0;

    width: 27px;

    color: ${cssVar.colorTextSecondary};

    opacity: 0.68;

    &::before {
      content: '';

      position: absolute;
      inset-block-start: -10px;
      inset-inline-start: 52%;

      width: 1px;
      height: 14px;

      background: linear-gradient(transparent, rgb(83 157 160 / 38%));
    }

    @media (width <= 600px) {
      inset-block-start: -14px;
      inset-inline-end: 20px;
      width: 22px;
    }
  `,
  waterline: css`
    position: absolute;
    inset-block-end: -6px;
    inset-inline-start: 28px;

    width: 72px;
    height: 8px;
    border-block-end: 1px solid rgb(70 175 188 / 18%);
    border-radius: 50%;

    color: ${cssVar.colorTextSecondary};

    opacity: 0.65;

    svg {
      position: absolute;
      inset-block-end: 1px;
      inset-inline-start: 22px;
      transform-origin: 50% 90%;

      width: 23px;

      animation: ${boatDrift} 6s ease-in-out infinite;
    }

    @media (width <= 600px) {
      display: none;
    }
  `,
}));
