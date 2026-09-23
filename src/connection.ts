export const REQUEST_TIMEOUT_MS = 20_000

const NETWORK_HINTS: Record<string, string> = {
  ENOTFOUND: 'no se pudo resolver el nombre del servidor',
  EAI_AGAIN: 'el DNS no respondió',
  ECONNREFUSED: 'el servidor rechazó la conexión',
  ECONNRESET: 'el servidor cortó la conexión',
  ETIMEDOUT: 'la conexión tardó demasiado',
  ENETUNREACH: 'no hay ruta de red hasta Dockploy',
  EHOSTUNREACH: 'el servidor no es alcanzable',
  CERT_HAS_EXPIRED: 'el certificado HTTPS ha caducado',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'el certificado HTTPS no es de confianza',
  DEPTH_ZERO_SELF_SIGNED_CERT: 'el certificado HTTPS es autofirmado',
  ERR_TLS_CERT_ALTNAME_INVALID: 'el certificado HTTPS no corresponde a ese dominio',
}

function causeOf(error: Error): unknown {
  return (error as { cause?: unknown }).cause
}

function errorCode(error: unknown): string {
  if (!error || typeof error !== 'object' || !('code' in error)) return ''
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : ''
}

/** Texto estable para el registro: distingue timeout, red, DNS y TLS. */
export function describeRequestFailure(error: unknown, endpoint: string): string {
  if (!(error instanceof Error)) {
    return `No se pudo contactar con Dockploy (${endpoint})`
  }
  if (error.name === 'TimeoutError' || error.name === 'AbortError') {
    return `Dockploy no respondió a ${endpoint} en ${REQUEST_TIMEOUT_MS / 1000} s`
  }

  const cause = causeOf(error)
  const code = errorCode(cause) || errorCode(error)
  const causeMessage = cause instanceof Error ? cause.message : ''
  const hint = NETWORK_HINTS[code]
  const detail = hint || causeMessage || error.message
  if (code && hint) return `No se pudo contactar con Dockploy (${endpoint}): ${hint} [${code}]`
  if (code) return `No se pudo contactar con Dockploy (${endpoint}): ${detail} [${code}]`
  return `No se pudo contactar con Dockploy (${endpoint}): ${detail}`
}

export function httpFailureMessage(status: number, endpoint: string, serverMessage?: string): string {
  if (status === 429) return `Dockploy está limitando las peticiones de este equipo (429) en ${endpoint}`
  if (status === 401) return serverMessage || 'Invalid connector token'
  if (serverMessage) return `Dockploy respondió ${status} en ${endpoint}: ${serverMessage}`
  return `Dockploy respondió ${status} en ${endpoint}`
}
