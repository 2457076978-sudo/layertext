/**
 * 验收 v2 尺子的 golden 锁（第三梯队项 9a，2026-09-18）
 *
 * ── 这一层在守什么 ──────────────────────────────────────────────────────
 * `src/core/acceptance.ts` 是七维度验收的**唯一判定实现**（MCP `layer_acceptance_v2`、
 * 验收v2.mjs、回放层共用）。09-17 之后它长出了新尺子（同段倒挂 / 注密度 / 语义警报 /
 * 句长容差 1.15），但**没有任何东西守着尺子自己**——尺子悄悄漂了，比产物坏了更难发现：
 * 报告照样能出，数已经不是那个数。
 *
 * 所以这里把尺子**锁在合成书上**：三章 CC0 合成书（本文件自写，无版权负担、无学生数据、
 * 无真实书稿），刻意布防每个维度的触发形与不触发形，`acceptanceV2` 全输出 deep-equal
 * 冻结值。锁的是**尺子的代码**，不是真项目的数（真项目的数由回放层
 * `tests/replay.test.ts` + `LAYERTEXT_REPLAY_DIR` 夹具守，两层分工见
 * docs/第三梯队_尺子收口_规划与验收标准_2026-09-18.md）。
 *
 * ── 三章的布防（每章锁什么）──────────────────────────────────────────
 * · 第一章「健康基线」：全维度**不触发**——排序 B<M<A 成立、无倒挂、句长梯度宽松通过、
 *   无结构/语义/重复注问题。锁"干净的章长什么样"，防止尺子把好章误报。
 * · 第二章「违规靶场」：全维度**触发**——未注率倒挂（B>M>A）、同段倒挂两段（P05：A 空段
 *   对 B 一词 / P07：B 两词对 A 零）、句长梯度 1.17 超线挂、语义三形全中（凭空数字 12 /
 *   专名 tessin 丢失 / 源段 2 否定→产物 0 否定）、结构三形（空段 / 注释外中文 /
 *   三层段ID不对齐：M 多一个 P08）、同段同词重复注 counted。注密度最差段钉在
 *   P07/P04/P03。
 * · 第三章「边界与豁免」：句长梯度**贴线过**——A 全 20 词句、B 全 23 词句，
 *   ratio=1.15 恰在容差线上通过（23 ≤ 20×1.15）。第二章的 1.17 在线外挂：两章合起来
 *   把容差从两侧夹住——调小→第三章翻红，调大到 ≥1.1667→第二章翻红
 *   （1.15–1.1666 之间是采样盲窗，如实声明）。豁免段 P03（exemptSeg 回调，对应管线侧
 *   歌词诗段注册表）：B 段未注 2 > A 段 1 却**不进**倒挂清单；P04 不豁免、同样的形状
 *   就进——豁免开关真的在起作用（对照实验：去掉回调 P03 立刻出现）。语义全部不触发形
 *   （数字子集/专名保留/否定 2→2）。A/M 零注释锁"无注章"的密度零值与空最差段。
 *
 * ── 冻结纪律（仓库既有承诺：记期望行为，不是现状捕捉）──────────────────
 * 首冻（2026-09-18）对三章输出逐字段人工过目——tokens/unnoted 与布防用词数逐一对照、
 * 每个触发/不触发形与设计意图逐一对照（过程记 CHANGELOG 当日条目）；此后任何字段的
 * 变动都必须有人解释。
 *
 * ── 反证（golden 的验收：不红的 golden 是空炮）─────────────────────────
 * 2026-09-18 实测（红码未入库，过程记 CHANGELOG）：
 * ① SENT_RATIO_TOLERANCE 1.15→1.2：第二章 pass false→true，deep-equal 红；
 * ② 未注计数偏一位（rates 循环 unk 种子 0→1）：三章 rates 全变，deep-equal 红。
 * 改尺子的人有义务重做一次反证。
 *
 * ── 已知边界（如实声明，不装看不见）─────────────────────────────────────
 * · 「段ID重复」在 acceptanceV2 里**结构上不可达**：segsOfMd 用 Map 装段，同号段后写
 *   覆盖前写，keys 永远唯一。重复段的可观测形态是**段数对不齐**（第二章 M 多 P08 锁的
 *   就是这个）。这是尺子的现状，不是本测试的缺口；若要真正检出重复段，得改 segsOfMd
 *   的装段方式——那是改尺子，走反证+重冻结流程。
 * · 词表 KNOWN 收全了正文用到的全部真实词，未注清单里只允许出现生造词
 *   （flarn/zorb/plim/gronk/vexol/quib/blorp/snib/wug）——出现任何真实词即词表漏词。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { acceptanceV2, segsOfMd, type AcceptanceV2Report } from '../src/core/acceptance.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/* ── CC0 合成书（本文件自写；Marlow/Tessin 为虚构人名）── */

const KNOWN = `marlow tessin keeper light rock sea wind bread tea friday lamp ships home safe cold gale
strong brave night town mill shops people man moved word old bell rang times dawn counted sacks locked
door river rose slowly spring boats carried coal down quiet fish jumped swam path stone saw small below
hill walked ran hid years burning bleak stubborn brought him and said one never not nobody did the was
for on that past again with by of a an is are was were been be
count morning work hard easy late early near far loud soft kept slept burned all went there lived whole
full winter waves fire grey hot heavy black slowly anybody about long big run sat slow song water very house came sleeping day narrow square twice bridge quiet`
  .split(/\s+/)
  .map((w) => w.trim().toLowerCase())
  .filter(Boolean);
const PROPER = ['marlow', 'tessin'];

const CH1 = {
  SRC: `[P01] Marlow kept the light on the rock for 3 years.

[P02] The sea was cold, and the wind never slept.

[P03] Tessin brought him bread and tea on friday.

[P04] The lamp burned all night, and the ships went home safe.`,
  A: `[P01] Marlow kept the light burning on the bleak rock for 3 years.

[P02] The sea was cold, and the gale（大风） never slept.

[P03] Tessin brought him bread and strong tea on friday.

[P04] The stubborn lamp burned all night, and the ships went home safe past the flarn, the zorb and the gronk.`,
  M: `[P01] Marlow kept the light burning on the cold rock for 3 years.

[P02] The sea was cold, and the wind never slept.

[P03] Tessin brought him bread and hot tea（茶） on friday.

[P04] The brave lamp burned all night, and the ships went home safe past the flarn and the zorb.`,
  B: `[P01] Marlow kept the light on the rock for 3 years.

[P02] The sea was cold, and the wind never slept.

[P03] Tessin brought him bread and tea（茶） on friday.

[P04] The lamp burned all night, and the ships went home safe past the flarn.`,
};
const CH2 = {
  SRC: `[P01] The mill town of Marlow had 3 shops and 40 people.

[P02] Not one man moved, and he never said a word.

[P03] The old bell rang 8 times at dawn.

[P04] Tessin counted the sacks and locked the door.

[P05] The river rose slowly that spring.

[P06] The boats carried coal down to the sea.

[P07] The path was long and hard.

[P08] The town slept early.`,
  A: `[P01] The small old mill town of Marlow had 3 shops and about 40 people.

[P02] One man moved slowly, and he said a quiet word to her.

[P03] The old bell in the square rang 12 times at the cold dawn.

[P04] She counted all the heavy sacks and locked the big door twice.

[P05] 

[P06] The two boats carried the black coal down to the cold sea 河流.

[P07] The narrow path（小路）was very long and hard for the slow flarn（弗拉恩）.`,
  M: `[P01] The mill town of Marlow had 3 shops and 40 people.

[P02] Not one man moved, and he never said a word.

[P03] The old bell rang 8 times at dawn.

[P04] Tessin counted（数）the sacks and counted（数）them all again.

[P05] The river rose slowly that vexol spring.

[P06] The boats carried coal down to the sea.

[P07] The path was long and hard.

[P08] The town slept early.`,
  B: `[P01] The small mill town of Marlow had 3 shops and about 40 quiet people lived there.

[P02] Not one man moved, and he never said one word to anybody at all.

[P03] The old bell（铃）rang 8 times（次）at the square in the cold wind at dawn（黎明）.

[P04] Tessin counted the big old sacks and locked the heavy door of the mill.

[P05] The quiet river rose slowly that spring, and a zorb swam by the bridge.

[P06] The boats carried the black coal slowly down to the cold sea that morning.

[P07] The long hard path was full of zorb and plim for the whole winter.`,
};
const CH3 = {
  SRC: `[P01] Marlow saw 5 boats on the water.

[P02] Tessin said the work was hard.

[P03] The old song was loud.

[P04] The night was long there.

[P05] He did not run and never hid.`,
  A: `[P01] Marlow saw 5 boats on the grey water, and the flarn moved below the cold plim near the old stone light.

[P02] Tessin said the hard work of the long winter was slow, and the gronk kept the snib fire burning there.

[P03] The old song was loud and very slow that cold night, and the vexol rang on the hill near town.

[P04] The long night was wug below the hill that spring, and the blorp sat near the door of the house.

[P05] He did not run that day, because the old keeper said the quib was not safe for him at all.`,
  M: `[P01] Marlow saw 5 boats on the water, and the vexol moved below.

[P02] Tessin said the work was hard and long, and the gronk kept the fire.

[P03] The old song was loud and slow that night, and the wug rang on the hill.

[P04] The night was long and quiet below the hill, and the snib sat near the door.

[P05] He did not run.`,
  B: `[P01] Marlow saw 5 boats on the water and the light of the town below the hill, and the cold sea was grey that morning.

[P02] Tessin said the work was hard, and the tea（茶）was cold there, because the wind came down from the hills all that day.

[P03] The old song was loud and slow that night, and the zorb and the plim rang on the hill near the sleeping town.

[P04] The night was long and zorb below the hill, and the quib and the plim sat near the old door of the house.

[P05] He did not run that day, because the old keeper of the light said the long path was not safe for him there.`,
};

/** 豁免回调（对应管线侧歌词诗段注册表的形状）：第三章只豁免 B 层 P03 */
const exemptPoemP03B = (segId: string, tier: 'A' | 'M' | 'B'): boolean => segId === 'P03' && tier === 'B';

interface Book {
  SRC: string;
  A: string;
  M: string;
  B: string;
}

const run = (ch: Book, exempt?: (segId: string, tier: 'A' | 'M' | 'B') => boolean): AcceptanceV2Report =>
  acceptanceV2({ tiers: { A: ch.A, M: ch.M, B: ch.B }, source: segsOfMd(ch.SRC), known: KNOWN, proper: PROPER, ...(exempt ? { exemptSeg: exempt } : {}) });

/* ── 冻结值（首冻 2026-09-18，逐字段人工过目；记期望行为，不是现状捕捉）── */

const GOLDEN_CH1: AcceptanceV2Report = {
  rates: {
    A: {
      tokens: 49,
      unnoted: 3,
      ratePct: 6.12,
    },
    M: {
      tokens: 47,
      unnoted: 2,
      ratePct: 4.26,
    },
    B: {
      tokens: 40,
      unnoted: 1,
      ratePct: 2.5,
    },
  },
  rateOrderPass: true,
  segInversions: [],
  sentGradient: {
    avgA: 12.3,
    avgB: 10,
    ratio: 0.82,
    pass: true,
  },
  density: {
    A: {
      per100: 2,
      worst: {
        d: 11.1,
        at: 'P02',
      },
    },
    M: {
      per100: 2.1,
      worst: {
        d: 11.1,
        at: 'P03',
      },
    },
    B: {
      per100: 2.5,
      worst: {
        d: 12.5,
        at: 'P03',
      },
    },
  },
  structure: [],
  semantic: [],
  duplicateAnnos: [],
  unnotedByTier: {
    A: {
      flarn: ['flarn'],
      zorb: ['zorb'],
      gronk: ['gronk'],
    },
    M: {
      flarn: ['flarn'],
      zorb: ['zorb'],
    },
    B: {
      flarn: ['flarn'],
    },
  },
};

const GOLDEN_CH2: AcceptanceV2Report = {
  rates: {
    A: {
      tokens: 72,
      unnoted: 0,
      ratePct: 0,
    },
    M: {
      tokens: 60,
      unnoted: 1,
      ratePct: 1.67,
    },
    B: {
      tokens: 98,
      unnoted: 3,
      ratePct: 3.06,
    },
  },
  rateOrderPass: false,
  segInversions: [
    {
      seg: 'P05',
      bUnnoted: 1,
      aUnnoted: 0,
      words: ['zorb'],
    },
    {
      seg: 'P07',
      bUnnoted: 2,
      aUnnoted: 0,
      words: ['zorb', 'plim'],
    },
  ],
  sentGradient: {
    avgA: 12,
    avgB: 14,
    ratio: 1.17,
    pass: false,
  },
  density: {
    A: {
      per100: 2.8,
      worst: {
        d: 16.7,
        at: 'P07',
      },
    },
    M: {
      per100: 3.3,
      worst: {
        d: 22.2,
        at: 'P04',
      },
    },
    B: {
      per100: 3.1,
      worst: {
        d: 21.4,
        at: 'P03',
      },
    },
  },
  structure: ['A/P05 空段', 'A/P06 注释外中文', '三层段ID不对齐 A:7/M:8/B:7'],
  semantic: ['A/P02 否定疑似反转', 'A/P03 凭空数字 12', 'A/P04 专名丢失 tessin'],
  duplicateAnnos: ['M/P04 重复注 counted'],
  unnotedByTier: {
    A: {},
    M: {
      vexol: ['vexol'],
    },
    B: {
      zorb: ['zorb', 'zorb'],
      plim: ['plim'],
    },
  },
};

const GOLDEN_CH3: AcceptanceV2Report = {
  rates: {
    A: {
      tokens: 100,
      unnoted: 8,
      ratePct: 8,
    },
    M: {
      tokens: 61,
      unnoted: 4,
      ratePct: 6.56,
    },
    B: {
      tokens: 115,
      unnoted: 5,
      ratePct: 4.35,
    },
  },
  rateOrderPass: true,
  segInversions: [
    {
      seg: 'P04',
      bUnnoted: 3,
      aUnnoted: 2,
      words: ['zorb', 'quib', 'plim'],
    },
  ],
  sentGradient: {
    avgA: 20,
    avgB: 23,
    ratio: 1.15,
    pass: true,
  },
  density: {
    A: {
      per100: 0,
      worst: {
        d: 0,
        at: '',
      },
    },
    M: {
      per100: 0,
      worst: {
        d: 0,
        at: '',
      },
    },
    B: {
      per100: 0.9,
      worst: {
        d: 4.3,
        at: 'P02',
      },
    },
  },
  structure: [],
  semantic: [],
  duplicateAnnos: [],
  unnotedByTier: {
    A: {
      flarn: ['flarn'],
      plim: ['plim'],
      gronk: ['gronk'],
      snib: ['snib'],
      vexol: ['vexol'],
      wug: ['wug'],
      blorp: ['blorp'],
      quib: ['quib'],
    },
    M: {
      vexol: ['vexol'],
      gronk: ['gronk'],
      wug: ['wug'],
      snib: ['snib'],
    },
    B: {
      zorb: ['zorb', 'zorb'],
      plim: ['plim', 'plim'],
      quib: ['quib'],
    },
  },
};

/* ── 第一章：健康基线（好章不许被误报）── */

test('★ golden 第一章（健康基线）：全维度不触发，输出与冻结值逐字段一致', () => {
  const r = run(CH1);
  // 先对布防意图点名（deep-equal 之前的可读证据），再整锁
  assert.equal(r.rateOrderPass, true, '健康的章必须 B<M<A 排序成立');
  assert.deepEqual(r.segInversions, [], '健康的章不许报同段倒挂');
  assert.deepEqual(r.structure, [], '健康的章不许报结构问题');
  assert.deepEqual(r.semantic, [], '健康的章不许报语义警报');
  assert.deepEqual(r.duplicateAnnos, [], '健康的章不许报重复注');
  assert.equal(r.sentGradient.pass, true, '健康的章句长梯度必须通过');
  assert.deepEqual(r.density.A.worst.at, 'P02', 'A 层最差段钉在带注的 P02');
  assert.deepEqual(r.density.B.worst.at, 'P03', 'B 层最差段钉在带注的 P03');
  // 健康章的未注清单**允许**有生造词（那是 B<M<A 梯度的来源）——只许生造、不许真实词漏收
  assert.deepEqual(Object.keys(r.unnotedByTier.A ?? {}), ['flarn', 'zorb', 'gronk'], 'A 层未注恰好三个生造词');
  assert.deepEqual(Object.keys(r.unnotedByTier.M ?? {}), ['flarn', 'zorb'], 'M 层未注恰好两个生造词');
  assert.deepEqual(Object.keys(r.unnotedByTier.B ?? {}), ['flarn'], 'B 层未注恰好一个生造词');
  assert.deepEqual(r, GOLDEN_CH1);
});

/* ── 第二章：违规靶场（触发形全中）── */

test('★ golden 第二章（违规靶场）：每个维度的触发形都被点名', () => {
  const r = run(CH2);
  assert.equal(r.rateOrderPass, false, '未注率 B>M>A 必须判倒挂');
  assert.deepEqual(
    r.segInversions.map((x) => x.seg),
    ['P05', 'P07'],
    '同段倒挂恰好两段：P05（A 空段对 B 一词）与 P07（B 两词对 A 零）',
  );
  assert.equal(r.sentGradient.ratio, 1.17, '梯度比值必须是 1.17（1.15 线外、1.2 线内的反证锚点）');
  assert.equal(r.sentGradient.pass, false, '1.17 > 1.15 容差必须挂');
  assert.deepEqual(r.semantic, ['A/P02 否定疑似反转', 'A/P03 凭空数字 12', 'A/P04 专名丢失 tessin'], '语义三形（否定归零/凭空数字/专名丢失）恰好各一条');
  assert.deepEqual(r.structure, ['A/P05 空段', 'A/P06 注释外中文', '三层段ID不对齐 A:7/M:8/B:7'], '结构三形：空段/注释外中文/段ID不对齐');
  assert.deepEqual(r.duplicateAnnos, ['M/P04 重复注 counted'], '同段同词重复注点名到词');
  assert.deepEqual(r, GOLDEN_CH2);
});

/* ── 第三章：边界与豁免（贴线过 + 豁免开关）── */

test('★ golden 第三章（边界与豁免）：1.15 贴线通过、豁免段不进倒挂', () => {
  const r = run(CH3, exemptPoemP03B);
  assert.deepEqual(r.sentGradient, { avgA: 20, avgB: 23, ratio: 1.15, pass: true }, '20→23 恰在 1.15 线上通过（贴线过：容差调小即翻红）');
  assert.deepEqual(
    r.segInversions.map((x) => x.seg),
    ['P04'],
    '不豁免的 P04（B 3 词 > A 2 词）进倒挂；豁免的 P03 不进',
  );
  // 对照实验：去掉豁免回调，P03 必须出现——豁免抑制是真的在起作用，不是碰巧没有
  const noExempt = run(CH3);
  assert.deepEqual(
    noExempt.segInversions.map((x) => x.seg),
    ['P03', 'P04'],
    '去掉豁免后 P03 立刻出现——证明 P03 的缺席是豁免在起作用',
  );
  assert.deepEqual(r.semantic, [], '语义不触发形（数字子集/专名保留/否定 2→2）不许报');
  assert.deepEqual(r.density.A, { per100: 0, worst: { d: 0, at: '' } }, '零注释章的密度锁零值与空最差段（防除零形态）');
  assert.deepEqual(r, GOLDEN_CH3);
});

/* ── 口径唯一（9e 纪律扫描，参照 concordance 1b 先例）── */

test('★ 纪律扫描：golden 与回放层不许自算维度——判定只准 import core/acceptance', () => {
  /* golden 锁行为、回放层锁真项目的数，两层都**只许消费** src/core/acceptance.ts。
   * 这里扫的是测试源文件自己的形状：一旦有人把 1.15 容差算术、cleanForAcceptance、
   * makeIsUnknown、IRREG 表之类的判定逻辑**复刻**进测试（而不是 import），
   * 尺子就分叉了——同一段文本两处各算各的，golden 红了也不知道该信谁。
   * （断言值与注释里的 1.15 字面量不在禁止之列——禁的是拿它做乘法比较的本地算术。） */
  const forbidden: Array<[string, RegExp, string]> = [
    ['tests/acceptance_golden.test.ts', /[)\w]\s*\*\s*1\.15\b|1\.15\s*\*\s*[\w(]/u, '本地复刻 1.15 容差算术（判容忍度只准走 SENT_RATIO_TOLERANCE）'],
    ['tests/acceptance_golden.test.ts', /function\s+(cleanForAcceptance|makeIsUnknown|annoTypesOf|unnotedTokensOf|sentLensOfSegs|semanticSuspectsOf)\s*\(/u, '本地复刻判定函数'],
    ['tests/acceptance_golden.test.ts', /(?:const|let)\s+IRREG\s*[=:]/u, '本地复刻不规则形表'],
    ['tests/replay.test.ts', /[)\w]\s*\*\s*1\.15\b|1\.15\s*\*\s*[\w(]/u, '回放层本地复刻 1.15 容差算术'],
    ['tests/replay.test.ts', /function\s+(cleanForAcceptance|makeIsUnknown|annoTypesOf|unnotedTokensOf|sentLensOfSegs|semanticSuspectsOf)\s*\(/u, '回放层本地复刻判定函数'],
    ['tests/replay.test.ts', /(?:const|let)\s+IRREG\s*[=:]/u, '回放层本地复刻不规则形表'],
  ];
  for (const [file, re, why] of forbidden) {
    const body = readFileSync(join(REPO, file), 'utf-8');
    assert.equal(re.test(body), false, `${file}：${why}——判定维度只准 import src/core/acceptance.ts`);
  }
  // 正向证明：golden 真的在 import 唯一实现（文件挪了/改名了这里要跟着改）
  assert.match(readFileSync(join(REPO, 'tests/acceptance_golden.test.ts'), 'utf-8'), /from '\.\.\/src\/core\/acceptance\.js'/, 'golden 必须 import core/acceptance');
});
