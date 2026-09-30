import { Flexbox } from '@lobehub/ui';
import { Alert } from 'antd';
import { createStaticStyles } from 'antd-style';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { TeachingRecord } from '@/types/presentationTeaching';

const styles = createStaticStyles(({ css, cssVar }) => ({
  page: css`
    flex: 1 1 300px;
    min-width: 0;
    max-width: 720px;
  `,
  raster: css`
    position: relative;
    border: 1px solid ${cssVar.colorBorder};
  `,
  image: css`
    display: block;
    width: 100%;
    height: auto;
  `,
  regions: css`
    pointer-events: none;

    position: absolute;
    inset: 0;

    width: 100%;
    height: 100%;
  `,
}));

/** Boxes are model-localized claims for teacher inspection, not verified detections. */
export function TeachingVisualEvidence({
  record,
  onReady,
}: {
  record: TeachingRecord;
  onReady: (ready: boolean) => void;
}) {
  const { t } = useTranslation('common');
  const [loaded, setLoaded] = useState<Set<string>>(() => new Set());
  const [failed, setFailed] = useState<Set<string>>(() => new Set());
  const snapshots = useMemo(() => record.source.visualPages ?? [], [record.source.visualPages]);
  useEffect(() => {
    onReady(snapshots.every((page) => loaded.has(page.ref) && !failed.has(page.ref)));
  }, [snapshots, loaded, failed, onReady]);
  return (
    <Flexbox data-testid="teaching-visual-evidence" gap={10}>
      <Alert message={t('presentationTeaching.visualBoundary')} type="warning" />
      {failed.size > 0 && (
        <Alert message={t('presentationTeaching.visualUnavailable')} role="alert" type="error" />
      )}
      <Flexbox horizontal gap={12} wrap="wrap">
        {snapshots.map((page) => {
          const regions =
            record.pattern.visualComparisons
              ?.flatMap((item) => item.regions)
              .filter((region) => region.page === page.page) ?? [];
          const url = `/api/runtime/presentation/artifacts/${encodeURIComponent(page.ref)}?raw=true`;
          return (
            <figure className={styles.page} key={page.ref}>
              <figcaption>{t('presentationTeaching.page', { page: page.page })}</figcaption>
              <div className={styles.raster}>
                <img
                  alt={t('presentationTeaching.sourceImage', { page: page.page })}
                  className={styles.image}
                  src={url}
                  onError={() => setFailed((previous) => new Set([...previous, page.ref]))}
                  onLoad={() => {
                    setLoaded((previous) => new Set([...previous, page.ref]));
                    setFailed((previous) => {
                      const next = new Set(previous);
                      next.delete(page.ref);
                      return next;
                    });
                  }}
                />
                <svg
                  aria-hidden
                  className={styles.regions}
                  preserveAspectRatio="none"
                  viewBox="0 0 1000 1000"
                >
                  {regions.map((region, i) => (
                    <rect
                      fill="none"
                      height={region.height * 1000}
                      key={i}
                      stroke="#d946ef"
                      strokeDasharray="6 4"
                      strokeWidth={2}
                      vectorEffect="non-scaling-stroke"
                      width={region.width * 1000}
                      x={region.x * 1000}
                      y={region.y * 1000}
                    />
                  ))}
                </svg>
              </div>
              <a href={url} rel="noreferrer" target="_blank">
                {t('presentationTeaching.openImage')}
              </a>
              <ul>
                {regions.map((region, i) => (
                  <li key={i}>{region.description}</li>
                ))}
              </ul>
              <details>
                <summary>
                  {t('presentationTeaching.buildEvidence', { count: page.builds.length })}
                </summary>
                <span>{t('presentationTeaching.buildBoundary')}</span>
                <ul>
                  {page.builds.map((build, i) => (
                    <li key={i}>
                      {build.id}: {build.nodeType} / {build.presetClass} /{' '}
                      {build.effects.join(', ')} / {build.targets.join(', ')}
                    </li>
                  ))}
                </ul>
                {page.buildsTruncated && <span>{t('presentationTeaching.buildTruncated')}</span>}
                <code>SHA256: {page.sha256}</code>
              </details>
            </figure>
          );
        })}
      </Flexbox>
      {record.pattern.visualComparisons?.map((comparison, i) => (
        <Flexbox gap={4} key={i}>
          <strong>
            {comparison.fromPage} → {comparison.toPage} · {t('presentationTeaching.visualClaim')}
          </strong>
          <span>{comparison.visibleChange}</span>
          <span>
            {t('presentationTeaching.alternative')}: {comparison.alternativeExplanation}
          </span>
          <span>
            {t('presentationTeaching.uncertainty')}: {comparison.uncertainty}
          </span>
        </Flexbox>
      ))}
    </Flexbox>
  );
}
