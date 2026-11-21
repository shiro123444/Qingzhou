import { Button, Modal, Popover } from 'antd';
import { createStaticStyles } from 'antd-style';
import { Check, ChevronDown, Expand, FileText, Palette } from 'lucide-react';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  type PresentationStyleId,
  presentationStylePresets,
} from '../../../../packages/runtime-contracts/src/presentation-style-presets';

const styles = createStaticStyles(({ css, cssVar }) => ({
  gallery: css`
    container-type: inline-size;
    min-width: 0;
    flex: none;
    box-sizing: border-box;
    width: min(100%, 920px);
    margin-inline: auto;
    padding: 6px 16px 32px;
    display: grid;
    gap: 28px;
  `,
  heading: css`
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin-bottom: 10px;
    h2 {
      font-size: 16px;
      font-weight: 600;
      letter-spacing: -0.025em;
      margin: 0;
    }
  `,
  styleActions: css`
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
  `,
  toggle: css`
    display: inline-flex;
    padding: 2px;
    border-radius: 20px;
    background: color-mix(in srgb, ${cssVar.colorFillSecondary} 72%, transparent);
    button {
      border: 0;
      background: transparent;
      cursor: pointer;
      color: ${cssVar.colorTextSecondary};
      font: inherit;
      font-size: 12px;
      border-radius: 20px;
      min-height: 32px;
      padding: 4px 12px;
      &:focus-visible {
        outline: 2px solid ${cssVar.colorPrimary};
        outline-offset: 1px;
      }
      @media (pointer: coarse) {
        min-height: 44px;
      }
    }
    button[aria-pressed='true'] {
      background: ${cssVar.colorBgContainer};
      color: ${cssVar.colorText};
      box-shadow: 0 1px 5px #0002;
    }
  `,
  grid: css`
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: clamp(8px, 1vw, 16px);
    @container (max-width: 580px) {
      display: flex;
      overflow-x: auto;
      overscroll-behavior-inline: contain;
      scroll-snap-type: x proximity;
      gap: 12px;
      padding: 5px 4px;
      > * {
        flex: 0 0 min(78%, 285px);
        scroll-snap-align: start;
      }
    }
  `,
  styleCard: css`
    position: relative;
    min-width: 0;
    &:focus-within button[aria-haspopup='dialog'],
    &[data-selected='true'] button[aria-haspopup='dialog'] {
      opacity: 1;
      pointer-events: auto;
    }
    @media (hover: hover) {
      &:hover button[aria-haspopup='dialog'] {
        opacity: 1;
        pointer-events: auto;
      }
    }
  `,
  previewTrigger: css`
    position: absolute;
    inset-block-start: 4px;
    inset-inline-end: 4px;
    display: grid;
    place-items: center;
    width: 36px;
    height: 36px;
    padding: 0;
    border: 0;
    border-radius: 50%;
    color: ${cssVar.colorText};
    background: color-mix(in srgb, ${cssVar.colorBgContainer} 92%, transparent);
    box-shadow: 0 1px 6px #0002;
    opacity: 0;
    pointer-events: none;
    cursor: zoom-in;
    &:focus-visible {
      outline: 2px solid ${cssVar.colorPrimary};
      outline-offset: 1px;
    }
    @media (pointer: coarse) {
      width: 44px;
      height: 44px;
    }
  `,
  previewMeta: css`
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 6px 12px;
    margin-bottom: 10px;
    color: ${cssVar.colorTextSecondary};
  `,
  previewImage: css`
    display: block;
    width: 100%;
    aspect-ratio: 16 / 9;
    max-height: 65dvh;
    object-fit: contain;
    border-radius: 8px;
  `,
  item: css`
    display: block;
    width: 100%;
    min-width: 0;
    padding: 0;
    text-align: start;
    color: ${cssVar.colorText};
    font: inherit;
    background: none;
    border: 0;
    border-radius: 9px;
    cursor: pointer;
    &:focus-visible {
      outline: 2px solid ${cssVar.colorPrimary};
      outline-offset: 2px;
    }
    > span:first-child {
      display: grid;
      place-items: center;
      position: relative;
      overflow: hidden;
      width: 100%;
      aspect-ratio: 16 / 9;
      border-radius: 8px;
      background: ${cssVar.colorFillTertiary};
      box-shadow: inset 0 0 0 1px ${cssVar.colorBorderSecondary};
    }
    img {
      width: 100%;
      height: 100%;
      display: block;
      object-fit: contain;
    }
    &[aria-pressed='true'] > span:first-child::after {
      position: absolute;
      inset: 0;
      content: '';
      border: 2px solid ${cssVar.colorPrimary};
      border-radius: inherit;
    }
    &:hover > span:first-child {
      outline: 1px solid ${cssVar.colorTextTertiary};
      outline-offset: -1px;
    }
  `,
  caption: css`
    display: flex;
    align-items: center;
    gap: 5px;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    margin-top: 7px;
    font-weight: 500;
    font-size: 13px;
    svg {
      flex: none;
    }
  `,
  empty: css`
    margin: 0;
    font-size: 13px;
    color: ${cssVar.colorTextTertiary};
  `,
  pickerTrigger: css`
    && {
      display: inline-flex;
      gap: 5px;
      align-items: center;
      height: 32px;
      padding-inline: 9px;
      font-size: 13px;
      color: ${cssVar.colorTextSecondary};

      &[aria-pressed='true'] {
        color: ${cssVar.colorText};
        background: ${cssVar.colorFillTertiary};
      }
    }
  `,
  stylePopover: css`
    overflow: auto;
    width: min(720px, calc(100vw - 48px));
    max-height: min(70dvh, 620px);
    padding: 4px;
  `,
  stylePanel: css`
    h2 {
      margin: 0;
      font-size: 14px;
      font-weight: 600;
      line-height: 1.4;
    }
  `,
}));

export interface RecentPresentation {
  cover?: string;
  jobId: string;
  title: string;
}

function RecentCover({ uri }: { uri?: string }) {
  const [failed, setFailed] = useState(false);
  return uri && !failed ? (
    <img alt="" loading="lazy" src={uri} onError={() => setFailed(true)} />
  ) : (
    <FileText aria-hidden size={24} strokeWidth={1.3} />
  );
}

type SamplePage = 'cover' | 'content';

function SamplePages({
  page,
  onChange,
}: {
  page: SamplePage;
  onChange: (page: SamplePage) => void;
}) {
  const { t } = useTranslation('common');
  return (
    <div aria-label={t('presentationGallery.compare')} className={styles.toggle} role="group">
      {(['cover', 'content'] as const).map((view) => (
        <button
          aria-pressed={page === view}
          key={view}
          type="button"
          onClick={() => onChange(view)}
        >
          {t(`presentationGallery.${view}`)}
        </button>
      ))}
    </div>
  );
}

interface StyleGalleryProps {
  onSelect: (style: PresentationStyleId) => void;
  selected?: PresentationStyleId;
  templatePicker?: React.ReactNode;
}

export function StyleGallery({ selected, onSelect, templatePicker }: StyleGalleryProps) {
  const { t } = useTranslation('common');
  const headingId = useId();
  const [page, setPage] = useState<SamplePage>('cover');
  const [preview, setPreview] = useState<PresentationStyleId>();

  return (
    <section aria-labelledby={headingId} className={styles.stylePanel}>
      <div className={styles.heading}>
        <h2 id={headingId}>{t('presentationGallery.styles')}</h2>
        <div className={styles.styleActions}>
          {templatePicker}
          <SamplePages page={page} onChange={setPage} />
        </div>
      </div>
      <div aria-labelledby={headingId} className={styles.grid} role="group">
        {presentationStylePresets.map(({ id }) => (
          <div className={styles.styleCard} data-selected={selected === id} key={id}>
            <button
              aria-pressed={selected === id}
              className={styles.item}
              data-testid={`presentation-style-${id}`}
              title={t(`presentationGallery.description.${id}`)}
              type="button"
              onClick={() => onSelect(id)}
            >
              <span>
                <img alt="" src={`/images/presentation-styles/${id}-${page}.svg`} />
              </span>
              <span className={styles.caption}>
                {t(`presentationGallery.${id}`)}
                {selected === id && <Check aria-hidden size={14} />}
              </span>
            </button>
            <button
              aria-haspopup="dialog"
              className={styles.previewTrigger}
              type="button"
              aria-label={t('presentationGallery.enlarge', {
                style: t(`presentationGallery.${id}`),
              })}
              onClick={() => setPreview(id)}
            >
              <Expand aria-hidden size={16} />
            </button>
          </div>
        ))}
      </div>
      <Modal
        centered
        destroyOnHidden
        open={Boolean(preview)}
        title={preview && t(`presentationGallery.${preview}`)}
        width={960}
        zIndex={1200}
        footer={
          preview && preview !== selected ? (
            <Button
              type="primary"
              onClick={() => {
                onSelect(preview);
                setPreview(undefined);
              }}
            >
              {t('presentationGallery.useDesign')}
            </Button>
          ) : null
        }
        onCancel={() => setPreview(undefined)}
      >
        {preview && (
          <>
            <div className={styles.previewMeta}>
              <span>{t(`presentationGallery.description.${preview}`)}</span>
              <SamplePages page={page} onChange={setPage} />
            </div>
            <img
              alt={t(`presentationGallery.sample.${page}`)}
              className={styles.previewImage}
              src={`/images/presentation-styles/${preview}-${page}.svg`}
            />
          </>
        )}
      </Modal>
    </section>
  );
}

export function StylePicker({
  disabled = false,
  onSelect,
  selected,
}: {
  disabled?: boolean;
  onSelect: (style: PresentationStyleId) => void;
  selected?: PresentationStyleId;
}) {
  const { t } = useTranslation('common');
  const [open, setOpen] = useState(false);

  return (
    <Popover
      arrow={false}
      open={open}
      placement="topLeft"
      trigger="click"
      content={
        <div className={styles.stylePopover}>
          <StyleGallery
            selected={selected}
            onSelect={(style) => {
              onSelect(style);
              setOpen(false);
            }}
          />
        </div>
      }
      onOpenChange={setOpen}
    >
      <Button
        aria-expanded={open}
        aria-pressed={Boolean(selected)}
        className={styles.pickerTrigger}
        disabled={disabled}
        icon={<Palette aria-hidden size={17} />}
        type="text"
      >
        {selected ? t(`presentationGallery.${selected}`) : t('presentationGallery.styles')}
        <ChevronDown aria-hidden size={14} />
      </Button>
    </Popover>
  );
}

function RecentPresentations({
  onOpen,
  recent,
}: {
  onOpen?: (jobId: string) => void;
  recent: RecentPresentation[];
}) {
  const { t } = useTranslation('common');
  const headingId = useId();

  return (
    <section aria-labelledby={headingId} data-testid="presentation-recent-works">
      <div className={styles.heading}>
        <h2 id={headingId}>{t('presentationGallery.recent')}</h2>
      </div>
      <div className={styles.grid}>
        {recent.map(({ jobId, title, cover }) => (
          <button className={styles.item} key={jobId} type="button" onClick={() => onOpen?.(jobId)}>
            <span>
              <RecentCover key={cover} uri={cover} />
            </span>
            <span className={styles.caption}>{title}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

export default function CreationGallery({
  selected,
  onSelect,
  recent,
  templatePicker,
  onOpen,
  showStyles = true,
}: {
  templatePicker?: React.ReactNode;
  selected?: PresentationStyleId;
  onSelect: (style: PresentationStyleId) => void;
  recent: RecentPresentation[];
  onOpen?: (jobId: string) => void;
  showStyles?: boolean;
}) {
  const { t } = useTranslation('common');
  if (!showStyles && recent.length === 0) return null;

  return (
    <div className={styles.gallery}>
      {showStyles && (
        <StyleGallery selected={selected} templatePicker={templatePicker} onSelect={onSelect} />
      )}
      {recent.length > 0 ? (
        <RecentPresentations recent={recent} onOpen={onOpen} />
      ) : (
        showStyles && <p className={styles.empty}>{t('presentationGallery.empty')}</p>
      )}
    </div>
  );
}
