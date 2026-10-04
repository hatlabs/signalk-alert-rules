/**
 * What the fake server answers, chosen by the page's query parameters. Each
 * parameter's first value is its default; AGENTS.md "Rendering the UI" maps
 * them to the views' states.
 */
export const OPTIONS = {
  /** `/state`: running, never answering, failed to start, stopped, out of reach, or logged out. */
  plugin: ['ready', 'loading', 'failed', 'notRunning', 'unreachable', 'session'],
  /**
   * `/state` once `SWITCH_AFTER_MS` (fakeServer.ts) has passed since load,
   * after the views have read the rules: as `plugin` says, out of reach,
   * logged out, or stopped. The views show it at their next poll.
   */
  after: ['ready', 'unreachable', 'session', 'notRunning'],
  /** `/rules`: the worked examples, none, or the examples with a stored rule that does not run and a file that could not be read. */
  rules: ['examples', 'empty', 'partial'],
  /** The rules' states: a mix of conditions, or the ones docs/examples.md shows where they differ. */
  states: ['mixed', 'docs'],
  access: ['admin', 'readwrite', 'readonly'],
  security: ['on', 'off'],
  /** The server's paths: the test fixtures' paths, none, never answering, or failing. */
  paths: ['ready', 'empty', 'loading', 'error'],
  /** The history provider: a day of data, data with a gap, nothing recorded, never answering, failing, or no provider. */
  history: ['data', 'gaps', 'empty', 'loading', 'error', 'none'],
  /** The stored rule an existing rule's editor reads. */
  definition: ['ready', 'loading', 'error'],
  /**
   * Saving a rule: stored unless the server would refuse it, refused with a
   * field error on the name, failing, or refused for the login's level (401).
   */
  save: ['ok', 'rejected', 'error', 'refused'],
  /** Disable, enable, reset and delete: done, or refused for the login's level (401). */
  controls: ['ok', 'refused'],
  /** What an edit would do: nothing, or restart the rule and clear its alert. */
  preview: ['none', 'restart'],
  /** `/templates`: the built-in and example sets, the same with every template new, none, never answering, or failing. */
  templates: ['ready', 'new', 'none', 'loading', 'error']
} as const

type Options = typeof OPTIONS

export type Scenario = { [K in keyof Options]: Options[K][number] }

function choice<K extends keyof Options>(params: URLSearchParams, key: K): Options[K][number] {
  const values: readonly string[] = OPTIONS[key]
  const value = params.get(key)
  const index = value === null ? 0 : values.indexOf(value)
  if (index < 0) {
    console.warn(`harness: ${key}=${String(value)} is not one of ${values.join(', ')}`)
    return OPTIONS[key][0]
  }
  return OPTIONS[key][index]
}

export function scenarioOf(search: string): Scenario {
  const params = new URLSearchParams(search)
  return {
    plugin: choice(params, 'plugin'),
    after: choice(params, 'after'),
    rules: choice(params, 'rules'),
    states: choice(params, 'states'),
    access: choice(params, 'access'),
    security: choice(params, 'security'),
    paths: choice(params, 'paths'),
    history: choice(params, 'history'),
    definition: choice(params, 'definition'),
    save: choice(params, 'save'),
    controls: choice(params, 'controls'),
    preview: choice(params, 'preview'),
    templates: choice(params, 'templates')
  }
}
