import type { Browser, BrowserContext, Page, Request } from 'playwright'
import { mapPool } from './capacity.js'
import {
  type LoadTestPhase,
  type LoadTestScenario,
  type LoadTestStep,
  type NetworkRequestRecord,
  type StartLoadTestCommand,
  type TimelineBucket,
  type VirtualUserResult,
  parseClickTarget,
} from './loadTestTypes.js'

export interface LoadTestProgress {
  completed: number
  running: number
  pending: number
  failed: number
  message: string
}

export interface LoadTestRunResult {
  status: 'completed' | 'failed' | 'cancelled'
  failureReason?: string
  users: VirtualUserResult[]
  timeline: TimelineBucket[]
}

interface ActiveRequest {
  startedAt: number
  phase: LoadTestPhase
  url: string
  method: string
  resourceType: string
}

function requestRecord(request: Request, phase: LoadTestPhase, startedAt: number, error?: string): NetworkRequestRecord {
  const url = request.url()
  let parsed: URL | undefined
  try {
    parsed = new URL(url)
  } catch {
    parsed = undefined
  }
  const timing = request.timing()
  const durationMs = Number.isFinite(timing.responseEnd) && timing.responseEnd >= 0
    ? Math.max(0, timing.responseEnd)
    : Math.max(0, Date.now() - startedAt)
  const failure = request.failure()
  return {
    method: request.method(),
    url,
    domain: parsed?.host || '',
    path: parsed ? `${parsed.pathname}${parsed.search}` : url,
    resourceType: request.resourceType(),
    status: null,
    bytes: 0,
    durationMs: Math.round(durationMs),
    startedAt: new Date(startedAt).toISOString(),
    phase,
    error: error || failure?.errorText,
  }
}

async function attachNetwork(page: Page, phaseOf: () => LoadTestPhase, records: NetworkRequestRecord[]): Promise<() => void> {
  const pending = new Map<Request, ActiveRequest>()

  const onRequest = (request: Request) => {
    pending.set(request, {
      startedAt: Date.now(),
      phase: phaseOf(),
      url: request.url(),
      method: request.method(),
      resourceType: request.resourceType(),
    })
  }

  const finish = async (request: Request, error?: string) => {
    const active = pending.get(request)
    pending.delete(request)
    const record = requestRecord(request, active?.phase || phaseOf(), active?.startedAt || Date.now(), error)
    try {
      const response = await request.response()
      if (response) {
        record.status = response.status()
        const headers = response.headers()
        const length = Number(headers['content-length'])
        if (Number.isFinite(length) && length >= 0) record.bytes = length
        else {
          try {
            const body = await response.body()
            record.bytes = body.byteLength
          } catch {
            record.bytes = 0
          }
        }
      }
    } catch {
      // The response may already be disposed; keep the request anyway.
    }
    records.push(record)
  }

  const onFinished = (request: Request) => {
    void finish(request)
  }
  const onFailed = (request: Request) => {
    void finish(request, request.failure()?.errorText || 'requestfailed')
  }

  page.on('request', onRequest)
  page.on('requestfinished', onFinished)
  page.on('requestfailed', onFailed)
  return () => {
    page.off('request', onRequest)
    page.off('requestfinished', onFinished)
    page.off('requestfailed', onFailed)
  }
}

async function runStep(page: Page, step: LoadTestStep, timeoutMs: number): Promise<void> {
  if (step.type === 'click') {
    const target = parseClickTarget(step)
    const locator = target.kind === 'css'
      ? page.locator(target.value).first()
      : page.getByText(target.value, { exact: false }).first()
    await locator.click({ timeout: timeoutMs })
    return
  }
  if (step.type === 'fill') {
    await page.locator(step.selector).first().fill(step.value, { timeout: timeoutMs })
    return
  }
  if (step.type === 'scroll') {
    await page.mouse.wheel(step.x || 0, step.y || 800)
    return
  }
  if (step.type === 'wait') {
    await new Promise((resolve) => setTimeout(resolve, step.ms))
    return
  }
  await page.keyboard.press(step.key)
}

async function waitForQuietNetwork(page: Page, timeoutMs: number): Promise<void> {
  try {
    await page.waitForLoadState('networkidle', { timeout: timeoutMs })
  } catch {
    // The page may keep long-polling; capture whatever arrived.
  }
}

async function runVirtualUser(
  browser: Browser,
  command: StartLoadTestCommand,
  userIndex: number,
  signal: AbortSignal,
): Promise<VirtualUserResult> {
  const startedAt = new Date()
  const requests: NetworkRequestRecord[] = []
  let phase: LoadTestPhase = 'initial-load'
  let context: BrowserContext | undefined
  let page: Page | undefined
  let detach: (() => void) | undefined
  try {
    if (signal.aborted) throw new Error('cancelled')
    context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 720 } })
    page = await context.newPage()
    page.setDefaultTimeout(command.navigationTimeoutMs)
    detach = await attachNetwork(page, () => phase, requests)
    await page.goto(command.targetUrl, {
      waitUntil: 'domcontentloaded',
      timeout: command.navigationTimeoutMs,
    })
    await waitForQuietNetwork(page, Math.min(command.navigationTimeoutMs, 15_000))
    for (const step of command.scenario.steps) {
      if (signal.aborted) throw new Error('cancelled')
      await runStep(page, step, command.navigationTimeoutMs)
      phase = 'after-click'
      await waitForQuietNetwork(page, command.afterClickTimeoutMs)
    }
    const finishedAt = new Date()
    return summarizeUser(userIndex, 'passed', startedAt, finishedAt, requests)
  } catch (error) {
    const finishedAt = new Date()
    const message = signal.aborted ? 'cancelled' : (error instanceof Error ? error.message : String(error))
    return summarizeUser(
      userIndex,
      signal.aborted ? 'cancelled' : 'failed',
      startedAt,
      finishedAt,
      requests,
      message,
      phase,
    )
  } finally {
    detach?.()
    await page?.close().catch(() => undefined)
    await context?.close().catch(() => undefined)
  }
}

function summarizeUser(
  userIndex: number,
  status: VirtualUserResult['status'],
  startedAt: Date,
  finishedAt: Date,
  requests: NetworkRequestRecord[],
  failureReason?: string,
  failedPhase?: LoadTestPhase,
): VirtualUserResult {
  return {
    userIndex,
    status,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
    failureReason,
    failedPhase,
    requestCount: requests.length,
    errorCount: requests.filter((request) => {
      const statusCode = request.status || 0
      return Boolean(request.error) || statusCode >= 400
    }).length,
    bytes: requests.reduce((sum, request) => sum + (request.bytes || 0), 0),
    requests,
  }
}

export function buildTimeline(users: VirtualUserResult[], originMs: number): TimelineBucket[] {
  const buckets = new Map<number, { requests: number; errors: number; totalMs: number }>()
  for (const user of users) {
    for (const request of user.requests) {
      const started = Date.parse(request.startedAt)
      if (!Number.isFinite(started)) continue
      const t = Math.max(0, Math.floor((started - originMs) / 1_000))
      const bucket = buckets.get(t) || { requests: 0, errors: 0, totalMs: 0 }
      bucket.requests += 1
      bucket.totalMs += request.durationMs
      const status = request.status || 0
      if (request.error || status >= 400) bucket.errors += 1
      buckets.set(t, bucket)
    }
  }
  return [...buckets.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([t, bucket]) => ({
      t,
      requests: bucket.requests,
      errors: bucket.errors,
      avgMs: bucket.requests ? Math.round(bucket.totalMs / bucket.requests) : 0,
    }))
}

export async function runLoadTest(
  command: StartLoadTestCommand,
  options: {
    signal: AbortSignal
    onProgress: (progress: LoadTestProgress, batch: VirtualUserResult[]) => Promise<void>
  },
): Promise<LoadTestRunResult> {
  const { chromium } = await import('playwright')
  const browser = await chromium.launch({ headless: true })
  const indexes = Array.from({ length: command.virtualUsers }, (_, index) => index + 1)
  const users: VirtualUserResult[] = []
  let completed = 0
  let failed = 0
  let running = 0

  const report = async (message: string, batch: VirtualUserResult[] = []) => {
    await options.onProgress({
      completed,
      running,
      pending: Math.max(0, command.virtualUsers - completed - running),
      failed,
      message,
    }, batch)
  }

  try {
    await report('Arrancando Chromium...')
    await mapPool(indexes, command.concurrency, async (userIndex) => {
      if (options.signal.aborted) return
      running += 1
      await report(`Ejecutando VU-${String(userIndex).padStart(3, '0')}`)
      const result = await runVirtualUser(browser, command, userIndex, options.signal)
      running -= 1
      completed += 1
      if (result.status !== 'passed') failed += 1
      users.push(result)
      await report(
        result.status === 'passed'
          ? `VU-${String(userIndex).padStart(3, '0')} listo`
          : `VU-${String(userIndex).padStart(3, '0')} falló`,
        [result],
      )
    }, () => options.signal.aborted)

    const cancelled = options.signal.aborted
    const origin = users.reduce((min, user) => Math.min(min, Date.parse(user.startedAt) || min), Date.now())
    return {
      status: cancelled ? 'cancelled' : 'completed',
      users,
      timeline: buildTimeline(users, origin),
      failureReason: cancelled ? 'Cancelado' : undefined,
    }
  } catch (error) {
    return {
      status: 'failed',
      failureReason: error instanceof Error ? error.message : String(error),
      users,
      timeline: buildTimeline(users, Date.now()),
    }
  } finally {
    await browser.close().catch(() => undefined)
  }
}

export type { LoadTestScenario }
