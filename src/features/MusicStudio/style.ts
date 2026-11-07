import { createStaticStyles, keyframes } from 'antd-style';

const turn = keyframes`
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
`;

export const styles = createStaticStyles(({ css, cssVar }) => ({
  studio: css`
    --music-accent: #4caea4;

    overflow: auto;
    flex: 1;

    width: 100%;
    min-width: 0;
    min-height: 0;

    color: ${cssVar.colorText};

    background:
      radial-gradient(
        ellipse at 30% 0%,
        color-mix(in srgb, #5abcb1 6%, transparent),
        transparent 55%
      ),
      ${cssVar.colorBgLayout};

    input[type='range'] {
      cursor: pointer;
      accent-color: var(--music-accent);
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
  `,
  inner: css`
    box-sizing: border-box;
    width: 100%;
    max-width: 1480px;
    margin-inline: auto;
    padding-block: 34px 160px;
    padding-inline: 40px;

    @media (width <= 768px) {
      padding-block: 24px 150px;
      padding-inline: 22px;
    }

    @media (width <= 480px) {
      padding-block: 22px 150px;
      padding-inline: 16px;
    }
  `,
  header: css`
    display: flex;
    gap: 16px;
    align-items: center;
    justify-content: space-between;

    margin-block-end: 30px;

    @media (width <= 480px) {
      gap: 10px;
    }
  `,
  brand: css`
    display: flex;
    gap: 13px;
    align-items: center;
    min-width: 0;

    h1 {
      margin-block: 5px 0;
      margin-inline: 0;

      font-size: 25px;
      font-weight: 650;
      letter-spacing: -0.8px;
    }

    @media (width <= 480px) {
      gap: 10px;

      h1 {
        font-size: 21px;
      }
    }
  `,
  brandIcon: css`
    display: grid;
    flex: none;
    place-items: center;

    width: 44px;
    height: 44px;
    border: 1px solid color-mix(in srgb, var(--music-accent) 18%, ${cssVar.colorBorderSecondary});
    border-radius: 15px;

    color: var(--music-accent);

    background: color-mix(in srgb, var(--music-accent) 9%, ${cssVar.colorBgContainer});
  `,
  eyebrow: css`
    margin: 0;

    font-size: 9px;
    font-weight: 600;
    color: ${cssVar.colorTextTertiary};
    letter-spacing: 1.6px;
  `,
  uploadButton: css`
    flex: none;
    border-color: ${cssVar.colorBorderSecondary};
    border-radius: 12px;
    background: color-mix(in srgb, ${cssVar.colorBgContainer} 70%, transparent);
  `,
  deck: css`
    overflow: hidden;
    display: grid;
    grid-template-columns: minmax(0, 1.45fr) minmax(260px, 1fr);

    min-width: 0;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 28px;

    background: color-mix(in srgb, ${cssVar.colorBgContainer} 86%, transparent);
    box-shadow: 0 18px 64px color-mix(in srgb, ${cssVar.colorText} 3%, transparent);

    @media (width <= 1180px) {
      grid-template-columns: minmax(0, 1fr);
    }

    @media (width <= 480px) {
      border-radius: 23px;
    }
  `,
  player: css`
    display: flex;
    flex-direction: column;

    min-width: 0;
    padding-block: 26px 20px;
    padding-inline: 28px;

    @media (width <= 480px) {
      padding-block: 22px 18px;
      padding-inline: 20px;
    }
  `,
  playerTopline: css`
    display: flex;
    gap: 12px;
    align-items: center;
    justify-content: space-between;
  `,
  sectionLabel: css`
    font-size: 12px;
    font-weight: 500;
    color: ${cssVar.colorTextSecondary};
  `,
  status: css`
    display: inline-flex;
    gap: 6px;
    align-items: center;

    font-size: 10px;
    color: ${cssVar.colorTextTertiary};

    &[data-playing='true'] {
      color: var(--music-accent);
    }
  `,
  statusDot: css`
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: currentcolor;
  `,
  playerBody: css`
    display: grid;
    grid-template-columns: minmax(160px, 0.92fr) minmax(0, 1fr);
    flex: 1;
    gap: 28px;
    align-items: center;

    min-width: 0;
    padding-block: 32px 28px;

    @media (width <= 640px) {
      grid-template-columns: minmax(0, 1fr);
      gap: 26px;
      padding-block: 28px;
    }
  `,
  artwork: css`
    isolation: isolate;
    position: relative;

    aspect-ratio: 1;
    width: min(100%, 260px);
    margin: auto;

    @media (width <= 640px) {
      width: 220px;
    }

    @media (width <= 390px) {
      width: 196px;
    }
  `,
  artworkGlow: css`
    position: absolute;
    z-index: -1;
    inset: -14%;

    border-radius: 50%;

    background: radial-gradient(
      circle,
      color-mix(in srgb, var(--music-accent) 21%, transparent),
      transparent 68%
    );
    filter: blur(18px);
  `,
  vinyl: css`
    position: relative;

    display: grid;
    place-items: center;

    width: 100%;
    height: 100%;
    border: 1px solid #343f3d;
    border-radius: 50%;

    background:
      conic-gradient(
        from 40deg,
        transparent 0deg,
        #c9ddd417 40deg,
        transparent 85deg,
        #0105035e 170deg,
        #d4e5da19 220deg,
        transparent 275deg
      ),
      repeating-radial-gradient(circle, #202724 0, #202724 1px, #171e1b 2px, #171e1b 4px);
    box-shadow:
      inset 0 0 0 7px #1a211e,
      inset 0 0 0 8px #35413b,
      0 20px 32px #0003;

    animation: ${turn} 30s linear infinite;
    animation-play-state: paused;

    &::after {
      content: '';

      position: absolute;
      inset: 49%;

      border: 1px solid #e4e7db;
      border-radius: 50%;

      background: #25302b;
    }

    &[data-playing='true'] {
      animation-play-state: running;
    }

    @media (prefers-reduced-motion: reduce) {
      animation: none;
    }
  `,
  vinylLabel: css`
    display: grid;
    place-items: center;

    width: 35%;
    height: 35%;
    border: 1px solid #78c8bb;
    border-radius: 50%;

    color: #d5eee4;

    background: radial-gradient(circle at 30% 25%, #a5d3b8, #4b9283 55%, #285e56);
    box-shadow: 0 0 0 4px #101a1455;

    svg {
      margin-block-start: -8px;
      opacity: 0.75;
    }
  `,
  tonearm: css`
    position: absolute;
    inset-block-start: 1%;
    inset-inline-end: 2%;
    transform-origin: right center;
    transform: rotate(38deg);

    width: 38%;
    height: 10px;
    border: 1px solid #9caba8;
    border-radius: 7px;

    background: linear-gradient(0deg, #526562, #ced8cc 50%, #849b94);
    box-shadow: 0 3px 8px #0002;

    &::after {
      content: '';

      position: absolute;
      inset-block-start: -3px;
      inset-inline-start: -8px;

      width: 26px;
      height: 16px;
      border: 1px solid #4b625a;
      border-radius: 4px;

      background: #263e35;
    }
  `,
  trackInfo: css`
    min-width: 0;

    @media (width <= 640px) {
      text-align: center;
    }
  `,
  trackOrigin: css`
    margin-block: 0 8px;
    margin-inline: 0;
    font-size: 11px;
    color: ${cssVar.colorTextTertiary};
  `,
  trackTitle: css`
    overflow: hidden;
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;

    margin: 0;

    font-size: clamp(21px, 2vw, 29px);
    font-weight: 600;
    line-height: 1.35;
    letter-spacing: -0.7px;
    overflow-wrap: anywhere;
  `,
  trackDescription: css`
    margin-block: 10px 0;
    margin-inline: 0;

    font-size: 11px;
    line-height: 1.7;
    color: ${cssVar.colorTextTertiary};
  `,
  timeline: css`
    margin-block-start: 26px;

    input {
      display: block;
      width: 100%;
      height: 3px;
      margin: 0;
    }

    input:disabled {
      cursor: default;
      opacity: 0.35;
    }
  `,
  timestamps: css`
    display: flex;
    justify-content: space-between;

    margin-block-start: 10px;

    font-size: 10px;
    font-variant-numeric: tabular-nums;
    color: ${cssVar.colorTextTertiary};
  `,
  transport: css`
    display: flex;
    gap: 7px;
    align-items: center;
    justify-content: center;

    margin-block-start: 16px;
  `,
  iconButton: css`
    cursor: pointer;

    display: grid;
    flex: none;
    place-items: center;

    width: 31px;
    height: 34px;
    padding: 0;
    border: 0;
    border-radius: 50%;

    color: ${cssVar.colorTextSecondary};

    background: transparent;

    transition:
      color 160ms,
      background 160ms;

    &:hover {
      color: ${cssVar.colorText};
      background: ${cssVar.colorFillTertiary};
    }

    &[data-active='true'] {
      color: var(--music-accent);
    }

    &:disabled {
      cursor: default;
      opacity: 0.3;
    }
  `,
  playButton: css`
    cursor: pointer;

    display: grid;
    flex: none;
    place-items: center;

    width: 54px;
    height: 54px;
    margin-inline: 5px;
    padding: 0;
    border: 1px solid color-mix(in srgb, var(--music-accent) 70%, white);
    border-radius: 50%;

    color: #f2fffb;

    background: linear-gradient(145deg, #6ec3b3, #35988f);
    box-shadow: 0 6px 18px #318d8330;

    transition:
      transform 160ms,
      box-shadow 160ms;

    &:hover {
      transform: scale(1.045);
      box-shadow: 0 8px 22px #318d8345;
    }

    &:active {
      transform: scale(0.98);
    }

    &:disabled {
      cursor: default;
      transform: none;
      opacity: 0.42;
      box-shadow: none;
    }
  `,
  repeatControl: css`
    position: relative;

    display: grid;
    flex: none;
    place-items: center;

    width: 31px;
    height: 34px;

    color: ${cssVar.colorTextSecondary};

    &[data-active='true'] {
      color: var(--music-accent);
    }

    &:focus-within {
      border-radius: 8px;
      outline: 2px solid var(--music-accent);
      outline-offset: 4px;
    }

    select {
      cursor: pointer;

      position: absolute;
      inset: 0;

      width: 100%;
      height: 100%;

      opacity: 0;
    }

    span {
      position: absolute;
      inset-block-start: 1px;
      inset-inline-end: 1px;
      font-size: 8px;
    }
  `,
  playerFoot: css`
    display: flex;
    gap: 12px;
    align-items: center;
    justify-content: space-between;

    margin-block-start: 20px;
  `,
  queuePosition: css`
    display: flex;
    gap: 7px;
    align-items: center;

    font-size: 10px;
    font-variant-numeric: tabular-nums;
    color: ${cssVar.colorTextTertiary};
  `,
  volume: css`
    display: flex;
    gap: 8px;
    align-items: center;

    width: 102px;

    color: ${cssVar.colorTextTertiary};

    input {
      flex: 1;
      width: 0;
      height: 3px;
      margin: 0;
    }
  `,
  continuousHint: css`
    display: flex;
    gap: 7px;
    align-items: center;
    justify-content: center;

    padding-block-start: 13px;
    border-block-start: 1px solid ${cssVar.colorBorderSecondary};

    font-size: 10px;
    line-height: 1.6;
    color: ${cssVar.colorTextTertiary};

    span {
      flex: none;

      width: 4px;
      height: 4px;
      border-radius: 50%;

      background: var(--music-accent);
    }
  `,
  lyricPanel: css`
    display: flex;
    flex-direction: column;

    min-width: 0;
    padding-block: 26px 22px;
    padding-inline: 26px;
    border-inline-start: 1px solid ${cssVar.colorBorderSecondary};

    background: color-mix(in srgb, var(--music-accent) 2%, transparent);

    @media (width <= 1180px) {
      border-block-start: 1px solid ${cssVar.colorBorderSecondary};
      border-inline-start: 0;
    }

    @media (width <= 480px) {
      padding-block: 22px;
      padding-inline: 20px;
    }
  `,
  sectionHeading: css`
    display: flex;
    gap: 12px;
    align-items: center;
    justify-content: space-between;

    h2 {
      margin: 0;
      font-size: 12px;
      font-weight: 500;
      color: ${cssVar.colorTextSecondary};
    }
  `,
  lyrics: css`
    scroll-behavior: smooth;
    scrollbar-width: thin;

    overflow: auto;
    display: flex;
    flex: 1;
    flex-direction: column;

    min-height: 220px;
    max-height: 350px;
    margin-block-start: 18px;
    padding-block: 22px;

    p {
      margin: 0;
      padding-block: 10px;

      font-size: 19px;
      font-weight: 500;
      line-height: 1.7;
      color: ${cssVar.colorTextQuaternary};

      transition: color 200ms;
    }

    p[aria-current='true'] {
      color: var(--music-accent);
    }

    button {
      cursor: pointer;

      padding: 0;
      border: 0;

      color: inherit;
      text-align: start;

      background: none;
    }

    &[data-empty='true'] {
      justify-content: center;
    }

    @media (width <= 1180px) {
      min-height: 180px;
      max-height: 250px;
    }
  `,
  emptyLyrics: css`
    display: flex;
    flex-direction: column;
    gap: 12px;
    align-items: center;

    max-width: 240px;
    margin: auto;

    color: ${cssVar.colorTextQuaternary};
    text-align: center;

    p {
      padding: 0;
      font-size: 14px;
      font-weight: 400;
      color: ${cssVar.colorTextSecondary};
    }

    span {
      font-size: 11px;
      line-height: 1.8;
      color: ${cssVar.colorTextTertiary};
    }
  `,
  collection: css`
    min-width: 0;
    margin-block-start: 32px;
  `,
  collectionHeader: css`
    display: flex;
    gap: 18px;
    align-items: center;
    justify-content: space-between;

    min-width: 0;
    padding-block-end: 15px;
    border-block-end: 1px solid ${cssVar.colorBorderSecondary};

    @media (width <= 768px) {
      flex-direction: column;
      gap: 14px;
      align-items: stretch;
    }
  `,
  tabs: css`
    display: flex;
    gap: 22px;
    align-items: center;
    min-width: 0;
  `,
  tab: css`
    cursor: pointer;

    display: flex;
    gap: 8px;
    align-items: center;

    padding-block: 4px;
    padding-inline: 0;
    border: 0;

    color: ${cssVar.colorTextTertiary};

    background: none;

    &[data-active='true'] {
      font-weight: 600;
      color: ${cssVar.colorText};
    }

    span {
      padding-block: 1px;
      padding-inline: 6px;
      border-radius: 5px;

      font-size: 10px;
      font-variant-numeric: tabular-nums;
      color: ${cssVar.colorTextTertiary};

      background: ${cssVar.colorFillQuaternary};
    }
  `,
  collectionActions: css`
    display: flex;
    gap: 12px;
    align-items: center;
    min-width: 0;

    @media (width <= 768px) {
      width: 100%;
    }
  `,
  search: css`
    width: 220px;
    border-color: transparent;
    border-radius: 10px;
    background: ${cssVar.colorFillQuaternary};

    input {
      font-size: 11px;
      background: transparent;
    }

    @media (width <= 768px) {
      flex: 1;
      width: 0;
      min-width: 0;
    }
  `,
  list: css`
    margin: 0;
    padding: 0;
    list-style: none;
  `,
  trackRow: css`
    display: flex;
    gap: 12px;
    align-items: center;

    min-width: 0;
    padding-block: 13px;
    padding-inline: 10px;
    border-block-end: 1px solid color-mix(in srgb, ${cssVar.colorBorderSecondary} 65%, transparent);
    border-radius: 10px;

    transition: background 150ms;

    &:hover {
      background: ${cssVar.colorFillQuaternary};
    }

    &[aria-current='true'] {
      color: var(--music-accent);
      background: color-mix(in srgb, var(--music-accent) 6%, transparent);
    }

    @media (width <= 480px) {
      gap: 9px;
      padding-inline: 5px;
    }
  `,
  rowNumber: css`
    display: grid;
    flex: none;
    place-items: center;

    width: 22px;

    font-size: 11px;
    font-variant-numeric: tabular-nums;
    color: ${cssVar.colorTextQuaternary};
  `,
  trackArt: css`
    display: grid;
    flex: none;
    place-items: center;

    width: 38px;
    height: 38px;
    border: 1px solid color-mix(in srgb, var(--music-accent) 10%, ${cssVar.colorBorderSecondary});
    border-radius: 10px;

    color: color-mix(in srgb, var(--music-accent) 75%, ${cssVar.colorTextSecondary});

    background: linear-gradient(
      145deg,
      color-mix(in srgb, var(--music-accent) 16%, ${cssVar.colorBgContainer}),
      ${cssVar.colorFillQuaternary}
    );

    @media (width <= 480px) {
      width: 32px;
      height: 32px;
      border-radius: 8px;
    }
  `,
  rowInfo: css`
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 5px;

    min-width: 0;
  `,
  name: css`
    overflow: hidden;
    display: block;

    font-size: 12px;
    font-weight: 500;
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  fileMeta: css`
    font-size: 10px;
    color: ${cssVar.colorTextTertiary};
  `,
  rowActions: css`
    display: flex;
    flex: none;
    gap: 2px;
    align-items: center;

    button {
      border-radius: 8px;
    }

    @media (width <= 480px) {
      gap: 0;
    }
  `,
  loading: css`
    padding-block: 12px;
    font-size: 12px;
    color: ${cssVar.colorTextTertiary};
  `,
  emptyCollection: css`
    display: flex;
    flex-direction: column;
    gap: 12px;
    align-items: center;

    padding-block: 46px;
    padding-inline: 20px;

    color: ${cssVar.colorTextQuaternary};
    text-align: center;

    h3 {
      margin: 0;
      font-size: 13px;
      font-weight: 500;
      color: ${cssVar.colorTextSecondary};
    }

    p {
      max-width: 330px;
      margin: 0;

      font-size: 11px;
      line-height: 1.8;
      color: ${cssVar.colorTextTertiary};
    }

    button {
      margin-block-start: 4px;
    }
  `,
}));
