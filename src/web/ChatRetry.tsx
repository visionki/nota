import { translate } from './locale';
import React, { useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { post } from './api';
import { Button, useNota } from './ui';
import { useResource } from './Views';

/** Failure controls belong to the delivery that failed, including older loaded history. */
export function ChatRetry({ operationId, messageId }: { operationId: string; messageId: string }) {
  const { action } = useNota();
  const r = useResource(`/operations/${operationId}/state`);
  const [busy, setBusy] = useState(false);
  const operation = r.data?.operation;
  if (!operation?.retryable || operation.latest_message_id !== messageId) return null;
  return (
    <div className="chat-retry" data-retry-operation-id={operationId}>
      <Button
        variant="secondary"
        busy={busy}
        onClick={async () => {
          setBusy(true);
          try {
            const result = await action(
              () => post(`/operations/${operationId}/retry`),
              translate('已重新排队，保留已完成的操作'),
            );
            if (result) window.dispatchEvent(new Event('nota:chat-retry'));
          } finally {
            setBusy(false);
          }
        }}
      >
        <RefreshCw size={14} /> {translate('重试这次交办')}
      </Button>
    </div>
  );
}
