import { createStaticStyles } from 'antd-style';

export const styles = createStaticStyles(({ css, cssVar }) => ({
  studio: css`
    --music-accent: #69a5de;

    isolation: isolate;
    position: relative;

    overflow: auto;
    flex: 1;

    width: 100%;
    min-width: 0;
    min-height: 0;

    color: ${cssVar.colorText};

    background: ${cssVar.colorBgContainer};

    &[data-view='player'] {
      color: #f2f2f3;
      background: #434951;

      &::before {
        pointer-events: none;
        content: '';

        position: fixed;
        z-index: -1;
        inset: 0;

        background:
          radial-gradient(ellipse at 13% 22%, #858c94 0, transparent 36%),
          radial-gradient(ellipse at 72% 14%, #675256 0, transparent 39%),
          radial-gradient(ellipse at 54% 68%, #263f67 0, transparent 43%),
          radial-gradient(ellipse at 16% 85%, #625453 0, transparent 42%),
          radial-gradient(ellipse at 90% 85%, #555a5d 0, transparent 43%), #42474f;
        filter: blur(55px);
      }
    }

    [hidden] {
      display: none !important;
    }

    button,
    input,
    select {
      font: inherit;
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
      height: 3px;
      margin: 0;
      border: 0;
      border-radius: 2px;

      appearance: none;
      accent-color: var(--music-accent);
      background: rgb(255 255 255 / 28%);

      &::-webkit-slider-thumb {
        width: 7px;
        height: 7px;
        border: 0;
        border-radius: 1px;

        appearance: none;
        background: var(--music-accent);
      }

      &::-moz-range-thumb {
        width: 7px;
        height: 7px;
        border: 0;
        border-radius: 1px;

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
    padding-block: 26px 32px;
    padding-inline: 36px;

    @media (width <= 768px) {
      padding-block: 20px 108px;
      padding-inline: 22px;
    }

    @media (width <= 480px) {
      padding-block: 18px 120px;
      padding-inline: 18px;
    }
  `,
  header: css`
    display: flex;
    flex: none;
    gap: 20px;
    align-items: center;
    justify-content: space-between;

    min-width: 0;

    @media (width <= 680px) {
      flex-wrap: wrap;
      gap: 14px;
    }
  `,
  brand: css`
    display: flex;
    gap: 10px;
    align-items: center;
    min-width: 0;

    h1 {
      margin: 0;
      font-size: 17px;
      font-weight: 600;
      letter-spacing: 0.3px;
    }
  `,
  tabs: css`
    display: flex;
    gap: 28px;
    align-items: center;

    @media (width <= 680px) {
      justify-content: center;
      order: 3;
      width: 100%;
    }
  `,
  tab: css`
    cursor: pointer;

    position: relative;

    padding-block: 12px;
    padding-inline: 0;
    border: 0;

    font-size: 13px;
    font-weight: 500;
    color: inherit;

    opacity: 0.55;
    background: transparent;

    &[aria-selected='true'] {
      opacity: 1;

      &::after {
        content: '';

        position: absolute;
        inset-block-end: 3px;
        inset-inline: 25%;

        height: 2px;
        border-radius: 2px;

        background: currentcolor;
      }
    }

    &:hover {
      opacity: 1;
    }
  `,
  headerActions: css`
    display: flex;
    flex: none;
    gap: 18px;
    align-items: center;

    @media (width <= 480px) {
      gap: 10px;
    }
  `,
  closeButton: css`
    display: grid;
    flex: none;
    place-items: center;

    width: 34px;
    height: 34px;

    color: inherit;

    opacity: 0.85;

    &:hover {
      transform: translateY(2px);
      color: inherit;
      opacity: 1;
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
    gap: clamp(40px, 6vw, 100px);
    align-items: center;

    width: 100%;
    max-width: 1520px;
    min-height: calc(100dvh - 206px);
    margin-inline: auto;
    padding-block: 40px 24px;

    @media (width <= 880px) {
      grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
      gap: 30px;
    }

    @media (width <= 680px) {
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
    max-width: 470px;
    margin-inline: auto;
  `,
  cover: css`
    display: grid;
    flex: none;
    place-items: center;

    aspect-ratio: 1;
    width: max(160px, min(400px, 33vw, calc(100dvh - 330px)));
    max-width: 100%;
    border-radius: 10px;

    color: rgb(225 232 242 / 72%);

    background:
      radial-gradient(ellipse at 20% 10%, rgb(143 165 182 / 38%), transparent 65%),
      linear-gradient(145deg, #637382, #394654 65%, #344552);
    box-shadow:
      0 16px 34px rgb(0 0 0 / 24%),
      0 2px 8px rgb(0 0 0 / 12%);

    @media (width <= 680px) {
      width: min(72vw, 340px);
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
    color: rgb(255 255 255 / 60%);
  `,
  timeline: css`
    display: flex;
    gap: 12px;
    align-items: center;

    width: 100%;
    margin-block-start: 19px;

    font-size: 12px;
    font-variant-numeric: tabular-nums;
    color: rgb(255 255 255 / 86%);

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

    color: #f2f2f3;

    background: transparent;

    &:hover {
      transform: scale(1.08);
      color: white;
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
    border: 0;

    color: #f2f2f3;

    background: transparent;

    &:hover {
      transform: scale(1.08);
      color: white;
    }
  `,
  repeatControl: css`
    position: relative;

    display: grid;
    flex: none;
    place-items: center;

    width: 40px;
    height: 44px;

    color: #f2f2f3;

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
    color: rgb(255 255 255 / 55%);
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
      color: white;
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
    border: 1px solid rgb(255 255 255 / 24%);
    border-radius: 5px;

    font-size: 12px;
    color: rgb(255 255 255 / 90%);

    background: transparent;

    &:hover {
      background: rgb(255 255 255 / 8%);
    }
  `,
  lyricPanel: css`
    position: relative;
    align-self: stretch;
    min-width: 0;
    min-height: 540px;

    @media (width <= 680px) {
      min-height: 360px;
    }
  `,
  lyricToolbar: css`
    position: absolute;
    z-index: 1;
    inset-block-start: -14px;
    inset-inline-end: 0;

    button {
      color: rgb(255 255 255 / 54%);

      &:hover {
        color: white !important;
        background: rgb(255 255 255 / 7%) !important;
      }
    }
  `,
  lyrics: css`
    scrollbar-width: none;

    position: absolute;
    inset-block: 12px 0;
    inset-inline: 0;

    overflow: auto;
    overscroll-behavior: contain;

    box-sizing: border-box;
    padding-block: 100px 180px;
    padding-inline: 16px;

    text-align: center;

    mask-image: linear-gradient(transparent, #000 12%, #000 84%, transparent);

    &::-webkit-scrollbar {
      display: none;
    }

    &[data-empty='true'] {
      display: grid;
      place-items: center;
      padding-block: 50px;
    }

    p {
      scroll-margin-block: 100px;

      margin-block: 0 34px;
      margin-inline: 0;

      font-size: clamp(22px, 2.3vw, 34px);
      font-weight: 500;
      line-height: 1.7;
      color: rgb(255 255 255 / 56%);
      overflow-wrap: anywhere;

      transition: color 0.3s ease;

      &[aria-current='true'] {
        color: var(--music-accent);
      }
    }

    button {
      cursor: pointer;

      width: 100%;
      padding: 0;
      border: 0;

      font: inherit;
      color: inherit;

      background: transparent;

      &:hover {
        color: white;
      }
    }

    @media (width <= 680px) {
      padding-block: 70px 100px;
      padding-inline: 0;

      p {
        margin-block-end: 24px;
        font-size: 23px;
      }
    }

    @media (prefers-reduced-motion: reduce) {
      p {
        transition: none;
      }
    }
  `,
  emptyLyrics: css`
    max-width: 340px;

    p {
      margin-block-end: 18px;
      font-size: clamp(22px, 2.3vw, 32px);
      font-weight: 400;
      color: rgb(255 255 255 / 76%);
    }

    span {
      display: block;
      font-size: 13px;
      line-height: 1.9;
      color: rgb(255 255 255 / 36%);
    }
  `,
  collection: css`
    width: 100%;
    min-width: 0;
    max-width: 1400px;
    margin-inline: auto;
    padding-block-start: 46px;

    @media (width <= 680px) {
      padding-block-start: 30px;
    }
  `,
  collectionHeading: css`
    display: flex;
    gap: 14px;
    align-items: baseline;

    h2 {
      margin: 0;
      font-size: 30px;
      font-weight: 650;
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

    @media (width <= 480px) {
      flex-wrap: wrap;
      gap: 14px;
    }
  `,
  search: css`
    width: min(300px, 55%);
    border-color: ${cssVar.colorBorderSecondary};
    background: ${cssVar.colorFillQuaternary};

    @media (width <= 480px) {
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
    border-radius: 5px;

    &:nth-child(odd) {
      background: ${cssVar.colorFillQuaternary};
    }

    &:hover {
      background: ${cssVar.colorFillTertiary};
    }

    &[aria-current='true'] {
      color: #568fbe;
    }

    @media (width <= 680px) {
      gap: 10px;
      padding-inline: 10px;
    }

    @media (width <= 420px) {
      flex-wrap: wrap;
    }
  `,
  rowNumber: css`
    flex: none;
    width: 24px;
    font-size: 12px;
    color: ${cssVar.colorTextQuaternary};

    @media (width <= 480px) {
      display: none;
    }
  `,
  trackArt: css`
    display: grid;
    flex: none;
    place-items: center;

    width: 44px;
    height: 44px;
    border-radius: 4px;

    color: #d9e2eb;

    background: linear-gradient(145deg, #748796, #425466);
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

    @media (width <= 680px) {
      display: none;
    }
  `,
  rowActions: css`
    display: flex;
    flex: none;
    gap: 3px;
    align-items: center;

    @media (width <= 420px) {
      justify-content: flex-end;
      width: 100%;
    }
  `,
}));
