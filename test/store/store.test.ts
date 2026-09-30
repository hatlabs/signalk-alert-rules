import * as fs from 'node:fs'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Rule } from '../../src/model/rule.js'
import { validateRule } from '../../src/model/validate.js'
import { Store, type FileSystem } from '../../src/store/store.js'

function valid(rule: unknown): Rule {
  const result = validateRule(rule)
  if (!result.ok) throw new Error(JSON.stringify(result.errors))
  return result.value
}

const oil = valid({
  name: 'Oil pressure low',
  slug: 'oil-pressure-low',
  message: 'Engine oil pressure is low',
  priority: 'alarm',
  signal: { path: 'propulsion.main.oilPressure' },
  detector: {
    type: 'sustained',
    direction: 'below',
    limit: { kind: 'fixed', value: 100000 },
    duration: 5
  }
})

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'skar-store-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('store', () => {
  it('starts empty with evaluation enabled in a fresh data directory', () => {
    const contents = new Store(dir).load()
    expect(contents).toEqual({
      rules: [],
      evaluation: { enabled: true },
      accumulators: {},
      log: [],
      issues: []
    })
  })

  it('round-trips the action log', () => {
    const store = new Store(dir)
    store.load()
    const log = [
      { at: '2026-09-30T12:00:00.000Z', actor: 'admin', action: 'delete', rule: 'user.oil' },
      { at: '2026-09-30T12:01:00.000Z', actor: 'admin', action: 'reset', rule: 'user.hours' },
      {
        at: '2026-09-30T12:02:00.000Z',
        actor: 'unauthenticated',
        action: 'evaluation',
        enabled: false
      }
    ] as const
    store.saveLog([...log])
    expect(new Store(dir).load().log).toEqual(log)
  })

  it('moves aside a log with an entry it does not recognise', () => {
    const store = new Store(dir)
    store.load()
    writeFileSync(
      join(dir, 'log.json'),
      JSON.stringify([{ at: '2026-09-30T12:00:00.000Z', actor: 'admin', action: 'explode' }])
    )
    const contents = new Store(dir).load()
    expect(contents.log).toEqual([])
    expect(contents.issues).toEqual([expect.stringMatching(/log\.json/)])
  })

  it('round-trips rules, the evaluation switch and accumulator checkpoints', () => {
    const store = new Store(dir)
    store.load()
    store.saveRule(oil)
    store.saveEvaluation({ enabled: false, actor: 'admin', at: '2026-09-30T12:00:00.000Z' })
    store.saveCheckpoints({ 'user.engine-hours': { '': 3600, port: 12.5 } })

    const contents = new Store(dir).load()
    expect(contents.rules).toEqual([{ slug: 'oil-pressure-low', value: oil }])
    expect(contents.evaluation).toEqual({
      enabled: false,
      actor: 'admin',
      at: '2026-09-30T12:00:00.000Z'
    })
    expect(contents.accumulators).toEqual({ 'user.engine-hours': { '': 3600, port: 12.5 } })
    expect(contents.issues).toEqual([])
  })

  it('replaces a saved rule, last write wins', () => {
    const store = new Store(dir)
    store.load()
    store.saveRule(oil)
    store.saveRule({ ...oil, message: 'Check the oil' })
    expect(new Store(dir).load().rules).toEqual([
      { slug: 'oil-pressure-low', value: { ...oil, message: 'Check the oil' } }
    ])
  })

  it('deletes a rule, and deleting a missing one is no error', () => {
    const store = new Store(dir)
    store.load()
    store.saveRule(oil)
    store.deleteRule('oil-pressure-low')
    store.deleteRule('oil-pressure-low')
    expect(new Store(dir).load().rules).toEqual([])
  })

  it('refuses a slug that could name a file outside the rules directory', () => {
    const store = new Store(dir)
    store.load()
    expect(() => {
      store.deleteRule('../evaluation')
    }).toThrow(/slug/)
    expect(() => {
      store.saveRule({ ...oil, slug: '../../escape' })
    }).toThrow(/slug/)
  })

  it('leaves the previous file intact when a write fails midway', () => {
    const failing: FileSystem = {
      ...fs,
      writeSync: (fd, data) => {
        // Half the bytes reach the disk before the failure.
        fs.writeSync(fd, data.slice(0, Math.floor(data.length / 2)))
        throw new Error('ENOSPC: no space left on device')
      }
    }
    const good = new Store(dir)
    good.load()
    good.saveRule(oil)
    good.saveCheckpoints({ 'user.engine-hours': { '': 100 } })

    const store = new Store(dir, failing)
    store.load()
    expect(() => {
      store.saveRule({ ...oil, message: 'changed' })
    }).toThrow(/ENOSPC/)
    expect(() => {
      store.saveCheckpoints({ 'user.engine-hours': { '': 200 } })
    }).toThrow(/ENOSPC/)

    const contents = new Store(dir).load()
    expect(contents.rules).toEqual([{ slug: 'oil-pressure-low', value: oil }])
    expect(contents.accumulators).toEqual({ 'user.engine-hours': { '': 100 } })
    expect(contents.issues).toEqual([])
    // The half-written temporary file is not left behind.
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([])
    expect(readdirSync(join(dir, 'rules')).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })

  it('moves a corrupt file aside, reports it and starts that part empty', () => {
    const store = new Store(dir)
    store.load()
    store.saveRule(oil)
    writeFileSync(join(dir, 'accumulators.json'), '{"user.engine-hours": {"": 1')
    writeFileSync(join(dir, 'evaluation.json'), '{"enabled": "yes"}')
    writeFileSync(join(dir, 'rules', 'broken.json'), 'not json')

    const contents = new Store(dir).load()
    expect(contents.rules).toEqual([{ slug: 'oil-pressure-low', value: oil }])
    expect(contents.accumulators).toEqual({})
    expect(contents.evaluation).toEqual({ enabled: true })
    expect(contents.issues).toHaveLength(3)
    expect(contents.issues.join('\n')).toMatch(/accumulators\.json.*accumulators\.json\.corrupt-/)
    expect(contents.issues.join('\n')).toMatch(/evaluation\.json/)
    expect(contents.issues.join('\n')).toMatch(/broken\.json/)

    // The bad content is kept for inspection and not read again.
    const aside = readdirSync(dir).find((f) => f.startsWith('accumulators.json.corrupt-'))
    expect(aside).toBeDefined()
    expect(readFileSync(join(dir, aside ?? ''), 'utf8')).toBe('{"user.engine-hours": {"": 1')
    expect(new Store(dir).load().issues).toEqual([])
  })

  it('returns a parseable rule as stored and leaves validating it to the caller', () => {
    const store = new Store(dir)
    store.load()
    writeFileSync(join(dir, 'rules', 'old-rule.json'), JSON.stringify({ slug: 'old-rule' }))
    expect(new Store(dir).load().rules).toEqual([{ slug: 'old-rule', value: { slug: 'old-rule' } }])
  })

  it('removes temporary files an interrupted write left behind', () => {
    const store = new Store(dir)
    store.load()
    writeFileSync(join(dir, '.accumulators.json.123.tmp'), '{')
    writeFileSync(join(dir, 'rules', '.oil-pressure-low.json.123.tmp'), '{')
    const contents = new Store(dir).load()
    expect(contents.issues).toEqual([])
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([])
    expect(readdirSync(join(dir, 'rules')).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })
})
