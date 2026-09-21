import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import i18n from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { presentationTemplateClient } from '@/services/runtime/templateClient';

import TemplateLibraryButton from './TemplateLibraryButton';

const template = { name: 'Calm blue', templateId: 'template-1', versionId: 'version-2' };
const renderLibrary = (onJobChanged = vi.fn().mockResolvedValue(undefined)) =>
  render(
    <I18nextProvider i18n={i18n}>
      <TemplateLibraryButton jobId="job-1" jobTitle="My presentation" onJobChanged={onJobChanged} />
    </I18nextProvider>,
  );

beforeEach(() => {
  vi.spyOn(presentationTemplateClient, 'analyze').mockResolvedValue({
    learning: { guidanceHistory: [], iteration: 1, questions: [], status: 'ready' },
    templateId: template.templateId,
    versionId: template.versionId,
  });
});
afterEach(() => vi.restoreAllMocks());

describe('TemplateLibraryButton', () => {
  it('edits native templates through composed skills and keeps the same request when retrying', async () => {
    const native = { ...template, source: { kind: 'pptx' } };
    vi.spyOn(presentationTemplateClient, 'list').mockResolvedValue([native]);
    vi.spyOn(presentationTemplateClient, 'listNativeOutputs').mockResolvedValue({
      outputs: [
        { artifactId: 'previous', uri: '/api/runtime/presentation/artifacts/previous?raw=true' },
      ],
    });
    const fill = vi
      .spyOn(presentationTemplateClient, 'fillNative')
      .mockRejectedValueOnce(new Error('Please retry'))
      .mockResolvedValue({
        summary: 'Done',
        result: {
          artifactId: 'native-result',
          uri: '/api/runtime/presentation/artifacts/native-result?raw=true',
        },
      });
    const apply = vi.spyOn(presentationTemplateClient, 'apply');
    renderLibrary();
    fireEvent.click(screen.getByRole('button', { name: 'Templates' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Edit original Calm blue' }));
    expect(await screen.findByRole('link', { name: 'Download PPTX' })).toHaveAttribute(
      'href',
      '/api/runtime/presentation/artifacts/previous?raw=true',
    );
    fireEvent.change(screen.getByRole('textbox', { name: 'Native editing instructions' }), {
      target: { value: 'Change only the title on page 4' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Apply native edits' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Please retry');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Apply native edits' })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Apply native edits' }));
    expect(await screen.findByRole('link', { name: 'Download PPTX' })).toHaveAttribute(
      'href',
      '/api/runtime/presentation/artifacts/native-result?raw=true',
    );
    expect(fill.mock.calls[0]).toEqual([
      native,
      'Change only the title on page 4',
      expect.any(String),
    ]);
    expect(fill.mock.calls[1]).toEqual(fill.mock.calls[0]);
    expect(apply).not.toHaveBeenCalled();
  }, 20000);

  it('learns from the current presentation and pins the selected template version when applying', async () => {
    vi.spyOn(presentationTemplateClient, 'list').mockResolvedValue([]);
    const learn = vi.spyOn(presentationTemplateClient, 'learn').mockResolvedValue(template);
    const apply = vi
      .spyOn(presentationTemplateClient, 'apply')
      .mockRejectedValueOnce(new Error('Connection interrupted'))
      .mockResolvedValue({ createdAt: '', updatedAt: '', jobId: 'job-1', state: 'queued' });
    const onJobChanged = vi.fn().mockResolvedValue(undefined);
    renderLibrary(onJobChanged);

    fireEvent.click(screen.getByRole('button', { name: 'Templates' }));
    await screen.findByText('No saved templates yet');
    fireEvent.change(screen.getByRole('textbox', { name: 'Template name' }), {
      target: { value: template.name },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Learn from this presentation' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Saved Calm blue');
    expect(learn).toHaveBeenCalledWith('job-1', template.name);

    const applyButton = screen.getByRole('button', { name: 'Apply Calm blue' });
    fireEvent.click(applyButton);
    expect(await screen.findByRole('alert')).toHaveTextContent('Connection interrupted');
    expect(onJobChanged).not.toHaveBeenCalled();
    fireEvent.click(applyButton);
    await waitFor(() => expect(onJobChanged).toHaveBeenCalledOnce());
    const firstInput = apply.mock.calls[0][1];
    expect(firstInput).toEqual({
      requestId: expect.any(String),
      templateId: 'template-1',
      versionId: 'version-2',
    });
    expect(apply.mock.calls[1][1]).toEqual(firstInput);
  }, 20000);

  it('imports a PPTX file and exposes it in the selectable library', async () => {
    vi.spyOn(presentationTemplateClient, 'list').mockResolvedValue([]);
    const importPptx = vi
      .spyOn(presentationTemplateClient, 'importPptx')
      .mockResolvedValue(template);
    renderLibrary();
    fireEvent.click(screen.getByRole('button', { name: 'Templates' }));
    await screen.findByText('No saved templates yet');
    const file = new File(['PPTX fixture'], 'Calm blue.pptx', {
      type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    });
    fireEvent.change(screen.getByLabelText('Import a reference PPTX', { selector: 'input' }), {
      target: { files: [file] },
    });
    expect(await screen.findByRole('button', { name: 'Apply Calm blue' })).toBeEnabled();
    expect(importPptx).toHaveBeenCalledWith(file, 'Calm blue');
  }, 20000);

  it('selects a template for a new presentation without applying it to a job', async () => {
    vi.spyOn(presentationTemplateClient, 'list').mockResolvedValue([template]);
    const apply = vi.spyOn(presentationTemplateClient, 'apply');
    const onSelectTemplate = vi.fn();
    render(
      <I18nextProvider i18n={i18n}>
        <TemplateLibraryButton selectedTemplate={template} onSelectTemplate={onSelectTemplate} />
      </I18nextProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Templates' }));
    expect(await screen.findByRole('button', { name: 'Use Calm blue' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(
      screen.queryByRole('button', { name: 'Learn from this presentation' }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'No template' }));
    expect(onSelectTemplate).toHaveBeenCalledWith(null);
    fireEvent.click(screen.getByRole('button', { name: 'Templates' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Use Calm blue' }));
    await waitFor(() => expect(onSelectTemplate).toHaveBeenLastCalledWith(template));
    expect(apply).not.toHaveBeenCalled();
    expect(presentationTemplateClient.analyze).not.toHaveBeenCalled();
  }, 20000);

  it('requires confirmation and removes a template from the real library list', async () => {
    vi.spyOn(presentationTemplateClient, 'list').mockResolvedValue([template]);
    const remove = vi.spyOn(presentationTemplateClient, 'remove').mockResolvedValue(undefined);
    const onSelectTemplate = vi.fn();
    render(
      <I18nextProvider i18n={i18n}>
        <TemplateLibraryButton selectedTemplate={template} onSelectTemplate={onSelectTemplate} />
      </I18nextProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Templates' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Delete Calm blue' }));
    expect(await screen.findByText('Delete Calm blue?')).toBeInTheDocument();
    expect(remove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(remove).toHaveBeenCalledWith('template-1'));
    expect(onSelectTemplate).toHaveBeenCalledWith(null);
    expect(screen.queryByRole('button', { name: 'Use Calm blue' })).not.toBeInTheDocument();
  });

  it('ends the import spinner after saving and hands learning to the main conversation', async () => {
    vi.spyOn(presentationTemplateClient, 'list').mockResolvedValue([]);
    vi.spyOn(presentationTemplateClient, 'importPptx').mockResolvedValue(template);
    const onSelectTemplate = vi.fn();
    render(
      <I18nextProvider i18n={i18n}>
        <TemplateLibraryButton onSelectTemplate={onSelectTemplate} />
      </I18nextProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Templates' }));
    await screen.findByText('No saved templates yet');
    const file = new File(['PPTX fixture'], 'Calm blue.pptx', {
      type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    });
    fireEvent.change(screen.getByLabelText('Import a reference PPTX', { selector: 'input' }), {
      target: { files: [file] },
    });

    await waitFor(() => expect(onSelectTemplate).toHaveBeenCalledWith(template));
    expect(presentationTemplateClient.analyze).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Templates' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });

  it('pauses on a material learning ambiguity and resumes with the user decision', async () => {
    vi.spyOn(presentationTemplateClient, 'list').mockResolvedValue([template]);
    const analyze = vi.mocked(presentationTemplateClient.analyze);
    analyze
      .mockResolvedValueOnce({
        learning: {
          guidanceHistory: [],
          iteration: 1,
          questions: [
            {
              choices: [
                { consequence: 'Keep motion', id: 'preserve', label: 'Keep the original video' },
                { consequence: 'Use a still', id: 'poster', label: 'Keep only the poster' },
              ],
              id: 'video-role',
              page: 3,
              question: 'How should the video on page 3 be handled?',
              reason: 'Frames do not reveal whether motion is essential.',
              recommendedChoiceId: 'preserve',
            },
          ],
          status: 'needs_input',
        },
        templateId: template.templateId,
        versionId: template.versionId,
      })
      .mockResolvedValueOnce({
        learning: {
          guidanceHistory: ['Keep the original video'],
          iteration: 2,
          questions: [],
          status: 'ready',
        },
        templateId: template.templateId,
        versionId: template.versionId,
      });
    const onSelectTemplate = vi.fn();
    const onJobChanged = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(presentationTemplateClient, 'apply').mockResolvedValue({
      createdAt: '',
      jobId: 'job-1',
      state: 'queued',
      updatedAt: '',
    });
    render(
      <I18nextProvider i18n={i18n}>
        <TemplateLibraryButton
          jobId="job-1"
          onJobChanged={onJobChanged}
          onSelectTemplate={onSelectTemplate}
        />
      </I18nextProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Templates' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Apply Calm blue' }));
    expect(
      await screen.findByText('How should the video on page 3 be handled?'),
    ).toBeInTheDocument();
    expect(onJobChanged).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Keep the original video' }));
    await waitFor(() => expect(onJobChanged).toHaveBeenCalledOnce());
    expect(onSelectTemplate).not.toHaveBeenCalled();
    expect(analyze).toHaveBeenNthCalledWith(
      2,
      template,
      'Keep the original video',
      'video-role',
      'preserve',
    );
  }, 20000);
});
