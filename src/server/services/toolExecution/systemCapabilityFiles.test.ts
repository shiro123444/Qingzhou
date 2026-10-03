// @vitest-environment node
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';

import { SystemCapabilityFileService } from './systemCapabilityFiles';

const setup = () => {
  const findFirst = vi
    .fn()
    .mockResolvedValue({
      id: 'owned-file',
      name: 'test.txt',
      fileType: 'text/plain',
      size: 6,
      url: 'owned/key',
    });
  const where = vi.fn().mockResolvedValue([]);
  const set = vi.fn().mockReturnValue({ where });
  const db = { query: { files: { findFirst } }, update: vi.fn().mockReturnValue({ set }) };
  const storage = {
    getFileByteArray: vi.fn().mockResolvedValue(Buffer.from('abcdef')),
    uploadFromBuffer: vi
      .fn()
      .mockResolvedValue({ fileId: 'new-file', key: 'new/key', url: '/f/new-file' }),
  };
  const active = vi.fn();
  const service = new SystemCapabilityFileService(
    db as any,
    'authenticated-owner',
    active,
    () => storage,
  );
  return { service, db, storage, active, findFirst, where, set };
};

describe('account capability files', () => {
  it('uses the authenticated owner predicate and reports truncated UTF-8 text', async () => {
    const { service, findFirst } = setup();
    expect(await service.readText('owned-file', 3)).toMatchObject({
      content: 'abc',
      truncated: true,
      totalChars: 6,
    });
    const query = new PgDialect().sqlToQuery(findFirst.mock.calls[0][0].where);
    expect(query.params).toEqual(['owned-file', 'authenticated-owner']);
  });

  it('rejects foreign files before any download, copy or rename effect', async () => {
    const { service, findFirst, storage, db } = setup();
    findFirst.mockResolvedValue(undefined);
    await expect(service.readText('foreign', 100)).rejects.toThrow('authenticated account');
    await expect(service.copy('foreign', 'copy.txt')).rejects.toThrow('authenticated account');
    await expect(service.rename('foreign', 'renamed.txt')).rejects.toThrow('authenticated account');
    expect(storage.getFileByteArray).not.toHaveBeenCalled();
    expect(storage.uploadFromBuffer).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });

  it('rejects binary reads, changed byte size and canceled writes', async () => {
    const { service, findFirst, storage, active } = setup();
    findFirst.mockResolvedValue({
      id: 'binary',
      fileType: 'image/png',
      size: 6,
      url: 'binary/key',
    });
    await expect(service.readText('binary', 100)).rejects.toThrow();
    expect(storage.getFileByteArray).not.toHaveBeenCalled();
    findFirst.mockResolvedValue({
      id: 'owned-file',
      fileType: 'text/plain',
      size: 7,
      url: 'owned/key',
    });
    await expect(service.copy('owned-file', 'copy.txt')).rejects.toThrow('stored size');
    active.mockImplementation(() => {
      throw new Error('lease expired');
    });
    await expect(
      service.createText({ name: 'notes.txt', content: 'hello', mimeType: 'text/plain' }),
    ).rejects.toThrow('lease expired');
    expect(storage.uploadFromBuffer).not.toHaveBeenCalled();
  });

  it('creates an owned text file and never accepts host paths', async () => {
    const { service, storage } = setup();
    await expect(
      service.createText({ name: '../secret.txt', content: 'hello', mimeType: 'text/plain' }),
    ).rejects.toThrow();
    const result = await service.createText({
      name: 'notes.md',
      content: '联调笔记',
      mimeType: 'text/markdown',
    });
    expect(result.artifact).toMatchObject({
      fileId: 'new-file',
      name: 'notes.md',
      mimeType: 'text/markdown',
    });
    expect(storage.uploadFromBuffer.mock.calls[0][2]).toMatch(
      /^system-capabilities\/[a-f\d]{64}\/[\w-]+\/notes\.md$/u,
    );
  });
});
