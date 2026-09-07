export type LoadTestPhase = 'initial-load' | 'after-click'

export type LoadTestStep =
  | { type: 'click'; selector?: string; text?: string }
  | { type: 'fill'; selector: string; value: string }
  | { type: 'scroll'; x?: number; y?: number }
  | { type: 'wait'; ms: number }
  | { type: 'press'; key: string }

export interface LoadTestScenario {
  steps: LoadTestStep[]
}

export interface NetworkRequestRecord {
  method: string
  url: string
  domain: string
  path: string
  resourceType: string
  status: number | null
  bytes: number
  durationMs: number
  startedAt: string
  phase: LoadTestPhase
  error?: string
}

export interface VirtualUserResult {
  userIndex: number
  status: 'passed' | 'failed' | 'cancelled'
  startedAt: string
  finishedAt: string
  durationMs: number
  failureReason?: string
  failedPhase?: LoadTestPhase
  requestCount: number
  errorCount: number
  bytes: number
  requests: NetworkRequestRecord[]
}

export interface TimelineBucket {
  t: number
  requests: number
  errors: number
  avgMs: number
}

export interface StartLoadTestCommand {
  action: 'start-load-test'
  runId: string
  targetUrl: string
  scenario: LoadTestScenario
  virtualUsers: number
  concurrency: number
  navigationTimeoutMs: number
  afterClickTimeoutMs: number
}

export function parseClickTarget(step: Extract<LoadTestStep, { type: 'click' }>): { kind: 'css' | 'text'; value: string } {
  const selector = step.selector?.trim() || ''
  const text = step.text?.trim() || ''
  if (selector) return { kind: 'css', value: selector }
  if (text) return { kind: 'text', value: text }
  throw new Error('El clic necesita un selector CSS o un texto visible')
}

export function looksLikeCssSelector(value: string): boolean {
  const trimmed = value.trim()
  return /^[#.\[a-zA-Z]/.test(trimmed) && /[#.\[\]>=:~]/.test(trimmed)
}

export function normalizeScenario(raw: unknown): LoadTestScenario {
  const source = raw && typeof raw === 'object' ? raw as { steps?: unknown; selector?: unknown; text?: unknown } : {}
  if (Array.isArray(source.steps) && source.steps.length > 0) {
    const steps = source.steps.map(parseStep)
    return { steps }
  }
  const selector = typeof source.selector === 'string' ? source.selector.trim() : ''
  const text = typeof source.text === 'string' ? source.text.trim() : ''
  if (selector) return { steps: [{ type: 'click', selector }] }
  if (text) return { steps: [{ type: 'click', text }] }
  throw new Error('Indica el botón a pulsar (selector o texto)')
}

function parseStep(value: unknown): LoadTestStep {
  if (!value || typeof value !== 'object') throw new Error('Paso de escenario no válido')
  const step = value as Record<string, unknown>
  const type = String(step.type || '')
  if (type === 'click') {
    return {
      type: 'click',
      selector: typeof step.selector === 'string' ? step.selector : undefined,
      text: typeof step.text === 'string' ? step.text : undefined,
    }
  }
  if (type === 'fill') {
    if (typeof step.selector !== 'string' || typeof step.value !== 'string') {
      throw new Error('fill requiere selector y value')
    }
    return { type: 'fill', selector: step.selector, value: step.value }
  }
  if (type === 'scroll') {
    return {
      type: 'scroll',
      x: typeof step.x === 'number' ? step.x : 0,
      y: typeof step.y === 'number' ? step.y : 800,
    }
  }
  if (type === 'wait') {
    const ms = Number(step.ms)
    if (!Number.isFinite(ms) || ms < 0 || ms > 60_000) throw new Error('wait inválido')
    return { type: 'wait', ms }
  }
  if (type === 'press') {
    if (typeof step.key !== 'string' || !step.key.trim()) throw new Error('press requiere key')
    return { type: 'press', key: step.key }
  }
  throw new Error(`Paso no permitido: ${type}`)
}
