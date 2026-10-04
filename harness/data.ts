/// <reference types="vite/client" />
import { parse } from 'yaml'
import {
  stateReport,
  type InstanceState,
  type LiveFacts,
  type RuleCondition,
  type RuleStateReport
} from '../src/alerts/state'
import type { InvalidRuleEntry, ListedRule, RuleEntry } from '../src/application'
import { ruleAlertPath } from '../src/model/alertPath'
import type { Rule } from '../src/model/rule'
import { validateTemplateSet } from '../src/model/template'
import { validateRule } from '../src/model/validate'
import type { TemplateSetEntry } from '../src/panel/api'
import type { Aggregate, HistoryQuery, HistorySeries } from '../src/panel/history/historySource'
import type { PathEntry } from '../src/panel/paths/selfPaths'
import { displayUnit } from '../src/panel/units'
import type { Disabled } from '../src/store/store'
import type { Scenario } from './scenario'
import { invalidEntry } from '../test/panel/fixtures'
import { reported } from '../test/panel/reportedPaths'
import builtinYaml from '../templates/builtin.yaml?raw'
import exampleSetYaml from '../examples/template-set-example/templates.yaml?raw'
import exampleSetPackage from '../examples/template-set-example/package.json'

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()

/** The worked examples, as the server stores them. */
const examples: Rule[] = Object.values(
  import.meta.glob<unknown>('../examples/rules/*.json', { eager: true, import: 'default' })
).map((json) => {
  const result = validateRule(json)
  if (!result.ok) throw new Error(`a worked example is not valid: ${JSON.stringify(result.errors)}`)
  return result.value
})

/** The shore power frequency the shared fixture paths lack, with zones for the zone limit. */
const extraPaths: PathEntry[] = [
  {
    path: 'electrical.ac.shore.phase.single.frequency',
    units: 'Hz',
    unit: displayUnit({ units: 'Hz', displayUnits: { formula: 'value * 1', symbol: 'Hz' } }),
    value: 50.4,
    zones: [
      { upper: 48, state: 'alarm' },
      { lower: 52, state: 'alarm' }
    ]
  }
]

/** The source of a path the shared fixtures give a value but no source, as one device reports it. */
const SOURCE = 'example'

/** Every path with a value has a source, as on a server, so the editors offer one to pick. */
export const paths: PathEntry[] = [...reported, ...extraPaths].map((entry) =>
  entry.value === undefined || entry.sources !== undefined
    ? entry
    : { ...entry, sources: [SOURCE], preferredSource: SOURCE }
)

function currentValue(path: string): number | undefined {
  const value = paths.find((p) => p.path === path)?.value
  return typeof value === 'number' ? value : undefined
}

const NORMAL: RuleCondition = { condition: 'normal', reason: 'withinLimits' }

/** An instance's state: normal unless `condition` says otherwise. */
function instanceState(condition: RuleCondition = NORMAL, facts: Partial<LiveFacts> = {}) {
  const state: InstanceState = { ...condition, gates: [], ...facts }
  return state
}

const wildcard = (segment: string) => ({ instance: { name: segment, segment } })

/** A rule's state shown in the list and detail view, beyond a normal one. */
interface Shown {
  condition: RuleCondition
  instances: InstanceState[]
  changedAt?: string
}

/**
 * States that show the list's and detail view's variety: an alert, a
 * wildcard rule with an instance alerting, totals and counts toward a limit,
 * an input gone silent, a disabled rule. Unlisted examples are normal.
 */
const states: Partial<Record<string, Shown>> = {
  'house-battery-low': {
    condition: {
      condition: 'alerting',
      reason: 'alertActive',
      priority: 'warning',
      step: 0,
      level: 'warn',
      awaitingInput: false,
      message: 'House battery voltage low: 11.8 V',
      value: 11.8
    },
    instances: [
      instanceState(
        {
          condition: 'alerting',
          reason: 'alertActive',
          priority: 'warning',
          step: 0,
          level: 'warn',
          awaitingInput: false
        },
        { value: 11.8 }
      )
    ],
    changedAt: minutesAgo(7)
  },
  'coolant-temperature-rising': {
    condition: {
      condition: 'alerting',
      reason: 'alertActive',
      priority: 'warning',
      step: 0,
      awaitingInput: false,
      value: 361.4
    },
    instances: [
      instanceState(NORMAL, { ...wildcard('port'), value: 355.2 }),
      instanceState(
        {
          condition: 'alerting',
          reason: 'alertActive',
          priority: 'warning',
          step: 0,
          awaitingInput: false
        },
        { ...wildcard('starboard'), value: 361.4 }
      )
    ],
    changedAt: minutesAgo(3)
  },
  'shore-power-frequency': {
    condition: {
      condition: 'alerting',
      reason: 'alertActive',
      priority: 'warning',
      step: 0,
      passed: 'high',
      awaitingInput: false,
      value: 51.3
    },
    instances: [
      instanceState(
        {
          condition: 'alerting',
          reason: 'alertActive',
          priority: 'warning',
          step: 0,
          passed: 'high',
          awaitingInput: false
        },
        { value: 51.3 }
      )
    ],
    changedAt: minutesAgo(2)
  },
  'engine-service-due': {
    condition: { ...NORMAL, progress: { kind: 'total', total: 612_000, limit: 900_000 } },
    instances: [
      instanceState(NORMAL, {
        value: 0,
        progress: { kind: 'total', total: 612_000, limit: 900_000 }
      })
    ]
  },
  'bilge-pump-cycling': {
    condition: { ...NORMAL, progress: { kind: 'events', count: 2, limit: 4 } },
    instances: [
      instanceState(NORMAL, { value: false, progress: { kind: 'events', count: 2, limit: 4 } })
    ]
  },
  'engine-stopped': {
    condition: NORMAL,
    instances: [
      instanceState(NORMAL, { ...wildcard('port'), value: 'started' }),
      instanceState(NORMAL, { ...wildcard('starboard'), value: 'started' })
    ]
  },
  'depth-sensor-silent': {
    condition: { condition: 'noData', reason: 'inputUnavailable', lastSeen: minutesAgo(12) },
    instances: [instanceState({ condition: 'noData', reason: 'inputUnavailable' })]
  }
}

const disabled: Partial<Record<string, Disabled>> = {
  'watch-not-acknowledged': { since: minutesAgo(90), actor: 'admin', note: 'Moored in harbour' }
}

/** The states docs/examples.md shows, where they differ from the mixed ones. */
const docsStates: Partial<Record<string, Shown>> = {
  'shore-power-frequency': {
    condition: { ...NORMAL, value: 50 },
    instances: [instanceState(NORMAL, { value: 50 })]
  }
}

/** The state of a rule as shown, or a normal one with one instance reading its path's current value. */
function shownState(rule: Rule, off: boolean, set: Scenario['states']): RuleStateReport {
  const shown = (set === 'docs' ? docsStates[rule.slug] : undefined) ?? states[rule.slug]
  if (shown !== undefined) {
    return stateReport(off, shown.condition, shown.changedAt ?? minutesAgo(240), {
      instances: shown.instances
    })
  }
  const path = 'path' in rule.signal ? rule.signal.path : undefined
  const value = path === undefined ? undefined : currentValue(path)
  return stateReport(off, NORMAL, minutesAgo(240), {
    instances: [instanceState(NORMAL, value === undefined ? {} : { value })]
  })
}

/** The state of a rule just stored, which has not read its input yet. */
export function freshState(off: boolean): RuleStateReport {
  return stateReport(
    off,
    { condition: 'noData', reason: 'neverReported' },
    new Date().toISOString()
  )
}

export function ruleEntry(rule: Rule, state: RuleStateReport, off?: Disabled): RuleEntry {
  return {
    slug: rule.slug,
    rule,
    alertPath: ruleAlertPath(rule),
    ...(off === undefined ? {} : { disabled: off }),
    state: { ...state, ruleState: off === undefined ? 'enabled' : 'disabled' }
  }
}

export function exampleEntries(set: Scenario['states']): ListedRule[] {
  return examples.map((rule) => {
    const off = disabled[rule.slug]
    return ruleEntry(rule, shownState(rule, off !== undefined, set), off)
  })
}

/** A stored rule that does not run: a worked example that lost its detector. */
export function invalidRuleEntry(): InvalidRuleEntry {
  const fixture = invalidEntry()
  const base = examples.find((r) => r.slug === 'coolant-temperature-rising')
  const { detector: _detector, ...body } = base ?? {}
  return {
    slug: fixture.slug,
    invalid: { ...fixture.invalid, body: { ...body, slug: fixture.slug, name: fixture.name } },
    state: stateReport(false, { condition: 'problem', reason: 'invalidRule' }, minutesAgo(240))
  }
}

/** A worked example stored as `slug` with a change the server refuses to run. */
function brokenExample(
  from: string,
  slug: string,
  change: (rule: Rule) => object
): InvalidRuleEntry {
  const base = examples.find((r) => r.slug === from)
  if (base === undefined) throw new Error(`no worked example ${from}`)
  const body = { ...change(base), slug }
  const result = validateRule(body)
  if (result.ok) throw new Error(`${slug} is meant not to validate`)
  return {
    slug,
    invalid: { errors: result.errors, body },
    state: stateReport(false, { condition: 'problem', reason: 'invalidRule' }, minutesAgo(240))
  }
}

/** Stored rules the editor cannot make, each beside the examples under its `rules` value. */
export const brokenRules: Record<'fixedLimit' | 'angularRatio', () => InvalidRuleEntry> = {
  fixedLimit: () =>
    brokenExample('house-battery-low', 'house-battery-fixed-limit', (rule) => ({
      ...rule,
      name: 'House battery fixed limit',
      detector: { ...rule.detector, limit: { kind: 'fixed', value: 12 } }
    })),
  angularRatio: () =>
    brokenExample('engine-rpm-mismatch', 'engine-rpm-ratio-angular', (rule) => ({
      ...rule,
      name: 'Engine RPM ratio',
      signal: { ...rule.signal, combinator: 'ratio', angular: true }
    }))
}

/** What the plugin found while loading, beside the stored rule that does not run. */
export const LOAD_ISSUE = 'rules/anchor-drag.json: Unexpected end of JSON input'

function templateSet(yaml: string, source: string): TemplateSetEntry {
  const result = validateTemplateSet(parse(yaml))
  if (!result.ok) throw new Error(`template set ${source} is not valid`)
  const { templates, ...set } = result.value
  return { ...set, source, templates, new: [] }
}

export const templateSets: TemplateSetEntry[] = [
  templateSet(builtinYaml, 'built-in'),
  templateSet(exampleSetYaml, `package ${exampleSetPackage.name}`)
]

const HOUR_MS = 3_600_000

/**
 * A slow swing around the path's current value, a little wider for the
 * highest and lowest of each bucket than for the average.
 */
export function historySeries(
  query: HistoryQuery,
  shape: 'data' | 'gaps' | 'empty'
): HistorySeries {
  const base = currentValue(query.path) ?? 1
  const now = Date.now()
  const count = Math.floor(query.seconds / query.resolution)
  const spread: Record<Aggregate, number> = { average: 0, min: -0.02, max: 0.02 }
  const series: HistorySeries = {}
  for (const method of query.methods) {
    series[method] = Array.from({ length: count }, (_, i) => {
      const time = now - (count - i) * query.resolution * 1000
      const gap = shape === 'gaps' && i > count * 0.4 && i < count * 0.6
      if (shape === 'empty' || gap) return { time, value: null }
      const swing = 0.04 * Math.sin((2 * Math.PI * time) / (6 * HOUR_MS))
      return { time, value: base * (1 + swing + spread[method]) }
    })
  }
  return series
}
