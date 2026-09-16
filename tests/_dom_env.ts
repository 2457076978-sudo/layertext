/**
 * node 测试的 DOM 环境（2026-09-16）：happy-dom 提供 window/document 全局。
 * **必须作为测试文件的第一个 import**——ESM 按声明序求值，uikit/chat 等模块在顶层
 * 就挂事件（uikit 的 error→toast、chat 的发送/清空/侧栏 tab），装配必须先于它们求值。
 * 骨架含链上模块顶层绑定所需的元素 ID；新模块若有顶层绑定，往这里补。
 */
import { Window } from 'happy-dom';

const win = new Window();
(globalThis as { window?: unknown }).window = win;
(globalThis as { document?: unknown }).document = win.document;
/* edit.scheduleHeatRail 等用到帧调度全局；happy-dom 的 Window 自带实现，桥接到全局 */
const g = globalThis as Record<string, unknown>;
if (!g.requestAnimationFrame) g.requestAnimationFrame = (cb: FrameRequestCallback) => win.requestAnimationFrame(cb);
if (!g.cancelAnimationFrame) g.cancelAnimationFrame = (id: number) => (win.cancelAnimationFrame as unknown as (n: number) => void)(id);

document.body.innerHTML =
  '<div id="reader"></div><aside id="sidebar"></aside><button id="btn-ai"></button><span id="status"></span>' +
  '<div id="mode-pill"></div>' +
  '<button id="chat-send"></button><button id="chat-clear"></button><textarea id="chat-input"></textarea>' +
  '<button id="side-tab-ai"></button><button id="side-tab-edit"></button><button id="side-tab-review"></button><div id="side-review"></div>';

/* ── `?raw` 加载钩子：随本模块按需注册（2026-09-16）──────────────────────────
 * 曾经用 npm test 全局 --import 挂钩，实测**注册模块钩子本身**会改变 node:test 的
 * 求值时序（lexiconstore 真跑组退化成"after() 删目录后才惰性 loadProject"，16/8 失败）。
 * 现在只有 import 本模块的测试才注册（wordsimpl 等 app DOM 链测试）；
 * 纯 node 测试（lexiconstore 等）不经过这里，时序不受影响。
 * 注意：模块钩子只对此后发生的**动态 import** 生效——需要钩子的测试文件对 app 模块
 * 一律用 await import(...)，不要静态 import。 */
import { register } from 'node:module';
register(new URL('../../tools/raw-hook-impl.mjs', import.meta.url)); // dist 布局：dist/tests → 仓根/tools
