import { Popover } from 'antd';
import { createStaticStyles } from 'antd-style';
import { type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

const styles = createStaticStyles(({ css, cssVar }) => ({
  list: css`
    overflow: auto;
    display: flex;
    flex-direction: column;
    gap: 12px;

    width: min(340px, 75vw);
    max-height: 300px;
    margin: 0;
    padding-block: 8px;
    padding-inline: 4px;

    font-size: 12px;
    color: ${cssVar.colorTextSecondary};
    list-style: none;

    li:first-child {
      font-weight: 600;
      color: ${cssVar.colorText};
    }
  `,
}));

export default function ActivityHistory({
  children,
  history,
}: {
  children: ReactNode;
  history?: { id: string; text: string }[];
}) {
  const { t } = useTranslation('common');
  return (
    <Popover
      placement="bottomRight"
      title={t('presentationTemplates.activityHistory')}
      trigger={['click']}
      content={
        <ol
          aria-label={t('presentationTemplates.activityHistory')}
          className={styles.list}
          data-testid="presentation-activity-history"
        >
          {history?.length ? (
            [...history].reverse().map((item) => <li key={item.id}>{item.text}</li>)
          ) : (
            <li>{t('presentationTemplates.waitingForActivity')}</li>
          )}
        </ol>
      }
    >
      {children}
    </Popover>
  );
}
