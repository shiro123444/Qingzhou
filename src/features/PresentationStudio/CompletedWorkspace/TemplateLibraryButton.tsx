import { Button, Flexbox, Icon } from '@lobehub/ui';
import { Input, Popconfirm, Popover, Spin, Tooltip } from 'antd';
import { createStaticStyles } from 'antd-style';
import {
  ArrowRight,
  BookmarkPlus,
  Check,
  FilePenLine,
  LayoutTemplate,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { memo, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  presentationTemplateClient,
  type PresentationTemplateLearningQuestion,
  type PresentationTemplateSummary,
} from '@/services/runtime/templateClient';

import { PRESENTATION_PPTX_MAX_UPLOAD_BYTES } from '../../../../packages/runtime-contracts/src';
import { styles as workspaceStyles } from './style';

const styles = createStaticStyles(({ css, cssVar }) => ({
  empty: css`
    padding-block: 20px;
    padding-inline: 8px;

    font-size: 13px;
    color: ${cssVar.colorTextDescription};
    text-align: center;
  `,
  error: css`
    margin: 0;
    font-size: 12px;
    color: ${cssVar.colorError};
    overflow-wrap: anywhere;
  `,
  learning: css`
    display: flex;
    flex-direction: column;
    gap: 8px;

    padding: 12px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 14px;

    background: ${cssVar.colorFillQuaternary};
  `,
  learningChoices: css`
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  `,
  learningQuestion: css`
    margin: 0;

    font-size: 13px;
    font-weight: 600;
    line-height: 1.45;
    color: ${cssVar.colorText};
  `,
  learningReason: css`
    margin: 0;
    font-size: 12px;
    line-height: 1.45;
    color: ${cssVar.colorTextSecondary};
  `,
  list: css`
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 4px;

    max-height: 280px;
  `,
  name: css`
    overflow: hidden;
    flex: 1;

    min-width: 0;

    font-size: 13px;
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  notice: css`
    display: flex;
    gap: 6px;
    align-items: center;

    font-size: 12px;
    color: ${cssVar.colorTextSecondary};
  `,
  palette: css`
    display: flex;
    gap: 3px;

    span {
      width: 9px;
      height: 9px;
      border: 1px solid ${cssVar.colorBorderSecondary};
      border-radius: 50%;
    }
  `,
  root: css`
    display: flex;
    flex-direction: column;
    gap: 12px;

    width: min(320px, calc(100vw - 64px));
    padding: 4px;
  `,
  template: css`
    && {
      display: flex;
      gap: 10px;
      align-items: center;
      justify-content: flex-start;

      width: 100%;
      height: 48px;
      padding-block: 10px;
      padding-inline: 12px;
      border-radius: 12px;
    }
  `,
}));

export interface TemplateLibraryButtonProps {
  canLearn?: boolean;
  jobId?: string;
  jobTitle?: string;
  onJobChanged?: () => Promise<void>;
  onSelectTemplate?: (template: PresentationTemplateSummary | null) => void;
  selectedTemplate?: PresentationTemplateSummary | null;
}

const TemplateLibraryButton = memo<TemplateLibraryButtonProps>(
  ({ canLearn = true, jobId, jobTitle, onJobChanged, onSelectTemplate, selectedTemplate }) => {
    const { t } = useTranslation('common');
    const [open, setOpen] = useState(false);
    const [templates, setTemplates] = useState<PresentationTemplateSummary[]>([]);
    const [name, setName] = useState('');
    const [nativeTemplate, setNativeTemplate] = useState<PresentationTemplateSummary | null>(null);
    const [nativePrompt, setNativePrompt] = useState('');
    const [nativeDownload, setNativeDownload] = useState<string>();
    const nativeRequest = useRef<{ key: string; id: string } | undefined>(undefined);
    const nativeOutputRevision = useRef(0);
    const [loading, setLoading] = useState(false);
    const [pending, setPending] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);
    const [clarification, setClarification] = useState<{
      question: PresentationTemplateLearningQuestion;
      template: PresentationTemplateSummary;
    } | null>(null);
    const [guidance, setGuidance] = useState('');
    const fileInput = useRef<HTMLInputElement>(null);
    const applyRequest = useRef<{ key: string; requestId: string } | null>(null);

    useEffect(() => {
      if (!nativeTemplate) return;
      const controller = new AbortController();
      const revision = ++nativeOutputRevision.current;
      void presentationTemplateClient
        .listNativeOutputs(nativeTemplate, controller.signal)
        .then(({ outputs }) => {
          if (controller.signal.aborted || revision !== nativeOutputRevision.current) return;
          const uri = outputs[0]?.uri;
          if (uri && /^\/api\/runtime\/presentation\/artifacts\/[\w-]+\?raw=true$/.test(uri)) {
            setNativeDownload(uri);
          }
        })
        .catch((cause) => {
          if (!controller.signal.aborted && revision === nativeOutputRevision.current) {
            setError(cause instanceof Error ? cause.message : t('presentationTemplates.error'));
          }
        });
      return () => controller.abort();
    }, [nativeTemplate, t]);

    useEffect(() => {
      if (!open) return;
      const controller = new AbortController();
      setLoading(true);
      setError(null);
      void presentationTemplateClient
        .list(controller.signal)
        .then(setTemplates)
        .catch((cause) => {
          if (!controller.signal.aborted) {
            setError(cause instanceof Error ? cause.message : t('presentationTemplates.error'));
          }
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
      return () => controller.abort();
    }, [open, t]);

    const addTemplate = (template: PresentationTemplateSummary) => {
      setTemplates((current) => [
        template,
        ...current.filter((item) => item.templateId !== template.templateId),
      ]);
      setName('');
      setNotice(t('presentationTemplates.saved', { name: template.name }));
    };

    const run = async (key: string, operation: () => Promise<void>) => {
      if (pending) return;
      setPending(key);
      setError(null);
      setNotice(null);
      try {
        await operation();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : t('presentationTemplates.error'));
      } finally {
        setPending(null);
      }
    };

    const learn = () =>
      run('learn', async () => {
        if (!jobId) return;
        const profile = await presentationTemplateClient.learn(
          jobId,
          name.trim() || jobTitle || t('presentationTemplates.untitled'),
        );
        addTemplate(profile);
      });

    const importPptx = (file: File) =>
      run('import', async () => {
        if (
          !/\.pptx$/iu.test(file.name) ||
          file.size === 0 ||
          file.size > PRESENTATION_PPTX_MAX_UPLOAD_BYTES
        ) {
          throw new Error(t('presentationTemplates.invalidFile'));
        }
        const profile = await presentationTemplateClient.importPptx(
          file,
          name.trim() || file.name.replace(/\.pptx$/iu, ''),
        );
        addTemplate(profile);
        if (!jobId) {
          onSelectTemplate?.(profile);
          setOpen(false);
        }
      });

    const applyReady = async (template: PresentationTemplateSummary) => {
      if (!jobId) {
        onSelectTemplate?.(template);
        setOpen(false);
        return;
      }
      const key = `${jobId}:${template.templateId}:${template.versionId}`;
      if (applyRequest.current?.key !== key) {
        applyRequest.current = { key, requestId: crypto.randomUUID() };
      }
      await presentationTemplateClient.apply(jobId, {
        requestId: applyRequest.current.requestId,
        templateId: template.templateId,
        versionId: template.versionId,
      });
      await onJobChanged?.();
      applyRequest.current = null;
      setNotice(t('presentationTemplates.applied', { name: template.name }));
    };

    const studyAndApply = async (
      template: PresentationTemplateSummary,
      answer?: string,
      questionId?: string,
      choiceId?: string,
    ) => {
      const result = await presentationTemplateClient.analyze(
        template,
        answer,
        questionId,
        choiceId,
      );
      const question = result.learning.questions[0];
      if (result.learning.status === 'needs_input' && question) {
        setClarification({ question, template });
        setGuidance('');
        setNotice(t('presentationTemplates.learningPaused'));
        return;
      }
      setClarification(null);
      setGuidance('');
      await applyReady(template);
    };

    const apply = (template: PresentationTemplateSummary) =>
      run(template.templateId, async () => {
        if (!jobId) {
          onSelectTemplate?.(template);
          setOpen(false);
          return;
        }
        await studyAndApply(template);
      });

    const continueLearning = (answer: string, choiceId?: string) =>
      run(`clarify:${clarification?.question.id ?? ''}`, async () => {
        if (!clarification || !answer.trim()) return;
        await studyAndApply(
          clarification.template,
          answer.trim(),
          clarification.question.id,
          choiceId,
        );
      });

    const removeTemplate = (template: PresentationTemplateSummary) =>
      run(`delete:${template.templateId}`, async () => {
        await presentationTemplateClient.remove(template.templateId);
        setTemplates((current) =>
          current.filter((item) => item.templateId !== template.templateId),
        );
        if (selectedTemplate?.templateId === template.templateId) onSelectTemplate?.(null);
        if (nativeTemplate?.templateId === template.templateId) setNativeTemplate(null);
        if (clarification?.template.templateId === template.templateId) setClarification(null);
        setNotice(t('presentationTemplates.deleted', { name: template.name }));
      });

    const editNative = () =>
      run('native', async () => {
        if (!nativeTemplate || !nativePrompt.trim()) return;
        const instruction = nativePrompt.trim();
        nativeOutputRevision.current++;
        const key = JSON.stringify([
          nativeTemplate.templateId,
          nativeTemplate.versionId,
          instruction,
        ]);
        if (nativeRequest.current?.key !== key) {
          nativeRequest.current = { key, id: crypto.randomUUID() };
        }
        setNativeDownload(undefined);
        const output = await presentationTemplateClient.fillNative(
          nativeTemplate,
          instruction,
          nativeRequest.current.id,
        );
        const uri = output.result?.uri;
        if (!uri || !/^\/api\/runtime\/presentation\/artifacts\/[\w-]+\?raw=true$/.test(uri)) {
          throw new Error(t('presentationTemplates.nativeUnavailable'));
        }
        setNativeDownload(uri);
        setNotice(t('presentationTemplates.nativeDone'));
        nativeRequest.current = undefined;
      });

    return (
      <Popover
        open={open}
        placement="bottomRight"
        trigger="click"
        content={
          <section aria-label={t('presentationTemplates.title')} className={styles.root}>
            <Flexbox horizontal align="center" gap={6}>
              <Input
                aria-label={t('presentationTemplates.name')}
                maxLength={80}
                placeholder={t('presentationTemplates.name')}
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
              {jobId && (
                <Tooltip
                  title={
                    canLearn
                      ? t('presentationTemplates.learn')
                      : t('presentationTemplates.waitForCompletion')
                  }
                >
                  <Button
                    aria-label={t('presentationTemplates.learn')}
                    className={workspaceStyles.iconButton}
                    disabled={!canLearn || loading || Boolean(pending)}
                    icon={<Icon aria-hidden icon={BookmarkPlus} size={22} />}
                    loading={pending === 'learn'}
                    type="text"
                    onClick={() => void learn()}
                  />
                </Tooltip>
              )}
              <Tooltip title={t('presentationTemplates.import')}>
                <Button
                  aria-label={t('presentationTemplates.import')}
                  className={workspaceStyles.iconButton}
                  disabled={loading || Boolean(pending)}
                  icon={<Icon aria-hidden icon={Upload} size={22} />}
                  loading={pending === 'import'}
                  type="text"
                  onClick={() => fileInput.current?.click()}
                />
              </Tooltip>
              <input
                hidden
                accept=".pptx,application/vnd.openxmlformats-officedocument.presentationml.presentation"
                aria-label={t('presentationTemplates.import')}
                ref={fileInput}
                type="file"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = '';
                  if (file) void importPptx(file);
                }}
              />
            </Flexbox>

            {nativeTemplate && (
              <Flexbox gap={8}>
                <Flexbox horizontal align="center" gap={8}>
                  <span className={styles.name}>{nativeTemplate.name}</span>
                  <Button
                    aria-label={t('presentationTemplates.nativeClose')}
                    disabled={Boolean(pending)}
                    icon={<Icon aria-hidden icon={X} size={20} />}
                    type="text"
                    onClick={() => setNativeTemplate(null)}
                  />
                </Flexbox>
                <Flexbox horizontal align="end" gap={8}>
                  <Input.TextArea
                    aria-label={t('presentationTemplates.nativePrompt')}
                    autoSize={{ minRows: 2, maxRows: 5 }}
                    disabled={Boolean(pending)}
                    maxLength={3800}
                    placeholder={t('presentationTemplates.nativePlaceholder')}
                    value={nativePrompt}
                    onChange={(event) => setNativePrompt(event.target.value)}
                  />
                  <Button
                    aria-label={t('presentationTemplates.nativeRun')}
                    className={workspaceStyles.iconButton}
                    disabled={!nativePrompt.trim() || Boolean(pending)}
                    icon={<Icon aria-hidden icon={ArrowRight} size={22} />}
                    loading={pending === 'native'}
                    type="text"
                    onClick={() => void editNative()}
                  />
                </Flexbox>
                {nativeDownload && (
                  <a download="presentation.pptx" href={nativeDownload}>
                    {t('presentationTemplates.nativeDownload')}
                  </a>
                )}
              </Flexbox>
            )}

            {clarification && (
              <section
                aria-label={t('presentationTemplates.clarification')}
                className={styles.learning}
              >
                <p className={styles.learningQuestion}>{clarification.question.question}</p>
                <p className={styles.learningReason}>{clarification.question.reason}</p>
                <div className={styles.learningChoices}>
                  {clarification.question.choices.map((choice) => (
                    <Tooltip key={choice.id} title={choice.consequence}>
                      <Button
                        disabled={Boolean(pending)}
                        size="small"
                        type={
                          choice.id === clarification.question.recommendedChoiceId
                            ? 'primary'
                            : 'default'
                        }
                        onClick={() => void continueLearning(choice.label, choice.id)}
                      >
                        {choice.label}
                      </Button>
                    </Tooltip>
                  ))}
                </div>
                <Flexbox horizontal align="end" gap={6}>
                  <Input.TextArea
                    aria-label={t('presentationTemplates.clarificationAnswer')}
                    autoSize={{ maxRows: 4, minRows: 1 }}
                    disabled={Boolean(pending)}
                    maxLength={2000}
                    placeholder={t('presentationTemplates.clarificationPlaceholder')}
                    value={guidance}
                    onChange={(event) => setGuidance(event.target.value)}
                  />
                  <Button
                    aria-label={t('presentationTemplates.continueLearning')}
                    className={workspaceStyles.iconButton}
                    disabled={!guidance.trim() || Boolean(pending)}
                    icon={<Icon aria-hidden icon={ArrowRight} size={20} />}
                    loading={pending?.startsWith('clarify:')}
                    type="text"
                    onClick={() => void continueLearning(guidance)}
                  />
                </Flexbox>
              </section>
            )}

            {error && (
              <p className={styles.error} role="alert">
                {error}
              </p>
            )}
            {notice && (
              <div className={styles.notice} role="status">
                <Icon aria-hidden icon={Check} size={14} />
                {notice}
              </div>
            )}

            <div aria-busy={loading} className={styles.list}>
              {!jobId && selectedTemplate && (
                <Button
                  aria-label={t('presentationTemplates.clear')}
                  className={styles.template}
                  disabled={Boolean(pending)}
                  icon={<Icon aria-hidden icon={X} size={20} />}
                  type="text"
                  onClick={() => {
                    onSelectTemplate?.(null);
                    setOpen(false);
                  }}
                >
                  {t('presentationTemplates.clear')}
                </Button>
              )}
              {loading ? (
                <div className={styles.empty}>
                  <Spin size="small" />
                </div>
              ) : templates.length === 0 ? (
                <div className={styles.empty}>{t('presentationTemplates.empty')}</div>
              ) : (
                templates.map((template) => (
                  <Flexbox
                    horizontal
                    align="center"
                    gap={4}
                    key={`${template.templateId}:${template.versionId}`}
                  >
                    <Tooltip
                      title={t(
                        jobId ? 'presentationTemplates.apply' : 'presentationTemplates.select',
                        { name: template.name },
                      )}
                    >
                      <Button
                        className={styles.template}
                        disabled={Boolean(pending)}
                        loading={pending === template.templateId}
                        type="text"
                        aria-label={t(
                          jobId ? 'presentationTemplates.apply' : 'presentationTemplates.select',
                          { name: template.name },
                        )}
                        aria-pressed={
                          !jobId &&
                          selectedTemplate?.templateId === template.templateId &&
                          selectedTemplate.versionId === template.versionId
                        }
                        onClick={() => void apply(template)}
                      >
                        <Icon aria-hidden icon={LayoutTemplate} size={22} />
                        <span className={styles.name}>
                          {template.name}
                          {template.learning && (
                            <span className={styles.learningReason}>
                              {' · '}
                              {t('presentationTemplates.learningCoverage', {
                                observed: template.learning.observedPages.length,
                                total: template.learning.totalPages,
                              })}
                              {' · '}
                              {t(`presentationTemplates.learningState.${template.learning.state}`)}
                            </span>
                          )}
                        </span>
                        <span aria-hidden className={styles.palette}>
                          {template.constraints?.palette.slice(0, 3).map((color, index) => (
                            <span key={`${color}:${index}`} style={{ backgroundColor: color }} />
                          ))}
                        </span>
                        <Icon
                          aria-hidden
                          size={16}
                          icon={
                            !jobId &&
                            selectedTemplate?.templateId === template.templateId &&
                            selectedTemplate.versionId === template.versionId
                              ? Check
                              : ArrowRight
                          }
                        />
                      </Button>
                    </Tooltip>
                    {template.source?.kind === 'pptx' && (
                      <Tooltip title={t('presentationTemplates.nativeModify')}>
                        <Button
                          disabled={!!pending}
                          icon={<Icon icon={FilePenLine} size={22} />}
                          type="text"
                          aria-label={t('presentationTemplates.nativeModifyNamed', {
                            name: template.name,
                          })}
                          onClick={() => {
                            setNativeTemplate(template);
                            setNativePrompt('');
                            setNativeDownload(undefined);
                            setNotice(null);
                            setError(null);
                          }}
                        />
                      </Tooltip>
                    )}
                    <Popconfirm
                      cancelText={t('presentationTemplates.deleteCancel')}
                      description={t('presentationTemplates.deleteDescription')}
                      okButtonProps={{ danger: true }}
                      okText={t('presentationTemplates.deleteConfirm')}
                      title={t('presentationTemplates.deleteTitle', { name: template.name })}
                      onConfirm={() => removeTemplate(template)}
                    >
                      <Tooltip title={t('presentationTemplates.delete')}>
                        <Button
                          disabled={Boolean(pending)}
                          icon={<Icon aria-hidden icon={Trash2} size={19} />}
                          loading={pending === `delete:${template.templateId}`}
                          type="text"
                          aria-label={t('presentationTemplates.deleteNamed', {
                            name: template.name,
                          })}
                        />
                      </Tooltip>
                    </Popconfirm>
                  </Flexbox>
                ))
              )}
            </div>
          </section>
        }
        onOpenChange={setOpen}
      >
        <Tooltip
          title={open ? undefined : selectedTemplate?.name || t('presentationTemplates.title')}
        >
          <Button
            aria-expanded={open}
            aria-label={t('presentationTemplates.title')}
            aria-pressed={Boolean(selectedTemplate)}
            className={workspaceStyles.iconButton}
            icon={<Icon aria-hidden icon={LayoutTemplate} size={22} />}
            type="text"
          />
        </Tooltip>
      </Popover>
    );
  },
);

TemplateLibraryButton.displayName = 'TemplateLibraryButton';

export default TemplateLibraryButton;
