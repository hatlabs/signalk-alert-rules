/**
 * Rule messages with their placeholders filled in. The webapp previews a
 * message with this module too, so it imports only types besides format.
 */
import { SECONDS_PER_MINUTE, formatDuration, formatNumber } from '../format.js'
import type { DisplayConversion } from '../affine.js'
import type { Rule } from '../model/rule.js'
import type { SignalValue } from '../engine/signals.js'

/** What a rule's message placeholders are filled in from, for one instance. */
export interface MessageFacts {
  /** The wildcard instance's name. */
  instance?: string
  /** The input's last value, in SI units. */
  value?: SignalValue
  /**
   * The step the alert has reached, an index into the rule's steps; absent
   * when no step set the alert's priority, as for an alert adopted above the
   * first step.
   */
  step?: number
  /**
   * The SI limit of that step as the evaluator resolved it, for a detector
   * whose steps have a limit (a zone limit's threshold included), or else the
   * limit SKAR last sent for the alert; absent for a match or absence rule.
   */
  limit?: number
  /** The signal's SI unit, as the path's `meta.units` names it. */
  units?: string
  /** The conversion from `units` to the display unit; absent, numbers stay in SI. */
  display?: DisplayConversion
  /** The signal is a difference of its inputs, so its values convert without the offset. */
  difference?: boolean
}

export interface RenderOptions {
  /**
   * `{limit}` with no limit to fill it in stays as written rather than a
   * dash: for the editor's preview, which cannot always know the limit the
   * server will resolve, and should not suggest there is none.
   */
  keepUnfilledLimit?: boolean
}

/**
 * How a number converts: a level through the whole conversion, a difference,
 * rate or total through its scale alone, as an offset applies only to a level.
 */
type Quantity = 'level' | 'interval'

/**
 * A number in the display unit, or in SI when there is none. A ratio's SI
 * unit has no symbol, as in the server's own `ratio` conversion, so without
 * a display unit it reads as a bare fraction.
 */
function quantity(
  value: number,
  facts: MessageFacts,
  kind: Quantity = facts.difference === true ? 'interval' : 'level',
  suffix = ''
): string {
  const { units, display } = facts
  const shown =
    display === undefined ? value : value * display.scale + (kind === 'level' ? display.offset : 0)
  const siSymbol = units === 'ratio' ? '' : (units ?? '')
  const symbol = (display?.symbol ?? siSymbol) + suffix
  return symbol === '' ? formatNumber(shown) : `${formatNumber(shown)} ${symbol}`
}

function valueText(value: SignalValue, facts: MessageFacts): string {
  if (typeof value === 'number') return quantity(value, facts)
  if (typeof value === 'object') {
    return `${value.latitude.toFixed(5)}, ${value.longitude.toFixed(5)}`
  }
  return String(value)
}

/**
 * The reached step's limit, in the quantity the detector's limits have: the
 * limit the facts carry, else the rule's own step, which serves until the
 * evaluator has resolved its steps. A zone limit has no step of its own, so
 * it is known only from the facts.
 */
function limitText(rule: Rule, facts: MessageFacts): string | undefined {
  const d = rule.detector
  const { step } = facts
  const own = step === undefined ? undefined : (d.steps ?? []).at(step)
  const limit = facts.limit ?? (own !== undefined && 'limit' in own ? own.limit : undefined)
  switch (d.type) {
    case 'sustained':
    case 'outside':
    case 'projection':
      return limit === undefined ? undefined : quantity(limit, facts)
    case 'slope':
      // Per minute, as the editor shows a slope: per second, a coolant's rise reads 0.0017 °C/s.
      return limit === undefined
        ? undefined
        : quantity(limit * SECONDS_PER_MINUTE, facts, 'interval', '/min')
    case 'count':
      return limit === undefined ? undefined : formatNumber(limit)
    case 'accumulator':
      if (limit === undefined) return undefined
      return d.measure === 'time' ? formatDuration(limit) : quantity(limit, facts, 'interval', '·s')
    case 'match': {
      const value = own !== undefined && 'value' in own ? own.value : undefined
      return value === undefined ? undefined : valueText(value, facts)
    }
    case 'absence': {
      const within = own !== undefined && 'within' in own ? own.within : undefined
      return within === undefined ? undefined : formatDuration(within)
    }
  }
}

const PLACEHOLDER = /\{(instance|limit|duration|value)\}/g

/** What a placeholder with nothing to fill it in reads as. */
const MISSING = '–'

/**
 * A rule's message with its placeholders filled in: `{instance}`, `{limit}`
 * (the reached step's), `{duration}` and `{value}` (the input's last value).
 * A placeholder with nothing to fill it in reads as a dash; any other text
 * in braces stays as written. `{instance}` is the exception: it is empty for
 * a rule without a wildcard, so a message shared by both kinds of rule reads
 * cleanly.
 */
export function renderMessage(
  rule: Rule,
  facts: MessageFacts,
  options: RenderOptions = {}
): string {
  return rule.message.replace(PLACEHOLDER, (_, name: string) => {
    let text: string | undefined
    switch (name) {
      case 'instance':
        text = facts.instance ?? ''
        break
      case 'limit':
        text =
          limitText(rule, facts) ?? (options.keepUnfilledLimit === true ? '{limit}' : undefined)
        break
      case 'duration': {
        const duration = 'duration' in rule.detector ? rule.detector.duration : undefined
        text = duration === undefined ? undefined : formatDuration(duration)
        break
      }
      case 'value':
        text = facts.value === undefined ? undefined : valueText(facts.value, facts)
    }
    return text ?? MISSING
  })
}
