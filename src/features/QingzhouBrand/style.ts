import { createStaticStyles, keyframes } from 'antd-style';

const turn = keyframes`to { transform: rotate(360deg); }`;
const counterTurn = keyframes`to { transform: rotate(-360deg); }`;
const settle = keyframes`
  0% { transform: rotate(-3deg); }
  60% { transform: rotate(1deg); }
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

    mask-image: linear-gradient(to bottom, #000 0, #000 140px, transparent 300px);

    @media (width <= 600px) {
      inset-block: -10px 0;
      inset-inline: 0;
      min-height: 300px;

      mask-image: linear-gradient(to bottom, #000 0, #000 100px, transparent 240px);
    }
  `,
  ferris: css`
    --qz-wheel-duration: 160s;

    position: absolute;
    inset-block-start: 0;
    inset-inline-end: -12px;

    width: min(54%, 340px);

    opacity: 0.3;

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
      --qz-wheel-duration: 180s;

      inset-block-start: clamp(10px, 3vh, 34px);
      inset-inline-end: clamp(28px, 7vw, 112px);

      width: min(58vw, 820px);

      opacity: 0.32;
      filter: saturate(0.85);

      mask-image: linear-gradient(to bottom, #000 0%, #000 74%, transparent 100%);
    }

    @media (width <= 600px) {
      inset-block-start: 5px;
      inset-inline-end: -30px;
      width: 220px;
      opacity: 0.2;

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
  wheelWash: css`
    position: absolute;
    inset-block-end: 6%;
    inset-inline: 8%;

    width: 84%;
    height: auto;
  `,
  rotor: css`
    position: absolute;
    inset: 0;
    transform-origin: 50% 40%;
    animation: ${turn} var(--qz-wheel-duration) linear infinite;
  `,
  cabinAnchor: css`
    position: absolute;
    transform: translate(-50%, -7.35%);
    display: block;
    width: 11.5625%;
  `,
  cabin: css`
    transform-origin: 50% 7.35%;

    display: block;

    width: 100%;
    height: auto;

    animation: ${counterTurn} var(--qz-wheel-duration) linear infinite;
  `,
  presentationMist: css`
    position: absolute;
    inset-block: 0;
    inset-inline: 0;

    width: 100%;
    height: 100%;

    color: ${cssVar.colorTextSecondary};

    opacity: 0.18;
    object-fit: contain;
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
      opacity: 0.4;
    }

    &[data-stage='intake'] {
      opacity: 0.4;
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
      animation: ${settle} 0.7s ease-out both;
    }
  `,
  ornaments: css`
    pointer-events: none;
    user-select: none;

    position: absolute;
    z-index: 2;
    inset: 0;

    @media (prefers-reduced-motion: reduce) {
      * {
        animation: none !important;
      }
    }
  `,
  leafPendant: css`
    position: absolute;
    inset-block-start: -30px;
    inset-inline-end: 22px;
    transform-origin: 78% 18%;

    display: block;

    width: 46px;
    height: auto;

    opacity: 0.85;

    @media (width <= 600px) {
      inset-block-start: -25px;
      inset-inline-end: 16px;
      width: 40px;
    }
  `,
  harbor: css`
    pointer-events: none;
    display: block;
    width: 96px;
    margin-block-end: 4px;

    img {
      display: block;
      width: 100%;
      height: auto;
    }
  `,
}));
