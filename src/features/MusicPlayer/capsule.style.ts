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
    touch-action: none;
    cursor: grab;
    user-select: none;

    position: relative;

    display: flex;
    gap: 12px;
    align-items: center;

    box-sizing: border-box;
    width: 100%;
    height: 76px;
    padding-block: 12px;
    padding-inline: 12px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 16px;

    color: ${cssVar.colorText};

    background: color-mix(in srgb, ${cssVar.colorBgElevated} 88%, transparent);
    backdrop-filter: blur(22px) saturate(1.2);
    box-shadow:
      0 12px 32px color-mix(in srgb, ${cssVar.colorText} 8%, transparent),
      0 2px 6px color-mix(in srgb, ${cssVar.colorText} 4%, transparent);

    &:active {
      cursor: grabbing;
    }

    &:focus-visible {
      outline: 2px solid ${cssVar.colorPrimary};
      outline-offset: 3px;
    }

    @media (width <= 390px) {
      gap: 9px;
      padding-inline: 10px;
    }
  `,
  artworkLink: css`
    overflow: hidden;
    display: block;
    flex: none;

    width: 48px;
    height: 48px;
    padding: 0;
    border: 0;
    border-radius: 10px;

    background: transparent;

    &:focus-visible {
      outline: 2px solid ${cssVar.colorPrimary};
      outline-offset: 3px;
    }
  `,
  record: css`
    overflow: hidden;
    display: grid;
    place-items: center;

    width: 100%;
    height: 100%;
    border-radius: inherit;

    color: var(--music-cover-ink);

    background: var(--music-cover-bg);
  `,
  recordLabel: css`
    display: grid;
    place-items: center;
    color: var(--music-cover-ink);
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

      font-size: 14px;
      font-weight: 500;
      line-height: 1.4;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    > span {
      overflow: hidden;

      font-size: 12px;
      line-height: 1.4;
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
  iconButton: css`
    cursor: pointer;

    display: inline-flex;
    flex: none;
    align-items: center;
    justify-content: center;

    width: 28px;
    height: 30px;
    padding: 0;
    border: 0;
    border-radius: 8px;

    color: ${cssVar.colorTextSecondary};

    background: transparent;

    transition:
      color 150ms,
      background 150ms;

    &:hover {
      color: ${cssVar.colorText};
      background: ${cssVar.colorFillTertiary};
    }

    &:focus-visible {
      outline: 2px solid ${cssVar.colorPrimary};
      outline-offset: 2px;
    }

    &[aria-pressed='true'] {
      color: var(--music-accent);
      background: var(--music-accent-soft);
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

    color: ${cssVar.colorBgContainer};

    background: ${cssVar.colorText};

    transition: transform 150ms;

    &:hover {
      transform: scale(1.08);
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

    height: 42px;
  `,
  collapseButton: css`
    cursor: pointer;

    position: absolute;
    inset-block-end: -8px;
    inset-inline-end: 4px;

    display: grid;
    place-items: center;

    width: 20px;
    height: 16px;
    padding: 0;
    border: 0;

    color: ${cssVar.colorTextTertiary};

    background: transparent;

    &:hover {
      color: ${cssVar.colorText};
    }

    &:focus-visible {
      outline: 2px solid ${cssVar.colorPrimary};
    }
  `,
  progress: css`
    position: absolute;
    inset-block-end: 0;
    inset-inline: 13px;

    height: 2px;

    background: linear-gradient(
      to right,
      var(--music-accent) var(--music-progress),
      ${cssVar.colorFillSecondary} var(--music-progress)
    );

    input {
      cursor: pointer;

      position: absolute;
      inset-block-start: -6px;

      width: 100%;
      height: 14px;
      margin: 0;
      border: 0;

      appearance: none;
      background: transparent;

      &::-webkit-slider-thumb {
        width: 6px;
        height: 6px;
        border-radius: 1px;

        appearance: none;
        opacity: 0;
        background: var(--music-accent);
      }

      &::-moz-range-thumb {
        width: 6px;
        height: 6px;
        border: 0;
        border-radius: 1px;

        opacity: 0;
        background: var(--music-accent);
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
    user-select: none;

    position: relative;

    box-sizing: border-box;
    width: 60px;
    height: 60px;
    padding: 5px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 16px;

    background: color-mix(in srgb, ${cssVar.colorBgElevated} 88%, transparent);
    backdrop-filter: blur(22px);
    box-shadow: 0 8px 24px color-mix(in srgb, ${cssVar.colorText} 10%, transparent);

    > button {
      cursor: pointer;

      width: 100%;
      height: 100%;
      padding: 0;
      border: 0;
      border-radius: 11px;

      background: transparent;
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

    background: var(--music-accent);
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
    border-radius: 16px;

    color: ${cssVar.colorText};

    background: color-mix(in srgb, ${cssVar.colorBgElevated} 94%, transparent);
    backdrop-filter: blur(24px);
    box-shadow: 0 14px 42px color-mix(in srgb, ${cssVar.colorText} 12%, transparent);

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

      font-size: 13px;
      font-weight: 500;
    }

    small {
      margin-inline-start: 3px;
      font-size: 11px;
      color: ${cssVar.colorTextTertiary};
    }

    a {
      display: grid;
      place-items: center;

      width: 26px;
      height: 26px;

      color: ${cssVar.colorTextSecondary};
    }

    a:hover {
      color: ${cssVar.colorText};
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
    border-radius: 8px;

    font: inherit;
    font-size: 12px;
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
      background: var(--music-accent-soft);
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

    background: var(--music-accent);
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

      accent-color: var(--music-accent);
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
