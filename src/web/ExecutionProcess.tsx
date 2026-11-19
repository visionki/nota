import { translate } from './locale';
import React, { useEffect, useRef, useState } from 'react';
import { Activity, ChevronDown, ChevronRight, LoaderCircle } from 'lucide-react';
import {
  applyExecutionEvent,
  emptyProcess,
  executionDuration,
  operationCycle,
  type ExecutionEvent,
  type ExecutionProcessState,
  type ExecutionTool,
  type ProcessSummary,
} from '../shared/execution.js';
import { displayError } from './api';
import { loadExecutionProcess } from './execution-api';
import { Markdown, Status, useNota } from './ui';

function elapsed(milliseconds?: number) {
  if (milliseconds === undefined) return '';
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (!Number.isFinite(seconds)) return '';
  return seconds < 60
    ? translate`用时 ${seconds} 秒`
    : translate`用时 ${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}

function StreamedText({
  id,
  text,
  animate,
  streaming,
  painted,
}: {
  id: string;
  text: string;
  animate: boolean;
  streaming: boolean;
  painted: Map<string, string>;
}) {
  const [shown, setShown] = useState(() => painted.get(id) ?? (animate ? '' : text));
  const current = useRef(shown);
  useEffect(() => {
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!animate || reduced) {
      current.current = text;
      painted.set(id, text);
      setShown(text);
      return;
    }
    if (!text.startsWith(current.current)) current.current = '';
    const characters = Array.from(text);
    let count = Array.from(current.current).length,
      last = performance.now(),
      frame: number;
    const draw = (now: number) => {
      const remaining = characters.length - count;
      const step = Math.max(
        1,
        Math.floor((Math.min(now - last, 64) * (80 + Math.min(1000, remaining * 2))) / 1000),
      );
      count = Math.min(characters.length, count + step);
      const next = characters.slice(0, count).join('');
      current.current = next;
      painted.set(id, next);
      setShown(next);
      last = now;
      if (count < characters.length) frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [id, text, animate, painted]);
  return (
    <div className="process-text" data-streaming={streaming}>
      <Markdown text={animate ? shown : text} />
      {streaming && <span className="stream-caret" aria-hidden="true" />}
    </div>
  );
}

function ToolStep({ tool }: { tool: ExecutionTool }) {
  return (
    <details className="trace-step process-tool" data-tool-id={tool.id}>
      <summary>
        {tool.status === 'running' ? (
          <LoaderCircle className="spin" size={14} />
        ) : (
          <Activity size={14} />
        )}
        <strong>{translate(tool.label ?? tool.name)}</strong>
        <Status value={tool.status} />
        <ChevronDown size={13} />
      </summary>
      <div className="trace-detail">
        <span className="eyebrow">{translate('调用参数')}</span>
        <pre>{JSON.stringify(tool.input ?? {}, null, 2)}</pre>
        {tool.result !== undefined && (
          <>
            <span className="eyebrow">{translate('返回结果')}</span>
            <pre>{JSON.stringify(tool.result, null, 2)}</pre>
          </>
        )}
        {tool.error && (
          <p className={tool.status === 'superseded' ? 'muted' : 'form-error'}>{tool.error}</p>
        )}
      </div>
    </details>
  );
}

/** One delivery's public text/tool timeline; final answers remain outside this disclosure. */
export function ExecutionProcess({
  operationId,
  live = false,
  cycle: requestedCycle,
  messageId,
  summary,
}: {
  operationId: string;
  live?: boolean;
  cycle?: number;
  messageId?: string;
  summary?: ProcessSummary;
}) {
  const { boot, revision } = useNota();
  const operation = boot.operations.find((item: any) => item.id === operationId);
  const cycle = requestedCycle ?? summary?.cycle ?? operationCycle(operation);
  const [open, setOpen] = useState(live),
    [process, setProcess] = useState<ExecutionProcessState>(() => emptyProcess(cycle));
  const [loading, setLoading] = useState(false),
    [error, setError] = useState(''),
    [retry, setRetry] = useState(0),
    [now, setNow] = useState(() => new Date().toISOString());
  const buffer = useRef<ExecutionEvent[]>([]),
    initialCursor = useRef(String(boot.cursor ?? '0')),
    painted = useRef(new Map<string, string>()),
    liveTurns = useRef(new Set<string>());
  useEffect(() => setOpen(live), [live]);
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => setNow(new Date().toISOString()), 1000);
    return () => clearInterval(timer);
  }, [live]);
  useEffect(() => {
    if (!open && !live) return;
    let alive = true;
    const controller = new AbortController();
    setLoading(true);
    setError('');
    loadExecutionProcess(
      operationId,
      {
        messageId,
        cycle: operation || requestedCycle !== undefined ? cycle : undefined,
      },
      controller.signal,
    )
      .then((result) => {
        if (!alive) return;
        let snapshot = result;
        for (const event of buffer.current) snapshot = applyExecutionEvent(snapshot, event);
        if (live)
          for (const entry of snapshot.entries)
            if (
              entry.kind === 'text' &&
              BigInt(entry.updatedSequence ?? entry.sequence) > BigInt(initialCursor.current)
            )
              liveTurns.current.add(entry.id);
        buffer.current = buffer.current.filter(
          (event) => BigInt(event.id) > BigInt(snapshot.cursor),
        );
        setProcess(snapshot);
        setError('');
      })
      .catch((error) => {
        if (alive) setError(displayError(error, '暂时无法读取过程记录'));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
      controller.abort();
    };
  }, [operationId, cycle, messageId, open, live, revision, retry]);
  useEffect(() => {
    if (messageId || (!live && !open)) return;
    const receive = (event: Event) => {
      const next = (event as CustomEvent<ExecutionEvent>).detail;
      if (next.operation_id !== operationId || (next.data.cycle ?? 0) !== cycle) return;
      if (['text_reset', 'text'].includes(next.type) && next.data.turn_id)
        liveTurns.current.add(next.data.turn_id);
      buffer.current.push(next);
      setProcess((current) => applyExecutionEvent(current, next));
    };
    window.addEventListener('nota:trace', receive);
    return () => window.removeEventListener('nota:trace', receive);
  }, [operationId, cycle, messageId, live, open]);
  const finalTurnId = summary?.final_turn_id ?? process.finalTurnId;
  const entries = process.entries.filter(
    (entry) =>
      entry.kind !== 'text' || ((entry.text || live) && (live || entry.id !== finalTurnId)),
  );
  const tools = summary?.tools ?? process.entries.filter((entry) => entry.kind === 'tool').length;
  const duration = elapsed(
    summary?.stats_version === 2
      ? summary.duration_ms
      : (process.durationMs ?? executionDuration(process, live ? now : process.finishedAt)),
  );
  const toolsKnown =
    summary?.tools_known ?? (summary?.tools !== undefined || process.cursor !== '0');
  const region = `process-${messageId ?? operationId}-${cycle}`;
  if (!live && toolsKnown && tools === 0) return null;
  return (
    <div
      className={`execution-process tool-trace ${live ? 'is-live' : ''} ${tools === 0 ? 'without-tools' : ''}`}
      data-operation-id={operationId}
      data-cycle={cycle}
    >
      {(tools > 0 || !live) && (
        <button
          className="trace-toggle process-toggle"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          aria-controls={region}
          aria-label={open ? translate('收起执行过程') : translate('展开执行过程')}
        >
          {live ? <LoaderCircle size={14} className="spin" /> : <Activity size={14} />}
          <span title={translate('用时仅统计实际运行，不含排队及等待补答')}>
            {live ? translate('正在处理') : duration || translate('执行过程')}
            {toolsKnown
              ? tools > 0
                ? translate` · ${tools} 个工具步骤`
                : translate(' · 未调用工具')
              : summary
                ? translate(' · 历史统计未记录')
                : ''}
          </span>
          {live && duration && <small>{duration}</small>}
          <ChevronRight size={14} className={`process-chevron ${open ? 'expanded' : ''}`} />
        </button>
      )}
      {open && (
        <div className="process-body" id={region}>
          {entries.map((entry) =>
            entry.kind === 'text' ? (
              <StreamedText
                key={entry.id}
                id={entry.id}
                text={entry.text}
                animate={live && liveTurns.current.has(entry.id)}
                streaming={live && !entry.complete}
                painted={painted.current}
              />
            ) : entry.kind === 'tool' ? (
              <ToolStep key={entry.id} tool={entry} />
            ) : entry.kind === 'input' ? (
              <div className="process-input" key={entry.id}>
                <span>
                  {entry.status === 'applied'
                    ? translate('已接入补充')
                    : translate('收到补充，等待接入')}
                </span>
                <p>{entry.content}</p>
              </div>
            ) : (
              <div className="process-activity" key={entry.id}>
                <Activity size={13} />
                <span>{entry.message}</span>
              </div>
            ),
          )}
          {live && (
            <div className="process-working" role="status">
              <span className="process-pulse" />
              {operation?.stage === 'transcribing'
                ? translate('正在转写录音')
                : (process.activity ??
                  (entries.length
                    ? translate('Nota 正在继续处理…')
                    : translate('正在接收这次交办…')))}
            </div>
          )}
          {!live && !entries.length && !loading && !error && (
            <p className="process-empty">{translate('这次直接生成了答复，没有调用业务工具。')}</p>
          )}
          {loading && !entries.length && (
            <p className="process-empty">{translate('正在读取过程…')}</p>
          )}
          {error && (
            <p className="process-error">
              {error}
              <button className="text-button" onClick={() => setRetry((value) => value + 1)}>
                {translate('重试')}
              </button>
            </p>
          )}
        </div>
      )}
    </div>
  );
}
