'use client';

import { cloneElement, type CSSProperties, type ReactElement, type Ref } from 'react';
import { type ItemProps, type ListProps, Virtuoso } from 'react-virtuoso';

import { type MusicTrack } from '@/types/music';

interface RowProps {
  'aria-posinset'?: number;
  'aria-setsize'?: number;
  'style'?: CSSProperties;
}
interface ListContext {
  className: string;
  label: string;
  offset: number;
  total: number;
}

function List({
  context,
  ref,
  ...props
}: ListProps<HTMLUListElement> & {
  context?: ListContext;
  ref?: Ref<HTMLUListElement>;
}) {
  return (
    <ul
      {...props}
      aria-label={context?.label}
      className={context?.className}
      ref={ref}
      style={{ ...props.style, maxHeight: 'none', overflow: 'visible' }}
    />
  );
}

function Item({
  children,
  context,
  item: _item,
  ...props
}: ItemProps<MusicTrack> & {
  context?: ListContext;
}) {
  const child = children as ReactElement<RowProps>;
  // Attach Virtuoso's measurements to the existing semantic list item without a nested row.
  // eslint-disable-next-line @eslint-react/no-clone-element
  return cloneElement(child, {
    ...props,
    'aria-posinset': (context?.offset ?? 0) + props['data-item-index'] + 1,
    'aria-setsize': context?.total,
    'style': { ...child.props.style, ...props.style },
  });
}
const components = { Item, List };

/** Only visible rows mount artwork and controls, even for a large manual queue or library. */
export default function MusicTrackList({
  className,
  height = 'min(52dvh, 520px)',
  initialIndex = 0,
  items,
  label,
  offset = 0,
  renderItem,
  rowHeight = 74,
  total = items.length,
}: {
  className: string;
  height?: string;
  initialIndex?: number;
  items: MusicTrack[];
  label: string;
  offset?: number;
  renderItem: (track: MusicTrack, index: number) => ReactElement<RowProps>;
  rowHeight?: number;
  total?: number;
}) {
  if (items.length <= 40)
    return (
      <ul aria-label={label} className={className}>
        {items.map(renderItem)}
      </ul>
    );
  return (
    <Virtuoso
      components={components}
      computeItemKey={(_index, track) => track.id}
      context={{ className, label, offset, total }}
      data={items}
      defaultItemHeight={rowHeight}
      increaseViewportBy={rowHeight * 2}
      initialItemCount={8}
      initialTopMostItemIndex={Math.max(0, initialIndex - 2)}
      itemContent={(index, track) => renderItem(track, index)}
      style={{ height, overscrollBehavior: 'contain' }}
    />
  );
}
