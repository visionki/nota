import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { post } from './api';

export const emptyReadState = {
  last_read_seq: '0',
  last_read_message_id: null,
  unread_count: 0,
  first_unread_id: null,
  first_unread_seq: null,
  latest_message_id: null,
};
export function useConversationRead(
  server: any,
  messages: any[],
  scroll: RefObject<HTMLDivElement | null>,
  ready: boolean,
) {
  const [ack, setAck] = useState<any>(server ?? emptyReadState);
  const [entryBoundary, setEntryBoundary] = useState<any>(
    ready && server?.first_unread_id
      ? { id: server.first_unread_id, seq: server.first_unread_seq }
      : null,
  );
  const initialized = useRef(ready);
  const [busy, setBusy] = useState(false);
  const state =
    BigInt(server?.last_read_seq ?? '0') >= BigInt(ack.last_read_seq) ? (server ?? ack) : ack;
  const current = useRef({ state, messages });
  const inFlight = useRef(false),
    retryAt = useRef(0);
  current.current = { state, messages };
  useEffect(() => {
    if (!initialized.current && ready) {
      initialized.current = true;
      setEntryBoundary(
        server?.first_unread_id
          ? { id: server.first_unread_id, seq: server.first_unread_seq }
          : null,
      );
    }
  }, [ready, server]);
  useEffect(() => {
    const reset = () => {
      setAck(emptyReadState);
      setEntryBoundary(null);
    };
    window.addEventListener('nota:history-reset', reset);
    return () => window.removeEventListener('nota:history-reset', reset);
  }, []);
  const markRead = useCallback(async (explicit = false, visibleMessageId?: string) => {
    const { state } = current.current;
    if (
      !state.latest_message_id ||
      !state.unread_count ||
      inFlight.current ||
      (!explicit && Date.now() < retryAt.current)
    )
      return;
    inFlight.current = true;
    setBusy(true);
    try {
      const result = await post('/chat/read', {
        message_id: explicit
          ? state.latest_message_id
          : (visibleMessageId ?? state.latest_message_id),
      });
      setAck((old: any) =>
        BigInt(result.read_state.last_read_seq) >= BigInt(old.last_read_seq)
          ? result.read_state
          : old,
      );
    } catch (e) {
      retryAt.current = Date.now() + 5000;
      if (explicit) throw e;
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }, []);
  useEffect(() => {
    if (!ready) return;
    const pane = scroll.current;
    if (!pane) return;
    let timer: ReturnType<typeof setTimeout>;
    const check = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (
          document.visibilityState !== 'visible' ||
          !document.hasFocus() ||
          document.querySelector('[role="dialog"]')
        )
          return;
        const first = current.current.state.first_unread_id;
        if (!first) return;
        const element = pane.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(first)}"]`);
        if (!element) return; // An unloaded unread boundary must never be skipped by the latest page.
        const box = element.getBoundingClientRect(),
          viewport = pane.getBoundingClientRect();
        if (box.bottom > viewport.top + 20 && box.top < viewport.bottom - 20) {
          const visible = [...pane.querySelectorAll<HTMLElement>('[data-message-id]')].filter(
            (node) => {
              const bounds = node.getBoundingClientRect();
              return bounds.bottom > viewport.top + 20 && bounds.top < viewport.bottom - 20;
            },
          );
          const last = visible.at(-1)?.dataset.messageId;
          if (last) void markRead(false, last);
        }
      }, 650);
    };
    pane.addEventListener('scroll', check, { passive: true });
    window.addEventListener('focus', check);
    document.addEventListener('visibilitychange', check);
    const observer = new ResizeObserver(check);
    observer.observe(pane);
    const flow = pane.querySelector('.conversation-flow');
    if (flow) observer.observe(flow);
    const next = () => check();
    window.addEventListener('nota:read-check', next);
    check();
    return () => {
      clearTimeout(timer);
      observer.disconnect();
      pane.removeEventListener('scroll', check);
      window.removeEventListener('focus', check);
      document.removeEventListener('visibilitychange', check);
      window.removeEventListener('nota:read-check', next);
    };
  }, [scroll, markRead, ready]);
  useEffect(() => {
    window.dispatchEvent(new Event('nota:read-check'));
  }, [state.first_unread_id, messages.length]);
  const dividerId =
    entryBoundary &&
    state.unread_count > 0 &&
    BigInt(state.last_read_seq) < BigInt(entryBoundary.seq)
      ? entryBoundary.id
      : null;
  return { state, dividerId, busy, markRead };
}
