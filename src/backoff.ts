export const HEARTBEAT_MS = 5_000
export const MAX_BACKOFF_MS = 60_000

interface DelayInput {
  failures: number
  retryAfterSeconds?: number
  random?: () => number
}

// Tras un fallo el agente espera cada vez más. Reintentar cada cinco segundos
// contra un servidor que responde 429 mantiene el bloqueo indefinidamente.
export function nextDelayMs({ failures, retryAfterSeconds, random = Math.random }: DelayInput): number {
  if (failures <= 0) return HEARTBEAT_MS

  const base = retryAfterSeconds && retryAfterSeconds > 0
    ? retryAfterSeconds * 1_000
    : HEARTBEAT_MS * 2 ** (failures - 1)
  const capped = Math.min(Math.max(base, HEARTBEAT_MS), MAX_BACKOFF_MS)

  // Reparte en el tiempo a los agentes que se recuperan a la vez.
  const jitter = 0.8 + random() * 0.4
  return Math.round(capped * jitter)
}

// Un fallo persistente no debe repetir la misma línea cada pocos segundos.
export function shouldLogFailure(failures: number): boolean {
  if (failures <= 3) return true
  return failures % 10 === 0
}
