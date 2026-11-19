import React, { useEffect, useRef, useState } from 'react';
import {
  AudioLines,
  Mic,
  Upload,
  Search,
  ChevronRight,
  ChevronLeft,
  ArrowLeft,
  Plus,
  CalendarDays,
  Clock3,
  Check,
  CheckCircle2,
  MoreHorizontal,
  Download,
  FileText,
  UsersRound,
  Quote,
  Link2,
  Activity,
  RefreshCw,
  Trash2,
  Pause,
  Play,
  Leaf,
  Crown,
  ArrowUpRight,
  AlertCircle,
  Bell,
  LoaderCircle,
  ExternalLink,
} from 'lucide-react';
import { api, post, patch, remove, formatDate, duration, localInput, zonedISO } from './api';
import { Button, IconButton, Modal, Markdown, Status, Empty, Field, Confirm, useNota } from './ui';
import { ToolTrace } from './App';
import { openOperation } from './operation-destination';
import type { LocalRecording } from './offline';
import { RecordingWindows, SourceExcerpt } from './RecordingWindows';
import { AgendaCalendar } from './AgendaCalendar';
import { AgendaEditor } from './AgendaEditor';
import { dateLabel } from '../shared/dates';
import { calendarRange, type CalendarView } from './calendar';
import {
  notificationLabels,
  notificationPreview,
  type NotificationKind,
} from '../shared/notifications';
export function useResource(path: string, deps: unknown[] = []) {
  const { revision } = useNota();
  const [data, setData] = useState<any>(null),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(true),
    [retry, setRetry] = useState(0);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    api(path)
      .then((r) => {
        if (alive) {
          setData(r);
          setError('');
        }
      })
      .catch((e) => {
        if (alive) setError(e.message);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [path, revision, retry, ...deps]);
  return { data, error, loading, retry: () => setRetry((n) => n + 1) };
}
export function ResourceNote({ resource }: { resource: ReturnType<typeof useResource> }) {
  return resource.error ? (
    <div className="resource-note">
      <AlertCircle size={16} />
      <span>{resource.error}</span>
      <button className="text-button" onClick={resource.retry}>
        重试
      </button>
    </div>
  ) : resource.loading && !resource.data ? (
    <div className="loading-note">
      <LoaderCircle size={18} className="spin" /> 正在读取…
    </div>
  ) : null;
}
export function PageHeading({
  eyebrow,
  title,
  description,
  children,
}: {
  eyebrow: string;
  title: string;
  description: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        <span className="eyebrow">{eyebrow}</span>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {children && <div className="page-heading-actions">{children}</div>}
    </div>
  );
}
function LocalAudio({ blob }: { blob: Blob }) {
  const [url, setUrl] = useState('');
  useEffect(() => {
    const u = URL.createObjectURL(blob);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [blob]);
  return <audio controls src={url} preload="none" />;
}
export function RecordingsView({
  localItems,
  discard,
  retry,
  onUpload,
}: {
  localItems: LocalRecording[];
  discard: (id: string) => Promise<void>;
  retry: () => Promise<any>;
  onUpload: (file: File) => Promise<void>;
}) {
  const { user, openRecording, record, toast, caps } = useNota();
  const [q, setQ] = useState(''),
    [query, setQuery] = useState(''),
    [filter, setFilter] = useState('all'),
    [confirm, setConfirm] = useState<LocalRecording | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const t = setTimeout(() => setQuery(q), 300);
    return () => clearTimeout(t);
  }, [q]);
  const r = useResource(`/recordings?q=${encodeURIComponent(query)}`);
  const records = (r.data?.recordings ?? []).filter(
    (x: any) =>
      filter === 'all' ||
      (filter === 'ready'
        ? x.status === 'ready'
        : ['pending', 'needs_attention', 'needs_confirmation'].includes(x.status)),
  );
  const files = async (list: FileList | File[]) => {
    for (const f of Array.from(list)) {
      if (f.size > (caps.maxUploadMB ?? 24) * 1024 * 1024) {
        toast(`${f.name} 超过上传大小限制`, true);
        continue;
      }
      await onUpload(f);
    }
  };
  return (
    <div className="page-container">
      <PageHeading
        eyebrow="A LIBRARY OF YOUR WORDS"
        title="每条便签，都有下文。"
        description="随口记下想法、约定与待办，原文、摘要和行动收在同一处。"
      >
        <Button variant="secondary" onClick={() => input.current?.click()}>
          <Upload size={17} />
          上传录音
        </Button>
        <Button onClick={record}>
          <Mic size={17} />
          开始录音
        </Button>
      </PageHeading>
      <RecordingWindows />
      <input
        ref={input}
        type="file"
        className="visually-hidden"
        accept="audio/*,.webm,.m4a,.mp4,.flac"
        multiple
        onChange={(e) => {
          if (e.target.files) void files(e.target.files);
          e.target.value = '';
        }}
      />
      {localItems.length > 0 && (
        <section className="local-recordings panel">
          <div className="section-heading">
            <h2>
              本机待上传 <span>{localItems.length}</span>
            </h2>
            <Button variant="secondary" onClick={() => void retry()}>
              <RefreshCw size={15} />
              重试上传
            </Button>
          </div>
          {localItems.map((item) => (
            <div className="local-recording-row" key={item.id}>
              <AudioLines size={20} />
              <div>
                <strong>{item.title}</strong>
                <small>
                  {item.error ?? '已保存在当前浏览器，收到服务端确认后才清理本机副本。'}
                </small>
                <LocalAudio blob={item.blob} />
              </div>
              <IconButton label={`删除本机录音 ${item.title}`} onClick={() => setConfirm(item)}>
                <Trash2 size={17} />
              </IconButton>
            </div>
          ))}
        </section>
      )}
      <div className="list-toolbar">
        <div className="tabs" aria-label="便签筛选">
          {[
            ['all', '全部便签'],
            ['ready', '已整理'],
            ['attention', '待处理'],
          ].map(([v, label]) => (
            <button key={v} className={filter === v ? 'active' : ''} onClick={() => setFilter(v)}>
              {label}
            </button>
          ))}
        </div>
        <label className="search-field">
          <Search size={16} />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜索标题或转写内容"
            aria-label="搜索录音"
          />
        </label>
      </div>
      <ResourceNote resource={r} />
      {!records.length && !r.loading && !r.error ? (
        <Empty
          title={q ? '没有匹配的录音' : '声音进来，行动开始。'}
          description={
            q
              ? '试试其他关键词，也可以在对话中按人物和时间查找。'
              : '口述自己的想法、约定或待办，Nota 会保留原文，并执行明确交办。'
          }
          icon={<AudioLines size={30} strokeWidth={1.3} />}
        >
          <Button variant="secondary" onClick={record}>
            <Mic size={16} />
            记第一段声音
          </Button>
        </Empty>
      ) : (
        <div className="recording-grid">
          {records.map((record: any) => (
            <button
              className="recording-card"
              key={record.id}
              onClick={() => openRecording(record.id)}
            >
              <div className="recording-card-top">
                <span className="audio-tile">
                  <AudioLines size={23} />
                </span>
                <Status value={record.status} />
              </div>
              <h3>{record.title}</h3>
              <p>
                {record.summary?.replace(/[#*\[\]]/g, '').slice(0, 115) ||
                  record.excerpt ||
                  record.last_error ||
                  (record.status === 'pending'
                    ? '录音已上传，免费额度已用完，待额度恢复后自动整理。'
                    : '录音已保存，等待 Nota 整理。')}
              </p>
              <footer>
                <span>
                  {formatDate(record.created_at, user.timezone, {
                    hour: undefined,
                    minute: undefined,
                  })}{' '}
                  · {duration(Number(record.duration_seconds))}
                </span>
                <ChevronRight size={16} />
              </footer>
            </button>
          ))}
        </div>
      )}
      {confirm && (
        <Confirm
          title="删除这段本机录音？"
          body="这段录音尚未收到服务端上传确认。删除后将无法从 Nota 找回。"
          danger
          onClose={() => setConfirm(null)}
          onConfirm={() => discard(confirm.id)}
        />
      )}
    </div>
  );
}
export function RecordingDetail({
  id,
  reference = '',
  onBack,
}: {
  id: string;
  reference?: string;
  onBack: () => void;
}) {
  const { user, action, toast, navigate } = useNota();
  const r = useResource(`/recordings/${id}`),
    record = r.data?.recording;
  const [tab, setTab] = useState('summary'),
    [editing, setEditing] = useState(false),
    [text, setText] = useState(''),
    [title, setTitle] = useState(''),
    [revision, setRevision] = useState<any>(null),
    [sourceChunk, setSourceChunk] = useState(new URLSearchParams(reference).get('chunk')),
    [excerpt, setExcerpt] = useState<any>(null),
    [busy, setBusy] = useState(false);
  const audio = useRef<HTMLAudioElement>(null);
  const source = revision ?? record;
  useEffect(() => {
    let alive = true;
    const version = new URLSearchParams(reference).get('version');
    if (version)
      void api(`/recordings/${id}/revisions/${version}`)
        .then((res) => {
          if (alive) {
            setRevision(res.revision);
            setTab('transcript');
          }
        })
        .catch((e) => toast(e.message, true));
    if (sourceChunk)
      void api(`/sources/${sourceChunk}`)
        .then((res) => {
          if (alive) {
            setExcerpt(res);
            setTab('transcript');
          }
        })
        .catch((e) => toast(e.message, true));
    return () => {
      alive = false;
    };
  }, [id, reference, sourceChunk]);
  return (
    <div className="page-container recording-detail">
      <button className="back-button" onClick={onBack}>
        <ArrowLeft size={16} />
        回到语音便签
      </button>
      <ResourceNote resource={r} />
      {record && (
        <>
          <div className="detail-heading">
            <div>
              <span className="eyebrow">A NOTE, WITH ITS SOURCE</span>
              <h1>{record.title}</h1>
              <div className="detail-meta">
                <Status value={record.status} />
                <span>
                  {record.recorded_at ? '录制于' : '上传于'}{' '}
                  {formatDate(
                    record.recorded_at ?? record.created_at,
                    record.recorded_timezone ?? user.timezone,
                  )}
                  {!record.recorded_at ? ' · 录制时间未知' : ''} ·{' '}
                  {duration(Number(record.duration_seconds))}
                </span>
              </div>
            </div>
            <Button
              variant="secondary"
              disabled={['pending', 'uploaded', 'transcribing', 'organizing'].includes(
                record.status,
              )}
              onClick={() => {
                setTitle(record.title);
                setText(record.transcript);
                setEditing(true);
              }}
            >
              修订原文
            </Button>
          </div>
          <div className="audio-player panel">
            <div className="audio-tile">
              <AudioLines size={24} />
            </div>
            <div>
              <strong>原始录音</strong>
              <audio ref={audio} controls src={`/api/recordings/${id}/audio`} preload="metadata" />
            </div>
            <a
              className="icon-button"
              href={`/api/recordings/${id}/audio`}
              download={record.filename}
              title="下载录音"
              aria-label="下载录音"
            >
              <Download size={19} />
            </a>
          </div>
          {record.status === 'pending' && (
            <div className="inline-note" role="status">
              <Clock3 size={18} />
              <span>
                录音已上传，免费额度已用完，待额度恢复后自动整理。免费额度于北京时间每日 00:00
                重置。
              </span>
            </div>
          )}
          {record.last_error && (
            <div className="resource-note">
              <AlertCircle size={18} />
              <span>{record.last_error}</span>
              <Button
                variant="ghost"
                onClick={() =>
                  void action(
                    () =>
                      post(`/operations/${record.retry_operation_id ?? record.operation_id}/retry`),
                    '已重新排队',
                  )
                }
              >
                重试整理
              </Button>
            </div>
          )}
          <div className="list-toolbar">
            <div className="tabs">
              {[
                ['summary', '整理摘要'],
                ['transcript', '转写原文'],
                ['history', '版本与来源'],
              ].map(([v, l]) => (
                <button key={v} className={tab === v ? 'active' : ''} onClick={() => setTab(v)}>
                  {l}
                </button>
              ))}
            </div>
          </div>
          {tab === 'summary' && (
            <section className="document-panel panel">
              {record.summary ? (
                <Markdown text={record.summary} />
              ) : (
                <Empty
                  title={record.status === 'pending' ? '录音已上传，等待处理' : '摘要还在路上'}
                  description={
                    record.status === 'pending'
                      ? '额度恢复后自动开始转写和整理，你可以继续上传录音。'
                      : record.status === 'needs_attention'
                        ? '请先处理上方提示，录音和已有原文已保留。'
                        : '录音保存后，Nota 会在后台完成整理。'
                  }
                />
              )}
              <div className="document-footer">
                <span>
                  <Link2 size={14} />
                  行动与来源保留在这条便签中
                </span>
                <button className="text-button" onClick={() => setTab('history')}>
                  查看工具回执 <ChevronRight size={13} />
                </button>
              </div>
            </section>
          )}
          {tab === 'transcript' && (
            <section className="document-panel panel">
              <div className="document-title">
                <h2>{revision ? `历史版本 ${revision.version}` : '当前原文'}</h2>
                {revision && (
                  <button className="text-button" onClick={() => setRevision(null)}>
                    返回当前版本
                  </button>
                )}
              </div>
              {sourceChunk && excerpt ? (
                <>
                  <p className="source-note">引用位置及附近原文 · 版本 {excerpt.source_version}</p>
                  <SourceExcerpt chunks={excerpt.chunks} selected={sourceChunk} />
                  <Button variant="secondary" onClick={() => setSourceChunk(null)}>
                    查看该版本全文
                  </Button>
                </>
              ) : source?.segments?.length ? (
                <div className="transcript-segments">
                  {source.segments.map((s: any, i: number) => (
                    <div className="transcript-segment" key={i}>
                      <button
                        className="segment-time"
                        onClick={() => {
                          if (audio.current) {
                            audio.current.currentTime = s.start;
                            void audio.current.play().catch(() => {});
                          }
                        }}
                      >
                        {duration(s.start)}
                      </button>
                      <div>
                        <p>{s.text}</p>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <>
                  <p className="source-note">以下为你保存的口述原文，可修订并回查历史版本。</p>
                  <div className="transcript-plain">{source?.transcript || '等待转写…'}</div>
                </>
              )}
            </section>
          )}
          {tab === 'history' && (
            <section className="document-panel panel">
              <h2>原文版本可复查</h2>
              <p className="muted">
                修订保留旧版本，摘要和检索索引会重新整理；已有日程与待办保留原执行事实。
              </p>
              <div className="revision-list">
                {r.data.revisions.map((v: any) => (
                  <button
                    key={v.id}
                    onClick={async () => {
                      try {
                        const res = await api(`/recordings/${id}/revisions/${v.version}`);
                        setRevision(res.revision);
                        setTab('transcript');
                      } catch (e: any) {
                        toast(e.message, true);
                      }
                    }}
                  >
                    <span className="revision-number">{v.version.toString().padStart(2, '0')}</span>
                    <div>
                      <strong>{v.source === 'user_edit' ? '手动修订' : v.source}</strong>
                      <small>{formatDate(v.created_at, user.timezone)}</small>
                    </div>
                    <span className="text-button">
                      查看原文 <ChevronRight size={14} />
                    </span>
                  </button>
                ))}
              </div>
              <ToolTrace operationId={record.agent_operation_id ?? record.operation_id} />
            </section>
          )}
          {editing && (
            <Modal title="修订录音原文" wide onClose={() => setEditing(false)}>
              <form
                className="modal-form"
                onSubmit={async (e) => {
                  e.preventDefault();
                  setBusy(true);
                  const result = await action(
                    () => patch(`/recordings/${id}`, { title, transcript: text }),
                    '已保存修订，旧版本仍可复查',
                  );
                  setBusy(false);
                  if (result) {
                    setEditing(false);
                    setRevision(null);
                  }
                }}
              >
                <Field label="标题">
                  <input
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    required
                    maxLength={200}
                  />
                </Field>
                <Field
                  label="转写原文"
                  hint="修订会清除当前版本的旧时间戳对齐。旧版本与原始录音仍保留。"
                >
                  <textarea
                    rows={15}
                    value={text}
                    maxLength={200000}
                    onChange={(e) => setText(e.target.value)}
                  />
                </Field>
                <footer className="modal-actions">
                  <Button variant="secondary" type="button" onClick={() => setEditing(false)}>
                    取消
                  </Button>
                  <Button type="submit" busy={busy}>
                    保存修订
                  </Button>
                </footer>
              </form>
            </Modal>
          )}
        </>
      )}
    </div>
  );
}
export function AgendaView() {
  const { user, openCreate, action, navigationTarget } = useNota();
  const [tab, setTab] = useState(
      navigationTarget?.startsWith('schedule:') ? 'automations' : 'calendar',
    ),
    [calendarView, setCalendarView] = useState<CalendarView>('month'),
    [selectedDate, setSelectedDate] = useState(() =>
      localInput(new Date(), user.timezone).slice(0, 10),
    ),
    [confirm, setConfirm] = useState<any>(null);
  const { from, to } = calendarRange(selectedDate, calendarView, user.timezone);
  const r = useResource(`/agenda?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`),
    t = useResource('/todos'),
    s = useResource('/schedules');
  const events = r.data?.events ?? [],
    todos = t.data?.todos ?? r.data?.todos ?? [],
    reminders = [
      ...(r.data?.reminders ?? []),
      ...(r.data?.event_reminders ?? []),
      ...(r.data?.todo_reminders ?? []),
    ];
  useEffect(() => {
    if (!navigationTarget?.startsWith('schedule:')) return;
    setTab('automations');
    if (!s.loading)
      document
        .querySelector(`[data-schedule-id="${CSS.escape(navigationTarget.slice(9))}"]`)
        ?.scrollIntoView({ block: 'center', behavior: 'instant' });
  }, [navigationTarget, s.loading]);
  const createArrangement = () => {
    openCreate('arrangement', {
      starts_on: selectedDate,
      all_day: true,
      onSaved: (value: string) => {
        if (value) setSelectedDate(value.slice(0, 10));
      },
    });
  };
  return (
    <div className="page-container agenda-page">
      <PageHeading
        eyebrow="YOUR CALENDAR"
        title="日程与待办"
        description="日程和有日期的待办一起看，提醒跟随事项。"
      >
        <a href="/api/calendar.ics" className="btn secondary">
          <Download size={16} />
          导出日历
        </a>
        <Button
          onClick={() =>
            tab === 'calendar' || tab === 'all'
              ? createArrangement()
              : openCreate(tab === 'todos' ? 'todo' : 'schedule')
          }
        >
          <Plus size={17} />
          {tab === 'todos' ? '新建待办' : tab === 'automations' ? '新建自动任务' : '新建事项'}
        </Button>
      </PageHeading>
      <div className="tabs page-tabs">
        {[
          ['calendar', '日历'],
          ['all', '全部事项'],
          [
            'todos',
            `待办事项${todos.length ? ` · ${todos.filter((x: any) => x.status === 'open').length}` : ''}`,
          ],
          ['automations', '自动任务'],
        ].map(([v, l]) => (
          <button key={v} className={tab === v ? 'active' : ''} onClick={() => setTab(v)}>
            {l}
          </button>
        ))}
      </div>
      {(tab === 'calendar' || tab === 'all') && (
        <>
          <ResourceNote resource={r} />
          <AgendaCalendar
            selectedDate={selectedDate}
            onSelectDate={setSelectedDate}
            view={calendarView}
            onViewChange={setCalendarView}
            events={events}
            todos={r.data?.todos ?? []}
            reminders={reminders}
            list={tab === 'all'}
            loading={r.loading}
            onCancelReminder={(item) => setConfirm({ kind: 'reminder', item })}
          />
        </>
      )}
      {tab === 'todos' && (
        <>
          <ResourceNote resource={t} />
          <div className="todo-list panel">
            {todos.length ? (
              todos.map((todo: any) => (
                <div className={`todo-row ${todo.status === 'done' ? 'done' : ''}`} key={todo.id}>
                  <button
                    className="todo-check"
                    aria-label={`${todo.status === 'done' ? '恢复' : '完成'}待办 ${todo.title}`}
                    onClick={() =>
                      void action(() =>
                        patch(`/todos/${todo.id}`, {
                          status: todo.status === 'done' ? 'open' : 'done',
                        }),
                      )
                    }
                  >
                    {todo.status === 'done' && <Check size={14} />}
                  </button>
                  <button className="todo-content" onClick={() => openCreate('todo', todo)}>
                    <strong>{todo.title}</strong>
                    {todo.notes && <p>{todo.notes}</p>}
                    <small
                      className={
                        todo.status !== 'done' &&
                        ((todo.due_at && Date.parse(todo.due_at) < Date.now()) ||
                          (todo.due_date &&
                            todo.due_date < localInput(new Date(), user.timezone).slice(0, 10)))
                          ? 'overdue'
                          : ''
                      }
                    >
                      {todo.planned_date
                        ? `计划 ${dateLabel(todo.planned_date)}`
                        : todo.planned_at
                          ? `计划 ${formatDate(todo.planned_at, user.timezone)}`
                          : '未安排日期'}
                      {(todo.due_date || todo.due_at) &&
                        ` · 截止 ${todo.due_date ? dateLabel(todo.due_date) : formatDate(todo.due_at, user.timezone)}`}
                    </small>
                    {todo.reminders?.some((x: any) => x.status === 'scheduled') && (
                      <small className="todo-reminder-summary">
                        <Bell size={12} />
                        {todo.reminders.filter((x: any) => x.status === 'scheduled').length} 个提醒
                      </small>
                    )}
                  </button>
                  {todo.recording_id && <span className="tiny-tag">来自录音</span>}
                  <Status value={todo.status} />
                </div>
              ))
            ) : (
              <Empty
                title="先记下来，一件一件做。"
                description="直接添加待办，或让 Nota 从录音和对话里提取明确的行动。"
              >
                <Button variant="secondary" onClick={() => openCreate('todo')}>
                  <Plus size={16} />
                  添加待办
                </Button>
              </Empty>
            )}
          </div>
        </>
      )}
      {tab === 'automations' && (
        <>
          <div className="inline-note">
            <Clock3 size={17} />
            自动任务会在指定时间激活同一个 Nota，结果回到对话；每次激活计为一次 AI
            处理。普通到点提醒不扣 AI 额度。
          </div>
          <ResourceNote resource={s} />
          {s.data?.schedules.length ? (
            <div className="schedule-list">
              {s.data.schedules.map((x: any) => (
                <div className="schedule-card panel" key={x.id} data-schedule-id={x.id}>
                  <span className="audio-tile">
                    <Clock3 size={21} />
                  </span>
                  <div>
                    <h3>{x.title}</h3>
                    <p>{x.prompt}</p>
                    <small>
                      {x.active
                        ? `下次 ${formatDate(x.next_run_at, user.timezone)}`
                        : '已暂停或执行完毕'}
                      {x.cron && ` · ${x.cron} · ${x.timezone}`}
                    </small>
                    <label className="schedule-notification-policy">
                      <span>结果通知</span>
                      <select
                        aria-label={`${x.title}的结果通知`}
                        value={x.notification_policy ?? 'always'}
                        onChange={(e) =>
                          void action(
                            () =>
                              patch(`/schedules/${x.id}`, { notification_policy: e.target.value }),
                            '已更新结果通知方式',
                          )
                        }
                      >
                        <option value="always">每次交付结果</option>
                        <option value="on_change">有新变化时通知</option>
                      </select>
                    </label>
                  </div>
                  <Button
                    variant="secondary"
                    onClick={() =>
                      void action(
                        () => patch(`/schedules/${x.id}`, { active: !x.active }),
                        x.active ? '已暂停自动任务' : '已启用自动任务',
                      )
                    }
                  >
                    {x.active ? <Pause size={15} /> : <Play size={15} />}{' '}
                    {x.active ? '暂停' : '启用'}
                  </Button>
                </div>
              ))}
            </div>
          ) : (
            !s.loading && (
              <Empty
                title="需要的时候，Nota 会主动来。"
                description="例如工作日早上整理今日安排，或在某个时间查询项目进度。"
              >
                <Button variant="secondary" onClick={() => openCreate('schedule')}>
                  <Plus size={16} />
                  设置自动任务
                </Button>
              </Empty>
            )
          )}
        </>
      )}
      {confirm && (
        <Confirm
          title={
            confirm.item.event_id || confirm.item.todo_id ? '取消这条提醒？' : '取消这个独立提醒？'
          }
          body={confirm.item.title}
          onClose={() => setConfirm(null)}
          onConfirm={() => action(() => remove(`/reminders/${confirm.item.id}`), '提醒已取消')}
        />
      )}
    </div>
  );
}
function IdentityCandidate({
  candidate,
  people,
  onResolve,
  onSource,
}: {
  candidate: any;
  people: any[];
  onResolve: (body: any) => Promise<any>;
  onSource: () => void;
}) {
  const [selected, setSelected] = useState(''),
    [organization, setOrganization] = useState(candidate.organization ?? ''),
    [role, setRole] = useState('');
  return (
    <article className="identity-candidate panel">
      <strong>
        {candidate.person_name} · {candidate.subject}
      </strong>
      <p>
        {candidate.predicate}：{candidate.value}
      </p>
      <blockquote>{candidate.evidence}</blockquote>
      <button className="text-button" onClick={onSource}>
        查看原文出处
      </button>
      <div>
        <select
          aria-label={`确认 ${candidate.person_name} 的身份`}
          value={selected}
          onChange={(e) => setSelected(e.target.value)}
        >
          <option value="">选择已知人物，暂不确定可保留待确认</option>
          {people.map((p) => (
            <option value={p.id} key={p.id}>
              {p.name}
              {p.organization ? ` · ${p.organization}` : ''}
              {p.role ? ` · ${p.role}` : ''}
            </option>
          ))}
          <option value="__new__">这是另一位同名人物</option>
        </select>
        {selected === '__new__' && (
          <div className="modal-form">
            <Field label="组织">
              <input
                value={organization}
                onChange={(e) => setOrganization(e.target.value)}
                maxLength={200}
              />
            </Field>
            <Field label="身份说明">
              <input value={role} onChange={(e) => setRole(e.target.value)} maxLength={200} />
            </Field>
          </div>
        )}
        <Button
          variant="secondary"
          disabled={!selected}
          onClick={() =>
            void onResolve(
              selected === '__new__'
                ? { new_person: { name: candidate.person_name, organization, role } }
                : { person_id: selected },
            )
          }
        >
          确认关联
        </Button>
      </div>
    </article>
  );
}
function MemoryDetails({ fact, onClose }: { fact: any; onClose: () => void }) {
  const { user, openSource, openRecording } = useNota(),
    details = useResource(`/facts/${fact.id}/history`);
  const actions: Record<string, string> = {
    ADD: '保存记忆',
    MERGE: '合并来源',
    SUPERSEDE: '更新当前值',
    SUPERSEDED: '保留为历史',
    HISTORICAL: '加入历史',
    CONFIRM: '确认当前值',
    CONFIRM_IDENTITY: '确认人物',
    MERGE_IDENTITY: '确认人物并合并',
    ARCHIVE: '转入归档',
    PIN: '设为长期保留',
    UNPIN: '取消长期保留',
  };
  return (
    <Modal title={`${fact.subject}的证据与变化`} onClose={onClose}>
      <ResourceNote resource={details} />
      <div className="memory-evidence-list">
        {details.data?.evidence.map((e: any) => (
          <article className="panel" key={e.id}>
            <small>
              {e.observed_at
                ? `提及于 ${formatDate(e.observed_at, user.timezone)}`
                : '提及时间未知'}{' '}
              · {e.source_kind === 'recording' ? '录音' : '对话'} · 版本 {e.source_version}
            </small>
            <blockquote>{e.evidence}</blockquote>
            <button
              className="text-button"
              onClick={() =>
                e.source_refs[0]?.chunk_id
                  ? openSource?.(e.source_refs[0].chunk_id)
                  : e.source_kind === 'recording'
                    ? openRecording(`${e.source_id}?version=${e.source_version}`)
                    : undefined
              }
            >
              查看这段原文
            </button>
          </article>
        ))}
        {details.data?.events.map((e: any) => (
          <p key={e.id}>
            <small>
              {formatDate(e.created_at, user.timezone)} · {actions[e.action] ?? '记忆更新'}
            </small>
          </p>
        ))}
      </div>
    </Modal>
  );
}
export function MemoryView() {
  const { user, openRecording, openSource, action, toast } = useNota();
  const [person, setPerson] = useState(''),
    [memoryMode, setMemoryMode] = useState<'current' | 'history' | 'timeline'>('current'),
    [q, setQ] = useState(''),
    [query, setQuery] = useState(''),
    [retract, setRetract] = useState<any>(null),
    [details, setDetails] = useState<any>(null),
    [editing, setEditing] = useState<any>(null);
  useEffect(() => {
    const t = setTimeout(() => setQuery(q), 300);
    return () => clearTimeout(t);
  }, [q]);
  const people = useResource('/people'),
    memoryStatus = useResource('/memory/status'),
    candidates = useResource('/memory/candidates'),
    facts = useResource(
      `/facts?mode=${memoryMode}&q=${encodeURIComponent(query)}${person ? `&person_id=${person}` : ''}`,
    );
  return (
    <div className="page-container">
      <PageHeading
        eyebrow="MEMORY, WITH A SOURCE"
        title="记得细节，也记得来处。"
        description="保留重要细节和原文出处。当前记忆随更正更新，过往变化仍可回查。"
      />
      <div className="memory-layout">
        <aside className="people-panel panel">
          <div className="section-heading">
            <h2>人物</h2>
            <span className="count">{people.data?.people.length ?? 0}</span>
          </div>
          <button className={`person-row ${!person ? 'active' : ''}`} onClick={() => setPerson('')}>
            <span className="person-avatar all">
              <UsersRound size={18} />
            </span>
            <div>
              <strong>全部记忆</strong>
              <small>跨人物、项目查看</small>
            </div>
          </button>
          <ResourceNote resource={people} />
          {people.data?.people.map((p: any) => (
            <button
              className={`person-row ${person === p.id ? 'active' : ''}`}
              key={p.id}
              onClick={() => setPerson(p.id)}
            >
              <span className="person-avatar">{p.name.slice(0, 1)}</span>
              <div>
                <strong>{p.name}</strong>
                <small>{p.organization || p.aliases?.join('、') || '未补充身份'}</small>
              </div>
              <span>{p.facts_count}</span>
            </button>
          ))}
          {person && (
            <button
              className="text-button edit-person"
              onClick={() => setEditing(people.data.people.find((p: any) => p.id === person))}
            >
              编辑人物与别名
            </button>
          )}
          <p className="people-note">记忆来自你的口述。相同姓名、不同身份不会自动合并。</p>
        </aside>
        <section className="memory-main">
          {!!memoryStatus.data?.pending && (
            <p className="muted" role="status">
              还有 {memoryStatus.data.pending} 份资料正在整理记忆，原文和日程已保留。
            </p>
          )}
          {!!memoryStatus.data?.failed && (
            <div className="inline-error" role="status">
              <span>有 {memoryStatus.data.failed} 份资料的记忆整理未完成。</span>
              <Button
                variant="ghost"
                onClick={() => action(() => post('/memory/retry', {}), '已重新安排记忆整理')}
              >
                重试整理
              </Button>
            </div>
          )}
          {!!candidates.data?.candidates.length && (
            <div className="identity-candidates">
              <h2>需要确认的记忆</h2>
              {candidates.data.candidates.map((candidate: any) =>
                candidate.status === 'needs_identity' ? (
                  <IdentityCandidate
                    key={candidate.id}
                    candidate={candidate}
                    people={people.data?.people ?? []}
                    onSource={() => openSource?.(candidate.source_refs[0]?.chunk_id)}
                    onResolve={(body) =>
                      action(
                        () => post(`/memory/candidates/${candidate.id}/resolve`, body),
                        '已确认人物，原文证据保留',
                      )
                    }
                  />
                ) : (
                  <article className="identity-candidate panel" key={candidate.id}>
                    <strong>
                      {candidate.subject} · {candidate.predicate}
                    </strong>
                    <p>新记录：{candidate.value}</p>
                    {!!candidate.comparison?.changed_values?.length && (
                      <p>
                        已有记录：
                        {candidate.comparison.changed_values.map((f: any) => f.value).join('、')}
                      </p>
                    )}
                    <blockquote>{candidate.evidence}</blockquote>
                    <p>这些信息是否属于同一范围，需要你确认。</p>
                    <Button
                      variant="secondary"
                      onClick={() =>
                        void action(
                          () => post(`/facts/${candidate.fact_id}/confirm`, {}),
                          '已更新当前记忆',
                        )
                      }
                    >
                      确认为当前值
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() =>
                        void action(() => remove(`/facts/${candidate.fact_id}`), '已忽略这条候选')
                      }
                    >
                      忽略
                    </Button>
                  </article>
                ),
              )}
            </div>
          )}
          <div className="list-toolbar">
            <h2>
              {person
                ? `${people.data?.people.find((p: any) => p.id === person)?.name ?? ''} 的记忆`
                : '事实与关系'}
            </h2>
            <label className="search-field">
              <Search size={16} />
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="搜索项目、关系、金额…"
                aria-label="搜索记忆"
              />
            </label>
          </div>
          <div className="memory-modes" role="group" aria-label="记忆范围">
            {(
              [
                ['current', '当前有效'],
                ['history', '历史与归档'],
                ['timeline', '变化过程'],
              ] as const
            ).map(([mode, label]) => (
              <button
                key={mode}
                type="button"
                aria-pressed={memoryMode === mode}
                onClick={() => setMemoryMode(mode)}
              >
                {label}
              </button>
            ))}
          </div>
          <ResourceNote resource={facts} />
          {facts.data?.facts.length ? (
            <div className="facts-list">
              {facts.data.facts.map((f: any) => (
                <article className="fact-card panel" key={f.id}>
                  <div className="fact-top">
                    <span className="fact-relation">{f.predicate}</span>
                    <time>
                      {f.time_precision === 'legacy'
                        ? `原记录日期 ${formatDate(f.effective_at, user.timezone, { hour: undefined, minute: undefined })}（待核对）`
                        : f.effective_date
                          ? `${f.effective_date} · 事实日期`
                          : f.effective_at
                            ? formatDate(f.effective_at, user.timezone, {
                                hour: undefined,
                                minute: undefined,
                                year: 'numeric',
                              })
                            : f.observed_at
                              ? `提及于 ${formatDate(f.observed_at, user.timezone, { hour: undefined, minute: undefined, year: 'numeric' })}`
                              : '事实时间未知'}
                    </time>
                    <span className="memory-state">
                      {f.status === 'superseded'
                        ? '已被替换'
                        : f.tier === 'archive'
                          ? '已归档'
                          : f.pinned
                            ? '长期保留'
                            : '当前有效'}
                    </span>
                    {f.status === 'active' && (
                      <IconButton
                        label={`${f.pinned ? '取消长期保留' : '长期保留'} ${f.subject}`}
                        onClick={() =>
                          void action(
                            () => patch(`/facts/${f.id}`, { pinned: !f.pinned }),
                            f.pinned ? '已取消长期保留' : '已设为长期保留',
                          )
                        }
                      >
                        <CheckCircle2 size={15} />
                      </IconButton>
                    )}
                    <IconButton label={`移除记忆 ${f.subject}`} onClick={() => setRetract(f)}>
                      <Trash2 size={15} />
                    </IconButton>
                  </div>
                  <h3>
                    <span>{f.subject}</span>
                    <ChevronRight size={14} />
                    <small>{f.predicate}</small>
                    <strong>{f.value}</strong>
                  </h3>
                  {(f.certainty === 'tentative' || f.certainty === 'goal' || f.qualifiers) && (
                    <p className="memory-state">
                      {f.certainty === 'tentative'
                        ? '尚未确认'
                        : f.certainty === 'goal'
                          ? '目标 / 意向'
                          : ''}
                      {f.qualifiers ? ` · ${f.qualifiers}` : ''}
                    </p>
                  )}
                  {!!f.business_links?.length && (
                    <p className="memory-state">
                      关联事项：
                      {f.business_links
                        .map(
                          (l: any) => `${l.title}${l.status === 'cancelled' ? '（已取消）' : ''}`,
                        )
                        .join('、')}
                    </p>
                  )}
                  <blockquote>
                    <Quote size={15} />
                    <span>{f.evidence}</span>
                  </blockquote>
                  <footer>
                    <button
                      className="text-button"
                      aria-label={`查看证据 ${f.subject}`}
                      onClick={() => setDetails(f)}
                    >
                      原文证据{f.evidence_count > 1 ? ` · ${f.evidence_count} 份来源` : ''}
                      {f.recording_version ? ` · 版本 ${f.recording_version}` : ''}
                    </button>
                    {f.recording_id ? (
                      <button
                        className="source-link"
                        onClick={() =>
                          openRecording(
                            `${f.recording_id}${f.recording_version ? `?version=${f.recording_version}${f.source_refs?.[0]?.chunk_id ? `&chunk=${f.source_refs[0].chunk_id}` : ''}` : ''}`,
                          )
                        }
                      >
                        <AudioLines size={14} />
                        {f.recording_title || '查看来源录音'}
                        <ChevronRight size={13} />
                      </button>
                    ) : (
                      <button
                        className="source-link"
                        onClick={() =>
                          f.source_refs?.[0]?.chunk_id && openSource?.(f.source_refs[0].chunk_id)
                        }
                      >
                        <MessageSquareSmall />
                        来自你的交办
                      </button>
                    )}
                  </footer>
                </article>
              ))}
            </div>
          ) : (
            !facts.loading &&
            !facts.error && (
              <Empty
                title={q ? '没有找到相关记忆' : '记忆从你的便签里长出来。'}
                description="人物、关系、偏好和约定会保留原文。明确更正会更新当前记忆，历史与归档可随时回查。"
                icon={<UsersRound size={30} strokeWidth={1.3} />}
              />
            )
          )}
        </section>
      </div>
      {retract && (
        <Confirm
          title="忘记这条记忆？"
          body="将停止召回并阻止后台重新保存这条记忆，清除相关检索向量。原始录音和对话存档仍保留，可由你直接打开。"
          danger
          onClose={() => setRetract(null)}
          onConfirm={() => action(() => remove(`/facts/${retract.id}`), '已移除记忆')}
        />
      )}
      {details && <MemoryDetails fact={details} onClose={() => setDetails(null)} />}
      {editing && (
        <Modal title="编辑人物" onClose={() => setEditing(null)}>
          <form
            className="modal-form"
            onSubmit={async (e) => {
              e.preventDefault();
              const a = Object.fromEntries(new FormData(e.currentTarget));
              const r = await action(
                () =>
                  patch(`/people/${editing.id}`, {
                    name: a.name,
                    organization: a.organization,
                    role: a.role,
                    aliases: String(a.aliases)
                      .split(/[，,、]/)
                      .map((s) => s.trim())
                      .filter(Boolean),
                  }),
                '人物信息已保存',
              );
              if (r) setEditing(null);
            }}
          >
            <Field label="姓名">
              <input name="name" defaultValue={editing.name} required maxLength={100} />
            </Field>
            <Field label="别名" hint="多个别名用逗号分隔；不会自动合并同名人物。">
              <input name="aliases" defaultValue={editing.aliases.join('，')} />
            </Field>
            <Field label="组织">
              <input name="organization" defaultValue={editing.organization} />
            </Field>
            <Field label="角色">
              <input name="role" defaultValue={editing.role} />
            </Field>
            <footer className="modal-actions">
              <Button type="submit">保存</Button>
            </footer>
          </form>
        </Modal>
      )}
    </div>
  );
}
function MessageSquareSmall() {
  return <FileText size={14} />;
}
export function NotificationsView() {
  const context = useNota();
  const { user, boot, action, navigate } = context;
  const r = useResource('/notifications');
  const [filter, setFilter] = useState<NotificationKind | 'all'>('all');
  const items = (r.data?.notifications ?? []).filter(
    (n: any) => filter === 'all' || n.kind === filter,
  );
  const open = async (n: any) => {
    await post('/notifications/read', { ids: [n.id] });
    if (n.object_type === 'schedule') {
      navigate('agenda', `schedule:${n.object_id}`);
    } else if (
      n.kind === 'attention' &&
      n.object_type === 'operation' &&
      n.object_status !== 'waiting'
    ) {
      await openOperation(context, n.object_id);
    } else if (n.message_id) {
      if (n.object_status === 'waiting')
        sessionStorage.setItem(`nota:reply:${user.id}`, n.object_id);
      navigate('chat', n.message_id);
    } else {
      if (n.object_type === 'operation') await openOperation(context, n.object_id);
      else navigate('agenda', n.object_id);
    }
  };
  return (
    <div className="page-container narrow-page">
      <PageHeading
        eyebrow="A GENTLE NUDGE"
        title="重要的事，有人记着。"
        description="到时提醒、后台任务的新结果，以及需要你处理的事。"
      >
        <Button
          variant="secondary"
          disabled={!boot.counts.unread}
          onClick={() => void action(() => post('/notifications/read'), '已全部标记为已读')}
        >
          <Check size={16} />
          全部已读
        </Button>
      </PageHeading>
      <div className="tabs page-tabs notification-tabs" aria-label="通知分类">
        {(['all', 'reminder', 'task_result', 'attention'] as const).map((kind) => (
          <button
            key={kind}
            className={filter === kind ? 'active' : ''}
            aria-pressed={filter === kind}
            onClick={() => setFilter(kind)}
          >
            {kind === 'all' ? '全部' : notificationLabels[kind]}
          </button>
        ))}
      </div>
      <ResourceNote resource={r} />
      <div className="notification-list panel">
        {items.length
          ? items.map((n: any) => (
              <button
                className={`notification-row ${n.read_at ? 'read' : ''}`}
                key={n.id}
                data-notification-id={n.id}
                onClick={() => void action(() => open(n))}
              >
                <div
                  className={`notification-icon ${n.kind === 'attention' && !n.resolved_at ? 'needs-attention' : ''}`}
                >
                  {n.kind === 'reminder' ? (
                    <Bell size={20} />
                  ) : n.kind === 'attention' ? (
                    <AlertCircle size={20} />
                  ) : (
                    <Leaf size={20} />
                  )}
                </div>
                <div>
                  <div className="notification-meta">
                    <span>{notificationLabels[n.kind as NotificationKind]}</span>
                    {n.kind === 'attention' && (
                      <span className={n.resolved_at ? '' : 'pending'}>
                        {n.resolved_at ? '已处理' : '待处理'}
                      </span>
                    )}
                  </div>
                  <strong>{n.title}</strong>
                  <p>{notificationPreview(n.body)}</p>
                  <time>{formatDate(n.created_at, user.timezone)}</time>
                </div>
                {!n.read_at && <i className="unread-dot" />}
                <ChevronRight size={15} />
              </button>
            ))
          : !r.loading &&
            !r.error && (
              <Empty
                title={filter === 'all' ? '暂时没有通知' : `暂时没有${notificationLabels[filter]}`}
                description="提醒到时、后台有新结果，或任务需要你处理时，会出现在这里。"
                icon={<Bell size={30} strokeWidth={1.3} />}
              />
            )}
      </div>
      <p className="footnote">站内通知会持续保存；当前未配置邮件、短信或浏览器系统推送。</p>
    </div>
  );
}
export function BillingView() {
  const { boot, user, action, caps } = useNota();
  const u = boot.usage;
  const [confirm, setConfirm] = useState(false);
  return (
    <div className="page-container billing-page">
      <PageHeading
        eyebrow="MORE ROOM FOR YOUR THOUGHTS"
        title="给想法，多一点余地。"
        description="免费开始；需要更多时，再升级。"
      />
      <section className="usage-panel panel">
        <div>
          <span className="eyebrow">YOUR PLAN</span>
          <h2>{u.pro ? 'Nota Pro' : 'Nota Free'}</h2>
          <p>
            {u.pro
              ? `当前周期至 ${formatDate(u.subscription?.period_end, user.timezone, { hour: undefined, minute: undefined })}`
              : '每天 10 次新的 AI 处理，北京时间 00:00 重置。'}
          </p>
        </div>
        <div className="usage-meter">
          <span>
            <strong>{u.used}</strong>
            {u.pro ? '次已处理' : ` / ${u.limit} 次`}
          </span>
          <div className="quota-track">
            <i
              style={{
                width: `${u.pro ? 100 : Math.min(100, ((u.used + u.reserved) / u.limit) * 100)}%`,
              }}
            />
          </div>
          <small>
            {u.reserved} 次处理中{!u.pro && ` · 还可发起 ${u.remaining} 次`}
          </small>
        </div>
      </section>
      {caps.billingMode === 'demo' && (
        <div className="demo-billing-note">
          <Leaf size={19} />
          <div>
            <strong>当前为演示订阅，不会产生任何扣款。</strong>
            <p>用于验证套餐权益、额度与到期行为。真实收款需后续配置支付商户。</p>
          </div>
        </div>
      )}
      <div className="plan-grid">
        <article className="plan-card panel">
          <span className="eyebrow">KEEP THE IMPORTANT THINGS</span>
          <h2>Free</h2>
          <p>让每一天，都有个清楚的开始。</p>
          <div className="plan-price">
            $0<small> / 一直免费</small>
          </div>
          <ul>
            <li>
              <Check size={16} />
              每天 10 次 AI 处理
            </li>
            <li>
              <Check size={16} />
              录音转写与整理
            </li>
            <li>
              <Check size={16} />
              日程、待办与站内提醒
            </li>
            <li>
              <Check size={16} />
              人物关系、来源检索与完整历史
            </li>
          </ul>
          <Button
            variant="secondary"
            disabled={!u.pro || u.subscription?.cancel_at_period_end}
            onClick={() => setConfirm(true)}
          >
            {u.pro
              ? u.subscription?.cancel_at_period_end
                ? '已安排到期恢复 Free'
                : '到期恢复 Free'
              : '当前计划'}
          </Button>
        </article>
        <article className="plan-card pro panel">
          <div className="plan-top">
            <span className="eyebrow">A LITTLE MORE SPACE</span>
            <span className="tiny-tag">
              <Crown size={12} /> PRO
            </span>
          </div>
          <h2>Pro</h2>
          <p>想说就说，让 Nota 多做一点。</p>
          <div className="plan-price">
            $6.99<small> / 月</small>
          </div>
          <ul>
            <li>
              <Check size={16} />
              不限每天 AI 处理次数
            </li>
            <li>
              <Check size={16} />
              包含 Free 所有功能
            </li>
            <li>
              <Check size={16} />
              仍适用单条时长与文件大小限制
            </li>
            <li>
              <Check size={16} />
              可取消续订，权益保留至周期结束
            </li>
          </ul>
          <Button
            disabled={u.pro || caps.billingMode !== 'demo'}
            onClick={() =>
              void action(() => post('/billing/demo-upgrade'), '演示 Pro 已开通，未收取费用')
            }
          >
            {u.pro
              ? '当前计划'
              : caps.billingMode === 'demo'
                ? '体验 Pro（演示）'
                : '支付服务待配置'}
            {!u.pro && <ArrowUpRight size={16} />}
          </Button>
        </article>
      </div>
      <section className="quota-explainer">
        <h3>一次 AI 处理，怎么算？</h3>
        <div>
          <p>
            <strong>一段录音或一次新的交办，算一次。</strong>
            其中的转写、摘要、人物提取和多个工具调用合计算一次；澄清补答、内部重试不会重复计数。
          </p>
          <p>
            <strong>浏览与手动管理不扣次数。</strong>
            查阅原文、手动编辑日程、完成待办、到点提醒均不占用 AI
            额度。新的历史追问、自动任务激活分别算一次。
          </p>
          <p>
            <strong>失败会返还预占额度。</strong>
            处理中先预占，成功后结算；最终失败会释放。重试请求通过幂等 ID 去重。
          </p>
        </div>
      </section>
      {u.pro && (
        <div className="cancel-subscription">
          <span>
            {u.subscription?.cancel_at_period_end
              ? '已取消续订，本周期到期后恢复 Free。'
              : '可随时取消下一周期续订。'}
          </span>
          <button
            disabled={u.subscription?.cancel_at_period_end}
            className="text-button"
            onClick={() => setConfirm(true)}
          >
            取消续订
          </button>
        </div>
      )}
      {confirm && (
        <Confirm
          title="取消 Pro 续订？"
          body="当前周期权益会保留到期，到期后恢复 Free。演示订阅不会扣款。"
          onClose={() => setConfirm(false)}
          onConfirm={() => action(() => post('/billing/cancel'), '已取消续订')}
        />
      )}
    </div>
  );
}
export function CreateModal({
  kind,
  initial,
  onClose,
}: {
  kind: string;
  initial?: any;
  onClose: () => void;
}) {
  return kind === 'schedule' ? (
    <ScheduleModal initial={initial} onClose={onClose} />
  ) : (
    <AgendaEditor
      key={`${kind}-${initial?.id ?? 'new'}`}
      kind={kind}
      initial={initial}
      onClose={onClose}
    />
  );
}
function ScheduleModal({ initial, onClose }: { initial?: any; onClose: () => void }) {
  const { user, action } = useNota();
  const [busy, setBusy] = useState(false);
  const [recurring, setRecurring] = useState(!!initial?.cron);
  return (
    <Modal title="设置自动任务" onClose={onClose}>
      <form
        className="modal-form"
        onSubmit={async (e) => {
          e.preventDefault();
          const values = Object.fromEntries(new FormData(e.currentTarget));
          setBusy(true);
          const result = await action(
            () =>
              post('/schedules', {
                title: String(values.title),
                prompt: String(values.prompt),
                timezone: user.timezone,
                notification_policy: String(values.notification_policy),
                ...(recurring
                  ? { cron: String(values.cron) }
                  : { run_at: zonedISO(String(values.run_at), user.timezone) }),
              }),
            '已保存',
          );
          setBusy(false);
          if (result) onClose();
        }}
      >
        <Field label="标题">
          <input name="title" required maxLength={200} defaultValue={initial?.title ?? ''} />
        </Field>
        <Field label="到时交给 Nota 的任务">
          <textarea
            name="prompt"
            rows={3}
            required
            maxLength={3000}
            placeholder="例如：查看今天的日程和未完成待办，给我一份简短安排。"
            defaultValue={initial?.prompt ?? ''}
          />
        </Field>
        <Field label="结果通知" hint="无法确认是否有变化，或任务需要你处理时，仍会告知。">
          <select
            name="notification_policy"
            defaultValue={initial?.notification_policy ?? 'always'}
          >
            <option value="always">每次执行后交付结果</option>
            <option value="on_change">有新变化时通知我</option>
          </select>
        </Field>
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={recurring}
            onChange={(e) => setRecurring(e.target.checked)}
          />
          <span>周期执行</span>
        </label>
        {recurring ? (
          <Field label="Cron（5 位）" hint="例如 0 9 * * 1-5：工作日早 9 点；最短间隔 10 分钟。">
            <input name="cron" required defaultValue={initial?.cron ?? '0 9 * * 1-5'} />
          </Field>
        ) : (
          <Field label={`触发时间（${user.timezone}）`}>
            <input
              type="datetime-local"
              name="run_at"
              required
              defaultValue={localInput(new Date(Date.now() + 3600000), user.timezone)}
            />
          </Field>
        )}
        <div className="inline-note">
          <Clock3 size={16} />
          每次触发属于一次新的 AI 处理；结果回到同一个对话。
        </div>
        <footer className="modal-actions">
          <Button type="button" variant="secondary" onClick={onClose}>
            返回
          </Button>
          <Button type="submit" busy={busy}>
            保存
          </Button>
        </footer>
      </form>
    </Modal>
  );
}
