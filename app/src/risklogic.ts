/** Pure risk-panel presentation helpers. Kept UI-free for Node tests and future worker use. */
import { GATE_RULES, type GateCategory } from '../../src/core/segmentgate.js';
import type { RiskItem } from '../../src/core/riskqueue.js';
export const ITEM_MINUTES: Record<string, number> = { 'FACT-01': 2, 'FACT-02': 2, 'ANNO-01': 0.5, 'ANNO-03': 0.7, 'ANNO-02': 0.3, 'SENT-01': 0.5, 'LEN-01': 0.5, 'ZH-01': 1 };
export const itemMinutes = (ruleId: string): number => ITEM_MINUTES[ruleId] ?? 0.5;
export function countByCategory(items: RiskItem[]): Partial<Record<GateCategory, number>> {
  const out: Partial<Record<GateCategory, number>> = {};
  for (const it of items) out[it.category] = (out[it.category] ?? 0) + 1;
  return out;
}
export const ruleLabel = (ruleId: string): string => GATE_RULES[ruleId]?.label ?? ruleId;
