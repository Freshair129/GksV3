# GKS v3 — Observability

GKS instruments every hot path with OpenTelemetry — spans on `retain` /
`recall`, plus histograms and counters covering embedder latency, rerank
latency, cache hit rate, and circuit-breaker activity. With no SDK
registered the API is no-op safe; activate OTLP export by calling
`setupTelemetry()` (or wiring your own SDK) at process start.

## Quick start

```ts
import { setupTelemetry } from 'gks-v3/lib/telemetry-setup'

const otel = await setupTelemetry({ serviceName: 'my-agent' })

// ... run agent ...

await otel.shutdown() // flushes pending spans + metrics on exit
```

If `OTEL_EXPORTER_OTLP_ENDPOINT` is unset, `setupTelemetry()` returns
`{ enabled: false }` and the global tracer/meter remain noop. Useful in
tests + local dev — instrumented code stays fast.

## Required environment

| Var | Purpose |
|---|---|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Base URL of your OTLP collector. The setup adapter appends `/v1/traces` and `/v1/metrics`. Example: `http://localhost:4318` for the local OTel Collector. |
| `OTEL_EXPORTER_OTLP_HEADERS` | Comma-separated `k=v` pairs added to OTLP requests (e.g. `api-key=ABC,team=memory`). |
| `OTEL_SERVICE_NAME` | Overrides the `serviceName` option. |
| `OTEL_RESOURCE_ATTRIBUTES` | Extra Resource attrs in `k=v,k=v` form (e.g. `deployment.environment=prod`). |

## Required dev packages (already in package.json devDeps)

`setupTelemetry()` lazy-imports the SDK pieces. They're devDeps in this
repo so users who only use the noop API don't pay the install cost. To
actually export to a collector you need them installed:

```sh
npm install \
  @opentelemetry/sdk-trace-base \
  @opentelemetry/sdk-metrics \
  @opentelemetry/exporter-trace-otlp-http \
  @opentelemetry/exporter-metrics-otlp-http \
  @opentelemetry/resources \
  @opentelemetry/context-async-hooks
```

The setup function throws an actionable error if any are missing.

## What's emitted

### Spans

| Span name | When | Attributes |
|---|---|---|
| `gks.retain` | Each `retain()` call | `gks.content_length`, `gks.session_id`, `gks.policy`, `gks.conflicts`, `gks.invalidated`, `gks.proposed_inbound` |
| `gks.recall` | Each `recall()` / `MemoryStore.retrieve()` call | `gks.query_length`, `gks.strategy`, `gks.top_k`, `gks.hit_count`, `gks.candidate_count`, `gks.took_ms` |

Spans use OTel's standard status — exceptions get recorded via
`span.recordException()` and the status flips to `ERROR`. Async-context
propagation across awaits is enabled when `setupTelemetry()` runs with
the default `enableAsyncContext: true`.

### Metrics

| Name | Type | Unit | Attributes |
|---|---|---|---|
| `gks.retain.docs` | counter | `{doc}` | `backend`, `has_conflict` |
| `gks.recall.latency_ms` | histogram | `ms` | `strategy` |
| `gks.recall.hits` | counter | `{hit}` | `strategy` |
| `gks.embedder.latency_ms` | histogram | `ms` | `provider`, `model`, `outcome`, `batch?` |
| `gks.rerank.latency_ms` | histogram | `ms` | `backend`, `host`, `batch`, `outcome` |
| `gks.cache.hits` | counter | `{hit}` | `cache=obsidian` |
| `gks.cache.misses` | counter | `{miss}` | `cache=obsidian` |
| `gks.circuit.opens` | counter | reserved (not yet emitted) | `name` |

Histogram buckets follow OTel defaults; tune in your collector pipeline
if you need finer granularity at the recall p99 tail.

## Recommended collector pipeline

Minimal `otel-collector-config.yaml`:

```yaml
receivers:
  otlp:
    protocols:
      http:
        endpoint: 0.0.0.0:4318

processors:
  batch:
  resourcedetection:
    detectors: [env, system]

exporters:
  prometheus:
    endpoint: 0.0.0.0:8889
  otlp:
    endpoint: tempo:4317
    tls: { insecure: true }

service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [batch, resourcedetection]
      exporters: [otlp]
    metrics:
      receivers: [otlp]
      processors: [batch, resourcedetection]
      exporters: [prometheus]
```

Point GKS at it:

```sh
export OTEL_EXPORTER_OTLP_ENDPOINT=http://collector:4318
npm start
```

## Dashboard cheat-sheet

A working starter dashboard tracks four panels:

1. **Recall latency** — `histogram_quantile(0.95, sum(rate(gks_recall_latency_ms_bucket[5m])) by (le))`. p95 < 200 ms is the BEAM target.
2. **Ingest throughput** — `sum(rate(gks_retain_docs[1m]))`. Multiply by avg-tokens-per-doc to estimate token throughput.
3. **Embedder error rate** — `sum(rate(gks_embedder_latency_ms_count{outcome="error"}[5m])) / sum(rate(gks_embedder_latency_ms_count[5m]))`. Spike → check provider status / circuit breaker.
4. **Cache hit rate** — `sum(rate(gks_cache_hits[5m])) / (sum(rate(gks_cache_hits[5m])) + sum(rate(gks_cache_misses[5m])))`. Sub-50% with stable workload usually means TTL is too short.

## Adding your own spans

Use the façade — it's the same API as direct `@opentelemetry/api`:

```ts
import { withSpan, recordHistogram } from 'gks-v3/lib/telemetry'

await withSpan(
  'agent.tool_call',
  { tool: 'search', user_id: ctx.userId },
  async (span) => {
    span.addEvent('tool_invoked', { args: JSON.stringify(args) })
    const result = await tool.run(args)
    span.setAttribute('result.bytes', result.length)
    return result
  },
)

recordHistogram('agent.tool.latency_ms', took, { tool: 'search' })
```

## Troubleshooting

- **No spans show up.** Confirm `OTEL_EXPORTER_OTLP_ENDPOINT` is set
  and reachable. Check `setupTelemetry()` return value: if `enabled` is
  `false`, the env wasn't picked up.
- **"missing OTel SDK packages" error.** Install the six packages listed
  above. Bare `@opentelemetry/api` is enough for noop mode but not for
  OTLP export.
- **Spans don't propagate across awaits.** Either `enableAsyncContext`
  is `false` or you're on a runtime without `async_hooks` (e.g.
  workers). Span attributes still attach, but parent/child links won't.
- **Metrics arrive as cumulative not delta.** Set the collector's
  receiver to `temporality_preference: delta` if you've configured the
  exporter for delta and the collector for cumulative (or vice versa).
