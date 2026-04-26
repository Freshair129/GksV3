---
id: BLUEPRINT--FEAT-STOCK
phase: 3
type: blueprint
status: stable
vault_id: EXAMPLE
title: Stock allocation blueprint
geography:
  - src/stock/fefo.ts:applyFefo
  - src/stock/checkout.ts
---

# BLUEPRINT — Stock allocation

FEFO with reservation; see `geography` for governed code paths.
