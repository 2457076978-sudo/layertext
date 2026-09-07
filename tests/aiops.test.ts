/**
 * AI 运维纯逻辑（W3）测试：提示词 manifest/模板 · 供应商 failover 序列 · 成本台账
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildTargets, composePrompt, COST_HEADER, fillTemplate, parseManifest,
  providerNameOf, shouldFailover, summarizeCost, toCostLine,
} from '../src/core/aiops.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

test('manifest 解析与全部提示词文件齐全（外置契约）', () => {
  const m = parseManifest(readFileSync(join(ROOT, 'prompts', 'manifest.json'), 'utf-8'));
  assert.match(m.setVersion, /^v\d+\.\d+$/); // 版本随 manifest changelog 递增，不在此锁死
  for (const name of Object.keys(m.prompts)) {
    assert.ok(m.prompts[name], `manifest 缺 ${name}`);
    const body = readFileSync(join(ROOT, 'prompts', m.prompts[name].file), 'utf-8');
    assert.ok(body.trim().length > 20, `${name} 内容为空`);
  }
  assert.ok(m.prompts.plot_points, '初步诊断需要 plot_points 提示词');
});

test('fillTemplate：占位符替换；未知占位符保留', () => {
  assert.equal(fillTemplate('A {{x}} B {{y}}', { x: '1', y: '2' }), 'A 1 B 2');
  assert.equal(fillTemplate('{{tier}} {{unknown}}', { tier: 'M' }), 'M {{unknown}}');
});

test('composePrompt：分层初稿模板与生产占位符对齐', () => {
  const out = composePrompt('{{tierRule}}{{chnoNote}}\n{{instructions}}', {
    tierRule: 'M 层：平均句长 ≤16 词', chnoNote: '（本章章号 1）', instructions: '',
  });
  assert.match(out, /M 层：平均句长 ≤16 词（本章章号 1）/);
  assert.doesNotMatch(out, /\{\{/); // 全部填充，无残留占位符
});

test('buildTargets：主在前备用按序；空 key 复用主 key；无效项剔除', () => {
  const targets = buildTargets(
    { baseUrl: 'https://api.deepseek.com/v1/', model: 'deepseek-chat', key: 'K0' },
    [
      { name: '智谱备用', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
      undefined,
      { baseUrl: '', model: 'x' }, // 无地址 → 剔除
    ],
    { 0: 'K1' },
  );
  assert.equal(targets.length, 2);
  assert.equal(targets[0].index, 0);
  assert.equal(targets[0].name, 'api.deepseek.com');
  assert.equal(targets[1].name, '智谱备用');
  assert.equal(targets[1].key, 'K1'); // 独立 key 生效
  // 备用无独立 key → 复用主 key
  const t2 = buildTargets({ baseUrl: 'https://a/v1', model: 'm', key: 'K0' }, [{ baseUrl: 'https://b/v1', model: 'm2' }], {});
  assert.equal(t2[1].key, 'K0');
});

test('shouldFailover：网络/5xx/429/4xx 降级；空错误不降级', () => {
  assert.equal(shouldFailover(new Error('HTTP 500: x')), true);
  assert.equal(shouldFailover(new Error('HTTP 429: x')), true);
  assert.equal(shouldFailover(new Error('Failed to fetch')), true);
  assert.equal(shouldFailover(new Error('')), false);
});

test('providerNameOf：host 提取与坏地址兜底', () => {
  assert.equal(providerNameOf('https://api.deepseek.com/v1'), 'api.deepseek.com');
  assert.equal(providerNameOf('不是网址'), '自定义');
  assert.equal(providerNameOf(''), '未配置');
});

test('成本台账：行写入与汇总（含按书过滤/failover/错误计数）往返', () => {
  const mk = (scene: string, book: string, pt: number, ct: number, fo: boolean, err: boolean) => toCostLine({
    ts: '2026-09-06 10:00:00', scene, book, chapter: 'ch1.md', provider: 'api.deepseek.com', model: 'deepseek-chat',
    promptVer: 'v1.0', promptTokens: pt, completionTokens: ct, elapsedMs: 1200, failover: fo, ok: !err,
  });
  const csv = COST_HEADER.join(',') + '\n'
    + mk('分层初稿', '动物农场', 1000, 800, false, false)
    + mk('审核建议', '动物农场', 200, 100, true, false)
    + mk('AI 助手', '动物农场', 300, 50, false, true)
    + mk('分层初稿', '另一本书', 5000, 4000, false, false);
  const all = summarizeCost(csv);
  assert.equal(all.calls, 4);
  assert.equal(all.promptTokens, 6500);
  assert.equal(all.completionTokens, 4950);
  assert.equal(all.failoverCount, 1);
  assert.equal(all.errCount, 1);
  const oneBook = summarizeCost(csv, '动物农场');
  assert.equal(oneBook.calls, 3);
  assert.equal(oneBook.promptTokens, 1500);
});

test('aiErrHuman：常见服务商错误码全覆盖（欠账#7：403/模型无权限）', async () => {
  const { aiErrHuman } = await import('../src/core/aiops.js');
  // 403 / 权限类 → 指向模型权限排查
  assert.match(aiErrHuman('HTTP 403: Forbidden'), /权限/);
  assert.match(aiErrHuman('Error: Permission denied for model glm-4.5'), /权限/);
  assert.match(aiErrHuman('{"error":{"message":"无权限访问该模型"}}'), /权限/);
  // 模型不存在类
  assert.match(aiErrHuman('model not found: gpt-5'), /没有这个模型/);
  // 既有分类不回归
  assert.match(aiErrHuman('HTTP 401: unauthorized'), /Key 不对/);
  assert.match(aiErrHuman('HTTP 404: not found'), /地址或模型名/);
  assert.match(aiErrHuman('HTTP 429: rate limit'), /太频繁/);
  assert.match(aiErrHuman('Failed to fetch'), /连不上/);
  assert.match(aiErrHuman('Insufficient balance'), /余额不足/);
  assert.match(aiErrHuman('账户余额不足'), /余额不足/);
  // 不认识的原样返回
  assert.equal(aiErrHuman('奇怪的错误'), '奇怪的错误');
});
