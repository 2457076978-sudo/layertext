/**
 * node 测试的 DOM 环境（2026-09-16）：happy-dom 提供 window/document 全局。
 * **必须作为测试文件的第一个 import**——ESM 按声明序求值，uikit 等模块在顶层
 * 就挂 window 事件（uikit.js 的 error→toast），装配必须先于它们的求值。
 */
import { Window } from 'happy-dom';

const win = new Window();
(globalThis as { window?: unknown }).window = win;
(globalThis as { document?: unknown }).document = win.document;
