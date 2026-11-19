import { useCallback, useLayoutEffect, useRef, type RefObject } from 'react';

/** Preserve a visible message, rather than treating unrelated tail growth as prepended history. */
export function useReadingPosition(
  paneRef: RefObject<HTMLDivElement | null>,
  contentRef: RefObject<HTMLDivElement | null>,
  followBottom: RefObject<boolean>,
) {
  const anchor = useRef<{ id: string; offset: number } | null>(null);
  const release = useCallback(() => {
    anchor.current = null;
  }, []);
  const remember = useCallback(() => {
    const pane = paneRef.current;
    if (!pane || followBottom.current) return release();
    const viewport = pane.getBoundingClientRect();
    for (const node of pane.querySelectorAll<HTMLElement>('[data-message-id]')) {
      const box = node.getBoundingClientRect();
      if (box.bottom > viewport.top + 1 && box.top < viewport.bottom) {
        anchor.current = { id: node.dataset.messageId!, offset: box.top - viewport.top };
        return;
      }
    }
    release();
  }, [paneRef, followBottom, release]);
  const restore = useCallback(() => {
    const pane = paneRef.current,
      saved = anchor.current;
    if (!pane || !saved || followBottom.current) return;
    const node = pane.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(saved.id)}"]`);
    if (!node) return release();
    const delta =
      node.getBoundingClientRect().top - pane.getBoundingClientRect().top - saved.offset;
    if (Math.abs(delta) > 0.5) pane.scrollTop += delta;
  }, [paneRef, followBottom, release]);
  // Run before paint; an animation-frame height correction can expose an intermediate jump.
  useLayoutEffect(() => {
    restore();
  });
  useLayoutEffect(() => {
    if (!contentRef.current) return;
    const observer = new ResizeObserver(restore);
    observer.observe(contentRef.current);
    if (paneRef.current) observer.observe(paneRef.current);
    return () => observer.disconnect();
  }, [contentRef, paneRef, restore]);
  return { remember, release };
}
