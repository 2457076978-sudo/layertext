/**
 * 命令行里的章号参数（`7` 或 `1,2,10`）——**唯一实现**。
 *
 * 拆成独立模块的理由与 `keychain.mjs` 同：`LayerText_AF词表与词典.mjs` 撞了
 * eslint 的 `max-lines` 1000 行门禁（`skipComments`/`skipBlankLines` 都开着，
 * 也就是说注释救不了它）。仓库里上一次的教训写在那条 commit 里——
 * **"prettier 会重展压缩行，拆模块是正解"**，所以这里不靠压缩代码过关。
 *
 * 存在的理由：这条解析原来在 **5 个脚本**里各抄了一份
 * `argv.filter((a) => /^\d/.test(a)).flatMap((a) => a.split(',').map(Number))`，
 * 而它有一个**静默产错**的洞：`/^\d/` 会放过 `1A`，`Number('1A')` 却是 `NaN`——
 * `chapters` 变成 `[NaN]`，`length` 非 0 于是默认值不进，后面
 * `CN[NaN - 1]` 得到 `undefined`，一路拼出 `…/undefined/原文_规范化.md`。
 * 报错时人看到的是"第undefined章 失败"，而不是"你把章号敲错了"。
 *
 * 现在：**非正整数的 token 当场拒绝并退出**，绝不把 `NaN` 放进去。
 * 章号越界（比如书只有 10 章却传 12）仍在后面拼路径时暴露——那一条要靠
 * `chapterNames(P).length` 才能判，本模块拿不到，故不在这里猜。
 */

/**
 * @param {string[]} argv 已 slice 过的命令行参数
 * @param {number[]} fallback 一个章号都没给时用的默认清单
 * @returns {number[]} 去重后的章号（保持出现序）
 */
export function parseChapters(argv, fallback) {
  const toks = argv
    .filter((a) => /^\d/.test(a))
    .flatMap((a) => a.split(',').map((s) => s.trim()))
    .filter(Boolean);
  const bad = toks.filter((s) => !/^\d+$/.test(s));
  if (bad.length) {
    console.error(`✗ 章号只收正整数或逗号分隔的正整数（例：7 或 1,2,10）；认不出的有：${bad.join('、')}`);
    process.exit(2);
  }
  const list = [...new Set(toks.map(Number))];
  return list.length ? list : [...fallback];
}
