/**
 * AI 故障人话翻译 · 单测（复盘方案 B2，2026-09-26）
 *
 * 锁两件事：①六类错误家族各有指向"去哪改"的提示（三件套的第三件——
 * 此前网络故障在教师眼里是裸的 `TypeError: fetch failed`）；②无法识别的
 * 错误返回空串（调用方原样展示，不编造解释）。表驱动：新家族加行即加例。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { aiFailureHint } from '../app/src/aierr.js';

const cases: Array<[unknown, RegExp]> = [
  [new Error('未找到 JSON（输出被截断）'), /非思考型模型/],
  [new TypeError('fetch failed'), /网络/],
  [new Error('getaddrinfo ENOTFOUND api.example.com'), /网络/],
  [new Error('HTTP 401: invalid api key'), /重新生成 key/],
  [new Error('HTTP 403: forbidden'), /重新生成 key/],
  [new Error('HTTP 429: rate limited'), /限流/],
  [new Error('HTTP 502: bad gateway'), /供应商服务端/],
  [new Error('timeout of 60000ms exceeded'), /超时/],
  ['AbortError: The operation was aborted', /超时/],
];

test('六类错误家族各有"去哪改"指向', () => {
  for (const [err, re] of cases) {
    const hint = aiFailureHint(err);
    assert.ok(hint.startsWith('（'), `提示应以全角括号开头：${err}`);
    assert.match(hint, re);
  }
});

test('未知错误返回空串——不编造解释，调用方原样展示', () => {
  assert.equal(aiFailureHint(new Error('别的什么错')), '');
  assert.equal(aiFailureHint(undefined), '');
});
