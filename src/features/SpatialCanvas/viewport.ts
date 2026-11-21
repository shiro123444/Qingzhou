export interface CanvasPage {
  id: string;
  label: string;
  preview?: string;
  width: number;
  height: number;
}

export type Point = { x: number; y: number };
export type Bounds = Point & { width: number; height: number };
export type Camera = Point & { scale: number };

/** Page positions are editor coordinates, independent of the slide's SVG viewBox. */
export function arrangePages(pages: CanvasPage[]) {
  // Keep the reading order stable as more generated pages arrive.
  const columns = 3;
  const gap = 64;
  const sizes = pages.map((page) => ({
    width: 960,
    height: (960 * page.height) / page.width,
  }));
  let top = 0;
  let rowHeight = 0;
  const frames = pages.map((page, index) => {
    const column = index % columns;
    if (column === 0 && index > 0) {
      top += rowHeight + gap;
      rowHeight = 0;
    }
    const size = sizes[index];
    rowHeight = Math.max(rowHeight, size.height);
    return { ...page, ...size, x: column * (960 + gap), y: top };
  });
  const bounds = {
    x: 0,
    y: 0,
    width: Math.max(960, ...frames.map((page) => page.x + page.width)),
    height: Math.max(1, top + rowHeight),
  };
  return { frames, bounds };
}

export function fitCamera(frame: Bounds, viewport: Bounds): Camera {
  const scale = Math.max(
    0.001,
    Math.min(viewport.width / frame.width, viewport.height / frame.height),
  );
  return {
    scale,
    x: viewport.x + (viewport.width - frame.width * scale) / 2 - frame.x * scale,
    y: viewport.y + (viewport.height - frame.height * scale) / 2 - frame.y * scale,
  };
}

/** Keep the same world point under a wheel cursor or between two moving fingers. */
export function zoomCamera(camera: Camera, previous: Point, next: Point, factor: number): Camera {
  const scale = Math.max(0.005, Math.min(8, camera.scale * factor));
  const ratio = scale / camera.scale;
  return {
    scale,
    x: next.x - (previous.x - camera.x) * ratio,
    y: next.y - (previous.y - camera.y) * ratio,
  };
}
