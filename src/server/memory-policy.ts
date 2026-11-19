import { z } from 'zod';
import type { SourceDocument } from './sources.js';

export const memoryInputSchema = z.object({
  subject: z.string().trim().min(1).max(200),
  predicate: z.string().trim().min(1).max(100),
  value: z.string().trim().min(1).max(2000),
  evidence: z.string().min(2).max(2000).optional(),
  person_name: z.string().max(100).nullish(),
  organization: z.string().max(200).nullish(),
  scope: z
    .string()
    .max(300)
    .nullish()
    .transform((value) => value ?? ''),
  kind: z.enum(['fact', 'preference', 'relationship', 'goal']).optional(),
  assertion: z.enum(['asserted', 'hypothetical', 'uncertain', 'question']).default('asserted'),
  operation: z.enum(['auto', 'replace']).default('auto'),
  effective_at: z.string().nullish(),
  effective_date: z.string().nullish(),
  time_expression: z.string().max(200).nullish(),
  expires_at: z.string().datetime({ offset: true }).nullish(),
  certainty: z.enum(['stated', 'tentative', 'confirmed', 'goal']).default('stated'),
  qualifiers: z
    .union([z.string(), z.array(z.string()).max(20)])
    .nullish()
    .transform((value) => (Array.isArray(value) ? value.join('；') : (value ?? '')))
    .pipe(z.string().max(1000)),
  purpose: z.enum(['durable', 'event_context', 'business', 'transient']).default('durable'),
  retention: z.enum(['persistent', 'temporary']).default('persistent'),
  business_refs: z
    .array(z.object({ kind: z.enum(['event', 'todo', 'reminder']), id: z.uuid() }))
    .max(12)
    .default([]),
});
export type MemoryInput = z.infer<typeof memoryInputSchema>;
export type RecallMode = 'current' | 'history' | 'timeline';

export function normalized(text: string) {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s，。；、：！？,.!?:;“”"'‘’]/g, '');
}
export function subjectKey(text: string) {
  const n = normalized(text);
  return ['我', '用户', '当前用户', '本人', '口述者', 'user', 'self'].includes(n) ? 'self' : n;
}
const predicates: Record<string, string> = {
  报价: '报价',
  报价金额: '报价',
  项目报价: '报价',
  偏好: '偏好',
  喜欢: '偏好',
  饮食偏好: '偏好',
  用户偏好: '偏好',
  负责: '职责',
  负责人: '职责',
  职责: '职责',
  负责事项: '职责',
  所在公司: '任职',
  任职: '任职',
  就职: '任职',
  工作单位: '任职',
  所属公司: '任职',
  目标: '目标',
  计划: '目标',
  阶段目标: '目标',
};
export function canonicalPredicate(value: string) {
  if (/偏好|^(?:喜欢|喜欢喝|喜欢吃|爱喝|爱吃)$/.test(normalized(value))) return '偏好';
  return predicates[normalized(value)] ?? value.trim();
}
export function canonicalScope(item: Pick<MemoryInput, 'predicate' | 'value' | 'scope'>) {
  if (canonicalPredicate(item.predicate) !== '偏好')
    return /^(?:无|无特殊条件|无额外条件|未注明|未提及|未说明|未明确|未知|默认|当前|当前报价|最新报价|更新后|原报价|人民币|RMB|CNY|USD|美元|null)$/i.test(
      item.scope.trim(),
    )
      ? ''
      : item.scope.trim();
  const text = `${item.predicate} ${item.value} ${item.scope}`;
  const domains: [RegExp, string][] = [
    [/茶|咖啡|饮料|饮品/, '饮品'],
    [/饮食|吃|口味|辣|食物/, '饮食'],
    [/编程|框架|开发|Python|React|Vue|JavaScript/i, '开发技术'],
    [/答复|回答|回复|简洁|详细/, '回复方式'],
    [/运动|游泳|跑步|健身/, '运动'],
  ];
  return domains.find(([pattern]) => pattern.test(text))?.[1] ?? item.scope.trim();
}
export function groundedScope(item: MemoryInput, evidence: string) {
  const scope = canonicalScope(item);
  if (canonicalPredicate(item.predicate) === '偏好') return scope;
  return scope
    .split(/[，,；;、/]/)
    .map((s) => s.trim())
    .filter(
      (s) =>
        s &&
        normalized(s) !== normalized(item.subject) &&
        normalized(s) !== normalized(item.value) &&
        normalized(evidence).includes(normalized(s)),
    )
    .sort()
    .join('、');
}
export function conciseValue(item: Pick<MemoryInput, 'predicate' | 'value'>) {
  return canonicalPredicate(item.predicate) === '偏好'
    ? item.value.split(/[，,；;](?:以后)?(?:不再|以前|之前|原来)/)[0].trim()
    : item.value;
}
export function chineseNumber(text: string): number {
  if (/^\d+(?:\.\d+)?$/.test(text)) return Number(text);
  const digits: Record<string, number> = {
    零: 0,
    〇: 0,
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
  };
  const [integer, decimal] = text.split('点');
  let total = 0,
    section = 0,
    number = 0;
  for (const c of integer) {
    if (c in digits) number = digits[c];
    else if (c === '十' || c === '百' || c === '千') {
      section += (number || 1) * { 十: 10, 百: 100, 千: 1000 }[c];
      number = 0;
    } else if (c === '万' || c === '亿') {
      total += (section + number) * (c === '万' ? 10000 : 100000000);
      section = 0;
      number = 0;
    } else return NaN;
  }
  const fraction = decimal ? Number(`0.${[...decimal].map((c) => digits[c] ?? c).join('')}`) : 0;
  return total + section + number + fraction;
}
export function amounts(text: string): string[] {
  const compact = text.normalize('NFKC').replace(/[,，\s]/g, '');
  return [
    ...compact.matchAll(
      /([零〇一二两三四五六七八九十百千\d]+(?:[.点][零〇一二两三四五六七八九\d]+)?)(亿|万|千)?(?:人民币|美元|美金|元|块|人民币元)?/g,
    ),
  ].map((m) => {
    const n = chineseNumber(m[1]) * ({ 亿: 1e8, 万: 1e4, 千: 1e3 }[m[2]] ?? 1);
    return `${/美元|美金/.test(m[0]) ? 'USD' : 'CNY'}:${Number(n.toFixed(6))}`;
  });
}
export function valueKey(value: string, predicate: string) {
  const values = amounts(value);
  return (canonicalPredicate(predicate) === '报价' || /元|块|美元|美金|人民币/.test(value)) &&
    values.length === 1
    ? `${values[0]}:${normalized(value).replace(/[零〇一二两三四五六七八九十百千万亿点\d.]+(?:人民币|美元|美金|元|块)?/g, '')}`
    : normalized(conciseValue({ value, predicate })).replace(
        canonicalPredicate(predicate) === '偏好' ? /^(?:喝|吃|使用|选择|用)/ : /^$/,
        '',
      );
}
export function memoryPermitted(text: string, instruction = '') {
  const s = `${instruction}\n${text}`;
  return (
    !/(?:只|仅)(?:需|做|进行|生成|保存|整理)?(?:转写|摘要)/.test(instruction) &&
    !/^(?:请|帮我)?(?:只|仅)(?:需|做|进行|生成|保存|整理)?(?:转写|摘要)/.test(text.trim()) &&
    !/(?:不要|不需|不再|禁止|不允许|别)(?:要)?[^。；\n]{0,16}(?:记住|记忆|提取人物|保存人物|记录人物)/.test(
      s,
    ) &&
    !/(?:不|无需)(?:提取|保存|记录)[^。；\n]{0,20}(?:记忆|关系|人物)/.test(s) &&
    !/(?:只|仅)(?:用|供)于本轮/.test(s)
  );
}
export function statementContext(source: SourceDocument, evidence: string) {
  const i = source.text.indexOf(evidence);
  if (i < 0) return evidence;
  const start =
    Math.max(source.text.lastIndexOf('。', i - 1), source.text.lastIndexOf('\n', i - 1)) + 1;
  const after = source.text.slice(i + evidence.length);
  const end = after.search(/[。\n]/);
  return source.text.slice(
    start,
    i + evidence.length + (end < 0 ? Math.min(after.length, 80) : end + 1),
  );
}
export function unsupportedReason(item: MemoryInput, evidence: string, context: string) {
  if (item.assertion !== 'asserted')
    return `这是一条${{ hypothetical: '假设', uncertain: '不确定信息', question: '疑问' }[item.assertion]}，未写入确定记忆`;
  if (/(?:如果|假如|假设|只是设想|尚未发生|还没发生|不确定|是不是|是否|可能会|也许)/.test(context))
    return '原文是条件、疑问或不确定陈述';
  if (item.person_name && !normalized(evidence).includes(normalized(item.person_name)))
    return '引用没有支持这条人物关联';
  if (item.organization && !normalized(evidence).includes(normalized(item.organization)))
    return '引用没有支持这条组织关联';
  if (
    canonicalPredicate(item.predicate) === '报价' ||
    /(?:\d|[零〇一二两三四五六七八九十百千万亿点])\s*(?:万|亿|千)?(?:人民币|美元|美金|元|块)/.test(
      item.value,
    )
  ) {
    const claimed = amounts(item.value),
      supported = amounts(evidence);
    if (!claimed.length || claimed.some((n) => !supported.includes(n)))
      return '抽取的金额与原文不一致';
  } else {
    const v = normalized(item.value).replace(
      /^(?:用户|我)?(?:更|最|比较)?(?:偏好|喜欢|爱喝|负责|是|为)/,
      '',
    );
    if (
      v.length > 1 &&
      v.length <= 80 &&
      !normalized(evidence).includes(v) &&
      !/^(?:是|否|不|没有|已|尚未)/.test(v)
    )
      return '抽取值需要更直接的原文支持';
  }
  return null;
}
export function inferredKind(item: MemoryInput) {
  const p = canonicalPredicate(item.predicate);
  return (
    item.kind ??
    (p === '偏好'
      ? 'preference'
      : p === '目标'
        ? 'goal'
        : ['职责', '任职'].includes(p)
          ? 'relationship'
          : 'fact')
  );
}
export function explicitReplacement(item: MemoryInput, context: string) {
  return (
    /(?:改成|改为|更正|纠正|作废|不再|更新为|替换|变成|搬到|换成|最新报价|现在(?:是|改|更|喜欢|住|在))/.test(
      context,
    ) ||
    (item.operation === 'replace' && /现在|目前|最新|之前|原来|改|换|更正/.test(context))
  );
}
export function activity(fact: any, now = new Date()) {
  if (fact.pinned) return Number(fact.strength ?? 1);
  const days = Math.max(
    0,
    (+now - +new Date(fact.last_reinforced_at ?? fact.created_at)) / 86400000,
  );
  return Number(fact.strength ?? 1) * Math.pow(0.5, days / Number(fact.half_life_days ?? 180));
}
export function factTime(source: SourceDocument, item: MemoryInput, evidence: string) {
  const zone = source.timezone;
  const expression =
    item.time_expression && evidence.includes(item.time_expression)
      ? item.time_expression
      : evidence;
  const relative = /(前天|昨天|今天|明天|后天)/.exec(expression);
  const supportsDay = (value: string) => {
    const [y, m, d] = value.split('-').map(Number);
    for (const match of evidence.matchAll(
      /(\d{4})\s*(?:年|[-/.])\s*(\d{1,2})\s*(?:月|[-/.])\s*(\d{1,2})(?:日|号)?/g,
    ))
      if (+match[1] === y && +match[2] === m && +match[3] === d) return true;
    if (!source.recordedAt || !zone) return false;
    const sourceYear = Number(
      new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric' }).format(
        new Date(source.recordedAt),
      ),
    );
    return (
      sourceYear === y &&
      [...evidence.matchAll(/(\d{1,2})月(\d{1,2})(?:日|号)/g)].some(
        (match) => +match[1] === m && +match[2] === d,
      )
    );
  };
  let day: string | null = null;
  if (relative && source.recordedAt && zone) {
    const local = new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(source.recordedAt));
    const d = new Date(`${local}T00:00:00Z`);
    d.setUTCDate(
      d.getUTCDate() + ({ 前天: -2, 昨天: -1, 今天: 0, 明天: 1, 后天: 2 }[relative[1]] ?? 0),
    );
    day = d.toISOString().slice(0, 10);
  } else if (
    !relative &&
    item.effective_date &&
    /^\d{4}-\d{2}-\d{2}$/.test(item.effective_date) &&
    supportsDay(item.effective_date)
  )
    day = item.effective_date;
  if (
    day &&
    Number.isFinite(Date.parse(`${day}T00:00:00Z`)) &&
    new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) === day
  )
    return {
      effective_at: null,
      effective_date: day,
      time_precision: 'day',
      time_expression: relative?.[1] ?? item.time_expression ?? null,
    };
  if (
    !relative &&
    item.effective_at &&
    z.string().datetime({ offset: true }).safeParse(item.effective_at).success &&
    zone &&
    supportsDay(
      new Intl.DateTimeFormat('en-CA', { timeZone: zone }).format(new Date(item.effective_at)),
    ) &&
    /(?:\d{1,2}:\d{2}|[零〇一二两三四五六七八九十\d]{1,3}点)/.test(evidence)
  )
    return {
      effective_at: item.effective_at,
      effective_date: null,
      time_precision: 'instant',
      time_expression: item.time_expression ?? null,
    };
  return {
    effective_at: null,
    effective_date: null,
    time_precision: 'unknown',
    time_expression: item.time_expression ?? relative?.[1] ?? null,
  };
}
