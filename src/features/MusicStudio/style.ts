import { createStaticStyles } from 'antd-style';

export const styles = createStaticStyles(({ css, cssVar }) => ({
  studio: css`
    --music-accent: #478f9a;

    overflow: auto;
    flex: 1;

    width: 100%;
    min-width: 0;
    min-height: 0;

    color: ${cssVar.colorText};

    background:
      radial-gradient(
        ellipse at 80% 8%,
        color-mix(in srgb, #86b7c6 8%, transparent),
        transparent 48%
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
    gap: 14px;
    align-items: center;
    min-width: 0;

    h1 {
      margin-block: 5px 0;
      margin-inline: 0;

      font-size: 28px;
      font-weight: 650;
      letter-spacing: -1px;
    }

    @media (width <= 480px) {
      gap: 10px;

      h1 {
        font-size: 22px;
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
    isolation: isolate;
    position: relative;

    overflow: hidden;
    display: grid;
    grid-template-columns: minmax(260px, 0.95fr) minmax(0, 1.05fr);

    min-width: 0;
    border: 1px solid color-mix(in srgb, var(--music-accent) 9%, ${cssVar.colorBorderSecondary});
    border-radius: 26px;

    background:
      radial-gradient(
        ellipse at 8% 30%,
        color-mix(in srgb, #6baeb3 13%, transparent),
        transparent 62%
      ),
      radial-gradient(
        ellipse at 95% 84%,
        color-mix(in srgb, #7a9ab2 11%, transparent),
        transparent 58%
      ),
      color-mix(in srgb, ${cssVar.colorBgContainer} 88%, transparent);
    box-shadow: 0 12px 40px color-mix(in srgb, ${cssVar.colorText} 3%, transparent);

    @media (width <= 880px) {
      grid-template-columns: minmax(0, 1fr);
    }

    @media (width <= 480px) {
      border-radius: 22px;
    }
  `,
  player: css`
    display: flex;
    flex-direction: column;

    min-width: 0;
    padding-block: 25px 20px;
    padding-inline: 30px;

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
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 25px;
    align-items: center;
    justify-content: center;

    min-width: 0;
    padding-block: 22px 25px;

    @media (width <= 480px) {
      gap: 23px;
    }
  `,
  artwork: css`
    isolation: isolate;
    position: relative;

    aspect-ratio: 1;
    width: min(100%, 224px);
    margin-inline: auto;

    @media (width <= 880px) {
      width: min(100%, 240px);
    }

    @media (width <= 480px) {
      width: min(100%, 216px);
    }
  `,
  artworkGlow: css`
    position: absolute;
    z-index: -1;
    inset-block: 16px -20px;
    inset-inline: -12px;

    border-radius: 26px;

    opacity: 0.3;
    background: linear-gradient(135deg, #76b3bd, #245d73 52%, #c6d9b4);
    filter: blur(25px);
  `,

  coverArt: css`
    position: relative;

    overflow: hidden;

    width: 100%;
    height: 100%;
    border: 1px solid #a5d3d244;
    border-radius: 18px;

    background:
      radial-gradient(ellipse at 82% 8%, #d6e7ceaa, transparent 45%),
      linear-gradient(155deg, #75adbc, #39778a 48%, #174a63 72%, #97c0b1);
    box-shadow:
      0 18px 30px #144b6b20,
      0 4px 12px #0e2c4720;

    transition: box-shadow 250ms;

    svg {
      display: block;
      width: 100%;
      height: 100%;
    }

    &[data-playing='true'] {
      box-shadow:
        0 20px 34px #144b6b2c,
        0 5px 14px #0e2c4728;
    }
  `,
  coverSignature: css`
    position: absolute;
    inset-block-end: 14px;
    inset-inline: 15px;

    display: flex;
    gap: 6px;
    align-items: center;

    font-size: 9px;
    font-weight: 500;
    color: #f2faf3b8;
    letter-spacing: 1px;

    svg {
      width: 14px;
      height: 14px;
    }
  `,
  trackInfo: css`
    width: 100%;
    min-width: 0;
    max-width: 320px;
    text-align: center;
  `,
  trackOrigin: css`
    margin-block: 0 7px;
    margin-inline: 0;

    font-size: 10px;
    line-height: 1.6;
    color: ${cssVar.colorTextTertiary};
  `,
  trackTitle: css`
    overflow: hidden;
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;

    margin: 0;

    font-size: clamp(20px, 1.8vw, 25px);
    font-weight: 600;
    line-height: 1.4;
    letter-spacing: -0.6px;
    overflow-wrap: anywhere;
  `,
  trackDescription: css`
    margin-block: 8px 0;
    margin-inline: 0;

    font-size: 11px;
    line-height: 1.7;
    color: ${cssVar.colorTextTertiary};
  `,
  timeline: css`
    margin-block-start: 22px;

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

    width: 52px;
    height: 52px;
    margin-inline: 7px;
    padding: 0;
    border: 1px solid color-mix(in srgb, var(--music-accent) 70%, white);
    border-radius: 50%;

    color: #f6fffc;

    background: linear-gradient(145deg, #7aadb0, #397f91);
    box-shadow: 0 5px 13px #397f9124;

    transition:
      transform 160ms,
      box-shadow 160ms;

    &:hover {
      transform: scale(1.04);
      box-shadow: 0 7px 18px #397f9138;
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

    padding-block-start: 4px;

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
    padding-block: 25px;
    padding-inline: 18px 30px;

    @media (width <= 880px) {
      padding-block: 22px;
      padding-inline: 28px;
      border-block-start: 1px solid
        color-mix(in srgb, ${cssVar.colorBorderSecondary} 70%, transparent);
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
    scroll-padding-block: 58px;

    overflow: auto;
    display: flex;
    flex: 1;
    flex-direction: column;

    min-height: 320px;
    max-height: 550px;
    margin-block-start: 5px;
    padding-block: 58px;

    mask-image: linear-gradient(transparent, #000 10%, #000 88%, transparent);

    p {
      margin: 0;
      padding-block: 15px;

      font-size: clamp(19px, 2vw, 26px);
      font-weight: 600;
      line-height: 1.65;
      color: ${cssVar.colorTextQuaternary};
      overflow-wrap: anywhere;

      transition:
        color 220ms,
        font-size 220ms;
    }

    p[aria-current='true'] {
      font-size: clamp(23px, 2.4vw, 31px);
      color: ${cssVar.colorText};
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

    @media (width <= 880px) {
      min-height: 210px;
      max-height: 270px;
    }

    @media (prefers-reduced-motion: reduce) {
      scroll-behavior: auto;

      p {
        transition: none;
      }
    }
  `,
  emptyLyrics: css`
    display: flex;
    flex-direction: column;
    gap: 15px;
    align-items: flex-start;

    max-width: 260px;
    margin: auto;

    color: color-mix(in srgb, var(--music-accent) 50%, ${cssVar.colorTextQuaternary});

    p {
      padding: 0;
      font-size: 21px;
      font-weight: 600;
      color: ${cssVar.colorTextSecondary};
    }

    span {
      font-size: 12px;
      line-height: 1.9;
      color: ${cssVar.colorTextTertiary};
    }

    @media (width <= 880px) {
      align-items: center;
      text-align: center;
    }
  `,
  collection: css`
    min-width: 0;
    margin-block-start: 34px;
  `,
  collectionHeader: css`
    display: flex;
    gap: 18px;
    align-items: center;
    justify-content: space-between;

    min-width: 0;
    padding-block-end: 18px;

    @media (width <= 768px) {
      flex-direction: column;
      gap: 14px;
      align-items: stretch;
    }
  `,
  tabs: css`
    display: flex;
    gap: 5px;
    align-items: center;

    width: fit-content;
    min-width: 0;
    padding: 4px;
    border-radius: 13px;

    background: ${cssVar.colorFillQuaternary};
  `,
  tab: css`
    cursor: pointer;

    display: flex;
    gap: 8px;
    align-items: center;

    padding-block: 8px;
    padding-inline: 13px;
    border: 0;
    border-radius: 10px;

    color: ${cssVar.colorTextTertiary};

    background: none;

    transition:
      color 150ms,
      background 150ms;

    &[data-active='true'] {
      font-weight: 600;
      color: var(--music-accent);
      background: ${cssVar.colorBgContainer};
      box-shadow: 0 2px 9px #00000008;
    }

    span {
      font-size: 10px;
      font-weight: 400;
      font-variant-numeric: tabular-nums;
      color: ${cssVar.colorTextTertiary};
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

  libraryGrid: css`
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 12px;

    margin: 0;
    padding: 0;

    list-style: none;

    @media (width >= 1640px) {
      grid-template-columns: repeat(3, minmax(0, 1fr));
    }

    @media (width <= 680px) {
      grid-template-columns: minmax(0, 1fr);
    }
  `,
  libraryCard: css`
    display: flex;
    gap: 12px;
    align-items: center;

    min-width: 0;
    padding: 11px;
    border: 1px solid color-mix(in srgb, ${cssVar.colorBorderSecondary} 50%, transparent);
    border-radius: 14px;

    background: color-mix(in srgb, ${cssVar.colorBgContainer} 88%, transparent);
    box-shadow: 0 3px 12px #00000003;

    transition:
      background 150ms,
      transform 150ms,
      box-shadow 150ms;

    &:hover {
      transform: translateY(-1px);
      box-shadow: 0 5px 16px #00000008;
    }

    &[aria-current='true'] {
      color: var(--music-accent);
      background: color-mix(in srgb, var(--music-accent) 7%, ${cssVar.colorBgContainer});
    }

    @media (prefers-reduced-motion: reduce) {
      transition: none;

      &:hover {
        transform: none;
      }
    }

    @media (width <= 480px) {
      gap: 11px;
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
    position: relative;

    overflow: hidden;
    display: grid;
    flex: none;
    place-items: center;

    width: 48px;
    height: 48px;
    border-radius: 9px;

    background: linear-gradient(145deg, #89b3c0, #417c92 65%, #a7c8bb);

    svg {
      width: 100%;
      height: 100%;
    }

    &[data-tone='1'] {
      background: linear-gradient(145deg, #9eb5bb, #607792 65%, #aebfca);
    }

    &[data-tone='2'] {
      background: linear-gradient(145deg, #9dc5bd, #4c9696 65%, #c4d3ad);
    }

    &[data-tone='3'] {
      background: linear-gradient(145deg, #a3bccb, #51768d 65%, #9cb4c0);
    }

    @media (width <= 480px) {
      width: 43px;
      height: 43px;
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

    font-size: 13px;
    font-weight: 550;
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

    padding-block: 42px;
    padding-inline: 20px;
    border: 1px dashed ${cssVar.colorBorderSecondary};
    border-radius: 18px;

    color: ${cssVar.colorTextQuaternary};
    text-align: center;

    h3 {
      margin: 0;
      font-size: 14px;
      font-weight: 500;
      color: ${cssVar.colorTextSecondary};
    }

    p {
      max-width: 330px;
      margin: 0;

      font-size: 12px;
      line-height: 1.8;
      color: ${cssVar.colorTextTertiary};
    }

    button {
      margin-block-start: 4px;
    }
  `,
}));
