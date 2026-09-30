import { describe, it, expect } from 'vitest'
import { AlertEmitter, HEARTBEAT_S, type AlertValue } from '../../src/alerts/emitter.js'
import { FakeAlertsCore } from '../helpers/FakeAlertsCore.js'

const PLUGIN = 'signalk-alert-rules'
const PATH = 'rules.user.oil-pressure-low'

const alarm: AlertValue = {
  priority: 'alarm',
  message: 'Engine oil pressure is low',
  latching: false,
  data: { rule: 'user.oil-pressure-low' }
}

function setup(options: { drop?: number } = {}) {
  const core = new FakeAlertsCore()
  const sent: [string, AlertValue | null][] = []
  let evidence = true
  let drop = options.drop ?? 0
  // The emitter gets no reader of core's alerts: what it sends never depends on core's state.
  const emitter = new AlertEmitter({
    send: (path, value) => {
      sent.push([path, value])
      // Core refuses a raise when its active set is full of more urgent alerts.
      if (drop > 0 && value !== null) drop--
      else core.ingest(PLUGIN, path, value)
    }
  })
  return {
    core,
    sent,
    emitter,
    evidence: () => evidence,
    setEvidence: (e: boolean) => {
      evidence = e
    }
  }
}

describe('alert emitter', () => {
  it('a condition entry emits one raise and its exit one clear', () => {
    const { core, sent, emitter, evidence } = setup()
    emitter.raise(PATH, alarm, evidence, 0)
    expect(sent).toEqual([[PATH, alarm]])
    emitter.clear(PATH)
    expect(sent.at(-1)).toEqual([PATH, null])
    expect(core.getByPath(PATH)).toMatchObject({ condition: false, state: 'rtn-unacknowledged' })
  })

  it('a heartbeat re-emits the identical value without changing what core stores', () => {
    const { core, sent, emitter, evidence } = setup()
    emitter.raise(PATH, alarm, evidence, 0)
    const writes = core.writes
    emitter.beat(HEARTBEAT_S - 1)
    expect(sent).toHaveLength(1)
    emitter.beat(HEARTBEAT_S)
    emitter.beat(2 * HEARTBEAT_S)
    expect(sent).toEqual([
      [PATH, alarm],
      [PATH, alarm],
      [PATH, alarm]
    ])
    expect(core.writes).toBe(writes)
    expect(core.alertings).toBe(1)
  })

  it('a clear sends one null and forgets the alert, whatever core then does with it', () => {
    const { core, sent, emitter, evidence } = setup()
    emitter.raise(PATH, alarm, evidence, 0)
    emitter.clear(PATH)
    emitter.beat(5 + HEARTBEAT_S)
    emitter.beat(5 + 2 * HEARTBEAT_S)
    expect(sent).toEqual([
      [PATH, alarm],
      [PATH, null]
    ])
    expect(emitter.status(PATH)).toBeUndefined()
    expect(core.getByPath(PATH)?.state).toBe('rtn-unacknowledged')
  })

  it('a latching raise is sent once and held nowhere: no heartbeat, repeat or clear follows', () => {
    const { core, sent, emitter, evidence } = setup()
    const event = { ...alarm, latching: true }
    emitter.raise(PATH, event, evidence, 0)
    emitter.beat(HEARTBEAT_S)
    emitter.repeat(PATH, HEARTBEAT_S + 1)
    emitter.beat(2 * HEARTBEAT_S)
    emitter.clear(PATH)
    expect(sent).toEqual([[PATH, event]])
    expect(emitter.status(PATH)).toBeUndefined()
    expect(core.getByPath(PATH)).toMatchObject({ condition: false, state: 'unacknowledged' })
  })

  it('without input evidence it stops heartbeating, so core can mark the alert stale', () => {
    const { sent, emitter, evidence, setEvidence } = setup()
    emitter.raise(PATH, alarm, evidence, 0)
    setEvidence(false)
    emitter.beat(HEARTBEAT_S)
    expect(sent).toHaveLength(1)
    expect(emitter.status(PATH)?.awaitingInput).toBe(true)
    setEvidence(true)
    emitter.beat(2 * HEARTBEAT_S)
    expect(sent).toEqual([
      [PATH, alarm],
      [PATH, alarm]
    ])
  })

  it('an active alert core does not hold as active is raised again by the next heartbeat', () => {
    const { core, sent, emitter, evidence } = setup({ drop: 1 })
    emitter.raise(PATH, alarm, evidence, 0)
    expect(core.getByPath(PATH)).toBeNull()
    emitter.beat(HEARTBEAT_S)
    expect(core.getByPath(PATH)?.condition).toBe(true)
    core.reportEnded('another-source', PATH)
    emitter.beat(2 * HEARTBEAT_S)
    expect(sent).toHaveLength(3)
    expect(core.getByPath(PATH)?.condition).toBe(true)
  })

  it('emits on a path another source raised, and clears it: core keys alerts on path alone', () => {
    const { core, sent, emitter, evidence } = setup()
    core.raiseFrom('other-plugin', PATH)
    emitter.raise(PATH, alarm, evidence, 0)
    expect(core.getByPath(PATH)?.$source).toBe(PLUGIN)
    emitter.clear(PATH)
    expect(sent).toEqual([
      [PATH, alarm],
      [PATH, null]
    ])
  })

  it('a revised header goes out with the next heartbeat and keeps the data of the raise', () => {
    const { core, sent, emitter, evidence } = setup()
    emitter.raise(PATH, alarm, evidence, 0)
    core.acknowledge(PATH)
    const header = { priority: 'emergency' as const, message: 'Check the oil', latching: false }
    emitter.revise(PATH, header)
    expect(sent).toHaveLength(1)
    emitter.beat(HEARTBEAT_S)
    expect(sent.at(-1)).toEqual([PATH, { ...header, data: alarm.data }])
    expect(core.getByPath(PATH)).toMatchObject({ ...header, state: 'unacknowledged' })
  })

  it('revising an alert it does not hold does nothing', () => {
    const { sent, emitter } = setup()
    emitter.revise(PATH, alarm)
    emitter.beat(HEARTBEAT_S)
    expect(sent).toEqual([])
    expect(emitter.status(PATH)).toBeUndefined()
  })

  it('a repeat emits an active alert at once and restarts its heartbeat', () => {
    const { sent, emitter, evidence } = setup()
    emitter.raise(PATH, alarm, evidence, 0)
    const header = { priority: 'emergency' as const, message: alarm.message, latching: false }
    emitter.revise(PATH, header)
    emitter.repeat(PATH, 7)
    expect(sent.at(-1)).toEqual([PATH, { ...header, data: alarm.data }])
    emitter.beat(HEARTBEAT_S)
    expect(sent).toHaveLength(2)
    emitter.beat(7 + HEARTBEAT_S)
    expect(sent).toHaveLength(3)
  })

  it('a repeat sends nothing without input evidence, or for an alert it does not hold', () => {
    const { sent, emitter, evidence, setEvidence } = setup()
    emitter.repeat(PATH, 0)
    emitter.raise(PATH, alarm, evidence, 0)
    setEvidence(false)
    emitter.repeat(PATH, 1)
    expect(sent).toHaveLength(1)
  })

  it("adopts an active alert with the rule's header and no data: one heartbeat at once, then only with evidence", () => {
    const { core, sent, emitter, evidence, setEvidence } = setup()
    core.ingest(PLUGIN, PATH, alarm)
    const adopted = core.getByPath(PATH)
    if (adopted === null) throw new Error('not raised')
    const { data: _data, ...header } = alarm
    setEvidence(false)
    emitter.adopt(adopted, header, evidence, 0)
    emitter.beat(HEARTBEAT_S)
    expect(sent).toEqual([[PATH, header]])
    expect(core.getByPath(PATH)?.data).toEqual(alarm.data)
    expect(core.alertings).toBe(1)
  })

  it('does not heartbeat an adopted alert core already marked stale, until evidence returns', () => {
    const { core, sent, emitter, evidence, setEvidence } = setup()
    core.ingest(PLUGIN, PATH, alarm)
    core.markStale(PATH)
    const stale = core.getByPath(PATH)
    if (stale === null) throw new Error('not raised')
    const { data: _data, ...header } = alarm
    setEvidence(false)
    emitter.adopt(stale, header, evidence, 0)
    expect(sent).toEqual([])
    setEvidence(true)
    emitter.beat(HEARTBEAT_S)
    expect(sent).toEqual([[PATH, header]])
  })
})
