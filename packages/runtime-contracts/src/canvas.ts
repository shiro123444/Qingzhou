/** All coordinates are in document units, independent of device scale and viewport zoom. */
export interface CanvasRect {
  height: number;
  width: number;
  x: number;
  y: number;
}

export interface CanvasObject extends CanvasRect {
  id: string;
}

export interface CanvasMove {
  bounds: CanvasRect;
  id: string;
  objects: CanvasObject[];
  x: number;
  y: number;
}

export function moveCanvasObject({ bounds, objects, id, x, y }: CanvasMove): CanvasRect {
  const selected = objects.filter((object) => object.id === id);
  if (selected.length !== 1) throw new Error('无法定位所选对象');
  const { width, height } = selected[0];
  if (
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    x < bounds.x ||
    y < bounds.y ||
    x + width > bounds.x + bounds.width ||
    y + height > bounds.y + bounds.height
  )
    throw new Error('对象超出了页面边界');
  for (const object of objects) {
    if (object.id === id) continue;
    const overlapX = Math.min(x + width, object.x + object.width) - Math.max(x, object.x);
    const overlapY = Math.min(y + height, object.y + object.height) - Math.max(y, object.y);
    if (overlapX > 1 && overlapY > 1) throw new Error('对象与同页的其他内容重叠');
  }
  return { x, y, width, height };
}
