import { AppError, Db, emit, type Client } from './db.js';

/** One durable position per account. Message sequence orders UUIDs without per-message flags. */
export async function conversationRead(c: Client, userId: string) {
  return (
    await c.query(
      `WITH position AS (
        SELECT coalesce((SELECT last_read_seq FROM conversation_reads WHERE user_id=$1),0) AS seq
      )
      SELECT p.seq::text AS last_read_seq,
        (SELECT last_read_message_id FROM conversation_reads WHERE user_id=$1) AS last_read_message_id,
        (SELECT count(*)::int FROM messages WHERE user_id=$1 AND role='assistant' AND seq>p.seq) AS unread_count,
        (SELECT id FROM messages WHERE user_id=$1 AND role='assistant' AND seq>p.seq ORDER BY seq LIMIT 1) AS first_unread_id,
        (SELECT seq::text FROM messages WHERE user_id=$1 AND role='assistant' AND seq>p.seq ORDER BY seq LIMIT 1) AS first_unread_seq,
        (SELECT id FROM messages WHERE user_id=$1 ORDER BY seq DESC LIMIT 1) AS latest_message_id
      FROM position p`,
      [userId],
    )
  ).rows[0];
}

export async function markConversationRead(db: Db, userId: string, messageId: string) {
  return db.tx(async (c) => {
    const message = (
      await c.query('SELECT id,seq FROM messages WHERE id=$1 AND user_id=$2', [messageId, userId])
    ).rows[0];
    if (!message) throw new AppError(404, '消息不存在或无访问权限');
    const changed = await c.query(
      `INSERT INTO conversation_reads(user_id,last_read_message_id,last_read_seq) VALUES($1,$2,$3)
       ON CONFLICT(user_id) DO UPDATE SET last_read_message_id=EXCLUDED.last_read_message_id,
         last_read_seq=EXCLUDED.last_read_seq,updated_at=now()
       WHERE conversation_reads.last_read_seq<EXCLUDED.last_read_seq RETURNING user_id`,
      [userId, message.id, message.seq],
    );
    const state = await conversationRead(c, userId);
    const notifications = await c.query(
      `UPDATE notifications n SET read_at=now() FROM messages m
       WHERE n.user_id=$1 AND n.message_id=m.id AND m.user_id=n.user_id
         AND m.seq<=$2 AND n.read_at IS NULL AND n.archived_at IS NULL RETURNING n.id`,
      [userId, state.last_read_seq],
    );
    if (changed.rowCount) await emit(c, userId, 'chat_read', state);
    if (notifications.rowCount) await emit(c, userId, 'changed', { entity: 'notification' });
    return state;
  });
}

export async function messagePage(
  c: Client,
  userId: string,
  options: { before?: string; after?: string; around?: string; limit: number; q?: string },
) {
  let rows: any[];
  const columns = 'id,operation_id,seq,role,kind,content,process,dedupe_key,created_at';
  if (options.around) {
    const target = (
      await c.query('SELECT seq FROM messages WHERE id=$1 AND user_id=$2', [options.around, userId])
    ).rows[0];
    if (!target) throw new AppError(404, '消息不存在或无访问权限');
    rows = (
      await c.query(
        `(SELECT ${columns} FROM messages WHERE user_id=$1 AND seq<$2 ORDER BY seq DESC LIMIT 3)
         UNION ALL (SELECT ${columns} FROM messages WHERE user_id=$1 AND seq>=$2 ORDER BY seq LIMIT $3)
         ORDER BY seq`,
        [userId, target.seq, options.limit],
      )
    ).rows;
  } else {
    rows = (
      await c.query(
        `SELECT ${columns} FROM messages WHERE user_id=$1
         AND ($2::bigint IS NULL OR seq<$2) AND ($3::bigint IS NULL OR seq>$3)
         AND ($4::text IS NULL OR content ILIKE $4)
         ORDER BY seq ${options.after ? 'ASC' : 'DESC'} LIMIT $5`,
        [
          userId,
          options.before ?? null,
          options.after ?? null,
          options.q ? `%${options.q}%` : null,
          options.limit,
        ],
      )
    ).rows;
    if (!options.after) rows.reverse();
  }
  const bounds = rows.length
    ? (
        await c.query(
          `SELECT EXISTS(SELECT 1 FROM messages WHERE user_id=$1 AND seq<$2 AND ($4::text IS NULL OR content ILIKE $4)) AS has_before,
           EXISTS(SELECT 1 FROM messages WHERE user_id=$1 AND seq>$3 AND ($4::text IS NULL OR content ILIKE $4)) AS has_after`,
          [userId, rows[0].seq, rows.at(-1).seq, options.q ? `%${options.q}%` : null],
        )
      ).rows[0]
    : { has_before: false, has_after: false };
  return { rows, ...bounds };
}
