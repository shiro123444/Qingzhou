import { type CSSProperties } from 'react';

import { glyphStyles } from './glyph.style';

export type GlyphName =
  | 'home'
  | 'search'
  | 'tasks'
  | 'document'
  | 'presentation'
  | 'music'
  | 'library'
  | 'plugins'
  | 'computer'
  | 'awareness'
  | 'sidebar'
  | 'close'
  | 'plus'
  | 'menu'
  | 'play'
  | 'pause'
  | 'next'
  | 'previous'
  | 'expand'
  | 'collapse'
  | 'refresh'
  | 'arrow'
  | 'back'
  | 'enter'
  | 'volume'
  | 'shuffle'
  | 'repeat'
  | 'channels';

const names: Record<string, GlyphName> = {
  House: 'home',
  Home: 'home',
  Search: 'search',
  ListTodo: 'tasks',
  SquareCheckBig: 'tasks',
  FilePenLine: 'document',
  FilePen: 'document',
  FileText: 'document',
  NotebookPen: 'document',
  Presentation: 'presentation',
  Music: 'music',
  Music2: 'music',
  EighthNote: 'music',
  AudioLines: 'music',
  Library: 'library',
  LibraryBig: 'library',
  ListMusic: 'tasks',
  Puzzle: 'plugins',
  Monitor: 'computer',
  Eye: 'awareness',
  EyeOff: 'awareness',
  PanelLeftClose: 'sidebar',
  PanelLeftOpen: 'sidebar',
  PanelRightClose: 'sidebar',
  PanelRightOpen: 'sidebar',
  X: 'close',
  Plus: 'plus',
  Ellipsis: 'menu',
  MoreHorizontal: 'menu',
  Play: 'play',
  Pause: 'pause',
  SkipForward: 'next',
  SkipBack: 'previous',
  Maximize2: 'expand',
  Minimize2: 'collapse',
  RefreshCw: 'refresh',
  RotateCcw: 'refresh',
  ArrowUpRight: 'arrow',
  ArrowRight: 'arrow',
  ArrowLeft: 'back',
  CornerDownLeft: 'enter',
  ScanEye: 'search',
  Volume2: 'volume',
  Shuffle: 'shuffle',
  Repeat: 'repeat',
  Repeat1: 'repeat',
  Radio: 'channels',
  Shapes: 'plugins',
  Image: 'document',
  ImagePlus: 'document',
  SquareTerminal: 'computer',
};

export function glyphForIcon(icon: unknown): GlyphName | undefined {
  return names[(icon as { displayName?: string } | undefined)?.displayName ?? ''];
}

/** Small, shaped strokes. Interaction comes from the owning control, never a looping badge. */
export function MotionGlyph({
  name,
  size = 20,
  active = false,
  running = false,
}: {
  name: GlyphName;
  size?: number;
  active?: boolean;
  running?: boolean;
}) {
  return (
    <span
      aria-hidden
      className={glyphStyles.glyph}
      data-active={active}
      data-motion-glyph={name}
      data-running={running}
      style={{ '--glyph-size': `${size}px` } as CSSProperties}
    >
      {[0, 1, 2, 3, 4, 5].map((part) => (
        <i key={part} style={{ '--part': part } as CSSProperties} />
      ))}
    </span>
  );
}
