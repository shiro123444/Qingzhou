import { describe, expect, it } from 'vitest';

import { audienceSpeakerNotes } from './speaker-notes';

describe('audienceSpeakerNotes', () => {
  it('removes legacy source appendices across repeated revisions', () => {
    const notes = '请逐项核对验收标准。\n[科研插图 diagram] AI生成定性示意，非实测数据';
    const legacy = `${notes}\n[可编辑内容源]\nvisual-1: {"type":"table"}\n[可编辑内容源]\nvisual-1: {"type":"table"}`;
    expect(audienceSpeakerNotes(legacy)).toBe(notes);
    expect(audienceSpeakerNotes(audienceSpeakerNotes(legacy))).toBe(notes);
  });

  it('preserves ordinary, empty and omitted speaker notes', () => {
    expect(audienceSpeakerNotes('原始讲稿\n')).toBe('原始讲稿\n');
    expect(audienceSpeakerNotes('')).toBe('');
    expect(audienceSpeakerNotes(undefined)).toBeUndefined();
  });
});
