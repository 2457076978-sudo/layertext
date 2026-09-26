/**
 * 数据面板三问分组 · 单测+纪律扫描（复盘方案 B3，2026-09-26）
 *
 * 两层锁：①纯函数——分组/排序/未登记即抛（纪律的运行时面）；
 * ②源码扫描——renderDataPane 实际喂给 dpSectionsHtml 的卡片 key 集合必须与
 * DP_CARD_GROUPS 注册表一致：加卡片不登记，这里先红（与 crosstier"锁不自算"同款手法）。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DP_CARD_GROUPS, DP_SECTIONS, dpSectionsHtml } from '../app/src/datapanel.js';

test('三问分组渲染：组头按 ①②③ 顺序、卡片落进自己的组', () => {
  const html = dpSectionsHtml([
    { key: 'dp-weekly-wrap', html: '<div>WEEKLY</div>' },
    { key: 'dp-crosstier-wrap', html: '<div>CROSS</div>' },
    { key: 'dp-tree', html: '<div>TREE</div>' },
    { key: 'ledger-card', html: '<div>LEDGER</div>' },
    { key: 'conc-reports-card', html: '<div>CONC</div>' },
  ]);
  const q1 = html.indexOf('① 这本书质量怎样');
  const q2 = html.indexOf('② 学生学得怎样');
  const q3 = html.indexOf('③ 我还要做什么');
  assert.ok(q1 >= 0 && q2 > q1 && q3 > q2, '三问组头必须按序出现');
  assert.ok(html.indexOf('CROSS') < html.indexOf('CONC') && html.indexOf('CONC') < html.indexOf('LEDGER'), '质量组内顺序=层间体检→词画卷→台账');
  assert.ok(html.indexOf('WEEKLY') > q2 && html.indexOf('WEEKLY') < q3, '复现卡在②组');
  assert.ok(html.indexOf('TREE') > q3, '层级卡在③组');
  /* 组锚=组头文本（纯展示分组不带 data-* 钩子——不需要行为就不给 clickwiring 添钩子） */
});

test('纪律运行时面：未登记的卡片 key 当场抛错', () => {
  assert.throws(() => dpSectionsHtml([{ key: 'shiny-new-card', html: '<div/>' }]), /未归组/);
});

test('纪律源码面：注册表与 renderDataPane 实际渲染的卡片集合一致（加卡片不登记先红）', () => {
  const src = readFileSync(fileURLToPath(new URL('../../app/src/datapanel.ts', import.meta.url)), 'utf8');
  const call = src.match(/dpSectionsHtml\(\[([\s\S]*?)\]\)/);
  assert.ok(call, 'renderDataPane 必须经 dpSectionsHtml 渲染卡片（不许绕过分组直拼）');
  const rendered = new Set([...call[1]!.matchAll(/key: '([^']+)'/g)].map((m) => m[1]!));
  const registered = new Set(Object.keys(DP_CARD_GROUPS));
  assert.deepEqual([...rendered].sort(), [...registered].sort(), '渲染集合与注册表不一致——新卡片必须两处同步');
  for (const id of DP_SECTIONS.map((s) => s.id))
    assert.ok(
      [...registered].some((k) => DP_CARD_GROUPS[k] === id),
      `三问之一 (${id}) 不能是空组`,
    );
});
