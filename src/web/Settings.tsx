import React, { useState } from 'react';
import {
  UserRound,
  ShieldCheck,
  Plus,
  Copy,
  Link2,
  Activity,
  ChevronDown,
  LogOut,
} from 'lucide-react';
import { api, post, patch, remove, formatDate } from './api';
import { Button, Field, Modal, Confirm, useNota } from './ui';
import { PageHeading, useResource, ResourceNote } from './Views';
export function SettingsView() {
  const { user, caps, action, toast } = useNota();
  const [tab, setTab] = useState('profile'),
    [newToken, setNewToken] = useState<any>(null),
    [tokenModal, setTokenModal] = useState(false),
    [confirm, setConfirm] = useState<any>(null),
    [offset, setOffset] = useState(0),
    [loading, setLoading] = useState(false);
  const triggers = useResource('/triggers'),
    context = useResource('/context'),
    history = useResource(`/context/history?offset=${offset}&limit=30`);
  return (
    <div className="page-container settings-page">
      <PageHeading
        eyebrow="MAKE YOURSELF AT HOME"
        title="你的 Nota，你的方式。"
        description="管理个人资料、自动触发与便签历史。"
      />
      <div className="tabs page-tabs">
        {[
          ['profile', '个人与服务'],
          ['triggers', '外部触发'],
          ['context', '上下文与历史'],
        ].map(([v, l]) => (
          <button key={v} className={tab === v ? 'active' : ''} onClick={() => setTab(v)}>
            {l}
          </button>
        ))}
      </div>
      {tab === 'profile' && (
        <div className="settings-columns">
          <section className="panel settings-section">
            <div className="section-heading">
              <h2>个人资料</h2>
              <UserRound size={18} />
            </div>
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                const data = Object.fromEntries(new FormData(e.currentTarget));
                setLoading(true);
                await action(() => patch('/me', data), '个人资料已更新');
                setLoading(false);
              }}
            >
              <Field label="称呼">
                <input name="name" defaultValue={user.name} required maxLength={60} />
              </Field>
              <Field label="邮箱">
                <input value={user.email} disabled />
              </Field>
              <Field
                label="日程时区"
                hint="免费额度仍以北京时间 00:00 重置，不受日程时区修改影响。"
              >
                <select name="timezone" defaultValue={user.timezone}>
                  {[
                    'Asia/Shanghai',
                    'Asia/Hong_Kong',
                    'Asia/Tokyo',
                    'Asia/Singapore',
                    'Europe/London',
                    'America/New_York',
                    'America/Los_Angeles',
                    'UTC',
                  ].map((t) => (
                    <option key={t}>{t}</option>
                  ))}
                </select>
              </Field>
              <Button type="submit" busy={loading}>
                保存资料
              </Button>
            </form>
            <div className="settings-divider" />
            <button
              className="text-button danger-text"
              onClick={() =>
                void action(async () => {
                  const r = await post('/auth/logout');
                  localStorage.removeItem('nota:last-user');
                  window.dispatchEvent(new Event('nota:unauthorized'));
                  return r;
                })
              }
            >
              <LogOut size={16} />
              退出登录
            </button>
          </section>
          <section className="panel settings-section">
            <div className="section-heading">
              <h2>服务连接</h2>
              <Activity size={18} />
            </div>
            <div className="service-row">
              <div>
                <strong>GMI · Nota Agent</strong>
                <small>负责理解交办、检索记忆与调用工具</small>
              </div>
              <span className={`status ${caps.agentConfigured ? 'good' : 'bad'}`}>
                {caps.agentConfigured ? '已配置' : '未配置'}
              </span>
            </div>
            <div className="service-row">
              <div>
                <strong>OpenAI · 录音转写</strong>
                <small>{caps.asrModel ?? 'gpt-transcribe'}</small>
              </div>
              <span className={`status ${caps.asrConfigured ? 'good' : 'bad'}`}>
                {caps.asrConfigured ? '已配置' : '待配置'}
              </span>
            </div>
            <div className="service-row">
              <div>
                <strong>站内提醒</strong>
                <small>后台到点投递，对话和通知中查看</small>
              </div>
              <span className="status good">已启用</span>
            </div>
            <div className="privacy-card">
              <ShieldCheck size={24} strokeWidth={1.3} />
              <h3>凭证留在服务端</h3>
              <p>浏览器不会接收 GMI / OpenAI 密钥。你的录音、任务、记忆和上下文归属当前账号。</p>
              <p>当前不接入系统日历账户，日程可导出为 ICS；不发送邮件或短信。</p>
            </div>
          </section>
        </div>
      )}
      {tab === 'triggers' && (
        <>
          <div className="settings-intro">
            <div>
              <h2>让外部事件，回到同一个 Nota</h2>
              <p>
                来自你的服务、设备或工作流的事件，可激活当前账号的 Agent。每个新事件计为一次 AI
                处理。
              </p>
            </div>
            <Button onClick={() => setTokenModal(true)}>
              <Plus size={16} />
              创建触发器密钥
            </Button>
          </div>
          <section className="panel settings-section">
            <h3>调用方式</h3>
            <p className="muted">
              用 Bearer Token 调用。相同 event_id 只处理一次，重试不会重复创建任务。
            </p>
            <pre className="code-sample">{`POST ${location.origin}/api/triggers/fire\nAuthorization: Bearer <你的触发器密钥>\nContent-Type: application/json\n\n{\n  "event_id": "my-event-0001",\n  "text": "请查看我今天的待办并给出安排。"\n}`}</pre>
            <p className="source-note">
              密钥只在创建时显示。持有者能向你的 Nota 交办并使用你的额度，请保存在自己的服务中。
            </p>
          </section>
          <ResourceNote resource={triggers} />
          <div className="trigger-list panel">
            {triggers.data?.tokens.map((t: any) => (
              <div key={t.id} className="trigger-row">
                <span className="audio-tile">
                  <Link2 size={20} />
                </span>
                <div>
                  <strong>{t.name}</strong>
                  <small>
                    创建 {formatDate(t.created_at, user.timezone)}
                    {t.last_used_at
                      ? ` · 最近使用 ${formatDate(t.last_used_at, user.timezone)}`
                      : ' · 尚未使用'}
                  </small>
                </div>
                <Button
                  variant="secondary"
                  onClick={() => setConfirm({ kind: 'trigger', id: t.id, title: t.name })}
                >
                  撤销
                </Button>
              </div>
            ))}
            {!triggers.loading && !triggers.data?.tokens.length && (
              <p className="small-empty">
                还没有外部触发器。定时交办可在“日程与待办 → 自动任务”中设置。
              </p>
            )}
          </div>
        </>
      )}
      {tab === 'context' && (
        <>
          <ResourceNote resource={context} />
          <section className="context-summary panel">
            <div>
              <span className="eyebrow">ONE CONTINUOUS CONVERSATION</span>
              <h2>正常累加，接近阈值再压缩。</h2>
              <p>
                每位用户维护独立的 Pi SDK
                会话。压缩后保留近期上下文与摘要，原始历史仍可通过检索工具和下方记录复查。
              </p>
              <small>{context.data?.model}</small>
            </div>
            <div className="context-numbers">
              <span>
                模型上下文容量
                <strong>
                  {Number(context.data?.context_window ?? 1048576).toLocaleString()}{' '}
                  <small>tokens</small>
                </strong>
              </span>
              <span>
                压缩阈值
                <strong>
                  {Number(context.data?.compact_at ?? 0).toLocaleString()} <small>tokens</small>
                </strong>
              </span>
              <span>
                当前估算
                <strong>
                  {Number(context.data?.state?.context_tokens ?? 0).toLocaleString()}{' '}
                  <small>tokens</small>
                </strong>
              </span>
              <span>
                已压缩
                <strong>
                  {context.data?.state?.compactions ?? 0} <small>次</small>
                </strong>
              </span>
            </div>
          </section>
          <div className="section-heading">
            <div>
              <h2>原始会话记录</h2>
              <p className="source-note">
                展示用户消息、工具交互与压缩摘要；私有推理不会显示。累计用量与单次上下文容量是两个指标。
              </p>
            </div>
            <span className="tiny-tag">{history.data?.total ?? 0} 条</span>
          </div>
          <ResourceNote resource={history} />
          <section className="context-history panel">
            {history.data?.entries.map((e: any, i: number) => (
              <details key={`${offset}:${i}`}>
                <summary>
                  <span className="history-role">
                    {e.type === 'compaction'
                      ? '压缩摘要'
                      : e.role === 'user'
                        ? '用户'
                        : e.role === 'assistant'
                          ? 'Nota'
                          : (e.toolName ?? e.role)}
                  </span>
                  <time>{e.timestamp ? formatDate(e.timestamp, user.timezone) : ''}</time>
                  <ChevronDown size={14} />
                </summary>
                <pre>
                  {typeof e.content === 'string'
                    ? e.content
                    : JSON.stringify(e.content ?? e.summary, null, 2)}
                </pre>
              </details>
            ))}
            {!history.loading && !history.data?.entries.length && (
              <p className="small-empty">还没有 SDK 会话记录，发起一次交办后会显示。</p>
            )}
          </section>
          <div className="pagination">
            <Button
              variant="secondary"
              disabled={offset === 0}
              onClick={() => setOffset((n) => Math.max(0, n - 30))}
            >
              上一页
            </Button>
            <span>第 {Math.floor(offset / 30) + 1} 页</span>
            <Button
              variant="secondary"
              disabled={history.data?.next === null || !history.data}
              onClick={() => setOffset(history.data.next)}
            >
              下一页
            </Button>
          </div>
        </>
      )}
      {tokenModal && (
        <Modal title="创建外部触发器" onClose={() => setTokenModal(false)}>
          <form
            className="modal-form"
            onSubmit={async (e) => {
              e.preventDefault();
              const name = new FormData(e.currentTarget).get('name');
              const result = await action(() => post('/triggers', { name }));
              if (result) {
                setTokenModal(false);
                setNewToken(result);
              }
            }}
          >
            <Field label="名称">
              <input name="name" required maxLength={100} placeholder="例如：我的工作流" />
            </Field>
            <p className="source-note">
              此密钥只显示一次，可调用你的 Nota 业务工具并占用 AI 额度。可随时在本页撤销。
            </p>
            <footer className="modal-actions">
              <Button type="submit">创建密钥</Button>
            </footer>
          </form>
        </Modal>
      )}
      {newToken && (
        <Modal title="保存你的触发器密钥" onClose={() => setNewToken(null)}>
          <div className="modal-form">
            <p>此密钥只显示这一次，请保存到你的服务配置。</p>
            <input
              className="token-display"
              value={newToken.token}
              readOnly
              onFocus={(e) => e.target.select()}
              aria-label="新触发器密钥"
            />
            <Button
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(newToken.token);
                  toast('密钥已复制');
                } catch {
                  toast('请选中上方密钥手动复制', true);
                }
              }}
            >
              <Copy size={16} />
              复制密钥
            </Button>
            <p className="source-note">{newToken.warning}</p>
          </div>
        </Modal>
      )}
      {confirm && (
        <Confirm
          title="撤销这个触发器？"
          body={`“${confirm.title}”的旧密钥将立即失效。`}
          danger
          onClose={() => setConfirm(null)}
          onConfirm={() => action(() => remove(`/triggers/${confirm.id}`), '已移除')}
        />
      )}
    </div>
  );
}
