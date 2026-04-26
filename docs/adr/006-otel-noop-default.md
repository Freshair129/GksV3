# ADR 006 — OpenTelemetry with no-op default

- **Status:** accepted
- **Date:** 2026-04-25
- **Deciders:** core
- **Context tag:** observability, dependencies

## Context

Phase 4 H.1 needed observability across retain / recall / reflect /
embedder / rerank / cache. Two design forks:

1. **Always-on SDK.** Bundle the OTel SDK as a hard dependency, set up
   an exporter at module load. Always pay the install + boot cost.
2. **API-only by default.** Use `@opentelemetry/api` (no-op without an
   SDK) in the codebase; ship a `setupTelemetry()` helper that lazy-
   imports the SDK pieces when the user enables OTLP export.

## Decision

Take fork (2). The codebase calls `withSpan / recordHistogram /
incrementCounter` everywhere; the API package is ~50 KB and has built-in
noop implementations. Users that want OTLP run `setupTelemetry({ ... })`
at process start; the SDK + exporter packages are devDeps that they
install themselves on demand (or we ship a starter).

## Consequences

**Positive**
- Zero observability tax for users who don't run a collector. ~50 ns
  per call to a noop tracer/meter — well below any work being measured.
- Tests don't need to set up an SDK; in-memory exporters in 9 test
  cases verify the instrumentation actually fires when an SDK IS
  registered.
- The "what happens when OTel isn't wired" question has a clean answer:
  same as if you removed all the spans.

**Negative**
- Lazy instrument resolution: `recordHistogram(name, ...)` calls
  `meter.createHistogram(name)` on every emit. If a user registers a
  MeterProvider after our module loaded, eagerly-cached instruments
  would point at the noop meter forever — so we resolve per-call.
  Cost is one Map lookup; negligible vs the work measured.
- Async-context propagation across awaits requires
  `AsyncHooksContextManager` (separate package). Documented in
  `docs/OBSERVABILITY.md`; tests verify the Span object reaches the
  fn synchronously, not the cross-await case.

## References

- `src/lib/telemetry.ts` — façade
- `src/lib/telemetry-setup.ts` — opt-in OTLP wiring
- [`docs/OBSERVABILITY.md`](../OBSERVABILITY.md)
