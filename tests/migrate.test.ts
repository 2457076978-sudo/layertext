/**
 * 布局迁移 CLI · 端到端（真跑子进程、真建临时项目）
 *
 * 验收（《LayerText 工程优化总计划》阶段 3）：
 *   「两位教师同时对同一本书不同层级运行不会覆盖词典、日志或产物」。
 *   `run` 布局能保证这一条，但**没人敢把默认翻过去**——翻过去会静默改掉教师已有文件的位置。
 *   于是缺的是"一次显式、可核对、可回滚的搬迁"，本组测试证明的就是这句话：
 *   默认演练不动盘、复制模式不删原件、第二次跑是幂等的、前置不过就一件都不搬、
 *   **迁完之后下游脚本真的还能找到产物**（这一条才是迁移的目的，不是把文件挪个地方就算完）。
 *
 * 每个断言都是"缺了这条行为就会红"的那种：不动盘的断言比的是**整棵树逐字节**，
 * 幂等的断言比的是**清单本身的字节**，下游那条断言比的是"台账落在哪一侧"。
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

/** 自己的编译输出目录（如 dist-c。**绝不用共享的 dist/**，多人同时改仓库时它会被人重编）。 */
const DIST = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = join(DIST, '..');
const AF = join(REPO, 'tools', 'af_pipeline');
const MIGRATE = 'LayerText_AF迁移.mjs';
const DATE = '2026-01-01';
const TAG = 'A层85';

interface Proj {
  root: string;
  json: string;
  runId: string;
  out: string;
  /** 产物目录/_运行/<runId> —— run 布局的私有目录 */
  priv: string;
  run: (script: string, args?: string[]) => { status: number | null; out: string };
}

const read = (p: string): string => readFileSync(p, 'utf-8');

/** 整棵树的逐字节指纹：**"什么都没改动"这种断言只能这么比**。 */
function tree(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) out[p.slice(root.length + 1)] = createHash('sha256').update(readFileSync(p)).digest('hex');
    }
  };
  walk(root);
  return out;
}

/** 建一个**legacy 布局**的临时项目：原文 + 词表 + 清单（`--new` 会写指针、词表正本与快照）。 */
function build(teacher = 'wayne'): Proj {
  const root = mkdtempSync(join(tmpdir(), 'lt-mig-'));
  const w = (...p: string[]): string => join(root, ...p);
  mkdirSync(w('原文', '第一章'), { recursive: true });
  mkdirSync(w('调适'), { recursive: true });
  mkdirSync(w('产物'), { recursive: true });
  writeFileSync(w('原文', '第一章', '原文_规范化.md'), '## Chapter One\n\n[P01] The boy ran to the red barn.\n', 'utf-8');
  const words = ['the', 'boy', 'ran', 'to', 'red', 'barn', 'and', 'saw', 'a', 'small', 'dog'];
  writeFileSync(w('词库.csv'), ['词,类型', ...words.map((x) => `${x},单词`)].join('\n') + '\n', 'utf-8');
  writeFileSync(w('专名表.txt'), '# 专名\n', 'utf-8');
  writeFileSync(w('知识库.csv'), '类型,词,值,次数\n', 'utf-8');
  writeFileSync(w('词典.csv'), '词,释义,来源\n', 'utf-8');
  const json = w('调适项目_自检.json');
  writeFileSync(
    json,
    JSON.stringify(
      {
        书名: '迁移自检',
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

  const env: NodeJS.ProcessEnv = { ...process.env, LAYERTEXT_PROJECT: json, LAYERTEXT_ENGINE: REPO, LAYERTEXT_DIST: DIST };
  // 外头若留着这两个变量，本组测试读到哪一次运行就成了环境问题——测试必须自足
  delete env.LAYERTEXT_RUN;
  delete env.LAYERTEXT_TEACHER;
  const run = (script: string, args: string[] = []): { status: number | null; out: string } => {
    const r = spawnSync(process.execPath, [join(AF, script), ...args], { cwd: REPO, encoding: 'utf-8', env });
    return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  };

  const init = run('LayerText_AF清单.mjs', ['--new', '--tier', 'A', '--chapters', '1', '--teacher', teacher]);
  assert.equal(init.status, 0, init.out);
  const runId = /运行 ID：(\S+)/.exec(init.out)?.[1] ?? '';
  assert.notEqual(runId, '', `没拿到运行 ID：${init.out}`);
  return { root, json, runId, out: w('产物'), priv: w('产物', '_运行', runId), run };
}

/** 往 legacy 落点放几件产物，再 `--stamp` 让清单登记它们（现实里就是这样走过来的）。 */
function seed(p: Proj, teacher = 'wayne'): void {
  mkdirSync(join(p.out, '第一章'), { recursive: true });
  mkdirSync(join(p.out, '_待复核', TAG), { recursive: true });
  mkdirSync(join(p.out, '_运行'), { recursive: true });
  writeFileSync(join(p.out, '第一章', `原文_${TAG}_${DATE}.md`), '## Chapter One\n\n[P01] The boy ran to the red barn（谷仓）.\n', 'utf-8');
  writeFileSync(join(p.out, `台账_${TAG}_${DATE}.md`), '# 台账（迁移前的旧稿）\n', 'utf-8');
  writeFileSync(join(p.out, `复核_${TAG}_${DATE}.md`), '# 复核\n', 'utf-8');
  writeFileSync(join(p.out, '_运行', `${TAG}.完成.json`), '{"完成":true}\n', 'utf-8');
  writeFileSync(join(p.out, '_运行', `风险队列_${TAG}.json`), '{"队列":[]}\n', 'utf-8');
  writeFileSync(join(p.out, '_待复核', TAG, '第一章_第7段.md'), '# 待复核\n', 'utf-8');
  const stamp = p.run('LayerText_AF清单.mjs', ['--stamp', '--tier', 'A', '--step', '生成', '--teacher', teacher]);
  assert.equal(stamp.status, 0, stamp.out);
}

/** legacy 落点 → run 落点（这两条是**本组测试要证明被搬过去**的东西） */
const legacyBody = (p: Proj): string => join(p.out, '第一章', `原文_${TAG}_${DATE}.md`);
const runBody = (p: Proj): string => join(p.priv, '正文', '第一章', `原文_${TAG}_${DATE}.md`);
const legacyLedger = (p: Proj): string => join(p.out, `台账_${TAG}_${DATE}.md`);
const runLedger = (p: Proj): string => join(p.priv, `台账_${TAG}_${DATE}.md`);

const manifestOf = (p: Proj): { layout: string; artifacts: { path: string; id?: string }[] } => JSON.parse(read(join(p.out, '_运行', `清单_${p.runId}.json`)));

const migrated = (teacher = 'wayne'): Proj => {
  const p = build(teacher);
  seed(p, teacher);
  const r = p.run(MIGRATE, ['--apply']);
  assert.equal(r.status, 0, r.out);
  return p;
};

/* ────────────────────── ① 默认就是演练 ────────────────────── */

test('① 不带 --apply：只打印计划，**整棵树逐字节不变**（教师的稿子只有一份）', () => {
  const p = build();
  seed(p);
  const before = tree(p.root);

  const r = p.run(MIGRATE);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /演练/, '输出必须说清这次是演练');
  assert.match(r.out, /--apply/, '演练必须告诉人"怎么才真做"');
  assert.match(r.out, /原文_A层85_2026-01-01\.md/, '演练要逐件列出会搬什么（不列出来人无从核对）');

  assert.deepEqual(tree(p.root), before, '演练必须一个字节都不写');
  assert.equal(manifestOf(p).layout, 'legacy', '演练不许改清单的布局');
  assert.equal(existsSync(runBody(p)), false, '演练不许在 run 落点造文件');
});

/* ────────────────────── ② 附加模式：先建后删 ────────────────────── */

test('② --apply（默认复制模式）：产物出现在 run 落点，legacy 原件逐字节还在', () => {
  const p = build();
  seed(p);
  const bodyBefore = read(legacyBody(p));
  const ledgerBefore = read(legacyLedger(p));
  const finishBefore = read(join(p.out, '_运行', `${TAG}.完成.json`));

  const r = p.run(MIGRATE, ['--apply']);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /复制/, '必须说清用的是哪种模式（默认不删原件）');

  assert.equal(read(runBody(p)), bodyBefore, '正文必须出现在 run 落点');
  assert.equal(read(runLedger(p)), ledgerBefore, '台账必须出现在 run 落点');
  // ★ 文件名**会变**的那几类：run 布局下完成标记叫 完成.json，不是 A层85.完成.json
  assert.equal(read(join(p.priv, '完成.json')), finishBefore, '完成标记必须落到 run 布局自己的文件名上');
  assert.equal(existsSync(join(p.priv, `${TAG}.完成.json`)), false, '不许把 legacy 的文件名照抄进 run 布局（照抄就等于没搬：脚本找的是 完成.json）');
  assert.equal(read(join(p.priv, '风险队列.json')), '{"队列":[]}\n', '机器风险队列同样要换到 run 布局的名字');
  assert.equal(read(join(p.priv, '待复核', '第一章_第7段.md')), '# 待复核\n', '待复核段落跟着走');

  assert.equal(read(legacyBody(p)), bodyBefore, '复制模式下原件必须留在原位（教师可能正在旧位置改稿）');
  assert.equal(read(legacyLedger(p)), ledgerBefore, '台账原件同样留着');
  assert.equal(existsSync(join(p.out, '_运行', `${TAG}.完成.json`)), true, 'legacy 的完成标记也不许被删');

  const m = manifestOf(p);
  assert.equal(m.layout, 'run', '清单要改成 run（否则下游还按 legacy 找，产物搬了等于白搬）');
  const paths = m.artifacts.map((a) => a.path);
  assert.ok(paths.length >= 2, '登记项不该凭空少掉');
  assert.ok(
    paths.every((x) => !x.startsWith('第一章/') && !x.startsWith('台账_')),
    `登记的落点必须全部跟着搬家：${paths.join(' / ')}`,
  );
  assert.ok(
    paths.every((x) => x.startsWith(`_运行/${p.runId}/`)),
    `登记项应当全部指向本次运行的私有目录：${paths.join(' / ')}`,
  );
  assert.ok(
    paths.every((x) => !x.includes('A层85.完成.json')),
    '登记项不许留下 legacy 的文件名',
  );
});

/* ────────────────────── ③ 布局无关的那批：一个都不搬 ────────────────────── */

test('③ `_运行/` 根的账（清单/指针/词表正本与快照）：一件不搬、一字不改、也不复制一份', () => {
  const p = build();
  seed(p);
  const keep = ['LexiconData.json', 'LexiconSnapshot.json', `清单_${p.runId}.json`, '清单_wayne_A层85.json', '清单_最新.json'];
  for (const f of keep) assert.equal(existsSync(join(p.out, '_运行', f)), true, `前提：${f} 应当在 _运行/ 根下`);
  const before = new Map(keep.map((f) => [f, read(join(p.out, '_运行', f))]));

  assert.equal(p.run(MIGRATE, ['--apply']).status, 0);

  for (const f of keep) {
    assert.equal(existsSync(join(p.out, '_运行', f)), true, `${f} 必须留在 _运行/ 根下（它的落点与布局无关）`);
    if (f !== `清单_${p.runId}.json`) assert.equal(read(join(p.out, '_运行', f)), before.get(f), `${f} 的内容不该被动过`);
    assert.equal(existsSync(join(p.priv, f)), false, `${f} 不许在运行私有目录里出现第二份（第二份＝两个事实源）`);
  }
  // 指针只记"指向谁"，布局**以清单为准**——所以指针不需要跟着改（改了反倒多一处要同步的真相）
  assert.match(before.get('清单_wayne_A层85.json') ?? '', /"layout": "legacy"/, '前提：迁移前的分片指针记的是 legacy');
  assert.equal(read(join(p.out, '_运行', '清单_wayne_A层85.json')), before.get('清单_wayne_A层85.json'), '指针一个字都不该改：布局由清单说了算');
});

/* ────────────────────── ④ 幂等 ────────────────────── */

test('④ 再跑一次：说"已经迁移过了"，**清单与整棵树逐字节不变**', () => {
  const p = migrated();
  const before = tree(p.root);
  const manifestBefore = read(join(p.out, '_运行', `清单_${p.runId}.json`));

  const r = p.run(MIGRATE, ['--apply']);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /已经迁移过/, '第二次跑必须明说"已迁过"，而不是再搬一遍');
  assert.deepEqual(tree(p.root), before, '第二次跑不许新建/改动任何文件（连迁移日志都不该再写一份）');
  assert.equal(read(join(p.out, '_运行', `清单_${p.runId}.json`)), manifestBefore, '第二次跑不许改写清单');
});

/* ────────────────────── ⑤ 下游真的还找得到（迁移的目的） ────────────────────── */

test('⑤ 迁完之后**真跑一次上游脚本**：它按 run 布局找正文，台账也写在 run 布局里', () => {
  const p = migrated();
  const legacyLedgerBefore = read(legacyLedger(p));
  assert.equal(legacyLedgerBefore, '# 台账（迁移前的旧稿）\n', '前提：legacy 台账还是迁移前那份');

  const r = p.run('LayerText_AF对照台账.mjs', ['--tier', 'A', '--chapters', '1', '--teacher', 'wayne']);
  assert.equal(r.status, 0, r.out);

  assert.equal(existsSync(runLedger(p)), true, '台账必须写在 run 落点（脚本按清单解析路径）');
  assert.match(read(runLedger(p)), /对照台账/, 'run 落点那份必须是这次新生成的，而不是被复制过去的旧稿');
  assert.equal(read(legacyLedger(p)), legacyLedgerBefore, 'legacy 那份一个字都不许被这次运行碰到（这正是 run 布局的意义）');
  assert.match(r.out, new RegExp(`_运行/${p.runId}/台账`), '脚本自己要说得出它写在哪儿');
});

/* ────────────────────── ⑥ 拒绝：登记了却不在盘上 ────────────────────── */

test('⑥ 登记的产物不在盘上：**大声拒绝**，并且一个文件都不动', () => {
  const p = build();
  seed(p);
  const missingName = `原文_${TAG}_${DATE}.md`;
  const before = tree(p.root);
  // 教师手工删掉了正文（现实里很常见：改名、挪走、或只保留了旧版）
  unlinkSync(legacyBody(p));
  const after = tree(p.root);
  assert.equal(Object.keys(after).length, Object.keys(before).length - 1, '前提：正文确实被删掉了');

  const r = p.run(MIGRATE, ['--apply']);
  assert.equal(r.status, 1, `必须拒绝而不是半程迁移：${r.out}`);
  assert.match(r.out, /不在盘上|缺失/, '拒绝的理由要说人话');
  assert.match(r.out, new RegExp(missingName), '拒绝时必须点名是哪一件产物');
  assert.match(r.out, /--stamp|--allow-missing/, '拒绝必须给出下一步动作（否则规矩只是挡路）');

  assert.deepEqual(tree(p.root), after, '拒绝之后不许留下任何改动');
  assert.equal(manifestOf(p).layout, 'legacy', '拒绝了就还是 legacy');
  assert.equal(existsSync(runBody(p)), false, '拒绝了就不许建 run 落点');
});

/* ────────────────────── ⑦ 拒绝：目标已有内容不同的文件 ────────────────────── */

test('⑦ 目标已存在且内容不同：拒绝搬迁，两侧的稿子都原封不动', () => {
  const p = build();
  seed(p);
  const bodyBefore = read(legacyBody(p));
  // run 落点已经有一份**别的内容**的正文（另一位教师、或上一次试跑留下的）
  mkdirSync(join(p.priv, '正文', '第一章'), { recursive: true });
  writeFileSync(runBody(p), '# 别人的稿子\n', 'utf-8');
  const before = tree(p.root);

  const r = p.run(MIGRATE, ['--apply']);
  assert.equal(r.status, 1, `目标内容不同时必须拒绝（搬过去就是覆盖）：${r.out}`);
  assert.match(r.out, /内容不同|覆盖/, '拒绝的理由要说清是"会覆盖"');
  assert.match(r.out, /一个文件都没有动/, '拒绝必须说清没有半程迁移');

  assert.deepEqual(tree(p.root), before, '拒绝之后不许留下任何改动');
  assert.equal(read(runBody(p)), '# 别人的稿子\n', '目标那份一个字都不许被覆盖');
  assert.equal(read(legacyBody(p)), bodyBefore, '源那份也不许动');
  assert.equal(manifestOf(p).layout, 'legacy', '拒绝了就没有"半个 run 布局"');
});

/* ────────────────────── ⑧ --move 与回滚 ────────────────────── */

test('⑧ --apply --move 删原件，随后 --rollback 逐件搬回来（清单与落点同步回退）', () => {
  const p = build();
  seed(p);
  const bodyBefore = read(legacyBody(p));
  const finishBefore = read(join(p.out, '_运行', `${TAG}.完成.json`));

  const mv = p.run(MIGRATE, ['--apply', '--move']);
  assert.equal(mv.status, 0, mv.out);
  assert.match(mv.out, /搬运/, '必须说清这次是搬运（原件已删）');
  assert.match(mv.out, /--rollback/, '搬运之后必须给出回滚方法（否则教师没有退路）');
  assert.equal(existsSync(legacyBody(p)), false, '--move 必须删掉原件');
  assert.equal(existsSync(runBody(p)), true, '删之前必须先建好目标');
  assert.equal(read(runBody(p)), bodyBefore, '搬过去的内容必须逐字节一致');
  assert.equal(manifestOf(p).layout, 'run');

  const rb = p.run(MIGRATE, ['--apply', '--rollback']);
  assert.equal(rb.status, 0, rb.out);
  assert.equal(read(legacyBody(p)), bodyBefore, '回滚必须把正文搬回原位');
  assert.equal(existsSync(runBody(p)), false, '回滚之后 run 落点不该还留着一份');
  assert.equal(read(join(p.out, '_运行', `${TAG}.完成.json`)), finishBefore, '完成标记也要回到 legacy 的文件名上');
  assert.equal(manifestOf(p).layout, 'legacy', '回滚必须把清单的布局改回去');
  assert.ok(
    manifestOf(p).artifacts.every((a) => !a.path.startsWith('_运行/')),
    `回滚后登记项应当指回 legacy 落点：${manifestOf(p)
      .artifacts.map((a) => a.path)
      .join(' / ')}`,
  );

  // 已经回滚过的迁移不许再回滚一次（重复执行不是"幂等"，是把别的账再搬一遍）
  const again = p.run(MIGRATE, ['--apply', '--rollback']);
  assert.equal(again.status, 1, again.out);
  assert.match(again.out, /已经回滚过/, again.out);
});

test('⑩ 试跑与正式的待复核段落各有各的落点（本工具当初拦下的那个撞名，已从根上修掉）', () => {
  /* 这条用例原来是"两件产物撞同一个落点 → 拒绝"。
   *
   * 那是**在绕一个根因**：`resolvePath` 的 run 布局分支漏了 `suffix`，
   * 而 legacy 是 `_待复核/A层85_试跑/` 与 `_待复核/A层85/` 两个目录。
   * 于是同一个 runId 下"先试跑、再正式"（输入相同 ⇒ runId 相同）会把待复核段落
   * 写进同一个文件，后一次覆盖前一次——而待复核目录是那次失败**唯一的记录**。
   *
   * 根因已在 `src/core/manifest.ts` 修掉（run 分支改为 `待复核${suffix}/`，保留 legacy 的语义）。
   * 所以这里改成断言**迁移成功且两份都在**：绕过去的问题不该永远留着"拒绝"当答案。 */
  const p = build();
  seed(p);
  mkdirSync(join(p.out, '_待复核', `${TAG}_试跑`), { recursive: true });
  writeFileSync(join(p.out, '_待复核', `${TAG}_试跑`, '第一章_第7段.md'), '# 待复核·试跑\n', 'utf-8');
  writeFileSync(join(p.out, '_待复核', TAG, '第一章_第7段.md'), '# 待复核·正式\n', 'utf-8');

  const r = p.run(MIGRATE, ['--apply']);
  assert.equal(r.status, 0, `两份待复核各有各的落点之后不该再拦：${r.out}`);
  assert.equal(read(join(p.priv, '待复核_试跑', '第一章_第7段.md')), '# 待复核·试跑\n', '试跑那份要单独有落点');
  assert.equal(read(join(p.priv, '待复核', '第一章_第7段.md')), '# 待复核·正式\n', '正式那份在原落点');
});

/* ────────────────────── ⑨ 反向只报告，不做 ────────────────────── */
test('⑨ --to legacy：只报告"搬回去会落在哪"，给 --apply 也不动手', () => {
  const p = migrated();
  const before = tree(p.root);

  const report = p.run(MIGRATE, ['--to', 'legacy']);
  assert.equal(report.status, 0, report.out);
  assert.match(report.out, /反向报告/, '必须说清这是报告而不是执行');
  assert.match(report.out, new RegExp(`原文_${TAG}_${DATE}\\.md`), '报告要列出"搬回去会落在哪个 legacy 落点"');
  assert.deepEqual(tree(p.root), before, '反向报告不许动盘');

  const attempt = p.run(MIGRATE, ['--to', 'legacy', '--apply']);
  assert.equal(attempt.status, 2, `反向迁移本工具不做（退出码 2）：${attempt.out}`);
  assert.deepEqual(tree(p.root), before, '不做就是不做：一个字节都没动');
});

test('⑪ 清单档案被删掉之后，--rollback 仍能从迁移日志把原件搬回来（只搬文件、如实说没改档案）', () => {
  const p = build();
  seed(p);
  const bodyBefore = read(legacyBody(p));
  assert.equal(p.run(MIGRATE, ['--apply', '--move']).status, 0);
  // 最需要回滚的情形：--move 已经把原件删了，而清单又被谁删了
  unlinkSync(join(p.out, '_运行', `清单_${p.runId}.json`));

  const rb = p.run(MIGRATE, ['--apply', '--rollback']);
  assert.equal(rb.status, 0, rb.out);
  assert.equal(read(legacyBody(p)), bodyBefore, '清单不在也得能把原件搬回来（依据是逐件记账的迁移日志）');
  assert.equal(existsSync(runBody(p)), false, '搬回来之后 run 落点不该还留着');
  assert.match(rb.out, /清单档案不在/, '必须如实说清这次没有改动清单档案');
});

/* ────────────────────── ⑫ 两位教师：不点名就拒绝，点名了只动点名的那一份 ────────────────────── */

test('⑫ 同一本书两位教师各有一份清单：不点名**拒绝**；点名后只迁那一份，另一位的原封不动', () => {
  const p = build('wayne');
  seed(p, 'wayne');
  // 第二位教师、另一个层级（阶段 3 验收里那一幕：同一本书、不同层级、共用产物目录）
  const second = p.run('LayerText_AF清单.mjs', ['--new', '--tier', 'M', '--chapters', '1', '--teacher', 'liu']);
  assert.equal(second.status, 0, second.out);
  const liuRunId = /运行 ID：(\S+)/.exec(second.out)?.[1] ?? '';
  assert.notEqual(liuRunId, p.runId, '两位教师/两个层级应当是两次不同的运行');
  const liuManifest = join(p.out, '_运行', `清单_${liuRunId}.json`);
  mkdirSync(join(p.out, '第一章'), { recursive: true });
  writeFileSync(join(p.out, '第一章', `原文_M层75_${DATE}.md`), '## Chapter One\n\n[P01] The boy ran to the barn.\n', 'utf-8');
  assert.equal(p.run('LayerText_AF清单.mjs', ['--stamp', '--tier', 'M', '--teacher', 'liu']).status, 0);

  // ① 不点名：两份清单摆在那里，谁都不该替人决定迁哪一份
  const blind = p.run(MIGRATE, ['--apply']);
  assert.equal(blind.status, 1, `多份清单时必须拒绝而不是"挑一份最近的"：${blind.out}`);
  assert.match(blind.out, /份运行清单/, '拒绝要说清有几份');
  assert.match(blind.out, /--run/, '拒绝要给出点名的方式');
  assert.equal((JSON.parse(read(liuManifest)) as { layout: string }).layout, 'legacy', '拒绝之后另一位教师的清单也得原样');
  assert.equal(manifestOf(p).layout, 'legacy');

  // ② 点名 wayne 的 A 层：只迁这一份
  const r = p.run(MIGRATE, ['--apply', '--teacher', 'wayne', '--tier', 'A']);
  assert.equal(r.status, 0, r.out);
  assert.equal(manifestOf(p).layout, 'run', '点名的那份要迁');
  assert.equal((JSON.parse(read(liuManifest)) as { layout: string }).layout, 'legacy', '另一位教师的清单一个字都不许动');
  assert.equal(existsSync(runBody(p)), true, 'wayne 的正文进了自己的运行私有目录');
  assert.equal(read(join(p.out, '第一章', `原文_M层75_${DATE}.md`)), '## Chapter One\n\n[P01] The boy ran to the barn.\n', 'liu 的产物必须原地不动');
  const priv = readdirSync(p.priv, { recursive: true }).join(' ');
  assert.doesNotMatch(priv, /M层75/, 'liu 的产物绝不许混进 wayne 的运行私有目录');
  assert.match(r.out, /不认领[\s\S]*原文_M层75/, '对方的产物要**报出来**（说清"我没动它"），不能悄悄略过');
});
