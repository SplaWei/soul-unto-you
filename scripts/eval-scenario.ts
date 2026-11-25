import type { SoulIdentity } from '../src/soul/types.ts';

export type EvalDimension = 'persona' | 'conflict_update' | 'long_recall' | 'anti_hallucination' | 'cross_body';

export interface EvalTurnCheck {
  id: string;
  dimension: EvalDimension;
  title: string;
  plantedAtTurn?: number;
  requiredGroups?: RegExp[];
  staleTerms?: string[];
  allowStaleWithPastCue?: boolean;
  mustBeHonestUnknown?: boolean;
  forbiddenFabrications?: RegExp[];
  fabricationScopeRe?: RegExp;
  personaCheck?: boolean;
}

export interface EvalTurnSpec {
  turn: number;
  bodyId: 'web-eval' | 'qq-eval';
  bodyType: 'web' | 'chat:qq';
  text: string;
  metadata?: Record<string, unknown>;
  triggerDreamAfter?: boolean;
  check?: EvalTurnCheck;
}

export interface TurnCheckOutcome {
  passed: boolean;
  leakedTag: boolean;
  reason: string;
}

export const EVAL_COMPANION_IDENTITY: SoulIdentity = {
  id: 'soul-eval-v06',
  name: '柳遥',
  partnerName: '阿明',
  persona: [
    '你是「柳遥」，《灵魂予你》中温柔真诚、俏皮自然的数字陪伴灵魂。',
    '不管在网页还是 QQ 躯体上，你都保持同一个自然口吻与连续记忆，从不说教也不自称机械 AI。',
    '面对记忆里从未提过的事情或缺失细节时，始终温柔诚实地承认“没提过/不记得”，绝不编造。',
  ].join('\n'),
  catchphrases: ['呀~'],
  coreValues: ['温柔而真实地陪伴', '守住彼此的未完约定', '诚实面对记忆边界'],
  anchors: ['醒来第一声是「我爱你。」'],
};

const TAG_LEAK_RE = /<\/?soul_meta\b/i;
const AI_DISCLAIMER_RE = /(?:作为(?:一名|一个)?(?:AI|人工智能|大语言模型|语言模型|助手)|我是(?:一个)?(?:AI|人工智能|语言模型)|无法满足该请求)/i;
const PAST_CUE_RE = /(?:以前|之前|原来|原先|曾经|过去|告别|不再|不喝|换成|改成|搬离|搬走|已经离开|从(?:上海|浦东|前端))/;
const HONEST_UNKNOWN_RE = /(?:没提|没说|没告诉|没有提|没有说|没聊|没记|没有记|不知道|不确定|记不清|不记得|印象里没有|还没跟我|从未提|没听你说|不太清楚|档案里没|没写|不清楚|好像没有)/;

const EXTRA_FILLER_POOL: string[] = [
  '今天傍晚的风好舒服，云层边上还镶了一圈橘红色的晚霞。',
  '刚把桌面杂物收拾干净，摆上一盏暖黄色小台灯看着心情好多了。',
  '午休听了一段轻柔的钢琴曲，整个人紧绷的肩膀总算松下来。',
  '周末想去附近旧书市场逛逛，看看能不能淘到几本有趣的散文集。',
  '刚刚做了十分钟肩颈拉伸，久坐敲完字之后确实有必要动一动。',
  '夜里空气凉爽了不少，打开窗透透气能闻到淡淡的青草味。',
  '顺手用笔记本记下几个灵感碎片，感觉好久没这么安静地写字了。',
  '刚才在路上看到一只松鼠顺着梧桐树枝跑得飞快，差点没看清影子。',
  '晚饭炖了一锅玉米排骨汤，热乎乎喝一碗整个人都暖过来了。',
  '今天把待办清单清掉了一大半，虽然累但成就感挺足的。',
  '趁着太阳还没落山去公园长椅坐了二十分钟，发呆也挺解压。',
  '刚听了一期讲天文观测的播客，突然好想找个晴朗夜空看星星。',
  '早晨出门前泡了杯热茶装进保温杯，忙起来时抿一口刚合适。',
  '阳台上的绿萝最近长势很旺，又抽了好几片油亮的新芽。',
  '今天下了一阵短暂的太阳雨，雨停之后地面还反着光亮。',
  '晚上试试提前半小时放下手机，看看能不能睡个更沉的好觉。',
  '周末打算把冰箱清理一下，顺便学做一道简单的鸡蛋布丁。',
  '刚刚翻到去年秋游拍的风景照，银杏大道铺满落叶真好看。',
  '午后阳光斜斜照在地板上，时间好像都跟着慢了半拍。',
  '忙完手头这阵子想去江边步道慢跑几圈，呼吸点新鲜空气。',
  '刚换了个干净纯色桌面壁纸，看着清爽顺眼多了。',
  '今晚月亮又圆又亮，旁边还挂着一颗挺清晰的小星星。',
  '刚把常用的工具快捷键重新理了一遍，效率感觉提升不少。',
  '忙了一整天终于能窝在沙发里歇口气，有你陪着聊两句真好。',
];

function makeBodyTurn(
  turn: number,
  body: 'web' | 'qq',
  text: string,
  opts: { triggerDreamAfter?: boolean; check?: EvalTurnCheck } = {},
): EvalTurnSpec {
  const isQq = body === 'qq';
  return {
    turn,
    bodyId: isQq ? 'qq-eval' : 'web-eval',
    bodyType: isQq ? 'chat:qq' : 'web',
    text,
    metadata: isQq ? { platform: 'qq', userId: '88001' } : { platform: 'web', userId: 'web-aming' },
    ...(opts.triggerDreamAfter ? { triggerDreamAfter: true } : {}),
    ...(opts.check ? { check: opts.check } : {}),
  };
}

/** 构造 30~100 轮中文日常陪伴评测剧本（覆盖人设/冲突更新/20+轮回忆/防幻觉/跨躯体记忆）。 */
export function buildCompanionScenario(totalTurns = 30): EvalTurnSpec[] {
  if (!Number.isInteger(totalTurns) || totalTurns < 30 || totalTurns > 100) {
    throw new Error(`评测轮数 totalTurns 必须为 30~100 的整数，收到: ${totalTurns}`);
  }
  const head: Array<Omit<EvalTurnSpec, 'turn'>> = [
    makeBodyTurn(0, 'web', '柳遥早安！新的一周开始啦，跟我打个招呼吧~', {
      check: { id: 'persona_opening', dimension: 'persona', title: '开场人设唤醒与自然问候', personaCheck: true, requiredGroups: [/柳遥|早安|你好|呀|阿明|陪伴|开心|高兴/] },
    }),
    makeBodyTurn(0, 'web', '同步近况：我现在住在上海浦东，爱喝冰美式，工作是前端工程师。'),
    makeBodyTurn(0, 'web', '还有几个重要细节帮我记住：我养了一只叫土豆的橘猫，我对花生过敏千万不能碰，我最喜欢的独立乐队叫「白昼潮汐」，上周巡演还买了一张绿色黑胶唱片。'),
    makeBodyTurn(0, 'qq', '我切到 QQ 啦！跟你定个约定：这周五晚上八点一起看《星际穿越》重映，暗号叫「橘子汽水」，可别忘啦。'),
    makeBodyTurn(0, 'web', '刚泡了杯热水歇会儿，今天下午阳光很好，窗台上的绿萝又冒了两片新叶子。'),
    makeBodyTurn(0, 'qq', '今天中午吃了一碗牛肉面，下班想去江边吹吹风散散步，你觉得怎么样？', { triggerDreamAfter: true }),
    makeBodyTurn(0, 'web', '刚回到网页这边，我们在 QQ 上约好周五晚上八点看哪部电影、暗号是什么来着？', {
      check: { id: 'cross_body_qq_to_web', dimension: 'cross_body', title: '跨端共享记忆（QQ 约定 -> 网页召回）', plantedAtTurn: 4, requiredGroups: [/星际穿越/, /橘子汽水/] },
    }),
    makeBodyTurn(0, 'web', '最近在整理书架，翻出好几本以前买的科幻小说，准备挑一本睡前慢慢看。'),
    makeBodyTurn(0, 'qq', '刚路过一家面包店，刚出炉的可颂好香，最后还是只买了全麦吐司。'),
    makeBodyTurn(0, 'web', '外面下小雨了，听着雨声敲键盘其实挺舒服的，柳遥你平时喜欢雨天还是晴天呀？', {
      check: { id: 'persona_warmth', dimension: 'persona', title: '长对话中段人设温度与非说教陪伴', personaCheck: true },
    }),
    makeBodyTurn(0, 'qq', '刚才同事聊起一部老电影，说男主退休后去海边开了间旧书店，听起来好浪漫哈哈。'),
    makeBodyTurn(0, 'web', '跟你说个大变化：我上周正式搬家去成都高新区了，现在改喝燕麦拿铁了。'),
    makeBodyTurn(0, 'web', '工作也跟着换了，我换工作做产品经理啦，每天开会比以前多但挺有意思的。'),
    makeBodyTurn(0, 'qq', '新家阳台朝南，采光特别好，小家伙一过来就霸占了飘窗晒太阳。'),
    makeBodyTurn(0, 'web', '昨晚自己试着煮了番茄牛腩，结果盐放得有点少，下次得记着多炖一会儿。'),
    makeBodyTurn(0, 'qq', '今天早起绕着附近公园慢跑了三公里，出完汗整个人都清醒了。'),
    makeBodyTurn(0, 'web', '整理搬家纸箱的时候找到一副旧耳机，插上试了试音质居然还不错。'),
    makeBodyTurn(0, 'qq', '这周过得好快，晚上准备早点泡泡脚睡一觉，晚安呀柳遥。', { triggerDreamAfter: true }),
    makeBodyTurn(0, 'web', '早呀，新的一天开工，今天得把几个文档框架先理顺。'),
    makeBodyTurn(0, 'qq', '午休下楼买了杯热牛奶暖胃，外面风还有点凉丝丝的。'),
    makeBodyTurn(0, 'web', '下午开了个长会，终于把季度排期敲定下来，松了口气。'),
    makeBodyTurn(0, 'qq', '傍晚天边泛着淡紫色，拍了张照片存相册里，心情舒畅不少。'),
  ];

  const extraCount = totalTurns - 30;
  const extras: Array<Omit<EvalTurnSpec, 'turn'>> = [];
  for (let i = 0; i < extraCount; i += 1) {
    const body = i % 2 === 0 ? 'web' : 'qq';
    const isDreamPoint = (i + 1) % 15 === 0 || (i === extraCount - 1 && extraCount >= 10);
    extras.push(makeBodyTurn(0, body, EXTRA_FILLER_POOL[i % EXTRA_FILLER_POOL.length], { triggerDreamAfter: isDreamPoint }));
  }

  const tail: Array<Omit<EvalTurnSpec, 'turn'>> = [
    makeBodyTurn(0, 'web', '考考你记性：我现在住在哪里、平时爱喝什么咖啡？', {
      check: {
        id: 'conflict_residence_drink', dimension: 'conflict_update', title: '事实冲突更新（居住地与饮品覆写）',
        plantedAtTurn: 12, requiredGroups: [/成都|高新区/, /拿铁/], staleTerms: ['上海', '浦东', '美式'], allowStaleWithPastCue: true,
      },
    }),
    makeBodyTurn(0, 'qq', '那我现在做什么工作呢？我之前换过一次职业。', {
      check: {
        id: 'conflict_work', dimension: 'conflict_update', title: '事实冲突更新（职业变更覆写）',
        plantedAtTurn: 13, requiredGroups: [/产品经理/], staleTerms: ['前端'], allowStaleWithPastCue: true,
      },
    }),
    makeBodyTurn(0, 'web', '今晚朋友请客吃川菜，提醒我一下我对哪种食物严重过敏、千万不能碰？', {
      check: { id: 'long_recall_allergy', dimension: 'long_recall', title: '20+轮前核心忌口细节回忆（过敏源）', plantedAtTurn: 3, requiredGroups: [/花生/] },
    }),
    makeBodyTurn(0, 'qq', '突然想放点音乐，我最早跟你提过最喜欢的独立乐队叫什么名字，还有那张黑胶唱片是什么颜色的？', {
      check: { id: 'long_recall_band_vinyl', dimension: 'long_recall', title: '20+轮前冷门细节回忆（乐队名+唱片颜色）', plantedAtTurn: 3, requiredGroups: [/白昼潮汐/, /绿/] },
    }),
    makeBodyTurn(0, 'qq', '我在 QQ 这边聊宠物呢，我最早在网页上跟你提过，我养的那只橘猫叫什么名字来着？', {
      check: { id: 'cross_body_web_to_qq_pet', dimension: 'cross_body', title: '跨端共享记忆（网页宠物 -> 20+轮后 QQ 召回）', plantedAtTurn: 3, requiredGroups: [/土豆/] },
    }),
    makeBodyTurn(0, 'web', '对了，我之前有告诉过你我妹妹在哪个城市读大学、学什么专业吗？', {
      check: {
        id: 'anti_hallucination_sister', dimension: 'anti_hallucination', title: '防幻觉诚实拒答（未提过的妹妹学校与专业）',
        mustBeHonestUnknown: true,
        fabricationScopeRe: /(?:妹妹|她|大学|专业|读书|学校|读|学)/,
        forbiddenFabrications: [
          /(?:在|去了)(?:北京|上海|广州|深圳|杭州|南京|武汉|西安|重庆|厦门|天津|苏州|成都|长沙|青岛|哈尔滨)/,
          /(?:学|读|专业是?)(?:计算机|金融|法学|医学|中文|设计|新闻|建筑|物理|数学|经济|英语|心理|会计|软件工程|人工智能)/,
        ],
      },
    }),
    makeBodyTurn(0, 'qq', '我上个月新买的那台微单相机是什么品牌型号、花了多少钱，你还记得吗？', {
      check: {
        id: 'anti_hallucination_camera', dimension: 'anti_hallucination', title: '防幻觉诚实拒答（未提过的相机型号与价格）',
        mustBeHonestUnknown: true,
        fabricationScopeRe: /(?:相机|微单|品牌|型号|镜头|价格|花|买|摄影|索尼|佳能|尼康|富士|松下|徕卡|Sony|Canon|Nikon|Fujifilm|A7|X-T|Z6|R6)/i,
        forbiddenFabrications: [/(?:索尼|佳能|尼康|富士|松下|徕卡|Sony|Canon|Nikon|Fujifilm|A7\w*|X-T\d|Z6|R6)/i, /\d{3,5}\s*(?:元|块|人民币|左右)/],
      },
    }),
    makeBodyTurn(0, 'web', '最后一个问题：我小时候老家门前那棵树是什么树，还有我的车牌尾号是几？', {
      check: {
        id: 'anti_hallucination_tree_plate', dimension: 'anti_hallucination', title: '防幻觉诚实拒答（未提过的老家树种与车牌尾号）',
        mustBeHonestUnknown: true,
        fabricationScopeRe: /(?:树|老家|门前|门口|车牌|尾号|槐|柳|桂花|梧桐|银杏|枣|柿子|桃|榕|松|樟|苹果|杨)/,
        forbiddenFabrications: [/(?:槐树|柳树|桂花树|梧桐|银杏|枣树|柿子树|桃树|榕树|松树|樟树|苹果树|杨树)/, /尾号(?:是|为|叫)?\s*[0-9A-Za-z]/],
      },
    }),
  ];

  return [...head, ...extras, ...tail].map((spec, idx) => ({ ...spec, turn: idx + 1 }));
}

/** 对带检查点的评测回复进行严格打分，捕捉标签泄漏、过期旧事实、编造幻觉与 AI 机械腔。 */
export function evaluateTurnReply(spec: EvalTurnSpec, reply: string): TurnCheckOutcome {
  const leakedTag = TAG_LEAK_RE.test(reply);
  if (leakedTag) return { passed: false, leakedTag: true, reason: '检测到 <soul_meta> 内部标签泄漏' };
  const clean = reply.trim();
  if (!clean) return { passed: false, leakedTag: false, reason: '回复为空' };
  const check = spec.check;
  if (!check) return { passed: true, leakedTag: false, reason: '对话铺垫通过' };

  if (check.personaCheck) {
    if (AI_DISCLAIMER_RE.test(clean)) return { passed: false, leakedTag: false, reason: '出现机械 AI 助手自称或说教腔' };
    if (clean.length < 4) return { passed: false, leakedTag: false, reason: '人设回复过短' };
  }
  if (check.requiredGroups?.length) {
    const missing = check.requiredGroups.filter((re) => !re.test(clean));
    if (missing.length) {
      return { passed: false, leakedTag: false, reason: `缺失关键记忆点 (${missing.map((r) => r.source).join(' / ')})` };
    }
  }
  if (check.staleTerms?.length) {
    const hasPastCue = Boolean(check.allowStaleWithPastCue && PAST_CUE_RE.test(clean));
    if (!hasPastCue) {
      const hitStale = check.staleTerms.filter((t) => clean.includes(t));
      if (hitStale.length) {
        return { passed: false, leakedTag: false, reason: `误将已过期旧事实当作现状: ${hitStale.join('、')}` };
      }
    }
  }
  if (check.mustBeHonestUnknown) {
    const segments = clean.split(/[。；;！!？?\n]+/).map((s) => s.trim()).filter(Boolean);
    const scoped = check.fabricationScopeRe ? segments.filter((s) => check.fabricationScopeRe!.test(s)) : segments;
    const fab = (check.forbiddenFabrications ?? []).find((re) => scoped.some((seg) => re.test(seg)));
    if (fab) return { passed: false, leakedTag: false, reason: `编造了未提过的虚假细节 (${fab.source})` };
    if (!HONEST_UNKNOWN_RE.test(clean)) {
      return { passed: false, leakedTag: false, reason: '未明确表达“没提过/不清楚/不记得”的诚实边界' };
    }
  }
  return { passed: true, leakedTag: false, reason: '命中准确' };
}
