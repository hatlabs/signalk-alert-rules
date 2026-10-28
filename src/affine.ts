/**
 * A unit conversion formula read as `scale * value + offset`. signalk-server
 * gives each display unit's SI-to-display conversion as a mathjs expression;
 * every standard one except Beaufort and the duration formatters is affine,
 * and reading it as such needs no mathjs. Shared by the webapp and the alert
 * messages the plugin renders.
 */
export interface Affine {
  scale: number
  offset: number
}

/** A display unit as `display = scale * si + offset`. */
export interface DisplayConversion extends Affine {
  symbol: string
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
