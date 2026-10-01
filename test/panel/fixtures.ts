import type { InstanceStatus, PanelApi, RuleEntry } from '../../src/panel/api'

const notExpected = () => Promise.reject(new Error('not expected to be asked'))

/** The authoring routes of a fake API, for tests that never author a rule. */
export const noAuthoring: Pick<
  PanelApi,
  'ruleDefinition' | 'createRule' | 'updateRule' | 'previewRule'
> = {
  ruleDefinition: notExpected,
  createRule: notExpected,
  updateRule: notExpected,
  previewRule: notExpected
}

/** The control routes of a fake API, for tests that never use them. */
export const noControls: Pick<PanelApi, 'disableRule' | 'enableRule'> = {
  disableRule: notExpected,
  enableRule: notExpected
}

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

/** An idle, enabled single-path rule, to override per test. */
export function ruleEntry(overrides: EntryOverrides = {}): RuleEntry {
  const { rule, status, ...rest } = overrides
  return {
    slug: 'oil-pressure-low',
    ...rest,
    rule: {
      name: 'Oil pressure low',
      alertPath: 'propulsion.port.oilPressureLow',
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
