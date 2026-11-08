import { createStaticStyles } from 'antd-style';

export const libraryStyles = createStaticStyles(({ css, cssVar }) => ({
  navigation: css`
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-block: 24px 8px;

    button {
      cursor: pointer;

      display: inline-flex;
      gap: 8px;
      align-items: center;

      padding-block: 9px;
      padding-inline: 14px;
      border: 1px solid transparent;
      border-radius: 18px;

      font-size: 13px;
      color: ${cssVar.colorTextSecondary};

      background: transparent;

      &:hover {
        color: ${cssVar.colorText};
        background: ${cssVar.colorFillTertiary};
      }

      &[aria-pressed='true'] {
        border-color: var(--qz-glass-border);
        color: var(--music-accent);
        background: var(--qz-glass-strong);
        box-shadow: inset 0 1px 0 var(--qz-glass-highlight);
      }
    }
  `,
  heading: css`
    display: flex;
    flex-wrap: wrap;
    gap: 14px;
    align-items: center;
    justify-content: space-between;

    margin-block: 28px 22px;

    h3 {
      margin: 0;
      font-size: 20px;
      font-weight: 600;
    }
  `,
  title: css`
    display: flex;
    gap: 10px;
    align-items: center;
    min-width: 0;

    h3 {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    > span {
      flex: none;
      font-size: 12px;
      color: ${cssVar.colorTextTertiary};
    }
  `,
  actions: css`
    display: flex;
    gap: 8px;
    align-items: center;
  `,
  grid: css`
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
    gap: 24px 20px;

    margin: 0;
    padding: 0;

    list-style: none;

    @container (width <= 480px) {
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 20px 14px;
    }
  `,
  card: css`
    cursor: pointer;

    display: flex;
    flex-direction: column;
    gap: 8px;

    width: 100%;
    min-width: 0;
    padding: 0;
    border: 0;

    color: ${cssVar.colorText};
    text-align: start;

    background: transparent;

    > strong {
      overflow: hidden;

      width: 100%;

      font-size: 14px;
      font-weight: 500;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    > small {
      font-size: 12px;
      color: ${cssVar.colorTextTertiary};
    }

    &:hover > span {
      transform: translateY(-3px);
    }
  `,
  cover: css`
    overflow: hidden;
    display: grid;
    place-items: center;

    aspect-ratio: 1;
    width: 100%;
    border: 1px solid var(--qz-glass-border);
    border-radius: 18px;

    color: var(--music-cover-ink);

    background: var(--qz-glass-strong);
    box-shadow: inset 0 1px 0 var(--qz-glass-highlight);

    transition: transform 180ms ease;

    img {
      width: 100%;
      height: 100%;
      object-fit: cover;
    }

    @media (prefers-reduced-motion: reduce) {
      transition: none;
    }
  `,
  more: css`
    display: flex;
    justify-content: center;
    margin-block: 24px;
  `,
}));
