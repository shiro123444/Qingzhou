import sharp from 'sharp';

import { AgentSkillModel } from '@/database/models/agentSkill';
import { FileModel } from '@/database/models/file';
import type { LobeChatDatabase } from '@/database/type';
import { FileService } from '@/server/services/file';
import { SearchService } from '@/server/services/search';

import {
  PRESENTATION_ATTACHMENT_MAX_UPLOAD_BYTES,
  PRESENTATION_ATTACHMENT_MAX_UPLOAD_MIB,
  PRESENTATION_PPTX_MAX_UPLOAD_BYTES,
  PRESENTATION_PPTX_MAX_UPLOAD_MIB,
} from '../../../../packages/runtime-contracts/src';
import { presentationAccountScope } from './account-workspace';
import { readPresentationAttachment } from './attachment-storage';
import type { PresentationContextServices } from './context-tools';

const builtin = [
  {
    id: 'ppt:story',
    name: '叙事与结构',
    content:
      '以受众和决策目标组织叙事。每页一个结论，区分事实、推断和建议；每页大纲包含关键数据、视觉建议和演讲备注。',
  },
  {
    id: 'ppt:visual',
    name: '视觉与资产',
    content:
      '根据内容选择留白、原生图表、图片或透明素材；只在必要时生图，优先复用已有资产。布局给标题和主要论点留足空间，避免无意义装饰。',
  },
  {
    id: 'ppt:evidence',
    name: '资料与来源',
    content:
      '从已提供的材料提取事实；允许联网时查证时效性信息。保留来源URL、日期和数据单位，材料未说明的数字不得编造。',
  },
];
export function createPresentationContextServices(
  db: LobeChatDatabase,
  userId: string,
): PresentationContextServices {
  const files = new FileModel(db, userId);
  const skills = new AgentSkillModel(db, userId);
  const storage = new FileService(db, userId);
  return {
    listSkills: async () => [
      ...builtin.map(({ id, name }) => ({ id, name })),
      ...(await skills.findAll()).data.map(({ id, name }) => ({ id, name })),
    ],
    readSkill: async (id) => {
      const skill = builtin.find((s) => s.id === id) ?? (await skills.findById(id));
      if (!skill?.content) throw new Error('所选技能不存在或没有可读取的指令');
      return { name: skill.name, content: skill.content.slice(0, 16000) };
    },
    readFile: async (id) => {
      if (id.startsWith('attachment-'))
        return readPresentationAttachment(id, presentationAccountScope(userId));
      const file = await files.findById(id);
      if (!file) throw new Error('附件不存在或不属于当前账号');
      const pptx =
        file.fileType ===
          'application/vnd.openxmlformats-officedocument.presentationml.presentation' ||
        file.name.toLowerCase().endsWith('.pptx');
      const maxBytes = pptx
        ? PRESENTATION_PPTX_MAX_UPLOAD_BYTES
        : PRESENTATION_ATTACHMENT_MAX_UPLOAD_BYTES;
      const maxMiB = pptx
        ? PRESENTATION_PPTX_MAX_UPLOAD_MIB
        : PRESENTATION_ATTACHMENT_MAX_UPLOAD_MIB;
      if (file.size > maxBytes) throw new Error(`附件超过 ${maxMiB} MiB，请缩小文件后重试`);
      if (file.fileType.startsWith('image/')) {
        const bytes = await storage.getFileByteArray(file.url);
        const image = await sharp(bytes, { limitInputPixels: 32_000_000 })
          .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
          .png()
          .toBuffer();
        return { name: file.name, imageUrl: `data:image/png;base64,${image.toString('base64')}` };
      }
      if (file.fileType.startsWith('audio/') || file.fileType.startsWith('video/'))
        return {
          name: file.name,
          content: `这是已保存的${file.fileType.startsWith('video/') ? '视频' : '音频'}附件；受信媒体引用为 ${id}。需要替换原生 PPTX 媒体时，将此引用作为 mediaRef。`,
        };
      const { DocumentService } = await import('@/server/services/document');
      const document = await new DocumentService(db, userId).parseFile(id);
      if (!document.content?.trim())
        throw new Error(`无法从 ${file.name} 提取正文，请提供可读取的文件`);
      return { name: file.name, content: document.content.slice(0, 36000) };
    },
    search: async (query) => {
      const result = await new SearchService().webSearch({ query });
      if (!result.results?.length) throw new Error('搜索服务没有返回可用来源，请调整关键词后重试');
      return { results: result.results.slice(0, 6) };
    },
    fetchPages: async (urls) => {
      const allowed = [
        ...new Set(urls.map((url) => url.trim()).filter((url) => url.startsWith('https://'))),
      ].slice(0, 3);
      if (!allowed.length) throw new Error('只能抓取 https 页面');
      const crawled = await new SearchService().crawlPages({ urls: allowed });
      return {
        pages: crawled.results.map((page) => {
          const body = page.data && 'content' in page.data ? page.data.content : '';
          const title = page.data && 'title' in page.data ? page.data.title : undefined;
          return {
            url: page.originalUrl,
            ...(title ? { title: String(title).slice(0, 200) } : {}),
            content: String(body ?? '').slice(0, 6000),
          };
        }),
      };
    },
  };
}
