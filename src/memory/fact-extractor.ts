import type { JournalEntry } from '../soul/types.ts';
import { normalizeFactCategory, type FactOperation, type MemoryFact } from './facts.ts';

const QUESTION_RE = /[?？]|(?:住哪|哪儿|哪里|什么|叫啥|啥|喝啥|吃啥|几岁|多少|是不是|是否|吗$|呢$)/;
const TRAILING_PARTICLE_RE = /[了啦啊呀呢哦嘛吧]+$/;
const INLINE_CONNECTOR_RE = /(?:并且|而且|还有|同时|然后|改喝|爱喝|喜欢喝|改吃|爱吃|喜欢吃|对[^\s]{1,12}过敏|养了).*$/;
const THIRD_PARTY_OR_NARRATIVE_RE = /(?:电影|电视|剧|小说|新闻|故事|书里|漫画|动画|朋友|同事|同学|室友|邻居|别人|他人|男主|女主|主角|家人|父母|爸妈|哥哥|姐姐|弟弟|妹妹|亲戚|他|她)/;
const NEGATED_RESIDENCE_RE = /(?:不(?:再)?|没(?:有)?)\s*住/;
const NEGATED_DRINK_RE = /(?:不(?:再)?|没(?:有)?)\s*喝/;
const NEGATED_FOOD_RE = /(?:不(?:再)?|没(?:有)?)\s*吃/;

interface FactPatternRule {
  category: string;
  mode: 'upsert' | 'delete';
  re: RegExp;
  format: (subject: string, m: RegExpMatchArray) => string;
}

const FACT_RULES: FactPatternRule[] = [
  {
    category: 'residence', mode: 'delete',
    re: /(?:(?:已经?|早(?:已|就)?|现在|如今)?(?:不(?:再)?|没(?:有)?)住(?:在)?|搬离(?:了)?)\s*([^\s，,。；;！!？?]{2,24})/,
    format: (subject, m) => `${subject}住在${cleanVal(m[1])}`,
  },
  {
    category: 'residence', mode: 'upsert',
    re: /(?:搬(?:家)?(?:去|到|来|回)|移居(?:到)?|定居(?:在|到)?|现(?:在)?住(?:在)?|改住(?:在)?|住在|家住|我住)\s*([^\s，,。；;！!？?]{2,24})/,
    format: (subject, m) => `${subject}住在${cleanVal(m[1])}`,
  },
  {
    category: 'drink_preference', mode: 'delete',
    re: /(?:(?:已经?|早(?:已|就)?|现在)?(?:不(?:再)?|没(?:有)?)喝|戒掉(?:了)?)\s*([^\s，,。；;！!？?]{1,20})/,
    format: (subject, m) => `${subject}爱喝${cleanVal(m[1])}`,
  },
  {
    category: 'drink_preference', mode: 'upsert',
    re: /(?:改喝|现在(?:也|更|最)?(?:爱|喜欢)?喝|爱喝|喜欢喝|最爱喝|常喝|习惯喝|每天喝)\s*([^\s，,。；;！!？?]{1,20})/,
    format: (subject, m) => `${subject}爱喝${cleanVal(m[1])}`,
  },
  {
    category: 'food_preference', mode: 'delete',
    re: /(?:(?:已经?|早(?:已|就)?|现在)?(?:不(?:再)?|没(?:有)?)吃|忌口)\s*([^\s，,。；;！!？?]{1,20})/,
    format: (subject, m) => `${subject}爱吃${cleanVal(m[1])}`,
  },
  {
    category: 'food_preference', mode: 'upsert',
    re: /(?:改吃|现在(?:也|更|最)?(?:爱|喜欢)?吃|爱吃|喜欢吃|最爱吃)\s*([^\s，,。；;！!？?]{1,20})/,
    format: (subject, m) => `${subject}爱吃${cleanVal(m[1])}`,
  },
  {
    category: 'allergy', mode: 'upsert',
    re: /对\s*([^\s，,。；;！!？?]{1,16})\s*(?:严重)?过敏/,
    format: (subject, m) => `${subject}对${cleanVal(m[1])}过敏`,
  },
  {
    category: 'pet', mode: 'upsert',
    re: /养了(?:一只|一条|只|条)?(?:叫([^\s，,。；;！!？?]{1,10})的)?([^\s，,。；;！!？?]{1,12}(?:猫|狗|兔|仓鼠|鹦鹉|龟|鱼))/,
    format: (subject, m) => (m[1]
      ? `${subject}养了一只叫${cleanVal(m[1])}的${cleanVal(m[2])}`
      : `${subject}养了一只${cleanVal(m[2])}`),
  },
  {
    category: 'work', mode: 'upsert',
    re: /(?:换(?:了)?工作(?:去|到|做)|现在(?:做|从事)|职业是|工作是)\s*([^\s，,。；;！!？?]{2,24})/,
    format: (subject, m) => `${subject}的工作是${cleanVal(m[1])}`,
  },
];

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const normFactKey = (s: string): string => s.toLowerCase().replace(/[\s，,。；;！!？?、"'`]/g, '');

function cleanVal(raw: string): string {
  return String(raw || '')
    .trim()
    .replace(INLINE_CONNECTOR_RE, '')
    .replace(TRAILING_PARTICLE_RE, '')
    .replace(/^(?:在|去|到)/, '')
    .trim();
}

function isLikelyQuestionClause(clause: string): boolean {
  return QUESTION_RE.test(clause);
}

function isNegatedUpsert(category: string, clause: string): boolean {
  if (category === 'residence') return NEGATED_RESIDENCE_RE.test(clause);
  if (category === 'drink_preference') return NEGATED_DRINK_RE.test(clause);
  if (category === 'food_preference') return NEGATED_FOOD_RE.test(clause);
  return false;
}

/** 离线规则提取器：严格限定第一人称实感事实，拦截第三方/叙事句，否定句走 DELETE 且 provenance 固定为 inferred。 */
export function extractHeuristicFactOps(
  entries: JournalEntry[],
  existingActive: MemoryFact[],
  partnerName: string,
): FactOperation[] {
  const subject = String(partnerName || '同行者').trim() || '同行者';
  const firstPersonStartRe = new RegExp(`^(?:我(?:们|的|家)?|${escapeRe(subject)})`);
  const sorted = [...entries]
    .filter((e) => e.role === 'partner' && !e.tags?.includes('first-love-covenant'))
    .sort((a, b) => a.seq - b.seq);

  const activeBySlot = new Map<string, { id?: string; fact: string }>();
  for (const f of existingActive) {
    if (f.status !== 'active' || !f.category) continue;
    const cat = normalizeFactCategory(f.category) || f.category.toLowerCase();
    const sub = String(f.subject || subject).trim().toLowerCase();
    activeBySlot.set(`${cat}::${sub}`, { id: f.id, fact: f.fact });
  }

  const ops: FactOperation[] = [];
  for (const entry of sorted) {
    const sentences = String(entry.text || '').split(/[。；;！!？?\n]+/).map((s) => s.trim()).filter(Boolean);
    for (const sentence of sentences) {
      const clauses = sentence.split(/[，,、：:]+|\s+/).map((s) => s.trim()).filter(Boolean);
      let inheritedSelfSubject = false;
      for (const clause of clauses) {
        if (isLikelyQuestionClause(clause)) continue;
        const startsSelf = firstPersonStartRe.test(clause);
        const hasThirdPartyAny = THIRD_PARTY_OR_NARRATIVE_RE.test(clause);
        if (!startsSelf && hasThirdPartyAny) {
          inheritedSelfSubject = false;
          continue;
        }
        let matchedInClause = false;
        const matchedCategories = new Set<string>();
        for (const rule of FACT_RULES) {
          if (matchedCategories.has(rule.category)) continue;
          if (rule.mode === 'upsert' && isNegatedUpsert(rule.category, clause)) continue;
          const m = clause.match(rule.re);
          if (!m) continue;
          const prefix = clause.slice(0, m.index ?? 0);
          if (THIRD_PARTY_OR_NARRATIVE_RE.test(prefix)) {
            inheritedSelfSubject = false;
            continue;
          }
          if (!(startsSelf || inheritedSelfSubject)) continue;
          const val = cleanVal(m[1] || '');
          if (!val || isLikelyQuestionClause(val) || THIRD_PARTY_OR_NARRATIVE_RE.test(val)) continue;
          matchedCategories.add(rule.category);
          matchedInClause = true;
          const fact = rule.format(subject, m);
          const slotKey = `${rule.category}::${subject.toLowerCase()}`;
          const prev = activeBySlot.get(slotKey);

          if (rule.mode === 'delete') {
            const delKey = normFactKey(fact);
            const prevKey = prev ? normFactKey(prev.fact) : '';
            const matchesPrev = Boolean(prev && (prevKey === delKey || prevKey.includes(delKey) || delKey.includes(prevKey)));
            ops.push({
              action: 'DELETE',
              ...(matchesPrev && prev?.id ? { targetId: prev.id } : {}),
              category: rule.category,
              subject,
              fact,
              sourceSeqs: [entry.seq],
              bodyType: entry.bodyType,
              provenance: 'inferred',
            });
            if (matchesPrev) activeBySlot.delete(slotKey);
            continue;
          }
          if (prev && prev.fact === fact) continue;
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
              provenance: 'inferred',
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
              provenance: 'inferred',
            });
            activeBySlot.set(slotKey, { fact });
          }
        }
        if (startsSelf && !hasThirdPartyAny) {
          inheritedSelfSubject = true;
        } else if (startsSelf && hasThirdPartyAny && !matchedInClause) {
          inheritedSelfSubject = false;
        }
      }
    }
  }
  return ops;
}
