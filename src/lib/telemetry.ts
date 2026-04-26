/**
 * OpenTelemetry façade.
 *
 * Two design constraints driving the shape:
 *
 *   1. **No-op by default.** Without an SDK registered, the OTel API ships a
 *      noop tracer/meter — calling code is safe regardless of whether the
 *      user's wired up an exporter. Production teams plug in their own
 *      `@opentelemetry/sdk-node` setup OR call `setupTelemetry()` here.
 *
 *   2. **Lazy instrument resolution.** OTel API caches Meter/instrument refs
 *      against the global provider at the time of `getMeter()`. If a user
 *      registers a MeterProvider AFTER our module loaded, eagerly-created
 *      counters point at the noop meter forever. So we resolve instruments
 *      on every emit. The OTel SDK caches instruments by name + meter
 *      internally, so the per-call cost is a Map lookup.
 *
 * Public surface (use these from app code):
 *   - withSpan(name, attrs?, fn)        ← wraps a fn in a span; ergonomic.
 *   - getTracer()                        ← raw OTel Tracer for advanced use.
 *   - recordHistogram(name, ms, attrs?)  ← lazy histogram emit.
 *   - incrementCounter(name, value?, attrs?) ← lazy counter emit.
 *   - METRIC_NAMES                       ← stable names so tests + dashboards
 *                                          stay in sync.
 *
 * SDK setup (opt-in) lives in setupTelemetry() — not loaded by app code so
 * the OTLP exporter packages stay devDeps until the user wants them.
 */

import {
  metrics,
  trace,
  context,
  type Attributes,
  type Span,
  type Tracer,
} from '@opentelemetry/api'
import { SpanStatusCode } from '@opentelemetry/api'

const TRACER_NAME = 'gks-v3'
const TRACER_VERSION = '3.5.0'

export const METRIC_NAMES = {
  retainDocs: 'gks.retain.docs',
  recallLatency: 'gks.recall.latency_ms',
  recallHits: 'gks.recall.hits',
  embedderLatency: 'gks.embedder.latency_ms',
  rerankLatency: 'gks.rerank.latency_ms',
  cacheHits: 'gks.cache.hits',
  cacheMisses: 'gks.cache.misses',
  circuitOpens: 'gks.circuit.opens',
} as const

export function getTracer(): Tracer {
  return trace.getTracer(TRACER_NAME, TRACER_VERSION)
}

/**
 * Wrap an async fn in a span. Sets status, records exceptions, and ends the
 * span on completion. The fn runs inside the span's context so descendant
 * spans created via withSpan() / startSpan() automatically nest.
 */
export async function withSpan<T>(
  name: string,
  attrs: Attributes | ((span: Span) => Attributes | undefined) | undefined,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  const tracer = getTracer()
  const initialAttrs = typeof attrs === 'function' ? undefined : attrs
  const span = tracer.startSpan(name, initialAttrs ? { attributes: initialAttrs } : {})
  if (typeof attrs === 'function') {
    const dynamic = attrs(span)
    if (dynamic) span.setAttributes(dynamic)
  }
  try {
    const result = await context.with(trace.setSpan(context.active(), span), () => fn(span))
    span.setStatus({ code: SpanStatusCode.OK })
    return result
  } catch (err) {
    const e = err as Error
    span.recordException(e)
    span.setStatus({ code: SpanStatusCode.ERROR, message: e.message ?? String(err) })
    throw err
  } finally {
    span.end()
  }
}

/** Record a histogram value (typically a duration in ms). */
export function recordHistogram(name: string, value: number, attrs?: Attributes): void {
  const meter = metrics.getMeter(TRACER_NAME, TRACER_VERSION)
  const hist = meter.createHistogram(name)
  hist.record(value, attrs)
}

export function incrementCounter(name: string, value = 1, attrs?: Attributes): void {
  const meter = metrics.getMeter(TRACER_NAME, TRACER_VERSION)
  const counter = meter.createCounter(name)
  counter.add(value, attrs)
}

/**
 * Time an async operation and record the duration in a histogram. Returns
 * the awaited value. Convenience wrapper around recordHistogram + Date.now().
 */
export async function timeAsync<T>(
  histogramName: string,
  fn: () => Promise<T>,
  attrs?: Attributes,
): Promise<T> {
  const start = Date.now()
  try {
    return await fn()
  } finally {
    recordHistogram(histogramName, Date.now() - start, attrs)
  }
}
