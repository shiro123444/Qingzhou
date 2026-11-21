import { z } from 'zod';

export const browserActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('start') }).strict(),
  z
    .object({
      action: z.literal('navigate'),
      url: z
        .string()
        .url()
        .max(4000)
        .refine((value) => /^https?:\/\//i.test(value)),
    })
    .strict(),
  z
    .object({
      action: z.literal('click'),
      button: z.enum(['left', 'right']).default('left'),
      x: z.number().min(0).max(1100),
      y: z.number().min(0).max(700),
    })
    .strict(),
  z
    .object({
      action: z.literal('drag'),
      x: z.number().min(0).max(1100),
      y: z.number().min(0).max(700),
      endX: z.number().min(0).max(1100),
      endY: z.number().min(0).max(700),
    })
    .strict(),
  z.object({ action: z.literal('text'), text: z.string().min(1).max(8000) }).strict(),
  z
    .object({
      action: z.literal('key'),
      key: z.enum([
        'Enter',
        'Tab',
        'Backspace',
        'Delete',
        'Escape',
        'ArrowUp',
        'ArrowDown',
        'ArrowLeft',
        'ArrowRight',
        'Home',
        'End',
        'PageUp',
        'PageDown',
        'a',
      ]),
      modifiers: z.number().int().min(0).max(15).default(0),
    })
    .strict(),
  z
    .object({
      action: z.literal('scroll'),
      deltaX: z.number().min(-2000).max(2000).default(0),
      deltaY: z.number().min(-2000).max(2000),
    })
    .strict(),
  z.object({ action: z.literal('back') }).strict(),
  z.object({ action: z.literal('reload') }).strict(),
]);
export const browserCommandSchema = z
  .object({ kind: z.literal('browser'), input: browserActionSchema })
  .strict();
export const browserFrameSchema = z.discriminatedUnion('running', [
  z.object({ running: z.literal(false) }).strict(),
  z
    .object({
      running: z.literal(true),
      image: z
        .string()
        .max(240000)
        .regex(/^[A-Z0-9+/=]+$/i),
      width: z.literal(1100),
      height: z.literal(700),
      url: z.string().max(4000),
      title: z.string().max(500),
      text: z.string().max(16000),
      controls: z
        .array(
          z
            .object({
              role: z.string().max(30),
              name: z.string().max(200),
              x: z.number(),
              y: z.number(),
            })
            .strict(),
        )
        .max(80),
    })
    .strict(),
]);
export type BrowserFrame = z.infer<typeof browserFrameSchema>;

export const computerManagementSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ensure') }).strict(),
  z.object({ kind: z.literal('wake') }).strict(),
  z.object({ kind: z.literal('sleep') }).strict(),
  z.object({ kind: z.literal('control'), target: z.enum(['agent', 'human']) }).strict(),
]);
export const computerHumanCommandSchema = z.discriminatedUnion('kind', [
  ...computerManagementSchema.options,
  browserCommandSchema,
]);
export const computerCommandSchema = z.discriminatedUnion('kind', [
  ...computerManagementSchema.options,
  browserCommandSchema,
  z
    .object({
      kind: z.literal('shell'),
      command: z.string().min(1).max(16000),
      timeoutMs: z.number().int().min(100).max(30000).default(30000),
    })
    .strict(),
]);
export type ComputerCommand = z.infer<typeof computerCommandSchema>;
export type ComputerActor = 'agent' | 'human';
export type ComputerState = 'new' | 'ready' | 'sleeping' | 'unknown';
export interface ComputerScope {
  agentId: string;
  userId: string;
}
export interface ComputerReceipt {
  control: ComputerActor;
  exitCode?: number;
  resourceId: string;
  state: 'ready' | 'sleeping';
  stderr?: string;
  stdout?: string;
}
export interface ComputerSessionView {
  busy: boolean;
  control: ComputerActor;
  id: string;
  revision: number;
  state: ComputerState;
  updatedAt: string;
}
export interface ComputerCommandView {
  actor: ComputerActor;
  completedAt?: string;
  createdAt: string;
  exitCode?: number;
  id: string;
  kind: ComputerCommand['kind'];
  status: 'prepared' | 'dispatched' | 'done' | 'unknown' | 'cancelled';
}
export interface ComputerView {
  actionFailed?: boolean;
  activity?: { phase: 'working' | 'approval'; topicId: string };
  bindingChanged?: boolean;
  botActivity?: { phase: 'working' | 'approval' | 'queued'; topicId: string };
  commands: ComputerCommandView[];
  enabled: boolean;
  reasoningModel?: { model: string; provider: string };
  session?: ComputerSessionView;
}

export interface CompanionTaskPage {
  items: {
    id: string;
    title: string;
    status: string;
    mode: 'heartbeat' | 'schedule' | null;
    intervalSeconds: number | null;
  }[];
  total: number;
}
