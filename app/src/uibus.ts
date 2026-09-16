/**
 * UI 总线端口（2026-09-16，C2 解环）：视图模块对"全局 UI 编排动作"的**唯一入口**。
 *
 * 为什么存在：renderAll / switchView / addSession 这些动作是 main.ts 的实现，
 * 而多个视图模块需要调用它们——直接 import main 就是反向边，是 24 条循环链的主体。
 * 现在视图模块 import 本模块（零视图依赖的底层），main.ts 在装配期把实现注入进来。
 *
 * **这是过渡方案（服务定位器模式），不是终局**：
 *   · 终局方向是事件总线（视图只发"发生了什么"，不做"接下来渲染什么"）或显式 DI
 *     （实现随模块构造传入）。两者都要先拆 main.ts 的编排职责，属于后续阶段。
 *   · **删除条件**：main.ts 的视图编排拆分完成后，各实现回到自己的模块、可以自上而下
 *     直接 import 时，槽位改回直接引用并删除本模块；或全面事件化后由事件总线取代。
 *   · 在此之前：新增"跨模块 UI 动作"时**必须**走本总线，不许再直接 import main.ts
 *     （静态或动态——动态 import 同样是边，reader.ts:220 的教训）。
 *
 * 守卫：每个槽位在注册前被调用会**当场抛错**（不静默、不吞）。
 * 装配发生在 main.ts 模块顶层；所有调用点都在用户交互回调里（2026-09-16 补查 3/B
 * 双向扫描证实：静态顶层 0 处、动态 import 0 处）——若未来有人把调用挪进模块加载路径，
 * 这道守卫会把装配顺序缺陷当场暴露，而不是让界面"点了没反应"。
 */

import type { ViewName } from './widgets.js';

function unregistered(name: string): (...args: unknown[]) => never {
  return () => {
    throw new Error(`uibus.${name} 未注册——main.ts 装配未完成就发生了调用。这是装配顺序缺陷，不是可重试错误。`);
  };
}

export interface UiBus {
  renderAll(): void;
  switchView(name: ViewName): void;
  syncChrome(): void;
  updateModePill(): void;
  flashApplied(revised: string): void;
  runQcCurrent(opts?: { auto?: boolean }): Promise<void>;
  openPathIntoSession(p: string): Promise<void>;
  loadBuiltinDemo(): void;
  addSession(md: string, fileName: string, sourcePath: string | null, opts?: { noAutoQc?: boolean }): Promise<void>;
  fileSummary(): void;
}

export const uibus: UiBus = {
  renderAll: unregistered('renderAll') as UiBus['renderAll'],
  switchView: unregistered('switchView') as UiBus['switchView'],
  syncChrome: unregistered('syncChrome') as UiBus['syncChrome'],
  updateModePill: unregistered('updateModePill') as UiBus['updateModePill'],
  flashApplied: unregistered('flashApplied') as UiBus['flashApplied'],
  runQcCurrent: unregistered('runQcCurrent') as UiBus['runQcCurrent'],
  openPathIntoSession: unregistered('openPathIntoSession') as UiBus['openPathIntoSession'],
  loadBuiltinDemo: unregistered('loadBuiltinDemo') as UiBus['loadBuiltinDemo'],
  addSession: unregistered('addSession') as UiBus['addSession'],
  fileSummary: unregistered('fileSummary') as UiBus['fileSummary'],
};
