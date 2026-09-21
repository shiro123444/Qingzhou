import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  PRESENTATION_ATTACHMENT_MAX_UPLOAD_BYTES,
  PRESENTATION_ATTACHMENT_MAX_UPLOAD_MIB,
  PRESENTATION_PPTX_MAX_UPLOAD_BYTES,
  PRESENTATION_PPTX_MAX_UPLOAD_MIB,
  type RuntimeScope,
} from '../../../../packages/runtime-contracts/src';
import { FilePresentationStorage } from './file-storage';
import { readPresentationUploadForm } from './upload-form';

export const presentationAttachmentStorage = () =>
  new FilePresentationStorage(
    process.env.CORDIS_PRESENTATION_DATA_DIR ?? path.join(process.cwd(), '.data', 'presentation'),
  );
const supported =
  /\.(?:txt|md|csv|tsv|pdf|docx|xlsx|pptx|png|jpe?g|webp|mp4|m4v|mov|avi|wmv|webm|mpe?g|mp3|m4a|aac|ogg|wav|wma)$/i;
const mediaMime = (name: string): string | undefined => {
  const extension = path.extname(name).toLowerCase();
  const mimeTypes: Record<string, string> = {
    '.aac': 'audio/aac',
    '.avi': 'video/x-msvideo',
    '.m4a': 'audio/mp4',
    '.m4v': 'video/x-m4v',
    '.mov': 'video/quicktime',
    '.mp3': 'audio/mpeg',
    '.mp4': 'video/mp4',
    '.mpeg': 'video/mpeg',
    '.mpg': 'video/mpeg',
    '.ogg': 'audio/ogg',
    '.wav': 'audio/wav',
    '.webm': 'video/webm',
    '.wma': 'audio/x-ms-wma',
    '.wmv': 'video/x-ms-wmv',
  };
  return mimeTypes[extension];
};
export async function uploadPresentationAttachment(request: Request, scope: RuntimeScope) {
  const form = await readPresentationUploadForm(request);
  const file = form.get('file');
  const pptx = typeof file !== 'string' && Boolean(file?.name.toLowerCase().endsWith('.pptx'));
  const maxBytes = pptx
    ? PRESENTATION_PPTX_MAX_UPLOAD_BYTES
    : PRESENTATION_ATTACHMENT_MAX_UPLOAD_BYTES;
  const maxMiB = pptx ? PRESENTATION_PPTX_MAX_UPLOAD_MIB : PRESENTATION_ATTACHMENT_MAX_UPLOAD_MIB;
  if (
    !file ||
    typeof file === 'string' ||
    !supported.test(file.name) ||
    file.size > maxBytes ||
    file.size === 0
  )
    throw new Error(`请上传 ${maxMiB} MiB 以内的${pptx ? ' PPTX' : '文档、图片或音视频'}`);
  const artifactId = `attachment-${randomUUID()}`;
  const image = /\.(?:png|jpe?g|webp)$/i.test(file.name);
  const mediaType = mediaMime(file.name);
  const output = await presentationAttachmentStorage().put(scope, {
    artifactId,
    name: path.basename(file.name),
    bytes: new Uint8Array(await file.arrayBuffer()),
    type: image
      ? 'image'
      : mediaType?.startsWith('video/')
        ? 'video'
        : mediaType
          ? 'audio'
          : 'file',
    mimeType: file.type || mediaType || 'application/octet-stream',
    metadata: { source: 'presentation-upload' },
  });
  return { id: artifactId, url: output.uri, name: output.name };
}
export async function readPresentationAttachment(id: string, scope: RuntimeScope) {
  const file = await presentationAttachmentStorage().get(scope, id);
  if (!file?.bytes || !file.name || !supported.test(file.name))
    throw new Error('附件不存在或不属于当前账号');
  if (file.type === 'image') {
    const { default: sharp } = await import('sharp');
    const bytes = await sharp(file.bytes, { limitInputPixels: 32_000_000 })
      .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
      .png()
      .toBuffer();
    return { name: file.name, imageUrl: `data:image/png;base64,${bytes.toString('base64')}` };
  }
  if (file.type === 'audio' || file.type === 'video')
    return {
      name: file.name,
      content: `这是已保存的${file.type === 'video' ? '视频' : '音频'}附件；受信媒体引用为 ${id}。需要替换原生 PPTX 媒体时，将此引用作为 mediaRef。`,
    };
  if (/\.(?:txt|md|csv|tsv)$/i.test(file.name))
    return { name: file.name, content: Buffer.from(file.bytes).toString('utf8').slice(0, 36000) };
  const directory = await mkdtemp(path.join(tmpdir(), 'jumi-attachment-'));
  try {
    const filename = path.join(directory, `source${path.extname(file.name).toLowerCase()}`);
    await writeFile(filename, file.bytes, { mode: 0o600 });
    const { loadFile } = await import('@lobechat/file-loaders');
    const document = await loadFile(filename);
    if (!document.content.trim()) throw new Error('附件没有可读取的正文');
    return { name: file.name, content: document.content.slice(0, 36000) };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
