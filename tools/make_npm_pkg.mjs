#!/usr/bin/env node
/** 生成 npm 发布目录 tools/_npm_pkg/（发布正本：layertext-mcp）
 *
 * 为什么是"生成目录"而不是直接发本仓：本仓 package.json 的 name=layertext 服务于
 * 开发与 Tauri 打包；发布包要的是 `npx layertext-mcp` 直接起 MCP 服务（bin 同名魔法）。
 * 文件白名单在此处唯一声明（C 档纪律：assets 只带公开词表/词频，教师数据永不进包）。
 *
 * 用法：
 *   npm run build && node tools/make_npm_pkg.mjs          # 生成 + 打 tgz
 *   npm publish tools/_npm_pkg/layertext-mcp-*.tgz --registry=https://registry.npmjs.org
 * 实装复验（不信 dry-run）：
 *   cd /tmp && mkdir lt-verify && cd lt-verify && npm init -y >/dev/null
 *   && npm i <tgz 路径> && npx --no-install layertext-mcp --help 的 stdio 冒烟
 */
import { cpSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'tools', '_npm_pkg');

const repo = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'));
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const pkg = {
  name: 'layertext-mcp',
  version: repo.version,
  description: 'LayerText 分层读 · 本地英语文本简化质检引擎（MCP 服务 + CLI）：词库判定超纲、句法黑名单、回炉四闸、句级修改双闸、教师三键审查单。全离线零遥测。',
  license: 'PolyForm-Noncommercial-1.0.0',
  keywords: ['mcp', 'education', 'english', 'simplification', 'vocab', 'layered-reading', '分层读'],
  engines: { node: '>=20' },
  bin: {
    'layertext-mcp': 'dist/src/mcp-server.js',
    'layertext-qc': 'dist/src/cli.js',
  },
  files: ['dist/src', 'assets', 'prompts', 'README.md', 'LICENSE', 'CHANGELOG.md'],
  // 运行时依赖=本仓 dependencies 全集（三件：MCP SDK / zod / ts-fsrs——CLI 的 fsrs 子命令用）
  dependencies: {
    '@modelcontextprotocol/sdk': repo.dependencies['@modelcontextprotocol/sdk'],
    'ts-fsrs': repo.dependencies['ts-fsrs'],
    zod: repo.dependencies.zod,
  },
  repository: { type: 'git', url: 'git+https://github.com/2457076978-sudo/layertext.git' },
  homepage: 'https://github.com/2457076978-sudo/layertext',
  publishConfig: { registry: 'https://registry.npmjs.org/', access: 'public' },
};
writeFileSync(join(OUT, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');

// 白名单逐项复制（发布包里没有的东西连目录都不出现）
for (const f of ['README.md', 'LICENSE', 'CHANGELOG.md']) cpSync(join(ROOT, f), join(OUT, f));
cpSync(join(ROOT, 'dist', 'src'), join(OUT, 'dist', 'src'), { recursive: true });
cpSync(join(ROOT, 'assets'), join(OUT, 'assets'), { recursive: true });
cpSync(join(ROOT, 'prompts'), join(OUT, 'prompts'), { recursive: true });

// dist/src 里只要可运行产物：剔除测试编译物（若 tsc 把 tests 编到 dist/tests，不在白名单内，天然不进包）
const tgz = execSync('npm pack --pack-destination .', { cwd: OUT, encoding: 'utf-8' }).trim().split('\n').pop();
const sizeKb = Math.round(Number(execSync(`stat -f%z ${tgz}`, { cwd: OUT, encoding: 'utf-8' }).trim()) / 1024);
console.log(`✓ 发布目录就绪：tools/_npm_pkg/（${tgz}，${sizeKb}KB）`);
console.log('  下一步（需登录）：npm whoami || npm login --registry=https://registry.npmjs.org');
console.log(`  然后：npm publish tools/_npm_pkg/${tgz} --registry=https://registry.npmjs.org`);
console.log('  发布后国内用户：npx -y layertext-mcp --registry=https://registry.npmmirror.com（镜像约 10 分钟内自动同步）');
