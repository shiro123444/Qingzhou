import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ConfigProvider, Modal } from 'antd';
import i18n from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { SWRConfig } from 'swr';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import setting from '@/locales/default/setting';
import { agentHarnessService } from '@/services/agentHarness';

import HarnessExperiments from './HarnessExperiments';

const text = (key: keyof typeof setting) => i18n.t(key, { ns: 'setting' });
const snapshot = (generation = 7) => ({
  enabled: true,
  contextStrategies: [],
  state: {
    scope: { userId: 'owner', agentId: 'agent' },
    sourceRevisionId: 'source',
    sourceGeneration: 3,
    publicationGeneration: generation,
    sourceCurrent: true,
    activeCurrent: false,
    experiments: {
      'experiment-id': {
        id: 'experiment-id',
        baselineId: 'source',
        candidateId: 'candidate',
        status: 'completed',
        validation: 'passed',
        validationDigest: `view-${generation}`,
        patch: { surface: 'chat.systemRole', value: 'Candidate instructions' },
        attempts: [],
        comparisons: [{ taskId: 'trial', choice: 'candidate', rationale: 'Fixture' }],
        validationComparisons: [
          { taskId: 'a', choice: 'candidate', rationale: 'Fixture' },
          { taskId: 'b', choice: 'candidate', rationale: 'Fixture' },
        ],
      },
    },
    active: undefined,
  },
});
beforeEach(() => {
  i18n.addResourceBundle('zh-CN', 'setting', setting, true, true);
});
afterEach(() => {
  act(() => Modal.destroyAll());
  cleanup();
  vi.restoreAllMocks();
});
const show = () =>
  render(
    <I18nextProvider i18n={i18n}>
      <ConfigProvider theme={{ token: { motion: false } }}>
        <SWRConfig value={{ provider: () => new Map(), revalidateOnFocus: false }}>
          <HarnessExperiments agentId={'agent'} />
        </SWRConfig>
      </ConfigProvider>
    </I18nextProvider>,
  );
async function confirmAdoption() {
  fireEvent.click(await screen.findByText(/experime.*·/u));
  fireEvent.click(await screen.findByRole('button', { name: text('harness.adopt') }));
  const dialog = await screen.findByRole('dialog');
  fireEvent.click(within(dialog).getByRole('button', { name: /OK|确定/u }));
}

describe('explicit harness publication confirmation', () => {
  it('registers a versioned parser from server discovery and displays its server-only scope and original version', async () => {
    const data = {
      ...snapshot(),
      skillMaterialProviders: [
        { value: 'skills.sections@1.0.0', labelKey: 'harness.materialSections' },
      ],
      state: {
        ...snapshot().state,
        managedSkills: [{ bindingId: 'binding', name: 'procedure', body: 'original' }],
        experiments: {
          'experiment-id': {
            ...snapshot().state.experiments['experiment-id'],
            patch: { surface: 'context.skillMaterial', value: 'skills.sections@1.0.0' },
            materialBaselineProvider: 'skills.raw@1.0.0',
          },
        },
      },
    };
    vi.spyOn(agentHarnessService, 'get').mockResolvedValue(data as any);
    const command = vi.spyOn(agentHarnessService, 'command').mockResolvedValue(undefined);
    show();
    fireEvent.mouseDown(await screen.findByRole('combobox', { name: text('harness.surface') }));
    fireEvent.click(
      await screen.findByText(text('harness.skillMaterial'), {
        selector: '.ant-select-item-option-content',
      }),
    );
    expect(screen.getByText(text('harness.materialScope'))).toBeVisible();
    for (const [index, key] of (
      ['harness.trialTask', 'harness.validationTask', 'harness.validationTask'] as const
    ).entries())
      fireEvent.change(
        screen.getByRole('textbox', { name: i18n.t(key, { ns: 'setting', number: index }) }),
        { target: { value: `Task ${index}` } },
      );
    fireEvent.click(screen.getByRole('button', { name: text('harness.register') }));
    await waitFor(() =>
      expect(command).toHaveBeenCalledWith({
        agentId: 'agent',
        command: expect.objectContaining({
          surface: 'context.skillMaterial',
          systemRole: 'skills.sections@1.0.0',
        }),
      }),
    );
    fireEvent.click(await screen.findByText(/experime.*·/u));
    expect(screen.getByRole('textbox', { name: text('harness.originalMaterial') })).toHaveValue(
      'skills.raw@1.0.0',
    );
  });
  it('registers a managed body against an explicit resource identity and shows the original without changing its loading policy', async () => {
    const data = {
      ...snapshot(),
      state: {
        ...snapshot().state,
        managedSkills: [
          {
            bindingId: '11111111-1111-4111-8111-111111111111',
            identifier: 'managed-skill:11111111-1111-4111-8111-111111111111',
            name: 'text-procedure',
            body: 'Original skill procedure',
          },
        ],
      },
    };
    vi.spyOn(agentHarnessService, 'get').mockResolvedValue(data as any);
    const command = vi.spyOn(agentHarnessService, 'command').mockResolvedValue(undefined);
    show();
    fireEvent.mouseDown(await screen.findByRole('combobox', { name: text('harness.surface') }));
    fireEvent.click(
      await screen.findByText(text('harness.managedSkill'), {
        selector: '.ant-select-item-option-content',
      }),
    );
    fireEvent.mouseDown(screen.getByRole('combobox', { name: text('harness.managedSkill') }));
    fireEvent.click(
      await screen.findByText('text-procedure', { selector: '.ant-select-item-option-content' }),
    );
    expect(screen.getByRole('textbox', { name: text('harness.originalSkillBody') })).toHaveValue(
      'Original skill procedure',
    );
    expect(
      screen.getByRole('textbox', { name: text('harness.originalSkillBody') }),
    ).toHaveAttribute('readonly');
    fireEvent.change(screen.getByRole('textbox', { name: text('harness.skillBody') }), {
      target: { value: 'Candidate skill procedure' },
    });
    for (const [index, key] of (
      ['harness.trialTask', 'harness.validationTask', 'harness.validationTask'] as const
    ).entries())
      fireEvent.change(
        screen.getByRole('textbox', { name: i18n.t(key, { ns: 'setting', number: index }) }),
        { target: { value: `Task ${index}` } },
      );
    fireEvent.click(screen.getByRole('button', { name: text('harness.register') }));
    await waitFor(() =>
      expect(command).toHaveBeenCalledWith({
        agentId: 'agent',
        command: expect.objectContaining({
          action: 'propose',
          baselineId: 'source',
          surface: 'managed.skillBody',
          targetBindingId: '11111111-1111-4111-8111-111111111111',
          systemRole: 'Candidate skill procedure',
        }),
      }),
    );
  });
  it('submits the displayed source, publication generation and validation manifest', async () => {
    vi.spyOn(agentHarnessService, 'get').mockResolvedValue(snapshot() as any);
    const command = vi.spyOn(agentHarnessService, 'command').mockResolvedValue(undefined);
    show();
    await confirmAdoption();
    await waitFor(() =>
      expect(command).toHaveBeenCalledWith({
        agentId: 'agent',
        command: expect.objectContaining({
          action: 'adopt',
          candidateId: 'candidate',
          experimentId: 'experiment-id',
          expectedGeneration: 7,
          expectedSourceId: 'source',
          expectedSourceGeneration: 3,
          validationDigest: 'view-7',
        }),
      }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('refreshes a conflicting comparison and waits for a new user confirmation', async () => {
    const get = vi
      .spyOn(agentHarnessService, 'get')
      .mockResolvedValueOnce(snapshot() as any)
      .mockResolvedValue(snapshot(9) as any);
    const command = vi
      .spyOn(agentHarnessService, 'command')
      .mockRejectedValueOnce(new Error('HARNESS_CAS_CONFLICT'))
      .mockResolvedValue(undefined);
    show();
    await confirmAdoption();
    await screen.findByText(text('harness.reviewChanged'));
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    expect(command).toHaveBeenCalledTimes(1);
    // No automatic approval of the refreshed state.
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: text('harness.adopt') }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: /OK|确定/u }));
    await waitFor(() => expect(command).toHaveBeenCalledTimes(2));
    expect(command.mock.calls[1][0].command).toMatchObject({
      expectedGeneration: 9,
      validationDigest: 'view-9',
    });
  });
});
