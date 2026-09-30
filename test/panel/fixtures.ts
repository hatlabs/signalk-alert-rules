import type { InstanceStatus, PanelApi, RuleEntry } from '../../src/panel/api'
import type { RulesetsApi } from '../../src/panel/rulesets/api'

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

/** The control and suppression routes of a fake API, for tests that never use them. */
export const noControls: Pick<
  PanelApi,
  | 'setEnabled'
  | 'setNote'
  | 'suppressions'
  | 'suppressRule'
  | 'endRuleSuppression'
  | 'suppressInput'
  | 'endInputSuppression'
  | 'previewInputSuppression'
> = {
  setEnabled: notExpected,
  setNote: notExpected,
  suppressions: () => Promise.resolve([]),
  suppressRule: notExpected,
  endRuleSuppression: notExpected,
  suppressInput: notExpected,
  endInputSuppression: notExpected,
  previewInputSuppression: notExpected
}

/** The ruleset routes of a server with no ruleset, for tests that change none. */
export const noRulesets: RulesetsApi = {
  list: () => Promise.resolve({ rulesets: [], problems: [] }),
  rescan: notExpected,
  setEnabled: notExpected,
  setParameters: notExpected,
  dismissNotices: notExpected
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
