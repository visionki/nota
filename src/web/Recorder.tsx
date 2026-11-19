import { interfaceLocale, translate } from './locale';
import { NOTE_INSTRUCTION, LEGACY_UPLOAD_INSTRUCTION } from '../shared/notes.js';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Mic,
  Pause,
  Play,
  Square,
  AudioLines,
  Upload,
  ShieldCheck,
  WifiOff,
  LoaderCircle,
  CheckCircle2,
} from 'lucide-react';
import { displayError, api, duration } from './api';
import { Modal, Button, Field, useNota } from './ui';
import { deleteLocal, listLocal, putLocal, type LocalRecording } from './offline';
export function useUploadQueue(
  user: any,
  online: boolean,
  toast: (text: string, error?: boolean) => void,
  refresh: () => Promise<void>,
) {
  const [items, setItems] = useState<LocalRecording[]>([]),
    [uploading, setUploading] = useState(false);
  const busy = useRef(false),
    identity = useRef(user),
    connected = useRef(online);
  identity.current = user;
  connected.current = online;
  const load = useCallback(async () => {
    const id = identity.current?.id;
    if (!id) {
      setItems([]);
      return;
    }
    const r = await listLocal(id);
    if (identity.current?.id === id) setItems(r);
  }, []);
  const sync = useCallback(
    async (force = false) => {
      const id = identity.current?.id;
      if (!id || busy.current || !connected.current) return;
      busy.current = true;
      setUploading(true);
      try {
        const attempted = new Set<string>();
        while (true) {
          if (identity.current?.id !== id || !connected.current) break;
          const item = (await listLocal(id)).find(
            (item) =>
              !attempted.has(item.id) &&
              (!item.error ||
                force ||
                item.errorCode === 'quota_exhausted' ||
                (!item.errorCode && item.error.includes('免费额度已用完'))),
          );
          if (!item) break;
          attempted.add(item.id);
          try {
            const form = new FormData();
            form.set('idempotency_key', item.id);
            form.set('title', item.title);
            form.set('instruction', item.instruction ?? LEGACY_UPLOAD_INSTRUCTION);
            if (item.recordedAt) form.set('recorded_at', item.recordedAt);
            if (item.recordedTimezone) form.set('recorded_timezone', item.recordedTimezone);
            form.set('file', item.blob, item.filename);
            const result = await api('/recordings', { method: 'POST', body: form });
            // Remove the local blob only after the server has acknowledged durable storage.
            await deleteLocal(item.id);
            if (identity.current?.id === id) {
              toast(
                result.status === 'pending'
                  ? translate`“${item.title}”已上传，免费额度已用完，待额度恢复后自动整理`
                  : translate`“${item.title}”已加入后台整理，完成后统一汇报`,
              );
              await refresh();
            }
          } catch (e: any) {
            await putLocal({ ...item, error: e.message, errorCode: e.code });
            toast(displayError(e), true);
            if ([0, 401, 429, 503].includes(e.status)) break;
          }
        }
      } finally {
        busy.current = false;
        setUploading(false);
        await load().catch(() => {});
      }
    },
    [load, toast, refresh],
  );
  useEffect(() => {
    void load()
      .then(() => {
        if (online) void sync();
      })
      .catch((e) => toast(displayError(e), true));
  }, [user?.id, online]);
  const add = async (item: Omit<LocalRecording, 'id' | 'userId' | 'createdAt'>) => {
    const id = identity.current?.id;
    if (!id) throw new Error(translate('请先登录'));
    await putLocal({
      ...item,
      instruction: item.instruction ?? NOTE_INSTRUCTION,
      id: crypto.randomUUID(),
      userId: id,
      createdAt: new Date().toISOString(),
    });
    await load();
    void sync();
  };
  const addFile = async (file: File) => {
    try {
      await add({
        title: file.name.replace(/\.[^.]+$/, ''),
        filename: file.name,
        blob: file,
      });
      if (!connected.current) toast(translate('录音已保存在本机，联网后上传'));
    } catch (e: any) {
      toast(displayError(e), true);
    }
  };
  const discard = async (id: string) => {
    await deleteLocal(id);
    await load();
    toast(translate('已删除本机待上传录音'));
  };
  useEffect(() => {
    const reset = () => {
      const id = identity.current?.id;
      if (id)
        void listLocal(id)
          .then(async (records) => {
            for (const record of records) await deleteLocal(record.id);
            await load();
          })
          .catch(() => {});
    };
    window.addEventListener('nota:history-reset', reset);
    return () => window.removeEventListener('nota:history-reset', reset);
  }, [load]);
  return { items, uploading, sync, add, addFile, discard };
}
export function Recorder({
  onClose,
  onSave,
}: {
  onClose: () => void;
  onSave: (item: Omit<LocalRecording, 'id' | 'userId' | 'createdAt'>) => Promise<void>;
}) {
  const { online, caps, user } = useNota();
  const [title, setTitle] = useState(
      translate`随手记 · ${new Date().toLocaleDateString(interfaceLocale(), { month: 'numeric', day: 'numeric' })}`,
    ),
    [state, setState] = useState<'idle' | 'requesting' | 'recording' | 'paused' | 'saving'>('idle'),
    [seconds, setSeconds] = useState(0),
    [error, setError] = useState('');
  const recorder = useRef<MediaRecorder | null>(null),
    stream = useRef<MediaStream | null>(null),
    timer = useRef<ReturnType<typeof setInterval> | undefined>(undefined),
    chunks = useRef<BlobPart[]>([]),
    startTime = useRef(0),
    recordedAt = useRef<string | undefined>(undefined),
    elapsed = useRef(0),
    alive = useRef(true),
    wakeLock = useRef<any>(null),
    fallbackBlob = useRef<Blob | null>(null);
  const titleRef = useRef(title);
  titleRef.current = title;
  const stop = () => {
    if (recorder.current && recorder.current.state !== 'inactive') {
      setState('saving');
      recorder.current.stop();
    }
    stream.current?.getTracks().forEach((t) => t.stop());
    if (timer.current) clearInterval(timer.current);
    void wakeLock.current?.release?.();
  };
  const save = async (blob: Blob) => {
    fallbackBlob.current = blob;
    try {
      if (!blob.size) throw new Error(translate('没有录到声音，请检查麦克风权限'));
      const ext = blob.type.includes('mp4') ? 'm4a' : blob.type.includes('ogg') ? 'ogg' : 'webm';
      await onSave({
        title: titleRef.current.trim() || translate('随手记'),
        filename: `recording-${Date.now()}.${ext}`,
        blob,
        recordedAt: recordedAt.current,
        recordedTimezone: user.timezone,
      });
      fallbackBlob.current = null;
    } catch (e: any) {
      if (alive.current) {
        setError(displayError(e));
        setState('idle');
      }
    }
  };
  const begin = async () => {
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
      setError(
        translate(
          '当前浏览器不支持录音。请使用新版浏览器，并通过 HTTPS 或 localhost 打开，或直接上传文件。',
        ),
      );
      return;
    }
    setState('requesting');
    setError('');
    try {
      const audio = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      if (!alive.current) {
        audio.getTracks().forEach((t) => t.stop());
        return;
      }
      stream.current = audio;
      const mime = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus'].find((t) =>
        MediaRecorder.isTypeSupported(t),
      );
      const r = new MediaRecorder(
        audio,
        mime ? { mimeType: mime, audioBitsPerSecond: 64000 } : undefined,
      );
      recorder.current = r;
      chunks.current = [];
      elapsed.current = 0;
      startTime.current = performance.now();
      setSeconds(0);
      r.ondataavailable = (e) => {
        if (e.data.size) chunks.current.push(e.data);
      };
      r.onerror = () => setError(translate('录音被浏览器中断，正在保存已录内容'));
      r.onstop = () => {
        const blob = new Blob(chunks.current, { type: r.mimeType || mime || 'audio/webm' });
        stream.current?.getTracks().forEach((t) => t.stop());
        void save(blob);
      };
      r.start(1000);
      recordedAt.current = new Date().toISOString();
      setState('recording');
      timer.current = setInterval(() => {
        const n =
          elapsed.current +
          (r.state === 'recording' ? (performance.now() - startTime.current) / 1000 : 0);
        setSeconds(n);
        if (n >= (caps.maxAudioSeconds ?? 600)) stop();
      }, 250);
      try {
        wakeLock.current = await (navigator as any).wakeLock?.request('screen');
      } catch {}
    } catch (e: any) {
      setState('idle');
      setError(
        e.name === 'NotAllowedError'
          ? translate('麦克风权限未开启。请在浏览器地址栏允许麦克风访问，然后重试。')
          : translate`无法开始录音：${e.message}`,
      );
    }
  };
  const pause = () => {
    const r = recorder.current;
    if (r?.state === 'recording') {
      elapsed.current += (performance.now() - startTime.current) / 1000;
      r.pause();
      setState('paused');
    } else if (r?.state === 'paused') {
      startTime.current = performance.now();
      r.resume();
      setState('recording');
    }
  };
  useEffect(() => {
    alive.current = true;
    const leave = (e: BeforeUnloadEvent) => {
      if (recorder.current?.state && recorder.current.state !== 'inactive') {
        e.preventDefault();
        e.returnValue = translate('录音尚未保存');
      }
    };
    window.addEventListener('beforeunload', leave);
    return () => {
      alive.current = false;
      window.removeEventListener('beforeunload', leave);
      if (timer.current) clearInterval(timer.current);
      if (recorder.current && recorder.current.state !== 'inactive') recorder.current.stop();
      stream.current?.getTracks().forEach((t) => t.stop());
      void wakeLock.current?.release?.();
    };
  }, []);
  const active = state === 'recording' || state === 'paused';
  return (
    <Modal
      title={translate('记一段声音')}
      onClose={() => {
        if (active) stop();
        else if (state !== 'saving' && state !== 'requesting') onClose();
      }}
    >
      <div className="recorder-content">
        <span className="eyebrow">LEAVE A NOTE FOR YOUR FUTURE SELF</span>
        <h3>{active ? translate('慢慢说，我在听。') : translate('把此刻，留个底稿。')}</h3>
        <p>{translate('说一条自己的备忘，结束后 Nota 会整理并执行明确交办。')}</p>
        <Field label={translate('便签标题')}>
          <input
            value={title}
            maxLength={200}
            onChange={(e) => setTitle(e.target.value)}
            disabled={state === 'saving'}
          />
        </Field>
        <div className={`recording-stage ${state === 'recording' ? 'is-recording' : ''}`}>
          <div className="waveform" aria-hidden="true">
            {Array.from({ length: 39 }, (_, i) => (
              <i
                key={i}
                style={{
                  height: `${8 + Math.abs(Math.sin(i * 0.73)) * 34}px`,
                  animationDelay: `${i * -0.13}s`,
                }}
              />
            ))}
          </div>
          <div className="recording-clock">{duration(seconds)}</div>
          <span>
            {state === 'recording' ? (
              <>
                <i className="red-dot" />
                {translate('正在录音')}
              </>
            ) : state === 'paused' ? (
              translate('录音已暂停')
            ) : state === 'saving' ? (
              translate('正在安全保存录音…')
            ) : state === 'requesting' ? (
              translate('等待麦克风授权…')
            ) : (
              translate`单段最长 ${(caps.maxAudioSeconds ?? 600) / 60} 分钟`
            )}
          </span>
        </div>
        {!caps.asrConfigured && (
          <div className="inline-note">
            <Clock3Icon />
            {translate('转写服务尚未配置，录音仍可上传保留；配置后在语音便签中重试。')}
          </div>
        )}
        {!online && (
          <div className="inline-note">
            <WifiOff size={16} />
            {translate('离线录音会保存在当前浏览器，联网后上传。')}
          </div>
        )}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="recorder-actions">
          {active ? (
            <>
              <Button variant="secondary" onClick={pause}>
                {state === 'paused' ? <Play size={17} /> : <Pause size={17} />}{' '}
                {state === 'paused' ? translate('继续') : translate('暂停')}
              </Button>
              <Button onClick={stop}>
                <Square size={16} fill="currentColor" />
                {translate('结束并整理')}
              </Button>
            </>
          ) : (
            <Button
              onClick={begin}
              busy={state === 'requesting' || state === 'saving'}
              disabled={state === 'saving'}
            >
              <Mic size={18} />
              {translate('开始录音')}
            </Button>
          )}
        </div>
        {fallbackBlob.current && (
          <div className="recording-rescue">
            <p>{translate('已录内容仍在本页，请先保存。')}</p>
            <Button variant="secondary" onClick={() => void save(fallbackBlob.current!)}>
              {translate('重试保存')}
            </Button>
            <a
              className="btn ghost"
              download="nota-recording.webm"
              href={URL.createObjectURL(fallbackBlob.current)}
            >
              {translate('下载到本机')}
            </a>
          </div>
        )}
        <div className="privacy-note">
          <ShieldCheck size={15} />
          <span>{translate('录音仅用于你的笔记和交办，存放于你的个人空间。')}</span>
        </div>
      </div>
    </Modal>
  );
}
function Clock3Icon() {
  return <LoaderCircle size={16} />;
}
