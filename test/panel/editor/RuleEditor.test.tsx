// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { LEVEL_PRIORITY, type Rule } from '../../../src/model/rule'
import { RuleRejectedError, type EditPreview } from '../../../src/panel/api'
import { ZONE_PRIORITY } from '../../../src/panel/editor/MoreOptions'
import type { PathSource } from '../../../src/panel/paths/selfPaths'
import { instance, ruleEntry } from '../fixtures'
import {
  button,
  checkbox,
  choose,
  click,
  description,
  distance,
  example,
  formShown,
  noChange,
  openMoreOptions,
  renderEditor,
  reported,
  saved,
  select,
  textbox,
  type,
  type FakeApi
} from './editorFixtures'

const HOUSE = 'electrical.batteries.house.voltage'

const create = () => {
  click(button('Create rule'))
}

/** Fills a new below-a-limit rule on the house battery to where it can be saved. */
function fillBelow(limit = '11.8') {
  choose('Priority for step 1', 'warning')
  type(textbox('Limit for step 1'), limit)
}

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn()
})

describe('RuleEditor, from a path', () => {
  afterEach(() => {
    cleanup()
    window.history.replaceState(null, '', '/')
  })

  it('shows the limit and duration of below a limit, with no limit filled in', async () => {
    renderEditor({ start: { path: HOUSE, kind: 'below' } })
    await formShown()
    expect(screen.getByRole('heading', { name: 'New rule' })).toBeTruthy()
    expect(select('Alert when')).toHaveProperty('value', 'below')
    expect(textbox('Limit for step 1')).toHaveProperty('value', '')
    expect(textbox('For at least')).toHaveProperty('value', '')
    expect(screen.getByText('House battery voltage')).toBeTruthy()
  })

  it('saves a sustained rule with its limit in SI', async () => {
    const { api, onSaved } = renderEditor({
      start: { path: 'propulsion.port.coolantTemperature', kind: 'above' }
    })
    await formShown()
    choose('Priority for step 1', 'alarm')
    type(textbox('Limit for step 1'), '95')
    type(textbox('For at least'), '2')
    choose('For at least unit', 'min')
    create()
    await saved(onSaved)
    const [[rule]] = api.createRule.mock.calls
    expect(rule.signal).toEqual({ path: 'propulsion.port.coolantTemperature' })
    expect(rule.detector).toMatchObject({ type: 'sustained', direction: 'above', duration: 120 })
    const steps = rule.detector.type === 'sustained' ? rule.detector.steps : undefined
    expect(steps?.[0]?.priority).toBe('alarm')
    expect(steps?.[0]?.limit).toBeCloseTo(368.15)
  })

  it('writes the message from the limit until the message is edited', async () => {
    renderEditor({ start: { path: HOUSE, kind: 'below' } })
    await formShown()
    fillBelow('11.8')
    expect(textbox(/^Message/)).toHaveProperty(
      'value',
      'House battery voltage below 11.8 V: {value}'
    )
    expect(textbox(/^Name/)).toHaveProperty('value', 'House battery voltage low')
    type(textbox('Limit for step 1'), '12')
    expect(textbox(/^Message/)).toHaveProperty('value', 'House battery voltage below 12 V: {value}')
    type(textbox(/^Message/), 'House battery is low')
    type(textbox('Limit for step 1'), '11.5')
    expect(textbox(/^Message/)).toHaveProperty('value', 'House battery is low')
  })

  it('previews the message with the value now, and warns of brace text sent as written', async () => {
    renderEditor({ start: { path: HOUSE, kind: 'below' } })
    await formShown()
    fillBelow()
    expect(description(textbox(/^Message/))).toContain(
      'Sends now: “House battery voltage below 11.8 V: 13.31 V”'
    )
    type(textbox(/^Message/), 'Low {volts}')
    expect(description(textbox(/^Message/))).toContain('{volts} is sent as written.')
  })

  it('says whether the value now would alert, and at which priority', async () => {
    renderEditor({ start: { path: HOUSE, kind: 'below' } })
    await formShown()
    fillBelow('11.8')
    expect(screen.getByText(/Now 13\.31 V: would not alert\./)).toBeTruthy()
    type(textbox('Limit for step 1'), '13.5')
    expect(screen.getByText(/Now 13\.31 V: would alert as a warning\./)).toBeTruthy()
  })

  it('says what the chosen priority means', async () => {
    renderEditor({ start: { path: HOUSE, kind: 'below' } })
    await formShown()
    choose('Priority for step 1', 'caution')
    expect(
      screen.getByText(
        /requires attention, not immediately hazardous\. Needs no acknowledgement; makes no sound\./
      )
    ).toBeTruthy()
    choose('Priority for step 1', 'warning')
    expect(
      screen.getByText(
        /requires attention for precautionary reasons\. Must be acknowledged; sounds briefly\./
      )
    ).toBeTruthy()
  })

  it('leaves no fields of the earlier kind behind when the kind changes', async () => {
    const { api, onSaved } = renderEditor({ start: { path: HOUSE, kind: 'often' } })
    await formShown()
    choose('Count each time the value', 'changes')
    type(textbox('Within'), '1')
    choose('Within unit', 'h')
    choose('Priority for step 1', 'warning')
    type(textbox('Limit for step 1'), '4')
    choose('Alert when', 'below')
    expect(screen.queryByRole('textbox', { name: 'Within' })).toBeNull()
    expect(textbox('Limit for step 1')).toHaveProperty('value', '')
    // The priority chosen stays: only the limit means something else.
    expect(select('Priority for step 1')).toHaveProperty('value', 'warning')
    type(textbox('Limit for step 1'), '11.8')
    create()
    await saved(onSaved)
    expect(api.createRule.mock.calls[0]?.[0].detector).toEqual({
      type: 'sustained',
      direction: 'below',
      steps: [{ limit: 11.8, priority: 'warning' }]
    })
  })

  it('escalates through further steps and saves them in order', async () => {
    const { api, onSaved } = renderEditor({ start: { path: HOUSE, kind: 'below' } })
    await formShown()
    fillBelow('12.2')
    click(button('Escalate at…'))
    expect(select('Priority for step 2')).toHaveProperty('value', 'alarm')
    type(textbox('Limit for step 2'), '11.8')
    expect(textbox(/^Message/)).toHaveProperty(
      'value',
      'House battery voltage below {limit}: {value}'
    )
    expect(textbox('Each step must hold for at least')).toBeTruthy()
    create()
    await saved(onSaved)
    expect(api.createRule.mock.calls[0]?.[0].detector).toMatchObject({
      steps: [
        { limit: 12.2, priority: 'warning' },
        { limit: 11.8, priority: 'alarm' }
      ]
    })
  })

  it('removes a later step', async () => {
    renderEditor({ start: { path: HOUSE, kind: 'below' } })
    await formShown()
    fillBelow()
    click(button('Escalate at…'))
    click(button('Remove step 2'))
    expect(screen.queryByRole('combobox', { name: 'Priority for step 2' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Remove step 1' })).toBeNull()
  })

  it('names a step out of order by the limit it must pass and whose it is', async () => {
    const { api } = renderEditor({ start: { path: HOUSE, kind: 'below' } })
    api.createRule.mockRejectedValueOnce(
      new RuleRejectedError('invalid request body', [
        { path: '/detector/steps/1/limit', message: "must be below the previous step's limit" }
      ])
    )
    await formShown()
    fillBelow('12.2')
    click(button('Escalate at…'))
    type(textbox('Limit for step 2'), '12.5')
    create()
    await waitFor(() => {
      expect(textbox('Limit for step 2').getAttribute('aria-invalid')).toBe('true')
    })
    expect(description(textbox('Limit for step 2'))).toContain(
      "Step 2: an alarm must be below 12.2 V, the warning's limit."
    )
  })

  it('offers each reporting source and the preferred one', async () => {
    renderEditor({ start: { path: 'navigation.speedOverGround', kind: 'above' } })
    await formShown()
    const options = within(select('Source'))
      .getAllByRole('option')
      .map((o) => o.textContent)
    expect(options).toEqual([
      "Preferred source (server's choice): gnss.stern",
      'gnss.bow',
      'gnss.stern'
    ])
    expect(description(select('Source'))).toContain('2 devices report this value.')
  })

  it('asks for the field a step misses', async () => {
    renderEditor({ start: { path: HOUSE, kind: 'below' } })
    await formShown()
    type(textbox('Limit for step 1'), '11.8')
    create()
    const priority = description(select('Priority for step 1'))
    expect(priority).toContain('Choose a priority')
    expect(priority).not.toContain('limit')
    choose('Priority for step 1', 'warning')
    type(textbox('Limit for step 1'), '')
    create()
    expect(description(textbox('Limit for step 1'))).toContain('Fill in the limit')
  })

  it('asks for a missing state as a state', async () => {
    renderEditor({ start: { path: HOUSE, kind: 'state' } })
    await formShown()
    choose('Priority for step 1', 'warning')
    create()
    expect(description(textbox('State for step 1'))).toContain('Fill in the state')
    expect(screen.getByText('Fill in the state to save.')).toBeTruthy()
  })

  it('has the browser ask before unloading only once the form has changes', async () => {
    const unload = () => {
      const event = new Event('beforeunload', { cancelable: true })
      window.dispatchEvent(event)
      return event.defaultPrevented
    }
    renderEditor({ start: { path: HOUSE, kind: 'below' } })
    await formShown()
    expect(unload()).toBe(false)
    type(textbox('Limit for step 1'), '11.8')
    expect(unload()).toBe(true)
  })

  it('takes a state of a text value as text, with no unit', async () => {
    renderEditor({ start: { path: 'propulsion.port.state', kind: 'state' } })
    await formShown()
    const state = textbox('State for step 1')
    expect(state.getAttribute('inputmode')).toBeNull()
    expect(state.parentElement?.textContent).not.toContain('SI')
  })

  it('drops the step errors when a step is removed', async () => {
    renderEditor({ start: { path: HOUSE, kind: 'below' } })
    await formShown()
    fillBelow('12.2')
    click(button('Escalate at…'))
    create()
    expect(textbox('Limit for step 2').getAttribute('aria-invalid')).toBe('true')
    click(button('Remove step 2'))
    expect(screen.queryByText(/detector\/steps/)).toBeNull()
    click(button('Escalate at…'))
    expect(textbox('Limit for step 2').getAttribute('aria-invalid')).toBeNull()
  })

  it('names a missing limit before asking the server', async () => {
    const { api } = renderEditor({ start: { path: HOUSE, kind: 'below' } })
    await formShown()
    choose('Priority for step 1', 'warning')
    create()
    expect(screen.getByText('Fill in the limit to save.')).toBeTruthy()
    expect(textbox('Limit for step 1').getAttribute('aria-invalid')).toBe('true')
    expect(api.createRule).not.toHaveBeenCalled()
  })

  it("shows the server's errors on their fields", async () => {
    const { api, onSaved } = renderEditor({ start: { path: HOUSE, kind: 'below' } })
    api.createRule.mockRejectedValueOnce(
      new RuleRejectedError('invalid request body', [
        { path: '/detector/duration', message: 'must be at most 86400' }
      ])
    )
    await formShown()
    fillBelow()
    type(textbox('For at least'), '100000')
    create()
    await waitFor(() => {
      expect(description(textbox('For at least'))).toContain('must be at most 86400')
    })
    expect(screen.getByText('Fix how long it must hold to save.')).toBeTruthy()
    expect(onSaved).not.toHaveBeenCalled()
  })

  it('opens More options when the server refuses a field in it', async () => {
    const { api } = renderEditor({ start: { path: HOUSE, kind: 'below' } })
    api.createRule.mockRejectedValueOnce(
      new RuleRejectedError('invalid request body', [
        { path: '/detector/hysteresis', message: 'must be at most 5' }
      ])
    )
    await formShown()
    fillBelow()
    const more = screen.getByText('More options').closest('details')
    expect(more?.open).toBe(false)
    create()
    await waitFor(() => {
      expect(more?.open).toBe(true)
    })
    expect(description(textbox('Clear margin'))).toContain('must be at most 5')
  })

  it('names the rule that holds the alert path, offering to add a step to it instead', async () => {
    const { api } = renderEditor({
      start: { path: HOUSE, kind: 'below' },
      ruleName: (slug) => (slug === 'battery-alarm' ? 'Battery alarm' : undefined),
      editHref: (slug) => `#edit=${slug}`
    })
    api.createRule.mockRejectedValueOnce(
      new RuleRejectedError('conflict', [
        {
          path: '/condition',
          message:
            'makes an alert path overlapping that of rule battery-alarm; each rule needs its own'
        }
      ])
    )
    await formShown()
    fillBelow()
    create()
    await waitFor(() => {
      expect(description(textbox(/^Condition name/))).toContain(
        'Another rule uses this alert path: Battery alarm. Give this condition its own name.'
      )
    })
    expect(screen.getByRole('link', { name: 'Battery alarm' }).getAttribute('href')).toBe(
      '#edit=battery-alarm'
    )
  })

  it('shows a save that failed without field errors, keeping the form to try again', async () => {
    const { api, onSaved } = renderEditor({ start: { path: HOUSE, kind: 'below' } })
    api.createRule.mockRejectedValueOnce(new Error('/rules did not answer in time'))
    await formShown()
    fillBelow()
    create()
    expect((await screen.findByRole('alert')).textContent).toBe('/rules did not answer in time')
    expect(onSaved).not.toHaveBeenCalled()
    create()
    await saved(onSaved)
  })

  it('uses the zones of the value in place of the steps', async () => {
    const { api, onSaved } = renderEditor({ start: { path: HOUSE, kind: 'below' } })
    await formShown()
    openMoreOptions()
    click(checkbox(/Use the value's zones/))
    choose('Starting at the zone', 'warn')
    expect(screen.queryByRole('combobox', { name: 'Priority for step 1' })).toBeNull()
    expect(screen.getByText("Set by the value's zones, under More options.")).toBeTruthy()
    expect(screen.getByText(/warn zone:/)).toBeTruthy()
    expect(screen.getByText(/alarm zone:/)).toBeTruthy()
    create()
    await saved(onSaved)
    expect(api.createRule.mock.calls[0]?.[0].detector).toEqual({
      type: 'sustained',
      direction: 'below',
      limit: { kind: 'zone', level: 'warn' }
    })
  })

  it('asks before leaving with unsaved changes, by Cancel or the back link', async () => {
    const { onClose } = renderEditor({ start: { path: HOUSE, kind: 'below' } })
    await formShown()
    fillBelow()
    click(button('Cancel'))
    const dialog = screen.getByRole('alertdialog', { name: 'Discard your changes?' })
    click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('alertdialog')).toBeNull()
    fireEvent.click(screen.getByRole('link', { name: 'Alert rules' }))
    expect(screen.getByRole('alertdialog', { name: 'Discard your changes?' })).toBeTruthy()
    click(button('Discard changes'))
    await waitFor(() => {
      expect(window.location.hash).toBe('#back')
    })
    expect(onClose).not.toHaveBeenCalled()
  })

  it('returns focus to what opened the leave prompt when the prompt is cancelled', async () => {
    renderEditor({ start: { path: HOUSE, kind: 'below' } })
    await formShown()
    fillBelow()
    const keepEditing = () => {
      const dialog = screen.getByRole('alertdialog', { name: 'Discard your changes?' })
      click(within(dialog).getByRole('button', { name: 'Cancel' }))
    }
    button('Cancel').focus()
    click(button('Cancel'))
    keepEditing()
    expect(document.activeElement).toBe(button('Cancel'))
    const back = screen.getByRole('link', { name: 'Alert rules' })
    back.focus()
    fireEvent.click(back)
    keepEditing()
    expect(document.activeElement).toBe(back)
  })

  it('moves focus into the path search on Change, and back to Change on Done', async () => {
    renderEditor({ start: { path: HOUSE, kind: 'below' } })
    await formShown()
    click(button('Change the value to watch'))
    expect(document.activeElement).toBe(select('Search by name or path'))
    click(button('Done'))
    expect(document.activeElement).toBe(button('Change the value to watch'))
  })

  it('focuses the first field in error when Save finds the form incomplete', async () => {
    renderEditor({ start: { path: HOUSE, kind: 'below' } })
    await formShown()
    choose('Priority for step 1', 'warning')
    create()
    expect(document.activeElement).toBe(textbox('Limit for step 1'))
  })

  it('focuses the first field the server refuses', async () => {
    const { api } = renderEditor({ start: { path: HOUSE, kind: 'below' } })
    api.createRule.mockRejectedValueOnce(
      new RuleRejectedError('invalid request body', [
        { path: '/detector/duration', message: 'must be at most 86400' }
      ])
    )
    await formShown()
    fillBelow()
    type(textbox('For at least'), '100000')
    button('Create rule').focus()
    create()
    await waitFor(() => {
      expect(document.activeElement).toBe(textbox('For at least'))
    })
  })

  it('leaves at once without changes', async () => {
    const { onClose } = renderEditor({ start: { path: HOUSE, kind: 'below' } })
    await formShown()
    click(button('Cancel'))
    expect(onClose).toHaveBeenCalled()
  })

  it('keeps the path search open while a path is typed', async () => {
    renderEditor()
    await formShown()
    type(select('Search by name or path'), 'e')
    expect(select('Search by name or path')).toHaveProperty('value', 'e')
  })

  it('changes the value watched, keeping a source the new value also reports', async () => {
    renderEditor({ start: { path: 'navigation.speedOverGround', kind: 'above' } })
    await formShown()
    choose('Source', 'gnss.bow')
    click(button('Change the value to watch'))
    type(select('Search by name or path'), 'navigation.position')
    expect(select('Source')).toHaveProperty('value', 'gnss.bow')
    type(select('Search by name or path'), HOUSE)
    expect(select('Source')).toHaveProperty('value', '')
    click(button('Done'))
    expect(screen.getByText(HOUSE)).toBeTruthy()
  })

  it('matches every instance, naming the instance in the message hint', async () => {
    renderEditor({ start: { path: HOUSE, kind: 'below' } })
    await formShown()
    openMoreOptions()
    click(checkbox('Every instance, one alert each'))
    expect(screen.getByText('electrical.batteries.*.voltage')).toBeTruthy()
    expect(description(textbox(/^Message/))).toContain('{instance} the instance')
  })
})

describe('RuleEditor, editing', () => {
  afterEach(cleanup)

  const battery = example('house-battery-low')
  const stepped: Rule = {
    ...battery,
    detector: {
      type: 'sustained',
      direction: 'below',
      steps: [
        { limit: 12.2, priority: 'warning' },
        { limit: 11.8, priority: 'alarm' }
      ],
      duration: 60
    }
  }
  const active = ruleEntry({
    slug: battery.slug,
    rule: { name: battery.name },
    status: {
      condition: 'alerting',
      reason: 'alertActive',
      instances: [instance({ condition: 'alerting', reason: 'alertActive' })]
    }
  })
  const clears: EditPreview = {
    restarts: true,
    changes: ['signal'],
    activeAlerts: 1,
    clearsActiveAlert: true,
    discardsTotal: false
  }

  it('opens with the stored values, More options open where they are used, and no slug', async () => {
    renderEditor({ editing: { entry: active, rule: battery } })
    await formShown()
    expect(screen.getByRole('heading', { name: 'Edit “House battery low”' })).toBeTruthy()
    expect(screen.getByText('More options').closest('details')?.open).toBe(true)
    expect(textbox('Clear margin')).toHaveProperty('value', '0.2')
    expect(textbox('For at least')).toHaveProperty('value', '1')
    expect(screen.queryByRole('textbox', { name: 'Slug' })).toBeNull()
    expect(button('Save')).toBeTruthy()
  })

  it('opens every stored step and saves them as changed', async () => {
    const { api } = renderEditor({ editing: { entry: active, rule: stepped } })
    await formShown()
    expect(textbox('Limit for step 2')).toHaveProperty('value', '11.8')
    type(textbox('Limit for step 1'), '12.4')
    click(button('Save'))
    await waitFor(() => {
      expect(api.previewRule).toHaveBeenCalled()
    })
    expect(api.previewRule.mock.calls[0]?.[1].detector).toMatchObject({
      steps: [
        { limit: 12.4, priority: 'warning' },
        { limit: 11.8, priority: 'alarm' }
      ]
    })
  })

  it.each(['engine-stopped', 'coolant-temperature-rising'])(
    'opens More options on the latching or gate of %s and saves it unchanged',
    async (slug) => {
      const rule = example(slug)
      const { api, onSaved } = renderEditor({
        editing: { entry: ruleEntry({ slug }), rule }
      })
      await formShown()
      expect(screen.getByText('More options').closest('details')?.open).toBe(true)
      click(button('Save'))
      await saved(onSaved)
      expect(api.updateRule).toHaveBeenCalledWith(slug, rule)
    }
  )

  it.each([
    ['reporting now', 'gnss.bow'],
    ['not reporting now', 'gnss.masthead']
  ])('lists a pinned source %s once, and keeps it', async (_, source) => {
    const pinned: Rule = {
      ...stepped,
      signal: { path: 'navigation.speedOverGround', source },
      detector: {
        type: 'sustained',
        direction: 'above',
        steps: [{ limit: 5, priority: 'caution' }]
      }
    }
    const { api, onSaved } = renderEditor({ editing: { entry: active, rule: pinned } })
    await formShown()
    const options = within(select('Source'))
      .getAllByRole('option')
      .map((o) => o.textContent)
    expect(options.filter((o) => o === source)).toHaveLength(1)
    expect(select('Source')).toHaveProperty('value', source)
    click(button('Save'))
    await saved(onSaved)
    expect(api.updateRule.mock.calls[0]?.[1].signal).toEqual(pinned.signal)
  })

  it('confirms an edit that clears an active alert, naming the consequence', async () => {
    const { api, onSaved } = renderEditor({ editing: { entry: active, rule: stepped } })
    api.previewRule.mockResolvedValueOnce(clears)
    await formShown()
    click(button('Change the value to watch'))
    type(select('Search by name or path'), 'electrical.batteries.start.voltage')
    click(button('Save'))
    const dialog = await screen.findByRole('alertdialog', { name: 'Save “House battery low”?' })
    expect(dialog.textContent).toContain(
      'Saving clears the active alert of this rule and restarts it, because its input changed.'
    )
    expect(api.updateRule).not.toHaveBeenCalled()
    click(within(dialog).getByRole('button', { name: 'Save' }))
    await saved(onSaved)
    expect(api.updateRule.mock.calls[0]?.[1].signal).toEqual({
      path: 'electrical.batteries.start.voltage'
    })
  })

  it('drops the confirmation when a field changes under it', async () => {
    const { api } = renderEditor({ editing: { entry: active, rule: stepped } })
    api.previewRule.mockResolvedValue(clears)
    await formShown()
    type(textbox('Limit for step 1'), '12.4')
    click(button('Save'))
    await screen.findByRole('alertdialog')
    type(textbox('Limit for step 1'), '12.5')
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  async function confirmed(api: FakeApi) {
    api.previewRule.mockResolvedValueOnce(clears)
    await formShown()
    type(textbox('Limit for step 1'), '12.4')
    click(button('Save'))
    click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Save' }))
  }

  it('closes the confirmation on a refusal and marks the refused field', async () => {
    const { api, onSaved } = renderEditor({ editing: { entry: active, rule: stepped } })
    api.updateRule.mockRejectedValueOnce(
      new RuleRejectedError('invalid request body', [
        { path: '/detector/steps/0/limit', message: 'must be a number' }
      ])
    )
    await confirmed(api)
    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).toBeNull()
    })
    expect(description(textbox('Limit for step 1'))).toContain('must be a number')
    expect(onSaved).not.toHaveBeenCalled()
  })

  it('returns focus to Save when the confirmation is cancelled', async () => {
    const { api } = renderEditor({ editing: { entry: active, rule: stepped } })
    api.previewRule.mockResolvedValueOnce(clears)
    await formShown()
    type(textbox('Limit for step 1'), '12.4')
    button('Save').focus()
    click(button('Save'))
    const dialog = await screen.findByRole('alertdialog')
    click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(document.activeElement).toBe(button('Save'))
  })

  it('focuses the refused field when the confirmation closes on a refusal', async () => {
    const { api } = renderEditor({ editing: { entry: active, rule: stepped } })
    api.updateRule.mockRejectedValueOnce(
      new RuleRejectedError('invalid request body', [
        { path: '/detector/steps/0/limit', message: 'must be a number' }
      ])
    )
    await confirmed(api)
    await waitFor(() => {
      expect(document.activeElement).toBe(textbox('Limit for step 1'))
    })
  })

  it('keeps the confirmation open with a failure that names no field', async () => {
    const { api, onSaved } = renderEditor({ editing: { entry: active, rule: stepped } })
    api.updateRule.mockRejectedValueOnce(new Error('/rules/x answered 503'))
    await confirmed(api)
    const dialog = screen.getByRole('alertdialog')
    await waitFor(() => {
      expect(within(dialog).getByRole('alert').textContent).toBe('/rules/x answered 503')
    })
    expect(onSaved).not.toHaveBeenCalled()
  })

  it('names the accumulated total an edit discards', async () => {
    const hours = example('engine-service-due')
    const entry = ruleEntry({
      slug: hours.slug,
      rule: { name: hours.name, detector: { type: 'accumulator', measure: 'time' } },
      status: { instances: [instance({ progress: { kind: 'total', total: 7200, limit: 900000 } })] }
    })
    const { api } = renderEditor({ editing: { entry, rule: hours } })
    api.previewRule.mockResolvedValueOnce({ ...noChange, restarts: true, discardsTotal: true })
    await formShown()
    choose('Total of', 'integral')
    type(textbox('Limit for step 1'), '100')
    click(button('Save'))
    const dialog = await screen.findByRole('alertdialog')
    expect(dialog.textContent).toContain('Saving discards the accumulated total 2 h.')
    expect(api.updateRule).not.toHaveBeenCalled()
  })

  it('follows the default condition name until one is typed, then keeps it', async () => {
    renderEditor({ editing: { entry: active, rule: stepped } })
    await formShown()
    const condition = textbox(/^Condition name/)
    expect(condition).toHaveProperty('value', '')
    expect(condition).toHaveProperty('placeholder', 'voltageLow')
    choose('Alert when', 'above')
    expect(condition).toHaveProperty('placeholder', 'voltageHigh')
    type(condition, 'overvoltage')
    choose('Alert when', 'below')
    expect(condition).toHaveProperty('value', 'overvoltage')
  })

  it('saves an edit applied in place without asking', async () => {
    const { api, onSaved } = renderEditor({ editing: { entry: active, rule: battery } })
    await formShown()
    type(textbox('Clear margin'), '0.3')
    click(button('Save'))
    await saved(onSaved)
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(api.previewRule).toHaveBeenCalledWith('house-battery-low', {
      ...battery,
      detector: { ...battery.detector, hysteresis: 0.3 }
    })
  })

  it('saves nothing on Enter in a field; only the Save button saves', async () => {
    const { api, onSaved } = renderEditor({ editing: { entry: active, rule: battery } })
    await formShown()
    type(textbox('Clear margin'), '0.3')
    // What a browser does on Enter, or a tablet keyboard's Go, in a text field.
    fireEvent.submit(screen.getByRole('form'))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(api.previewRule).not.toHaveBeenCalled()
    expect(onSaved).not.toHaveBeenCalled()
  })
})

describe('RuleEditor, an invalid stored rule', () => {
  afterEach(cleanup)

  const battery = example('house-battery-low')

  it('opens with its errors on their fields and saves once fixed, without a preview', async () => {
    const { api, onSaved } = renderEditor({
      invalid: {
        slug: battery.slug,
        name: battery.name,
        body: { ...battery, detector: { ...battery.detector, duration: -5 } },
        errors: [{ path: '/detector/duration', message: 'must be at least 0' }]
      }
    })
    await formShown()
    expect(screen.getByRole('heading', { name: 'Fix “House battery low”' })).toBeTruthy()
    expect(description(textbox('For at least'))).toContain('must be at least 0')
    type(textbox('For at least'), '1')
    choose('For at least unit', 'min')
    click(button('Save'))
    await saved(onSaved)
    expect(api.previewRule).not.toHaveBeenCalled()
    expect(api.updateRule).toHaveBeenCalledWith(battery.slug, battery)
  })

  it('opens a body it cannot read as a form with its name and message', async () => {
    renderEditor({
      invalid: {
        slug: 'odd',
        name: 'Odd',
        body: { name: 'Odd', message: 'Hello', detector: { type: 'nonsense' } },
        errors: [{ path: '/detector/type', message: 'is not a known detector' }]
      }
    })
    await formShown()
    expect(textbox(/^Name/)).toHaveProperty('value', 'Odd')
    expect(textbox(/^Message/)).toHaveProperty('value', 'Hello')
  })

  it('opens a rule-shaped body without a message, asking for one', async () => {
    const { message: _message, ...body } = battery
    renderEditor({
      invalid: {
        slug: battery.slug,
        name: battery.name,
        body,
        errors: [{ path: '/message', message: 'is required' }]
      }
    })
    await formShown()
    expect(textbox(/^Message/)).toHaveProperty('value', '')
    expect(description(textbox(/^Message/))).toContain('is required')
  })

  it('keeps an error on a detector it does not know after Save', async () => {
    const { api } = renderEditor({
      invalid: {
        slug: battery.slug,
        name: battery.name,
        body: { ...battery, detector: { type: 'nonsense' } },
        errors: [{ path: '/detector/type', message: 'is not a known detector' }]
      }
    })
    await formShown()
    click(button('Save'))
    await waitFor(() => {
      expect(description(select(/^Alert when/))).toContain('is required')
    })
    expect(api.updateRule).not.toHaveBeenCalled()
  })

  it('saves under the slug it is stored under, whatever its body says', async () => {
    const { api, onSaved } = renderEditor({
      invalid: {
        slug: 'battery-old',
        name: battery.name,
        body: { ...battery, detector: { ...battery.detector, duration: -5 } },
        errors: [{ path: '/detector/duration', message: 'must be at least 0' }]
      }
    })
    await formShown()
    type(textbox('For at least'), '1')
    choose('For at least unit', 'min')
    click(button('Save'))
    await saved(onSaved)
    expect(api.updateRule).toHaveBeenCalledWith('battery-old', { ...battery, slug: 'battery-old' })
  })
})

describe('RuleEditor, a unit reported after it opens', () => {
  const COOLANT = 'propulsion.port.coolantTemperature'
  /** Reports the coolant temperature, in °C, from the second read on. */
  const later = (): { source: PathSource; reads: () => number } => {
    let reads = 0
    return {
      source: {
        selfPaths: () => {
          reads++
          return Promise.resolve(
            reads === 1 ? reported.filter((p) => p.path !== COOLANT) : reported
          )
        },
        distanceUnit: () => Promise.resolve(distance)
      },
      reads: () => reads
    }
  }
  const polled = async (reads: () => number) => {
    await vi.advanceTimersByTimeAsync(5000)
    await waitFor(() => {
      expect(reads()).toBeGreaterThan(1)
    })
    await waitFor(() => {
      expect(screen.getByText(/^Now /)).toBeTruthy()
    })
  }

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
  })
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('saves a stored limit unchanged', async () => {
    const rule: Rule = {
      name: 'Coolant hot',
      slug: 'coolant-hot',
      message: 'Coolant {value}',
      signal: { path: COOLANT },
      detector: {
        type: 'sustained',
        direction: 'above',
        steps: [{ limit: 368.15, priority: 'alarm' }]
      }
    }
    const { source, reads } = later()
    const { api, onSaved } = renderEditor({
      paths: source,
      editing: { entry: ruleEntry({ slug: rule.slug }), rule }
    })
    await formShown()
    await polled(reads)
    click(button('Save'))
    await saved(onSaved)
    expect(api.updateRule).toHaveBeenCalledWith(rule.slug, rule)
  })

  it('keeps a typed limit in the unit it was typed in', async () => {
    const { source, reads } = later()
    const { api, onSaved } = renderEditor({
      paths: source,
      start: { path: COOLANT, kind: 'above' }
    })
    await formShown()
    choose('Priority for step 1', 'alarm')
    type(textbox('Limit for step 1'), '368.15')
    await polled(reads)
    create()
    await saved(onSaved)
    const [[rule]] = api.createRule.mock.calls
    expect(rule.detector).toMatchObject({ steps: [{ limit: 368.15, priority: 'alarm' }] })
  })
})

describe('RuleEditor, outside a range', () => {
  afterEach(cleanup)

  const COOLANT = 'propulsion.port.coolantTemperature'

  function fillRange(low: string, high: string, n = 1) {
    type(textbox(`Low limit for step ${String(n)}`), low)
    type(textbox(`High limit for step ${String(n)}`), high)
  }

  function rejectWith(api: FakeApi, path: string, message: string) {
    api.createRule.mockRejectedValueOnce(
      new RuleRejectedError('invalid request body', [{ path, message }])
    )
  }

  it('saves a range typed in display units in SI, and opens it as typed', async () => {
    const { api, onSaved } = renderEditor({ start: { path: COOLANT, kind: 'outside' } })
    await formShown()
    choose('Priority for step 1', 'warning')
    fillRange('60', '95')
    create()
    await saved(onSaved)
    const [[rule]] = api.createRule.mock.calls
    expect(rule.detector.type).toBe('outside')
    const step = rule.detector.type === 'outside' ? rule.detector.steps[0] : undefined
    expect(step?.priority).toBe('warning')
    expect(step?.low).toBeCloseTo(333.15)
    expect(step?.high).toBeCloseTo(368.15)
    cleanup()
    renderEditor({ editing: { entry: ruleEntry({ slug: rule.slug }), rule } })
    await formShown()
    expect(select('Alert when')).toHaveProperty('value', 'outside')
    expect(textbox('Low limit for step 1')).toHaveProperty('value', '60')
    expect(textbox('High limit for step 1')).toHaveProperty('value', '95')
  })

  it('starts afresh with one empty step when the kind changes to outside a range', async () => {
    renderEditor({ start: { path: HOUSE, kind: 'below' } })
    await formShown()
    fillBelow('12.2')
    click(button('Escalate at…'))
    type(textbox('Limit for step 2'), '11.8')
    choose('Alert when', 'outside')
    expect(screen.queryByRole('combobox', { name: 'Priority for step 2' })).toBeNull()
    expect(textbox('Low limit for step 1')).toHaveProperty('value', '')
    expect(textbox('High limit for step 1')).toHaveProperty('value', '')
    expect(select('Priority for step 1')).toHaveProperty('value', 'warning')
  })

  it('hides the zones for outside a range, and comes back to typed steps', async () => {
    renderEditor({ start: { path: HOUSE, kind: 'below' } })
    await formShown()
    openMoreOptions()
    click(checkbox(/Use the value's zones/))
    choose('Alert when', 'outside')
    expect(screen.queryByRole('checkbox', { name: /Use the value's zones/ })).toBeNull()
    expect(textbox('Low limit for step 1')).toBeTruthy()
    choose('Alert when', 'below')
    expect(checkbox(/Use the value's zones/)).toHaveProperty('checked', false)
    expect(textbox('Limit for step 1')).toBeTruthy()
  })

  it('offers how long it must hold, the clear margin and the clear delay', async () => {
    renderEditor({ start: { path: HOUSE, kind: 'outside' } })
    await formShown()
    expect(textbox('For at least')).toBeTruthy()
    openMoreOptions()
    expect(textbox('Clear margin')).toBeTruthy()
    expect(textbox('Clear delay')).toBeTruthy()
  })

  it('asks for a missing high limit on its field, and moves focus there', async () => {
    const { api } = renderEditor({ start: { path: HOUSE, kind: 'outside' } })
    await formShown()
    choose('Priority for step 1', 'warning')
    type(textbox('Low limit for step 1'), '11.5')
    create()
    expect(description(textbox('High limit for step 1'))).toContain('Fill in the high limit')
    expect(textbox('Low limit for step 1').getAttribute('aria-invalid')).toBeNull()
    expect(document.activeElement).toBe(textbox('High limit for step 1'))
    expect(screen.getByText('Fill in the high limit to save.')).toBeTruthy()
    expect(api.createRule).not.toHaveBeenCalled()
  })

  it('shows a range whose high limit is not above its low on the high field', async () => {
    const { api } = renderEditor({ start: { path: HOUSE, kind: 'outside' } })
    rejectWith(api, '/detector/steps/1/high', 'must be above the low limit')
    await formShown()
    choose('Priority for step 1', 'warning')
    fillRange('11.5', '14.8')
    click(button('Escalate at…'))
    fillRange('11', '10', 2)
    create()
    await waitFor(() => {
      expect(textbox('High limit for step 2').getAttribute('aria-invalid')).toBe('true')
    })
    expect(description(textbox('High limit for step 2'))).toContain(
      'Step 2: the high limit must be above the low limit.'
    )
    expect(screen.queryByText(/detector\/steps/)).toBeNull()
  })

  it('names a narrower later range by the limit it moved inside', async () => {
    const { api } = renderEditor({ start: { path: HOUSE, kind: 'outside' } })
    rejectWith(api, '/detector/steps/1/low', "must not be inside the previous step's range")
    await formShown()
    choose('Priority for step 1', 'warning')
    fillRange('11.5', '14.8')
    click(button('Escalate at…'))
    fillRange('11.8', '15', 2)
    create()
    await waitFor(() => {
      expect(textbox('Low limit for step 2').getAttribute('aria-invalid')).toBe('true')
    })
    expect(description(textbox('Low limit for step 2'))).toContain(
      "Step 2: an alarm's low limit must not be above 11.5 V, the warning's low limit."
    )
  })

  it('names a high limit moved inside, and a range no wider than the last', async () => {
    const { api } = renderEditor({ start: { path: HOUSE, kind: 'outside' } })
    rejectWith(api, '/detector/steps/1/high', "must not be inside the previous step's range")
    await formShown()
    choose('Priority for step 1', 'warning')
    fillRange('11.5', '14.8')
    click(button('Escalate at…'))
    fillRange('11', '14.5', 2)
    create()
    await waitFor(() => {
      expect(description(textbox('High limit for step 2'))).toContain(
        "Step 2: an alarm's high limit must not be below 14.8 V, the warning's high limit."
      )
    })
    rejectWith(api, '/detector/steps/1/high', "must not be inside the previous step's range")
    fillRange('11.5', '14.8', 2)
    create()
    await waitFor(() => {
      expect(description(textbox('High limit for step 2'))).toContain(
        "Step 2: an alarm's range must be wider than 11.5 to 14.8 V, the warning's range."
      )
    })
  })

  it('opens More options for a clear margin too wide for the range', async () => {
    const { api } = renderEditor({ start: { path: HOUSE, kind: 'outside' } })
    rejectWith(
      api,
      '/detector/hysteresis',
      "must be less than half the first step's range, or the alert could never clear"
    )
    await formShown()
    choose('Priority for step 1', 'warning')
    fillRange('11.5', '14.8')
    const more = screen.getByText('More options').closest('details')
    expect(more?.open).toBe(false)
    create()
    await waitFor(() => {
      expect(more?.open).toBe(true)
    })
    expect(description(textbox('Clear margin'))).toContain("half the first step's range")
  })

  it('says whether the value now would alert, and past which limit', async () => {
    renderEditor({ start: { path: HOUSE, kind: 'outside' } })
    await formShown()
    choose('Priority for step 1', 'warning')
    fillRange('11.5', '13')
    expect(screen.getByText(/Now 13\.31 V: would alert as a warning \(above 13 V\)\./)).toBeTruthy()
    fillRange('11.5', '14.8')
    expect(screen.getByText(/Now 13\.31 V: would not alert\./)).toBeTruthy()
  })
})

describe('RuleEditor, the keyboard a number brings up', () => {
  afterEach(cleanup)

  // A phone's decimal keypad has no minus key, so only a number that cannot be negative asks for it.
  const inputMode = (name: string) => textbox(name).getAttribute('inputmode')

  it.each([
    ['below', ['Limit for step 1']],
    ['outside', ['Low limit for step 1', 'High limit for step 1']],
    ['rate', ['Limit for step 1']],
    ['state', ['State for step 1']]
  ] as const)('offers a minus for the limits of %s', async (kind, fields) => {
    renderEditor({ start: { path: HOUSE, kind } })
    await formShown()
    for (const field of fields) expect(inputMode(field)).toBeNull()
  })

  it('offers a minus for a condition limit, and the keypad for its clear margin', async () => {
    renderEditor({ start: { path: HOUSE, kind: 'below' } })
    await formShown()
    openMoreOptions()
    click(button('Add a condition'))
    expect(inputMode('Condition 1 limit')).toBeNull()
    expect(inputMode('Condition 1 clear margin')).toBe('decimal')
  })

  it('offers the keypad for a count, a duration and the clear margin', async () => {
    renderEditor({ start: { path: HOUSE, kind: 'often' } })
    await formShown()
    expect(inputMode('Limit for step 1')).toBe('decimal')
    cleanup()
    renderEditor({ start: { path: HOUSE, kind: 'outside' } })
    await formShown()
    expect(inputMode('For at least')).toBe('decimal')
    openMoreOptions()
    expect(inputMode('Clear margin')).toBe('decimal')
  })
})

describe('ZONE_PRIORITY', () => {
  it('is the priority the model gives each zone level', () => {
    expect(ZONE_PRIORITY).toEqual(LEVEL_PRIORITY)
  })
})
