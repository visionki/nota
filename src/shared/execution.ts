export interface ExecutionEvent {
  id: string;
  type: string;
  operation_id?: string;
  data: Record<string, any>;
  created_at: string;
}

export interface ExecutionText {
  kind: 'text';
  id: string;
  sequence: string;
  updatedSequence?: string;
  text: string;
  complete: boolean;
}

export interface ExecutionTool {
  kind: 'tool';
  id: string;
  sequence: string;
  name: string;
  label?: string;
  status: string;
  input?: unknown;
  result?: unknown;
  error?: string;
}

export interface ExecutionActivity {
  kind: 'activity';
  id: string;
  sequence: string;
  message: string;
}
export interface ExecutionInput {
  kind: 'input';
  id: string;
  sequence: string;
  content: string;
  status: string;
}

export interface ProcessSummary {
  stats_version?: 2;
  duration_ms?: number;
  tools_known?: boolean;
  cycle: number;
  from_event?: string;
  to_event: string;
  final_turn_id?: string;
  started_at?: string;
  finished_at: string;
  status: string;
  tools: number;
  notes: number;
}

export interface ExecutionProcessState {
  cycle: number;
  cursor: string;
  firstEvent?: string;
  entries: (ExecutionText | ExecutionTool | ExecutionActivity | ExecutionInput)[];
  currentTurnId?: string;
  finalTurnId?: string;
  startedAt?: string;
  finishedAt?: string;
  status?: string;
  activity?: string;
  activeDurationMs?: number;
  runningSince?: string;
  timingKnown?: boolean;
  queuedAt?: string;
  durationMs?: number;
}

export const isExecuting = (status?: string) => status === 'queued' || status === 'running';
export const operationCycle = (operation: any): number =>
  operation?.cycle ?? operation?.input?.clarifications?.length ?? 0;

export function emptyProcess(cycle = 0): ExecutionProcessState {
  return { cycle, cursor: '0', entries: [] };
}

/** Public assistant text and business receipts only; private reasoning is never an event. */
export function applyExecutionEvent(
  state: ExecutionProcessState,
  event: ExecutionEvent,
): ExecutionProcessState {
  if (BigInt(event.id) <= BigInt(state.cursor)) return state;
  const data = event.data ?? {};
  if ((data.cycle ?? 0) !== state.cycle) return state;
  const next = {
    ...state,
    cursor: event.id,
    firstEvent: state.firstEvent ?? event.id,
    startedAt: state.startedAt ?? event.created_at,
    entries: [...state.entries],
  };
  const completeText = () => {
    next.entries = next.entries.map((entry) =>
      entry.kind === 'text' && !entry.complete ? { ...entry, complete: true } : entry,
    );
  };
  if (event.type === 'text_reset') {
    completeText();
    next.currentTurnId = data.turn_id ?? `legacy-${event.id}`;
    next.entries.push({
      kind: 'text',
      id: next.currentTurnId!,
      sequence: event.id,
      text: '',
      complete: false,
      updatedSequence: event.id,
    });
  } else if (event.type === 'text') {
    const id = data.turn_id ?? next.currentTurnId ?? `legacy-${event.id}`;
    next.currentTurnId = id;
    const at = next.entries.findIndex((entry) => entry.kind === 'text' && entry.id === id);
    if (at < 0)
      next.entries.push({
        kind: 'text',
        id,
        sequence: event.id,
        text: String(data.delta ?? ''),
        complete: false,
        updatedSequence: event.id,
      });
    else {
      const prior = next.entries[at] as ExecutionText;
      next.entries[at] = {
        ...prior,
        text: prior.text + String(data.delta ?? ''),
        updatedSequence: event.id,
      };
    }
  } else if (event.type === 'text_end') {
    const id = data.turn_id ?? next.currentTurnId;
    next.entries = next.entries.map((entry) =>
      entry.kind === 'text' && entry.id === id ? { ...entry, complete: true } : entry,
    );
  } else if (event.type === 'tool') {
    completeText();
    const at = next.entries.findIndex((entry) => entry.kind === 'tool' && entry.id === data.id);
    const prior = at < 0 ? undefined : (next.entries[at] as ExecutionTool);
    const tool: ExecutionTool = {
      ...prior,
      kind: 'tool',
      id: data.id,
      sequence: prior?.sequence ?? event.id,
      name: data.name ?? prior?.name,
      label: data.label ?? prior?.label,
      status: data.status,
      ...(data.input !== undefined ? { input: data.input } : {}),
      ...(data.result !== undefined ? { result: data.result } : {}),
      ...(data.error !== undefined ? { error: data.error } : {}),
    };
    if (at < 0) next.entries.push(tool);
    else next.entries[at] = tool;
  } else if (event.type === 'input') {
    if (data.status === 'pending')
      next.entries.push({
        kind: 'input',
        id: data.id,
        sequence: event.id,
        content: data.content ?? '',
        status: 'pending',
      });
    if (data.status === 'applied')
      next.entries = next.entries.map((entry) =>
        entry.kind === 'input' && (data.ids ?? []).includes(entry.id)
          ? { ...entry, status: 'applied' }
          : entry,
      );
  } else if (event.type === 'activity') {
    next.activity = data.message;
    if (data.message && ['retrying', 'compacting', 'compaction_failed'].includes(data.phase))
      next.entries.push({
        kind: 'activity',
        id: event.id,
        sequence: event.id,
        message: data.message,
      });
  } else if (event.type === 'operation') {
    if (data.status === 'running') {
      next.runningSince = next.runningSince ?? event.created_at;
      next.timingKnown = true;
    } else if (data.status && next.runningSince) {
      const interval = new Date(event.created_at).getTime() - new Date(next.runningSince).getTime();
      if (Number.isFinite(interval))
        next.activeDurationMs = (next.activeDurationMs ?? 0) + Math.max(0, interval);
      next.runningSince = undefined;
    }
    if (data.status === 'queued') next.queuedAt = next.queuedAt ?? event.created_at;
    next.status = data.status ?? next.status;
    next.finalTurnId = data.process?.final_turn_id ?? next.finalTurnId;
    if (data.status && !isExecuting(data.status)) {
      completeText();
      next.finishedAt = event.created_at;
    }
  }
  return next;
}

/** Active worker intervals, excluding time queued or awaiting the user's reply. */
export function executionDuration(state: ExecutionProcessState, finishedAt?: string) {
  if (state.runningSince && finishedAt) {
    const interval = new Date(finishedAt).getTime() - new Date(state.runningSince).getTime();
    return Number.isFinite(interval)
      ? (state.activeDurationMs ?? 0) + Math.max(0, interval)
      : undefined;
  }
  if (state.timingKnown) return state.activeDurationMs ?? 0;
  if (state.queuedAt && !state.entries.length) return 0;
  return undefined;
}

export function summarizeProcess(
  state: ExecutionProcessState,
  text: string,
  status: string,
  finishedAt = new Date().toISOString(),
  finalTurnId?: string,
): ProcessSummary {
  const final =
    finalTurnId ??
    [...state.entries]
      .reverse()
      .find((entry) => entry.kind === 'text' && entry.text.trim() === text.trim())?.id;
  return {
    stats_version: 2,
    duration_ms: executionDuration(state, finishedAt),
    tools_known: true,
    cycle: state.cycle,
    from_event: state.firstEvent,
    to_event: state.cursor,
    ...(final ? { final_turn_id: final } : {}),
    started_at: state.startedAt,
    finished_at: finishedAt,
    status,
    tools: state.entries.filter((entry) => entry.kind === 'tool').length,
    notes: state.entries.filter(
      (entry) => entry.kind === 'text' && entry.text && entry.id !== final,
    ).length,
  };
}
