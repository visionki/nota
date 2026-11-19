import React, { useEffect, useRef, useState } from 'react';
import { Activity, ArrowUpRight, ChevronRight, Clock3, RefreshCw } from 'lucide-react';
import { api, formatDate, post } from './api';
import { Button, Empty, Markdown, Status, useNota } from './ui';
import { PageHeading, ResourceNote, useResource } from './Views';
import { ExecutionProcess } from './ExecutionProcess';
import { followOperationDestination } from './operation-destination';
import type { OperationDestination, TaskDetail, TaskPage, TaskSummary } from '../shared/tasks';

const currentStages: Record<string, string> = {
  queued: '等待开始',
  running: '正在查询与整理',
  waiting: '等待补充信息',
  failed: '需要重试',
  cancelled: '任务已停止',
  awaiting_report: '结果已保存，等待交付',
  reporting: '正在交付结果',
  delivery_failed: '结果已保存，交付需要重试',
  needs_input: '需要你补充信息',
  delivery_cancelled: '结果已保存，已停止交付',
  delivered: '结果已回到对话',
  unchanged: '检查完成，没有新变化',
  completed: '处理完成',
};
type Scope = 'current' | 'history' | 'all';

function useTaskPage(scope: Scope) {
  const { revision } = useNota();
  const [depth, setDepth] = useState(1),
    [retry, setRetry] = useState(0);
  const [state, setState] = useState<{
    scope: Scope;
    data: TaskPage | null;
    loading: boolean;
    error: string;
  }>({ scope, data: null, loading: true, error: '' });
  const previousScope = useRef(scope);
  useEffect(() => {
    const controller = new AbortController();
    let alive = true;
    const changed = previousScope.current !== scope;
    previousScope.current = scope;
    if (changed) setDepth(1);
    setState((old) => ({
      scope,
      data: old.scope === scope ? old.data : null,
      loading: true,
      error: '',
    }));
    void (async () => {
      try {
        let cursor: string | null = null,
          data: TaskPage | null = null;
        const items = new Map<string, TaskSummary>();
        for (let page = 0; page < (changed ? 1 : depth); page++) {
          data = await api<TaskPage>(
            `/background-tasks?scope=${scope}${cursor ? `&cursor=${cursor}` : ''}`,
            { signal: controller.signal },
          );
          for (const task of data.tasks) items.set(task.id, task);
          cursor = data.next_cursor;
          if (!cursor) break;
        }
        if (alive && data)
          setState({
            scope,
            data: { ...data, tasks: [...items.values()] },
            loading: false,
            error: '',
          });
      } catch (error: any) {
        if (alive) setState((old) => ({ ...old, loading: false, error: error.message }));
      }
    })();
    return () => {
      alive = false;
      controller.abort();
    };
  }, [scope, depth, revision, retry]);
  return {
    ...state,
    data: state.scope === scope ? state.data : null,
    retry: () => setRetry((n) => n + 1),
    more: () => setDepth((n) => n + 1),
  };
}

function TaskDetails({ id }: { id: string }) {
  const context = useNota();
  const { user, action, navigate } = context;
  const r = useResource(`/background-tasks/${id}`);
  const data = r.data as TaskDetail | null;
  const [busy, setBusy] = useState(false),
    [processOpen, setProcessOpen] = useState(false);
  const task = data?.task;
  const mutate = async (operationId: string, kind: 'retry' | 'cancel') => {
    setBusy(true);
    try {
      await action(
        () => post(`/operations/${operationId}/${kind}`),
        kind === 'retry' ? '已重新排队，保留已完成的结果' : '已停止后续处理',
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <aside className="operation-detail panel task-detail" aria-label="后台任务详情">
      <ResourceNote resource={r} />
      {task && data && (
        <>
          <div className="section-heading">
            <h2>{task.title}</h2>
            <Status value={task.status} />
          </div>
          <p className="task-stage-description">{currentStages[task.stage] ?? '正在处理'}</p>
          <div className="operation-info">
            <span>任务来源</span>
            <strong>{task.source === 'schedule' ? '自动任务' : '外部触发'}</strong>
            <span>开始时间</span>
            <strong>{formatDate(task.created_at, user.timezone)}</strong>
            <span>最近进展</span>
            <strong>{formatDate(task.updated_at, user.timezone)}</strong>
          </div>
          <ol className="task-stages">
            {data.stages.map((stage) => (
              <li key={stage.operation_id}>
                <div>
                  <strong>{stage.label}</strong>
                  {stage.attempts > 1 && <small>已重试 {stage.attempts - 1} 次</small>}
                </div>
                <Status value={stage.status} />
              </li>
            ))}
          </ol>
          {data.error && (
            <p className="form-error" role="alert">
              {data.error}
            </p>
          )}
          {data.result && (
            <div className="task-saved-result">
              <Markdown text={data.result} />
            </div>
          )}
          <div className="operation-actions">
            {task.retry_operation_id && (
              <Button busy={busy} onClick={() => void mutate(task.retry_operation_id!, 'retry')}>
                <RefreshCw size={15} />
                {task.stage === 'delivery_failed' ? '重试交付' : '重试任务'}
              </Button>
            )}
            {task.reply_operation_id && (
              <Button
                onClick={() => {
                  followOperationDestination(context, {
                    view: 'chat',
                    target: task.message_id,
                    reply_operation_id: task.reply_operation_id!,
                  });
                }}
              >
                回到对话补充
              </Button>
            )}
            {task.message_id && !task.reply_operation_id && (
              <Button variant="secondary" onClick={() => navigate('chat', task.message_id!)}>
                查看对话结果 <ArrowUpRight size={14} />
              </Button>
            )}
            {task.cancel_operation_id && (
              <Button
                variant="secondary"
                busy={busy}
                onClick={() => void mutate(task.cancel_operation_id!, 'cancel')}
              >
                {data.stages[0].status === 'succeeded' ? '停止交付' : '取消任务'}
              </Button>
            )}
            {task.schedule_id && (
              <Button
                variant="ghost"
                onClick={() => navigate('agenda', `schedule:${task.schedule_id}`)}
              >
                查看自动任务
              </Button>
            )}
          </div>
          <details className="task-request">
            <summary>查看交办内容</summary>
            <p>{data.request}</p>
          </details>
          <details
            className="task-process"
            onToggle={(event) => setProcessOpen(event.currentTarget.open)}
          >
            <summary>查看查询过程</summary>
            {processOpen && (
              <ExecutionProcess
                operationId={task.id}
                cycle={data.stages[0].cycle}
                live={data.stages[0].status === 'running'}
              />
            )}
          </details>
        </>
      )}
    </aside>
  );
}

export function BackgroundTasksView() {
  const context = useNota();
  const { user, navigate, navigationTarget, toast } = context;
  const [scope, setScope] = useState<Scope>('current'),
    [selected, setSelected] = useState<string | null>(null),
    [locating, setLocating] = useState(false);
  const r = useTaskPage(scope);
  useEffect(() => {
    if (!navigationTarget) {
      setSelected(null);
      return;
    }
    let alive = true;
    setLocating(true);
    void api<{ destination: OperationDestination }>(`/operations/${navigationTarget}/destination`)
      .then(({ destination }) => {
        if (!alive) return;
        if (destination.view === 'tasks') {
          setSelected(destination.target);
          if (destination.target !== navigationTarget || location.hash.startsWith('#activity'))
            navigate('tasks', destination.target!);
        } else followOperationDestination(context, destination);
      })
      .catch((error) => {
        if (alive) toast(error.message, true);
      })
      .finally(() => {
        if (alive) setLocating(false);
      });
    return () => {
      alive = false;
    };
  }, [navigationTarget, user.id]);
  return (
    <div className="page-container background-tasks-page">
      <PageHeading
        eyebrow="WORKING WHILE YOU'RE AWAY"
        title="交给 Nota，回来查看进展。"
        description="管理自动任务和外部触发的查询，查看进展、处理阻塞或重试。"
      />
      <div className="tabs page-tabs task-tabs">
        {(
          [
            ['current', '进行中与待处理'],
            ['history', '历史记录'],
            ['all', '全部任务'],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            className={scope === value ? 'active' : ''}
            aria-pressed={scope === value}
            onClick={() => setScope(value)}
          >
            {label}
            {r.data && <span className="task-count">{r.data.counts[value]}</span>}
          </button>
        ))}
      </div>
      <ResourceNote resource={r} />
      <div className="activity-layout">
        <section className="operation-list panel" aria-label="后台任务列表">
          {r.data?.tasks.map((task) => (
            <button
              className={`operation-row ${selected === task.id ? 'selected' : ''}`}
              key={task.id}
              data-task-id={task.id}
              onClick={() => navigate('tasks', task.id)}
            >
              <div className="operation-icon">
                <Clock3 size={19} />
              </div>
              <div>
                <strong>{task.title}</strong>
                <span className="task-row-progress">
                  {currentStages[task.stage] ?? task.status}
                </span>
                <small>
                  {formatDate(task.created_at, user.timezone)} ·{' '}
                  {task.source === 'schedule' ? '自动任务' : '外部触发'}
                </small>
              </div>
              <Status value={task.status} />
              <ChevronRight size={16} />
            </button>
          ))}
          {!r.loading && !r.error && !r.data?.tasks.length && (
            <Empty
              icon={<Clock3 size={28} />}
              title={
                scope === 'current' ? '没有正在进行或待处理的后台任务' : '暂时没有后台任务记录'
              }
              description="自动任务开始执行后，会在这里显示进展。"
            />
          )}
          {r.data?.next_cursor && (
            <Button variant="ghost" className="task-load-more" busy={r.loading} onClick={r.more}>
              查看更多任务
            </Button>
          )}
        </section>
        {selected ? (
          <TaskDetails key={selected} id={selected} />
        ) : (
          <aside className="operation-detail panel execution-note">
            <Activity size={30} strokeWidth={1.2} />
            <h3>{locating ? '正在定位任务…' : '后台的进展，在这里查看。'}</h3>
            <p>选择一项任务，查看查询与交付进展，或处理需要你确认的事。</p>
          </aside>
        )}
      </div>
    </div>
  );
}
