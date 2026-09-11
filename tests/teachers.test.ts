/**
 * 教师稳定 ID + 名录（roster）· 测试
 *
 * 验收（《LayerText 工程优化总计划》阶段 3）：
 *   「Run/Artifact/Decision/**Teacher** 四类实体有稳定 ID」
 *   「两位教师同时对同一本书不同层级运行不会覆盖词典、日志或产物」
 *
 * 这一组用例盯的是一个**至今仍然存在**的真实缺陷：Run 有 `runId`、Artifact 有 `artifactIdOf`、
 * Decision 有 `eventId`，**教师一直只是一个自由字符串**。于是
 *   · `--teacher wayne` / `--teacher Wayne` / `--teacher 'wayne '` 是三个人：
 *     三个 runId、三份分片指针、三堆决定事件，而没有任何地方会说一句话；
 *   · `process.env.USER` 是机器账号不是人（两个教师共用一台机器 → 同一个身份；
 *     一个人两台机器 → 两个身份），两个方向都错；
 *   · 「谁在这本书上干过活」答不出来——而这正是阶段 3「多教师」的第一问。
 *
 * 每个断言都是"缺了这条行为就会红"的那种；端到端那几条真跑子进程、
 * 真建临时项目（`--new` 两次、`--teachers`、坏名录），因为"库是对的、脚本没用它"
 * 是这类改造里最尴尬也最常见的结果。
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  describeTeacherResolution,
  diskOnlyTeachers,
  findTeacherRecord,
  formatTeacherRoster,
  infoNoticesOf,
  isRealTeacher,
  parseTeacherRegistry,
  registryOnlyTeachers,
  resolveTeacherName,
  serializeTeacherRegistry,
  suggestTeachers,
  teacherIdOf,
  teacherIdOrUnknown,
  teacherRosterOf,
  warningNoticesOf,
  withTeacher,
  type TeacherRecord,
  type TeacherRegistry,
} from '../src/core/teachers.js';
import { fileSafe, pointerNameOf } from '../src/core/manifest.js';

/** 自己的编译输出目录（如 dist-a。**绝不用共享的 dist/**：多人同时改仓库时它会被人重编）。 */
const DIST = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = join(DIST, '..');
const AF = join(REPO, 'tools', 'af_pipeline');
const LIST = 'LayerText_AF清单.mjs';
const DATE = '2026-01-01';
/* 子进程与**进程内**的动态 import 都要走自己的 dist-a：
 * 共享模块的 `distOf()` 认这个环境变量，于是 `readRunIdentity` 也用同一份引擎。 */
process.env.LAYERTEXT_DIST = DIST;

const read = (p: string): string => readFileSync(p, 'utf-8');
const REG = '教师名录.json';

/* ────────────────────── ① 归一化：稳定 ID = 归一化后的名字 ────────────────────── */

test('★ 稳定 ID：大小写 / 首尾与连续空白 / 全半角都是**同一个人的同一种笔误**', () => {
  assert.equal(teacherIdOf('wayne'), 'wayne', '已经是 ID 的写法一个字都不许改（旧运行照常解析的前提）');
  assert.equal(teacherIdOf('Wayne'), 'wayne');
  assert.equal(teacherIdOf('wayne '), 'wayne');
  assert.equal(teacherIdOf(' wayne '), 'wayne');
  assert.equal(teacherIdOf('Wayne\t'), 'wayne', '制表符也是空白');
  assert.equal(teacherIdOf('Ｗａｙｎｅ'), 'wayne', '全角（中文输入法）与半角同一个人');
  assert.equal(teacherIdOf('张 老师'), '张 老师', '中文名保留（只折叠空白，不做拼音化）');
  assert.equal(teacherIdOf('张  老师'), '张 老师', '连续空白折成一个空格');
  assert.equal(teacherIdOf('张老师'), '张老师', '不加空格的写法**不**与"张 老师"合并——工具不猜');
});

test('★ 空名：`teacherIdOf` 说"没有名字"，`teacherIdOrUnknown` 才退到 unknown（旧口径）', () => {
  assert.equal(teacherIdOf(''), '');
  assert.equal(teacherIdOf('   '), '');
  assert.equal(teacherIdOf(null), '');
  assert.equal(teacherIdOf(undefined), '');
  assert.equal(teacherIdOrUnknown(''), 'unknown');
  assert.equal(teacherIdOrUnknown(undefined), 'unknown', '复刻脚本里 process.env.USER ?? "unknown" 的既有口径');
  assert.equal(teacherIdOrUnknown('Wayne '), 'wayne');
  assert.equal(isRealTeacher('wayne'), true);
  assert.equal(isRealTeacher('unknown'), false, 'unknown 不是人：它不参与"谁做过什么"');
  assert.equal(isRealTeacher(''), false);
});

test('归一化是幂等的（ID 再归一化还是自己）——否则每读一次名字都会漂一点', () => {
  for (const s of ['wayne', 'Wayne ', 'Ｗａｙｎｅ', '张 老师', 'zhang-lao-shi']) {
    assert.equal(teacherIdOf(teacherIdOf(s)), teacherIdOf(s));
  }
});

/* ────────────────────── ② 指针文件名：这一条才是"分片"能不能成立的关键 ────────────────────── */

test('★ 指针按**人**分片，不按**字符串**分片——这正是修好"拼错一个字母就多一个人"的地方', () => {
  const want = { teacher: teacherIdOf('Wayne '), tier: 'A层85' };
  assert.equal(pointerNameOf(want), '清单_wayne_A层85.json');
  // 旧行为的两半：`Wayne` 会算成另一个文件名（分片失效、多出一个教师），
  // 而 `wayne ` 因为 fileSafe 会修剪首尾，本来就是同名——所以"只修空白"是不够的。
  assert.equal(fileSafe('Wayne'), 'Wayne');
  assert.notEqual(pointerNameOf({ teacher: 'Wayne', tier: 'A层85' }), pointerNameOf({ teacher: 'wayne', tier: 'A层85' }), '老代码：大小写不同 = 两个分片指针');
  assert.equal(pointerNameOf({ teacher: teacherIdOf('wayne '), tier: 'A层85' }), pointerNameOf({ teacher: 'wayne', tier: 'A层85' }), '新代码：归一到同一个文件');
  // 真实项目（AnimalFarm，2026-09-11 建）里教师是 wayne —— 归一化之后**一个字都没变**
  assert.equal(pointerNameOf({ teacher: teacherIdOf('wayne'), tier: 'A层85' }), '清单_wayne_A层85.json');
});

/* ────────────────────── ③ 名录：登记、别名、坏文件 ────────────────────── */

const regWith = (...recs: Partial<TeacherRecord>[]): TeacherRegistry => ({
  schemaVersion: 1,
  updatedAt: '2026-01-01T00:00:00.000Z',
  teachers: recs.map((r) => ({ id: r.id ?? '', name: r.name ?? r.id ?? '', aliases: r.aliases ?? [] })),
});

test('登记：归一化之后同一个人**只长一条**记录（`Wayne` 不会在 `wayne` 旁边再长一条）', () => {
  const a = withTeacher(null, { raw: 'Wayne ', now: '2026-01-01T00:00:00.000Z' });
  assert.equal(a.created, true);
  assert.equal(a.id, 'wayne');
  assert.equal(a.registry.teachers.length, 1);
  assert.equal(a.registry.teachers[0]!.name, 'Wayne', '显示名保留人写的那一种写法（ID 要稳定，名字要好看）');
  const b = withTeacher(a.registry, { raw: 'Wayne', now: '2026-01-02T00:00:00.000Z' });
  assert.equal(b.created, false);
  assert.equal(b.registry.teachers.length, 1, '第二次登记不许再多一条');
  assert.equal(b.registry.teachers[0]!.lastSeenAt, '2026-01-02T00:00:00.000Z');
  assert.deepEqual(b.droppedAliases, ['Wayne'], '与 ID 归一化后相同的写法不进别名（记了只会让人以为两者有区别）');
});

test('别名：归一化统一不了的其它写法由**人**写明（中文名 vs 英文工号）', () => {
  const reg = withTeacher(null, { raw: 'wayne' }).registry;
  reg.teachers[0]!.aliases = ['洪梓境'];
  const hit = findTeacherRecord(reg, teacherIdOf('洪梓境'));
  assert.equal(hit?.via, 'alias');
  assert.equal(hit?.record.id, 'wayne', '别名把两种写法指向同一个人——只有人写得出来，工具不许猜');
  assert.equal(findTeacherRecord(reg, 'zhang')?.record, undefined);
});

test('★ unknown / 空名**不进名录**：它不是人，登记进去只会让"谁干过活"多一个假条目', () => {
  const r = withTeacher(null, { raw: '   ' });
  assert.equal(r.id, 'unknown');
  assert.equal(r.record, null);
  assert.equal(r.registry.teachers.length, 0);
  const r2 = withTeacher(r.registry, { raw: 'unknown' });
  assert.equal(r2.created, false);
  assert.equal(r2.registry.teachers.length, 0);
});

test('名录解析：坏 JSON / 缺 id / 重复 id 都要**说出来**，而不是当成空名录咽下去', () => {
  const broken = parseTeacherRegistry('{ 这不是 JSON');
  assert.equal(broken.problems.length, 1);
  assert.match(broken.problems[0]!, /JSON/);
  assert.deepEqual(broken.registry.teachers, [], '读不出来时按空名录处理（调用方据此拒绝登记，不覆盖）');

  const messy = parseTeacherRegistry(JSON.stringify({ schemaVersion: 1, teachers: [{ name: '没有 id' }, { id: 'Wayne', name: 'Wayne' }, { id: 'wayne', name: 'wayne' }] }));
  assert.equal(messy.registry.teachers.length, 1, '缺 id 的跳过、重复 id 的合并——重名会让"谁做过什么"分成两半');
  assert.equal(messy.registry.teachers[0]!.id, 'wayne', 'id 也归一化：名录里的 `Wayne` 与运行里的 `wayne` 必须落进同一条');
  assert.equal(messy.problems.length, 2, '两条问题（缺 id、重复 id）都要报出来');

  const none = parseTeacherRegistry(null);
  assert.deepEqual(none.problems, [], '还没有名录文件不是"问题"——那是第一次用');
});

test('名录序列化可往返（落盘的就是读得回来的）', () => {
  const reg = withTeacher(null, { raw: 'Wayne', now: '2026-01-01T00:00:00.000Z' }).registry;
  const back = parseTeacherRegistry(serializeTeacherRegistry(reg));
  assert.deepEqual(back.problems, []);
  assert.deepEqual(back.registry.teachers, reg.teachers);
  assert.equal(serializeTeacherRegistry(reg).endsWith('\n'), true);
});

/* ────────────────────── ④ 解析：名录里没有这个人时怎么办 ────────────────────── */

test('★ 名录里有这个名字 → 在册，一句话不说（日常路径不许变成噪音）', () => {
  const reg = regWith({ id: 'wayne', name: 'Wayne' });
  const r = resolveTeacherName('wayne', reg);
  assert.equal(r.id, 'wayne');
  assert.equal(r.status, '在册');
  assert.equal(r.changed, false);
  assert.deepEqual(r.notices, []);
});

test('★ 归一化改过写法 → **一定说出来**（`Wayne ` 记成 `wayne` 这件事不许静默）', () => {
  const reg = regWith({ id: 'wayne', name: 'wayne' });
  const r = resolveTeacherName('Wayne ', reg);
  assert.equal(r.id, 'wayne');
  assert.equal(r.status, '在册');
  assert.equal(r.changed, true);
  const text = describeTeacherResolution(r).join('\n');
  assert.match(text, /已归一成「wayne」/);
  assert.match(text, /Wayne /, '要有原样写法，否则人不知道是哪一次输入');
});

test('★ 名录里没有 → 不拒绝，但**大声**：列出名录里已有谁，且能不登记就说清"本次没登记"', () => {
  const reg = regWith({ id: 'wayne', name: 'wayne' }, { id: 'liu', name: 'liu' });
  const r = resolveTeacherName('chen', reg);
  assert.equal(r.id, 'chen', '拼不出"最像的那个"——工具不替人改名字');
  assert.equal(r.status, '未登记');
  assert.deepEqual(r.suggestions, [], 'chen 与 wayne/liu 差得远，不许报假警');
  const text = describeTeacherResolution(r).join('\n');
  assert.match(text, /不在名录里/);
  assert.match(text, /wayne、liu/, '"现在有谁"要摆出来——不然这个名字是"新人"还是"拼错"没人判断得了');
});

test('★ 疑似拼错：名录里只差一两个字符的名字要摆出来问一句（这才是"错字不再隐形"）', () => {
  const reg = regWith({ id: 'wayne', name: 'wayne' }, { id: 'zhanglaoshi', name: '张老师' });
  for (const typo of ['waynee', 'wanye', 'wayn']) {
    const r = resolveTeacherName(typo, reg);
    assert.equal(r.status, '未登记');
    assert.equal(
      r.suggestions.some((s) => s.id === 'wayne'),
      true,
      `${typo} 应该提示 wayne`,
    );
  }
  const near = resolveTeacherName('waynee', reg).notices.filter((n) => n.kind === 'teacher-typo-suspect');
  assert.equal(near.length, 1);
  assert.match(near[0]!.message, /wayne/);
  assert.match(near[0]!.message, /是同一个人|另一个人/, '要同时给出"两种可能各自怎么办"，否则这句话只是噪音');
  assert.equal(suggestTeachers('wayne', reg).length, 0, '自己不算"相近的别人"');
  assert.equal(suggestTeachers('liu', reg).length, 0, '差得远的名字不许报假警');
});

test('★ 没有名字 → warn（这条会进清单的账），并按 unknown 记', () => {
  const r = resolveTeacherName('   ', regWith({ id: 'wayne' }));
  assert.equal(r.id, 'unknown');
  assert.equal(r.status, '空名');
  assert.equal(warningNoticesOf(r).length, 1);
  assert.match(warningNoticesOf(r)[0]!.message, /分不清是谁做的/);
  assert.match(describeTeacherResolution(r).join('\n'), /--teacher wayne/, '要给出下一步动作');
});

test('★ 还没有名录文件 ≠ 名录里没有这个人：两者说的话不一样', () => {
  const noFile = resolveTeacherName('wayne', null);
  assert.equal(noFile.status, '未登记');
  assert.match(describeTeacherResolution(noFile).join('\n'), /还没有教师名录/);
  assert.match(describeTeacherResolution(noFile).join('\n'), /不需要任何迁移/, '旧项目第一次用时要先说清"不用改任何东西"');
});

test('名录的账分两档：说明白的话（info）与要留档的话（warn）', () => {
  const reg = regWith({ id: 'wayne', name: 'wayne' });
  const r = resolveTeacherName('waynee', reg);
  assert.equal(
    infoNoticesOf(r).every((n) => n.level === 'info'),
    true,
  );
  // warningNoticesOf 直接就是清单 `warnings` 的形状（{kind,message}）：说明白的话不落账，
  // 值得留档的（疑似拼错）才落账——一行 stderr 跑过去就没了，清单不会。
  assert.deepEqual(
    warningNoticesOf(r).map((n) => n.kind),
    ['teacher-typo-suspect'],
  );
  assert.equal(
    warningNoticesOf(r).every((n) => typeof n.message === 'string' && n.message.length > 10),
    true,
  );
  assert.equal(
    infoNoticesOf(r).some((n) => n.kind === 'teacher-unregistered'),
    true,
  );
});

/* ────────────────────── ⑤ 名册：谁在这本书上干过活 ────────────────────── */

test('★ 名册来自**两个来源**：盘上清单说"谁真的跑过"，名录说"还有哪些写法"', () => {
  const reg = withTeacher(null, { raw: 'wayne' }).registry;
  reg.teachers[0]!.aliases = ['洪梓境'];
  reg.teachers.push({ id: 'liu', name: '刘老师', aliases: [] });
  const list = teacherRosterOf({
    registry: reg,
    runs: [
      { runId: 'run-1', teacher: 'wayne', tiers: ['A'], updatedAt: '2026-01-02T00:00:00.000Z' },
      { runId: 'run-2', teacher: 'wayne ', tiers: ['M'], createdAt: '2026-01-03T00:00:00.000Z' },
      { runId: 'run-3', teacher: 'chen', tiers: ['A'], updatedAt: '2026-01-01T00:00:00.000Z' },
    ],
  });
  const wayne = list.find((e) => e.id === 'wayne')!;
  assert.equal(wayne.runCount, 2, '归一化之后两次运行算**一个人**的');
  assert.deepEqual(wayne.rawNames, ['wayne '], '盘上那个多余的空格要留证——归一化不许静默改写历史');
  assert.deepEqual(wayne.tiers, ['A', 'M']);
  assert.equal(wayne.lastAt, '2026-01-03T00:00:00.000Z', '最近一次取 updatedAt/createdAt 里最大的那个');
  const chen = list.find((e) => e.id === 'chen')!;
  assert.equal(chen.registered, false);
  assert.equal(chen.runCount, 1);
  assert.deepEqual(
    diskOnlyTeachers(list).map((e) => e.id),
    ['chen'],
    '盘上有、名录里没有 = 旧运行遗留，要说出来',
  );
  assert.deepEqual(
    registryOnlyTeachers(list).map((e) => e.id),
    ['liu'],
    '名录里有、一次没跑过 = 也要说，否则名录会先于事实被当成权威',
  );
  assert.deepEqual(
    list.map((e) => e.id),
    ['wayne', 'chen', 'liu'],
    '跑得多的在前，其余按 ID 定序（报表要能逐字对比）',
  );
});

test('名册的人读文本：跑过的、名录独有的、盘上独有的三类都要出现', () => {
  const list = teacherRosterOf({
    registry: withTeacher(null, { raw: 'liu' }).registry,
    runs: [{ runId: 'r1', teacher: 'wayne', tiers: ['A'] }],
  });
  const text = formatTeacherRoster(list, { registryExists: false }).join('\n');
  assert.match(text, /wayne/);
  assert.match(text, /1 次运行/);
  assert.match(text, /不在名录里/);
  assert.match(text, /liu/, '名录里那位也要列出来');
  assert.match(text, /从没在这本书上跑过/);
  assert.match(text, /还没有教师名录/);
  assert.match(formatTeacherRoster([], {}).join('\n'), /还没有任何教师记录/);
});

/* ────────────────────── ⑥ 端到端：脚本真的这么干了吗 ────────────────────── */

interface Proj {
  root: string;
  json: string;
  out: string;
  run: (args: string[]) => { status: number | null; out: string };
}

/** 建一个自检项目（内容**逐字节可复现**：两个项目内容相同 ⇒ 同一个 runId，这一点是下面那条断言的支点） */
function makeProject(book = '教师自检'): Proj {
  const root = mkdtempSync(join(tmpdir(), 'lt-teach-'));
  const w = (...p: string[]): string => join(root, ...p);
  mkdirSync(w('原文', '第一章'), { recursive: true });
  mkdirSync(w('调适'), { recursive: true });
  mkdirSync(w('产物'), { recursive: true });
  writeFileSync(w('原文', '第一章', '原文_规范化.md'), '## Chapter One\n\n[P01] The boy ran to the red barn.\n', 'utf-8');
  writeFileSync(w('词库.csv'), ['词,类型', ...['the', 'boy', 'ran', 'to', 'red', 'barn'].map((x) => `${x},单词`)].join('\n') + '\n', 'utf-8');
  writeFileSync(w('专名表.txt'), '# 专名\n', 'utf-8');
  writeFileSync(w('知识库.csv'), '类型,词,值,次数\n', 'utf-8');
  writeFileSync(w('词典.csv'), '词,释义,来源\n', 'utf-8');
  const json = w('调适项目_自检.json');
  writeFileSync(
    json,
    JSON.stringify(
      {
        书名: book,
        工作区: root,
        调适工作区: w('调适'),
        原文目录: w('原文'),
        产物目录: w('产物'),
        词库: w('词库.csv'),
        书级: { 专名表: w('专名表.txt'), 知识库: w('知识库.csv'), 词典: w('词典.csv') },
        日期: DATE,
        章数: 1,
        引擎目录: REPO,
      },
      null,
      2,
    ),
    'utf-8',
  );
  const env = { ...process.env, LAYERTEXT_PROJECT: json, LAYERTEXT_ENGINE: REPO, LAYERTEXT_DIST: DIST };
  const run = (args: string[]): { status: number | null; out: string } => {
    const r = spawnSync(process.execPath, [join(AF, LIST), ...args], { cwd: REPO, encoding: 'utf-8', env });
    return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  };
  return { root, json, out: w('产物'), run };
}

const runDirOf = (p: Proj): string => join(p.out, '_运行');
const newRun = (p: Proj, teacher: string, tier = 'A'): { status: number | null; out: string } => p.run(['--new', '--tier', tier, '--chapters', '1', '--teacher', teacher]);

test('★ 同一个人的三种写法建出来的运行**必须是同一次运行**（老代码是三次）', () => {
  const a = makeProject();
  const b = makeProject();
  const ra = newRun(a, 'Wayne ');
  const rb = newRun(b, 'wayne');
  assert.equal(ra.status, 0, ra.out);
  assert.equal(rb.status, 0, rb.out);
  const ida = /运行 ID：(\S+)/.exec(ra.out)?.[1] ?? '';
  const idb = /运行 ID：(\S+)/.exec(rb.out)?.[1] ?? '';
  assert.notEqual(ida, '');
  assert.equal(ida, idb, '`Wayne ` 与 `wayne` 必须是同一次运行：runId 里拼的是稳定 ID');
  // 老代码在这里会红：`slug('Wayne ')` = 'Wayne'，于是 runId 里是 `-Wayne-`，与 `-wayne-` 不同
  assert.match(ida, /-wayne-/, 'runId 里不许出现 `Wayne` 这种写法');
  const m = JSON.parse(read(join(runDirOf(a), `清单_${ida}.json`))) as { teacher: string };
  assert.equal(m.teacher, 'wayne', '清单里记的是**稳定 ID**（runId / 指针 / 决定事件三处同源）');
  assert.match(ra.out, /已归一成「wayne」/, '归一化这件事要打印出来，不许静默');
  assert.equal(existsSync(join(runDirOf(a), '清单_wayne_A层85.json')), true, '分片指针按稳定 ID 命名');
  assert.equal(existsSync(join(runDirOf(a), '清单_Wayne-_A层85.json')), false);
});

test('★ 名录是 `--new` 顺手建的：再问一次"谁在这本书上干过活"答得出人来', () => {
  const p = makeProject();
  assert.equal(newRun(p, 'wayne').status, 0);
  const regPath = join(runDirOf(p), REG);
  assert.equal(existsSync(regPath), true);
  const reg = JSON.parse(read(regPath)) as TeacherRegistry;
  assert.deepEqual(
    reg.teachers.map((t) => t.id),
    ['wayne'],
  );
  const t = p.run(['--teachers']);
  assert.equal(t.status, 0, t.out);
  assert.match(t.out, /wayne/);
  assert.match(t.out, /1 次运行/);
  assert.match(t.out, /层 A/);
});

test('★ 第二个名字出现时是**被看见**的：疑似拼错会打印，也会写进清单的账（--verify 每次都能翻到）', () => {
  const p = makeProject();
  assert.equal(newRun(p, 'wayne').status, 0);
  const typo = newRun(p, 'waynee', 'B');
  assert.equal(typo.status, 0, typo.out);
  assert.match(typo.out, /⚠/);
  assert.match(typo.out, /wayne/, '要指出名录里最像的那一个');
  const id = /运行 ID：(\S+)/.exec(typo.out)?.[1] ?? '';
  const m = JSON.parse(read(join(runDirOf(p), `清单_${id}.json`))) as { warnings: { kind: string; message: string }[]; teacher: string };
  assert.equal(m.teacher, 'waynee', '确实是另一个人时照常开工——不拒绝第一次用的人');
  assert.equal(
    m.warnings.some((w) => w.kind === 'teacher-typo-suspect'),
    true,
    '打印一行跑过去就没了；这条必须留在清单的账上',
  );
  const v = p.run(['--verify', '--tier', 'B']);
  assert.match(v.out, /teacher-typo-suspect/, '--verify 必须能翻到它（这就是"留档"的意义）');
  const roster = p.run(['--teachers']);
  assert.match(roster.out, /wayne/);
  assert.match(roster.out, /waynee/);
});

test('★ 列名录是只读的：没有名录文件时`--teachers`不写盘，但不妨碍它答出"盘上谁跑过"', () => {
  const p = makeProject();
  assert.equal(newRun(p, 'wayne').status, 0);
  const regPath = join(runDirOf(p), REG);
  unlinkSync(regPath); // 模拟"归一化之前建的项目"：有运行、没有名录
  const before = read(join(runDirOf(p), '清单_最新.json'));
  const t = p.run(['--teachers']);
  assert.equal(t.status, 0, t.out);
  assert.equal(existsSync(regPath), false, '看一眼不该改盘上的东西');
  assert.equal(read(join(runDirOf(p), '清单_最新.json')), before);
  assert.match(t.out, /wayne/);
  assert.match(t.out, /1 次运行/);
  assert.match(t.out, /不在名录里/, '旧运行遗留要说出来：名录不是权威，盘上的清单才是');
  assert.match(t.out, /不需要迁移/);
  assert.equal(newRun(p, 'wayne').status, 0, '旧项目照常建下一次运行');
  assert.equal(existsSync(regPath), true, '下一次 --new 自动把它登记上');
});

test('★ 归一化之前建的运行照常读得出来：清单里记 `Wayne`、指针也叫 `清单_Wayne_A层85.json`（真项目的形状）', async () => {
  const p = makeProject();
  const r = newRun(p, 'wayne');
  assert.equal(r.status, 0, r.out);
  const runDir = runDirOf(p);
  const id = /运行 ID：\S+/.exec(r.out)?.[0].replace('运行 ID：', '') ?? '';
  const manPath = join(runDir, `清单_${id}.json`);
  // 把盘上改成"归一化之前"的样子：清单里记 `Wayne`、指针文件名也跟着是 `Wayne`
  const m = JSON.parse(read(manPath)) as { teacher: string };
  m.teacher = 'Wayne';
  writeFileSync(manPath, JSON.stringify(m, null, 2), 'utf-8');
  renameSync(join(runDir, '清单_wayne_A层85.json'), join(runDir, '清单_Wayne_A层85.json'));
  unlinkSync(join(runDir, '清单_最新.json')); // 断掉"最近一次"这条退路，逼它必须从分片指针读

  const SHARED = await import(join(AF, 'LayerText_AF词表与词典.mjs'));
  const P = SHARED.loadProject(p.json);
  const RUN = await SHARED.readRunIdentity({ out: P.产物目录, work: P.调适工作区 }, { teacher: 'wayne', tier: 'A层85' });
  assert.equal(RUN.source, '按教师分片', '必须从分片指针读到——不是靠"最近一次"兜底');
  assert.equal(RUN.runId, id, '拿到的还是同一个运行');
  assert.equal(RUN.teacher, 'wayne', '读的时候也归一化：`Wayne` 与 `wayne` 是同一个人');
  assert.match(RUN.warning ?? '', /Wayne/, '这份清单写的不是稳定 ID，这件事必须说出来（不许静默改写历史）');
  // 反向：另一个人不该被误认领（扫描兜底不许把别人的运行认领过来）
  const other = await SHARED.readRunIdentity({ out: P.产物目录, work: P.调适工作区 }, { teacher: 'liu', tier: 'A层85' });
  assert.notEqual(other.source, '按教师分片', '别人的名字不许认领这份指针');
  assert.notEqual(other.runId, id);
});

test('★ 文件名对不上、人也对得上时，靠**扫一遍**把老指针认回来（大小写之外的差异，任何文件系统都成立）', async () => {
  // 为什么单开一条：macOS 的大小写不敏感文件系统会让 `清单_wayne_…` 与 `清单_Wayne_…`
  // 是**同一个文件**，于是上一条在 macOS 上即使没有兜底扫描也会绿（在 Linux 上才会红）。
  // 这里用"连续空格"制造一个任何文件系统都不同的文件名：归一化之前的写法 `liu  ming`
  // 经 fileSafe 是 `liu--ming`，而稳定 ID `liu ming` 是 `liu-ming`。
  const p = makeProject();
  const r = newRun(p, 'liu  ming');
  assert.equal(r.status, 0, r.out);
  const runDir = runDirOf(p);
  const id = /运行 ID：(\S+)/.exec(r.out)?.[1] ?? '';
  assert.equal(existsSync(join(runDir, '清单_liu-ming_A层85.json')), true, '新指针按稳定 ID 命名');
  const manPath = join(runDir, `清单_${id}.json`);
  const m = JSON.parse(read(manPath)) as { teacher: string };
  m.teacher = 'liu  ming'; // 归一化之前记的是**原样写法**
  writeFileSync(manPath, JSON.stringify(m, null, 2), 'utf-8');
  renameSync(join(runDir, '清单_liu-ming_A层85.json'), join(runDir, '清单_liu--ming_A层85.json'));
  unlinkSync(join(runDir, '清单_最新.json'));

  const SHARED = await import(join(AF, 'LayerText_AF词表与词典.mjs'));
  const P = SHARED.loadProject(p.json);
  const RUN = await SHARED.readRunIdentity({ out: P.产物目录, work: P.调适工作区 }, { teacher: 'liu ming', tier: 'A层85' });
  assert.equal(RUN.source, '按教师分片');
  assert.equal(RUN.runId, id, '扫描兜底必须把它认回来（换任何文件系统、任何平台）');
  assert.equal(RUN.teacher, 'liu ming');
  assert.match(RUN.warning ?? '', /归一化之前/);
  assert.match(RUN.warning ?? '', /liu--ming/);
  // 层级要对得上：不许把别的层的运行认领过来
  const otherTier = await SHARED.readRunIdentity({ out: P.产物目录, work: P.调适工作区 }, { teacher: 'liu ming', tier: 'B层60' });
  assert.notEqual(otherTier.runId, id);
});

test('★ 名录坏掉时**拒绝登记**（不是覆盖它）：名册里的别名与显示名是人工信息，覆盖了就补不回来', () => {
  const p = makeProject();
  assert.equal(newRun(p, 'wayne').status, 0);
  const regPath = join(runDirOf(p), REG);
  const broken = '{ 这不是 JSON，是有人手改坏的';
  writeFileSync(regPath, broken, 'utf-8');
  const r = newRun(p, 'liu', 'B');
  assert.notEqual(r.status, 0, `坏名录上不许建清单：${r.out}`);
  assert.match(r.out, /读不出来/);
  assert.match(r.out, /不覆盖它/);
  assert.match(r.out, /教师名录\.json/);
  assert.equal(read(regPath), broken, '**一个字节都没改**——拒绝的含义就是拒绝');
});

test('为什么老代码一定会把 `Wayne` 当成第二个人（钉在这里，免得以后有人"顺手"改回去）', () => {
  // 老逻辑等价于直接用原始字符串拼 runId 与指针名。这里用 manifest 的两个纯函数复现它：
  const slug = (s: string): string => (s || 'x').replace(/[^\w\u4e00-\u9fff-]+/g, '').slice(0, 24) || 'x';
  assert.notEqual(slug('Wayne '), slug('wayne'), '老代码：runId 里 `Wayne` 与 `wayne` 不同 → 两次运行');
  assert.notEqual(pointerNameOf({ teacher: 'Wayne', tier: 'A层85' }), pointerNameOf({ teacher: 'wayne', tier: 'A层85' }), '老代码：两份分片指针');
  // 新逻辑把这两处都收在 teacherIdOf 后面
  assert.equal(slug(teacherIdOf('Wayne ')), slug(teacherIdOf('wayne')));
  assert.equal(pointerNameOf({ teacher: teacherIdOf('Wayne '), tier: 'A层85' }), pointerNameOf({ teacher: teacherIdOf('wayne'), tier: 'A层85' }));
});
