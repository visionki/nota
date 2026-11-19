export interface TaskSummary {
  id: string;
  title: string;
  source: 'schedule' | 'webhook';
  status: string;
  stage: string;
  summary: string;
  created_at: string;
  updated_at: string;
  message_id: string | null;
  schedule_id: string | null;
  retry_operation_id: string | null;
  cancel_operation_id: string | null;
  reply_operation_id: string | null;
}

export interface TaskStage {
  operation_id: string;
  label: string;
  status: string;
  cycle: number;
  attempts: number;
}

export interface TaskDetail {
  task: TaskSummary;
  request: string;
  result: string | null;
  error: string | null;
  stages: TaskStage[];
}

export interface TaskPage {
  tasks: TaskSummary[];
  counts: { current: number; history: number; all: number };
  next_cursor: string | null;
}

export interface OperationDestination {
  view: 'chat' | 'recordings' | 'tasks';
  target: string | null;
  reply_operation_id?: string;
}
