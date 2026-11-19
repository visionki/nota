import { randomUUID } from 'node:crypto';
import { emit, type Client } from './db.js';
import {
  notificationPreview,
  type NotificationKind,
  type NotificationObject,
} from '../shared/notifications.js';

export async function notify(
  c: Client,
  userId: string,
  key: string,
  event: {
    kind: NotificationKind;
    title: string;
    body: string;
    objectId?: string;
    objectType?: NotificationObject;
    messageId?: string;
  },
) {
  const id = randomUUID();
  const r = await c.query(
    `INSERT INTO notifications(id,user_id,title,body,kind,object_id,object_type,message_id,dedupe_key,read_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,
       CASE WHEN EXISTS(SELECT 1 FROM messages m JOIN conversation_reads r ON r.user_id=m.user_id
         WHERE m.id=$8 AND m.user_id=$2 AND m.seq<=r.last_read_seq) THEN now() END)
     ON CONFLICT(user_id,dedupe_key) DO NOTHING RETURNING *`,
    [
      id,
      userId,
      notificationPreview(event.title, 90),
      notificationPreview(event.body),
      event.kind,
      event.objectId ?? null,
      event.objectType ?? 'operation',
      event.messageId ?? null,
      key,
    ],
  );
  if (r.rows[0]) await emit(c, userId, 'notification', r.rows[0]);
  return r.rows[0]?.id ?? null;
}

export async function notifications(c: Client, userId: string, limit = 100) {
  return (
    await c.query(
      `SELECT n.*,o.status AS object_status FROM notifications n
       LEFT JOIN operations o ON n.object_type='operation' AND o.id=n.object_id AND o.user_id=n.user_id
       WHERE n.user_id=$1 AND n.archived_at IS NULL ORDER BY n.created_at DESC,n.id DESC LIMIT $2`,
      [userId, limit],
    )
  ).rows;
}

export async function resolveNotifications(
  c: Client,
  userId: string,
  objectId: string,
  objectType: NotificationObject = 'operation',
) {
  const updated = await c.query(
    `UPDATE notifications SET resolved_at=now(),read_at=coalesce(read_at,now())
     WHERE user_id=$1 AND object_type=$3 AND kind='attention'
       AND (object_id=$2 OR ($3='operation' AND object_id IN (
         SELECT b.agent_operation_id FROM recording_batches b JOIN operations o ON o.id=b.agent_operation_id AND o.user_id=b.user_id
         WHERE b.user_id=$1 AND o.status='succeeded'
           AND EXISTS(SELECT 1 FROM recording_batch_items i WHERE i.batch_id=b.id AND i.operation_id=$2)
           AND NOT EXISTS(SELECT 1 FROM recording_batch_items i JOIN operations child ON child.id=i.operation_id AND child.user_id=i.user_id
             WHERE i.batch_id=b.id AND i.operation_id<>$2 AND child.status='failed')
       )))
       AND resolved_at IS NULL AND archived_at IS NULL RETURNING id`,
    [userId, objectId, objectType],
  );
  if (updated.rowCount) await emit(c, userId, 'changed', { entity: 'notification' });
}

export function operationTitle(op: any, recordingTitle?: string) {
  return notificationPreview(
    op.input.schedule_title ??
      op.input.background_title ??
      op.input.trigger_name ??
      op.input.title ??
      recordingTitle ??
      (op.input.source === 'recording_window' ? '语音便签整理' : op.input.text) ??
      '这次交办',
    48,
  );
}
