/**
 * 单句/单段改写服务契约 回归测试
 *
 * 验收标准（《LayerText 审查报告 v4_方向》第 1 条）：
 *   「App 与管线可以有不同上下文大小，但必须共用同一个输入输出 schema、
 *     同一个 `gateSegment` 判定和写入事务。App 单句改写当前只调用 `buildSystemPrompt`，
 *     随后只运行 `checkRev`，没有词表、词典、专名和事实检查。**这是残余 P0。**」
 *
 * 这里锁三件事：
 *   ① 两条路径调的是**同一个**判定（同一个 `gateSegment`，不是"差不多的两套检查"）；
 *   ② 单句 scope 有一条**有意的、写下来的**差异：只查"新引入的"超纲词；
 *   ③ 策略缺什么要**可见地缺**，不假装查过。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  annotationLedgerOf,
  checkRewrite,
  describeChecks,
  missingPolicyOf,
  oovOfText,
  policySlice,
  traceIdOf,
  type RewritePolicy,
  type RewriteRequest,
} from '../src/core/rewrite.js';
import { gateSegment } from '../src/core/segmentgate.js';
import { IRR } from '../src/core/irregular.js';

/** 与 App 的 `S.currentKnown` 同一口径：词表 ∪ 不规则形 ∪ 词句卡。
 *  不并 IRR 的话 ran/stood 会被判超纲——那是引擎既有口径（`hit` 不还原不规则动词），
 *  而 App 侧早就把 IRR 并进去了，夹具必须跟上，否则测的不是真实行为。 */
const KNOWN = [
  ...IRR,
  'the', 'boy', 'ran', 'to', 'red', 'barn', 'and', 'saw', 'a', 'small', 'dog', 'was', 'old', 'he', 'it',
  'structure', 'again', 'once', 'by', 'stood', 'here', 'there', 'today',
];

const req = (over: Partial<RewriteRequest> = {}): RewriteRequest => ({
  source: 'The boy ran to the red barn and saw a small dog.',
  scope: 'sentence',
  tier: 'A',
  bookVersion: 'run-1',
  promptVersion: 'p1',
  ...over,
});

const policy = (over: Partial<RewritePolicy> = {}): RewritePolicy => ({
  tier: 'A',
  maxLen: 20,
  known: KNOWN,
  annotated: [],
  dict: new Map(),
  ...over,
});

/* ────────────────── ① 同一个判定 ────────────────── */

test('两条路径调的是同一个 gateSegment：结论与直接调门禁逐字段一致', () => {
  const body = 'The boy ran to the red barn.';
  const r = checkRewrite(req(), policy(), body);
  const direct = gateSegment({ text: body, source: req().source, target: 0, maxLen: 20, oov: [], dict: new Map(), scope: 'sentence' });
  assert.deepEqual(r.checks, direct, '改写契约不许自己发明一套判定');
});

test('单句 scope 不补段号（给一句话前面加 [P01] 是错的）', () => {
  const r = checkRewrite(req(), policy(), 'The boy ran.');
  assert.equal(r.revised.startsWith('[P'), false);
  assert.equal(r.revised, 'The boy ran.');
});

test('段 scope 仍然补/纠正段号（管线侧行为不变）', () => {
  const r = checkRewrite(
    req({ scope: 'segment', source: '[P07] The boy ran to the red barn and saw a small dog.', markerId: 'P07' }),
    policy({ target: 12 }),
    'The boy ran to the red barn.',
  );
  assert.equal(r.revised.startsWith('[P07]'), true);
});

/* ────────────────── ② 单句 scope 的有意差异 ────────────────── */

test('单句 scope：源句本来就有的超纲词没注，不算这次改写的错（那是补注脚本的活）', () => {
  // windmill 在源句和改写句里都在，且全篇没注过 → 段级会拦，单句不拦
  const r = checkRewrite(
    req({ source: 'A windmill（风车） stood by the barn.' }),
    policy({ known: KNOWN }),
    'A windmill stood by the barn.',
  );
  assert.equal(r.checks.blockers.some((p) => p.ruleId === 'ANNO-01'), false, '源句固有的漏注不该算在单句改写头上');
});

test('单句 scope：这次改写**新引入**的超纲词必须注，否则拦下', () => {
  const r = checkRewrite(req(), policy(), 'The boy ran to a tremendous structure.');
  assert.equal(r.status, 'blocked');
  assert.equal(r.checks.blockers.some((p) => p.ruleId === 'ANNO-01'), true);
  assert.match(r.blockedReasons.join(' '), /tremendous/);
});

test('单句 scope：新引入的超纲词注了就通过', () => {
  const r = checkRewrite(req(), policy(), 'The boy ran to a tremendous（巨大的） structure.');
  assert.equal(r.status, 'candidate', r.blockedReasons.join('；'));
});

test('段级 scope 保持原语义：本段出现的超纲词（去掉别处已注的）都该注', () => {
  const r = checkRewrite(
    req({ scope: 'segment', source: '[P01] A windmill stood there.' }),
    policy({ target: 5 }),
    '[P01] A windmill stood there.',
  );
  assert.equal(r.checks.blockers.some((p) => p.ruleId === 'ANNO-01'), true, '段级仍然要求注');
});

test('已注词账本生效：别处注过的词，单句里再注会被判重复注（warn 不是 blocker）', () => {
  const r = checkRewrite(req(), policy({ annotated: ['barn'] }), 'The boy ran to the barn（谷仓） again.');
  assert.equal(r.checks.warns.some((p) => p.ruleId === 'ANNO-02'), true);
  assert.equal(r.status, 'candidate', '重复注是待判断，不该把候选整个毙掉');
});

test('统一词典生效：释义与全书不一致要报出来（同词同义）', () => {
  const dict = new Map([['barn', '谷仓']]);
  const bad = checkRewrite(req(), policy({ dict }), 'The boy ran to a barn（仓房） today.');
  assert.equal(bad.checks.warns.some((p) => p.ruleId === 'ANNO-03'), true);
  const good = checkRewrite(req(), policy({ dict }), 'The boy ran to a barn（谷仓） today.');
  assert.equal(good.checks.warns.some((p) => p.ruleId === 'ANNO-03'), false);
});

test('句长与中文混入照拦（这两条单句 scope 完全适用）', () => {
  const long = checkRewrite(req(), policy({ maxLen: 5 }), 'The boy ran to the red barn and saw a small dog.');
  assert.equal(long.checks.blockers.some((p) => p.ruleId === 'SENT-01'), true);
  const zh = checkRewrite(req(), policy(), 'The boy 跑了 to the barn.');
  assert.equal(zh.checks.blockers.some((p) => p.ruleId === 'ZH-01'), true);
});

test('段级长度约束在单句 scope 下彻底不参与（拿整段目标卡一句话是错的用法）', () => {
  const r = checkRewrite(req(), policy({ target: 999 }), 'The boy ran.');
  assert.equal(r.checks.blockers.some((p) => p.ruleId === 'LEN-01'), false);
  assert.equal(r.checks.target, 0);
});

test('事实类仍是待判断：丢数字只进 warn，不把候选毙掉', () => {
  const r = checkRewrite(
    req({ source: 'In 1911 the boy ran to the barn.' }),
    policy(),
    'Once the boy ran to the barn.',
  );
  assert.equal(r.status, 'candidate');
  assert.equal(r.checks.warns.some((p) => p.ruleId === 'FACT-01'), true);
});

/* ────────────────── ③ 策略缺什么要可见 ────────────────── */

test('策略齐备时没有 missingPolicy', () => {
  assert.deepEqual(missingPolicyOf(policy({ dict: new Map([['barn', '谷仓']]) })), []);
  // 空词典 = 等于没给：释义一致性这条根本查不了
  assert.deepEqual(missingPolicyOf(policy()), ['统一词典（本句无法判断释义是否与全书一致）']);
});

test('缺词典 / 缺账本 / 缺词表 → 明确写出来，不假装查过', () => {
  const miss = missingPolicyOf({ tier: 'A', maxLen: 20, known: [] });
  assert.equal(miss.length, 3);
  assert.match(miss.join('，'), /已注词账本/);
  assert.match(miss.join('，'), /统一词典/);
  assert.match(miss.join('，'), /学生词汇表/);
  // 空词典 = 等于没给
  assert.equal(missingPolicyOf(policy({ dict: new Map() })).length, 1);
});

test('界面文案把"未带什么"说出来（教师才知道这次判定凭不凭得住）', () => {
  const r = checkRewrite(req(), { tier: 'A', maxLen: 20, known: KNOWN }, 'The boy ran.');
  const s = describeChecks(r);
  assert.match(s, /通过门禁/);
  assert.match(s, /本次未带/);
});

/* ────────────────── traceId：可复现 ────────────────── */

test('traceId 稳定且区分要素：同输入同 ID，换书版本/原文/意图/提示词版本就换 ID', () => {
  const a = traceIdOf(req());
  assert.equal(traceIdOf(req()), a);
  assert.notEqual(traceIdOf(req({ bookVersion: 'run-2' })), a);
  assert.notEqual(traceIdOf(req({ source: 'Other.' })), a);
  assert.notEqual(traceIdOf(req({ intent: '太长' })), a);
  assert.notEqual(traceIdOf(req({ promptVersion: 'p2' })), a);
  assert.equal(a.length, 16);
  // 同一份原文在单句与段级下是两条不同的记录（判定口径不同）
  assert.notEqual(traceIdOf(req({ scope: 'segment' }), 'segment'), a);
});

/* ────────────────── 局部切片：分离上下文与成本 ────────────────── */

test('App 切片：专名并进已知词（与管线同一口径，专名不加注）', () => {
  const p = policySlice({ tier: 'A', maxLen: 20, known: KNOWN, properNames: ['Napoleon', 'Boxer'] });
  assert.equal([...p.known].includes('napoleon'), true);
  assert.equal([...p.known].includes('boxer'), true);
  assert.equal(p.target, 0, '单句切片不该带段级长度目标');
});

test('App 切片：词典只带本句相关的那几条（成本与上下文分离）', () => {
  const full = new Map([['barn', '谷仓'], ['windmill', '风车'], ['boxer', '拳师']]);
  const p = policySlice({
    tier: 'A', maxLen: 20, known: KNOWN, properNames: [],
    annotated: [], dict: full, involved: ['barn', 'the', 'ran'],
  });
  assert.deepEqual([...p.dict!.keys()], ['barn'], '只带本句命中词，不是整份词典');
});

test('App 切片：别处已注过的词不进切片词典（省 token 且不可能被误用）', () => {
  const full = new Map([['barn', '谷仓'], ['windmill', '风车']]);
  const p = policySlice({
    tier: 'A', maxLen: 20, known: KNOWN, properNames: [],
    annotated: ['barn'], dict: full, involved: ['barn', 'windmill'],
  });
  assert.deepEqual([...p.dict!.keys()], ['windmill']);
});

test('切片判定结果与全量判定一致：同一句话不该因为"给多给少"而结论不同', () => {
  const full = new Map([['tremendous', '巨大的']]);
  const body = 'The boy ran to a tremendous（巨大的） structure.';
  const p1 = policy({ dict: full });
  const p2 = policySlice({ tier: 'A', maxLen: 20, known: KNOWN, properNames: [], annotated: [], dict: full, involved: ['tremendous'] });
  const a = checkRewrite(req(), p1, body);
  const b = checkRewrite(req(), p2, body);
  assert.equal(a.status, b.status);
  assert.deepEqual(
    a.checks.blockers.map((x) => x.ruleId),
    b.checks.blockers.map((x) => x.ruleId),
  );
});

/* ────────────────── 词表工具 ────────────────── */

test('oovOfText 与引擎同一口径：后缀还原命中、去单字母、不规则形要靠 IRR', () => {
  // boys→boy、barns→barn 靠后缀还原命中；the/and 不在表里就是超纲
  const oov = oovOfText('The boys ran and the barns stood.', ['boy', 'barn', ...IRR]);
  assert.deepEqual(oov, ['the', 'and'], 'ran/stood 靠 IRR 命中（与 App 口径一致）');
  // 引擎不还原不规则动词——不给 IRR 时 ran/stood 就是超纲（这是既有口径，不是本模块引入的）
  assert.deepEqual(oovOfText('ran stood.', ['run', 'stand']), ['ran', 'stood']);
  assert.deepEqual(oovOfText('A tremendous structure.', ['a', 'structure']), ['tremendous']);
});

test('annotationLedgerOf：从多段正文还原已注词账本', () => {
  const led = annotationLedgerOf('A barn（谷仓） here.', 'A barn again, and a windmill（风车） there.');
  assert.deepEqual([...led].sort(), ['barn', 'windmill']);
  assert.equal(annotationLedgerOf('No annotations.').size, 0);
});

test('返回的正文与判定用的正文是同一个字符串（不许"判 A 写 B"）', () => {
  const r = checkRewrite(
    req({ scope: 'segment', source: '[P07] The boy ran to the red barn.', markerId: 'P07' }),
    policy({ target: 12 }),
    'The boy ran to the barn.',   // 模型漏写段号
  );
  assert.equal(r.revised, '[P07] The boy ran to the barn.', '返回的必须已经带上段号');
  // 再判一次：拿返回的正文当输入，结论必须一致（幂等）
  const again = checkRewrite(
    req({ scope: 'segment', source: '[P07] The boy ran to the red barn.', markerId: 'P07' }),
    policy({ target: 12 }),
    r.revised,
  );
  assert.equal(again.revised, r.revised);
  assert.deepEqual(again.checks.blockers.map((p) => p.ruleId), r.checks.blockers.map((p) => p.ruleId));
});

test('别处注过、这里又注 → ANNO-02（段内重复与跨段重复由同一条规则管）', () => {
  const r = checkRewrite(req(), policy({ annotated: ['barn'] }), 'The boy ran to the barn（谷仓） again.');
  const p = r.checks.warns.find((x) => x.ruleId === 'ANNO-02');
  assert.ok(p, '第 1 章注过的词在第 5 章再注，必须被抓住');
  assert.deepEqual(p.detail?.words, ['barn']);
});

test('ANNO-02 段内重复与跨段重复会合并成一条（同一条规则只出一个判定处）', () => {
  const r = checkRewrite(
    req(),
    policy({ annotated: ['windmill'] }),
    'A barn（谷仓） and a barn（仓房） and a windmill（风车） here.',
  );
  const hits = r.checks.warns.filter((x) => x.ruleId === 'ANNO-02');
  assert.equal(hits.length, 1, '不该出现两条 ANNO-02');
  assert.deepEqual([...hits[0]!.detail!.words as string[]].sort(), ['barn', 'windmill']);
});
