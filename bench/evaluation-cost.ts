/**
 * Evaluation cost at the resource bounds: 500 rules, 64 instances per
 * wildcard rule, windowed detectors filled to their decimation cap. Drives the
 * real RuleRunner and RuleEvaluators on a simulated clock and times each
 * evaluation cycle (one runner tick) and each delta delivered to a rule.
 *
 * Usage: ./run bench [scenario ...]   (scenarios: mixed, wildcard; default both)
 */
import type {
  Delta,
  Path,
  SourceRef,
  SubscribeCallback,
  SubscribeMessage,
  SubscriptionManager,
  Timestamp,
  Unsubscribes,
  Value
} from '@signalk/server-api'
import { RuleRunner, type LoadedRule } from '../src/alerts/runner.js'
import { ruleId } from '../src/alerts/paths.js'
import { MAX_WINDOW_SAMPLES } from '../src/engine/detectors/trend.js'
import type { PathMeta } from '../src/engine/evaluator.js'
import { MAX_INSTANCES, MAX_RULES } from '../src/model/rule.js'
import { validateRule, validateRuleSet } from '../src/model/validate.js'

const ORIGIN = 'user'
/** Assumed evaluation cycle; the plugin's tick cadence is not fixed yet. */
const TICK_S = 1
/** Simulation step: the fastest input rate is 10 Hz. */
const STEP_S = 0.1
/**
 * Trend windows. Decimation keeps about MAX_WINDOW_SAMPLES points per window
 * at 1 Hz and at 5-10 Hz, but up to twice that when the input interval falls
 * between half the decimation spacing and the spacing, as 2 Hz input does
 * here; the mix therefore includes the most points a window can hold.
 */
const TREND_WINDOW_S = 250
const WARMUP_S = TREND_WINDOW_S + 30
const MEASURE_S = 120

/** A path's value as a function of simulated time. */
type Waveform = (t: number) => Value

interface Feed {
  path: string
  rateHz: number
  value: Waveform
}

interface Scenario {
  name: string
  describe: string
  ratesHz: readonly number[]
  rules: unknown[]
  feeds: Feed[]
  meta: Map<string, PathMeta>
}

// ---------------------------------------------------------------------------
// Subscriptions

interface Subscription {
  matches: (path: string) => boolean
  callback: SubscribeCallback
}

/**
 * Delivers deltas to the plugin's subscriptions with the matching resolved
 * once per path, so the timings are the engine's and not a test double's
 * linear scan over every subscription and cached value.
 */
class IndexedSubscriptions implements SubscriptionManager {
  private readonly subscriptions: Subscription[] = []
  private readonly byPath = new Map<string, Subscription[]>()

  subscribe(
    command: SubscribeMessage,
    unsubscribes: Unsubscribes,
    _errorCallback: (err: unknown) => void,
    callback: SubscribeCallback
  ): void {
    for (const row of command.subscribe) {
      const pattern = row.path ?? '*'
      const regex = new RegExp('^' + pattern.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$')
      const sub: Subscription = { matches: (p) => regex.test(p), callback }
      this.subscriptions.push(sub)
      this.byPath.clear()
      unsubscribes.push(() => {
        this.subscriptions.splice(this.subscriptions.indexOf(sub), 1)
        this.byPath.clear()
      })
    }
  }

  unsubscribe(): void {
    throw new Error('not used by the plugin')
  }

  /** Resolves a path's subscribers ahead of timing, as the server's bus would have them. */
  prepare(path: string): Subscription[] {
    let subs = this.byPath.get(path)
    if (subs === undefined) {
      subs = this.subscriptions.filter((s) => s.matches(path))
      this.byPath.set(path, subs)
    }
    return subs
  }

  publish(path: string, value: Value): void {
    const delta: Delta = {
      context: 'vessels.urn:mrn:signalk:uuid:bench' as Delta['context'],
      updates: [
        {
          $source: 'bench.1' as SourceRef,
          timestamp: '2026-01-01T00:00:00.000Z' as Timestamp,
          values: [{ path: path as Path, value }]
        }
      ]
    }
    for (const sub of this.prepare(path)) sub.callback(delta)
  }
}

// ---------------------------------------------------------------------------
// Rule mix

/** Deterministic pseudo-random numbers, so every run feeds the same data. */
function prng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

const wave =
  (base: number, amp: number, period: number, phase: number): Waveform =>
  (t) =>
    base + amp * Math.sin((2 * Math.PI * t) / period + phase)

const toggle =
  (period: number, phase: number): Waveform =>
  (t) =>
    Math.floor(t / period + phase) % 2 === 0

const STATES = ['idle', 'running', 'fault', 'running'] as const
const states =
  (period: number, phase: number): Waveform =>
  (t) =>
    STATES[Math.floor(t / period + phase) % STATES.length]

const counter =
  (period: number): Waveform =>
  (t) =>
    Math.floor(t / period)

const position =
  (jitter: number, period: number, phase: number): Waveform =>
  (t) => ({
    latitude: 60.1 + jitter * Math.sin((2 * Math.PI * t) / period + phase),
    longitude: 24.9 + jitter * Math.cos((2 * Math.PI * t) / period + phase)
  })

/** 0..100 with warn above 80, alarm above 90, emergency above 95. */
const ZONES: PathMeta = {
  zones: [
    { lower: 80, upper: 90, state: 'warn' },
    { lower: 90, upper: 95, state: 'alarm' },
    { lower: 95, upper: 100, state: 'emergency' }
  ]
}

const ENGINE_RPM = 'bench.engine.revolutions'

/** What each detector kind needs: its detector, and the waveform its input carries. */
type Kind =
  | 'sustained'
  | 'zone'
  | 'slope'
  | 'projection'
  | 'accumulator'
  | 'count'
  | 'absence'
  | 'match'
  | 'timedOut'

function detectorFor(kind: Kind, i: number): unknown {
  switch (kind) {
    case 'sustained':
      return {
        type: 'sustained',
        direction: 'above',
        limit: { kind: 'fixed', value: 85 },
        duration: 5 + (i % 30),
        hysteresis: 2,
        clearDuration: 10
      }
    case 'zone':
      return {
        type: 'sustained',
        direction: 'above',
        limit: { kind: 'zone', level: 'warn' },
        duration: 10,
        hysteresis: 1,
        clearDuration: 10
      }
    case 'slope':
      return { type: 'slope', direction: 'rising', window: TREND_WINDOW_S, limit: 0.15 }
    case 'projection':
      return {
        type: 'projection',
        direction: 'rising',
        limit: { kind: 'fixed', value: 95 },
        window: TREND_WINDOW_S,
        horizon: 600
      }
    case 'accumulator':
      return i % 2 === 0
        ? { type: 'accumulator', measure: 'time', while: { op: 'above', value: 50 }, limit: 3600 }
        : { type: 'accumulator', measure: 'integral', limit: 1e7 }
    case 'count':
      return {
        type: 'count',
        event: { op: 'changesTo', value: true },
        window: TREND_WINDOW_S,
        limit: 4
      }
    case 'absence':
      return { type: 'absence', event: { op: 'changes' }, within: 20 + (i % 40) }
    case 'match':
      return i % 2 === 0
        ? { type: 'match', op: 'equals', value: 'fault', duration: 5 }
        : { type: 'match', op: 'changesTo', value: 'fault' }
    case 'timedOut':
      return { type: 'match', op: 'timedOut', duration: 30 }
  }
}

function waveformFor(kind: Kind, rnd: () => number): Waveform {
  const period = 60 + rnd() * 540
  const phase = rnd() * 2 * Math.PI
  switch (kind) {
    case 'count':
      return toggle(20 + rnd() * 60, rnd())
    case 'absence':
      return counter(10 + rnd() * 60)
    case 'match':
      return states(15 + rnd() * 30, rnd())
    default:
      return wave(50, 48, period, phase)
  }
}

interface MixEntry {
  kind: Kind
  count: number
}

// Scalar (non-wildcard) rules of the mixed scenario, by detector.
const SCALAR_MIX: MixEntry[] = [
  { kind: 'sustained', count: 80 },
  { kind: 'zone', count: 40 },
  { kind: 'slope', count: 60 },
  { kind: 'projection', count: 50 },
  { kind: 'accumulator', count: 40 },
  { kind: 'count', count: 50 },
  { kind: 'absence', count: 40 },
  { kind: 'match', count: 40 },
  { kind: 'timedOut', count: 20 }
]
const COMBINATOR_RULES = 40

// Wildcard rules of the mixed scenario, by detector; each has 64 instances.
const WILDCARD_MIX: MixEntry[] = [
  { kind: 'sustained', count: 6 },
  { kind: 'zone', count: 4 },
  { kind: 'slope', count: 8 },
  { kind: 'projection', count: 6 },
  { kind: 'accumulator', count: 4 },
  { kind: 'count', count: 5 },
  { kind: 'absence', count: 4 },
  { kind: 'match', count: 3 }
]

// Every rule not otherwise gated in this share is gated on the shared engine RPM.
const SHARED_GATE_EVERY = 4
// Of the wildcard rules, this share is gated per instance by a wildcard gate.
const INSTANCE_GATE_EVERY = 3

class Builder {
  readonly rules: unknown[] = []
  readonly feeds: Feed[] = []
  readonly meta = new Map<string, PathMeta>()
  private readonly rnd = prng(1)
  private n = 0

  constructor(readonly ratesHz: readonly number[]) {
    // Engine running most of the time, so gated rules are mostly in use.
    this.feeds.push({ path: ENGINE_RPM, rateHz: 10, value: wave(20, 18, 900, 0) })
  }

  private rateOf(i: number): number {
    return this.ratesHz[i % this.ratesHz.length]
  }

  private rule(kind: Kind, signal: unknown, gates: unknown[] | undefined): void {
    const i = this.n++
    this.rules.push({
      name: `Bench ${String(i)}`,
      slug: `bench-${String(i)}`,
      message: 'Bench rule {instance}',
      ...(kind === 'zone' ? {} : { priority: 'warning' }),
      signal,
      detector: detectorFor(kind, i),
      ...(gates === undefined ? {} : { gates })
    })
  }

  private sharedGate(): unknown[] | undefined {
    return this.n % SHARED_GATE_EVERY === 0
      ? [
          {
            signal: { path: ENGINE_RPM },
            direction: 'above',
            limit: { kind: 'fixed', value: 8 },
            duration: 10
          }
        ]
      : undefined
  }

  scalar(kind: Kind): void {
    const path = `bench.s${String(this.n)}.value`
    this.feeds.push({ path, rateHz: this.rateOf(this.n), value: waveformFor(kind, this.rnd) })
    if (kind === 'zone') this.meta.set(path, ZONES)
    this.rule(kind, { path }, this.sharedGate())
  }

  combinator(): void {
    const n = this.n
    const variant = n % 4
    const combinator = ['absDifference', 'mean', 'spread', 'positionSpread'][variant]
    const inputs = [2, 4, 3, 3][variant]
    // Validation recognises a position input by its last segment.
    const leaf = combinator === 'positionSpread' ? 'position' : 'value'
    const paths = Array.from(
      { length: inputs },
      (_, k) => `bench.c${String(n)}.in${String(k)}.${leaf}`
    )
    for (const [k, path] of paths.entries()) {
      this.feeds.push({
        path,
        rateHz: this.rateOf(n + k),
        value:
          combinator === 'positionSpread'
            ? position(1e-4, 60 + this.rnd() * 300, this.rnd() * 6)
            : wave(50, 5, 60 + this.rnd() * 300, this.rnd() * 6)
      })
    }
    this.rule(
      'sustained',
      { combinator, inputs: paths.map((path) => ({ path })) },
      this.sharedGate()
    )
  }

  wildcard(kind: Kind): void {
    const n = this.n
    const pattern = `bench.w${String(n)}.*.value`
    const gated = n % INSTANCE_GATE_EVERY === 0
    const gatePattern = `bench.w${String(n)}.*.gate`
    for (let k = 0; k < MAX_INSTANCES; k++) {
      const path = pattern.replace('*', `i${String(k)}`)
      this.feeds.push({ path, rateHz: this.rateOf(n + k), value: waveformFor(kind, this.rnd) })
      if (kind === 'zone') this.meta.set(path, ZONES)
      if (gated) {
        this.feeds.push({
          path: gatePattern.replace('*', `i${String(k)}`),
          rateHz: 1,
          value: wave(20, 18, 600 + this.rnd() * 600, this.rnd() * 6)
        })
      }
    }
    const gates = gated
      ? [
          {
            signal: { path: gatePattern },
            direction: 'above',
            limit: { kind: 'fixed', value: 8 },
            duration: 10
          }
        ]
      : this.sharedGate()
    this.rule(kind, { path: pattern }, gates)
  }
}

function mixed(): Scenario {
  const b = new Builder([1, 2, 5, 10])
  for (const { kind, count } of WILDCARD_MIX) for (let i = 0; i < count; i++) b.wildcard(kind)
  for (const { kind, count } of SCALAR_MIX) for (let i = 0; i < count; i++) b.scalar(kind)
  for (let i = 0; i < COMBINATOR_RULES; i++) b.combinator()
  const wildcards = WILDCARD_MIX.reduce((s, e) => s + e.count, 0)
  return {
    name: 'mixed',
    describe: `${String(wildcards)} wildcard x ${String(MAX_INSTANCES)} + ${String(MAX_RULES - wildcards)} scalar (${String(COMBINATOR_RULES)} combinators)`,
    ratesHz: b.ratesHz,
    rules: b.rules,
    feeds: b.feeds,
    meta: b.meta
  }
}

/**
 * Every rule a wildcard at the instance bound: the most units the bounds
 * admit. Inputs run at 1-2 Hz to keep the simulation short; per-delta cost
 * does not depend on the rate beyond the trend window fill.
 */
function wildcard(): Scenario {
  const b = new Builder([1, 2])
  const kinds = WILDCARD_MIX.map((e) => e.kind)
  for (let i = 0; i < MAX_RULES; i++) b.wildcard(kinds[i % kinds.length])
  return {
    name: 'wildcard',
    describe: `${String(MAX_RULES)} wildcard x ${String(MAX_INSTANCES)}, detectors round-robin`,
    ratesHz: b.ratesHz,
    rules: b.rules,
    feeds: b.feeds,
    meta: b.meta
  }
}

const SCENARIOS: Record<string, () => Scenario> = { mixed, wildcard }

// ---------------------------------------------------------------------------
// Measurement

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return Number.NaN
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]
}

function stats(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b)
  const sum = samples.reduce((s, v) => s + v, 0)
  return {
    median: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    max: sorted.at(-1) ?? Number.NaN,
    mean: sum / samples.length,
    sum
  }
}

function heapMiB(): number {
  // Without --expose-gc the figure includes garbage; ./run bench passes the flag.
  globalThis.gc?.()
  return process.memoryUsage().heapUsed / 2 ** 20
}

function load(scenario: Scenario): LoadedRule[] {
  const loaded = scenario.rules.map((input): LoadedRule => {
    const result = validateRule(input)
    if (!result.ok) throw new Error(`invalid bench rule: ${JSON.stringify(result.errors)}`)
    return { origin: ORIGIN, rule: result.value }
  })
  const setErrors = validateRuleSet(loaded)
  if (setErrors.length > 0) throw new Error(`invalid bench rule set: ${JSON.stringify(setErrors)}`)
  if (loaded.length !== MAX_RULES) throw new Error(`expected ${String(MAX_RULES)} rules`)
  return loaded
}

interface Result {
  scenario: Scenario
  units: number
  issues: number
  deltasPerS: number
  tickMs: ReturnType<typeof stats>
  deltaUs: ReturnType<typeof stats>
  gateSubscribers: number
  gateUs: ReturnType<typeof stats>
  cpuShare: number
  heapBaseMiB: number
  heapEngineMiB: number
  emissions: number
}

function run(scenario: Scenario): Result {
  const rules = load(scenario)
  const heapBase = heapMiB()
  const sm = new IndexedSubscriptions()
  let now = 0
  let emissions = 0
  const runner = new RuleRunner(
    {
      pluginId: 'signalk-alert-rules',
      subscriptions: sm,
      meta: (path) => scenario.meta.get(path),
      timeoutSettings: () => ({ enforce: true, useDefaults: true }),
      clock: () => now,
      alerts: { list: () => [] },
      wallClock: () => new Date(0),
      send: () => {
        emissions++
      }
    },
    rules
  )
  runner.start()
  for (const feed of scenario.feeds) sm.prepare(feed.path)

  const everyStep = scenario.feeds.map((f) => Math.max(1, Math.round(1 / (f.rateHz * STEP_S))))
  const stepsPerTick = Math.round(TICK_S / STEP_S)
  const tickMs: number[] = []
  const deltaUs: number[] = []
  const gateUs: number[] = []
  let deltas = 0

  const simulate = (fromStep: number, toStep: number, record: boolean) => {
    for (let step = fromStep; step < toStep; step++) {
      now = step * STEP_S
      for (const [i, feed] of scenario.feeds.entries()) {
        if (step % everyStep[i] !== 0) continue
        const value = feed.value(now)
        if (!record) {
          sm.publish(feed.path, value)
          continue
        }
        const t0 = performance.now()
        sm.publish(feed.path, value)
        const us = (performance.now() - t0) * 1000
        deltaUs.push(us)
        if (feed.path === ENGINE_RPM) gateUs.push(us)
        deltas++
      }
      if (step % stepsPerTick === 0) {
        const t0 = performance.now()
        runner.tick()
        if (record) tickMs.push(performance.now() - t0)
      }
    }
  }

  const warmupSteps = Math.round(WARMUP_S / STEP_S)
  const measureSteps = Math.round(MEASURE_S / STEP_S)
  simulate(0, warmupSteps, false)
  const heapEngine = heapMiB() - heapBase
  emissions = 0
  const cpu0 = process.cpuUsage()
  simulate(warmupSteps, warmupSteps + measureSteps, true)
  const cpu = process.cpuUsage(cpu0)

  const gateSubscribers = sm.prepare(ENGINE_RPM).length
  let units = 0
  let issues = 0
  for (const { rule } of rules) {
    const status = runner.status(ruleId(ORIGIN, rule.slug))
    units += status?.instances.length ?? 0
    if ((status?.issues.length ?? 0) + (status?.errors.length ?? 0) > 0) issues++
  }
  runner.stop()
  return {
    scenario,
    units,
    issues,
    deltasPerS: deltas / MEASURE_S,
    tickMs: stats(tickMs),
    deltaUs: stats(deltaUs),
    gateSubscribers,
    gateUs: stats(gateUs),
    // User and system CPU of the measured stretch per simulated second, which
    // includes the timing calls themselves and so slightly overstates.
    cpuShare: (cpu.user + cpu.system) / 1e6 / MEASURE_S,
    heapBaseMiB: heapBase,
    heapEngineMiB: heapEngine,
    emissions
  }
}

// ---------------------------------------------------------------------------
// Report

const f = (v: number, digits = 1) => v.toFixed(digits)

function report(r: Result): string {
  const rows: [string, string][] = [
    ['rules', `${String(r.scenario.rules.length)}: ${r.scenario.describe}`],
    ['evaluated units (rule instances)', String(r.units)],
    ['rules reporting issues', String(r.issues)],
    ['input paths', `${String(r.scenario.feeds.length)} at ${r.scenario.ratesHz.join('/')} Hz`],
    ['deltas/s (simulated)', f(r.deltasPerS, 0)],
    [
      `tick ms (every ${String(TICK_S)} s) median/p95/max`,
      `${f(r.tickMs.median, 2)} / ${f(r.tickMs.p95, 2)} / ${f(r.tickMs.max, 2)}`
    ],
    [
      'delta us median/p95/p99/max',
      `${f(r.deltaUs.median, 2)} / ${f(r.deltaUs.p95, 2)} / ${f(r.deltaUs.p99, 2)} / ${f(r.deltaUs.max, 0)}`
    ],
    ['delta us mean', f(r.deltaUs.mean, 2)],
    [
      `shared gate delta us median/max (${String(r.gateSubscribers)} rules)`,
      `${f(r.gateUs.median, 0)} / ${f(r.gateUs.max, 0)}`
    ],
    [
      'CPU per simulated s: ticks + deltas = total (ms)',
      `${f(r.tickMs.sum / MEASURE_S)} + ${f(r.deltaUs.sum / 1000 / MEASURE_S)} = ${f(r.cpuShare * 1000)}`
    ],
    ['share of one core at these rates', `${f(r.cpuShare * 100)} %`],
    ['heap MiB: baseline / engine after warm-up', `${f(r.heapBaseMiB)} / ${f(r.heapEngineMiB)}`],
    ['alert emissions per simulated s', f(r.emissions / MEASURE_S)]
  ]
  const width = Math.max(...rows.map(([k]) => k.length))
  return [`## ${r.scenario.name}`, ...rows.map(([k, v]) => `${k.padEnd(width)}  ${v}`)].join('\n')
}

function main(): void {
  const names = process.argv.slice(2).filter((a) => a !== '--')
  const selected = names.length > 0 ? names : Object.keys(SCENARIOS)
  for (const name of selected) {
    if (!(name in SCENARIOS)) {
      throw new Error(`unknown scenario ${name}; known: ${Object.keys(SCENARIOS).join(', ')}`)
    }
  }
  console.log(
    `node ${process.version} ${process.platform}/${process.arch}; ` +
      `warm-up ${String(WARMUP_S)} s, measured ${String(MEASURE_S)} s simulated; ` +
      `trend windows ${String(TREND_WINDOW_S)} s (MAX_WINDOW_SAMPLES ${String(MAX_WINDOW_SAMPLES)})`
  )
  for (const name of selected) console.log('\n' + report(run(SCENARIOS[name]())))
}

main()
