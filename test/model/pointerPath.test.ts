import { describe, expect, it } from 'vitest'
import {
  FIELD_ZONES_LEVEL_MESSAGE,
  FIELD_ZONES_MESSAGE,
  FIELD_ZONES_PATH_MESSAGE,
  POINTER_MESSAGE,
  POINTER_TOKEN_MESSAGE,
  fieldZonesError,
  isPointerPath,
  pathSegments,
  resolvePointer,
  splitPointerPath
} from '../../src/model/pointerPath.js'

describe('splitPointerPath', () => {
  it('reads a plain path as its own base, with no field', () => {
    expect(splitPointerPath('navigation.attitude')).toEqual({
      valid: true,
      basePath: 'navigation.attitude',
      tokens: []
    })
  })

  it('splits a field path at "#" into the base path and the pointer tokens', () => {
    expect(splitPointerPath('navigation.attitude#/roll')).toEqual({
      valid: true,
      basePath: 'navigation.attitude',
      tokens: ['roll']
    })
    expect(splitPointerPath('a.b#/c/d')).toEqual({
      valid: true,
      basePath: 'a.b',
      tokens: ['c', 'd']
    })
  })

  it('decodes ~1 to "/" and ~0 to "~", in that order', () => {
    expect(splitPointerPath('a#/x~1y')).toMatchObject({ tokens: ['x/y'] })
    expect(splitPointerPath('a#/x~0y')).toMatchObject({ tokens: ['x~y'] })
    // ~01 is an escaped "~" followed by "1", not an escaped "/".
    expect(splitPointerPath('a#/x~01')).toMatchObject({ tokens: ['x~1'] })
  })

  it.each([
    ['an empty pointer', 'navigation.attitude#'],
    ['a pointer not starting with "/"', 'navigation.attitude#roll'],
    ['an empty field name', 'navigation.attitude#/'],
    ['an empty field name between others', 'a#/b//c'],
    ['a stray "~"', 'a#/x~2'],
    ['a trailing "~"', 'a#/x~'],
    ['a second "#"', 'a#/b#/c']
  ])('refuses %s with the pointer message, keeping the base path', (_case, path) => {
    expect(splitPointerPath(path)).toEqual({
      valid: false,
      basePath: path.slice(0, path.indexOf('#')),
      message: POINTER_MESSAGE
    })
  })

  it.each([
    ['a dot', 'a#/b.c'],
    ['a space', 'a#/b c'],
    ['a tab', 'a#/b\tc'],
    ['a wildcard', 'a#/*'],
    ['a dot escaped in another token', 'a#/b/c.d']
  ])('refuses a field name with %s, which would not be one path segment', (_case, path) => {
    expect(splitPointerPath(path)).toEqual({
      valid: false,
      basePath: 'a',
      message: POINTER_TOKEN_MESSAGE
    })
  })

  it('accepts a decoded "/", which the alert path sanitises as it does other characters', () => {
    expect(splitPointerPath('a#/b~1c')).toMatchObject({ valid: true, tokens: ['b/c'] })
  })

  it('words its messages as Skip does', () => {
    expect(POINTER_MESSAGE).toBe(
      'After "#", write the field name starting with "/", for example "#/roll".'
    )
  })
})

describe('isPointerPath', () => {
  it('tells a path that addresses a field', () => {
    expect(isPointerPath('navigation.attitude#/roll')).toBe(true)
    expect(isPointerPath('navigation.attitude#')).toBe(true)
    expect(isPointerPath('navigation.attitude')).toBe(false)
  })
})

describe('pathSegments', () => {
  it("is a plain path's dot-separated segments", () => {
    expect(pathSegments('propulsion.*.revolutions')).toEqual(['propulsion', '*', 'revolutions'])
  })

  it("is a field path's base segments followed by its pointer tokens", () => {
    expect(pathSegments('navigation.attitude#/roll')).toEqual(['navigation', 'attitude', 'roll'])
    expect(pathSegments('propulsion.*.x#/a~1b/c')).toEqual(['propulsion', '*', 'x', 'a/b', 'c'])
  })

  it('is undefined for an invalid pointer', () => {
    expect(pathSegments('navigation.attitude#roll')).toBeUndefined()
  })
})

describe('resolvePointer', () => {
  const attitude = { roll: 0.1, pitch: -0.2, yaw: 3, nested: { a: { b: 7 } }, empty: null }

  it('is the whole value for no tokens', () => {
    expect(resolvePointer(attitude, [])).toBe(attitude)
  })

  it('walks the tokens into nested objects', () => {
    expect(resolvePointer(attitude, ['roll'])).toBe(0.1)
    expect(resolvePointer(attitude, ['nested', 'a', 'b'])).toBe(7)
    expect(resolvePointer(attitude, ['empty'])).toBeNull()
  })

  it('is undefined for a field the value does not have', () => {
    expect(resolvePointer(attitude, ['heel'])).toBeUndefined()
    expect(resolvePointer(attitude, ['roll', 'x'])).toBeUndefined()
    expect(resolvePointer(null, ['roll'])).toBeUndefined()
    expect(resolvePointer(12, ['roll'])).toBeUndefined()
    expect(resolvePointer([1, 2], ['0'])).toBeUndefined()
  })

  it('reads own fields only, never what an object inherits', () => {
    expect(resolvePointer(attitude, ['__proto__'])).toBeUndefined()
    expect(resolvePointer(attitude, ['constructor'])).toBeUndefined()
    expect(resolvePointer(attitude, ['toString'])).toBeUndefined()
  })
})

describe('fieldZonesError', () => {
  const ROLL = 'navigation.attitude#/roll'
  const VOLTS = 'electrical.batteries.house.voltage'

  it("puts a limit taking a field signal's own zones at the limit, worded for its place", () => {
    expect(fieldZonesError(undefined, ROLL, FIELD_ZONES_MESSAGE)).toEqual({
      at: 'limit',
      message: FIELD_ZONES_MESSAGE
    })
    expect(fieldZonesError(undefined, ROLL, FIELD_ZONES_LEVEL_MESSAGE)).toEqual({
      at: 'limit',
      message: FIELD_ZONES_LEVEL_MESSAGE
    })
  })

  it('puts a field named as the zones path at the path', () => {
    expect(fieldZonesError(ROLL, VOLTS, FIELD_ZONES_MESSAGE)).toEqual({
      at: 'path',
      message: FIELD_ZONES_PATH_MESSAGE
    })
    expect(fieldZonesError(ROLL, undefined, FIELD_ZONES_MESSAGE)).toEqual({
      at: 'path',
      message: FIELD_ZONES_PATH_MESSAGE
    })
  })

  it('finds nothing wrong with zones from a plain path, or a pointer that is not one', () => {
    expect(fieldZonesError(undefined, VOLTS, FIELD_ZONES_MESSAGE)).toBeUndefined()
    expect(fieldZonesError(VOLTS, ROLL, FIELD_ZONES_MESSAGE)).toBeUndefined()
    expect(fieldZonesError(undefined, undefined, FIELD_ZONES_MESSAGE)).toBeUndefined()
    expect(fieldZonesError('navigation.attitude#roll', VOLTS, FIELD_ZONES_MESSAGE)).toBeUndefined()
  })
})
