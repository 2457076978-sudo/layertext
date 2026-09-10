/**
 * 数据面板纯逻辑测试（规范 v1 第八节）
 *
 * 验收口径：面板是教师改数据的唯一入口，**它自己不能写出非法数据**。
 * 所以这里重点验：非法值被拦、同词多义被拦、更新已有行不被误判成重复、CSV 往返无损。
 * 纯逻辑不依赖 Tauri（IO 走注入点），可在 node 下直接跑。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DATA_KINDS, parseCsv, toTable, fromTable, validateText, validateUnit,
  upsertRow, deleteRow, upsertProperLine, deleteProperLine, setIo,
  type DataKind,
} from '../app/src/datapanel.js';

const K: Record<string, DataKind> = Object.fromEntries(DATA_KINDS.map((k) => [k.id, k]));
const VOCAB_HDR = '词,类型,词性,释义,来源册,来源单元,音标,备注';

test('CSV 解析：BOM / 引号内逗号 / CRLF 都能处理', () => {
  const t = toTable(`\uFEFF词,类型,词性,释义,来源册,来源单元,音标,备注\r\ntake off,短语,phr.,"起飞,脱下",九上,U1,,\r\n`);
  assert.equal(t.header.length, 8);
  assert.equal(t.rows[0]!['词'], 'take off');
  assert.equal(t.rows[0]!['释义'], '起飞,脱下');
});

test('CSV 往返：带逗号的释义无损', () => {
  const src = `\uFEFF${VOCAB_HDR}\n"take off",短语,phr.,"起飞,脱下",九上,U1,,\n`;
  assert.equal(toTable(fromTable(toTable(src))).rows[0]!['释义'], '起飞,脱下');
});

test('词库：合法行通过', () => {
  assert.deepEqual(validateText(K.vocab!, `\uFEFF${VOCAB_HDR}\nrebellion,单词,n.,起义,九上,U3,,,\n`), []);
});

test('词库：非法「类型」被拦下并给出允许值', () => {
  const errs = validateText(K.vocab!, `\uFEFF${VOCAB_HDR}\nx,乱填,n.,,九上,,,\n`);
  assert.ok(errs.length > 0);
  assert.match(errs[0]!, /不合法/);
  assert.match(errs[0]!, /待定词/);
});

test('词库：缺「来源册」被拦下（判定锚必须可溯源）', () => {
  assert.ok(validateText(K.vocab!, `\uFEFF${VOCAB_HDR}\nx,单词,n.,,,,\n`).some((e) => e.includes('来源册')));
});

test('词典：文件里同词不同释义被拦下（规范冻结：一词一义）', () => {
  const dup = '\uFEFF词,释义,来源\nmajestic,威严的,教师知识库\nmajestic,宏大的,归一\n';
  assert.ok(validateText(K.dict!, dup).some((e) => e.includes('同词多义')));
});

test('词典：同词同义重复行被拦下', () => {
  const dup = '\uFEFF词,释义,来源\nmajestic,威严的,教师知识库\nmajestic,威严的,归一\n';
  assert.ok(validateText(K.dict!, dup).some((e) => e.includes('重复')));
});

test('upsertRow：更新已有行是合法编辑，不该被当成重复', () => {
  const src = '\uFEFF词,释义,来源\nmajestic,威严的,教师知识库\n';
  const r = upsertRow(K.dict!, src, { 词: 'majestic', 释义: '宏大的', 来源: '教师知识库' });
  assert.equal(r.error, undefined, r.error);
  assert.equal(toTable(r.text).rows.length, 1, '应更新而非新增');
  assert.equal(toTable(r.text).rows[0]!['释义'], '宏大的');
});

test('upsertRow：新增后整份文件仍合规', () => {
  const src = '\uFEFF词,释义,来源\nmajestic,威严的,教师知识库\n';
  const r = upsertRow(K.dict!, src, { 词: 'rebellion', 释义: '起义', 来源: '归一' });
  assert.equal(r.error, undefined, r.error);
  assert.deepEqual(validateText(K.dict!, r.text), []);
});

test('validateText：校验某一行时不能把该行自身算作重复', () => {
  // 回归：曾因未排除自身，导致任何"单行文件"都被判成"已存在"
  const one = '\uFEFF类型,词,值,来源数\n加注词,harness,马具,2\n';
  assert.deepEqual(validateText(K.kb!, one), []);
});

test('知识库：同型同词视为更新（合法）', () => {
  const src = '\uFEFF类型,词,值,来源数\n加注词,harness,马具,2\n';
  const r = upsertRow(K.kb!, src, { 类型: '加注词', 词: 'harness', 值: '挽具', 来源数: '1' });
  assert.equal(r.error, undefined, r.error);
  assert.equal(toTable(r.text).rows.length, 1);
  assert.equal(toTable(r.text).rows[0]!['值'], '挽具');
});

test('知识库：同型同词两行被拦下', () => {
  const dup = '\uFEFF类型,词,值,来源数\n加注词,harness,马具,2\n加注词,harness,挽具,1\n';
  assert.ok(validateText(K.kb!, dup).some((e) => e.includes('已存在')));
});

test('知识库：非法「类型」被拦下', () => {
  assert.ok(upsertRow(K.kb!, '\uFEFF类型,词,值,来源数\n', { 类型: '乱填', 词: 'x', 值: 'y' }).error);
});

test('专名表：合法通过，大写被拦下', () => {
  assert.deepEqual(validateText(K.proper!, '# 注释\nnapoleon\nboxer\n'), []);
  assert.ok(validateText(K.proper!, 'Napoleon\n').some((e) => e.includes('非法字符')));
});

test('专名表：新增 / 拒重复 / 删除且保留注释', () => {
  const src = '# 注释\nnapoleon\nboxer\n';
  const a = upsertProperLine(src, 'clover');
  assert.equal(a.error, undefined, a.error);
  assert.ok(a.text.includes('clover'));

  assert.ok(upsertProperLine(src, 'napoleon').error, '重复专名应被拒');

  const c = deleteProperLine(src, 'boxer');
  assert.equal(c.error, undefined, c.error);
  assert.ok(!c.text.includes('boxer'));
  assert.ok(c.text.includes('# 注释'), '注释行不能被删掉');
});

test('deleteRow：删除成功；删不存在的行报错', () => {
  const src = '\uFEFF词,释义,来源\nmajestic,威严的,教师知识库\n';
  const d = deleteRow(K.dict!, src, 'majestic');
  assert.equal(d.error, undefined, d.error);
  assert.ok(!d.text.includes('majestic'));
  assert.ok(deleteRow(K.dict!, src, '不存在').error);
});

test('validateUnit：专名为空时报错', () => {
  assert.ok(validateUnit(K.proper!, { 词: '' }).length > 0);
});

test('save：写前校验不过则拒绝写入（面板不能产出非法数据）', async () => {
  let wrote = false;
  const store: Record<string, string> = { '/tmp/x.csv': '\uFEFF词,释义,来源\n' };
  setIo({
    async read(p) { return store[p] ?? ''; },
    async write(p, c) { wrote = true; store[p] = c; },
    async appendLog() { /* noop */ },
    async listDir() { return []; },
  });
  const DP = await import('../app/src/datapanel.js');
  const bad = '\uFEFF词,释义,来源\nmajestic,威严的,教师知识库\nmajestic,宏大的,归一\n';
  const r = await DP.save(K.dict!, { 书级: { 词典: '/tmp/x.csv' } }, bad, '测试');
  assert.equal(r.ok, false);
  assert.match(r.error!, /写前校验未通过/);
  assert.equal(wrote, false, '校验不过就不该写盘');
});

test('save：合法数据写入成功并留痕', async () => {
  const store: Record<string, string> = {};
  const logs: string[] = [];
  setIo({
    async read(p) { return store[p] ?? ''; },
    async write(p, c) { store[p] = c; },
    async appendLog(_n, line) { logs.push(line); },
    async listDir() { return []; },
  });
  const DP = await import('../app/src/datapanel.js');
  const good = '\uFEFF词,释义,来源\nmajestic,威严的,教师知识库\n';
  const r = await DP.save(K.dict!, { 书级: { 词典: '/tmp/y.csv' } }, good, '新增 majestic');
  assert.equal(r.ok, true, r.error);
  assert.ok(store['/tmp/y.csv']!.includes('majestic'));
  assert.equal(logs.length, 1, '应留一行变更日志');
  assert.match(logs[0]!, /新增 majestic/);
});

test('parseCsv 空文件返回空数组', () => {
  assert.deepEqual(parseCsv(''), []);
});

test('findProjectConfig：在书目里找到 调适项目_*.json', async () => {
  setIo({
    async read(_p) { return JSON.stringify({ 书名: 'X', 词库: '/tmp/v.csv' }); },
    async write() { /* noop */ },
    async appendLog() { /* noop */ },
    async listDir(dir) { return dir === '/book' ? ['调适项目_X.json', '其他.md'] : []; },
  });
  const DP = await import('../app/src/datapanel.js');
  const cfg = await DP.findProjectConfig('/book');
  assert.equal(cfg?.['书名'], 'X');
});

test('findProjectConfig：找不到时逐级向上一层再试', async () => {
  setIo({
    async read() { return JSON.stringify({ 书名: 'Y' }); },
    async write() { /* noop */ },
    async appendLog() { /* noop */ },
    async listDir(dir) { return dir === '/book' ? ['调适项目_Y.json'] : []; },
  });
  const DP = await import('../app/src/datapanel.js');
  const cfg = await DP.findProjectConfig('/book/调适工作区');
  assert.equal(cfg?.['书名'], 'Y');
});

test('findProjectConfig：都没有则返回 null', async () => {
  setIo({
    async read() { return ''; },
    async write() { /* noop */ },
    async appendLog() { /* noop */ },
    async listDir() { return ['readme.md']; },
  });
  const DP = await import('../app/src/datapanel.js');
  assert.equal(await DP.findProjectConfig('/nothing'), null);
});

test('getPath：书级数据在 书级.* 下也能取到（回归）', async () => {
  const DP = await import('../app/src/datapanel.js');
  const project = { 词库: '/a.csv', 书级: { 专名表: '/p.txt', 词典: '/d.csv' } };
  assert.equal(DP.getPath(project, '书级.专名表'), '/p.txt');
  assert.equal(DP.getPath(project, '书级.词典'), '/d.csv');
  assert.equal(DP.getPath(project, '词库'), '/a.csv');
  assert.equal(DP.getPath(project, '书级.不存在'), undefined);
  assert.equal(DP.getPath(undefined, '书级.专名表'), undefined);
});

test('findProjectConfig：向上三层能找到（书开的是 调适工作区/ 时要用到）', async () => {
  setIo({
    async read() { return JSON.stringify({ 书名: 'Z' }); },
    async write() { /* noop */ },
    async appendLog() { /* noop */ },
    // 只在第三层有
    async listDir(dir) { return dir === '/ws' ? ['调适项目_Z.json'] : ['其他.md']; },
  });
  const DP = await import('../app/src/datapanel.js');
  const cfg = await DP.findProjectConfig('/ws/调适工作区/第三章');
  assert.equal(cfg?.['书名'], 'Z');
});
