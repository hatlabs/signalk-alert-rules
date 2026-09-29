import Type, { type Static } from 'typebox'
import {
  MAX_RULES,
  MAX_SLUG_LENGTH,
  PATTERN_MESSAGE_KEY,
  QUANTITY_KEY,
  SLUG_MESSAGE,
  SLUG_PATTERN,
  ruleSchemas
} from './rule.js'

export const MAX_PARAMETERS = 32

/** Origin of user-authored rules; no ruleset may take it as its slug. */
export const USER_ORIGIN = 'user'

const PARAMETER_NAME_PATTERN = '^[A-Za-z][A-Za-z0-9_]*$'

/** Stands in for a number in a ruleset rule; resolved from the parameter's value. */
export const ParamRefSchema = Type.Object(
  { param: Type.String({ pattern: PARAMETER_NAME_PATTERN }) },
  { additionalProperties: false }
)
export type ParamRef = Static<typeof ParamRefSchema>

const rulesetRuleSchemas = ruleSchemas((quantity, options) =>
  Type.Union([Type.Number({ ...options, [QUANTITY_KEY]: quantity }), ParamRefSchema])
)

const ParameterSchema = Type.Object(
  {
    name: Type.String({ pattern: PARAMETER_NAME_PATTERN }),
    type: Type.Union([Type.Literal('number'), Type.Literal('string')]),
    description: Type.Optional(Type.String()),
    /** SI unit of a number parameter, for display-unit entry in the panel. */
    unit: Type.Optional(Type.String()),
    default: Type.Union([Type.Number(), Type.String()]),
    minimum: Type.Optional(Type.Number()),
    maximum: Type.Optional(Type.Number())
  },
  { additionalProperties: false }
)
export type Parameter = Static<typeof ParameterSchema>

/**
 * A ruleset's rules reference number parameters as `{ "param": name }` and
 * string parameters inside paths as `${name}`, so a provider whose path prefix
 * is configurable can ship one ruleset.
 */
export const RulesetSchema = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 200 }),
    slug: Type.String({
      maxLength: MAX_SLUG_LENGTH,
      pattern: SLUG_PATTERN,
      [PATTERN_MESSAGE_KEY]: SLUG_MESSAGE
    }),
    version: Type.String({ minLength: 1 }),
    description: Type.Optional(Type.String()),
    parameters: Type.Optional(Type.Array(ParameterSchema, { maxItems: MAX_PARAMETERS })),
    rules: Type.Array(rulesetRuleSchemas.Rule, { maxItems: MAX_RULES })
  },
  { additionalProperties: false }
)
export type Ruleset = Static<typeof RulesetSchema>
export type RulesetRule = Static<typeof rulesetRuleSchemas.Rule>

export type ParameterValues = Record<string, unknown>
