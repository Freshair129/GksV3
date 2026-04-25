/**
 * Telemetry module tests — verify spans + metrics actually fire when an SDK
 * is registered. Uses the OTel SDK's InMemory exporters so we never touch
 * the network.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { trace, metrics } from '@opentelemetry/api'
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from '@opentelemetry/sdk-trace-base'
import {
  MeterProvider,
  InMemoryMetricExporter,
  PeriodicExportingMetricReader,
  AggregationTemporality,
} from '@opentelemetry/sdk-metrics'

import {
  withSpan,
  recordHistogram,
  incrementCounter,
  timeAsync,
  METRIC_NAMES,
} from '../../src/lib/telemetry.js'

describe('telemetry — tracing', () => {
  let exporter: InMemorySpanExporter
  let provider: BasicTracerProvider

  beforeEach(() => {
    exporter = new InMemorySpanExporter()
    provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] })
    trace.setGlobalTracerProvider(provider)
  })

  afterEach(async () => {
    await provider.shutdown()
    trace.disable()
  })

  it('withSpan emits a span with the given name + attributes', async () => {
    const out = await withSpan('test.op', { foo: 'bar', n: 42 }, async () => 'ok')
    expect(out).toBe('ok')

    const spans = exporter.getFinishedSpans()
    expect(spans).toHaveLength(1)
    const s = spans[0]!
    expect(s.name).toBe('test.op')
    expect(s.attributes['foo']).toBe('bar')
    expect(s.attributes['n']).toBe(42)
    expect(s.status.code).toBe(1) // OK
  })

  it('withSpan records exceptions + sets ERROR status when fn throws', async () => {
    await expect(
      withSpan('test.fail', { kind: 'unit' }, async () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow(/boom/)

    const spans = exporter.getFinishedSpans()
    expect(spans).toHaveLength(1)
    expect(spans[0]!.status.code).toBe(2) // ERROR
    expect(spans[0]!.status.message).toBe('boom')
    expect(spans[0]!.events.some((e) => e.name === 'exception')).toBe(true)
  })

  // The active-span / parent-span APIs need a context manager
  // (AsyncHooksContextManager) which is a separate registration step the
  // user does in setupTelemetry(). What we own here is "withSpan passes the
  // SDK Span object to the fn correctly" — that's enough to let callers
  // attach attributes, events, and child spans manually.
  it('passes the active SDK Span to the fn for attribute/event mutation', async () => {
    let receivedSpanId: string | undefined
    await withSpan('outer', {}, async (span) => {
      receivedSpanId = span.spanContext().spanId
      span.addEvent('inside')
    })
    const spans = exporter.getFinishedSpans()
    const outer = spans.find((s: ReadableSpan) => s.name === 'outer')!
    expect(receivedSpanId).toBe(outer.spanContext().spanId)
    expect(outer.events.some((e) => e.name === 'inside')).toBe(true)
  })

  it('accepts attributes-as-fn (lazy attrs)', async () => {
    await withSpan(
      'lazy',
      (span) => {
        // sentinel that the fn was called with the actual span
        span.setAttribute('via', 'fn')
        return { also: 'set' }
      },
      async () => 1,
    )
    const s = exporter.getFinishedSpans()[0]!
    expect(s.attributes['via']).toBe('fn')
    expect(s.attributes['also']).toBe('set')
  })
})

describe('telemetry — metrics', () => {
  let exporter: InMemoryMetricExporter
  let reader: PeriodicExportingMetricReader
  let provider: MeterProvider

  beforeEach(() => {
    exporter = new InMemoryMetricExporter(AggregationTemporality.DELTA)
    reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 60_000 })
    provider = new MeterProvider({ readers: [reader] })
    metrics.setGlobalMeterProvider(provider)
  })

  afterEach(async () => {
    await provider.shutdown()
    metrics.disable()
  })

  it('recordHistogram emits to the configured exporter', async () => {
    recordHistogram(METRIC_NAMES.recallLatency, 12.5, { strategy: 'vector' })
    recordHistogram(METRIC_NAMES.recallLatency, 45.3, { strategy: 'vector' })

    await reader.forceFlush()
    const data = exporter.getMetrics()
    const found = data
      .flatMap((r) => r.scopeMetrics)
      .flatMap((sm) => sm.metrics)
      .find((m) => m.descriptor.name === METRIC_NAMES.recallLatency)
    expect(found).toBeDefined()
    const dp = found!.dataPoints[0] as { value?: { count: number; sum: number } }
    expect(dp.value?.count).toBe(2)
    expect(dp.value?.sum).toBeCloseTo(57.8, 1)
  })

  it('incrementCounter accumulates', async () => {
    incrementCounter(METRIC_NAMES.retainDocs, 1)
    incrementCounter(METRIC_NAMES.retainDocs, 4)
    incrementCounter(METRIC_NAMES.retainDocs)

    await reader.forceFlush()
    const data = exporter.getMetrics()
    const found = data
      .flatMap((r) => r.scopeMetrics)
      .flatMap((sm) => sm.metrics)
      .find((m) => m.descriptor.name === METRIC_NAMES.retainDocs)
    expect(found).toBeDefined()
    const dp = found!.dataPoints[0] as { value: number }
    expect(dp.value).toBe(6)
  })

  it('timeAsync records latency under any name', async () => {
    const result = await timeAsync('test.op_ms', async () => {
      await new Promise((r) => setTimeout(r, 5))
      return 'done'
    })
    expect(result).toBe('done')

    await reader.forceFlush()
    const data = exporter.getMetrics()
    const found = data
      .flatMap((r) => r.scopeMetrics)
      .flatMap((sm) => sm.metrics)
      .find((m) => m.descriptor.name === 'test.op_ms')
    expect(found).toBeDefined()
    const dp = found!.dataPoints[0] as { value?: { count: number } }
    expect(dp.value?.count).toBe(1)
  })
})

describe('telemetry — no-op when no provider registered', () => {
  beforeEach(() => {
    trace.disable()
    metrics.disable()
  })

  it('withSpan still runs the fn and returns its value', async () => {
    const out = await withSpan('test.op', { x: 1 }, async () => 42)
    expect(out).toBe(42)
  })

  it('recordHistogram + incrementCounter are no-ops, no throw', () => {
    expect(() => recordHistogram('x', 1)).not.toThrow()
    expect(() => incrementCounter('y')).not.toThrow()
  })
})
