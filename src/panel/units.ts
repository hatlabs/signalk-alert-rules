/**
 * Conversion between the numbers a user types and the SI numbers a rule
 * stores (docs/rules.md, Quantities).
 *
 * signalk-server resolves each path's display unit from the user's unit
 * preferences and returns it in `meta.displayUnits`, with the SI-to-display
 * conversion as a mathjs expression in `formula`. Rather than bundle mathjs,
 * the panel reads that expression as an affine map `scale * value + offset`,
 * which every standard conversion except Beaufort and the duration formatters
 * is. Interval and slope fields need that decomposition anyway: they convert
 * through the linear part alone.
 */

/**
 * How a field converts: `absolute` through the full formula, `interval`
 * through its linear part, `ratio` not at all, and `slope` through the linear
 * part and from per minute (display) to per second (SI).
 */
export type QuantityKind = 'absolute' | 'interval' | 'ratio' | 'slope'

/** The part of a path's meta that decides its display unit. */
export interface UnitMeta {
  units?: string
  displayUnits?: { formula: string; symbol: string }
}

/** A display unit as `display = scale * si + offset`. */
export interface DisplayUnit {
  symbol: string
  scale: number
  offset: number
  /** No display preference applies, so values are shown in the SI unit. */
  si: boolean
}

export interface Affine {
  scale: number
  offset: number
}

const SECONDS_PER_MINUTE = 60

/**
 * Conversion leaves float noise: 95 °C would be stored as 368.15000000000003
 * and 32 °F shown back as -4e-10. Rounding to a number of significant digits
 * measured against the larger operand, not the result, removes it even where
 * an offset cancels the value out. A stored value keeps 15 digits, close to
 * what a double holds, so showing it again loses nothing a user typed; a
 * shown value keeps 12, far beyond any sensor's precision.
 */
const SI_DIGITS = 15
const DISPLAY_DIGITS = 12

function round(result: number, magnitude: number, digits: number): number {
  if (result === 0 || magnitude === 0 || !Number.isFinite(result)) return result
  const exponent = (x: number) => Math.floor(Math.log10(Math.abs(x)))
  const kept = digits - (exponent(magnitude) - exponent(result))
  return kept < 1 ? 0 : Number(result.toPrecision(kept))
}

const TOKEN = /\s*(?:(\d+\.?\d*(?:e[+-]?\d+)?|\.\d+(?:e[+-]?\d+)?)|([A-Za-z_]\w*)|(\S))/iy

type Token = { kind: 'number'; value: number } | { kind: 'name' | 'symbol'; text: string }

function tokenize(formula: string): Token[] {
  const tokens: Token[] = []
  TOKEN.lastIndex = 0
  while (TOKEN.lastIndex < formula.length) {
    const match = TOKEN.exec(formula)
    if (match === null) break
    // Exactly one group matched; the others are undefined.
    const [, number, name, symbol] = match as (string | undefined)[]
    if (number !== undefined) tokens.push({ kind: 'number', value: Number(number) })
    else if (name !== undefined) tokens.push({ kind: 'name', text: name })
    else if (symbol !== undefined) tokens.push({ kind: 'symbol', text: symbol })
  }
  return tokens
}

const constant = (value: number): Affine => ({ scale: 0, offset: value })

/**
 * Evaluates a formula over affine forms of `value`, so the result is exact in
 * the formula's own constants. Returns null for anything that is not affine
 * in `value` or cannot be inverted.
 */
export function affine(formula: string): Affine | null {
  const tokens = tokenize(formula)
  let at = 0

  const next = (): Token | undefined => tokens[at]

  const peek = (text: string) => {
    const token = next()
    return token?.kind === 'symbol' && token.text === text
  }

  // Recursive descent; each level returns null once the formula is out of reach.
  const expression = (): Affine | null => {
    let left = term()
    while (left !== null && (peek('+') || peek('-'))) {
      const sign = peek('+') ? 1 : -1
      at++
      const right = term()
      if (right === null) return null
      left = { scale: left.scale + sign * right.scale, offset: left.offset + sign * right.offset }
    }
    return left
  }

  const term = (): Affine | null => {
    let left = unary()
    while (left !== null && (peek('*') || peek('/'))) {
      const multiply = peek('*')
      at++
      const right = unary()
      if (right === null) return null
      if (multiply) {
        if (left.scale !== 0 && right.scale !== 0) return null
        left =
          left.scale === 0
            ? { scale: right.scale * left.offset, offset: right.offset * left.offset }
            : { scale: left.scale * right.offset, offset: left.offset * right.offset }
      } else {
        if (right.scale !== 0 || right.offset === 0) return null
        left = { scale: left.scale / right.offset, offset: left.offset / right.offset }
      }
    }
    return left
  }

  const unary = (): Affine | null => {
    if (peek('-')) {
      at++
      const operand = unary()
      return operand === null ? null : { scale: -operand.scale, offset: -operand.offset }
    }
    return power()
  }

  const power = (): Affine | null => {
    const base = primary()
    if (base === null || !peek('^')) return base
    at++
    const exponent = unary()
    if (exponent === null || base.scale !== 0 || exponent.scale !== 0) return null
    return constant(base.offset ** exponent.offset)
  }

  const primary = (): Affine | null => {
    const token = next()
    if (token === undefined) return null
    at++
    if (token.kind === 'number') return constant(token.value)
    if (token.kind === 'name') return token.text === 'value' ? { scale: 1, offset: 0 } : null
    if (token.text !== '(') return null
    const inner = expression()
    if (inner === null || !peek(')')) return null
    at++
    return inner
  }

  const result = expression()
  if (result === null || at !== tokens.length) return null
  if (!Number.isFinite(result.scale) || !Number.isFinite(result.offset) || result.scale === 0) {
    return null
  }
  return result
}

/** The unit a path's values are entered and shown in. */
export function displayUnit(meta: UnitMeta): DisplayUnit {
  const conversion = meta.displayUnits === undefined ? null : affine(meta.displayUnits.formula)
  if (meta.displayUnits !== undefined && conversion !== null) {
    return { symbol: meta.displayUnits.symbol, ...conversion, si: false }
  }
  return { symbol: meta.units ?? '', scale: 1, offset: 0, si: true }
}

/** The factor from an SI value of this kind to its display value, before any offset. */
function factor(kind: QuantityKind, unit: DisplayUnit): number {
  switch (kind) {
    case 'ratio':
      return 1
    case 'slope':
      return unit.scale * SECONDS_PER_MINUTE
    case 'absolute':
    case 'interval':
      return unit.scale
  }
}

function offset(kind: QuantityKind, unit: DisplayUnit): number {
  return kind === 'absolute' ? unit.offset : 0
}

/** Whether a field of this kind shows a number other than the SI one. */
export function converts(kind: QuantityKind, unit: DisplayUnit): boolean {
  return factor(kind, unit) !== 1 || offset(kind, unit) !== 0
}

/** The SI value to store for a value entered in the display unit. */
export function toSI(kind: QuantityKind, value: number, unit: DisplayUnit): number {
  const shift = offset(kind, unit)
  const scale = factor(kind, unit)
  const magnitude = Math.max(Math.abs(value), Math.abs(shift)) / Math.abs(scale)
  return round((value - shift) / scale, magnitude, SI_DIGITS)
}

/** A stored SI value in the display unit. */
export function fromSI(kind: QuantityKind, value: number, unit: DisplayUnit): number {
  const scaled = value * factor(kind, unit)
  const shift = offset(kind, unit)
  return round(scaled + shift, Math.max(Math.abs(scaled), Math.abs(shift)), DISPLAY_DIGITS)
}

/** The label beside a field of this kind, naming SI explicitly when no preference applies. */
export function unitLabel(kind: QuantityKind, unit: DisplayUnit): string {
  if (kind === 'ratio') return ''
  const symbol = kind === 'slope' ? `${unit.symbol}/min` : unit.symbol
  if (!unit.si) return symbol
  return unit.symbol === '' ? 'SI' : `${symbol} (SI)`
}
