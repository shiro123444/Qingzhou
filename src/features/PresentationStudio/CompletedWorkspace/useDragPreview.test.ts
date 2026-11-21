import { renderHook } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { readCanvasDocument } from './canvasObjects';
import { useDragPreview } from './useCanvasDocument';

it('holds the released layer through source refresh until the published page takes over', async () => {
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="20" height="20"/></svg>';
  const source = readCanvasDocument(svg)!;
  const { result, rerender } = renderHook(
    ({ source }) => useDragPreview('deck:6', source, undefined, undefined),
    { initialProps: { source } },
  );
  const host = document.createElement('div');
  const layer = () => {
    const img = document.createElement('img');
    img.decode = vi.fn().mockResolvedValue(undefined);
    host.append(img);
    return img;
  };
  const bg = layer(),
    fg = layer();
  result.current.background.current = bg;
  result.current.floating.current = fg;
  const urls = class extends URL {
    static createObjectURL = vi.fn(() => 'blob:test-' + Math.random());
    static revokeObjectURL = vi.fn();
  };
  vi.stubGlobal('URL', urls);
  try {
    result.current.update('svg:0', 15, 8);
    await Promise.resolve();
    await Promise.resolve();
    result.current.hold();
    result.current.update();
    rerender({ source: readCanvasDocument(svg)! });
    expect(host.dataset.moving).toBe('true');
    expect(fg.style.transform).toContain('translate(15%, 8%)');
    expect(urls.revokeObjectURL).not.toHaveBeenCalled();
    result.current.end();
    expect(host.dataset.moving).toBeUndefined();
    expect(urls.revokeObjectURL).toHaveBeenCalledTimes(2);
  } finally {
    vi.unstubAllGlobals();
  }
});
