import { api } from './api';
import type { NotaContext } from './ui';
import type { OperationDestination } from '../shared/tasks';

export function followOperationDestination(
  context: Pick<NotaContext, 'user' | 'navigate' | 'openRecording'>,
  destination: OperationDestination,
) {
  if (destination.reply_operation_id)
    sessionStorage.setItem(`nota:reply:${context.user.id}`, destination.reply_operation_id);
  if (destination.view === 'recordings' && destination.target)
    context.openRecording(destination.target);
  else context.navigate(destination.view, destination.target ?? undefined);
}

export async function openOperation(
  context: Pick<NotaContext, 'user' | 'navigate' | 'openRecording'>,
  id: string,
) {
  const { destination } = await api<{ destination: OperationDestination }>(
    `/operations/${id}/destination`,
  );
  followOperationDestination(context, destination);
}
