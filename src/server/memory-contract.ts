import { z } from 'zod';

export const decisionSchema = z.object({
  action: z.enum(['ADD', 'MERGE', 'SUPERSEDE', 'CONFLICT', 'IGNORE', 'LINK']),
  target_ids: z.array(z.uuid()).max(12).default([]),
  classification: z.enum(['durable', 'event_context', 'business', 'transient']),
  evidence_supported: z.boolean(),
  reason: z.string().min(1).max(1200),
  canonical: z
    .object({
      subject: z.string().min(1).max(200).optional(),
      predicate: z.string().min(1).max(100).optional(),
      value: z.string().min(1).max(2000).optional(),
      scope: z.string().max(300).optional(),
      certainty: z.enum(['stated', 'tentative', 'confirmed', 'goal']).optional(),
      qualifiers: z.string().max(1000).optional(),
    })
    .optional(),
});
export type MemoryDecision = z.infer<typeof decisionSchema>;
// Snapshots are supplied by the server, never trusted from a model's tool arguments.
export type ReviewedMemory = MemoryDecision & {
  snapshots: any[];
  proposal_id?: string;
  repair?: boolean;
};

export const memoryPrinciples = `长期记忆是通用的个人资料与实体关系，属性和关系名称是开放的，不限定行业或题目样例。关注人物与组织关系、职责与协作、居住与生活背景、可复用的偏好和约束、重要事件的背景与结果、持续目标等；这些只是例子，不是白名单。
先判断信息的职责再抽取。日程的日期、时间、地点、时长，待办的执行参数，提醒的提前量属于业务对象，不能拆成长期事实。“19点”“大约两小时”“提前提醒我”不具备独立记忆含义。已有业务对象用真实ID关联，不复制它的易变字段。一次约会不推断为朋友、客户等长期关系。尚未创建的行动也仍然是行动，不因没有ID就变成记忆。
business专指本应用日程、待办、提醒的执行字段，不是“所有工作/商业信息”。本应用没有另一个项目、合同或人物资料数据库；不可假设重要背景已在别处保存。工作职责、活动成果、设备属性、协商条件、重要数值与持续目标等仍可构成durable或event_context记忆。按长期复用价值判断，既不优先抽取某类数值，也不因它属于工作信息就一律忽略。
长期通用偏好可以记忆，例如“以后所有安排默认提前半小时通知”；不能只凭出现提醒、时间等词就过滤。事件背景和重要结果可记忆，但计划发生与已经发生必须区分；普通零散经历没有复用价值时忽略。
结合完整语境解析“他、这个、那件事”，不得凭相似度猜身份。多个爱好、朋友、职责可以同时成立，不把所有不同值都当成替换。明确变化只替换被指明的旧事实，不清楚时待确认。
原文引用必须逐字真实；抽取后的表达可以是原文的忠实概括或规范化，不要求抽取值也是连续子串。“项目的负责人”和“项目负责人”可等价，但否定、条件、数量、单位、币种、时间及确认状态必须保留。“对方提出的数值尚未确认”和“用户期望的目标值”不可写成已经达成的事实。
未确认的方案本身可以明确被陈述：assertion=asserted、certainty=tentative、qualifiers保留未确认；不要把它误写成没有依据的猜测而丢弃。确认状态和条件附在完整主张上，不额外拆出脱离主张的状态碎片。明确表达的目标使用certainty=goal。
不保存提问、假设、临时操作指令、助手推测或网页内容为用户已确定的事实。用户只转写、只摘要、不要记忆或只用于本轮时遵守限制。已有来源重复处理不算新证据，压缩摘要及助手重复转述也不算独立证据。`;

export const memoryDecisionInstructions = `${memoryPrinciples}
判断候选与相关旧记忆：ADD新增独立信息；MERGE同一事实的等价表达并增加真实证据；SUPERSEDE明确更正或状态变化，保留旧版本；CONFLICT含义、身份或适用范围无法确定；IGNORE业务字段、临时内容、无依据或不应记忆的内容；LINK只关联已有业务对象，不制造长期事实。
只使用提供的实际target_ids。MERGE/SUPERSEDE/CONFLICT需指出相关目标，ADD允许多个独立值并存。语义相似只用于召回候选，不能作为等价或同一人物的证明。不同确认状态和适用条件不能合并；过时材料不能替换较新的当前值。evidence_supported表示全部引用共同支持这条完整主张，跨消息指代必须能从引用链中明确解析。`;
