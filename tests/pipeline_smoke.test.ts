/**
 * 管线脚本 · TDZ 冒烟门禁
 *
 * 来由：TDZ（"新加的绑定落在使用之后"）已**四次**发生（第二/三/五轮落实对照表、CHANGELOG）。
 * 它是**运行期**缺陷——`tsc` 与 `node --check` 都不报，只有真跑到那一行才崩；
 * 而管线脚本大多按参数走分支，平时不进的分支里藏一个 TDZ 可以潜伏很久。
 *
 * 这里对 `tools/af_pipeline/` 下每个 .mjs 做**零成本冒烟**：坏的项目指针让脚本在
 * 加载阶段就失败，但模块顶层（import、共享模块初始化、常量绑定）会**先于**业务
 * 逻辑执行——顶层有 TDZ 当场就炸，轮不到业务分支。
 * 退出码不设预期（参数错、找不到项目，都是**正确的失败**）；只守一件事：
 * **不许以 TDZ / ReferenceError 的方式死**。那类死法的报错里带着行号，
 * 修起来只要一分钟——前提是有人看见它。
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIR = join(REPO, 'tools', 'af_pipeline');
/** TDZ / 引用错误的特征串——出现即顶层（或任何先跑到的位置）绑定顺序错了 */
const BAD_BINDING = /before initialization|ReferenceError|is not defined/u;

test('★ 每个管线脚本都冒烟通过：不许以 TDZ / ReferenceError 的方式死（第七轮 P2）', () => {
  const scripts = readdirSync(DIR)
    .filter((f) => f.endsWith('.mjs'))
    .sort();
  assert.ok(scripts.length >= 15, `af_pipeline 的脚本清单读不出来（实得 ${scripts.length} 个）——门禁本身先要能看见它守的东西`);
  const offenders: string[] = [];
  for (const s of scripts) {
    const r = spawnSync(process.execPath, [join(DIR, s)], {
      cwd: REPO,
      encoding: 'utf-8',
      timeout: 30_000,
      /* 坏的项目指针：脚本会在项目加载处失败（≈30ms），顶层初始化已全部跑完。
       * `冻结回放` 是例外（空参数走 --check 对账，同样不碰业务分支），也照跑。 */
      env: { ...process.env, LAYERTEXT_PROJECT: join(REPO, '不存在的项目_冒烟探针.json'), LAYERTEXT_ENGINE: REPO },
    });
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    if (BAD_BINDING.test(out)) offenders.push(`${s}：${out.split('\n').find((l) => BAD_BINDING.test(l)) ?? ''}`);
  }
  assert.deepEqual(offenders, [], `以下脚本以 TDZ / 引用错误的方式死——tsc 查不出、只有真跑才炸的那类，就该在冒烟里炸：\n${offenders.join('\n')}`);
});
