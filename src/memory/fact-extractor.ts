import type { JournalEntry } from '../soul/types.ts';
import type { FactOperation, MemoryFact } from './facts.ts';

const QUESTION_RE = /[?？]|(?:住哪|哪儿|哪里|什么|叫啥|啥|喝啥|吃啥|几岁|多少|是不是|是否|吗$|呢$)/;
const TRAILING_PARTICLE_RE = /[了啦啊呀呢哦嘛吧]+$/;

interface FactPatternRule {
  category: string;
  mode: 'upsert' | 'delete';
  re: RegExp;
  format: (subject: string, m: RegExpMatchArray) => string;
}

const FACT_RULES: FactPatternRule[] = [
  {
    category: 'residence',
    mode: 'delete',
    re: /(?:已经?不?再?住在|不住在|搬离(?:了)?)\s*([^\s，,。；;！!？?]{2,24})/,
    format: (subject, m) => `${subject}住在${cleanVal(m[1])}`,
  },
  {
    category: 'residence',
    mode: 'upsert',
    re: /(?:搬(?:家)?(?:去|到|来|回)|移居(?:到)?|定居(?:在|到)?|现(?:在)?住(?:在)?|改住(?:在)?|住在|家住|我住)\s*([^\s，,。；;！!？?]{2,24})/,
    format: (subject, m) => `${subject}住在${cleanVal(m[1])}`,
  },
  {
    category: 'drink_preference',
    mode: 'delete',
    re: /(?:已经?不再喝|不再喝|已经不喝|不喝|戒掉(?:了)?)\s*([^\s，,。；;！!？?]{1,20})/,
    format: (subject, m) => `${subject}爱喝${cleanVal(m[1])}`,
  },
  {
    category: 'drink_preference',
    mode: 'upsert',
    re: /(?:改喝|现在(?:也|更|最)?(?:爱|喜欢)?喝|爱喝|喜欢喝|最爱喝|常喝|习惯喝|每天喝)\s*([^\s，,。；;！!？?]{1,20})/,
    format: (subject, m) => `${subject}爱喝${cleanVal(m[1])}`,
  },
  {
    category: 'food_preference',
    mode: 'delete',
    re: /(?:已经?不再吃|不再吃|不吃|忌口)\s*([^\s，,。；;！!？?]{1,20})/,
    format: (subject, m) => `${subject}爱吃${cleanVal(m[1])}`,
  },
  {
    category: 'food_preference',
    mode: 'upsert',
    re: /(?:改吃|现在(?:也|更|最)?(?:爱|喜欢)?吃|爱吃|喜欢吃|最爱吃)\s*([^\s，,。；;！!？?]{1,20})/,
    format: (subject, m) => `${subject}爱吃${cleanVal(m[1])}`,
  },
  {
    category: 'allergy',
    mode: 'upsert',
    re: /对\s*([^\s，,。；;！!？?]{1,16})\s*(?:严重)?过敏/,
    format: (subject, m) => `${subject}对${cleanVal(m[1])}过敏`,
  },
  {
    category: 'pet',
    mode: 'upsert',
    re: /养了(?:一只|一条|只|条)?(?:叫([^\s，,。；;！!？?]{1,10})的)?([^\s，,。；;！!？?]{1,12}(?:猫|狗|兔|仓鼠|鹦鹉|龟|鱼))/,
    format: (subject, m) => (m[1]
      ? `${subject}养了一只叫${cleanVal(m[1])}的${cleanVal(m[2])}`
      : `${subject}养了一只${cleanVal(m[2])}`),
  },
  {
    category: 'work',
    mode: 'upsert',
    re: /(?:换(?:了)?工作(?:去|到|做)|现在(?:做|从事)|职业是|工作是)\s*([^\s，,。；;！!？?]{2,24})/,
    format: (subject, m) => `${subject}的工作是${cleanVal(m[1])}`,
  },
];

function cleanVal(raw: string): string {
  return String(raw || '').trim().replace(TRAILING_PARTICLE_RE, '').replace(/^(?:在|去|到)/, '').trim();
}

function isLikelyQuestionClause(clause: string): boolean {
  return QUESTION_RE.test(clause);
}

/**
 * 离线无 LLM 做梦兜底：从伙伴对话流水中按因果 seq 提取原子个人事实，
 * 自动识别单值槽位变更（如搬家/改喝饮品）并生成 ADD / UPDATE / DELETE 操作序列。
 */
export function extractHeuristicFactOps(
  entries: JournalEntry[],
  existingActive: MemoryFact[],
  partnerName: string,
): FactOperation[] {
  const subject = String(partnerName || '同行者').trim() || '同行者';
  const sorted = [...entries]
    .filter((e) => e.role === 'partner' && !e.tags?.includes('first-love-covenant'))
    .sort((a, b) => a.seq - b.seq);

  const activeBySlot = new Map<string, { id?: string; fact: string }>();
  for (const f of existingActive) {
    if (f.status !== 'active' || !f.category) continue;
    const sub = String(f.subject || subject).trim().toLowerCase();
    activeBySlot.set(`${f.category.toLowerCase()}::${sub}`, { id: f.id, fact: f.fact });
  }

  const ops: FactOperation[] = [];
  for (const entry of sorted) {
    const clauses = String(entry.text || '')
      .split(/[，,。；;！!？?\n]+/)
      .map((s) => s.trim())
      .filter(Boolean);

    for (const clause of clauses) {
      if (isLikelyQuestionClause(clause)) continue;
      for (const rule of FACT_RULES) {
        const m = clause.match(rule.re);
        if (!m) continue;
        const val = cleanVal(m[1] || '');
        if (!val || isLikelyQuestionClause(val)) continue;
        const fact = rule.format(subject, m);
        const slotKey = `${rule.category.toLowerCase()}::${subject.toLowerCase()}`;
        const prev = activeBySlot.get(slotKey);

        if (rule.mode === 'delete') {
          if (prev) {
            ops.push({
              action: 'DELETE',
              ...(prev.id ? { targetId: prev.id } : {}),
              category: rule.category,
              subject,
              fact,
              sourceSeqs: [entry.seq],
              bodyType: entry.bodyType,
              provenance: entry.provenance,
            });
            activeBySlot.delete(slotKey);
          }
          break;
        }

        if (prev && prev.fact === fact) break;
        if (prev) {
          ops.push({
            action: 'UPDATE',
            ...(prev.id ? { targetId: prev.id } : {}),
            category: rule.category,
            subject,
            fact,
            validFrom: entry.timestamp,
            sourceSeqs: [entry.seq],
            bodyType: entry.bodyType,
            provenance: entry.provenance,
          });
          activeBySlot.set(slotKey, { fact });
        } else {
          ops.push({
            action: 'ADD',
            category: rule.category,
            subject,
            fact,
            validFrom: entry.timestamp,
            sourceSeqs: [entry.seq],
            bodyType: entry.bodyType,
            provenance: entry.provenance,
          });
          activeBySlot.set(slotKey, { fact });
        }
        break;
      }
    }
  }
  return ops;
}
