import { createStaticStyles } from 'antd-style';

export const styles = createStaticStyles(({ css, cssVar }) => ({
  shell: css`
    position: relative;

    display: flex;
    flex: 1;
    flex-direction: column;

    min-width: 0;
    height: 100%;
    min-height: 0;
  `,
  content: css`
    position: relative;

    overflow: hidden;
    display: flex;
    flex: 1;
    flex-direction: column;

    min-width: 0;
    min-height: 0;
  `,
  mini: css`
    z-index: 10;

    display: flex;
    flex: none;
    flex-wrap: wrap;
    gap: 12px;
    align-items: center;

    padding-block: 10px;
    padding-inline: 16px;
    border-block-start: 1px solid ${cssVar.colorBorderSecondary};

    font-size: 12px;

    background: ${cssVar.colorBgContainer};

    input[type='range'] {
      accent-color: ${cssVar.colorPrimary};
    }

    select {
      padding-block: 4px;
      padding-inline: 8px;
      border: 1px solid ${cssVar.colorBorderSecondary};
      border-radius: 6px;

      font: inherit;
      color: inherit;

      background: ${cssVar.colorBgContainer};
    }
  `,
  trackName: css`
    overflow: hidden;
    width: 160px;
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  controls: css`
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
  `,
  progress: css`
    display: flex;
    flex: 1 1 180px;
    gap: 8px;
    align-items: center;

    min-width: 160px;

    input {
      width: 100%;
      min-width: 50px;
    }
  `,
  volume: css`
    display: flex;
    gap: 6px;
    align-items: center;

    input {
      width: 65px;
    }
  `,
  studio: css`
    overflow: auto;

    height: 100%;
    padding: 28px;

    color: ${cssVar.colorText};

    background: ${cssVar.colorBgLayout};

    h1,
    h2,
    p {
      margin-block: 0 12px;
    }

    h1 {
      font-size: 28px;
    }

    h2 {
      font-size: 16px;
    }

    @media (width <= 768px) {
      padding: 16px;
    }
  `,
  header: css`
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    align-items: center;
    justify-content: space-between;

    margin-block-end: 24px;
  `,
  grid: css`
    display: grid;
    grid-template-columns: minmax(260px, 1fr) minmax(280px, 1fr);
    gap: 20px;
    align-items: start;

    @media (width <= 1000px) {
      grid-template-columns: minmax(0, 1fr);
    }
  `,
  card: css`
    padding: 20px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 16px;
    background: ${cssVar.colorBgContainer};
  `,
  stack: css`
    display: flex;
    flex-direction: column;
    gap: 20px;
    min-width: 0;
  `,
  list: css`
    margin-block: 12px 0;
    margin-inline: 0;
    padding: 0;
    list-style: none;
  `,
  row: css`
    display: flex;
    gap: 10px;
    align-items: center;

    padding-block: 10px;
    border-block-end: 1px solid ${cssVar.colorBorderSecondary};

    &[aria-current='true'] {
      color: ${cssVar.colorPrimary};
    }
  `,
  name: css`
    overflow: hidden;
    flex: 1;

    min-width: 0;

    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  lyrics: css`
    overflow: auto;
    max-height: 300px;
    margin-block-start: 16px;

    p {
      padding-block: 6px;
      padding-inline: 0;
      color: ${cssVar.colorTextSecondary};
    }

    p[aria-current='true'] {
      font-weight: 600;
      color: ${cssVar.colorPrimary};
    }

    button {
      cursor: pointer;

      border: 0;

      font: inherit;
      color: inherit;
      text-align: start;

      background: none;
    }
  `,
  muted: css`
    color: ${cssVar.colorTextSecondary};
  `,
}));
