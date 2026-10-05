import Type, { type Static } from 'typebox'
import {
  MAX_RULES,
  MAX_SLOT_NAME_LENGTH,
  MAX_SLOTS,
  MAX_VERSION_LENGTH,
  PATTERN_MESSAGE_KEY,
  SLOT_NAME_MESSAGE,
  SLOT_NAME_PATTERN,
  SOURCE_PICK,
  slugSchema,
  type TemplatePick
} from './rule.js'
import { MAX_ALERT_PATH_LENGTH } from '../alerts/paths.js'
import { CONDITION_POINTER } from './alertPath.js'
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
  slotsOf,
  substitutePlaceholders,
  type PlaceholderUse
} from '../templates/instantiate.js'
import { isRecord, pointer } from '../util.js'

const MAX_SLOT_LABEL_LENGTH = 40

/** An open path segment of a template, written `${<name>}`, which its user picks. */
const SlotSchema = Type.Object(
  {
    name: Type.String({
      maxLength: MAX_SLOT_NAME_LENGTH,
      pattern: SLOT_NAME_PATTERN,
      [PATTERN_MESSAGE_KEY]: SLOT_NAME_MESSAGE
    }),
    /** What the user picks for the slot, such as `Battery`. */
    label: Type.String({ minLength: 1, maxLength: MAX_SLOT_LABEL_LENGTH })
  },
  { additionalProperties: false }
)
export type Slot = Static<typeof SlotSchema>

/**
 * A rule whose path segments named by its slots, written `${<slot>}` in its
 * paths, its user picks, or whose input's source they pick, or both. With
 * nothing open it is fully bound. `open: [instance]` declares the one slot
 * `instance`. A slot may also appear in the name, message and condition.
 * The slug and the template record are set when the template is used.
 */
export const TemplateSchema = Type.Object(
  {
    id: slugSchema(),
    description: Type.Optional(Type.String({ maxLength: 1000 })),
    /**
     * The condition name of the rule each use makes, which the rule stores:
     * the last segment of its alert path, under the parent its input gives.
     * `voltageLow` names `electrical.batteries.<pick>.voltageLow`. Absent,
     * the rule stores none and its name is the default of its input and
     * detector; a combined signal has none, so its template needs one. It is
     * checked as a condition name once its slots are filled in.
     */
    condition: Type.Optional(Type.String({ maxLength: MAX_ALERT_PATH_LENGTH })),
    slots: Type.Optional(Type.Array(SlotSchema, { maxItems: MAX_SLOTS })),
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
  return {
    ...Object.fromEntries(slotsOf(template).map((slot) => [slot.name, SAMPLE])),
    ...(template.open?.includes('source') ? { [SOURCE_PICK]: SAMPLE } : {})
  }
}

/** Every placeholder in the template's condition and rule, at pointers into the template. */
function placeholderUses(template: Template): PlaceholderUse[] {
  const uses: PlaceholderUse[] = []
  substitutePlaceholders({ condition: template.condition, rule: template.rule }, (use) => {
    uses.push(use)
    return ''
  })
  return uses
}

/**
 * The slug and the template record belong to the rule each use of the
 * template makes, and its condition name is the template's own.
 */
function presetFieldErrors(template: Template, ruleAt: string): ValidationError[] {
  const errors: ValidationError[] = []
  if (template.rule.slug !== undefined)
    errors.push({ path: pointer(ruleAt, 'slug'), message: 'is chosen when the template is used' })
  if (template.rule.template !== undefined) {
    const message = 'is recorded when the template is used'
    errors.push({ path: pointer(ruleAt, 'template'), message })
  }
  if (template.rule.condition !== undefined) {
    const message = "is given as the template's condition"
    errors.push({ path: pointer(ruleAt, 'condition'), message })
  }
  return errors
}

const placeholder = (name: string) => `\${${name}}`

function unknownPlaceholderErrors(
  template: Template,
  uses: PlaceholderUse[],
  at: string
): ValidationError[] {
  // Without slots, `${instance}` is checked against the open list instead.
  const known = new Set(
    template.slots === undefined ? [INSTANCE_PLACEHOLDER] : template.slots.map((s) => s.name)
  )
  const parameters =
    template.slots === undefined
      ? '${instance} is the only one'
      : template.slots.length === 0
        ? 'the template declares no slots'
        : `the slots are ${template.slots.map((s) => placeholder(s.name)).join(', ')}`
  return uses
    .filter((use) => !known.has(use.name))
    .map((use) => ({
      path: at + use.at,
      message:
        `${placeholder(use.name)} is not a template parameter; ${parameters}` +
        ' (message placeholders such as {value} are written without $)'
    }))
}

/** Declared slots: names, labels, and a whole path segment in at least one path each. */
function slotErrors(template: Template, uses: PlaceholderUse[], at: string): ValidationError[] {
  // A template without slots has at most the one `open: [instance]` gives,
  // which openErrors checks.
  if (template.slots === undefined) return []
  const errors: ValidationError[] = []
  const slots = template.slots
  const slotsAt = pointer(at, 'slots')
  slots.forEach((slot, i) => {
    const slotAt = pointer(slotsAt, i)
    if (slot.name === SOURCE_PICK) {
      errors.push({
        path: pointer(slotAt, 'name'),
        message: 'source is reserved for the open source'
      })
    } else if (slots.findIndex((s) => s.name === slot.name) !== i) {
      errors.push({ path: pointer(slotAt, 'name'), message: `${slot.name} is declared twice` })
    }
    if (slots.findIndex((s) => s.label === slot.label) !== i)
      errors.push({ path: pointer(slotAt, 'label'), message: `${slot.label} labels another slot` })
    if (!uses.some((use) => use.name === slot.name && use.key === 'path'))
      errors.push({ path: slotAt, message: `a slot needs ${placeholder(slot.name)} in a path` })
  })
  const names = new Set(slots.map((s) => s.name))
  for (const use of uses) {
    if (use.key === 'path' && names.has(use.name) && !use.segment && !use.inPointer) {
      const message = `${placeholder(use.name)} must be a whole path segment`
      errors.push({ path: at + use.at, message })
    }
  }
  return errors
}

/**
 * A placeholder in a field pointer: a pick may hold `/` or `~`, which would
 * name another field there, so the field is the template's to name.
 */
function pointerPlaceholderErrors(uses: PlaceholderUse[], at: string): ValidationError[] {
  return uses
    .filter((use) => use.key === 'path' && use.inPointer)
    .map((use) => ({
      path: at + use.at,
      message: `${placeholder(use.name)} cannot be in the field pointer after "#"`
    }))
}

/** The open list against the rule's `${instance}` placeholders, the slots and the signal. */
function openErrors(template: Template, uses: PlaceholderUse[], at: string): ValidationError[] {
  const errors: ValidationError[] = []
  const open = template.open ?? []
  const openAt = pointer(at, 'open')
  open.forEach((part, i) => {
    if (open.indexOf(part) !== i)
      errors.push({ path: pointer(openAt, i), message: `${part} is listed twice` })
  })
  const instanceUses = uses.filter((use) => use.name === INSTANCE_PLACEHOLDER)
  if (template.slots !== undefined) {
    const i = open.indexOf('instance')
    if (i >= 0) {
      const message = 'an open instance cannot be combined with slots; declare it as a slot'
      errors.push({ path: pointer(openAt, i), message })
    }
  } else if (!open.includes('instance')) {
    for (const use of instanceUses)
      errors.push({ path: at + use.at, message: '${instance} needs instance in open' })
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
  const uses = placeholderUses(template)
  const errors = [
    ...openErrors(template, uses, at),
    ...slotErrors(template, uses, at),
    ...pointerPlaceholderErrors(uses, at),
    ...presetFieldErrors(template, ruleAt),
    ...unknownPlaceholderErrors(template, uses, at)
  ]
  if (errors.length > 0) return errors
  const made = instantiate(set, template, samplePick(template))
  // The sample pick fills exactly the open parts, and openErrors has checked
  // the signal an open source needs: instantiate has nothing left to refuse.
  if (!made.ok) throw new Error(`template ${template.id} refused its sample pick`)
  const result = validateRule(made.value)
  if (result.ok) return []
  // The rule's condition name is the template's, so its errors are reported there.
  return result.errors.flatMap((e) => prefixed([e], e.path === CONDITION_POINTER ? at : ruleAt))
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
