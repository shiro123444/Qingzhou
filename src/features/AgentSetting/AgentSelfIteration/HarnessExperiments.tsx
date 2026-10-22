'use client';

import { Alert, Button, Collapse, Flex, Input, Modal, Select, Typography } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import useSWR from 'swr';

import { agentHarnessService } from '@/services/agentHarness';

const trialBudget = {
  calls: 3,
  inputBytesPerCall: 32000,
  outputTokensPerCall: 512,
  deadlineMs: 120000,
  tokens: 120000,
  costMicros: 150000,
  costMicrosPerCall: 50000,
};

/** Own-account experiments live beside the existing self-iteration control. */
export default function HarnessExperiments({ agentId }: { agentId: string }) {
  const { t } = useTranslation('setting');
  const { data, error, mutate } = useSWR(['agent-harness', agentId], () =>
    agentHarnessService.get(agentId),
  );
  const [systemRole, setSystemRole] = useState('');
  const [surface, setSurface] = useState<
    'chat.systemRole' | 'chat.contextStrategy' | 'managed.skillBody' | 'context.skillMaterial'
  >('chat.systemRole');
  const [strategy, setStrategy] = useState('evidence-first');
  const [materialProvider, setMaterialProvider] = useState('skills.sections@1.0.0');
  const [targetBindingId, setTargetBindingId] = useState('');
  const [tasks, setTasks] = useState(['', '', '']);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState('');
  const [modal, contextHolder] = Modal.useModal();
  if (!data?.enabled && !data?.state?.active && !error) return null;
  const state = data?.state;
  const run = async (command: Parameters<typeof agentHarnessService.command>[0]['command']) => {
    setPending(true);
    setFailure('');
    try {
      await agentHarnessService.command({ agentId, command });
      await mutate();
    } catch (e) {
      const message = e instanceof Error ? e.message : '';
      if (
        /HARNESS_(?:CAS_CONFLICT|STALE_SOURCE|STALE_VALIDATION|DECISION_CONFLICT|SOURCE_RECAPTURE_REQUIRED)/u.test(
          message,
        )
      ) {
        setFailure(t('harness.reviewChanged'));
        await mutate().catch(() => undefined);
      } else setFailure(message || t('harness.failed'));
    } finally {
      setPending(false);
    }
  };
  const experiments = Object.values(state?.experiments ?? {}).reverse();
  return (
    <Flex vertical gap={16}>
      {contextHolder}
      <Typography.Title level={5}>{t('harness.title')}</Typography.Title>
      <Typography.Paragraph>{t('harness.description')}</Typography.Paragraph>
      {state?.sourceRevisionId && !state.sourceCurrent && (
        <Alert type={'warning'} title={t('harness.sourceOutdated')} />
      )}
      {state?.active && !state.activeCurrent && (
        <Alert type={'warning'} title={t('harness.activeOutdated')} />
      )}
      {(error || failure) && (
        <Alert role={'alert'} title={failure || t('harness.failed')} type={'error'} />
      )}
      {!state?.sourceRevisionId ? (
        <Typography.Text>{t('harness.noSource')}</Typography.Text>
      ) : (
        <>
          <Select
            aria-label={t('harness.surface')}
            value={surface}
            options={[
              { value: 'chat.systemRole', label: t('harness.instructions') },
              { value: 'chat.contextStrategy', label: t('harness.contextStrategy') },
              { value: 'managed.skillBody', label: t('harness.managedSkill') },
              { value: 'context.skillMaterial', label: t('harness.skillMaterial') },
            ]}
            onChange={setSurface}
          />
          {surface === 'managed.skillBody' && (
            <>
              <Typography.Paragraph>{t('harness.managedSkillScope')}</Typography.Paragraph>
              <Select
                aria-label={t('harness.managedSkill')}
                value={targetBindingId || undefined}
                options={(state.managedSkills ?? []).map((skill) => ({
                  value: skill.bindingId,
                  label: skill.name,
                }))}
                onChange={(id) => {
                  setTargetBindingId(id);
                  setSystemRole('');
                }}
              />
              <Input.TextArea
                readOnly
                rows={4}
                aria-label={t('harness.originalSkillBody')}
                value={
                  state.managedSkills?.find((skill) => skill.bindingId === targetBindingId)?.body ??
                  ''
                }
              />
              {!state.managedSkills?.length && (
                <Alert type={'info'} title={t('harness.noEligibleSkill')} />
              )}
            </>
          )}
          {surface === 'context.skillMaterial' ? (
            <>
              <Typography.Paragraph>{t('harness.materialScope')}</Typography.Paragraph>
              <Select
                aria-label={t('harness.skillMaterial')}
                value={materialProvider}
                options={(data?.skillMaterialProviders ?? []).map((option) => ({
                  value: option.value,
                  label: `${t(option.labelKey)} · ${option.value}`,
                }))}
                onChange={setMaterialProvider}
              />
              {!state.managedSkills?.length && (
                <Alert type={'info'} title={t('harness.noEligibleSkill')} />
              )}
            </>
          ) : surface === 'chat.contextStrategy' ? (
            <Select
              aria-label={t('harness.contextStrategy')}
              value={strategy}
              options={data?.contextStrategies.map((option) => ({
                value: option.value,
                label: t(option.labelKey),
              }))}
              onChange={setStrategy}
            />
          ) : (
            <Input.TextArea
              aria-label={t(
                surface === 'managed.skillBody' ? 'harness.skillBody' : 'harness.instructions',
              )}
              placeholder={t(
                surface === 'managed.skillBody' ? 'harness.skillBody' : 'harness.instructions',
              )}
              rows={4}
              value={systemRole}
              onChange={(e) => setSystemRole(e.target.value)}
            />
          )}
          {state.instructionProposals
            ?.filter((proposal) => proposal.baselineId === state.sourceRevisionId)
            .map((proposal) => (
              <Alert
                key={proposal.id}
                title={t('harness.signalProposal')}
                type={'info'}
                description={
                  <Flex vertical gap={8}>
                    <Typography.Paragraph>{proposal.rationale}</Typography.Paragraph>
                    <Button
                      disabled={pending || !data?.enabled}
                      onClick={() => {
                        setSurface('chat.systemRole');
                        setSystemRole(proposal.systemRole);
                      }}
                    >
                      {t('harness.useProposal')}
                    </Button>
                  </Flex>
                }
              />
            ))}
          {tasks.map((value, index) => (
            <Input.TextArea
              key={index}
              rows={2}
              value={value}
              aria-label={t(index === 0 ? 'harness.trialTask' : 'harness.validationTask', {
                number: index,
              })}
              placeholder={t(index === 0 ? 'harness.trialTask' : 'harness.validationTask', {
                number: index,
              })}
              onChange={(e) =>
                setTasks(tasks.map((task, i) => (i === index ? e.target.value : task)))
              }
            />
          ))}
          <Typography.Text type={'secondary'}>{t('harness.budget')}</Typography.Text>
          <Button
            disabled={
              !data?.enabled ||
              !state?.sourceCurrent ||
              pending ||
              (!['chat.contextStrategy', 'context.skillMaterial'].includes(surface) &&
                !systemRole.trim()) ||
              (surface === 'context.skillMaterial' &&
                (!state.managedSkills?.length ||
                  !data.skillMaterialProviders?.some(
                    (option) => option.value === materialProvider,
                  ))) ||
              (surface === 'managed.skillBody' &&
                !(state.managedSkills ?? []).some(
                  (skill) => skill.bindingId === targetBindingId,
                )) ||
              tasks.some((value) => !value.trim())
            }
            onClick={() =>
              void run({
                action: 'propose',
                baselineId: state.sourceRevisionId!,
                surface,
                ...(surface === 'managed.skillBody' ? { targetBindingId } : {}),
                systemRole:
                  surface === 'chat.contextStrategy'
                    ? strategy
                    : surface === 'context.skillMaterial'
                      ? materialProvider
                      : systemRole,
                tasks: [{ id: 'trial', prompt: tasks[0] }],
                heldout: [
                  { id: 'validation-a', prompt: tasks[1] },
                  { id: 'validation-b', prompt: tasks[2] },
                ],
                budget: trialBudget,
                validationBudget: { ...trialBudget, calls: 6, tokens: 240000, costMicros: 300000 },
              })
            }
          >
            {t('harness.register')}
          </Button>
        </>
      )}
      <Collapse
        items={experiments.map((experiment) => ({
          key: experiment.id,
          label: `${experiment.id.slice(0, 8)} · ${t(`harness.status.${experiment.status}`)} · ${t(`harness.validation.${experiment.validation}`)}`,
          children: (
            <Flex vertical gap={12}>
              {experiment.patch.surface === 'context.skillMaterial' && (
                <>
                  <Alert type={'info'} title={t('harness.materialScope')} />
                  <Input
                    readOnly
                    aria-label={t('harness.originalMaterial')}
                    value={experiment.materialBaselineProvider ?? ''}
                  />
                </>
              )}
              {experiment.patch.surface === 'managed.skillBody' && (
                <>
                  <Alert type={'info'} title={t('harness.managedSkillScope')} />
                  <Input.TextArea
                    readOnly
                    aria-label={t('harness.originalSkillBody')}
                    autoSize={{ minRows: 2, maxRows: 10 }}
                    value={experiment.skillBaselineBody ?? ''}
                  />
                </>
              )}
              <Input.TextArea
                readOnly
                aria-label={t(
                  experiment.patch.surface === 'managed.skillBody'
                    ? 'harness.skillBody'
                    : experiment.patch.surface === 'context.skillMaterial'
                      ? 'harness.skillMaterial'
                      : 'harness.instructions',
                )}
                autoSize={{ minRows: 2, maxRows: 10 }}
                value={experiment.patch.value}
              />
              <Typography.Text>
                {t('harness.calls', { count: experiment.attempts.length })}
              </Typography.Text>
              {experiment.error && <Alert title={experiment.error} type={'warning'} />}
              {experiment.attempts
                .filter((attempt) => attempt.receipt && !attempt.label.endsWith(':selection'))
                .map((attempt) => (
                  <Typography.Paragraph key={attempt.label}>
                    <Typography.Text strong>
                      {t(
                        attempt.label.endsWith(':baseline')
                          ? 'harness.baselineAnswer'
                          : 'harness.candidateAnswer',
                      )}
                    </Typography.Text>
                    <Input.TextArea
                      readOnly
                      autoSize={{ minRows: 2, maxRows: 10 }}
                      value={attempt.receipt!.text}
                      aria-label={t(
                        attempt.label.endsWith(':baseline')
                          ? 'harness.baselineAnswer'
                          : 'harness.candidateAnswer',
                      )}
                    />
                  </Typography.Paragraph>
                ))}
              {[...experiment.comparisons, ...experiment.validationComparisons].map(
                (comparison, index) => (
                  <Typography.Paragraph key={`${comparison.taskId}-${index}`}>
                    {t(`harness.choice.${comparison.choice}`)}: {comparison.rationale}
                  </Typography.Paragraph>
                ),
              )}
              <Flex wrap gap={8}>
                <Button
                  disabled={
                    !data?.enabled ||
                    !state?.sourceCurrent ||
                    pending ||
                    experiment.cancelRequested ||
                    experiment.status !== 'registered'
                  }
                  onClick={() => void run({ action: 'run', experimentId: experiment.id })}
                >
                  {t('harness.run')}
                </Button>
                <Button
                  disabled={
                    pending ||
                    !data?.enabled ||
                    !state?.sourceCurrent ||
                    experiment.cancelRequested ||
                    experiment.status !== 'completed' ||
                    experiment.validation !== 'pending'
                  }
                  onClick={() => void run({ action: 'validate', experimentId: experiment.id })}
                >
                  {t('harness.validate')}
                </Button>
                <Button
                  disabled={experiment.cancelRequested}
                  onClick={() =>
                    void agentHarnessService
                      .command({
                        agentId,
                        command: { action: 'cancel', experimentId: experiment.id },
                      })
                      .then(() => mutate())
                      .catch((e) => setFailure(String(e)))
                  }
                >
                  {t('harness.cancel')}
                </Button>
                <Button
                  disabled={
                    !data?.enabled ||
                    !state?.sourceCurrent ||
                    pending ||
                    experiment.cancelRequested ||
                    experiment.status !== 'completed'
                  }
                  onClick={() =>
                    void run({
                      action: 'keep',
                      id: crypto.randomUUID(),
                      experimentId: experiment.id,
                      candidateId: experiment.candidateId,
                      expectedActiveId: state?.active?.revisionId,
                      expectedGeneration: state!.publicationGeneration,
                      expectedSourceId: experiment.baselineId,
                      expectedSourceGeneration: state!.sourceGeneration,
                      validationDigest: experiment.validationDigest,
                    })
                  }
                >
                  {t('harness.keep')}
                </Button>
                <Button
                  type={'primary'}
                  disabled={
                    !data?.enabled ||
                    !state?.sourceCurrent ||
                    experiment.cancelRequested ||
                    pending ||
                    experiment.validation !== 'passed' ||
                    !experiment.comparisons.every((comparison) => comparison.choice === 'candidate')
                  }
                  onClick={() =>
                    modal.confirm({
                      title: t('harness.confirmTitle'),
                      content: t('harness.confirmDescription'),
                      onOk: () =>
                        run({
                          action: 'adopt',
                          id: crypto.randomUUID(),
                          experimentId: experiment.id,
                          candidateId: experiment.candidateId,
                          expectedActiveId: state?.active?.revisionId,
                          expectedGeneration: state!.publicationGeneration,
                          expectedSourceId: experiment.baselineId,
                          expectedSourceGeneration: state!.sourceGeneration,
                          validationDigest: experiment.validationDigest,
                        }),
                    })
                  }
                >
                  {t('harness.adopt')}
                </Button>
              </Flex>
            </Flex>
          ),
        }))}
      />
      {!!state?.intents?.length && (
        <Alert title={t('harness.pendingSkills', { count: state.intents.length })} type={'info'} />
      )}
      {state?.active && (
        <Button
          disabled={pending}
          onClick={() =>
            modal.confirm({
              title: t('harness.rollback'),
              content: t('harness.confirmDescription'),
              onOk: () =>
                run({
                  action: 'rollback',
                  id: crypto.randomUUID(),
                  expectedActiveId: state.active!.revisionId,
                  expectedGeneration: state.publicationGeneration,
                }),
            })
          }
        >
          {t('harness.rollback')}
        </Button>
      )}
    </Flex>
  );
}
