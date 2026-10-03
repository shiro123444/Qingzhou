import { createHash, randomUUID } from 'node:crypto';

import { and, desc, eq, ilike } from 'drizzle-orm';

import { FileModel } from '@/database/models/file';
import { files } from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';
import { FileService } from '@/server/services/file';

import { capabilityFilenameSchema, capabilityTextMimeSchema } from './systemCapabilityExtras';

/** Application file operations always use the server-owned account, never a caller-supplied path. */
export class SystemCapabilityFileService {
  private readonly model: FileModel;
  private get service() {
    return this.storageFactory();
  }

  constructor(
    private readonly db: LobeChatDatabase,
    private readonly userId: string,
    private readonly assertActive: () => void = () => {},
    private readonly storageFactory: () => Pick<
      FileService,
      'getFileByteArray' | 'uploadFromBuffer'
    > = () => new FileService(db, userId),
  ) {
    this.model = new FileModel(db, userId);
  }

  private async owned(fileId: string) {
    const file = await this.model.findById(fileId);
    if (!file) throw new Error('File not found in the authenticated account');
    return file;
  }

  inspect = async (fileId: string) => {
    const file = await this.owned(fileId);
    return { fileId: file.id, name: file.name, mimeType: file.fileType, size: file.size };
  };

  inspectDelivery = async (fileId: string) => {
    const file = await this.inspect(fileId);
    if (file.size < 1 || file.size > 25 * 1024 * 1024)
      throw new Error('Channel file replies support files up to 25 MiB');
    return file;
  };

  list = async ({ q, limit, offset }: { q?: string; limit: number; offset: number }) => {
    const rows = await this.db
      .select({
        fileId: files.id,
        name: files.name,
        mimeType: files.fileType,
        size: files.size,
      })
      .from(files)
      .where(and(eq(files.userId, this.userId), q ? ilike(files.name, `%${q}%`) : undefined))
      .orderBy(desc(files.createdAt), desc(files.id))
      .limit(limit + 1)
      .offset(offset);
    return { files: rows.slice(0, limit), nextOffset: rows.length > limit ? offset + limit : null };
  };

  private async read(fileId: string, maxBytes: number) {
    const file = await this.owned(fileId);
    if (file.size < 1 || file.size > maxBytes)
      throw new Error('File exceeds the operation size limit');
    const bytes = Buffer.from(await this.service.getFileByteArray(file.url));
    if (bytes.length !== file.size) throw new Error('File bytes do not match stored size');
    return { file, bytes };
  }

  readText = async (fileId: string, maxChars: number) => {
    const metadata = await this.owned(fileId);
    capabilityTextMimeSchema.parse(metadata.fileType.split(';')[0].trim());
    const { bytes } = await this.read(fileId, 1024 * 1024);
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return {
      fileId,
      content: text.slice(0, maxChars),
      totalChars: text.length,
      truncated: text.length > maxChars,
    };
  };

  save = async (bytes: Buffer, mimeType: string, rawName: string) => {
    const name = capabilityFilenameSchema.parse(rawName);
    if (bytes.length < 1 || bytes.length > 25 * 1024 * 1024)
      throw new Error('Generated file exceeds the channel size limit');
    const owner = createHash('sha256').update(this.userId).digest('hex');
    this.assertActive();
    const result = await this.service.uploadFromBuffer(
      bytes,
      mimeType,
      `system-capabilities/${owner}/${randomUUID()}/${name}`,
    );
    return {
      artifact: {
        fileId: result.fileId,
        name,
        mimeType,
        size: bytes.length,
        url: result.url,
        access: 'Application file link; localhost links are only accessible on the host computer',
      },
    };
  };

  createText = async ({
    name,
    content,
    mimeType,
  }: {
    name: string;
    content: string;
    mimeType: string;
  }) => this.save(Buffer.from(content, 'utf8'), capabilityTextMimeSchema.parse(mimeType), name);

  rename = async (fileId: string, rawName: string) => {
    await this.owned(fileId);
    const name = capabilityFilenameSchema.parse(rawName);
    this.assertActive();
    await this.model.update(fileId, { name });
    return { file: await this.inspect(fileId) };
  };

  copy = async (fileId: string, name: string) => {
    const { file, bytes } = await this.read(fileId, 25 * 1024 * 1024);
    return this.save(bytes, file.fileType, name);
  };
}
