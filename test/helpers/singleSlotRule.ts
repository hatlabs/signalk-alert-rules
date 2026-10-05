import type { TemplatePick } from '../../src/model/rule.js'
import type { Template } from '../../src/model/template.js'
import { slugify } from '../../src/templates/instantiate.js'

/**
 * The rule an `open: [instance]` or fully bound template makes, written out
 * independently by replacing `${instance}` as text, so that `instantiate`
 * can be held to it.
 */
export function singleSlotRule(
  set: { id: string; version: string },
  template: Template,
  pick: TemplatePick
): Record<string, unknown> {
  const { instance, source } = pick
  const text = JSON.stringify(template.rule)
  const filled = JSON.parse(
    instance === undefined ? text : text.replaceAll('${instance}', instance)
  ) as Record<string, unknown>
  const signal = filled.signal as Record<string, unknown>
  return {
    ...filled,
    slug: instance === undefined ? template.id : `${template.id}-${slugify(instance)}`,
    ...(template.condition === undefined ? {} : { condition: template.condition }),
    signal: source === undefined ? signal : { ...signal, source },
    template: { set: set.id, id: template.id, version: set.version, pick }
  }
}
