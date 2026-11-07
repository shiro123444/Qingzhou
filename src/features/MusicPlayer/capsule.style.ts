import { createStaticStyles } from 'antd-style';

export const styles = createStaticStyles(({ css, cssVar }) => ({
  dock: css`
    pointer-events: none;

    position: fixed;
    z-index: 90;
    inset-block-end: max(24px, env(safe-area-inset-bottom));
    inset-inline-end: 24px;

    display: flex;
    flex-direction: column;
    gap: 12px;
    align-items: flex-end;

    width: min(380px, calc(100vw - 48px));

    > * {
      pointer-events: auto;
    }

    &[data-dragging='true'] {
      user-select: none;
    }

    &[data-collapsed='false'] {
      inset-block-end: max(108px, calc(env(safe-area-inset-bottom) + 96px));
    }

    @media (width <= 600px) {
      inset-block-end: max(12px, env(safe-area-inset-bottom));
      inset-inline-end: 12px;
      width: min(350px, calc(100vw - 24px));

      &[data-collapsed='false'] {
        inset-block-end: max(104px, calc(env(safe-area-inset-bottom) + 88px));
      }
    }
  `,
  capsule: css`
    position: relative;

    display: flex;
    gap: 9px;
    align-items: center;

    width: 100%;
    height: 76px;
    padding-block: 10px 12px;
    padding-inline: 10px;
    border: 1px solid color-mix(in srgb, #4f99ad 18%, ${cssVar.colorBorderSecondary});
    border-radius: 42px;

    color: ${cssVar.colorText};

    background:
      radial-gradient(ellipse at 12% 100%, rgb(79 153 173 / 10%), transparent 65%),
      color-mix(in srgb, ${cssVar.colorBgElevated} 90%, transparent);
    backdrop-filter: blur(24px) saturate(1.3);
    box-shadow:
      0 12px 40px rgb(20 69 82 / 12%),
      0 2px 8px rgb(0 0 0 / 5%),
      inset 0 1px 0 rgb(255 255 255 / 15%);

    @media (width <= 390px) {
      gap: 8px;
      padding-inline: 10px 8px;
    }
  `,
  artworkLink: css`
    flex: none;
    width: 45px;
    height: 45px;
    border-radius: 14px;
  `,
  record: css`
    position: relative;

    overflow: hidden;
    display: grid;
    place-items: center;

    width: 100%;
    height: 100%;
    border: 1px solid rgb(255 255 255 / 20%);
    border-radius: inherit;

    background:
      radial-gradient(ellipse at 24% 12%, #d6e8df 0, transparent 60%),
      linear-gradient(150deg, #8fc7cf, #448999 55%, #195c6d);
    box-shadow: 0 2px 6px rgb(20 69 82 / 12%);

    &::after {
      pointer-events: none;
      content: '';

      position: absolute;
      inset-block: 55% -75%;
      inset-inline: -30%;
      transform: rotate(-12deg);

      border: 1px solid rgb(224 246 244 / 35%);
      border-radius: 50%;

      box-shadow: 0 -5px 0 rgb(224 246 244 / 10%);
    }

    &[data-playing='true']::after {
      animation: qingzhou-capsule-water 4s ease-in-out infinite alternate;
    }

    @keyframes qingzhou-capsule-water {
      to {
        transform: translateY(4px) rotate(-4deg);
      }
    }

    @media (prefers-reduced-motion: reduce) {
      &::after {
        animation: none;
      }
    }
  `,
  recordLabel: css`
    position: relative;
    z-index: 1;

    display: grid;
    place-items: center;

    color: #eff9f7;
  `,
  track: css`
    overflow: hidden;
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 5px;

    min-width: 0;

    color: inherit;
    text-decoration: none;

    strong {
      overflow: hidden;

      font-size: 12px;
      font-weight: 600;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    > span {
      overflow: hidden;

      font-size: 10px;
      color: ${cssVar.colorTextTertiary};
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    &:hover {
      color: ${cssVar.colorText};
    }
  `,
  transport: css`
    display: flex;
    flex: none;
    gap: 2px;
    align-items: center;
  `,
  dragHandle: css`
    touch-action: none;
    cursor: grab;

    display: grid;
    flex: none;
    place-items: center;

    width: 24px;
    height: 38px;
    padding: 0;
    border: 0;
    border-radius: 8px;

    color: ${cssVar.colorTextQuaternary};

    background: transparent;

    &:hover,
    &:focus-visible {
      color: #4f99ad;
      background: color-mix(in srgb, #4f99ad 9%, transparent);
    }

    &:active {
      cursor: grabbing;
    }

    &:focus-visible {
      outline: 2px solid ${cssVar.colorPrimary};
      outline-offset: 1px;
    }
  `,
  iconButton: css`
    cursor: pointer;

    display: inline-flex;
    flex: none;
    align-items: center;
    justify-content: center;

    width: 28px;
    height: 28px;
    padding: 0;
    border: 0;
    border-radius: 50%;

    color: ${cssVar.colorTextSecondary};

    background: transparent;

    transition:
      background 150ms,
      color 150ms;

    &:hover {
      color: ${cssVar.colorText};
      background: ${cssVar.colorFillSecondary};
    }

    &:focus-visible {
      outline: 2px solid ${cssVar.colorPrimary};
      outline-offset: 2px;
    }

    &[aria-pressed='true'] {
      color: #4f99ad;
      background: color-mix(in srgb, #4f99ad 10%, transparent);
    }
  `,
  secondaryTransport: css`
    @media (width <= 390px) {
      width: 23px;
    }
  `,
  playButton: css`
    cursor: pointer;

    display: grid;
    flex: none;
    place-items: center;

    width: 36px;
    height: 36px;
    padding: 0;
    border: 0;
    border-radius: 50%;

    color: #f3faf8;

    background: #286c7c;

    transition: transform 150ms;

    &:hover {
      transform: scale(1.06);
    }

    &:focus-visible {
      outline: 2px solid ${cssVar.colorPrimary};
      outline-offset: 3px;
    }
  `,
  utilities: css`
    position: relative;

    display: flex;
    flex: none;
    align-items: center;

    padding-inline-end: 5px;
  `,
  collapseButton: css`
    cursor: pointer;

    position: absolute;
    inset-block-end: -13px;
    inset-inline-end: -2px;

    display: grid;
    place-items: center;

    width: 20px;
    height: 18px;
    padding: 0;
    border: 0;
    border-radius: 8px;

    color: ${cssVar.colorTextTertiary};

    background: transparent;

    &:hover {
      color: ${cssVar.colorText};
      background: ${cssVar.colorFillSecondary};
    }

    &:focus-visible {
      outline: 2px solid ${cssVar.colorPrimary};
    }
  `,
  progress: css`
    position: absolute;
    inset-block-end: 6px;
    inset-inline: 72px 45px;

    height: 3px;
    border-radius: 4px;

    background: linear-gradient(
      to right,
      #4f99ad var(--music-progress),
      ${cssVar.colorFillSecondary} var(--music-progress)
    );

    input {
      cursor: pointer;

      position: absolute;
      inset-block-start: -5px;

      width: 100%;
      height: 13px;
      margin: 0;
      border: 0;

      appearance: none;
      background: transparent;

      &::-webkit-slider-thumb {
        width: 9px;
        height: 9px;
        border-radius: 50%;

        appearance: none;
        opacity: 0;
        background: #4f99ad;
      }

      &::-moz-range-thumb {
        width: 9px;
        height: 9px;
        border: 0;
        border-radius: 50%;

        opacity: 0;
        background: #4f99ad;
      }

      &:hover::-webkit-slider-thumb,
      &:focus-visible::-webkit-slider-thumb {
        opacity: 1;
      }

      &:hover::-moz-range-thumb,
      &:focus-visible::-moz-range-thumb {
        opacity: 1;
      }

      &:focus-visible {
        outline: 2px solid ${cssVar.colorPrimary};
        outline-offset: 1px;
      }
    }
  `,
  orb: css`
    touch-action: none;
    cursor: grab;

    position: relative;

    width: 60px;
    height: 60px;
    padding: 5px;
    border: 1px solid color-mix(in srgb, ${cssVar.colorText} 12%, transparent);
    border-radius: 21px;

    background: color-mix(in srgb, ${cssVar.colorBgElevated} 90%, transparent);
    backdrop-filter: blur(18px);
    box-shadow: 0 10px 30px rgb(20 69 82 / 15%);

    &:hover {
      border-color: color-mix(in srgb, #4f99ad 55%, transparent);
    }

    &:active {
      cursor: grabbing;
    }

    &:focus-visible {
      outline: 2px solid ${cssVar.colorPrimary};
      outline-offset: 3px;
    }
  `,
  orbIndicator: css`
    position: absolute;
    inset-block-end: 3px;
    inset-inline-end: 3px;

    width: 9px;
    height: 9px;
    border: 2px solid ${cssVar.colorBgContainer};
    border-radius: 50%;

    background: #4f99ad;
  `,
  panel: css`
    position: absolute;
    inset-block-end: calc(100% + 12px);
    inset-inline-end: 0;

    overflow: auto;
    overscroll-behavior: contain;

    width: 100%;
    max-height: var(--music-panel-max-height, calc(100dvh - 120px));
    padding: 16px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 24px;

    color: ${cssVar.colorText};

    background: color-mix(in srgb, ${cssVar.colorBgElevated} 94%, transparent);
    backdrop-filter: blur(24px);
    box-shadow: 0 14px 48px rgb(0 0 0 / 16%);

    [data-panel-side='below'] & {
      inset-block: calc(100% + 12px) auto;
    }
  `,
  panelHeading: css`
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-block-end: 12px;

    > span {
      display: inline-flex;
      gap: 8px;
      align-items: center;

      font-size: 12px;
      font-weight: 600;
    }

    small {
      min-width: 20px;
      padding-block: 2px;
      padding-inline: 6px;
      border-radius: 12px;

      font-size: 10px;
      text-align: center;

      background: ${cssVar.colorFillSecondary};
    }

    a {
      display: grid;
      place-items: center;

      width: 26px;
      height: 26px;
      border-radius: 8px;

      color: ${cssVar.colorTextSecondary};
    }

    a:hover {
      background: ${cssVar.colorFillSecondary};
    }
  `,
  queue: css`
    overflow: auto;

    max-height: min(250px, calc(100dvh - 310px));
    margin: 0;
    padding: 0;

    list-style: none;
  `,
  queueTrack: css`
    cursor: pointer;

    display: flex;
    gap: 10px;
    align-items: center;

    width: 100%;
    padding-block: 9px;
    padding-inline: 8px;
    border: 0;
    border-radius: 10px;

    font: inherit;
    font-size: 11px;
    color: ${cssVar.colorTextSecondary};
    text-align: start;

    background: transparent;

    > span:nth-child(2) {
      overflow: hidden;
      flex: 1;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    &:hover {
      background: ${cssVar.colorFillSecondary};
    }

    &[aria-current='true'] {
      color: ${cssVar.colorText};
      background: color-mix(in srgb, #4f99ad 8%, transparent);
    }

    &:focus-visible {
      outline: 2px solid ${cssVar.colorPrimary};
      outline-offset: -2px;
    }
  `,
  queueNumber: css`
    display: grid;
    flex: none;
    place-items: center;

    width: 18px;

    font-size: 10px;
    color: ${cssVar.colorTextTertiary};
  `,
  activeDot: css`
    flex: none;

    width: 5px;
    height: 5px;
    border-radius: 50%;

    background: #4f99ad;
  `,
  settings: css`
    display: flex;
    gap: 8px;
    align-items: center;

    margin-block-start: 12px;
    padding-block-start: 12px;
    border-block-start: 1px solid ${cssVar.colorBorderSecondary};
  `,
  volume: css`
    display: flex;
    flex: 1;
    gap: 10px;
    align-items: center;

    min-width: 0;
    margin-inline-start: 10px;

    color: ${cssVar.colorTextSecondary};

    input {
      flex: 1;

      width: 100%;
      min-width: 0;
      height: 3px;

      accent-color: #4f99ad;
    }
  `,
  empty: css`
    margin-block: 20px;
    margin-inline: 4px;

    font-size: 12px;
    line-height: 1.7;
    color: ${cssVar.colorTextTertiary};
  `,
  notice: css`
    margin-block: 12px 0;
    margin-inline: 4px;

    font-size: 10px;
    line-height: 1.5;
    color: ${cssVar.colorWarning};
  `,
}));
