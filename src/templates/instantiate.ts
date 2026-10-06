/**
 * Turning a template into a rule. The webapp builds unsaved rules with this
 * as well, so the module imports only types from the schema modules, which
 * are not bundled into the webapp.
 */
import { sanitiseSegment } from '../alerts/paths.js'
import type { TemplatePick } from '../model/rule.js'
import type { Slot, Template } from '../model/template.js'
import type { Result, ValidationError } from '../model/validate.js'
import { isRecord, pointer } from '../util.js'

// The schema modules are not bundled into the webapp; a test keeps this
// equal to the model's MAX_SLUG_LENGTH.
export const MAX_SLUG = 64

// A test keeps these equal to the model's: the one path segment a slot's
// placeholder stands for, so a pick can neither deepen the path, make it a
// wildcard nor turn it into a field's pointer.
export const SLOT_PICK_PATTERN = '^[^.\\s*#]+$'
export const SLOT_PICK_MESSAGE = 'must be one path segment, without dots, whitespace, * or #'
const SLOT_PICK = new RegExp(SLOT_PICK_PATTERN)

/** A slot's name, which keys its pick; a test keeps it equal to the model's. */
export const SLOT_NAME_PATTERN = '^[A-Za-z][A-Za-z0-9]*$'

/**
 * The parts of a template's rule its user picks: the instance in its paths,
 * the source of its input. A template with slots lists only `source` here.
 */
export const OPEN_PARTS = ['instance', 'source'] as const
export type OpenPart = (typeof OPEN_PARTS)[number]
/** The pick key of an open source; a test keeps it equal to the model's. */
export const SOURCE_PICK: OpenPart = 'source'

/** A picked source is set on a single path's input, so a combined signal cannot leave it open. */
export const OPEN_SOURCE_MESSAGE = 'an open source needs a signal with a single path'

/** The placeholder of the one slot `open: [instance]` declares: `${instance}`. */
export const INSTANCE_PLACEHOLDER = 'instance'

/** The slot `open: [instance]` stands for. */
export const INSTANCE_SLOT: Slot = { name: INSTANCE_PLACEHOLDER, label: 'Instance' }

/** A template's slots in declaration order: its `slots`, or the one `open: [instance]` gives. */
export function slotsOf(template: Template): readonly Slot[] {
  if (template.slots !== undefined) return template.slots
  return template.open?.includes('instance') ? [INSTANCE_SLOT] : []
}

/** The keys under which a template's strings carry slot placeholders such as `${instance}`. */
export const PLACEHOLDER_KEYS: ReadonlySet<string> = new Set([
  'path',
  'name',
  'message',
  'condition'
])

const PLACEHOLDER = /\$\{([^}]*)\}/g

/** Where a `${name}` placeholder appears: under which key, at which JSON pointer. */
export interface PlaceholderUse {
  name: string
  key: string
  at: string
  /** The placeholder is a whole segment of its string, between dots or before a field pointer. */
  segment: boolean
  /** The placeholder is in a field pointer, after `#`. */
  inPointer: boolean
}

function isSegment(text: string, start: number, end: number): boolean {
  return (
    (start === 0 || text[start - 1] === '.') &&
    (end === text.length || text[end] === '.' || text[end] === '#')
  )
}

/**
 * A copy of a rule document in which each `${name}` placeholder in a string
 * under one of the {@link PLACEHOLDER_KEYS} is replaced by `visit`'s result.
 * Fresh objects throughout, so values a YAML alias shares are never shared
 * between copies.
 */
export function substitutePlaceholders(
  value: unknown,
  visit: (use: PlaceholderUse) => string,
  at = ''
): unknown {
  if (Array.isArray(value))
    return value.map((item: unknown, i) => substitutePlaceholders(item, visit, pointer(at, i)))
  if (!isRecord(value)) return value
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => {
      const childAt = pointer(at, key)
      if (PLACEHOLDER_KEYS.has(key) && typeof child === 'string') {
        const replaced = child.replace(PLACEHOLDER, (match: string, name: string, offset: number) =>
          visit({
            name,
            key,
            at: childAt,
            segment: isSegment(child, offset, offset + match.length),
            inPointer: child.slice(0, offset).includes('#')
          })
        )
        return [key, replaced]
      }
      return [key, substitutePlaceholders(child, visit, childAt)]
    })
  )
}

/** A slug from free text: lowercase ASCII letters and digits joined by single hyphens. */
export function slugify(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG)
    .replace(/-+$/, '')
}

function fitted(base: string, suffix: string): string {
  return base.slice(0, MAX_SLUG - suffix.length).replace(/-+$/, '') + suffix
}

/** A slot's pick, read from the pick's own keys only, whatever the slot is named. */
export function picked(pick: TemplatePick, name: string): string | undefined {
  return Object.hasOwn(pick, name) ? pick[name] : undefined
}

/**
 * A slug for a rule made from a template: its id and each slot's pick in
 * the order the template declares its slots, numbered when another rule has
 * it, so the same template can be used twice for the same picks.
 */
export function proposeSlug(
  template: Template,
  pick: TemplatePick,
  taken: ReadonlySet<string>
): string {
  const parts = slotsOf(template).map((slot) => slugify(picked(pick, slot.name) ?? ''))
  const base = fitted([template.id, ...parts.filter((part) => part !== '')].join('-'), '')
  if (!taken.has(base)) return base
  for (let n = 2; ; n++) {
    const slug = fitted(base, `-${String(n)}`)
    if (!taken.has(slug)) return slug
  }
}

const REQUIRED = 'is required: the template leaves it open'
const NOT_OPEN = 'the template does not leave it open'

function pickErrors(template: Template, pick: TemplatePick): ValidationError[] {
  const slots = slotsOf(template)
  const errors = slots.flatMap((slot): ValidationError[] => {
    const value = picked(pick, slot.name)
    const at = pointer('', slot.name)
    if (value === undefined) return [{ path: at, message: REQUIRED }]
    if (!SLOT_PICK.test(value)) return [{ path: at, message: SLOT_PICK_MESSAGE }]
    return []
  })
  const sourceOpen = template.open?.includes('source') === true
  if (sourceOpen && picked(pick, SOURCE_PICK) === undefined)
    errors.push({ path: pointer('', SOURCE_PICK), message: REQUIRED })
  for (const key of Object.keys(pick)) {
    const known = key === SOURCE_PICK ? sourceOpen : slots.some((slot) => slot.name === key)
    if (!known) errors.push({ path: pointer('', key), message: NOT_OPEN })
  }
  return errors
}

/**
 * A copy of a template's rule and condition with each slot's pick filled in.
 * A pick goes into the condition sanitised as the alert parent sanitises the
 * same pick in a path, so a pick any path takes makes a condition name of
 * characters core accepts.
 */
function substituted(template: Template, pick: TemplatePick) {
  const names = new Set(slotsOf(template).map((slot) => slot.name))
  return substitutePlaceholders({ condition: template.condition, rule: template.rule }, (use) => {
    const value = names.has(use.name) ? picked(pick, use.name) : undefined
    if (value === undefined) return `\${${use.name}}`
    return use.key === 'condition' ? sanitiseSegment(value) : value
  }) as { condition?: string; rule: Record<string, unknown> }
}

/**
 * The rule a template makes with the picks for its open parts, unvalidated:
 * a pick can make a path or condition name that rule validation then
 * refuses, such as a forbidden name or an alert path too long. The rule records
 * the set and template it came from, and takes a slug no rule in `taken`
 * has. It stores the template's condition name, if the template has one.
 * Another rule holding its alert path refuses the rule when it is created.
 */
export function instantiate(
  set: { id: string; version: string },
  template: Template,
  pick: TemplatePick,
  taken: ReadonlySet<string> = new Set()
): Result<Record<string, unknown>> {
  const errors = pickErrors(template, pick)
  if (errors.length > 0) return { ok: false, errors }
  const source = picked(pick, SOURCE_PICK)
  const { condition, rule } = substituted(template, pick)
  const { name, slug: _slug, template: _template, ...rest } = rule
  if (source !== undefined) {
    if (!isRecord(rest.signal) || typeof rest.signal.path !== 'string') {
      return { ok: false, errors: [{ path: '/source', message: OPEN_SOURCE_MESSAGE }] }
    }
    rest.signal = { ...rest.signal, source }
  }
  return {
    ok: true,
    value: {
      name,
      slug: proposeSlug(template, pick, taken),
      ...(condition === undefined ? {} : { condition }),
      ...rest,
      template: { set: set.id, id: template.id, version: set.version, pick: { ...pick } }
    }
  }
}
