import { describe, expect, it } from 'vitest'
import type { Template } from '../../../src/model/template'
import { validateRule } from '../../../src/model/validate'
import { copySettings, drafts, tabsHint } from '../../../src/panel/add/templateDrafts'
import { toRule } from '../../../src/panel/editor/formModel'
import { units } from '../editor/editorFixtures'

const set = { id: 'builtin', version: '1.0.0' }

const lifepo4: Template = {
  id: 'battery-voltage-low-lifepo4',
  open: ['instance'],
  condition: 'voltageLow',
  rule: {
    name: 'Battery ${instance} voltage low (LiFePO4)',
    message: 'Battery ${instance} voltage below {limit}: {value}',
    signal: { path: 'electrical.batteries.${instance}.voltage' },
    detector: {
      type: 'sustained',
      direction: 'below',
      steps: [
        { limit: 12.8, priority: 'warning' },
        { limit: 12, priority: 'alarm' }
      ],
      duration: 60,
      hysteresis: 0.1
    }
  }
}

describe('drafts', () => {
  it('makes one form per pick, with the template steps and a slug no rule has', () => {
    const made = drafts(
      set,
      lifepo4,
      [{ instance: 'house' }, { instance: 'windlass' }],
      new Set(['battery-voltage-low-lifepo4-house']),
      units
    )
    expect(made.map((d) => d.form.slug)).toEqual([
      'battery-voltage-low-lifepo4-house-2',
      'battery-voltage-low-lifepo4-windlass'
    ])
    const house = made.at(0)
    expect(house?.form.name).toBe('Battery house voltage low (LiFePO4)')
    expect(house?.form.steps.map((s) => [s.limit, s.priority])).toEqual([
      ['12.8', 'warning'],
      ['12', 'alarm']
    ])
    const rule = house === undefined ? undefined : toRule(house.form, units)
    expect(rule?.ok && validateRule(rule.rule).ok).toBe(true)
    expect(rule?.ok && rule.rule).toMatchObject({
      condition: 'voltageLow',
      signal: { path: 'electrical.batteries.house.voltage' },
      template: { set: 'builtin', id: lifepo4.id, version: '1.0.0', pick: { instance: 'house' } }
    })
  })

  it('leaves out a pick the template cannot take', () => {
    expect(drafts(set, lifepo4, [{ source: 'x' }, { instance: 'a.b' }], new Set(), units)).toEqual(
      []
    )
  })
})

describe('copySettings', () => {
  it('overwrites the condition, steps, duration and priority but not the name, message or value', () => {
    const made = drafts(
      set,
      lifepo4,
      [{ instance: 'house' }, { instance: 'starter' }],
      new Set(),
      units
    )
    const first = made.at(0)
    const second = made.at(1)
    const step = first?.form.steps.at(0)
    if (first === undefined || second === undefined || step === undefined) throw new Error('none')
    const edited = {
      ...first.form,
      steps: [{ ...step, limit: '12.5', priority: 'alarm' as const }],
      detector: { ...first.form.detector, duration: { amount: '2', unit: 'min' as const } },
      name: 'House',
      message: 'house message'
    }
    const copied = copySettings(edited, second.form, units)
    if (copied === undefined) throw new Error('not copied')
    expect(copied.steps.map((s) => [s.limit, s.priority])).toEqual([['12.5', 'alarm']])
    expect(copied.detector.duration).toEqual({ amount: '2', unit: 'min' })
    expect(copied.name).toBe(second.form.name)
    expect(copied.message).toBe(second.form.message)
    expect(copied.slug).toBe(second.form.slug)
    expect(copied.signal).toEqual(second.form.signal)
    expect(copied.template).toEqual(second.form.template)
    // The copy is the target's own: editing it later leaves the source alone.
    expect(copied.steps).not.toBe(edited.steps)
    expect(copied.detector).not.toBe(edited.detector)
  })

  const coolant: Template = {
    id: 'coolant-high',
    open: ['instance'],
    rule: {
      name: 'Engine ${instance} coolant high',
      message: 'm',
      signal: { path: 'propulsion.${instance}.coolantTemperature' },
      detector: {
        type: 'sustained',
        direction: 'above',
        steps: [{ limit: 368.15, priority: 'warning' }],
        hysteresis: 2
      }
    }
  }
  // The port engine reports in °C; one typed in reports nothing yet, so its values are in kelvin.
  const engines = () =>
    drafts(set, coolant, [{ instance: 'port' }, { instance: 'aux' }], new Set(), units).map(
      (d) => d.form
    )

  it('carries the values across tabs shown in different units', () => {
    const all = engines()
    const port = all.at(0)
    const aux = all.at(1)
    if (port === undefined || aux === undefined) throw new Error('none')
    expect(port.steps.map((s) => s.limit)).toEqual(['95'])
    expect(aux.steps.map((s) => s.limit)).toEqual(['368.15'])
    const step = port.steps.at(0)
    if (step === undefined) throw new Error('no step')
    const copied = copySettings({ ...port, steps: [{ ...step, limit: '100' }] }, aux, units)
    expect(copied?.steps.map((s) => s.limit)).toEqual(['373.15'])
    expect(copied?.detector.hysteresis).toBe('2')
  })

  it('carries the exact value of a limit shown rounded', () => {
    const exact: Template = {
      ...coolant,
      rule: {
        ...coolant.rule,
        detector: {
          type: 'sustained',
          direction: 'above',
          steps: [{ limit: 368.4567, priority: 'warning' }]
        }
      }
    }
    const made = drafts(
      set,
      exact,
      [{ instance: 'port' }, { instance: 'starboard' }],
      new Set(),
      units
    )
    const port = made.at(0)?.form
    const starboard = made.at(1)?.form
    if (port === undefined || starboard === undefined) throw new Error('none')
    expect(port.steps.map((s) => s.limit)).toEqual(['95.31'])
    const edited = {
      ...port,
      detector: { ...port.detector, duration: { amount: '2', unit: 'min' as const } }
    }
    const copied = copySettings(edited, starboard, units)
    if (copied === undefined) throw new Error('not copied')
    const read = toRule(copied, units)
    expect(read.ok && read.rule.detector.steps).toEqual([{ limit: 368.4567, priority: 'warning' }])
  })

  it('copies nothing across units while the shown tab cannot be read', () => {
    const all = engines()
    const port = all.at(0)
    const aux = all.at(1)
    if (port === undefined || aux === undefined) throw new Error('none')
    const step = port.steps.at(0)
    if (step === undefined) throw new Error('no step')
    expect(copySettings({ ...port, steps: [{ ...step, limit: '' }] }, aux, units)).toBeUndefined()
  })
})

describe('tabsHint', () => {
  it('names each tab with something missing or wrong', () => {
    const form = drafts(set, lifepo4, [{ instance: 'house' }], new Set(), units).at(0)?.form
    if (form === undefined) throw new Error('no draft')
    expect(
      tabsHint([
        { label: 'house', form, errors: [] },
        {
          label: 'windlass',
          form,
          errors: [{ path: '/detector/steps/0/limit', message: 'is required' }]
        },
        { label: 'starter', form, errors: [{ path: '/name', message: 'is too long' }] }
      ])
    ).toBe('Fill in step 1 on windlass and fix the name on starter to save.')
    expect(tabsHint([{ label: 'house', form, errors: [] }])).toBeUndefined()
  })
})
