export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void
  info(msg: string, meta?: Record<string, unknown>): void
  warn(msg: string, meta?: Record<string, unknown>): void
  error(msg: string, meta?: Record<string, unknown>): void
  child(scope: string): Logger
}

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

function currentLevel(): number {
  const env = (process.env['GKS_LOG_LEVEL'] ?? 'info').toLowerCase() as LogLevel
  return LEVELS[env] ?? LEVELS.info
}

function emit(level: LogLevel, scope: string, msg: string, meta?: Record<string, unknown>) {
  if (LEVELS[level] < currentLevel()) return
  const line = {
    t: new Date().toISOString(),
    level,
    scope,
    msg,
    ...(meta ?? {}),
  }
  const channel = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log
  channel(JSON.stringify(line))
}

export function createLogger(scope = 'gks'): Logger {
  return {
    debug: (msg, meta) => emit('debug', scope, msg, meta),
    info: (msg, meta) => emit('info', scope, msg, meta),
    warn: (msg, meta) => emit('warn', scope, msg, meta),
    error: (msg, meta) => emit('error', scope, msg, meta),
    child: (child) => createLogger(`${scope}:${child}`),
  }
}
