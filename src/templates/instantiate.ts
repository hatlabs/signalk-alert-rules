/**
 * Turning a template into a rule. The webapp builds unsaved rules with this
 * as well, so the module imports only types from the schema modules, which
 * are not bundled into the webapp.
 */
import type { TemplatePick } from '../model/rule.js'
import type { Template } from '../model/template.js'
import type { Result, ValidationError } from '../model/validate.js'
import { isRecord, pointer } from '../util.js'

// The schema modules are not bundled into the webapp; a test keeps this
// equal to the model's MAX_SLUG_LENGTH.
export const MAX_SLUG = 64

// A test keeps these equal to the model's: the one path segment `${instance}`
// stands for, so a pick can neither deepen the path nor make it a wildcard.
export const INSTANCE_PICK_PATTERN = '^[^.\\s*]+$'
export const INSTANCE_PICK_MESSAGE = 'must be one path segment, without dots, whitespace or *'
const INSTANCE_PICK = new RegExp(INSTANCE_PICK_PATTERN)

/** The parts of a template's rule its user picks: the instance in its paths, the source of its input. */
export const OPEN_PARTS = ['instance', 'source'] as const
export type OpenPart = (typeof OPEN_PARTS)[number]

/** A picked source is set on a single path's input, so a combined signal cannot leave it open. */
export const OPEN_SOURCE_MESSAGE = 'an open source needs a signal with a single path'

/** The one placeholder a template substitutes: `${instance}`. */
export const INSTANCE_PLACEHOLDER = 'instance'

/** The keys under which a template's strings carry `${instance}`. */
export const PLACEHOLDER_KEYS: ReadonlySet<string> = new Set(['path', 'name', 'message'])

const PLACEHOLDER = /\$\{([^}]*)\}/g

/** Where a `${name}` placeholder appears: under which key, at which JSON pointer. */
export interface PlaceholderUse {
  name: string
  key: string
  at: string
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
        const replaced = child.replace(PLACEHOLDER, (_, name: string) =>
          visit({ name, key, at: childAt })
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

/**
 * A slug for a rule made from a template: its id and the instance picked,
 * numbered when another rule has it, so the same template can be used twice
 * for one instance.
 */
export function proposeSlug(
  templateId: string,
  instance: string | undefined,
  taken: ReadonlySet<string>
): string {
  const picked = instance === undefined ? '' : slugify(instance)
  const base = fitted(picked === '' ? templateId : `${templateId}-${picked}`, '')
  if (!taken.has(base)) return base
  for (let n = 2; ; n++) {
    const slug = fitted(base, `-${String(n)}`)
    if (!taken.has(slug)) return slug
  }
}

function pickErrors(template: Template, pick: TemplatePick): ValidationError[] {
  const open = new Set<OpenPart>(template.open ?? [])
  return OPEN_PARTS.flatMap((part): ValidationError[] => {
    const at = pointer('', part)
    if (open.has(part) && pick[part] === undefined)
      return [{ path: at, message: 'is required: the template leaves it open' }]
    if (!open.has(part) && pick[part] !== undefined)
      return [{ path: at, message: 'the template does not leave it open' }]
    if (part === 'instance' && pick.instance !== undefined && !INSTANCE_PICK.test(pick.instance))
      return [{ path: at, message: INSTANCE_PICK_MESSAGE }]
    return []
  })
}

/**
 * The rule a template makes with the picks for its open parts, unvalidated:
 * a pick can make a path that rule validation then refuses. The rule records
 * the set and template it came from, and takes a slug no rule in `taken` has.
 */
export function instantiate(
  set: { id: string; version: string },
  template: Template,
  pick: TemplatePick,
  taken: ReadonlySet<string> = new Set()
): Result<Record<string, unknown>> {
  const errors = pickErrors(template, pick)
  if (errors.length > 0) return { ok: false, errors }
  const { instance, source } = pick
  const substituted = substitutePlaceholders(template.rule, (use) =>
    use.name === INSTANCE_PLACEHOLDER && instance !== undefined ? instance : `\${${use.name}}`
  ) as Record<string, unknown>
  const { name, slug: _slug, template: _template, ...rest } = substituted
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
      slug: proposeSlug(template.id, instance, taken),
      ...rest,
      template: { set: set.id, id: template.id, version: set.version, pick: { ...pick } }
    }
  }
}
