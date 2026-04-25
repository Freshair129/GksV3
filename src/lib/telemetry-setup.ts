/**
 * setupTelemetry() — opt-in OpenTelemetry SDK wiring.
 *
 * Most app code only needs `src/lib/telemetry.ts` (the noop-safe façade).
 * This module is the optional escape hatch for users who want OTLP export
 * to a real collector (Jaeger / Tempo / Honeycomb / Grafana / Otel
 * collector / etc.).
 *
 * Why a separate module
 *   The OTLP exporters + AsyncHooks context manager weigh a few MB. Pinning
 *   them as devDeps means callers who only use the noop API don't pull
 *   them. setupTelemetry() lazy-imports the SDK pieces; if they aren't
 *   installed, we throw with a clear "npm install ..." pointer.
 *
 * Usage
 *   import { setupTelemetry } from 'gks-v3/lib/telemetry-setup'
 *
 *   await setupTelemetry({ serviceName: 'my-agent' })
 *   // ...uses OTEL_EXPORTER_OTLP_ENDPOINT env var
 *
 * Env conventions (matched to OpenTelemetry SDK env spec)
 *   OTEL_EXPORTER_OTLP_ENDPOINT     base URL — adapter appends /v1/traces, /v1/metrics
 *   OTEL_EXPORTER_OTLP_HEADERS      comma-separated k=v pairs
 *   OTEL_SERVICE_NAME               overrides serviceName option
 *   OTEL_RESOURCE_ATTRIBUTES        comma-separated k=v pairs added to Resource
 */

import {
  trace,
  metrics,
  context as contextApi,
  type ContextManager,
  type MeterProvider,
  type TracerProvider,
} from '@opentelemetry/api'

export interface SetupTelemetryOptions {
  /** Service name added to the Resource. Default 'gks-v3'. */
  serviceName?: string
  /**
   * OTLP base endpoint. If omitted (and OTEL_EXPORTER_OTLP_ENDPOINT also
   * unset), telemetry stays in noop mode — useful for tests / local runs.
   */
  otlpEndpoint?: string
  /** Headers added to OTLP requests (e.g. auth). */
  otlpHeaders?: Record<string, string>
  /** Trace export interval (ms). Default 5000. */
  traceExportIntervalMs?: number
  /** Metric export interval (ms). Default 30000. */
  metricExportIntervalMs?: number
  /**
   * Wire AsyncHooksContextManager so spans propagate across awaits. Default
   * true — turn it off in environments where async_hooks isn't available
   * (Cloudflare Workers, etc.).
   */
  enableAsyncContext?: boolean
  /**
   * Additional Resource attributes (deployment.environment, k8s.pod.name, …).
   */
  resourceAttributes?: Record<string, string>
}

export interface SetupResult {
  shutdown: () => Promise<void>
  enabled: boolean
}

/**
 * Bring up an OTel SDK with OTLP exporters. Returns a `shutdown()` callback
 * the caller should invoke at process exit so spans/metrics flush.
 *
 * Throws with an actionable error if the SDK packages aren't installed.
 */
export async function setupTelemetry(
  opts: SetupTelemetryOptions = {},
): Promise<SetupResult> {
  const endpoint = opts.otlpEndpoint ?? process.env['OTEL_EXPORTER_OTLP_ENDPOINT']
  if (!endpoint) {
    return { shutdown: async () => {}, enabled: false }
  }

  let sdk: SdkExports
  try {
    sdk = await loadSdk()
  } catch (err) {
    throw new Error(
      `setupTelemetry: missing OTel SDK packages. Install with:\n` +
        `  npm install \\\n` +
        `    @opentelemetry/sdk-trace-base \\\n` +
        `    @opentelemetry/sdk-metrics \\\n` +
        `    @opentelemetry/exporter-trace-otlp-http \\\n` +
        `    @opentelemetry/exporter-metrics-otlp-http \\\n` +
        `    @opentelemetry/resources \\\n` +
        `    @opentelemetry/context-async-hooks\n\n` +
        `(${(err as Error).message})`,
    )
  }

  const serviceName =
    opts.serviceName ?? process.env['OTEL_SERVICE_NAME'] ?? 'gks-v3'
  const allAttrs: Record<string, string> = {
    'service.name': serviceName,
    'service.version': '3.5.0',
    ...parseAttributes(process.env['OTEL_RESOURCE_ATTRIBUTES']),
    ...(opts.resourceAttributes ?? {}),
  }
  const headers = {
    ...opts.otlpHeaders,
    ...parseAttributes(process.env['OTEL_EXPORTER_OTLP_HEADERS']),
  }

  const resource = sdk.defaultResource().merge(sdk.resourceFromAttributes(allAttrs))

  // ── Tracing ────────────────────────────────────────────────────────────
  const traceExporter = new sdk.OTLPTraceExporter({
    url: `${stripTrailingSlash(endpoint)}/v1/traces`,
    headers,
  })
  const tracerProvider = new sdk.BasicTracerProvider({
    resource,
    spanProcessors: [
      new sdk.BatchSpanProcessor(traceExporter, {
        scheduledDelayMillis: opts.traceExportIntervalMs ?? 5_000,
      }),
    ],
  })
  trace.setGlobalTracerProvider(tracerProvider as unknown as TracerProvider)

  if (opts.enableAsyncContext !== false) {
    const cm = new sdk.AsyncHooksContextManager().enable()
    contextApi.setGlobalContextManager(cm as ContextManager)
  }

  // ── Metrics ────────────────────────────────────────────────────────────
  const metricExporter = new sdk.OTLPMetricExporter({
    url: `${stripTrailingSlash(endpoint)}/v1/metrics`,
    headers,
  })
  const metricReader = new sdk.PeriodicExportingMetricReader({
    exporter: metricExporter,
    exportIntervalMillis: opts.metricExportIntervalMs ?? 30_000,
  })
  const meterProvider = new sdk.MeterProvider({ resource, readers: [metricReader] })
  metrics.setGlobalMeterProvider(meterProvider as unknown as MeterProvider)

  return {
    enabled: true,
    shutdown: async () => {
      await Promise.allSettled([tracerProvider.shutdown(), meterProvider.shutdown()])
    },
  }
}

// ─── helpers ───────────────────────────────────────────────────────────────

function stripTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url
}

function parseAttributes(raw: string | undefined): Record<string, string> {
  if (!raw) return {}
  const out: Record<string, string> = {}
  for (const part of raw.split(',')) {
    const eq = part.indexOf('=')
    if (eq <= 0) continue
    out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim()
  }
  return out
}

/**
 * The OTel SDK has a non-trivial type surface that doesn't survive `unknown`
 * casts well. We type each piece via the fields we use; unused ones can stay
 * loose. Runtime correctness is what matters — the wrong import path would
 * fail at sdk-load time, before any of these casts mattered.
 */
interface SdkExports {
  BasicTracerProvider: new (opts: {
    resource: unknown
    spanProcessors: unknown[]
  }) => { shutdown(): Promise<void> }
  BatchSpanProcessor: new (
    exporter: unknown,
    opts: { scheduledDelayMillis: number },
  ) => unknown
  OTLPTraceExporter: new (opts: {
    url: string
    headers?: Record<string, string>
  }) => unknown
  MeterProvider: new (opts: { resource: unknown; readers: unknown[] }) => {
    shutdown(): Promise<void>
  }
  PeriodicExportingMetricReader: new (opts: {
    exporter: unknown
    exportIntervalMillis: number
  }) => unknown
  OTLPMetricExporter: new (opts: {
    url: string
    headers?: Record<string, string>
  }) => unknown
  defaultResource: () => { merge(other: unknown): unknown }
  resourceFromAttributes: (attrs: Record<string, string>) => unknown
  AsyncHooksContextManager: new () => { enable(): unknown }
}

async function loadSdk(): Promise<SdkExports> {
  // Dynamic imports keep these out of the typecheck path when packages
  // aren't installed yet (the imports become runtime-only requirements).
  const [tb, ms, te, me, res, ah] = (await Promise.all([
    import('@opentelemetry/sdk-trace-base'),
    import('@opentelemetry/sdk-metrics'),
    import('@opentelemetry/exporter-trace-otlp-http'),
    import('@opentelemetry/exporter-metrics-otlp-http'),
    import('@opentelemetry/resources'),
    import('@opentelemetry/context-async-hooks'),
  ])) as unknown as [
    Pick<SdkExports, 'BasicTracerProvider' | 'BatchSpanProcessor'>,
    Pick<SdkExports, 'MeterProvider' | 'PeriodicExportingMetricReader'>,
    Pick<SdkExports, 'OTLPTraceExporter'>,
    Pick<SdkExports, 'OTLPMetricExporter'>,
    Pick<SdkExports, 'defaultResource' | 'resourceFromAttributes'>,
    Pick<SdkExports, 'AsyncHooksContextManager'>,
  ]

  return {
    ...tb,
    ...ms,
    ...te,
    ...me,
    ...res,
    ...ah,
  }
}
