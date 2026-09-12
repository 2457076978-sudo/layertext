# UI dependency graph

Evidence from `rg -n`:

```text
app/src/main.ts
  -> risk.ts (line 16), widgets.ts (13), aiflow.ts (20), report.ts (22), shelf.ts (54), reader.ts (55), edit.ts (60)
  -> state.ts, uikit.ts, pure.ts, bookpure.ts, datapanel.ts, pipew.ts, ai.ts, review.ts
app/src/risk.ts
  -> src/core/workbench.ts (lines 40-56), riskqueue.ts, version.ts, manifest.ts, decision.ts, riskaction.ts
  -> app/src/risklogic.ts (new pure presentation helpers)
src/core/workbench.ts
  -> src/core/riskqueue.ts (line 24), decision.ts, manifest.ts
```

`main -> risk` is an import edge. There is no direct `risk -> main` edge in the current source; the practical cycle is indirect through modules imported by both (notably state/uikit and UI action callbacks), so moving pure calculations out of risk reduces the cycle surface. `workbench` is core-only and has no UI import; it is not part of a direct cycle.

Extracted boundary: `app/src/risklogic.ts` contains `itemMinutes`, `countByCategory`, and `ruleLabel`; `risk.ts` imports them so existing callers and exports remain unchanged. These functions are deterministic and UI-free, suitable for core tests or a worker later.
