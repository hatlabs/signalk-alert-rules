import Type, { type Static } from 'typebox'
import { MAX_RULES, MAX_VERSION_LENGTH, slugSchema, type TemplatePick } from './rule.js'
import {
  checkSchema,
  prefixed,
  validateRule,
  type Result,
  type ValidationError
} from './validate.js'
import {
  INSTANCE_PLACEHOLDER,
  OPEN_PARTS,
  OPEN_SOURCE_MESSAGE,
  instantiate,
  substitutePlaceholders,
  type PlaceholderUse
} from '../templates/instantiate.js'
import { isRecord, pointer } from '../util.js'

/**
 * A rule whose instance segment, written `${instance}` in its paths, its
 * user picks, or whose input's source they pick, or both. With nothing open
 * it is fully bound. `${instance}` may also appear in the name and message.
 * The slug and the template record are set when the template is used.
 */
export const TemplateSchema = Type.Object(
  {
    id: slugSchema(),
    description: Type.Optional(Type.String({ maxLength: 1000 })),
    open: Type.Optional(Type.Array(Type.Enum(OPEN_PARTS), { maxItems: OPEN_PARTS.length })),
    rule: Type.Record(Type.String(), Type.Unknown())
  },
  { additionalProperties: false }
)
export type Template = Static<typeof TemplateSchema>

/** A template set file: one built into SKAR, others from packages and the drop-in directory. */
export const TemplateSetSchema = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 200 }),
    id: slugSchema(),
    version: Type.String({ minLength: 1, maxLength: MAX_VERSION_LENGTH }),
    description: Type.Optional(Type.String({ maxLength: 1000 })),
    templates: Type.Array(TemplateSchema, { maxItems: MAX_RULES })
  },
  { additionalProperties: false }
)
export type TemplateSet = Static<typeof TemplateSetSchema>

/** What a template's open parts are checked with: any valid path segment and source. */
const SAMPLE = 'sample'

function samplePick(template: Template): TemplatePick {
  const open = template.open ?? []
  return {
    ...(open.includes('instance') ? { instance: SAMPLE } : {}),
    ...(open.includes('source') ? { source: SAMPLE } : {})
  }
}

function placeholderUses(rule: Template['rule']): PlaceholderUse[] {
  const uses: PlaceholderUse[] = []
  substitutePlaceholders(rule, (use) => {
    uses.push(use)
    return ''
  })
  return uses
}

/** The slug and the template record belong to the rule each use of the template makes. */
function presetFieldErrors(template: Template, ruleAt: string): ValidationError[] {
  const errors: ValidationError[] = []
  if (template.rule.slug !== undefined)
    errors.push({ path: pointer(ruleAt, 'slug'), message: 'is chosen when the template is used' })
  if (template.rule.template !== undefined) {
    const message = 'is recorded when the template is used'
    errors.push({ path: pointer(ruleAt, 'template'), message })
  }
  return errors
}

function unknownPlaceholderErrors(uses: PlaceholderUse[], ruleAt: string): ValidationError[] {
  return uses
    .filter((use) => use.name !== INSTANCE_PLACEHOLDER)
    .map((use) => ({
      path: ruleAt + use.at,
      message: `unknown placeholder \${${use.name}}; only \${instance} is substituted`
    }))
}

/** The open list against the rule's `${instance}` placeholders and its signal. */
function openErrors(template: Template, uses: PlaceholderUse[], at: string): ValidationError[] {
  const errors: ValidationError[] = []
  const open = template.open ?? []
  const openAt = pointer(at, 'open')
  open.forEach((part, i) => {
    if (open.indexOf(part) !== i)
      errors.push({ path: pointer(openAt, i), message: `${part} is listed twice` })
  })
  const instanceUses = uses.filter((use) => use.name === INSTANCE_PLACEHOLDER)
  if (!open.includes('instance')) {
    const ruleAt = pointer(at, 'rule')
    for (const use of instanceUses)
      errors.push({ path: ruleAt + use.at, message: '${instance} needs instance in open' })
  } else if (!instanceUses.some((use) => use.key === 'path')) {
    errors.push({ path: openAt, message: 'an open instance needs ${instance} in a path' })
  }
  const { signal } = template.rule
  if (open.includes('source') && !(isRecord(signal) && typeof signal.path === 'string'))
    errors.push({ path: openAt, message: OPEN_SOURCE_MESSAGE })
  return errors
}

/** A template's own problems, then the rule it makes with a sample pick, validated. */
function templateErrors(set: TemplateSet, template: Template, at: string): ValidationError[] {
  const ruleAt = pointer(at, 'rule')
  const uses = placeholderUses(template.rule)
  const errors = [
    ...openErrors(template, uses, at),
    ...presetFieldErrors(template, ruleAt),
    ...unknownPlaceholderErrors(uses, ruleAt)
  ]
  if (errors.length > 0) return errors
  const made = instantiate(set, template, samplePick(template))
  // The sample pick fills exactly the open parts, and openErrors has checked
  // the signal an open source needs: instantiate has nothing left to refuse.
  if (!made.ok) throw new Error(`template ${template.id} refused its sample pick`)
  const result = validateRule(made.value)
  return result.ok ? [] : prefixed(result.errors, ruleAt)
}

/** Validates a template set document: its schema, its template ids, and each template. */
export function validateTemplateSet(input: unknown): Result<TemplateSet> {
  const schema = checkSchema(TemplateSetSchema, input)
  if (schema.length > 0) return { ok: false, errors: schema }
  const set = input as TemplateSet
  const errors: ValidationError[] = []
  const ids = new Set<string>()
  set.templates.forEach((template, i) => {
    const at = pointer('/templates', i)
    if (ids.has(template.id)) {
      errors.push({ path: pointer(at, 'id'), message: `${template.id} is used twice` })
      return
    }
    ids.add(template.id)
    errors.push(...templateErrors(set, template, at))
  })
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: set }
}
