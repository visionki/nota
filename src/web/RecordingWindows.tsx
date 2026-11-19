import { translate } from './locale';
import React, { useState } from 'react';
import { AudioLines, ChevronDown, CheckCircle2, Clock3, LoaderCircle } from 'lucide-react';
import { useNota, Modal, Button } from './ui';
import { useResource, ResourceNote } from './Views';
export function RecordingWindows() {
  const { boot, openRecording } = useNota();
  const [selected, setSelected] = useState<string | null>(null);
  const windows = (boot.recording_batches ?? []).filter((b: any) => b.state !== 'dispatched');
  if (!windows.length && !selected) return null;
  return (
    <div className="recording-windows" aria-label={translate('后台录音整理')}>
      {windows.map((batch: any) => (
        <button
          className="recording-window"
          key={batch.id}
          onClick={() => setSelected(batch.id)}
          data-testid="recording-window"
        >
          <AudioLines size={19} />
          <div>
            <strong>
              {translate('正在整理')} {batch.total} {translate('条声音')}
            </strong>
            <span>
              {translate('已整理')} {batch.ready} {translate('条')}
              {batch.failed ? translate` · ${batch.failed} 条失败` : ''} ·{' '}
              {batch.pending
                ? translate`${batch.pending} 条处理中`
                : translate('即将统一交给 Nota')}
            </span>
            <small>
              {batch.state === 'open'
                ? translate('新录音会一起整理，每轮最多 10 条')
                : translate('本轮已收齐，新录音将另起一轮')}
            </small>
          </div>
          <ChevronDown size={15} />
        </button>
      ))}
      {selected && (
        <WindowDetail id={selected} onClose={() => setSelected(null)} onOpen={openRecording} />
      )}
    </div>
  );
}
function WindowDetail({
  id,
  onClose,
  onOpen,
}: {
  id: string;
  onClose: () => void;
  onOpen: (id: string) => void;
}) {
  const r = useResource(`/recording-batches/${id}`);
  return (
    <Modal title={translate('正在一起整理的声音')} onClose={onClose}>
      <ResourceNote resource={r} />
      <p className="muted">{translate('录音独立处理，收齐后由 Nota 一次汇报。你可以继续聊天。')}</p>
      <div className="window-items">
        {r.data?.items.map((item: any) => (
          <button
            key={item.operation_id}
            onClick={() => {
              onOpen(item.recording_id);
              onClose();
            }}
          >
            {item.state === 'ready' ? (
              <CheckCircle2 size={17} />
            ) : item.state === 'pending' ? (
              <LoaderCircle size={17} className="spin" />
            ) : (
              <Clock3 size={17} />
            )}
            <span>
              <strong>{item.title}</strong>
              <small>
                {item.state === 'ready'
                  ? translate('已整理')
                  : item.state === 'pending'
                    ? translate('处理中')
                    : (item.error ?? translate('已停止'))}
              </small>
            </span>
          </button>
        ))}
      </div>
    </Modal>
  );
}
export function SourcePreview({ id, onClose }: { id: string; onClose: () => void }) {
  const { openRecording } = useNota();
  const r = useResource(`/sources/${id}`);
  return (
    <Modal title={translate('原文出处')} onClose={onClose} wide>
      <ResourceNote resource={r} />
      {r.data && (
        <>
          <p className="source-note">
            {translate('原文版本')} {r.data.source_version} {translate('· 附近文段')}
          </p>
          <SourceExcerpt chunks={r.data.chunks} selected={id} />
          {r.data.source_kind === 'recording' && (
            <footer className="modal-actions">
              <Button
                onClick={() => {
                  openRecording(`${r.data.source_id}?version=${r.data.source_version}&chunk=${id}`);
                  onClose();
                }}
              >
                {translate('查看录音及该版本全文')}
              </Button>
            </footer>
          )}
        </>
      )}
    </Modal>
  );
}
export function SourceExcerpt({ chunks, selected }: { chunks: any[]; selected: string }) {
  return (
    <div className="source-excerpt">
      {chunks.map((chunk: any) => (
        <section key={chunk.id} className={chunk.id === selected ? 'is-cited' : ''}>
          <small>
            {translate('第')} {chunk.start_line}–{chunk.end_line} {translate('行 · 文段')}{' '}
            {chunk.ordinal + 1}
          </small>
          <p>{chunk.text}</p>
        </section>
      ))}
    </div>
  );
}
