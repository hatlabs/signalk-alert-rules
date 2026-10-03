// @vitest-environment jsdom
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { cleanup, screen } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { kindOf } from '../../../src/panel/editor/conditionKinds'
import {
  fromRule,
  stepQuantity,
  type DurationField,
  type EventForm,
  type RuleForm,
  type SignalForm,
  type ValueField
} from '../../../src/panel/editor/formModel'
import {
  button,
  checkbox,
  choose,
  click,
  example,
  formShown,
  openMoreOptions,
  renderEditor,
  saved,
  select,
  textbox,
  type,
  units
} from './editorFixtures'

const SLUGS = readdirSync(join(import.meta.dirname, '../../../examples/rules'))
  .filter((f) => f.endsWith('.json'))
  .map((f) => f.slice(0, -'.json'.length))

function duration(label: string, value: DurationField) {
  if (value.amount === '') return
  type(textbox(label), value.amount)
  choose(`${label} unit`, value.unit)
}

/** Enters a value the way its control takes it: a choice of true or false, or typed. */
function value(label: string, v: ValueField) {
  if (screen.queryByRole('textbox', { name: label }) === null) {
    if (screen.queryByRole('combobox', { name: `${label} type` }) !== null) {
      choose(`${label} type`, v.type)
      if (v.type === 'number' || v.type === 'text') type(textbox(label), v.text)
    } else {
      choose(label, v.type)
    }
    return
  }
  type(textbox(label), v.text)
}

function event(label: string, e: EventForm) {
  choose(label, e.op)
  if (e.op === 'changesTo') value(`${label}: value`, e.value)
}

/** A combination, entered under More options. */
function combination(label: string, signal: SignalForm) {
  choose(`${label} combination`, signal.combinator)
  const angles = screen.queryByRole('checkbox', { name: /Values are angles/ })
  if (angles !== null && (angles as HTMLInputElement).checked !== signal.angular) click(angles)
  signal.slots.forEach((slot, i) => {
    const n = String(i + 1)
    if (screen.queryByRole('combobox', { name: `${label} path ${n}` }) === null) {
      click(button('Add path'))
    }
    type(select(`${label} path ${n}`), slot.path)
    if (slot.source !== '') choose(`Source for ${label.toLowerCase()} path ${n}`, slot.source)
  })
}

function conditionFields(form: RuleForm) {
  const d = form.detector
  switch (d.type) {
    case 'slope':
      choose('Changing', d.trend)
      duration('Over the last', d.window)
      break
    case 'projection':
      choose('Heading', d.trend)
      duration('Trend over the last', d.window)
      duration('Reaching the limit within', d.horizon)
      break
    case 'match':
      if (d.matchOp !== 'timedOut') choose('The value', d.matchOp)
      break
    case 'count':
      event('Count each time the value', d.event)
      duration('Within', d.window)
      break
    case 'absence':
      event('Expect the value to', d.event)
      break
    case 'accumulator':
      choose('Total of', d.measure)
      if (d.useWhile) {
        click(checkbox('Only while the value is…'))
        choose('Count while the value is', d.whileOp)
        value('Count while: value', d.whileValue)
      }
      if (d.useResetOn) {
        click(checkbox('Start the total again when…'))
        event('Start again when the value', d.resetOn)
      }
      break
    default:
      break
  }
}

function steps(form: RuleForm) {
  const quantity = stepQuantity(form.detector)
  form.steps.forEach((step, i) => {
    const n = String(i + 1)
    if (i > 0) click(button(/^Escalate/))
    choose(`Priority for step ${n}`, step.priority)
    if (quantity === 'time' || quantity === 'within') duration(`Limit for step ${n}`, step.duration)
    else if (quantity === 'match') value(`State for step ${n}`, step.value)
    else if (quantity !== 'none') type(textbox(`Limit for step ${n}`), step.limit)
  })
}

function moreOptions(form: RuleForm) {
  const d = form.detector
  if (d.hysteresis !== '' || d.clearDuration.amount !== '') {
    openMoreOptions()
    if (d.hysteresis !== '') type(textbox('Clear margin'), d.hysteresis)
    duration('Clear delay', d.clearDuration)
  }
  if (form.latching) {
    openMoreOptions()
    click(checkbox('Keep the alert until acknowledged'))
  }
  form.gates.forEach((gate, i) => {
    openMoreOptions()
    const name = `Condition ${String(i + 1)}`
    click(button('Add a condition'))
    if (gate.signal.mode === 'combine') throw new Error('no worked example combines a gate input')
    type(select(`${name} input path`), gate.signal.slots[0]?.path ?? '')
    choose(`${name} holds while the input is`, gate.direction)
    if (gate.limit.kind !== 'fixed') throw new Error('no worked example has a zone gate')
    type(textbox(`${name} limit`), gate.limit.value)
    duration(`${name}: for at least`, gate.duration)
    if (gate.hysteresis !== '') type(textbox(`${name} clear margin`), gate.hysteresis)
    duration(`${name}: stops holding after`, gate.clearDuration)
  })
}

/** Authors `form` from an empty editor, as a user would, field by field. */
function author(form: RuleForm) {
  const d = form.detector
  if (form.signal.mode === 'single') {
    const [slot] = form.signal.slots
    type(select('Search by name or path'), slot.path)
    if (slot.source !== '') choose('Source', slot.source)
  } else {
    openMoreOptions()
    click(checkbox('Combine with other paths'))
    combination('Combined', form.signal)
  }
  const kind = kindOf(d)
  if (kind === undefined) throw new Error('the example has no condition kind')
  choose('Alert when', kind)
  conditionFields(form)
  if (d.limit.kind === 'zone') {
    openMoreOptions()
    click(checkbox(/Use the value's zones/))
    choose('Starting at the zone', d.limit.level)
  } else {
    steps(form)
  }
  if (d.duration.amount !== '') {
    const label = screen.queryByRole('textbox', { name: 'Silent for at least' })
      ? 'Silent for at least'
      : form.steps.length > 1
        ? 'Each step must hold for at least'
        : 'For at least'
    duration(label, d.duration)
  }
  moreOptions(form)
  type(textbox(/^Message/), form.message)
  if (form.condition !== '') type(textbox(/^Condition name/), form.condition)
  type(textbox(/^Name/), form.name)
  if ((textbox('Slug') as HTMLInputElement).value !== form.slug) type(textbox('Slug'), form.slug)
}

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn()
})

describe('every worked example', () => {
  afterEach(cleanup)

  it.each(SLUGS)('%s can be created in the editor and saves as stored', async (slug) => {
    const rule = example(slug)
    const { api, onSaved } = renderEditor()
    await formShown()
    openMoreOptions()
    author(fromRule(rule, units))
    click(button('Create rule'))
    await saved(onSaved)
    expect(api.createRule).toHaveBeenCalledWith(rule)
  })
})
