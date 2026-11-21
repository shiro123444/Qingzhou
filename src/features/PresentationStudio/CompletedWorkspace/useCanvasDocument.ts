import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import type { CanvasObject } from '@/features/SpatialCanvas';

import { dragPreviewParts, movePreview, readCanvasDocument } from './canvasObjects';

export function useCanvasDocument(
  uri: string | undefined,
  hasObjects: boolean,
  jobId: string | undefined,
  page: number,
  versionId: string | undefined,
) {
  const [loaded, setLoaded] = useState<{
    identity: string;
    source: NonNullable<ReturnType<typeof readCanvasDocument>>;
  }>();
  const identity = `${jobId}:${page}:${versionId}:${uri?.startsWith('data:') ? 'embedded' : uri}`;
  useEffect(() => {
    if (!uri || !hasObjects) return;
    const controller = new AbortController();
    const read = async () => {
      let svg: string;
      if (uri.startsWith('data:image/svg+xml')) {
        const comma = uri.indexOf(',');
        if (comma < 0) return;
        const encoded = decodeURIComponent(uri.slice(comma + 1));
        svg = /;base64(?:;|$)/iu.test(uri.slice(0, comma))
          ? new TextDecoder().decode(
              Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0)),
            )
          : encoded;
      } else if (uri.startsWith('blob:')) {
        svg = await (await fetch(uri, { signal: controller.signal })).text();
      } else {
        if (!jobId || !versionId) return;
        // The published preview embeds the original bitmaps. Relative image
        // references in the authoring SVG cannot load inside a blob image.
        const preview = new URL(uri, window.location.href);
        if (
          preview.origin === window.location.origin &&
          preview.pathname.startsWith('/api/runtime/presentation/artifacts/')
        ) {
          preview.searchParams.set('raw', 'true');
          const response = await fetch(preview, {
            credentials: 'same-origin',
            signal: controller.signal,
          });
          if (response.ok && response.headers.get('content-type')?.includes('image/svg+xml')) {
            const source = readCanvasDocument(await response.text());
            if (source && !controller.signal.aborted) {
              setLoaded({ identity, source });
              return;
            }
          }
        }
        const response = await fetch('/api/runtime/presentation/tools/presentation.page.read', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jobId, page }),
          signal: controller.signal,
        });
        if (!response.ok) return;
        const result = await response.json();
        if (result.versionId !== versionId || typeof result.slide?.svg !== 'string') return;
        svg = result.slide.svg;
      }
      const source = readCanvasDocument(svg);
      if (source && !controller.signal.aborted) setLoaded({ identity, source });
    };
    void read().catch(() => {
      /* The published slide and its download stay available. */
    });
    return () => controller.abort();
  }, [hasObjects, identity, jobId, page, uri, versionId]);
  return loaded?.identity === identity ? loaded.source : undefined;
}

export function usePositionPreview(
  document: Document | undefined,
  object: CanvasObject | undefined,
  draft: { x: number; y: number } | undefined,
) {
  const [preview, setPreview] = useState<{
    uri: string;
    draft: typeof draft;
    document: Document;
  }>();
  useEffect(() => {
    if (!document || !object || !draft) return;
    const svg = movePreview(document, object, draft.x, draft.y);
    if (!svg) return;
    const uri = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
    setPreview({ uri, draft, document });
    return () => URL.revokeObjectURL(uri);
  }, [document, object, draft]);
  return preview && draft === preview.draft && document === preview.document
    ? preview.uri
    : undefined;
}

export function useDragPreview(
  pageKey: string,
  source: ReturnType<typeof readCanvasDocument>,
  starting: { blockId: string; x: number; y: number } | undefined,
  original: CanvasObject | undefined,
  selection?: string[],
  expand?: (ids: string[]) => string[],
) {
  const background = useRef<HTMLImageElement>(null);
  const floating = useRef<HTMLImageElement>(null);
  const active = useRef<{ id: string; urls: string[]; held?: boolean } | undefined>(undefined);
  const end = useCallback(() => {
    if (active.current) active.current.urls.forEach((url) => URL.revokeObjectURL(url));
    active.current = undefined;
    background.current?.parentElement?.removeAttribute('data-moving');
    floating.current?.removeAttribute('src');
    background.current?.removeAttribute('src');
  }, []);
  useLayoutEffect(() => end, [pageKey, end]);
  useEffect(() => {
    if (!active.current?.held) end();
  }, [source, end]);
  const hold = useCallback(() => {
    if (active.current) active.current.held = true;
  }, []);
  const update = useCallback(
    (id?: string, dx = 0, dy = 0, factor = 1, ax = 0, ay = 0) => {
      if (active.current?.held) return;
      if (!id || !source || !floating.current || !background.current) {
        end();
        return;
      }
      if (active.current?.id !== id) {
        end();
        const parts = dragPreviewParts(
          source.document,
          selection?.includes(id) ? selection : (expand?.([id]) ?? id),
        );
        if (!parts) return;
        const urls = [parts.background, parts.object].map((svg) =>
          URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' })),
        );
        active.current = { id, urls };
        background.current.src = urls[0];
        floating.current.src = urls[1];
        const host = background.current.parentElement;
        void Promise.all([background.current.decode(), floating.current.decode()])
          .then(() => {
            if (active.current?.urls === urls) host?.setAttribute('data-moving', 'true');
          })
          .catch(() => {});
      }
      const extraX = original && starting?.blockId === id ? starting.x - original.x : 0;
      const extraY = original && starting?.blockId === id ? starting.y - original.y : 0;
      floating.current.style.transformOrigin =
        ((ax - source.x) / source.width) * 100 +
        '% ' +
        ((ay - source.y) / source.height) * 100 +
        '%';
      floating.current.style.transform = `translate(${((dx + extraX) / source.width) * 100}%, ${((dy + extraY) / source.height) * 100}%) scale(${factor})`;
    },
    [end, original, source, starting, selection, expand],
  );
  return { background, floating, update, hold, end };
}
