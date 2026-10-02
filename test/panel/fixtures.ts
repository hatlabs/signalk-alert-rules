import type { InstanceStatus, InvalidRuleEntry, PanelApi, RuleEntry } from '../../src/panel/api'

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
export const noControls: Pick<PanelApi, 'disableRule' | 'enableRule' | 'deleteRule'> = {
  disableRule: notExpected,
  enableRule: notExpected,
  deleteRule: notExpected
}

/** A normal instance with a value, to override per test. */
export function instance(overrides: Partial<InstanceStatus> = {}): InstanceStatus {
  return {
    condition: 'normal',
    reason: 'withinLimits',
    value: 12.6,
    gates: [],
    ...overrides
  }
}

type EntryOverrides = Omit<Partial<RuleEntry>, 'rule' | 'status'> & {
  rule?: Partial<RuleEntry['rule']>
  status?: Partial<RuleEntry['status']>
}

/** A normal, enabled single-path rule, to override per test. */
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
      ruleState: overrides.disabled === undefined ? 'enabled' : 'disabled',
      condition: 'normal',
      reason: 'withinLimits',
      changedAt: '2026-09-30T12:00:00.000Z',
      errors: [],
      issues: [],
      instances: [instance()],
      ...status
    }
  }
}

/** A stored rule that does not run, as `GET /rules` lists it after the others. */
export function invalidEntry(overrides: Partial<InvalidRuleEntry> = {}): InvalidRuleEntry {
  return {
    slug: 'coolant-high',
    name: 'Coolant high',
    invalid: { errors: [{ path: '/detector', message: 'is required' }], body: {} },
    status: {
      ruleState: 'enabled',
      condition: 'problem',
      reason: 'invalidRule',
      changedAt: '2026-09-30T12:00:00.000Z',
      errors: [],
      issues: [],
      instances: []
    },
    ...overrides
  }
}
