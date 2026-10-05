import { afterEach, describe, expect, it, vi } from 'vitest'
import { fakeApi, fakeHistory, fakePaths, SWITCH_AFTER_MS } from '../../harness/fakeServer'
import { OPTIONS, scenarioOf } from '../../harness/scenario'
import { alertPathOverlap } from '../../src/application'
import {
  isInvalid,
  isSlugTaken,
  LevelRefusedError,
  parseState,
  parseTemplates,
  RuleRejectedError,
  SessionExpiredError,
  type PanelApi,
  type RuleEntry
} from '../../src/panel/api'
import { withRefusals } from '../../src/panel/refusal'

/**
 * The render harness's fake server against the panel: a renamed example, a
 * template set that stops validating or a parser change would otherwise
 * leave a blank harness page that only the next UI review finds.
 */

type Outcome = 'resolves' | 'pending' | 'rejects' | 'sessionExpired'

/** Each read the views make on load, with the scenario values meant not to answer it. */
const READS = ['state', 'rules', 'templates', 'definition', 'paths', 'history'] as const
type Read = (typeof READS)[number]

/** What a scenario value does to a read other than answer it; every other read resolves. */
const INTENDED: Record<string, Partial<Record<Read, Outcome>>> = {
  'plugin=loading': { state: 'pending' },
  'plugin=unreachable': { state: 'rejects' },
  'plugin=session': { state: 'sessionExpired' },
  'rules=empty': { definition: 'rejects' },
  'paths=loading': { paths: 'pending' },
  'paths=error': { paths: 'rejects' },
  'history=loading': { history: 'pending' },
  'history=error': { history: 'rejects' },
  'definition=loading': { definition: 'pending' },
  'definition=error': { definition: 'rejects' },
  'templates=loading': { templates: 'pending' },
  'templates=error': { templates: 'rejects' }
}

const HOUSE = 'house-battery-low'

const json = (value: unknown): unknown => JSON.parse(JSON.stringify(value))

function fakes(search = '') {
  const scenario = scenarioOf(search)
  return { api: fakeApi(scenario), paths: fakePaths(scenario), history: fakeHistory(scenario) }
}

/** The read's outcome, with what it answered passed through the panel's parser where it has one. */
async function outcome(read: Promise<unknown>, parse: (v: unknown) => unknown = (v) => v) {
  const later = new Promise<Outcome>((resolve) =>
    setTimeout(() => {
      resolve('pending')
    }, 10)
  )
  const settled = read.then(
    (v): Outcome => {
      parse(json(v))
      return 'resolves'
    },
    (err: unknown): Outcome => (err instanceof SessionExpiredError ? 'sessionExpired' : 'rejects')
  )
  return Promise.race([settled, later])
}

async function outcomes(search: string): Promise<Record<Read, Outcome>> {
  const { api, paths, history } = fakes(search)
  const query = { path: 'electrical.batteries.house.voltage', methods: ['average'] as const }
  return {
    state: await outcome(api.state(), parseState),
    rules: await outcome(api.rules()),
    templates: await outcome(api.templates(), (v) => parseTemplates(v, '/templates')),
    definition: await outcome(api.ruleDefinition(HOUSE)),
    paths: await outcome(paths.selfPaths()),
    history: await outcome(history.values({ ...query, seconds: 3600, resolution: 60 }))
  }
}

async function rejection(write: Promise<unknown>): Promise<unknown> {
  return write.then(
    () => {
      throw new Error('the write was not refused')
    },
    (err: unknown) => err
  )
}

/** A stored worked example, as the editor sends it back. */
async function stored(api: PanelApi, slug: string) {
  return { ...(await api.ruleDefinition(slug)) }
}

describe('render harness', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  const cases = Object.entries(OPTIONS).flatMap(([key, values]) =>
    values.map((value) => `${key}=${value}`)
  )

  it.each(cases)('answers the views as intended for %s', async (param) => {
    const intended = INTENDED[param] ?? {}
    const expected = Object.fromEntries(READS.map((r) => [r, intended[r] ?? 'resolves']))
    expect(await outcomes(`?${param}`)).toEqual(expected)
  })

  it('serves rules, templates and paths by default', async () => {
    const { api, paths } = fakes()
    expect((await api.rules()).length).toBeGreaterThan(0)
    expect((await api.templates()).sets.length).toBeGreaterThan(0)
    expect((await paths.selfPaths()).length).toBeGreaterThan(0)
  })

  it.each([
    ['mixed', 'alerting', 51.3],
    ['docs', 'normal', 50.4]
  ] as const)('shows shore power frequency with states=%s %s', async (set, condition, value) => {
    const { api } = fakes(`?states=${set}`)
    const entry = (await api.rules()).find((r) => r.slug === 'shore-power-frequency')
    expect(entry?.status).toMatchObject({ condition, value, instances: [{ condition, value }] })
  })

  it('lists the examples as docs/examples.md shows them with states=docs', async () => {
    const { api } = fakes('?states=docs')
    const rules = await api.rules()
    const alerting = rules.filter((r) => r.status.condition !== 'normal').map((r) => r.slug)
    expect(alerting).toEqual(['bilge-pump-cycling'])
    expect(rules.filter((r) => 'disabled' in r && r.disabled !== undefined)).toEqual([])
  })

  it('gives states=docs states that agree with each rule and its path', async () => {
    const { api, paths } = fakes('?states=docs')
    const reported = new Map((await paths.selfPaths()).map((p) => [p.path, p.value]))
    let compared = 0
    for (const entry of await api.rules()) {
      if (isInvalid(entry)) continue
      const { rule, status } = entry
      const path = rule.signal.combinator === undefined ? rule.signal.paths.at(0) : undefined
      if (path !== undefined && !path.includes('*') && status.value !== undefined) {
        expect(status.value, entry.slug).toEqual(reported.get(path))
        compared++
      }
      for (const instance of status.instances) {
        const progress = instance.progress
        if (progress?.kind === 'events') {
          expect(progress.limit, entry.slug).toBe(rule.steps[0]?.limit)
          // A count rule alerts on more events than its limit, and only then.
          expect(progress.count > progress.limit, entry.slug).toBe(
            instance.condition === 'alerting'
          )
        }
        if (path === undefined || instance.value === undefined) continue
        const segment = instance.instance?.segment
        const own = segment === undefined ? path : path.replace('*', segment)
        if (reported.get(own) !== undefined) {
          expect(instance.value, `${entry.slug} ${own}`).toEqual(reported.get(own))
          compared++
        }
      }
    }
    expect(compared).toBeGreaterThan(0)
  })

  it('gives every path with a value a source', async () => {
    const { paths } = fakes()
    for (const entry of await paths.selfPaths()) {
      if (entry.value === undefined) continue
      expect(entry.sources, entry.path).not.toEqual(undefined)
      expect(entry.sources).toContain(entry.preferredSource ?? entry.sources?.[0])
    }
  })

  it.each([
    ['unreachable', 'rejects'],
    ['session', 'sessionExpired'],
    ['notRunning', 'resolves']
  ] as const)('answers after=%s once the first reads are done', async (after, expected) => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const { api } = fakes(`?after=${after}`)
    expect((await api.state()).running).toBe(true)
    vi.setSystemTime(Date.now() + SWITCH_AFTER_MS)
    expect(await outcome(api.state(), parseState)).toBe(expected)
    if (after === 'notRunning') expect((await api.state()).running).toBe(false)
  })

  it('refuses a create whose slug a stored rule has', async () => {
    const { api } = fakes()
    const err = await rejection(api.createRule(await stored(api, HOUSE)))
    expect(isSlugTaken(err)).toBe(true)
  })

  it("refuses a create whose alert path overlaps another rule's", async () => {
    const { api } = fakes()
    const rule = { ...(await stored(api, HOUSE)), slug: 'house-battery-low-again' }
    const err = await rejection(api.createRule(rule))
    expect(err).toBeInstanceOf(RuleRejectedError)
    expect(err).toMatchObject({ errors: [alertPathOverlap(HOUSE)] })
    expect((await api.rules()).map((r) => r.slug)).not.toContain(rule.slug)
  })

  it('refuses an edit that changes the slug and keeps the rule', async () => {
    const { api } = fakes()
    const rule = { ...(await stored(api, HOUSE)), slug: 'house-battery' }
    const err = await rejection(api.updateRule(HOUSE, rule))
    expect(err).toBeInstanceOf(RuleRejectedError)
    expect(err).toMatchObject({ errors: [{ path: '/slug' }] })
    expect((await api.rules()).map((r) => r.slug)).toContain(HOUSE)
  })

  it('keeps the rule when a save fails', async () => {
    const { api } = fakes('?save=error')
    const rule = await stored(api, HOUSE)
    await rejection(api.updateRule(HOUSE, rule))
    expect((await api.rules()).map((r) => r.slug)).toContain(HOUSE)
  })

  it('starts a fixed invalid rule fresh, like a new one', async () => {
    const { api } = fakes('?rules=partial')
    const invalid = (await api.rules()).find(isInvalid)
    if (invalid === undefined) throw new Error('rules=partial has no invalid rule')
    const rule = { ...(await stored(api, HOUSE)), slug: invalid.slug }
    rule.signal = { path: 'electrical.batteries.start.voltage' }
    const entry: RuleEntry = await api.updateRule(invalid.slug, rule)
    expect(entry.status).toMatchObject({ condition: 'noData', reason: 'neverReported' })
  })

  // States the editor cannot produce: only a stored rule reaches them.
  it.each([
    ['fixedLimit', 'house-battery-fixed-limit', '/detector/limit'],
    ['angularRatio', 'engine-rpm-ratio-angular', '/signal/angular'],
    ['eventValue', 'bilge-pump-changes-value', '/detector/event/value'],
    ['zoneSteps', 'house-battery-zone-steps', '/detector/steps']
  ])('stores beside the examples an invalid rule for rules=%s', async (value, slug, under) => {
    const rules = await fakes(`?rules=${value}`).api.rules()
    expect(rules.map((r) => r.slug)).toContain(HOUSE)
    const invalid = rules.filter(isInvalid)
    expect(invalid.map((r) => r.slug)).toEqual([slug])
    const paths = invalid[0]?.invalid.errors.map((e) => e.path) ?? []
    expect(paths.length).toBeGreaterThan(0)
    expect(paths.filter((p) => p !== under && !p.startsWith(`${under}/`))).toEqual([])
  })

  it.each([
    ['save', async (api: PanelApi) => api.updateRule(HOUSE, await stored(api, HOUSE))],
    ['controls', (api: PanelApi) => api.disableRule(HOUSE, '')]
  ] as const)('refuses a write for its level with %s=refused', async (param, write) => {
    const { api } = fakes(`?${param}=refused`)
    const refused = vi.fn()
    const err = await rejection(write(withRefusals(api, refused)))
    expect(err).toBeInstanceOf(LevelRefusedError)
    expect(refused).toHaveBeenCalledOnce()
  })
})
