import { emit, type Client, type Db } from './db.js';
import { fence, type ToolContext } from './tools.js';

export async function sealInputs(db: Db, ctx: ToolContext, version: number) {
  return db.tx(async (c) => {
    const current = await fence(c, ctx);
    if (current.input_version > version) return false;
    await c.query(
      "UPDATE operations SET stage='finalizing' WHERE id=$1 AND user_id=$2 AND lease_token=$3",
      [ctx.operationId, ctx.userId, ctx.leaseToken],
    );
    return true;
  });
}

export interface SteeringInput {
  id: string;
  operation_id: string;
  message_id: string;
  content: string;
  input_version: number;
  cycle: number;
  created_at: string;
  status: string;
}

export async function steeringInputs(db: Client, userId: string, operationId: string) {
  return (
    await db.query<SteeringInput>(
      "SELECT id,operation_id,message_id,content,input_version,cycle,created_at,status FROM chat_inputs WHERE user_id=$1 AND operation_id=$2 AND kind='steering' AND status<>'cancelled' ORDER BY input_version",
      [userId, operationId],
    )
  ).rows;
}

export async function acknowledgeInputs(db: Client, ctx: ToolContext, ids: string[]) {
  if (!ids.length) return;
  const changed = (
    await db.query(
      "UPDATE chat_inputs SET status='applied',applied_at=now() WHERE user_id=$1 AND operation_id=$2 AND id=ANY($3::uuid[]) AND status='pending' RETURNING id",
      [ctx.userId, ctx.operationId, ids],
    )
  ).rows;
  if (changed.length)
    await emit(
      db,
      ctx.userId,
      'input',
      { cycle: ctx.cycle ?? 0, status: 'applied', ids: changed.map((row) => row.id) },
      ctx.operationId,
    );
}

export function steeringEnvelope(input: SteeringInput) {
  return JSON.stringify({
    nota_input: true,
    input_id: input.id,
    source_messages: [{ id: input.message_id, created_at: input.created_at }],
    input_version: input.input_version,
    received_at: input.created_at,
    user_request: input.content,
    instruction:
      '这是用户对当前交办的新补充或更正。保持已有事实和回执，以最新意图为准继续；已创建的对象应修改原对象，未执行的旧参数不要继续执行。',
  });
}

export function readInputEnvelope(content: unknown): any {
  const text =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content
            .filter((part) => part?.type === 'text')
            .map((part) => part.text)
            .join('')
        : '';
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
