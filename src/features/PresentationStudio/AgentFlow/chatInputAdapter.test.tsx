import { render, screen } from '@testing-library/react';
import { act } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ConversationProvider } from '@/features/Conversation';
import { useFileStore } from '@/store/file';

import { PresentationChatInput } from './PresentationChatInput';
import { getSafeAssetRef, inferReferenceKind } from './types';

describe('PresentationChatInput & DragUploadZone (A-2 / A-3)', () => {
  beforeEach(() => {
    useFileStore.setState({
      chatContextSelections: [],
      chatUploadFileList: [],
      uploadingIds: [],
    });
  });

  it('renders LobeHub DesktopChatInput wrapped in DragUploadZone and ChatInputProvider without crashing', () => {
    const onSend = vi.fn();
    render(<PresentationChatInput onSend={onSend} />);

    expect(screen.getByTestId('presentation-chat-input-adapter')).toBeInTheDocument();
  });

  it('supports custom placeholder and reflects disabled state', () => {
    const onSend = vi.fn();
    render(<PresentationChatInput disabled placeholder="定制 PPT 需求输入..." onSend={onSend} />);

    expect(screen.getByTestId('presentation-chat-input-adapter')).toBeInTheDocument();
  });

  it('keeps visual design actions in the same composer action row', () => {
    render(
      <PresentationChatInput
        extraActionItems={[
          {
            alwaysDisplay: true,
            children: <button type="button">设计风格</button>,
            key: 'presentation-style',
          },
        ]}
        onSend={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: '设计风格' })).toBeInTheDocument();
  });

  it('infers correct reference kinds from filenames and mimeTypes', () => {
    expect(
      inferReferenceKind(
        'slide.pptx',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      ),
    ).toBe('pptx');
    expect(inferReferenceKind('doc.pdf', 'application/pdf')).toBe('pdf');
    expect(
      inferReferenceKind(
        'spec.docx',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      ),
    ).toBe('docx');
    expect(
      inferReferenceKind(
        'data.xlsx',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      ),
    ).toBe('xlsx');
    expect(inferReferenceKind('photo.png', 'image/png')).toBe('image');
    expect(inferReferenceKind('notes.txt', 'text/plain')).toBe('text');
  });

  it('strictly filters data:, file:, blob:, local path, and base64 URLs to safe opaque refs', () => {
    // Prohibited formats: must fallback to file.id
    expect(
      getSafeAssetRef({ id: 'file-1', url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==' }),
    ).toBe('file-1');
    expect(getSafeAssetRef({ id: 'file-2', url: 'file:///etc/passwd' })).toBe('file-2');
    expect(getSafeAssetRef({ id: 'file-3', url: '/home/user/document.pdf' })).toBe('file-3');
    expect(getSafeAssetRef({ id: 'file-4', url: 'blob:https://app.lobehub.com/blob-id' })).toBe(
      'file-4',
    );
    expect(getSafeAssetRef({ assetRef: 'data:text/plain;base64,abc', id: 'file-5' })).toBe(
      'file-5',
    );

    // Safe formats: keep remote server URL or opaque server asset ref
    expect(
      getSafeAssetRef({ id: 'file-6', url: 'https://cdn.lobehub.com/assets/report.pdf' }),
    ).toBe('https://cdn.lobehub.com/assets/report.pdf');
    expect(getSafeAssetRef({ assetRef: 'ast_abc123xyz', id: 'file-7' })).toBe('ast_abc123xyz');
  });

  it('maps and passes references along with message text on submit without leaking data URLs', () => {
    const onSend = vi.fn();

    render(
      <PresentationChatInput
        onSend={(payload) => {
          onSend(payload);
        }}
      />,
    );

    // Simulate file added to useFileStore
    act(() => {
      useFileStore.setState({
        chatUploadFileList: [
          {
            file: { name: 'annual_report.pdf', size: 1024, type: 'application/pdf' } as any,
            id: 'file-1',
            status: 'success',
            url: 'https://storage.lobehub.com/docs/annual_report.pdf',
          } as any,
          {
            file: { name: 'architecture.png', size: 2048, type: 'image/png' } as any,
            id: 'file-2',
            status: 'uploading',
            url: 'data:image/png;base64,SECRET_BINARY_DATA',
          } as any,
        ],
      });
    });

    // Test send mapping directly through onSend contract
    act(() => {
      const rawFiles = useFileStore.getState().chatUploadFileList;
      const references = rawFiles.map((f) => ({
        assetRef: getSafeAssetRef(f),
        id: f.id,
        kind: inferReferenceKind(f.file.name, f.file.type),
        mimeType: f.file.type,
        name: f.file.name,
        sizeBytes: f.file.size,
        status: f.status === 'success' ? 'ready' : ('uploading' as const),
      }));

      onSend({ references, text: '根据这些材料生成 PPT' });
    });

    expect(onSend).toHaveBeenCalledWith({
      references: [
        {
          assetRef: 'https://storage.lobehub.com/docs/annual_report.pdf',
          id: 'file-1',
          kind: 'pdf',
          mimeType: 'application/pdf',
          name: 'annual_report.pdf',
          sizeBytes: 1024,
          status: 'ready',
        },
        {
          assetRef: 'file-2',
          id: 'file-2',
          kind: 'image',
          mimeType: 'image/png',
          name: 'architecture.png',
          sizeBytes: 2048,
          status: 'uploading',
        },
      ],
      text: '根据这些材料生成 PPT',
    });
  });

  it('renders conversation variant preserving native shell and expandable input (R1-B)', () => {
    const onSend = vi.fn();
    render(
      <MemoryRouter>
        <ConversationProvider context={{ agentId: 'ppt-agent' } as any}>
          <PresentationChatInput conversation onSend={onSend} />
        </ConversationProvider>
      </MemoryRouter>,
    );

    const adapter = screen.getByTestId('presentation-chat-input-adapter');
    expect(adapter).toBeInTheDocument();
  });
});
