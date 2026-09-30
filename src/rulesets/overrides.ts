import type { Rule } from '../model/rule.js'
import type { Ruleset } from '../model/ruleset.js'
import {
  parameterValueErrors,
  resolveRuleset,
  type Result,
  type ValidationError
} from '../model/validate.js'
import type { RulesetControl, RulesetNotice } from '../store/store.js'
import { isRecord } from '../util.js'

/** What loading a ruleset does to the operator's stored settings for it. */
export interface RulesetUpgrade {
  /** The settings to store: the kept parameter values, the loaded version and rules, and new notices. */
  control: RulesetControl
  /** Slugs of rules the ruleset had when last loaded and has no more. */
  removed: string[]
  /** The ruleset's rules with the kept parameter values. */
  rules: Rule[]
}

function describe(errors: readonly ValidationError[]): string {
  return errors.map((e) => e.message).join('; ')
}

const RULE_POINTER = /^\/rules\/(\d+)(.*)$/

/**
 * Resolution errors of the rules, which point into the ruleset file, with
 * the rule and field in the message instead: an operator setting values sees
 * neither the file nor the rule's index in it.
 */
function namingRules(ruleset: Ruleset, errors: readonly ValidationError[]): ValidationError[] {
  return errors.map(({ path, message }) => {
    const match = RULE_POINTER.exec(path)
    const slug = match === null ? undefined : ruleset.rules[Number(match[1])]?.slug
    if (match === null || slug === undefined) return { path, message }
    return { path: '', message: `rule ${slug} ${match[2] || '/'}: ${message}` }
  })
}

/** The rules at the parameter defaults, which validation has already checked. */
function atDefaults(ruleset: Ruleset): Rule[] {
  const resolved = resolveRuleset(ruleset, {})
  if (!resolved.ok) throw new Error(`ruleset ${ruleset.slug} does not resolve at its defaults`)
  return resolved.value
}

/**
 * Carries the operator's settings for a ruleset over to the ruleset as it
 * loads now. A ruleset seen for the first time starts disabled. A rule that
 * is gone, and a stored parameter value that no longer validates, are
 * dropped with a notice; the rest is kept. Notices accumulate until the
 * operator dismisses them, because the plugin restarts on every
 * configuration save and would otherwise lose them.
 */
export function upgradeRuleset(
  ruleset: Ruleset,
  stored: RulesetControl | undefined,
  at: string
): RulesetUpgrade {
  const slugs = ruleset.rules.map((r) => r.slug)
  if (stored === undefined) {
    return {
      control: {
        enabled: false,
        parameters: {},
        version: ruleset.version,
        rules: slugs,
        notices: []
      },
      removed: [],
      rules: atDefaults(ruleset)
    }
  }
  const notices: RulesetNotice[] = []
  const notice = (message: string) => notices.push({ at, message })

  const removed = stored.rules.filter((slug) => !slugs.includes(slug))
  for (const slug of removed) {
    notice(
      `rule ${slug} is not in version ${ruleset.version}: its alert was cleared and its settings dropped`
    )
  }

  let parameters: RulesetControl['parameters'] = {}
  for (const [name, value] of Object.entries(stored.parameters)) {
    const errors = parameterValueErrors(ruleset, { [name]: value })
    if (errors.length === 0) parameters[name] = value
    else
      notice(`parameter ${name}: ${JSON.stringify(value)} ${describe(errors)}; the default applies`)
  }
  let resolved = resolveRuleset(ruleset, parameters)
  if (!resolved.ok) {
    const errors = describe(namingRules(ruleset, resolved.errors))
    notice(`the parameter values no longer make valid rules (${errors}); the defaults apply`)
    parameters = {}
    resolved = { ok: true, value: atDefaults(ruleset) }
  }
  return {
    control: {
      ...stored,
      parameters,
      version: ruleset.version,
      rules: slugs,
      notices: [...stored.notices, ...notices]
    },
    removed,
    rules: resolved.value
  }
}

/** The ruleset's rules with new parameter values, as an operator's change sets them. */
export function withParameters(
  ruleset: Ruleset,
  values: unknown
): Result<{ parameters: RulesetControl['parameters']; rules: Rule[] }> {
  if (!isRecord(values)) return { ok: false, errors: [{ path: '', message: 'must be an object' }] }
  const resolved = resolveRuleset(ruleset, values)
  if (!resolved.ok) return { ok: false, errors: namingRules(ruleset, resolved.errors) }
  // Resolving checked each value against its parameter's type.
  const parameters = values as RulesetControl['parameters']
  return { ok: true, value: { parameters, rules: resolved.value } }
}
