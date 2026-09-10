#!/usr/bin/env node
/**
 * 版本对齐门禁（交互标准 A1 附带 / 商业化评估 C1-2）：
 * package.json / app/package.json / tauri.conf.json / Cargo.toml / README「当前状态」五处版本必须一致，漂移即退出码 1。
 * 由 CI 调用（node tools/check_versions.mjs）；发版只改一处而漏其余的事故（README 滞留 v1.0.0、
 * Cargo.toml 滞留 1.1.0 致 About 显示错版本）由本门禁终结。
 */
import { readFileSync } from 'node:fs';

const u = (p) => new URL('../' + p, import.meta.url); // readFileSync 直接收 URL（中文路径不被 percent-encode 破坏）

const pkg = JSON.parse(readFileSync(u('package.json'), 'utf8')).version;
const appPkg = JSON.parse(readFileSync(u('app/package.json'), 'utf8')).version;
const tauri = JSON.parse(readFileSync(u('app/src-tauri/tauri.conf.json'), 'utf8')).version;
const cargoM = readFileSync(u('app/src-tauri/Cargo.toml'), 'utf8').match(/^version\s*=\s*"(\d+\.\d+\.\d+)"/m);
const readme = readFileSync(u('README.md'), 'utf8');
const m = readme.match(/## 当前状态：v(\d+\.\d+\.\d+)/);
const readMeV = m ? m[1] : null;

const rows = [
  ['package.json', pkg],
  ['app/package.json', appPkg],
  ['app/src-tauri/tauri.conf.json', tauri],
  ['app/src-tauri/Cargo.toml', cargoM ? cargoM[1] : '(未找到 version)'],
  ['README.md 当前状态', readMeV ?? '(未找到版本标记)'],
];
console.log(rows.map(([f, v]) => `${f}: ${v}`).join('\n'));

const bad = rows.filter(([, v]) => v !== pkg);
if (bad.length) {
  console.error(`\n✗ 版本漂移：与 package.json(${pkg}) 不一致 → ${bad.map(([f, v]) => `${f}=${v}`).join(', ')}`);
  console.error('  发版时五处一起改：根 package.json、app/package.json、tauri.conf.json、Cargo.toml、README。');
  process.exit(1);
}
console.log(`\n✓ 版本五处一致：${pkg}`);
