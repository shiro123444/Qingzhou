import { createStaticStyles } from 'antd-style';

export const styles = createStaticStyles(({ css, cssVar }) => ({
  studio: css`
    --music-range-track: ${cssVar.colorFillSecondary};

    isolation: isolate;
    position: relative;

    container-type: inline-size;
    overflow: auto;
    flex: 1;

    width: 100%;
    min-width: 0;
    min-height: 0;

    color: ${cssVar.colorText};

    background: transparent;

    &[data-view='player'] {
      background:
        radial-gradient(
          ellipse at 16% 44%,
          color-mix(in srgb, var(--music-accent) 7%, transparent),
          transparent 55%
        ),
        radial-gradient(
          ellipse at 94% 90%,
          color-mix(in srgb, #aabca1 6%, transparent),
          transparent 50%
        ),
        transparent;
    }

    [hidden] {
      display: none !important;
    }

    button,
    input,
    select {
      font-family: inherit;
    }

    button:focus-visible,
    select:focus-visible,
    input:focus-visible {
      outline: 2px solid var(--music-accent);
      outline-offset: 4px;
    }

    button:disabled {
      cursor: default;
      opacity: 0.35;
    }

    input[type='range'] {
      cursor: pointer;

      min-width: 0;
      height: 4px;
      margin: 0;
      border: 0;
      border-radius: 4px;

      appearance: none;
      accent-color: var(--music-accent);
      background: var(--music-range-track);

      &::-webkit-slider-thumb {
        width: 10px;
        height: 10px;
        border: 0;
        border-radius: 50%;

        appearance: none;
        background: var(--music-accent);
      }

      &::-moz-range-thumb {
        width: 10px;
        height: 10px;
        border: 0;
        border-radius: 50%;

        background: var(--music-accent);
      }

      &:disabled {
        cursor: default;
        opacity: 0.5;
      }
    }
  `,
  inner: css`
    display: flex;
    flex-direction: column;

    box-sizing: border-box;
    width: 100%;
    min-height: 100%;
    padding-block: 12px 24px;
    padding-inline: 24px;

    @container (width <= 768px) {
      padding-block: 12px 108px;
      padding-inline: 20px;
    }

    @container (width <= 480px) {
      padding-block: 12px 120px;
      padding-inline: 16px;
    }
  `,
  header: css`
    display: flex;
    flex: none;
    gap: 16px;
    align-items: center;
    justify-content: space-between;

    min-width: 0;
    min-height: 42px;
    padding-block-end: 12px;
    border-block-end: 1px solid var(--qz-glass-border, ${cssVar.colorBorderSecondary});

    @container (width <= 960px) {
      flex-wrap: wrap;
      gap: 10px;
    }
  `,
  brand: css`
    display: flex;
    gap: 8px;
    align-items: center;
    min-width: 0;

    h1 {
      margin: 0;
      font-size: 15px;
      font-weight: 600;
      white-space: nowrap;
    }
  `,
  brandIcon: css`
    display: grid;
    flex: none;
    place-items: center;

    width: 28px;
    height: 28px;
    border-radius: ${cssVar.borderRadius};

    color: var(--music-accent);

    background: var(--qz-glass-surface);
    box-shadow: inset 0 1px 0 var(--qz-glass-highlight);
  `,
  tabs: css`
    display: flex;
    gap: 4px;
    align-items: center;

    @container (width <= 960px) {
      justify-content: center;
      order: 3;
      width: 100%;
    }

    @container (width <= 480px) {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 2px;
    }
  `,
  tab: css`
    cursor: pointer;

    position: relative;

    display: inline-flex;
    gap: 7px;
    align-items: center;
    justify-content: center;

    min-width: 0;
    min-height: 34px;
    padding-block: 6px;
    padding-inline: 12px;
    border: 1px solid transparent;
    border-radius: 18px;

    font-size: 13px;
    font-weight: 500;
    color: ${cssVar.colorTextSecondary};
    white-space: nowrap;

    background: transparent;

    > span:last-child {
      overflow: hidden;
      max-width: 100%;
      text-overflow: ellipsis;
    }

    &[aria-selected='true'] {
      border-color: var(--qz-glass-border);
      color: var(--music-accent);
      background: var(--qz-glass-strong);
      box-shadow:
        inset 0 1px 0 var(--qz-glass-highlight),
        0 3px 10px color-mix(in srgb, ${cssVar.colorText} 4%, transparent);
    }

    &:hover {
      color: ${cssVar.colorText};
      background: ${cssVar.colorFillTertiary};
    }

    @container (width <= 480px) {
      flex-direction: column;
      gap: 4px;

      min-height: 48px;
      padding-inline: 4px;

      font-size: 11px;
    }
  `,
  headerActions: css`
    display: flex;
    flex: none;
    gap: 8px;
    align-items: center;

    @container (width <= 480px) {
      gap: 10px;
    }
  `,
  closeButton: css`
    display: grid;
    flex: none;
    place-items: center;

    width: 32px;
    height: 32px;
    border-radius: ${cssVar.borderRadius};

    color: ${cssVar.colorTextSecondary};

    &:hover {
      color: ${cssVar.colorText};
      background: ${cssVar.colorFillTertiary};
    }
  `,
  uploadButton: css`
    flex: none;
    color: inherit;

    &:hover {
      color: inherit !important;
      background: color-mix(in srgb, currentcolor 8%, transparent) !important;
    }
  `,
  scene: css`
    display: grid;
    grid-template-columns: minmax(0, 43fr) minmax(0, 57fr);
    flex: 1;
    gap: clamp(32px, 5cqw, 80px);
    align-items: center;

    width: 100%;
    max-width: 1240px;
    min-height: calc(100dvh - 184px);
    margin-inline: auto;
    padding-block: 32px 24px;

    @container (width <= 880px) {
      grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
      gap: 30px;
    }

    @container (width <= 640px) {
      grid-template-columns: minmax(0, 1fr);
      gap: 26px;
      padding-block-start: 28px;
    }
  `,
  player: css`
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;

    width: 100%;
    min-width: 0;
    max-width: 400px;
    margin-inline: auto;
  `,
  cover: css`
    isolation: isolate;
    position: relative;

    overflow: hidden;
    display: grid;
    flex: none;
    place-items: center;

    aspect-ratio: 1;
    width: max(160px, min(360px, 33cqw, calc(100dvh - 340px)));
    max-width: 100%;
    border: 1px solid var(--qz-glass-border);
    border-radius: 30px;

    color: var(--music-cover-ink);

    background: var(--music-cover-bg);
    backdrop-filter: var(--qz-glass-filter);
    box-shadow:
      inset 0 1px 1px var(--qz-glass-highlight),
      inset 0 -1px 1px color-mix(in srgb, var(--music-accent) 16%, transparent),
      var(--qz-glass-shadow);

    &::before {
      pointer-events: none;
      content: '';

      position: absolute;
      z-index: -1;
      inset-block: 42% -30%;
      inset-inline: -20% -35%;
      transform: rotate(-18deg);

      border-block-start: 1px solid var(--qz-glass-highlight);
      border-radius: 50%;

      background: linear-gradient(
        175deg,
        color-mix(in srgb, var(--music-accent) 18%, transparent),
        transparent 70%
      );
    }

    img {
      width: 100%;
      height: 100%;
      object-fit: cover;
    }

    @container (width <= 640px) {
      width: min(70cqw, 300px);
    }
  `,
  trackInfo: css`
    width: 100%;
    min-width: 0;
    margin-block-start: 23px;
    text-align: center;
  `,
  trackTitle: css`
    overflow: hidden;

    max-width: 100%;
    margin: 0;

    font-size: clamp(18px, 1.6vw, 24px);
    font-weight: 600;
    line-height: 1.4;
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  trackDescription: css`
    margin-block: 7px 0;
    margin-inline: 0;

    font-size: 14px;
    line-height: 1.5;
    color: ${cssVar.colorTextSecondary};
  `,
  timeline: css`
    display: flex;
    gap: 12px;
    align-items: center;

    width: 100%;
    margin-block-start: 19px;

    font-size: 12px;
    font-variant-numeric: tabular-nums;
    color: ${cssVar.colorTextSecondary};

    input {
      flex: 1;
    }

    span {
      flex: none;
    }
  `,
  transport: css`
    display: flex;
    flex: none;
    gap: clamp(10px, 1.3vw, 22px);
    align-items: center;
    justify-content: center;

    width: 100%;
    margin-block-start: 20px;
  `,
  iconButton: css`
    cursor: pointer;

    display: grid;
    flex: none;
    place-items: center;

    width: 40px;
    height: 44px;
    padding: 0;
    border: 0;
    border-radius: ${cssVar.borderRadius};

    color: ${cssVar.colorTextSecondary};

    background: transparent;

    &:hover {
      color: ${cssVar.colorText};
      background: ${cssVar.colorFillTertiary};
    }

    &[data-active='true'] {
      color: var(--music-accent);
    }
  `,
  playButton: css`
    cursor: pointer;

    display: grid;
    flex: none;
    place-items: center;

    width: 48px;
    height: 48px;
    padding: 0;
    border: 1px solid var(--qz-glass-border);
    border-radius: 50%;

    color: var(--music-accent);

    background:
      radial-gradient(ellipse at 18% 0%, var(--qz-glass-highlight), transparent 62%),
      var(--qz-glass-strong);
    box-shadow:
      inset 0 1px 0 var(--qz-glass-highlight),
      0 4px 12px color-mix(in srgb, ${cssVar.colorText} 8%, transparent);

    &:hover {
      background-color: var(--music-accent-soft);
    }
  `,
  repeatControl: css`
    position: relative;

    display: grid;
    flex: none;
    place-items: center;

    width: 40px;
    height: 44px;

    color: ${cssVar.colorTextSecondary};

    &[data-active='true'] {
      color: var(--music-accent);
    }

    select {
      cursor: pointer;

      position: absolute;
      inset: 0;

      width: 100%;
      height: 100%;
      border: 0;

      opacity: 0;
    }

    span {
      position: absolute;
      inset-block-start: 4px;
      inset-inline-end: 3px;
      font-size: 10px;
    }

    &:focus-within {
      outline: 2px solid var(--music-accent);
      outline-offset: 2px;
    }
  `,
  playerFoot: css`
    display: flex;
    gap: 16px;
    align-items: center;
    justify-content: space-between;

    width: 100%;
    margin-block-start: 16px;

    font-size: 11px;
    color: ${cssVar.colorTextTertiary};
  `,
  queuePosition: css`
    cursor: pointer;

    display: flex;
    gap: 8px;
    align-items: center;

    padding-block: 4px;
    padding-inline: 0;
    border: 0;

    font-size: 11px;
    color: inherit;

    background: transparent;

    &:hover {
      color: ${cssVar.colorText};
    }
  `,
  status: css`
    overflow: hidden;
    max-width: 180px;
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  volume: css`
    display: flex;
    gap: 8px;
    align-items: center;

    input {
      width: 64px;
    }
  `,
  chooseButton: css`
    cursor: pointer;

    margin-block-start: 20px;
    padding-block: 8px;
    padding-inline: 18px;
    border: 1px solid ${cssVar.colorBorder};
    border-radius: ${cssVar.borderRadius};

    font-size: 12px;
    color: ${cssVar.colorText};

    background: transparent;

    &:hover {
      background: ${cssVar.colorFillTertiary};
    }
  `,
  lyricPanel: css`
    position: relative;
    align-self: stretch;
    min-width: 0;
    min-height: 480px;

    @container (width <= 640px) {
      min-height: 360px;
    }
  `,
  lyricToolbar: css`
    position: absolute;
    z-index: 1;
    inset-block-start: -14px;
    inset-inline-end: 0;

    button {
      color: ${cssVar.colorTextSecondary};

      &:hover {
        color: ${cssVar.colorText} !important;
        background: ${cssVar.colorFillTertiary} !important;
      }
    }
  `,
  collection: css`
    width: 100%;
    min-width: 0;
    max-width: 1400px;
    margin-inline: auto;
    padding-block-start: 32px;

    @container (width <= 680px) {
      padding-block-start: 30px;
    }
  `,
  collectionHeading: css`
    display: flex;
    gap: 14px;
    align-items: baseline;

    h2 {
      margin: 0;
      font-size: 24px;
      font-weight: 600;
    }

    span {
      font-size: 14px;
      color: ${cssVar.colorTextTertiary};
    }
  `,
  collectionToolbar: css`
    display: flex;
    gap: 20px;
    align-items: center;
    justify-content: space-between;

    margin-block: 28px 24px;

    @container (width <= 480px) {
      flex-wrap: wrap;
      gap: 14px;
    }
  `,
  sourceSelector: css`
    display: inline-flex;
    gap: 4px;

    padding: 4px;
    border: 1px solid var(--qz-glass-border);
    border-radius: 20px;

    background: var(--qz-glass-strong);

    button {
      cursor: pointer;

      padding-block: 8px;
      padding-inline: 18px;
      border: 0;
      border-radius: 16px;

      color: ${cssVar.colorTextSecondary};

      background: transparent;

      transition:
        background 180ms,
        color 180ms;
    }

    button[aria-pressed='true'] {
      color: ${cssVar.colorText};
      background: var(--music-range-track);
    }
  `,
  sourceNote: css`
    max-width: 340px;
    margin-block: 10px 0;

    font-size: 12px;
    line-height: 1.6;
    color: ${cssVar.colorTextTertiary};
    text-align: center;
  `,
  search: css`
    width: min(300px, 55%);
    border-color: ${cssVar.colorBorderSecondary};
    border-radius: 18px;

    background: var(--qz-glass-strong);
    box-shadow: inset 0 1px 0 var(--qz-glass-highlight);

    @container (width <= 480px) {
      order: 2;
      width: 100%;
    }
  `,
  loading: css`
    padding-block: 15px;
    font-size: 13px;
    color: ${cssVar.colorTextTertiary};
  `,
  emptyCollection: css`
    display: flex;
    flex-direction: column;
    gap: 12px;
    align-items: center;
    justify-content: center;

    min-height: 400px;
    padding-block: 40px;
    padding-inline: 22px;

    color: ${cssVar.colorTextTertiary};
    text-align: center;

    h3 {
      max-width: 430px;
      margin-block: 8px 0;
      margin-inline: 0;

      font-size: 17px;
      font-weight: 500;
      line-height: 1.6;
      color: ${cssVar.colorTextSecondary};
    }

    p {
      max-width: 360px;
      margin-block: 0 10px;
      margin-inline: 0;

      font-size: 13px;
      line-height: 1.7;
    }
  `,
  list: css`
    margin: 0;
    padding: 0;
    list-style: none;
  `,
  trackRow: css`
    display: flex;
    gap: 16px;
    align-items: center;

    min-width: 0;
    min-height: 74px;
    padding-block: 10px;
    padding-inline: 16px;
    border-radius: ${cssVar.borderRadius};

    &:nth-child(odd) {
      background: ${cssVar.colorFillQuaternary};
    }

    &:hover {
      background: ${cssVar.colorFillTertiary};
    }

    &[aria-current='true'] {
      color: var(--music-accent);
      background: var(--music-accent-soft);
    }

    @container (width <= 680px) {
      gap: 10px;
      padding-inline: 10px;
    }

    @container (width <= 420px) {
      flex-wrap: wrap;
    }
  `,
  rowNumber: css`
    flex: none;
    width: 24px;
    font-size: 12px;
    color: ${cssVar.colorTextQuaternary};

    @container (width <= 480px) {
      display: none;
    }
  `,
  trackArt: css`
    overflow: hidden;
    display: grid;
    flex: none;
    place-items: center;

    width: 44px;
    height: 44px;
    border-radius: ${cssVar.borderRadius};

    color: var(--music-cover-ink);

    background: var(--music-cover-bg);

    img {
      width: 100%;
      height: 100%;
      object-fit: cover;
    }
  `,
  rowInfo: css`
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 6px;

    min-width: 0;
  `,
  name: css`
    overflow: hidden;

    font-size: 14px;
    font-weight: 500;
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  fileMeta: css`
    font-size: 11px;
    color: ${cssVar.colorTextTertiary};
  `,
  fileSize: css`
    flex: none;
    width: 90px;
    font-size: 12px;
    color: ${cssVar.colorTextTertiary};

    @container (width <= 680px) {
      display: none;
    }
  `,
  rowActions: css`
    display: flex;
    flex: none;
    gap: 3px;
    align-items: center;

    @container (width <= 420px) {
      justify-content: flex-end;
      width: 100%;
    }
  `,
}));
