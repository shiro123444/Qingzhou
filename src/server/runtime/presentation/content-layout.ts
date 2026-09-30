/** One shared budget for measurement and page composition, in the 960-wide canvas. */
export function contentLayout(boardSpace?: unknown, aspectRatio = '16:9') {
  const [w, h] = aspectRatio.split(':').map(Number);
  const right = boardSpace === 'right-third' ? 640 : 960;
  return { x: 48, y: 100, width: right - 96, height: (960 * h) / w - 160, right };
}
