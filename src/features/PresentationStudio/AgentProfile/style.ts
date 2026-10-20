import { createStaticStyles } from 'antd-style';

export const styles = createStaticStyles(({ css, cssVar }) => ({
  avatar: css`
    overflow: hidden;
    display: flex;
    flex-shrink: 0;
    align-items: center;
    justify-content: center;

    width: 44px;
    height: 44px;
    border-radius: 22px;

    background: ${cssVar.colorBgContainer};
    box-shadow: 0 4px 12px rgb(0 0 0 / 12%);

    img {
      width: 100%;
      height: 100%;
      object-fit: cover;
    }
  `,
  capabilityItem: css`
    display: flex;
    gap: 8px;
    align-items: center;

    font-size: 13px;
    color: ${cssVar.colorText};
  `,
  capabilityList: css`
    display: flex;
    flex-direction: column;
    gap: 8px;
  `,
  card: css`
    display: flex;
    flex-direction: column;
    gap: 16px;

    padding: 18px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 12px;

    background: ${cssVar.colorBgContainer};
    box-shadow: 0 2px 8px rgb(0 0 0 / 4%);
  `,
  description: css`
    font-size: 13px;
    line-height: 1.5;
    color: ${cssVar.colorTextSecondary};
  `,
  header: css`
    display: flex;
    gap: 12px;
    align-items: center;
  `,
  meta: css`
    display: flex;
    flex-direction: column;
    gap: 2px;
  `,
  promptCard: css`
    cursor: pointer;

    display: flex;
    align-items: center;
    justify-content: space-between;

    padding-block: 9px;
    padding-inline: 12px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 8px;

    font-size: 12px;
    color: ${cssVar.colorTextSecondary};

    background: ${cssVar.colorFillQuaternary};

    transition: all 0.2s ease-in-out;

    &:hover {
      border-color: ${cssVar.colorPrimary};
      color: ${cssVar.colorText};
      background: ${cssVar.colorFillAlter};
    }
  `,
  promptList: css`
    display: flex;
    flex-direction: column;
    gap: 8px;
  `,
  sectionTitle: css`
    font-size: 12px;
    font-weight: 600;
    color: ${cssVar.colorTextTertiary};
    letter-spacing: 0.5px;
  `,
  tagGroup: css`
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  `,
  title: css`
    font-size: 16px;
    font-weight: 700;
    color: ${cssVar.colorText};
  `,
}));
