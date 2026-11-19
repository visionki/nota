import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { SourcePreview } from './RecordingWindows';
import { emptyReadState, useConversationRead } from './useConversationRead';
import { useReadingPosition } from './useReadingPosition';
import {
  MessageSquare,
  AudioLines,
  CalendarDays,
  UsersRound,
  Activity,
  Bell,
  Settings,
  Mic,
  Menu,
  X,
  ArrowUp,
  Plus,
  Upload,
  Search,
  ArrowLeft,
  ChevronDown,
  Check,
  LoaderCircle,
  LogOut,
  Crown,
  WifiOff,
  Leaf,
  ChevronRight,
  CheckCircle2,
  Clock3,
  Square,
  BookOpen,
} from 'lucide-react';
import { api, post, ApiError, formatDate } from './api';
import {
  Context,
  Button,
  IconButton,
  Markdown,
  Status,
  Empty,
  Modal,
  type View,
  useNota,
} from './ui';
import {
  RecordingsView,
  AgendaView,
  MemoryView,
  NotificationsView,
  BillingView,
  CreateModal,
  RecordingDetail,
} from './Views';
import { SettingsView } from './Settings';
import { Recorder, useUploadQueue } from './Recorder';
import { ExecutionProcess } from './ExecutionProcess';
import { BackgroundTasksView } from './BackgroundTasksView';
import { ChatRetry } from './ChatRetry';
import { operationCycle } from '../shared/execution.js';
const nav: { id: View; label: string; icon: React.ElementType }[] = [
  { id: 'chat', label: '与 Nota 对话', icon: MessageSquare },
  { id: 'recordings', label: '语音便签', icon: AudioLines },
  { id: 'agenda', label: '日程与待办', icon: CalendarDays },
  { id: 'memory', label: '人物与记忆', icon: UsersRound },
  { id: 'tasks', label: '后台任务', icon: Activity },
  { id: 'notifications', label: '通知', icon: Bell },
];
const initialBoot = {
  recording_batches: [],
  messages: [],
  operations: [],
  notifications: [],
  counts: { recordings: 0, todos: 0, people: 0, unread: 0 },
  usage: { used: 0, reserved: 0, limit: 10, remaining: 10, pro: false },
  context: { contextWindow: 1048576, compactAt: 891289 },
  cursor: '0',
  read_state: emptyReadState,
  has_older_messages: false,
};
function viewFromLocation(): View {
  const hash = location.hash.slice(1).split('/')[0];
  if (hash === 'activity') return 'tasks';
  return [...nav.map((n) => n.id), 'billing', 'settings'].includes(hash) ? (hash as View) : 'chat';
}
function Login({ onLogin }: { onLogin: (user: any) => void }) {
  const [register, setRegister] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  return (
    <div className="login-page">
      <aside className="login-story">
        <a className="wordmark" href="/">
          nota<span>●</span>
        </a>
        <span className="eyebrow">YOUR WORDS, IN GOOD HANDS</span>
        <h1>
          说过的话，
          <br />
          都有下文。
        </h1>
        <p>
          把零散的想法、重要的约定，
          <br />
          留在一个记得，也会行动的地方。
        </p>
        <div className="notebook-art" aria-hidden="true">
          <div className="notebook-binding" />
          <span className="notebook-date">A LITTLE NOTE, A NEXT STEP.</span>
          <i />
          <i />
          <i />
          <div className="notebook-check">
            <Check size={18} /> 把记忆，变成行动。
          </div>
          <div className="notebook-leaf">
            <Leaf size={64} strokeWidth={0.8} />
          </div>
        </div>
        <footer>一个自己的语音笔记本。一个持续陪伴的 Nota。</footer>
      </aside>
      <main className="login-main">
        <div className="login-box">
          <span className="eyebrow">WELCOME TO NOTA</span>
          <h2>{register ? '开始你的第一篇笔记' : '留一点空间，给重要的事'}</h2>
          <p>
            {register ? '创建账号，拥有独立的笔记、记忆和日程。' : '登录后，从上次的话题继续。'}
          </p>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              setError('');
              const data = new FormData(e.currentTarget);
              try {
                const r = await post(
                  `/auth/${register ? 'register' : 'login'}`,
                  Object.fromEntries(data),
                );
                onLogin(r.user);
              } catch (e: any) {
                setError(e.message);
              } finally {
                setBusy(false);
              }
            }}
          >
            {register && (
              <label className="field">
                <span>怎么称呼你</span>
                <input
                  name="name"
                  required
                  maxLength={60}
                  autoComplete="nickname"
                  placeholder="你的名字"
                />
              </label>
            )}
            <label className="field">
              <span>邮箱</span>
              <input
                name="email"
                type="email"
                required
                autoComplete="email"
                placeholder="you@example.com"
              />
            </label>
            <label className="field">
              <span>密码</span>
              <input
                name="password"
                type="password"
                minLength={8}
                maxLength={128}
                required
                autoComplete={register ? 'new-password' : 'current-password'}
                placeholder="至少 8 位字符"
              />
            </label>
            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}
            <Button type="submit" busy={busy} className="full-width">
              {register ? '创建账号' : '登录 Nota'}
              <ChevronRight size={16} />
            </Button>
          </form>
          <button
            className="text-button login-switch"
            onClick={() => {
              setRegister(!register);
              setError('');
            }}
          >
            {register ? '已有账号？登录' : '第一次来？创建账号'}
          </button>
          <div className="login-note">
            <CheckCircle2 size={15} /> 每日 10 次免费 AI 处理 · 无需绑定支付方式
          </div>
        </div>
      </main>
    </div>
  );
}
export default function App() {
  const [user, setUser] = useState<any>(null),
    [boot, setBoot] = useState<any>(null),
    [caps, setCaps] = useState<any>({}),
    [loading, setLoading] = useState(true),
    [view, setView] = useState<View>(viewFromLocation),
    [navigationTarget, setNavigationTarget] = useState<string | null>(
      location.hash.split('/')[1] ?? null,
    ),
    [menu, setMenu] = useState(false),
    [online, setOnline] = useState(navigator.onLine),
    [offlineIdentity, setOfflineIdentity] = useState(false),
    [connected, setConnected] = useState(false),
    [revision, setRevision] = useState(0),
    [toastMessage, setToastMessage] = useState<{ text: string; error: boolean } | null>(null),
    [recording, setRecording] = useState(false),
    [sourceId, setSourceId] = useState<string | null>(
      location.pathname.match(/^\/sources\/([^/]+)/)?.[1] ?? null,
    ),
    [detailReference, setDetailReference] = useState(location.search),
    [detailId, setDetailId] = useState<string | null>(
      location.pathname.match(/^\/recordings\/([^/]+)/)?.[1] ?? null,
    ),
    [create, setCreate] = useState<{ kind: string; initial?: any } | null>(null);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined),
    toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined),
    currentUser = useRef<any>(null),
    sessionEpoch = useRef(0);
  currentUser.current = user;
  const toast = useCallback((text: string, error = false) => {
    setToastMessage({ text, error });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToastMessage(null), error ? 8000 : 4500);
  }, []);
  const refresh = useCallback(async () => {
    const expected = currentUser.current?.id;
    if (!expected) return;
    const r = await api('/bootstrap');
    if (currentUser.current?.id !== expected || r.user.id !== expected) return;
    setUser(r.user);
    setBoot((old: any) => {
      if (old?.user?.id === r.user.id && BigInt(old.cursor ?? '0') > BigInt(r.cursor ?? '0'))
        return old;
      const merged =
        old?.user?.id === r.user.id
          ? [...new Map([...old.messages, ...r.messages].map((m: any) => [m.id, m])).values()].sort(
              (a: any, b: any) => Number(a.seq) - Number(b.seq),
            )
          : r.messages;
      return { ...r, messages: merged };
    });
    setRevision((n) => n + 1);
  }, []);
  const startSession = useCallback(async () => {
    const epoch = ++sessionEpoch.current;
    try {
      const r = await api('/me');
      if (epoch !== sessionEpoch.current) return;
      setUser(r.user);
      currentUser.current = r.user;
      setCaps(r.capabilities);
      setOfflineIdentity(false);
      localStorage.setItem('nota:last-user', JSON.stringify(r.user));
      await refresh();
    } catch (e) {
      if (epoch !== sessionEpoch.current) return;
      if (e instanceof ApiError && e.status === 0) {
        const raw = localStorage.getItem('nota:last-user');
        if (raw) {
          try {
            const cached = JSON.parse(raw);
            setUser(cached);
            currentUser.current = cached;
            setOfflineIdentity(true);
            setBoot({ ...initialBoot, user: cached });
          } catch {}
        }
      } else {
        currentUser.current = null;
        setUser(null);
        setBoot(null);
      }
    } finally {
      if (epoch === sessionEpoch.current) setLoading(false);
    }
  }, [refresh]);
  useEffect(() => {
    void startSession();
    const off = () => setOnline(false);
    const on = () => {
      setOnline(true);
      void startSession();
    };
    const auth = () => {
      sessionEpoch.current++;
      currentUser.current = null;
      setUser(null);
      setLoading(false);
      setBoot(null);
      setConnected(false);
    };
    const route = () => {
      if (location.hash === '#activity' || location.hash.startsWith('#activity/'))
        history.replaceState(
          null,
          '',
          `${location.pathname}${location.search}#tasks${location.hash.slice('#activity'.length)}`,
        );
      setDetailReference(location.search);
      setSourceId(location.pathname.match(/^\/sources\/([^/]+)/)?.[1] ?? null);
      setView(viewFromLocation());
      setNavigationTarget(location.hash.split('/')[1] ?? null);
      setDetailId(location.pathname.match(/^\/recordings\/([^/]+)/)?.[1] ?? null);
    };
    route();
    window.addEventListener('offline', off);
    window.addEventListener('online', on);
    window.addEventListener('nota:unauthorized', auth);
    window.addEventListener('popstate', route);
    window.addEventListener('hashchange', route);
    return () => {
      window.removeEventListener('offline', off);
      window.removeEventListener('online', on);
      window.removeEventListener('nota:unauthorized', auth);
      window.removeEventListener('popstate', route);
      window.removeEventListener('hashchange', route);
    };
  }, [startSession]);
  const hasBoot = !!boot;
  useEffect(() => {
    if (!user || !hasBoot || offlineIdentity || !online) return;
    const uid = user.id;
    const source = new EventSource(`/api/events?after=${boot.cursor ?? '0'}`);
    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);
    source.addEventListener('update', (event) => {
      const e = JSON.parse((event as MessageEvent).data);
      if (currentUser.current?.id !== uid) return;
      setBoot((old: any) => {
        if (!old || BigInt(e.id) <= BigInt(old.cursor ?? '0')) return old;
        if (e.type === 'history_reset')
          return {
            ...old,
            messages: [],
            operations: [],
            notifications: [],
            pending_inputs: [],
            recording_batches: [],
            read_state: emptyReadState,
            has_older_messages: false,
            counts: { recordings: 0, todos: 0, people: 0, unread: 0 },
            context: { ...old.context, context_tokens: 0, compactions: 0 },
            cursor: e.id,
          };
        let operations = old.operations,
          messages = old.messages,
          pendingInputs = old.pending_inputs ?? [],
          readState = old.read_state ?? emptyReadState;
        if (
          e.type === 'chat_read' &&
          BigInt(e.data.last_read_seq) >= BigInt(readState.last_read_seq)
        )
          readState = e.data;
        // File and research lifecycle events stay outside the conversational actor.
        if (
          e.operation_id &&
          (operations.some((o: any) => o.id === e.operation_id) ||
            (e.type === 'operation' && e.data.executor === 'agent'))
        ) {
          operations = [...operations];
          let at = operations.findIndex((o: any) => o.id === e.operation_id);
          if (at < 0) {
            operations.unshift({
              id: e.operation_id,
              status: 'queued',
              created_at: e.created_at,
              reply: '',
            });
            at = 0;
          }
          let o = { ...operations[at] };
          if (e.type === 'operation') o = { ...o, ...e.data };
          if (['operation', 'input'].includes(e.type) && e.data.message) {
            const m = e.data.message;
            if (
              m.role === 'assistant' &&
              !messages.some((old: any) => old.id === m.id) &&
              BigInt(m.seq) > BigInt(readState.last_read_seq)
            ) {
              readState = {
                ...readState,
                unread_count: readState.unread_count + 1,
                first_unread_id: readState.first_unread_id ?? m.id,
                first_unread_seq: readState.first_unread_seq ?? m.seq,
                latest_message_id: m.id,
              };
            }
            messages = [
              ...new Map(
                [...messages, e.data.message].map((message: any) => [message.id, message]),
              ).values(),
            ].sort((a: any, b: any) => Number(a.seq) - Number(b.seq));
          }
          if (e.type === 'input') {
            if (e.data.status === 'pending')
              pendingInputs = [...pendingInputs, { ...e.data, operation_id: e.operation_id }];
            if (e.data.status === 'applied')
              pendingInputs = pendingInputs.filter((input: any) => !e.data.ids.includes(input.id));
            if (e.data.input_version !== undefined) o.input_version = e.data.input_version;
          }
          if (e.type === 'text_reset') o.reply = '';
          if (e.type === 'text') o.reply = (o.reply ?? '') + e.data.delta;
          if (e.type === 'activity') o.activity = e.data;
          operations[at] = o;
        }
        return {
          ...old,
          operations,
          messages,
          read_state: readState,
          pending_inputs: pendingInputs,
          cursor: e.id,
        };
      });
      window.dispatchEvent(new CustomEvent('nota:trace', { detail: e }));
      if (e.type === 'history_reset') window.dispatchEvent(new Event('nota:history-reset'));
      if (!['text', 'text_reset', 'text_end', 'activity'].includes(e.type)) {
        if (refreshTimer.current) clearTimeout(refreshTimer.current);
        refreshTimer.current = setTimeout(() => void refresh().catch(() => {}), 350);
      }
    });
    const poll = setInterval(() => void refresh().catch(() => {}), 20000);
    return () => {
      source.close();
      clearInterval(poll);
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      setConnected(false);
    };
  }, [user?.id, hasBoot, offlineIdentity, online]);
  const action = useCallback(
    async (fn: () => Promise<any>, success?: string) => {
      try {
        const r = await fn();
        if (success) toast(success);
        await refresh();
        return r;
      } catch (e: any) {
        toast(e.message ?? '操作没有完成', true);
        return undefined;
      }
    },
    [refresh, toast],
  );
  const navigate = (v: View, target?: string) => {
    setView(v);
    setNavigationTarget(target ?? null);
    setMenu(false);
    setDetailId(null);
    history.pushState(null, '', `/#${v}${target ? `/${target}` : ''}`);
  };
  const openRecording = (id: string) => {
    const [recordingId, query = ''] = id.split('?');
    setDetailId(recordingId);
    setDetailReference(query ? `?${query}` : '');
    setView('recordings');
    setMenu(false);
    history.pushState(null, '', `/recordings/${id}`);
  };
  const uploads = useUploadQueue(user, online && !offlineIdentity, toast, refresh);
  const context = {
    user,
    boot: boot ?? initialBoot,
    caps,
    online: online && !offlineIdentity,
    revision,
    view,
    navigationTarget,
    refresh,
    action,
    toast,
    navigate,
    openRecording,
    openSource: setSourceId,
    openCreate: (kind: string, initial?: any) => setCreate({ kind, initial }),
    record: () => setRecording(true),
  };
  if (loading)
    return (
      <div className="app-loading">
        <span className="wordmark">
          nota<span>●</span>
        </span>
        <LoaderCircle className="spin" size={22} />
        <p>打开你的笔记本</p>
      </div>
    );
  if (!user)
    return (
      <Login
        onLogin={(u) => {
          setUser(u);
          currentUser.current = u;
          void startSession();
        }}
      />
    );
  const today = new Date().toLocaleDateString('zh-CN', {
    timeZone: user.timezone,
    month: 'long',
    day: 'numeric',
    weekday: 'long',
  });
  return (
    <Context.Provider value={context}>
      <div className="app-shell">
        {menu && <div className="nav-scrim" onClick={() => setMenu(false)} />}
        <aside className={`sidebar ${menu ? 'is-open' : ''}`}>
          <div className="sidebar-top">
            <a
              href="/#chat"
              className="wordmark"
              onClick={(e) => {
                e.preventDefault();
                navigate('chat');
              }}
            >
              nota<span>●</span>
            </a>
            <IconButton label="关闭菜单" className="mobile-only" onClick={() => setMenu(false)}>
              <X size={20} />
            </IconButton>
          </div>
          <Button
            onClick={() => {
              setMenu(false);
              setRecording(true);
            }}
            className="record-primary"
          >
            <Mic size={17} /> 记一段声音 <span>＋</span>
          </Button>
          <nav className="main-nav" aria-label="主导航">
            {nav.map((n) => (
              <button
                key={n.id}
                className={view === n.id ? 'active' : ''}
                onClick={() => navigate(n.id)}
              >
                <n.icon size={19} strokeWidth={1.65} />
                <span>{n.label}</span>
                {n.id === 'chat' && context.boot.read_state?.unread_count > 0 && (
                  <b className="count" aria-label="未读对话">
                    {context.boot.read_state.unread_count}
                  </b>
                )}
                {n.id === 'notifications' && context.boot.counts.unread > 0 && (
                  <b className="count">{context.boot.counts.unread}</b>
                )}
                {n.id === 'recordings' && context.boot.counts.recordings > 0 && (
                  <span className="nav-count">{context.boot.counts.recordings}</span>
                )}
              </button>
            ))}
          </nav>
          <div className="sidebar-bottom">
            <button className="quota-widget" onClick={() => navigate('billing')}>
              <span>
                <Leaf size={15} />
                {context.boot.usage.pro ? 'Nota Pro' : '今日免费额度'}
                <ChevronRight size={14} />
              </span>
              <div className="quota-track">
                <i
                  style={{
                    width: `${context.boot.usage.pro ? 100 : Math.min(100, ((context.boot.usage.used + context.boot.usage.reserved) / context.boot.usage.limit) * 100)}%`,
                  }}
                />
              </div>
              <small>
                {context.boot.usage.pro
                  ? '不限 AI 处理次数'
                  : `${context.boot.usage.used} 已用 · ${context.boot.usage.reserved} 处理中 / ${context.boot.usage.limit} 次`}
              </small>
            </button>
            <button className="profile-button" onClick={() => navigate('settings')}>
              <span className="avatar">{user.name.slice(0, 1)}</span>
              <span>
                <strong>{user.name}</strong>
                <small>{context.boot.usage.pro ? 'Pro 计划' : '个人空间'}</small>
              </span>
              <Settings size={17} />
            </button>
          </div>
        </aside>
        <div className="main-shell">
          <header className="topbar">
            <div className="topbar-left">
              <IconButton label="打开菜单" className="mobile-only" onClick={() => setMenu(true)}>
                <Menu size={21} />
              </IconButton>
              <span className="breadcrumb">
                我的空间 <ChevronRight size={13} />{' '}
                <strong>
                  {detailId
                    ? '录音详情'
                    : (nav.find((n) => n.id === view)?.label ??
                      (view === 'billing' ? '订阅与额度' : '设置'))}
                </strong>
              </span>
            </div>
            <div className="topbar-right">
              <span className={`connection ${connected ? 'online' : ''}`}>
                <i />
                {!online || offlineIdentity ? '离线' : connected ? '实时同步' : '正在重连'}
              </span>
              <IconButton label="通知" onClick={() => navigate('notifications')}>
                <Bell size={18} />
                {context.boot.counts.unread > 0 && <i className="notification-dot" />}
              </IconButton>
              <button
                className="avatar small"
                onClick={() => navigate('settings')}
                aria-label="账户设置"
              >
                {user.name.slice(0, 1)}
              </button>
            </div>
          </header>
          {(!online || offlineIdentity) && (
            <div className="offline-banner">
              <WifiOff size={16} /> 当前离线。你仍可录音，内容保存在本机，联网并登录后上传。
            </div>
          )}
          {view !== 'chat' && uploads.items.length > 0 && (
            <div className="upload-queue">
              <div>
                <Upload size={16} />
                <strong>{uploads.items.length} 段录音等待上传</strong>
                <span>
                  {uploads.uploading
                    ? '正在上传…'
                    : (uploads.items[0]?.error ?? '已安全保存在当前浏览器')}
                </span>
              </div>
              <Button
                variant="ghost"
                busy={uploads.uploading}
                onClick={() => void uploads.sync(true)}
              >
                重试上传
              </Button>
              <IconButton label="查看待上传录音" onClick={() => navigate('recordings')}>
                <ChevronRight size={16} />
              </IconButton>
            </div>
          )}
          <main className={`main-content view-${view}`}>
            {view === 'chat' && <Chat key={user.id} today={today} />}
            {view === 'recordings' &&
              (detailId ? (
                <RecordingDetail
                  key={`${detailId}:${detailReference}`}
                  id={detailId}
                  reference={detailReference}
                  onBack={() => navigate('recordings')}
                />
              ) : (
                <RecordingsView
                  localItems={uploads.items}
                  discard={uploads.discard}
                  retry={() => uploads.sync(true)}
                  onUpload={uploads.addFile}
                />
              ))}
            {view === 'agenda' && <AgendaView />}
            {view === 'memory' && <MemoryView />}
            {view === 'tasks' && <BackgroundTasksView />}
            {view === 'notifications' && <NotificationsView />}
            {view === 'billing' && <BillingView />}
            {view === 'settings' && <SettingsView />}
          </main>
        </div>
        <nav className="mobile-nav" aria-label="手机导航">
          {[
            { id: 'chat', label: 'Nota', icon: MessageSquare },
            { id: 'recordings', label: '录音', icon: AudioLines },
            { id: 'agenda', label: '日程', icon: CalendarDays },
            { id: 'settings', label: '我的', icon: UsersRound },
          ].map((n) => (
            <button
              key={n.id}
              className={view === n.id ? 'active' : ''}
              onClick={() => navigate(n.id as View)}
            >
              <n.icon size={21} strokeWidth={1.7} />
              <span>{n.label}</span>
            </button>
          ))}
        </nav>
        {recording && (
          <Recorder
            onClose={() => setRecording(false)}
            onSave={async (item) => {
              await uploads.add(item);
              setRecording(false);
              navigate('chat');
            }}
          />
        )}
        {sourceId && <SourcePreview id={sourceId} onClose={() => setSourceId(null)} />}
        {create && (
          <CreateModal
            kind={create.kind}
            initial={create.initial}
            onClose={() => setCreate(null)}
          />
        )}
        {toastMessage && (
          <div
            className={`toast ${toastMessage.error ? 'error' : ''}`}
            role={toastMessage.error ? 'alert' : 'status'}
          >
            {toastMessage.error ? <WifiOff size={17} /> : <CheckCircle2 size={17} />}
            <span>{toastMessage.text}</span>
            <IconButton label="关闭提示" onClick={() => setToastMessage(null)}>
              <X size={15} />
            </IconButton>
          </div>
        )}
      </div>
    </Context.Provider>
  );
}
function Chat({ today }: { today: string }) {
  const { boot, user, action, toast, refresh, record, navigate, openRecording, navigationTarget } =
    useNota();
  const [text, setText] = useState(''),
    [replyTo, setReplyTo] = useState<string | null>(() =>
      sessionStorage.getItem(`nota:reply:${user.id}`),
    ),
    [sending, setSending] = useState(false),
    [older, setOlder] = useState<any[]>([]),
    [more, setMore] = useState(Boolean(boot.has_older_messages)),
    [historyPage, setHistoryPage] = useState<any>(null),
    [jumping, setJumping] = useState(Boolean(navigationTarget)),
    [loadingOlder, setLoadingOlder] = useState(false);
  const scroll = useRef<HTMLDivElement>(null),
    pendingSubmission = useRef<any>(null),
    flow = useRef<HTMLDivElement>(null),
    textarea = useRef<HTMLTextAreaElement>(null),
    stick = useRef(!navigationTarget),
    historyRequest = useRef<AbortController | null>(null);
  const resizeComposer = useCallback(() => {
    const input = textarea.current;
    if (!input) return;
    input.style.height = 'auto';
    input.style.height = `${input.scrollHeight}px`;
    input.style.overflowY = input.scrollHeight > input.clientHeight ? 'auto' : 'hidden';
    if (stick.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  }, []);
  useLayoutEffect(resizeComposer, [text, resizeComposer]);
  useEffect(() => {
    const input = textarea.current;
    if (!input) return;
    let width = input.clientWidth,
      alive = true;
    const observer = new ResizeObserver(() => {
      if (input.clientWidth !== width) {
        width = input.clientWidth;
        resizeComposer();
      }
    });
    observer.observe(input);
    void document.fonts.ready.then(() => {
      if (alive) resizeComposer();
    });
    return () => {
      alive = false;
      observer.disconnect();
    };
  }, [resizeComposer]);
  const readingPosition = useReadingPosition(scroll, flow, stick);
  const cancelHistoryLoad = useCallback(() => {
    historyRequest.current?.abort();
    historyRequest.current = null;
    setLoadingOlder(false);
    readingPosition.release();
  }, [readingPosition.release]);
  useEffect(
    () => () => {
      historyRequest.current?.abort();
    },
    [],
  );
  const active = boot.operations.filter(
    (o: any) =>
      (o.executor ?? 'agent') === 'agent' && ['queued', 'running', 'waiting'].includes(o.status),
  );
  const foreground =
    active.find((o: any) => o.status === 'running') ??
    active
      .filter((o: any) => o.status === 'queued')
      .sort((a: any, b: any) => +new Date(a.created_at) - +new Date(b.created_at))[0];
  const latest = boot.operations
    .filter(
      (o: any) =>
        ['chat', 'recording'].includes(o.kind) ||
        ['recording_window', 'background_followup'].includes(o.input?.source) ||
        (o.input?.source === 'background_result' && o.status === 'waiting'),
    )
    .sort(
      (a: any, b: any) =>
        +new Date(b.updated_at ?? b.created_at) - +new Date(a.updated_at ?? a.created_at),
    )[0];
  const waiting =
    active.find((o: any) => o.status === 'waiting' && o.id === replyTo) ??
    (!foreground && latest?.status === 'waiting' ? latest : undefined);
  const queued = active
    .filter((o: any) => o.status === 'queued' && o.kind === 'chat' && o.id !== foreground?.id)
    .sort((a: any, b: any) => +new Date(a.created_at) - +new Date(b.created_at));
  const pendingInputs = (boot.pending_inputs ?? []).filter(
    (input: any) => input.operation_id === foreground?.id,
  );
  useEffect(() => {
    sessionStorage.removeItem(`nota:reply:${user.id}`);
    localStorage.removeItem(`nota:send-mode:${user.id}`);
    const reset = () => {
      cancelHistoryLoad();
      setOlder([]);
      setMore(false);
      setHistoryPage(null);
      setReplyTo(null);
      setText('');
      pendingSubmission.current = null;
    };
    window.addEventListener('nota:history-reset', reset);
    return () => window.removeEventListener('nota:history-reset', reset);
  }, [user.id, cancelHistoryLoad]);
  useEffect(() => {
    const retried = () => {
      cancelHistoryLoad();
      setOlder([]);
      setHistoryPage(null);
      setJumping(false);
      stick.current = true;
      navigate('chat');
      requestAnimationFrame(() => {
        if (scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
      });
    };
    window.addEventListener('nota:chat-retry', retried);
    return () => window.removeEventListener('nota:chat-retry', retried);
  }, [user.id, cancelHistoryLoad]);
  const messages = [
    ...new Map(
      [...older, ...(historyPage?.messages ?? boot.messages)].map((m: any) => [m.id, m]),
    ).values(),
  ].sort((a: any, b: any) => Number(a.seq) - Number(b.seq));
  const read = useConversationRead(
    boot.read_state,
    messages,
    scroll,
    Boolean(boot.user) && !jumping,
  );
  const started = messages.length > 0 || active.length > 0;
  useEffect(() => {
    if (!older.length && !historyPage) setMore(Boolean(boot.has_older_messages));
  }, [boot.has_older_messages, older.length, historyPage]);
  const jumpUnread = async () => {
    const id = read.state.first_unread_id;
    if (!id || jumping) return;
    cancelHistoryLoad();
    setJumping(true);
    stick.current = false;
    try {
      if (!messages.some((m: any) => m.id === id)) {
        const result = await api(`/messages?around=${id}&limit=50`);
        setOlder([]);
        setHistoryPage(result);
        setMore(result.has_before);
      }
      await new Promise<void>((done) =>
        requestAnimationFrame(() => requestAnimationFrame(() => done())),
      );
      const message = scroll.current?.querySelector<HTMLElement>(`[data-message-id="${id}"]`);
      const boundary = message?.previousElementSibling?.classList.contains('unread-divider')
        ? message.previousElementSibling
        : message;
      boundary?.scrollIntoView({ block: 'start', behavior: 'instant' });
      await read.markRead(true);
    } catch (e: any) {
      toast(e.message, true);
    } finally {
      setJumping(false);
    }
  };
  useEffect(() => {
    if (!navigationTarget) return;
    const controller = new AbortController();
    let alive = true;
    cancelHistoryLoad();
    stick.current = false;
    setJumping(true);
    void (async () => {
      try {
        const result = await api(
          `/messages?around=${encodeURIComponent(navigationTarget)}&limit=50`,
          { signal: controller.signal },
        );
        if (!alive) return;
        setOlder([]);
        setHistoryPage(result);
        setMore(result.has_before);
        await new Promise<void>((done) =>
          requestAnimationFrame(() => requestAnimationFrame(() => done())),
        );
        if (!alive) return;
        scroll.current
          ?.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(navigationTarget)}"]`)
          ?.scrollIntoView({ block: 'center', behavior: 'instant' });
      } catch (e: any) {
        if (alive) toast(e.message, true);
      } finally {
        if (alive) setJumping(false);
      }
    })();
    return () => {
      alive = false;
      controller.abort();
    };
  }, [navigationTarget, cancelHistoryLoad]);
  useEffect(() => {
    if (stick.current && !historyPage)
      scroll.current?.scrollTo({ top: scroll.current.scrollHeight, behavior: 'auto' });
  }, [
    boot.messages.length,
    boot.operations.map((o: any) => `${o.status}:${o.reply?.length ?? 0}`).join(','),
  ]);
  useEffect(() => {
    if (!flow.current) return;
    const observer = new ResizeObserver(() => {
      if (stick.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
    });
    observer.observe(flow.current);
    return () => observer.disconnect();
  }, []);
  const submit = async (value = text) => {
    if (!value.trim() || sending) return;
    setSending(true);
    const input = value.trim();
    try {
      const mode = 'steer' as const;
      const targetId =
        replyTo ??
        (foreground?.input?.source !== 'background_result' &&
        (foreground?.status === 'running' || foreground?.kind === 'chat')
          ? foreground?.id
          : undefined) ??
        waiting?.id;
      if (
        !pendingSubmission.current ||
        pendingSubmission.current.text !== input ||
        pendingSubmission.current.mode !== mode
      )
        pendingSubmission.current = {
          text: input,
          mode,
          body: {
            text: input,
            mode,
            idempotency_key: crypto.randomUUID(),
            ...(mode === 'steer' && targetId ? { target_operation_id: targetId } : {}),
          },
        };
      try {
        await post('/chat', pendingSubmission.current.body);
      } catch (error) {
        if (error instanceof ApiError && error.code === 'turn_finished') {
          pendingSubmission.current.body = {
            text: input,
            mode: 'queue',
            idempotency_key: pendingSubmission.current.body.idempotency_key,
          };
          await post('/chat', pendingSubmission.current.body);
        } else throw error;
      }
      pendingSubmission.current = null;
      setText('');
      setReplyTo(null);
      cancelHistoryLoad();
      setOlder([]);
      setHistoryPage(null);
      stick.current = true;
      await refresh();
      textarea.current?.focus();
    } catch (e: any) {
      toast(e.message, true);
    } finally {
      setSending(false);
    }
  };
  return (
    <div className={`chat-layout ${started ? 'has-conversation' : 'is-empty'}`}>
      <section className="chat-main" aria-label="Nota 对话">
        {read.state.unread_count > 0 && (
          <div className="unread-banner" role="status">
            <button onClick={() => void jumpUnread()} disabled={jumping} aria-label="跳转到未读">
              <span className="unread-dot" />
              {read.state.unread_count} 条未读消息{' '}
              <span>{jumping ? '正在定位…' : '跳转到未读'}</span>
            </button>
            <button
              onClick={() => void read.markRead(true).catch((e: any) => toast(e.message, true))}
              disabled={read.busy}
              aria-label="全部标为已读"
            >
              <Check size={15} />
              <span>标为已读</span>
            </button>
          </div>
        )}
        <div
          className="chat-scroll"
          ref={scroll}
          onScroll={(e) => {
            const el = e.currentTarget;
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
            readingPosition.remember();
          }}
          onWheel={readingPosition.release}
          onTouchStart={readingPosition.release}
          onPointerDown={readingPosition.release}
          onKeyDown={(e) => {
            if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(e.key))
              readingPosition.release();
          }}
        >
          {!started && (
            <div className="chat-heading">
              <span className="eyebrow">{today}</span>
              <h1>{user.name}，随时记下重要的事。</h1>
              <p>我会记得上下文，也会把约定变成行动。</p>
            </div>
          )}
          {!started && (
            <>
              <div className="suggestions">
                {[
                  {
                    icon: Mic,
                    title: '整理一条便签',
                    detail: '摘要、行动项、人物与关系',
                    run: record,
                  },
                  {
                    icon: CalendarDays,
                    title: '安排接下来的事',
                    detail: '日程、待办，还有到点提醒',
                    run: () => {
                      setText('帮我创建一个日程：');
                      textarea.current?.focus();
                    },
                  },
                  {
                    icon: BookOpen,
                    title: '找回之前的细节',
                    detail: '按人物、时间检索录音原文',
                    run: () => {
                      setText('帮我查一下之前录音里提到的');
                      textarea.current?.focus();
                    },
                  },
                ].map((s, i) => (
                  <button key={i} onClick={s.run}>
                    <s.icon size={21} />
                    <strong>{s.title}</strong>
                    <small>{s.detail}</small>
                    <ChevronRight size={15} />
                  </button>
                ))}
              </div>
            </>
          )}
          {messages.length > 0 && more && (
            <button
              className="load-history text-button"
              disabled={loadingOlder}
              onClick={async () => {
                if (historyRequest.current) return;
                const controller = new AbortController();
                historyRequest.current = controller;
                setLoadingOlder(true);
                try {
                  stick.current = false;
                  const r = await api(`/messages?before=${messages[0].seq}&limit=50`, {
                    signal: controller.signal,
                  });
                  if (controller.signal.aborted || historyRequest.current !== controller) return;
                  // The user may have kept reading while the request was in flight.
                  readingPosition.remember();
                  setOlder((v) => [...r.messages, ...v]);
                  setMore(r.has_before);
                } catch (e: any) {
                  if (!controller.signal.aborted) toast(e.message, true);
                } finally {
                  if (historyRequest.current === controller) {
                    historyRequest.current = null;
                    setLoadingOlder(false);
                  }
                }
              }}
            >
              {loadingOlder ? '正在读取…' : '查看更早的对话'}
            </button>
          )}
          <div className="conversation-flow" ref={flow}>
            <div className="messages">
              {messages.map((m: any) => (
                <React.Fragment key={m.id}>
                  {m.id === read.dividerId && (
                    <div className="unread-divider" role="separator" aria-label="新消息分界线">
                      <span>以下为新消息</span>
                    </div>
                  )}
                  <article
                    key={m.id}
                    className={`message ${m.role === 'user' ? 'from-user' : 'from-nota'} ${m.kind === 'reminder' ? 'reminder-message' : ''}`}
                    data-message-id={m.id}
                  >
                    <div className="message-avatar">
                      {m.role === 'user' ? (
                        user.name.slice(0, 1)
                      ) : (
                        <Leaf size={18} strokeWidth={1.6} />
                      )}
                    </div>
                    <div className="message-body">
                      <div className="message-meta">
                        <strong>
                          {m.role === 'user'
                            ? '你'
                            : m.kind === 'reminder'
                              ? 'Nota · 提醒'
                              : 'Nota'}
                        </strong>
                        <time>{formatDate(m.created_at, user.timezone)}</time>
                        {m.kind === 'trigger' && <span className="tiny-tag">自动触发</span>}
                        {m.kind === 'steering' && <span className="tiny-tag">补充交办</span>}
                      </div>
                      {m.operation_id && m.role === 'assistant' && (
                        <ExecutionProcess
                          operationId={m.operation_id}
                          messageId={m.id}
                          summary={m.process}
                          cycle={m.process_cycle ?? m.process?.cycle ?? 0}
                        />
                      )}
                      <div className="message-content">
                        <Markdown text={m.content} />
                      </div>
                      {m.role === 'assistant' &&
                        m.operation_id &&
                        (m.process?.status === 'failed' ||
                          (!m.process &&
                            boot.operations.some(
                              (o: any) => o.id === m.operation_id && o.status === 'failed',
                            ))) && <ChatRetry operationId={m.operation_id} messageId={m.id} />}
                      {m.role === 'assistant' &&
                        boot.operations.some(
                          (o: any) => o.id === m.operation_id && o.status === 'waiting',
                        ) && (
                          <button
                            className="text-button"
                            onClick={() => {
                              setReplyTo(m.operation_id);
                              textarea.current?.focus();
                            }}
                          >
                            {waiting?.id === m.operation_id ? '正在补充这次交办' : '补充这次交办'}
                          </button>
                        )}
                    </div>
                  </article>
                </React.Fragment>
              ))}
            </div>
            {historyPage && (
              <div className="history-navigation">
                <button
                  className="text-button"
                  onClick={() => {
                    cancelHistoryLoad();
                    stick.current = true;
                    setOlder([]);
                    setHistoryPage(null);
                    requestAnimationFrame(() => {
                      if (scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
                    });
                  }}
                >
                  回到最新
                </button>
              </div>
            )}
            {historyPage?.has_after && (
              <button
                className="load-history text-button"
                disabled={loadingOlder}
                onClick={async () => {
                  setLoadingOlder(true);
                  stick.current = false;
                  try {
                    const r = await api(`/messages?after=${messages.at(-1).seq}&limit=50`);
                    setHistoryPage((p: any) => ({
                      ...p,
                      messages: [...p.messages, ...r.messages],
                      has_after: r.has_after,
                    }));
                  } catch (e: any) {
                    toast(e.message, true);
                  } finally {
                    setLoadingOlder(false);
                  }
                }}
              >
                查看后续对话
              </button>
            )}
            {(foreground ? [foreground] : []).map((o: any) => (
              <article className="message from-nota" key={o.id}>
                <div className="message-avatar">
                  <Leaf size={18} />
                </div>
                <div className="message-body">
                  <div className="message-meta">
                    <strong>Nota</strong>
                    <Status value={o.status} />
                  </div>
                  <ExecutionProcess
                    key={`${o.id}:${operationCycle(o)}`}
                    operationId={o.id}
                    cycle={operationCycle(o)}
                    live
                  />
                  <button
                    className="text-button subtle"
                    onClick={() =>
                      void action(() => post(`/operations/${o.id}/cancel`), '已取消任务')
                    }
                  >
                    停止本次任务
                  </button>
                </div>
              </article>
            ))}
          </div>
          {waiting && (
            <div className="clarification">
              <Clock3 size={17} />
              <div>
                <strong>
                  {active.filter((o: any) => o.status === 'waiting').length > 1
                    ? '有多项交办待补充，可在对应回复下选择'
                    : '有一个任务在等你补充'}
                </strong>
                <p>{(waiting.input?.title ?? waiting.input?.text ?? '').slice(0, 75)}</p>
                <p>下方回复将继续这次任务，不会再占用一次额度。</p>
              </div>
              <button
                className="text-button"
                onClick={() =>
                  void action(() => post(`/operations/${waiting.id}/cancel`), '已取消待确认任务')
                }
              >
                取消
              </button>
            </div>
          )}
          <p className="composer-note">
            {(foreground && foreground.input?.source !== 'background_result') || waiting
              ? '补充会继续当前交办 · 已完成的操作保留 · 不重复计次'
              : '一个持续的对话 · 历史可复查 · AI 可能有误，请核对重要约定'}
          </p>
        </div>
        <div className="composer-area">
          {pendingInputs.length > 0 && (
            <div className="input-preview" role="status">
              <Clock3 size={15} />
              <div>
                <strong>补充已收到，将在当前步骤后接入</strong>
                {pendingInputs.map((input: any) => (
                  <p key={input.id}>{input.content}</p>
                ))}
              </div>
            </div>
          )}
          {queued.length > 0 && (
            <div className="input-preview queued-preview">
              <Clock3 size={15} />
              <div>
                <strong>{queued.length} 项交办排队中</strong>
                {queued.slice(0, 3).map((operation: any) => (
                  <p key={operation.id}>
                    {operation.input?.text ?? operation.input?.title ?? '等待处理'}
                  </p>
                ))}
              </div>
            </div>
          )}
          <form
            className="composer"
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <textarea
              ref={textarea}
              aria-label="发送给 Nota"
              placeholder={waiting ? '补充一下，继续这次任务…' : '说说你的想法，或者交办一件事…'}
              value={text}
              rows={1}
              maxLength={20000}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (
                  e.key === 'Enter' &&
                  !e.shiftKey &&
                  !e.nativeEvent.isComposing &&
                  window.innerWidth > 700
                ) {
                  e.preventDefault();
                  void submit(text);
                }
              }}
            />
            <Button
              type="submit"
              className="send-button"
              aria-label="发送"
              disabled={!text.trim()}
              busy={sending}
            >
              {!sending && <ArrowUp size={20} />}
            </Button>
          </form>
        </div>
      </section>
    </div>
  );
}
export function ToolTrace({ operationId, live = false }: { operationId: string; live?: boolean }) {
  return <ExecutionProcess operationId={operationId} live={live} />;
}
