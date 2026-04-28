---
id: SLO--<SERVICE-NAME>
phase: 2
type: slo
status: active                  # draft | active | retired
vault_id: <YOUR-PROJECT>
title: <Service + metric>
tags: [slo, monitoring]
crosslinks:
  enforces: []                  # NFR-- this SLO operationalises (Hierarchical Link)
  runbooks: []                  # RUNBOOK-- triggered by breach (Action Link)
  references: []                # Contextual background / external dashboards (Context Link)
---

# SLO — <Title>

## Indicator (SLI)

What is measured.

```
metric:    <e.g. http_requests_total successful / http_requests_total all>
window:    <e.g. rolling 30 days>
exclusion: <maintenance windows / known degradations>
```

## Target

```
objective: <e.g. 99.9% successful requests / month>
threshold: <e.g. error budget = 0.1% × monthly request volume>
```

## Alert thresholds

| Burn rate | Alert | Recipient |
|---|---|---|
| 14× (2h budget exhaustion) | page | on-call |
| 6× (24h) | page | on-call |
| 1× (30d) | ticket | team channel |

## Error budget policy

What happens when budget is exhausted:
- freeze non-critical deploys
- prioritise reliability work
- review at next retro

## Review cadence

- weekly: trend check
- quarterly: re-evaluate target

## See also

- <NFR-- this implements>
- <RUNBOOK-- triggered on breach>
