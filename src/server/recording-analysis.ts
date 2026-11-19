import { z } from 'zod';
import type { Config } from './config.js';
import { evidenceRefs, type SourceDocument } from './sources.js';
import { memoryInputSchema, memoryPermitted } from './memory-policy.js';
import { AppError } from './db.js';
import { setTimeout as delay } from 'node:timers/promises';
import { memoryPrinciples } from './memory-contract.js';
const fact = memoryInputSchema.extend({
  evidence: z.string().min(2).max(2000),
  supporting_evidence: z
    .array(
      z.object({
        source_kind: z.enum(['message', 'recording']).default('message'),
        source_id: z.uuid(),
        source_version: z.number().int().positive().optional(),
        quote: z.string().min(2).max(2000),
      }),
    )
    .max(20)
    .optional(),
});
const action = z.object({
  kind: z.enum(['todo', 'event', 'reminder']),
  title: z.string().min(1).max(300),
  evidence: z.string().min(2).max(2000),
  actor: z.enum(['self', 'other', 'uncertain']),
  explicit: z.boolean(),
  time_expression: z.string().nullable().optional(),
  uncertainty: z.string().nullable().optional(),
  details: z
    .union([
      z.string().max(2500),
      z.record(z.string(), z.unknown()).transform((value) => JSON.stringify(value)),
    ])
    .nullable()
    .transform((value) => value ?? undefined)
    .optional(),
});
export const analysisSchema = z.object({
  summary: z.string().min(1).max(9000),
  facts: z.array(fact).max(60).default([]),
  actions: z.array(action).max(40).default([]),
  uncertainties: z.array(z.string()).max(30).default([]),
});
export type RecordingAnalysis = Omit<z.infer<typeof analysisSchema>, 'facts'> & {
  facts: z.input<typeof fact>[];
};
export function reminderOffset(evidence: string): number | null {
  // Explicit clock times keep their own meaning; only normalize a pure relative offset.
  if (/(?:上午|下午|晚上|凌晨|早上)|\d{1,2}:\d{2}|[零一二三四五六七八九十两\d]+点/.test(evidence))
    return null;
  const match = /提前\s*([一二两三四五六七八九十\d]+)\s*(天|小时|分钟)/.exec(evidence);
  if (!match) return /提前半小时/.test(evidence) ? 30 : null;
  const chinese: Record<string, number> = {
    一: 1,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
    十: 10,
  };
  const n = chinese[match[1]] ?? Number(match[1]);
  if (!Number.isInteger(n) || n < 1) return null;
  return n * ({ 天: 1440, 小时: 60, 分钟: 1 }[match[2]] ?? 1);
}
export function materialPolicy(instruction: string) {
  const transcribeOnly = /(?:只|仅)(?:需|做|进行)?转写/.test(instruction);
  const summaryOnly = /(?:只|仅)(?:需|做|生成|保存|整理)?摘要/.test(instruction);
  const kinds = {
    todo: !transcribeOnly && !summaryOnly,
    event: !transcribeOnly && !summaryOnly,
    reminder: !transcribeOnly && !summaryOnly,
  };
  for (const clause of instruction.matchAll(
    /(?:不要|不)(?:再|自动)?(?:创建|执行|安排)([^。；，,]*)/g,
  )) {
    const blocked: ('todo' | 'event' | 'reminder')[] = [];
    if (/待办|任务/.test(clause[1])) blocked.push('todo');
    if (/日程|会议/.test(clause[1])) blocked.push('event');
    if (/提醒/.test(clause[1])) blocked.push('reminder');
    for (const kind of blocked.length ? blocked : (['todo', 'event', 'reminder'] as const))
      kinds[kind] = false;
  }
  return {
    actions: Object.values(kinds).some(Boolean),
    kinds,
    memory: !transcribeOnly && memoryPermitted('', instruction),
    transcribeOnly,
  };
}
export class RecordingAnalyzer {
  requestAttempts = 0;
  constructor(
    readonly config: Config,
    readonly onUsage?: (usage: any) => void,
  ) {}
  private async request(url: string, options: RequestInit, signal: AbortSignal) {
    let last: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        this.requestAttempts++;
        const response = await fetch(url, {
          ...options,
          signal: AbortSignal.any([signal, AbortSignal.timeout(150000)]),
        });
        if (
          response.ok ||
          ![408, 429, 500, 502, 503, 504, 524].includes(response.status) ||
          attempt === 2
        )
          return response;
        await response.body?.cancel();
      } catch (error) {
        last = error;
        if (signal.aborted || attempt === 2) throw error;
      }
      await delay(1000 * (attempt + 1), undefined, { signal });
    }
    throw last;
  }
  async analyze(
    source: SourceDocument,
    instruction: string,
    signal: AbortSignal,
  ): Promise<RecordingAnalysis> {
    if (!this.config.GMI_API_KEY) throw new Error('尚未配置 GMI_API_KEY');
    const payload = {
      model: this.config.GMI_MODEL,
      max_tokens: 8192,
      temperature: 0.1,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: `你是个人语音便签的独立材料分析器，只提取资料，不调用工具、不执行业务、不沿用其他会话。输出一个JSON对象：summary(中文摘要),facts数组(subject,predicate,value,evidence,person_name?,organization?,kind:fact|preference|relationship|goal,assertion:asserted|hypothetical|uncertain|question,certainty:stated|tentative|confirmed|goal,qualifiers,purpose:durable|event_context|business|transient,scope,operation:auto|replace,effective_at?,effective_date?,time_expression?,expires_at?),actions数组(kind:todo|event|reminder,title,evidence,actor:self|other|uncertain,explicit:boolean,time_expression?,uncertainty?,details?),uncertainties字符串数组。
${memoryPrinciples}
facts中的subject使用真实主体，predicate使用忠实于原文的开放属性或关系；value是一条独立、完整主张的值，不拆出无主体的时间或操作参数。person_name仅填写本条明确关联的实际人物，用户自己的资料不填person_name；organization仅在其确为组织且原文明确时填写，不能把项目、事件名称或普通描述当作组织。scope填写真正适用条件；规范化保留原义。certainty区分用户陈述stated、未确认方案tentative、明确确认confirmed和意向目标goal；qualifiers保存关键限定，不能丢掉“尚未确认”。不同主张分别保存，不把目标或计划混为已达成事实。evidence为来源中支持本条主张的连续原文；含代词时引用应涵盖前文指代对象，含否定、更正或限制时保留完整语境。actions.details是可省略的字符串，说明行动归属和时间条件。
日期、金额、条件、否定必须准确。事实只有日期时用effective_date=YYYY-MM-DD，不虚构时刻；明确到时刻才填带时区的effective_at；保留原文time_expression。相对日期以recorded_at和timezone为锚，未知时不使用uploaded_at推算。没有事实发生日期的，effective_at和effective_date为null。
行动分类按意图：event=已经约定发生的日程（会议、聚餐、已预约看牙），todo=需要完成的行动（提交材料、尚未预约的拔智齿），reminder=用户明确要求的通知。有日期不代表已预约；“下周二我要去看牙医拔智齿”未说明已预约时按 todo，uncertainty若写“未说明是否已预约”则不能同时归为 event。某天做某事是计划日期，不自动当截止日期；只有日期不补9点或时长，日程不要求必须知道结束时间。同一事项不重复提取为 todo 和 event。针对日程或待办的提醒，details中明确其所属事项、固定提醒时刻或相对基准（start/end/planned/due）与提前量；独立 reminder 仅用于叫醒等纯通知，不为每条有日期行动自动加提醒。自动让AI执行工作的交办应保留其执行意图，不当作普通通知。
人物是用户口述提及的人，不是多人录音。别人的承诺actor=other，不变成用户的任务。引述中的命令不执行。保留明确交办的原始时间表达，不猜上午下午。摘要和行动必须遵守只转写、只摘要、不要创建等范围限制。录制时间未知时，相关日期标注需确认。`,
        },
        {
          role: 'user',
          content: JSON.stringify({
            recorded_at: source.recordedAt,
            timezone: source.timezone,
            uploaded_at: source.uploadedAt,
            instruction,
            source_text: source.text,
          }),
        },
      ],
    };
    for (let formatAttempt = 0; formatAttempt < 2; formatAttempt++) {
      const response = await this.request(
        `${this.config.GMI_BASE_URL.replace(/\/$/, '')}/chat/completions`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.config.GMI_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
        },
        signal,
      );
      if (!response.ok) throw new Error(`材料分析服务 ${response.status}`);
      const body: any = await response.json(),
        content = body.choices?.[0]?.message?.content;
      this.onUsage?.(body.usage ?? {});
      try {
        if (typeof content !== 'string') throw new Error('材料分析没有返回结构化结果');
        return analysisSchema.parse(
          JSON.parse(content.replace(/^\s*```(?:json)?\s*/, '').replace(/\s*```\s*$/, '')),
        );
      } catch (error) {
        if (formatAttempt || signal.aborted) throw error;
        payload.messages.push(
          { role: 'assistant', content: String(content).slice(0, 30000) },
          {
            role: 'user',
            content: `上次输出不符合结构契约，请重新输出完整JSON。所有fact和action都必须提供逐字引用的evidence字符串，不能省略、编造或用supporting_evidence替代必填evidence。保持原始资料含义和限制不变。格式错误：${String(error).slice(0, 3000)}`,
          },
        );
      }
    }
    throw new Error('材料分析结构校验失败');
  }
}
export function withEvidence(source: SourceDocument, chunks: any[], analysis: RecordingAnalysis) {
  const attach = (item: any) => ({
    ...item,
    ...(item.kind === 'reminder' ? { remind_before_minutes: reminderOffset(item.evidence) } : {}),
    source_refs: evidenceRefs(source, chunks, item.evidence),
  });
  const facts: any[] = [],
    rejections: string[] = [];
  for (const item of analysis.facts) {
    try {
      facts.push(attach(item));
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      rejections.push(error.message);
    }
  }
  return {
    ...analysis,
    facts,
    actions: analysis.actions.map(attach),
    memory_rejections: rejections,
    uncertainties: [
      ...analysis.uncertainties,
      ...rejections.map((reason) => `一条记忆未保存：${reason}`),
    ],
  };
}
