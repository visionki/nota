import { translate } from './locale';
import React, { createContext, useContext, useEffect, useRef } from 'react';
import {
  X,
  LoaderCircle,
  CheckCircle2,
  AlertCircle,
  Clock3,
  ChevronRight,
  Leaf,
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
export type View =
  'chat' | 'recordings' | 'agenda' | 'memory' | 'tasks' | 'notifications' | 'billing' | 'settings';
export interface NotaContext {
  user: any;
  boot: any;
  caps: any;
  online: boolean;
  revision: number;
  view: View;
  navigationTarget?: string | null;
  refresh: () => Promise<void>;
  action: (fn: () => Promise<any>, success?: string) => Promise<any>;
  toast: (message: string, error?: boolean) => void;
  navigate: (v: View, target?: string) => void;
  openRecording: (id: string) => void;
  openSource?: (id: string) => void;
  openCreate: (kind: string, initial?: any) => void;
  record: () => void;
}
export const Context = createContext<NotaContext>(null!);
export const useNota = () => useContext(Context);
export function Button({
  children,
  variant = 'primary',
  className = '',
  busy = false,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  busy?: boolean;
}) {
  return (
    <button {...props} disabled={props.disabled || busy} className={`btn ${variant} ${className}`}>
      {busy && <LoaderCircle size={16} className="spin" />}
      {children}
    </button>
  );
}
export function IconButton({
  label,
  children,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      {...props}
      className={`icon-button ${props.className ?? ''}`}
      title={label}
      aria-label={label}
    >
      {children}
    </button>
  );
}
export function Modal({
  title,
  children,
  onClose,
  wide = false,
}: React.PropsWithChildren<{ title: string; onClose: () => void; wide?: boolean }>) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const old = document.activeElement as HTMLElement;
    const oldOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const t = setTimeout(
      () => ref.current?.querySelector<HTMLElement>('input,textarea,button,select')?.focus(),
      50,
    );
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'Tab') {
        const nodes = Array.from(
          ref.current?.querySelectorAll<HTMLElement>(
            'button:not(:disabled),input,textarea,select,a[href],[tabindex="0"]',
          ) ?? [],
        ).filter((e) => e.offsetParent !== null);
        if (!nodes.length) return;
        const first = nodes[0],
          last = nodes.at(-1);
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', key);
    return () => {
      clearTimeout(t);
      document.body.style.overflow = oldOverflow;
      document.removeEventListener('keydown', key);
      old?.focus();
    };
  }, []);
  return (
    <div
      className="modal-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={`modal ${wide ? 'wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        ref={ref}
      >
        <header className="modal-header">
          <h2>{title}</h2>
          <IconButton label={translate('关闭')} onClick={onClose}>
            <X size={20} />
          </IconButton>
        </header>
        {children}
      </div>
    </div>
  );
}
export function Markdown({ text }: { text: string }) {
  const { openRecording, openSource } = useNota();
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => {
            const match = /^\/recordings\/([0-9a-f-]{36})/.exec(href ?? '');
            return match ? (
              <a
                href={href}
                onClick={(e) => {
                  e.preventDefault();
                  openRecording((href ?? '').slice('/recordings/'.length));
                }}
              >
                {children}
                <ChevronRight size={12} />
              </a>
            ) : (
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => {
                  const source = /^\/sources\/([0-9a-f-]{36})/.exec(href ?? '');
                  if (source && openSource) {
                    e.preventDefault();
                    openSource(source[1]);
                  }
                }}
              >
                {children}
              </a>
            );
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
const labels: Record<string, string> = {
  queued: '排队中',
  running: '执行中',
  waiting: '待你确认',
  succeeded: '已完成',
  failed: '未完成',
  cancelled: '已取消',
  uploaded: '待转写',
  pending: '待处理',
  transcribing: '转写中',
  organizing: '整理中',
  ready: '已整理',
  needs_attention: '需要处理',
  needs_confirmation: '待确认',
  interrupted: '已中断',
  superseded: '已跳过',
  prepared: '已整理，待汇总',
  scheduled: '待提醒',
  delivered: '已投递',
  confirmed: '已确认',
  open: '待完成',
  done: '已完成',
};
export function Status({ value }: { value: string }) {
  const loading = ['running', 'transcribing', 'organizing', 'queued', 'uploaded'].includes(value);
  const good = ['succeeded', 'ready', 'done', 'delivered', 'confirmed'].includes(value);
  const bad = ['failed', 'needs_attention', 'interrupted'].includes(value);
  return (
    <span className={`status ${good ? 'good' : bad ? 'bad' : loading ? 'loading' : ''}`}>
      {loading ? (
        <LoaderCircle size={12} className="spin" />
      ) : good ? (
        <CheckCircle2 size={12} />
      ) : bad ? (
        <AlertCircle size={12} />
      ) : (
        <Clock3 size={12} />
      )}{' '}
      {translate(labels[value] ?? value)}
    </span>
  );
}
export function Empty({
  title,
  description,
  children,
  icon,
}: {
  title: string;
  description: string;
  children?: React.ReactNode;
  icon?: React.ReactNode;
}) {
  return (
    <div className="empty-state">
      <div className="empty-icon">{icon ?? <Leaf size={28} strokeWidth={1.3} />}</div>
      <h3>{title}</h3>
      <p>{description}</p>
      {children}
    </div>
  );
}
export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: React.ReactNode;
  hint?: string;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}
export function Confirm({
  title,
  body,
  onConfirm,
  onClose,
  danger = false,
}: {
  title: string;
  body: string;
  onConfirm: () => Promise<any>;
  onClose: () => void;
  danger?: boolean;
}) {
  const [busy, setBusy] = React.useState(false);
  return (
    <Modal title={title} onClose={onClose}>
      <p className="modal-copy">{body}</p>
      <footer className="modal-actions">
        <Button variant="secondary" onClick={onClose}>
          {translate('返回')}
        </Button>
        <Button
          variant={danger ? 'danger' : 'primary'}
          busy={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await onConfirm();
              onClose();
            } finally {
              setBusy(false);
            }
          }}
        >
          {translate('确认')}
        </Button>
      </footer>
    </Modal>
  );
}
