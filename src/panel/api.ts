/** The plugin id, which is also the path segment of its routes. */
export const PLUGIN_ID = 'signalk-alert-rules'

const PLUGIN_BASE = `/plugins/${PLUGIN_ID}`

/**
 * A request that hangs, as on a tablet that lost its Wi-Fi, would otherwise
 * hold up polling and show stale data as current.
 */
export const REQUEST_TIMEOUT_MS = 10_000

/** `GET /state`, as docs/api.md describes it. */
export interface PluginState {
  running: boolean
  error?: string
  securityEnabled: boolean | null
}

/** The part of a rule entry the panel reads so far. */
export interface RuleSummary {
  origin: string
  slug: string
}

/** What the panel asks of the server; tests substitute their own. */
export interface PanelApi {
  state(): Promise<PluginState>
  /**
   * Whether the plugin is enabled in the server's plugin settings. The
   * server answers this on the plugin's own route root, whether or not the
   * plugin is running (signalk-server src/interfaces/plugins.ts, the
   * router's `GET /`).
   */
  pluginEnabled(): Promise<boolean>
  rules(): Promise<RuleSummary[]>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function malformed(what: string): Error {
  return new Error(`unexpected response from ${what}`)
}

export function parseState(body: unknown): PluginState {
  if (!isRecord(body) || typeof body.running !== 'boolean') throw malformed('/state')
  const { running, error, securityEnabled } = body
  return {
    running,
    ...(typeof error === 'string' ? { error } : {}),
    securityEnabled: typeof securityEnabled === 'boolean' ? securityEnabled : null
  }
}

/**
 * The server answers `enabledByDefault || options.enabled`, which is undefined
 * for a plugin that was never configured, so JSON leaves the flag out.
 */
function parseEnabled(body: unknown): boolean {
  if (!isRecord(body)) throw malformed('the plugin route')
  if (body.enabled === undefined) return false
  if (typeof body.enabled !== 'boolean') throw malformed('the plugin route')
  return body.enabled
}

function parseRules(body: unknown): RuleSummary[] {
  if (!Array.isArray(body)) throw malformed('/rules')
  return body.map((entry) => {
    if (!isRecord(entry) || typeof entry.origin !== 'string' || typeof entry.slug !== 'string') {
      throw malformed('/rules')
    }
    return { origin: entry.origin, slug: entry.slug }
  })
}

/** The API over HTTP, relative to the admin UI's origin. */
export function httpApi(fetchFn: typeof fetch = (input, init) => fetch(input, init)): PanelApi {
  const getJson = async (path: string): Promise<unknown> => {
    const res = await fetchFn(path, {
      credentials: 'same-origin',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    })
    if (!res.ok) throw new Error(`${path} answered ${String(res.status)}`)
    return res.json()
  }
  return {
    state: async () => parseState(await getJson(`${PLUGIN_BASE}/state`)),
    pluginEnabled: async () => parseEnabled(await getJson(`${PLUGIN_BASE}/`)),
    rules: async () => parseRules(await getJson(`${PLUGIN_BASE}/rules`))
  }
}
