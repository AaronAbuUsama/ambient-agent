/**
 * `apiFetch` — the token-authenticated fetch client for the control plane (#372).
 *
 * Every console screen (#377–#382) reaches the runtime through this function and nothing else.
 * It is the single place three things happen:
 *
 * - the bearer token minted by #364 is attached to the request;
 * - a `401` clears the stored token and announces it, so the shell returns to its sign-in state
 *   instead of leaving a screen to render an error it cannot fix;
 * - the JSON body is parsed.
 *
 * The token lives in `localStorage` because the shell itself is served unauthenticated (see
 * `apps/cli/src/control-plane.ts`) — the operator pastes the token the CLI printed, once.
 */

const TOKEN_KEY = "ambient-agent.control-plane-token"

/** Fired whenever the stored token appears or disappears. The shell re-reads it and re-renders. */
export const AUTH_CHANGED_EVENT = "ambient-agent:auth-changed"

const announce = (): void => {
  window.dispatchEvent(new Event(AUTH_CHANGED_EVENT))
}

export const controlPlaneToken = (): string | null =>
  localStorage.getItem(TOKEN_KEY)

export const rememberControlPlaneToken = (token: string): void => {
  localStorage.setItem(TOKEN_KEY, token)
  announce()
}

export const forgetControlPlaneToken = (): void => {
  localStorage.removeItem(TOKEN_KEY)
  announce()
}

/** Thrown when the control plane refused the token. The stored token is already cleared. */
export class UnauthorizedError extends Error {
  constructor() {
    super("The control plane rejected the bearer token.")
    this.name = "UnauthorizedError"
  }
}

/**
 * `new Headers` rather than a spread: `init.headers` may be a `Headers` or an array of pairs, and
 * spreading either of those silently drops every header a caller set.
 */
const authorized = (token: string, init: RequestInit): RequestInit => {
  const headers = new Headers(init.headers)
  headers.set("authorization", `Bearer ${token}`)
  return { ...init, headers }
}

/**
 * A `GET /api/...` (or any method via `init`) against the control plane, carrying the token.
 *
 * @throws {UnauthorizedError} when no token is stored, or the stored one was refused.
 */
export async function apiFetch<T>(
  path: string,
  init: RequestInit = {}
): Promise<T> {
  const token = controlPlaneToken()
  if (token === null) throw new UnauthorizedError()
  const response = await fetch(path, authorized(token, init))
  if (response.status === 401) {
    forgetControlPlaneToken()
    throw new UnauthorizedError()
  }
  if (!response.ok)
    throw new Error(
      `${init.method ?? "GET"} ${path} failed: ${response.status}`
    )
  return (await response.json()) as T
}

/**
 * Does this token open the control plane? Used by the sign-in screen, which has no stored token
 * to send yet and must not store one that does not work.
 */
export const verifyControlPlaneToken = async (
  token: string
): Promise<boolean> => (await fetch("/api/status", authorized(token, {}))).ok
