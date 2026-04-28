---
id: NFR--<TARGET-NAME>
phase: 1
type: nfr
status: draft
vault_id: <YOUR-PROJECT>
title: <One-line target>
tags: [non-functional, <perf|security|scale|availability|observability>]
priority: medium
target:
  metric: <e.g. p99-latency-ms | error-rate | rps | uptime-%>
  threshold: <e.g. < 200 | < 0.001 | > 1000 | > 99.9>
crosslinks:
  parent: REQ--<umbrella>       # if part of a larger requirement (Hierarchical Link)
  satisfied_by: []              # FEAT-- that satisfy this NFR (Inverse Link)
  verified_by: []               # AUDIT-- / load-test report / SLO-- monitoring (Resolution Link)
  governed_by: []               # ADR-- architecture decision dictating this NFR (Governance Link)
  references: []                # Contextual background / external benchmarks (Context Link)
---

# NFR — <Title>

## Statement

System **shall** maintain <metric> <comparator> <threshold> under <load /
condition>.

## Verification approach

- **method:** load test | chaos test | pen test | continuous monitoring
- **tooling:** <k6 / locust / SLO dashboard / etc>
- **frequency:** every release / weekly / on-demand

## Threshold rationale

Why this number? (SLA, customer expectation, technical constraint)

## Failure mode

What happens if we miss this target? (degraded UX, alert fires,
incident triggered, refund obligation)

## See also

- SLO--<related-objective> (when promoted to live monitoring)
