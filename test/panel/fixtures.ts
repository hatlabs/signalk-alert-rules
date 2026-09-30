import type { InstanceStatus, RuleEntry } from '../../src/panel/api'

/** An idle instance with a value, to override per test. */
export function instance(overrides: Partial<InstanceStatus> = {}): InstanceStatus {
  return {
    badge: 'idle',
    subLabels: [],
    active: false,
    input: 'value',
    value: 12.6,
    gates: [],
    ...overrides
  }
}

type EntryOverrides = Omit<Partial<RuleEntry>, 'rule' | 'status'> & {
  rule?: Partial<RuleEntry['rule']>
  status?: Partial<RuleEntry['status']>
}

/** An idle, enabled single-path user rule, to override per test. */
export function ruleEntry(overrides: EntryOverrides = {}): RuleEntry {
  const { rule, status, ...rest } = overrides
  return {
    origin: 'user',
    slug: 'oil-pressure-low',
    enabled: true,
    ...rest,
    rule: {
      name: 'Oil pressure low',
      priority: 'alarm',
      detector: { type: 'sustained', direction: 'below' },
      signal: { paths: ['propulsion.port.oilPressure'] },
      gates: [],
      ...rule
    },
    status: {
      badge: 'idle',
      subLabels: [],
      errors: [],
      issues: [],
      instances: [instance()],
      ...status
    }
  }
}
