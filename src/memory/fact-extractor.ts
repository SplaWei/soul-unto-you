import type { JournalEntry } from '../soul/types.ts';
import { tokenizeText } from './experience.ts';
import { normalizeFactCategory, type FactOperation, type MemoryFact } from './facts.ts';

const QUESTION_RE = /[?？]|(?:住哪|哪儿|哪里|什么|叫啥|啥|喝啥|吃啥|几岁|多少|是不是|是否|吗$|呢$)/;
const TRAILING_PARTICLE_RE = /[了啦啊呀呢哦嘛吧]+$/;
const INLINE_CONNECTOR_RE = /(?:并且|而且|还有|同时|然后|改喝|爱喝|喜欢喝|改吃|爱吃|喜欢吃|对[^\s]{1,12}过敏|养了).*$/;
const FILLER_TOKENS = new Set(['同行者', '居住', '住在', '喜欢', '爱喝', '喜欢喝', '爱吃', '喜欢吃', '工作', '现在', '目前', '已经', '最近']);

interface FactPatternRule {
  category: string;
  mode: 'upsert' | 'delete';
  re: RegExp;
  format: (subject: string, m: RegExpMatchArray) => string;
}

const FACT_RULES: FactPatternRule[] = [
  {
    category: 'residence', mode: 'delete',
    re: /(?:已经?不?再?住在|不住在|搬离(?:了)?)\s*([^\s，,。；;！!？?]{2,24})/,
    format: (subject, m) => `${subject}住在${cleanVal(m[1])}`,
  },
  {
    category: 'residence', mode: 'upsert',
    re: /(?:搬(?:家)?(?:去|到|来|回)|移居(?:到)?|定居(?:在|到)?|现(?:在)?住(?:在)?|改住(?:在)?|住在|家住|我住)\s*([^\s，,。；;！!？?]{2,24})/,
    format: (subject, m) => `${subject}住在${cleanVal(m[1])}`,
  },
  {
    category: 'drink_preference', mode: 'delete',
    re: /(?:已经?不再喝|不再喝|已经不喝|不喝|戒掉(?:了)?)\s*([^\s，,。；;！!？?]{1,20})/,
    format: (subject, m) => `${subject}爱喝${cleanVal(m[1])}`,
  },
  {
    category: 'drink_preference', mode: 'upsert',
    re: /(?:改喝|现在(?:也|更|最)?(?:爱|喜欢)?喝|爱喝|喜欢喝|最爱喝|常喝|习惯喝|每天喝)\s*([^\s，,。；;！!？?]{1,20})/,
    format: (subject, m) => `${subject}爱喝${cleanVal(m[1])}`,
  },
  {
    category: 'food_preference', mode: 'delete',
    re: /(?:已经?不再吃|不再吃|不吃|忌口)\s*([^\s，,。；;！!？?]{1,20})/,
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

/** 离线规则提取器：按严格因果 seq 提取原子个人事实，并支持无标点复合句多事实拆分。 */
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
    const cat = normalizeFactCategory(f.category) || f.category.toLowerCase();
    const sub = String(f.subject || subject).trim().toLowerCase();
    activeBySlot.set(`${cat}::${sub}`, { id: f.id, fact: f.fact });
  }

  const ops: FactOperation[] = [];
  for (const entry of sorted) {
    const clauses = String(entry.text || '').split(/[，,。；;！!？?、\n]+|\s+/).map((s) => s.trim()).filter(Boolean);
    for (const clause of clauses) {
      if (isLikelyQuestionClause(clause)) continue;
      const matchedCategories = new Set<string>();
      for (const rule of FACT_RULES) {
        if (matchedCategories.has(rule.category)) continue;
        const m = clause.match(rule.re);
        if (!m) continue;
        const val = cleanVal(m[1] || '');
        if (!val || isLikelyQuestionClause(val)) continue;
        matchedCategories.add(rule.category);
        const fact = rule.format(subject, m);
        const slotKey = `${rule.category}::${subject.toLowerCase()}`;
        const prev = activeBySlot.get(slotKey);

        if (rule.mode === 'delete') {
          if (prev) {
            ops.push({
              action: 'DELETE', ...(prev.id ? { targetId: prev.id } : {}),
              category: rule.category, subject, fact, sourceSeqs: [entry.seq],
              bodyType: entry.bodyType, provenance: entry.provenance,
            });
            activeBySlot.delete(slotKey);
          }
          continue;
        }
        if (prev && prev.fact === fact) continue;
        if (prev) {
          ops.push({
            action: 'UPDATE', ...(prev.id ? { targetId: prev.id } : {}),
            category: rule.category, subject, fact, validFrom: entry.timestamp,
            sourceSeqs: [entry.seq], bodyType: entry.bodyType, provenance: entry.provenance,
          });
          activeBySlot.set(slotKey, { fact });
        } else {
          ops.push({
            action: 'ADD', category: rule.category, subject, fact, validFrom: entry.timestamp,
            sourceSeqs: [entry.seq], bodyType: entry.bodyType, provenance: entry.provenance,
          });
          activeBySlot.set(slotKey, { fact });
        }
      }
    }
  }
  return ops;
}

function extractCoreTokens(text?: string): string[] {
  const valueOnly = String(text || '')
    .replace(/^.*?(?:居住在|住在|喜欢喝|爱喝|喜欢吃|爱吃|工作是|养了一只(?:叫[^\s的]{1,10}的)?|对)/, '')
    .trim() || String(text || '');
  const toks = tokenizeText(valueOnly).filter((t) => !FILLER_TOKENS.has(t));
  if (toks.length) return toks;
  const chars = valueOnly.match(/[\u4e00-\u9fa5a-z0-9]/gi) ?? [];
  return chars.filter((c) => !'的了是在我你他她住喝吃'.includes(c));
}

function factMatchesValue(candidate?: string, target?: string): boolean {
  const cToks = extractCoreTokens(candidate);
  const tToks = extractCoreTokens(target);
  if (!cToks.length || !tToks.length) return false;
  const cLow = String(candidate || '').toLowerCase();
  const tLow = String(target || '').toLowerCase();
  return tToks.some((t) => cLow.includes(t)) || cToks.some((t) => tLow.includes(t));
}

/**
 * 真实 LLM 与时序确定性规则对账保护：
 * 当真实 LLM 在同一批次漏提旧事实、错留过期事实、或漏掉 UPDATE/DELETE 时，按日志 seq 自动补全冲突演化链，
 * 同时保留 LLM 提取的其他非冲突自由事实。
 */
export function reconcileDreamFactOps(llmOps: FactOperation[], heuristicOps: FactOperation[]): FactOperation[] {
  const normLlm = llmOps.map((op) => ({ ...op, category: normalizeFactCategory(op.category) }));
  const normHeur = heuristicOps.map((op) => ({ ...op, category: normalizeFactCategory(op.category) }));
  if (!normHeur.length) return normLlm;

  const hByCat = new Map<string, FactOperation[]>();
  for (const h of normHeur) {
    if (!h.category) continue;
    const arr = hByCat.get(h.category) ?? [];
    arr.push(h);
    hByCat.set(h.category, arr);
  }
  const lByCat = new Map<string, FactOperation[]>();
  for (const l of normLlm) {
    if (!l.category) continue;
    const arr = lByCat.get(l.category) ?? [];
    arr.push(l);
    lByCat.set(l.category, arr);
  }

  const replacedCats = new Set<string>();
  const staleSnippets: Array<{ oldFact: string; newFact: string }> = [];
  const additions: FactOperation[] = [];

  for (const [cat, hSlot] of hByCat) {
    const lSlot = lByCat.get(cat) ?? [];
    const hLatest = hSlot[hSlot.length - 1];

    if (hSlot.length >= 2) {
      const lLatest = lSlot[lSlot.length - 1];
      const llmValidChain = lSlot.length >= 2
        && (lLatest?.action === 'UPDATE' || lLatest?.action === 'DELETE')
        && (hLatest.action === 'DELETE'
          ? lLatest.action === 'DELETE'
          : factMatchesValue(lLatest.fact, hLatest.fact));
      if (!llmValidChain) {
        replacedCats.add(cat);
        additions.push(...hSlot);
        for (const oldOp of hSlot.slice(0, -1)) {
          if (oldOp.fact) staleSnippets.push({ oldFact: oldOp.fact, newFact: hLatest.fact || '' });
        }
      }
      continue;
    }

    const hOnly = hSlot[0];
    if (hOnly.action === 'UPDATE' || hOnly.action === 'DELETE') {
      const llmHandled = lSlot.some((op) =>
        op.action === hOnly.action
        || (op.action === 'UPDATE' && factMatchesValue(op.fact, hOnly.fact))
        || (op.action === 'ADD' && hOnly.action === 'UPDATE' && factMatchesValue(op.fact, hOnly.fact)),
      );
      if (!llmHandled) {
        replacedCats.add(cat);
        additions.push(hOnly);
        if (hOnly.fact) staleSnippets.push({ oldFact: '', newFact: hOnly.fact });
      }
      continue;
    }

    const coveredByLlm = lSlot.length > 0
      || normLlm.some((op) => op.action !== 'NONE' && factMatchesValue(op.fact, hOnly.fact));
    if (!coveredByLlm) additions.push(hOnly);
  }

  const keptLlm = normLlm.filter((op) => {
    if (op.category && replacedCats.has(op.category)) return false;
    if (staleSnippets.some((s) => s.oldFact && factMatchesValue(op.fact, s.oldFact) && !factMatchesValue(op.fact, s.newFact))) {
      return false;
    }
    return true;
  });
  return [...keptLlm, ...additions];
}
