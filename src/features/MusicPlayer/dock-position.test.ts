import { describe, expect, it } from 'vitest';

import {
  clampDockPoint,
  defaultDockPoint,
  DOCK_GAP,
  DOCK_PANEL_GAP,
  dockAnchorToPoint,
  dockOverlapArea,
  dockPanelLayout,
  dockPointToAnchor,
  dockPositionKey,
  parseDockPosition,
  placeDock,
  serializeDockPosition,
} from './dock-position';

const viewport = { x: 0, y: 0, width: 1200, height: 800 };
const capsule = { width: 380, height: 76 };
const orb = { width: 60, height: 60 };

describe('persisted floating player preference', () => {
  it('keeps each account in a separate key and accepts a bounded versioned record', () => {
    const anchor = { x: 0.72, y: 0.6 };
    expect(parseDockPosition(serializeDockPosition(anchor))).toEqual(anchor);
    expect(dockPositionKey('alice')).not.toBe(dockPositionKey('bob'));
    expect(dockPositionKey('alice/bob')).toContain('alice%2Fbob');
  });

  it.each([
    null,
    '',
    'null',
    '{invalid}',
    '[]',
    '{"version":2,"anchor":{"x":0.5,"y":0.5}}',
    '{"version":1,"anchor":{"x":-1,"y":0.5}}',
    '{"version":1,"anchor":{"x":0.5,"y":1.01}}',
    '{"version":1,"anchor":{"x":"0.5","y":0.5}}',
    '{"version":1,"anchor":{"x":0.5,"y":0.5},"userId":"another-account"}',
    '{"version":1,"anchor":{"x":0.5,"y":0.5,"code":"ignored"}}',
    ' '.repeat(257),
  ])('rejects untrusted or incompatible storage without throwing (%s)', (raw) => {
    expect(parseDockPosition(raw)).toBeNull();
  });
});

describe('capsule viewport projection', () => {
  it('uses the actual compact surface rather than a transparent 380px parent', () => {
    expect(clampDockPoint({ x: -200, y: 900 }, orb, viewport)).toEqual({ x: 12, y: 728 });
    const position = { x: 20, y: 100 };
    const anchor = dockPointToAnchor(position, orb, viewport);
    expect(dockAnchorToPoint(anchor, orb, viewport)).toEqual(position);
  });

  it('keeps the same trailing/bottom anchor across collapsed, expanded and refreshed views', () => {
    const anchor = parseDockPosition(serializeDockPosition({ x: 0.75, y: 0.65 }))!;
    const small = dockAnchorToPoint(anchor, orb, viewport);
    const large = dockAnchorToPoint(anchor, capsule, viewport);
    expect(small.x + orb.width).toBe(large.x + capsule.width);
    expect(small.y + orb.height).toBe(large.y + capsule.height);
    expect(dockPointToAnchor(large, capsule, viewport)).toEqual(anchor);
  });

  it('temporarily clamps to a small viewport without replacing the original preference', () => {
    const preference = Object.freeze({ x: 0.95, y: 0.93 });
    const small = { x: 0, y: 0, width: 390, height: 340 };
    const mobileCapsule = { width: 350, height: 76 };
    const projected = placeDock(
      dockAnchorToPoint(preference, mobileCapsule, small),
      mobileCapsule,
      small,
      [],
    );
    expect(projected.x).toBeGreaterThanOrEqual(12);
    expect(projected.x + mobileCapsule.width).toBeLessThanOrEqual(378);
    expect(projected.y + mobileCapsule.height).toBeLessThanOrEqual(328);
    const restored = placeDock(
      dockAnchorToPoint(preference, capsule, viewport),
      capsule,
      viewport,
      [],
    );
    expect(dockPointToAnchor(restored, capsule, viewport)).toEqual(preference);
  });

  it('respects a scrolled visual viewport during a mobile keyboard resize', () => {
    const visible = { x: 40, y: 120, width: 390, height: 320 };
    const size = { width: 350, height: 76 };
    const point = clampDockPoint({ x: -1, y: 9999 }, size, visible);
    expect(point).toEqual({ x: 52, y: 352 });
    expect(defaultDockPoint(size, visible, false).y).toBeGreaterThanOrEqual(132);
  });
});

describe('temporary composer avoidance', () => {
  it('moves a remembered position the smallest distance clear of a composer', () => {
    const composer = { x: 300, y: 650, width: 850, height: 130 };
    const wanted = { x: 700, y: 692 };
    const point = placeDock(wanted, capsule, viewport, [composer]);
    expect(point).toEqual({ x: 700, y: composer.y - capsule.height - DOCK_GAP });
    expect(dockOverlapArea(point, capsule, composer)).toBe(0);
    expect(placeDock(wanted, capsule, viewport, [])).toEqual(wanted);
  });

  it('finds space between multiple visible composers without overwriting the request', () => {
    const wanted = Object.freeze({ x: 700, y: 600 });
    const obstacles = [
      { x: 500, y: 580, width: 600, height: 180 },
      { x: 100, y: 250, width: 1050, height: 120 },
    ];
    const point = placeDock(wanted, capsule, viewport, obstacles);
    expect(obstacles.every((rect) => dockOverlapArea(point, capsule, rect) === 0)).toBe(true);
    expect(wanted).toEqual({ x: 700, y: 600 });
  });

  it('returns a finite, reachable fallback when a fullscreen composer leaves no free area', () => {
    const point = placeDock({ x: 400, y: 400 }, capsule, viewport, [{ ...viewport }]);
    expect(Number.isFinite(point.x) && Number.isFinite(point.y)).toBe(true);
    expect(point.x).toBeGreaterThanOrEqual(12);
    expect(point.y).toBeGreaterThanOrEqual(12);
    expect(point.x + capsule.width).toBeLessThanOrEqual(1188);
    expect(point.y + capsule.height).toBeLessThanOrEqual(788);
  });
});

describe('floating panel placement', () => {
  it('opens below a top-positioned capsule and bounds its height', () => {
    const panel = dockPanelLayout({ x: 500, y: 12 }, capsule, viewport, []);
    expect(panel.side).toBe('below');
    expect(panel.maxHeight).toBe(688);
  });

  it('opens above the capsule when a composer blocks the space below', () => {
    const point = { x: 700, y: 520 };
    const composer = { x: 300, y: 620, width: 850, height: 160 };
    const panel = dockPanelLayout(point, capsule, viewport, [composer]);
    expect(panel.side).toBe('above');
    expect(panel.maxHeight).toBeLessThanOrEqual(point.y - 12 - DOCK_GAP);
  });

  it('accounts for the real CSS panel gap while keeping a composer clear', () => {
    const point = { x: 700, y: 650 };
    const composer = { x: 650, y: 350, width: 500, height: 150 };
    const panel = dockPanelLayout(point, capsule, viewport, [composer]);
    expect(panel.side).toBe('above');
    const panelPoint = { x: point.x, y: point.y - DOCK_PANEL_GAP - panel.maxHeight };
    expect(
      dockOverlapArea(panelPoint, { width: capsule.width, height: panel.maxHeight }, composer),
    ).toBe(0);
    expect(panelPoint.y).toBe(composer.y + composer.height + DOCK_GAP);
  });
});
