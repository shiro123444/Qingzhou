import { describe, expect, it } from 'vitest';

import { parseString } from '../../../../packages/file-loaders/src/utils/parser-utils';
import type {
  PresentationMessage,
  PresentationSlidePlan,
} from '../../../../packages/runtime-contracts/src';
import { canvasHistory } from '../../../../packages/utils/src/presentationCanvasHistory';
import { canvasNode } from '../../../../packages/utils/src/presentationAnnotation';
import { editCanvasPage } from './canvas-command';

describe('canvas edit transactions', () => {
  const slide: PresentationSlidePlan = {
    slideId: 'p6',
    order: 6,
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 540"><defs><linearGradient id="ink"/></defs><g fill="url(#ink)"><text id="title" x="50">Title</text></g><rect width="50" height="12"/></svg>',
    notes: 'notes',
    metadata: { title: 'Title' },
  };
  const base = { expectedVersionId: 'v1' };
  it('keeps originals and their definitions, gives each pasted object its own IDs and restores exact bytes', async () => {
    const copy = await editCanvasPage(
      slide,
      6,
      { ...base, kind: 'paste', sourceVersion: 'v1', sourcePage: 6, object: 'svg:0' },
      'copy title',
      async () => slide,
    );
    const root = parseString(copy.svg).documentElement;
    const copied = canvasNode(root, 'svg:2')!;
    expect(copied.textContent).toBe('Title');
    const id = copied.getAttribute('id')!;
    expect(id).toMatch(/^copy-.+-title$/);
    expect((copied.parentNode as Element).getAttribute('fill')).toBe(
      'url(#' + id.replace(/title$/, 'ink') + ')',
    );
    expect(canvasNode(root, 'svg:0')!.getAttribute('id')).toBe('title');
    const restored = await editCanvasPage(
      copy,
      6,
      { ...base, kind: 'restore', direction: 'undo', operationId: 'copy title', version: 'v1' },
      'undo',
      async () => slide,
    );
    expect(restored).toEqual(slide);
  });
  it('deletes and translates only the selected object', async () => {
    const moved = await editCanvasPage(
      slide,
      6,
      { ...base, kind: 'translate', dx: 8, dy: 12, object: 'svg:1' },
      'drag',
      async () => slide,
    );
    expect(
      canvasNode(parseString(moved.svg).documentElement, 'svg:1')!.getAttribute('transform'),
    ).toBe('translate(8 12)');
    const cut = await editCanvasPage(
      moved,
      6,
      { ...base, kind: 'remove', object: 'svg:0' },
      'cut',
      async () => slide,
    );
    expect(canvasNode(parseString(cut.svg).documentElement, 'svg:0')!.localName).toBe('rect');
    expect(cut.svg).not.toContain('Title');
  });
  it('resolves a whole clipboard selection from one immutable page in paint order', async () => {
    const destination = {
      ...slide,
      slideId: 'p2',
      svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 540"><circle r="8"/></svg>',
    };
    const copied = await editCanvasPage(
      destination,
      2,
      {
        ...base,
        kind: 'pasteMany',
        objects: ['svg:1', 'svg:0'],
        dx: 12,
        dy: 12,
        sourceVersion: 'v1',
        sourcePage: 6,
      },
      'two',
      async (version, page) => {
        expect([version, page]).toEqual(['v1', 6]);
        return slide;
      },
    );
    const root = parseString(copied.svg).documentElement;
    expect(copied.metadata?.canvasSelection).toEqual({ requestId: 'two', ids: ['svg:1', 'svg:2'] });
    expect(canvasNode(root, 'svg:1')!.textContent).toBe('Title');
    expect(canvasNode(root, 'svg:2')!.localName).toBe('rect');
    const removed = await editCanvasPage(
      copied,
      2,
      { ...base, kind: 'removeMany', objects: ['svg:1', 'svg:2'] },
      'cut',
      async () => slide,
    );
    expect(canvasNode(parseString(removed.svg).documentElement, 'svg:0')!.localName).toBe('circle');
    expect(canvasNode(parseString(removed.svg).documentElement, 'svg:1')).toBeUndefined();
    const undo = await editCanvasPage(
      removed,
      2,
      { ...base, kind: 'restore', version: 'v2', operationId: 'cut', direction: 'undo' },
      'undo',
      async () => copied,
    );
    expect(undo).toEqual(copied);
  });
  it('rejects a stale member or repeated object without partially moving the selection', async () => {
    const move = { object: 'svg:0', dx: 2, dy: 3 };
    for (const object of ['svg:100', 'svg:0'])
      await expect(
        editCanvasPage(
          slide,
          6,
          { ...base, kind: 'moveMany', moves: [move, { ...move, object }] },
          'move',
          async () => slide,
        ),
      ).rejects.toThrow();
    expect(
      canvasNode(parseString(slide.svg).documentElement, 'svg:0')!.hasAttribute('transform'),
    ).toBe(false);
  });
  it('uses page coordinates when dragging an object inside a scaled group', async () => {
    const nested = {
      ...slide,
      svg: '<svg xmlns="http://www.w3.org/2000/svg"><g transform="scale(2 3)"><text>Title</text></g></svg>',
    };
    const result = await editCanvasPage(
      nested,
      6,
      { ...base, kind: 'translate', dx: 8, dy: 12, object: 'svg:0' },
      'move',
      async () => nested,
    );
    expect(
      canvasNode(parseString(result.svg).documentElement, 'svg:0')!.getAttribute('transform'),
    ).toBe('translate(4 4)');
  });
  it('rebuilds cross-page undo and redo in order and invalidates redo on a new edit', () => {
    const messages: PresentationMessage[] = [];
    function add(
      id: string,
      previous: string,
      version: string,
      page: number,
      direction?: 'redo' | 'undo',
      operationId = 'second',
    ) {
      messages.push({
        createdAt: '',
        content: 'edit',
        status: 'applied',
        target: { type: 'slide', slideNumber: page },
        versionId: version,
        requestId: id,
        canvasCommand: direction
          ? {
              kind: 'restore',
              direction,
              operationId,
              expectedVersionId: previous,
              version: direction === 'undo' ? 'v2' : 'v3',
            }
          : { kind: 'remove', object: 'svg:1', expectedVersionId: previous },
      });
      return canvasHistory({ messages, versionId: version });
    }
    add('first', 'v1', 'v2', 4);
    add('second', 'v2', 'v3', 6);
    expect(add('undo', 'v3', 'v4', 6, 'undo').undo.at(-1)?.page).toBe(4);
    expect(add('redo', 'v4', 'v5', 6, 'redo').undo.at(-1)?.id).toBe('second');
    add('undo-again', 'v5', 'v6', 6, 'undo');
    expect(add('new', 'v6', 'v7', 3).redo).toEqual([]);
    expect(canvasHistory({ messages, versionId: 'other' }).undo).toEqual([]);
  });
});

it('round-trips membership, rejects partial group edits and gives pasted groups independent identities', async () => {
  const objects = ['svg:0', 'svg:1'];
  const base = { expectedVersionId: 'v1' };
  const page: PresentationSlidePlan = {
    slideId: 'p6',
    order: 6,
    svg: '<svg viewBox="0 0 960 540"><text x="20" y="40" font-size="20">Title</text><image x="60" y="100" width="80" height="40" /></svg>',
  };
  const grouped = await editCanvasPage(
    page,
    6,
    { ...base, kind: 'group', objects },
    'group',
    async () => page,
  );
  const membership = (p: typeof page) =>
    Array.from(parseString(p.svg).getElementsByTagName('*'))
      .map((n) => n.getAttribute('data-canvas-group'))
      .filter(Boolean);
  const names = membership(grouped);
  expect(names).toHaveLength(2);
  expect(names[0]).toBe(names[1]);
  await expect(
    editCanvasPage(
      grouped,
      6,
      { ...base, kind: 'remove', object: 'svg:0' },
      'partial',
      async () => page,
    ),
  ).rejects.toThrow('完整组合');
  const pasted = await editCanvasPage(
    grouped,
    6,
    { ...base, kind: 'pasteMany', objects, sourceVersion: 'v', sourcePage: 6, dx: 8, dy: 8 },
    'paste-group',
    async () => grouped,
  );
  expect(new Set(membership(pasted)).size).toBe(2);
  const ungrouped = await editCanvasPage(
    grouped,
    6,
    { ...base, kind: 'ungroup', objects },
    'ungroup',
    async () => page,
  );
  expect(membership(ungrouped)).toHaveLength(0);
  const scaled = await editCanvasPage(
    grouped,
    6,
    { ...base, kind: 'resizeGroup', objects, anchorX: 0, anchorY: 0, factor: 1.5 },
    'scaled',
    async () => page,
  );
  const doc = parseString(scaled.svg);
  expect(doc.getElementsByTagName('text')[0].getAttribute('font-size')).toBe('30');
  expect(doc.getElementsByTagName('image')[0].getAttribute('width')).toBe('120');
});
