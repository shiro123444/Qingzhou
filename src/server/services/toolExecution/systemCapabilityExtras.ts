import { z } from 'zod';

import type { AtomicOperation } from '@/server/runtime/atomic-runtime';
import { type PngRenderInput, pngRenderSchema } from '@/server/runtime/presentation/png-renderer';

export interface OwnedCapabilityFile {
  fileId: string;
  mimeType: string;
  name: string;
  size: number;
}

export interface ChannelFilePorts {
  copy?: (fileId: string, name: string) => Promise<unknown>;
  createText?: (args: { name: string; content: string; mimeType: string }) => Promise<unknown>;
  importPresentation?: (artifactId: string) => Promise<unknown>;
  inspect: (fileId: string) => Promise<OwnedCapabilityFile>;
  list?: (args: { q?: string; limit: number; offset: number }) => Promise<unknown>;
  readText?: (fileId: string, maxChars: number) => Promise<unknown>;
  rename?: (fileId: string, name: string) => Promise<unknown>;
}

export interface ChannelExtraPorts {
  images?: { render: (input: PngRenderInput) => Promise<unknown> };
  web?: {
    search: (input: { query: string; limit: number; timeRange?: string }) => Promise<unknown>;
  };
}

// Account file display names, not paths on the host computer.
export const capabilityFilenameSchema = z
  .string()
  .trim()
  .min(1)
  .max(160)
  // eslint-disable-next-line no-control-regex -- Filenames cannot contain path separators or controls.
  .regex(/^[^/\\\x00-\x1F\x7F]+$/u)
  .refine((name) => name !== '.' && name !== '..', 'A filename is required');
export const capabilityTextMimeSchema = z.enum([
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/json',
]);

export const channelFileOperations = (files: ChannelFilePorts): AtomicOperation[] => [
  {
    name: 'files.inspect',
    description: 'Read metadata for a file owned by the authenticated account.',
    input: z.object({ fileId: z.string().uuid() }).strict(),
    execute: ({ fileId }) => files.inspect(fileId),
  },
  {
    name: 'files.deliver',
    description:
      'Attach an owned file to the channel reply. Registration is not proof of platform delivery.',
    input: z.object({ fileId: z.string().uuid() }).strict(),
    execute: ({ fileId }) => files.inspect(fileId),
  },
  ...(files.list
    ? [
        {
          name: 'files.list',
          description:
            'List owned application files with bounded pagination. No host filesystem access.',
          input: z
            .object({
              q: z.string().max(200).optional(),
              limit: z.number().int().min(1).max(30).default(20),
              offset: z.number().int().min(0).max(10000).default(0),
            })
            .strict(),
          execute: (input: { q?: string; limit: number; offset: number }) => files.list!(input),
        },
      ]
    : []),
  ...(files.readText
    ? [
        {
          name: 'files.readText',
          description: 'Read UTF-8 text from an owned text file; returns truncation information.',
          input: z
            .object({
              fileId: z.string().uuid(),
              maxChars: z.number().int().min(1).max(20000).default(10000),
            })
            .strict(),
          execute: ({ fileId, maxChars }: { fileId: string; maxChars: number }) =>
            files.readText!(fileId, maxChars),
        },
      ]
    : []),
  ...(files.createText
    ? [
        {
          name: 'files.createText',
          description:
            'Create a new owned UTF-8 text, Markdown, CSV or JSON file. Does not overwrite existing files.',
          input: z
            .object({
              name: capabilityFilenameSchema,
              content: z.string().min(1).max(100000),
              mimeType: capabilityTextMimeSchema.default('text/plain'),
            })
            .strict(),
          execute: (input: { name: string; content: string; mimeType: string }) =>
            files.createText!(input),
        },
      ]
    : []),
  ...(files.rename
    ? [
        {
          name: 'files.rename',
          description:
            'Rename an owned application file without changing its bytes or storage path.',
          input: z.object({ fileId: z.string().uuid(), name: capabilityFilenameSchema }).strict(),
          execute: ({ fileId, name }: { fileId: string; name: string }) =>
            files.rename!(fileId, name),
        },
      ]
    : []),
  ...(files.copy
    ? [
        {
          name: 'files.copy',
          description: 'Copy an owned application file to a new file with its own ID.',
          input: z.object({ fileId: z.string().uuid(), name: capabilityFilenameSchema }).strict(),
          execute: ({ fileId, name }: { fileId: string; name: string }) =>
            files.copy!(fileId, name),
        },
      ]
    : []),
  ...(files.importPresentation
    ? [
        {
          name: 'files.importPresentation',
          description:
            'Copy a ready presentation artifact from this account into application files for channel delivery.',
          input: z.object({ artifactId: z.string().min(1).max(500) }).strict(),
          execute: ({ artifactId }: { artifactId: string }) =>
            files.importPresentation!(artifactId),
        },
      ]
    : []),
];

export const channelExtraOperations = (ports: ChannelExtraPorts): AtomicOperation[] => [
  ...(ports.images
    ? [
        {
          name: 'images.render',
          description:
            'Create a real PNG from a formula, flow graph, plot or radar using the Cordis semantic vector engine. Returns an owned file, not an image URL invented by the model.',
          input: pngRenderSchema,
          execute: (input: PngRenderInput) => ports.images!.render(input),
        },
      ]
    : []),
  ...(ports.web
    ? [
        {
          name: 'web.search',
          description:
            'Search the configured web service and return source titles, URLs, snippets and dates. Provider failures remain failures; cite returned sources.',
          input: z
            .object({
              query: z.string().trim().min(1).max(1000),
              limit: z.number().int().min(1).max(10).default(5),
              timeRange: z.enum(['day', 'week', 'month', 'year']).optional(),
            })
            .strict(),
          execute: (input: { query: string; limit: number; timeRange?: string }) =>
            ports.web!.search(input),
        },
      ]
    : []),
];
