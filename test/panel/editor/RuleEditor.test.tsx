// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { RANGE_HYSTERESIS, RANGE_INVERTED, RANGE_NOT_WIDER } from '../../../src/model/rangeMessages'
import { LEVEL_PRIORITY, type CombinatorKind, type Rule } from '../../../src/model/rule'
import { validateRule } from '../../../src/model/validate'
import { RuleRejectedError, type EditPreview, type FieldError } from '../../../src/panel/api'
import { ZONE_PRIORITY } from '../../../src/panel/editor/MoreOptions'
import type { PathSource } from '../../../src/panel/paths/selfPaths'
import { instance, onceShown, ruleEntry } from '../fixtures'
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
  pathSource,
  renderEditor,
  reported,
  saved,
  select,
  textbox,
  type,
  type FakeApi
} from './editorFixtures'

const ZONES_INVALID =
  'The stored zone setting is not valid: choose a zone, or turn this off and type the steps.'

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

  it('previews a wildcard rule with the first instance reporting, by name', async () => {
    const rule = example('coolant-temperature-rising')
    renderEditor({ editing: { entry: ruleEntry({ slug: rule.slug }), rule } })
    await formShown()
    await waitFor(() => {
      expect(description(textbox(/^Message/))).toContain(
        'Sends now: “Coolant temperature is rising fast on port”'
      )
    })
  })

  it('previews a wildcard rule with no instance reporting with {instance} as written', async () => {
    const rule = example('coolant-temperature-rising')
    const silent: PathSource = { ...pathSource, selfPaths: () => Promise.resolve([]) }
    renderEditor({ paths: silent, editing: { entry: ruleEntry({ slug: rule.slug }), rule } })
    await formShown()
    await waitFor(() => {
      expect(description(textbox(/^Message/))).toContain(
        'Sends now: “Coolant temperature is rising fast on {instance}”'
      )
    })
  })

  it('previews a wildcard rule pinned to a source with an instance that source reports', async () => {
    const coolant = example('coolant-temperature-rising')
    const rule: Rule = { ...coolant, signal: { ...coolant.signal, source: 'n2k.starboard' } }
    const bySource: PathSource = {
      ...pathSource,
      selfPaths: () =>
        Promise.resolve(
          reported.map((p) =>
            p.path === 'propulsion.port.coolantTemperature'
              ? { ...p, sources: ['n2k.port'] }
              : p.path === 'propulsion.starboard.coolantTemperature'
                ? { ...p, sources: ['n2k.starboard'] }
                : p
          )
        )
    }
    renderEditor({ paths: bySource, editing: { entry: ruleEntry({ slug: rule.slug }), rule } })
    await formShown()
    await waitFor(() => {
      expect(description(textbox(/^Message/))).toContain(
        'Sends now: “Coolant temperature is rising fast on starboard”'
      )
    })
  })

  it('previews nothing for a wildcard rule while the paths load, showing no form yet', async () => {
    const rule = example('coolant-temperature-rising')
    renderEditor({
      paths: { ...pathSource, selfPaths: () => new Promise<never>(() => undefined) },
      editing: { entry: ruleEntry({ slug: rule.slug }), rule }
    })
    expect(await screen.findByRole('status')).toHaveProperty('textContent', 'Loading paths…')
    expect(screen.queryByText(/Sends now/)).toBeNull()
  })

  it('previews a wildcard rule with {instance} as written when the paths fail to load', async () => {
    const rule = example('coolant-temperature-rising')
    renderEditor({
      paths: { ...pathSource, selfPaths: () => Promise.reject(new Error('unreachable')) },
      editing: { entry: ruleEntry({ slug: rule.slug }), rule }
    })
    await formShown()
    await waitFor(() => {
      expect(description(textbox(/^Message/))).toContain(
        'Sends now: “Coolant temperature is rising fast on {instance}”'
      )
    })
  })

  it('previews {instance} as empty for a rule without a wildcard, as the server sends it', async () => {
    const rule: Rule = {
      name: 'Port coolant hot',
      slug: 'port-coolant-hot',
      message: 'Coolant hot{instance}',
      signal: { path: 'propulsion.port.coolantTemperature' },
      detector: {
        type: 'sustained',
        direction: 'above',
        steps: [{ limit: 368.15, priority: 'alarm' }]
      }
    }
    renderEditor({ editing: { entry: ruleEntry({ slug: rule.slug }), rule } })
    await formShown()
    await waitFor(() => {
      expect(description(textbox(/^Message/))).toContain('Sends now: “Coolant hot”')
    })
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

  it('focuses a refused field inside More options while it is closed', async () => {
    const { api } = renderEditor({ start: { path: HOUSE, kind: 'below' } })
    api.createRule.mockRejectedValueOnce(
      new RuleRejectedError('invalid request body', [
        { path: '/detector/hysteresis', message: 'must be at most 5' }
      ])
    )
    await formShown()
    fillBelow()
    button('Create rule').focus()
    create()
    await waitFor(() => {
      expect(document.activeElement).toBe(textbox('Clear margin'))
    })

    const summary = screen.getByText('More options')
    const toggle = async () => {
      const toggled = new Promise((resolve) => {
        summary.closest('details')?.addEventListener('toggle', resolve, { once: true })
      })
      click(summary)
      await toggled
    }
    summary.focus()
    await toggle()
    await toggle()
    expect(document.activeElement).toBe(summary)
    textbox(/^Name/).focus()
    type(textbox(/^Name/), 'House low')
    expect(document.activeElement).toBe(textbox(/^Name/))
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

  it('moves focus into the path search on a Change clicked as the form appears', async () => {
    const clicked = onceShown(
      () => screen.queryByRole('button', { name: 'Change the value to watch' }),
      click
    )
    renderEditor({ start: { path: HOUSE, kind: 'below' } })
    await clicked
    await waitFor(() => {
      expect(document.activeElement).toBe(select('Search by name or path'))
    })
  })

  it('keeps focus on a field focused as the form appears', async () => {
    const focused = onceShown(
      () => screen.queryByRole('textbox', { name: /^Name/ }),
      (name) => {
        name.focus()
      }
    )
    renderEditor({ start: { path: HOUSE, kind: 'below' } })
    await focused
    await formShown()
    type(textbox(/^Name/), 'House low')
    expect(document.activeElement).toBe(textbox(/^Name/))
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

  describe("a single signal's zones from another path", () => {
    const START = 'electrical.batteries.start.voltage'
    const zonePicker = () => select(/^Zones from path/)
    const fromStart: Rule = {
      ...battery,
      detector: { ...battery.detector, limit: { kind: 'zone', level: 'warn', path: START } }
    } as Rule

    it('shows an empty picker that says empty uses the zones of the value', async () => {
      renderEditor({ editing: { entry: active, rule: battery } })
      await formShown()
      expect(zonePicker()).toHaveProperty('value', '')
      expect(description(zonePicker())).toContain(`Empty uses the zones of ${HOUSE}.`)
      expect(screen.getByText(/^From the zones of/).textContent).toBe(`From the zones of ${HOUSE}`)
    })

    it('labels the picker plainly, with no hint, while combining', async () => {
      renderEditor({ editing: { entry: active, rule: battery } })
      await formShown()
      click(checkbox('Combine with other paths'))
      expect(screen.getByRole('combobox', { name: 'Zones from path' })).toBeTruthy()
      expect(description(zonePicker())).not.toContain('Empty uses')
    })

    it('shows a stored path in the picker and the zones it names', async () => {
      renderEditor({ editing: { entry: active, rule: fromStart } })
      await formShown()
      expect(zonePicker()).toHaveProperty('value', START)
      expect(screen.getByText(/^From the zones of/).textContent).toBe(`From the zones of ${START}`)
    })

    it('saves without a path once the picker is cleared', async () => {
      const { api, onSaved } = renderEditor({ editing: { entry: active, rule: fromStart } })
      await formShown()
      type(zonePicker(), '')
      click(button('Save'))
      await saved(onSaved)
      expect(api.updateRule.mock.calls[0]?.[1].detector).toEqual(battery.detector)
    })

    it('keeps a path chosen while combining in view once back to a single path', async () => {
      const { api, onSaved } = renderEditor({ editing: { entry: active, rule: battery } })
      await formShown()
      click(checkbox('Combine with other paths'))
      type(zonePicker(), START)
      click(checkbox('Combine with other paths'))
      expect(zonePicker()).toHaveProperty('value', START)
      click(button('Save'))
      await saved(onSaved)
      expect(api.updateRule.mock.calls[0]?.[1].detector).toEqual(fromStart.detector)
    })
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

  describe('a limit shown rounded in its display unit', () => {
    const revolutions: Rule = {
      ...battery,
      signal: { path: 'propulsion.port.revolutions' },
      detector: {
        type: 'sustained',
        direction: 'above',
        steps: [{ limit: 3.0123, priority: 'warning' }]
      }
    }

    it('shows it rounded and saves the stored value while it is not edited', async () => {
      const { api, onSaved } = renderEditor({ editing: { entry: active, rule: revolutions } })
      await formShown()
      expect(textbox('Limit for step 1')).toHaveProperty('value', '180.7')
      type(textbox(/^Message/), 'Edited')
      click(button('Save'))
      await saved(onSaved)
      expect(api.updateRule.mock.calls[0]?.[1]).toEqual({ ...revolutions, message: 'Edited' })
    })

    it('saves what the shown text converts to once it is typed back in', async () => {
      const { api, onSaved } = renderEditor({ editing: { entry: active, rule: revolutions } })
      await formShown()
      type(textbox('Limit for step 1'), '180.8')
      type(textbox('Limit for step 1'), '180.7')
      click(button('Save'))
      await saved(onSaved)
      const steps = api.updateRule.mock.calls[0]?.[1].detector.steps as { limit: number }[]
      expect(steps[0].limit).toBeCloseTo(180.7 / 60, 12)
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

  it('opens a body without a detector watching its signal, asking only for Alert when', async () => {
    const coolant = example('coolant-temperature-rising')
    const { detector: _detector, ...body } = coolant
    renderEditor({
      invalid: {
        slug: coolant.slug,
        name: coolant.name,
        body,
        errors: [{ path: '/detector', message: 'is required' }]
      }
    })
    await formShown()
    expect(screen.getByText('propulsion.*.coolantTemperature')).toBeTruthy()
    expect(button('Change the value to watch')).toBeTruthy()
    expect(screen.getByText('alerts.propulsion.*.')).toBeTruthy()
    expect(description(select(/^Alert when/))).toContain('is required')
    expect(document.querySelectorAll('[aria-invalid="true"]')).toHaveLength(1)
    expect(screen.getByText('Fill in what should alert to save.')).toBeTruthy()
  })

  it('opens a count body without an event keeping the rest, asking only for the event', async () => {
    const bilge = example('bilge-pump-cycling')
    const { event: _event, ...detector } = bilge.detector as Extract<
      Rule['detector'],
      { type: 'count' }
    >
    renderEditor({
      invalid: {
        slug: bilge.slug,
        name: bilge.name,
        body: { ...bilge, detector },
        errors: [{ path: '/detector/event', message: 'is required' }]
      }
    })
    await formShown()
    const event = select(/^Count each time the value/)
    expect(event).toHaveProperty('value', '')
    expect(event.querySelector('option[value=""]')?.textContent).toBe('Choose…')
    expect(textbox(/^Message/)).toHaveProperty('value', bilge.message)
    expect(document.querySelectorAll('[aria-invalid="true"]')).toHaveLength(1)
    expect(screen.getByText('Fill in the event to save.')).toBeTruthy()
  })

  it('opens a body without a signal keeping its detector, its limit marked to type in the new unit', async () => {
    const coolant = example('coolant-temperature-rising')
    const { signal: _signal, ...body } = coolant
    renderEditor({
      invalid: {
        slug: coolant.slug,
        name: coolant.name,
        body,
        errors: [{ path: '/signal', message: 'is required' }]
      }
    })
    await formShown()
    expect(select(/^Alert when/)).not.toHaveProperty('value', '')
    expect(textbox('Limit for step 1')).toHaveProperty('value', '')
    expect(description(textbox('Limit for step 1'))).toContain('Fill in the limit')
    expect(textbox(/^Message/)).toHaveProperty('value', coolant.message)
    const search = screen.getByRole('combobox', { name: /^Search by name or path/ })
    expect(description(search)).toContain('is required')
    expect(document.querySelectorAll('[aria-invalid="true"]')).toHaveLength(2)
    expect(screen.getByText('Fill in the value to watch and the limit to save.')).toBeTruthy()
  })

  const openStored = async (body: Record<string, unknown>) => {
    const result = validateRule(body)
    renderEditor({
      invalid: {
        slug: String(body.slug),
        name: String(body.name),
        body,
        errors: result.ok ? [] : result.errors
      }
    })
    await formShown()
  }

  const engine = example('engine-service-due')
  const bilge = example('bilge-pump-cycling')
  it.each([
    [
      'a count changing to no value',
      { ...bilge, detector: { ...bilge.detector, event: { op: 'changesTo' } } },
      () => select('Count each time the value: value'),
      () => select('Count each time the value')
    ],
    [
      'a total while above no value',
      { ...engine, detector: { ...engine.detector, while: { op: 'above' } } },
      () => textbox('Count while: value'),
      () => select('Count while the value is')
    ],
    [
      'a total reset on changing to no value',
      { ...engine, detector: { ...engine.detector, resetOn: { op: 'changesTo' } } },
      () => textbox('Start again when the value: value'),
      () => select('Start again when the value')
    ]
  ])('opens %s with its error on the value', async (_kind, body, value, op) => {
    await openStored(body)
    const result = validateRule(body)
    const message = result.ok ? '' : (result.errors[0]?.message ?? '')
    expect(message).not.toBe('')
    expect(description(value())).toContain(message)
    expect(value().getAttribute('aria-invalid')).toBe('true')
    expect(op().getAttribute('aria-invalid')).toBeNull()
    expect(description(op())).not.toContain(message)
    expect(document.querySelectorAll('[aria-invalid="true"]')).toHaveLength(1)
    expect(screen.queryByText(/^\/detector\//)).toBeNull()
  })

  it('opens an unknown op with its error on the op alone', async () => {
    const body = {
      ...engine,
      detector: { ...engine.detector, while: { op: 'nonsense', value: 5 } }
    }
    await openStored(body)
    const result = validateRule(body)
    const message = result.ok ? '' : (result.errors[0]?.message ?? '')
    expect(message).not.toBe('')
    const op = select('Count while the value is')
    expect(op.getAttribute('aria-invalid')).toBe('true')
    expect(description(op)).toContain(message)
    expect(textbox('Count while: value').getAttribute('aria-invalid')).toBeNull()
    expect(description(textbox('Count while: value'))).not.toContain(message)
    expect(document.querySelectorAll('[aria-invalid="true"]')).toHaveLength(1)
  })

  it.each([
    ['a fixed value', { kind: 'fixed', value: 12 }],
    ['an unknown kind', { kind: 'nonsense', level: 'warn' }]
  ])('opens a detector limit of %s with its errors on the zones', async (_kind, limit) => {
    const body = { ...battery, detector: { ...battery.detector, limit } }
    await openStored(body)
    expect(validateRule(body).ok).toBe(false)
    const zones = checkbox(/Use the value's zones/)
    expect(zones.getAttribute('aria-invalid')).toBe('true')
    expect(description(zones)).toContain(ZONES_INVALID)
    expect(description(zones)).not.toMatch(/is required|is not a known property|constant/)
    expect(screen.queryByText(/^\/detector\//)).toBeNull()
    expect(screen.getByText("Fix Use the value's zones to save.")).toBeTruthy()
  })

  it("opens a zone limit's stray setting with its error on the zones", async () => {
    const limit = { kind: 'zone', level: 'warn', value: 5 }
    await openStored({ ...battery, detector: { ...battery.detector, limit } })
    const zones = checkbox(/Use the value's zones/)
    expect(zones.getAttribute('aria-invalid')).toBe('true')
    expect(description(zones)).toContain(ZONES_INVALID)
    expect(select('Starting at the zone').getAttribute('aria-invalid')).toBeNull()
    expect(screen.queryByText(/^\/detector\//)).toBeNull()
    expect(screen.getByText("Fix Use the value's zones to save.")).toBeTruthy()
  })

  it('keeps the errors of a fixed detector limit on the zones once they are chosen', async () => {
    const limit = { kind: 'fixed', value: 12 }
    await openStored({ ...battery, detector: { ...battery.detector, limit } })
    click(checkbox(/Use the value's zones/))
    const zones = checkbox(/Use the value's zones/)
    expect(zones.getAttribute('aria-invalid')).toBe('true')
    expect(description(zones)).toContain(ZONES_INVALID)
    expect(description(zones)).not.toMatch(/is required|is not a known property|constant/)
    expect(description(select('Starting at the zone'))).toContain('is required')
    expect(screen.queryByText(/^\/detector\//)).toBeNull()
    expect(
      screen.getByText("Fill in the zone to start at and fix Use the value's zones to save.")
    ).toBeTruthy()
  })

  const rpm = example('engine-rpm-mismatch')
  it("names the zones' own path by its field", async () => {
    const { steps: _steps, ...detector } = rpm.detector as Extract<
      Rule['detector'],
      { type: 'sustained' }
    >
    await openStored({ ...rpm, detector: { ...detector, limit: { kind: 'zone', level: 'warn' } } })
    expect(screen.getByText('Fix the path of the zones to save.')).toBeTruthy()
  })

  it("says an empty zone path uses the value's path while the signal has none", async () => {
    await openStored({ ...battery, signal: { path: '' } })
    const picker = select(/^Zones from path/)
    expect(picker).toHaveProperty('value', '')
    expect(description(picker)).toContain("Empty uses the zones of the value's path.")
  })

  it("opens a single signal's stray zone path with its error on the picker", async () => {
    const limit = { kind: 'zone', level: 'warn', path: 'electrical.batteries.*.voltage' }
    const body = { ...battery, detector: { ...battery.detector, limit } }
    await openStored(body)
    const result = validateRule(body)
    const message = result.ok ? '' : (result.errors[0]?.message ?? '')
    expect(message).not.toBe('')
    const picker = select(/^Zones from path/)
    expect(picker).toHaveProperty('value', limit.path)
    expect(picker.getAttribute('aria-invalid')).toBe('true')
    expect(description(picker)).toContain(message)
    expect(document.querySelectorAll('[aria-invalid="true"]')).toHaveLength(1)
    expect(screen.getByText('Fix the path of the zones to save.')).toBeTruthy()
  })

  it('lists an angular flag on a combination that cannot wrap angles, which has no field', async () => {
    await openStored({ ...rpm, signal: { ...rpm.signal, combinator: 'ratio', angular: true } })
    expect(screen.queryByRole('checkbox', { name: /angle/i })).toBeNull()
    expect(screen.getByText('/signal/angular: ratio cannot wrap angles')).toBeTruthy()
    expect(screen.getByText('Fix the error listed above to save.')).toBeTruthy()
  })

  describe('an error no field shows', () => {
    const steps = [{ limit: 12, priority: 'warning' }]

    it('names the list, not the event, for a value on an event that takes none', async () => {
      await openStored({
        ...bilge,
        detector: { ...bilge.detector, event: { op: 'changes', value: true } }
      })
      expect(screen.getByText('/detector/event/value: changes takes no value')).toBeTruthy()
      expect(screen.getByText('Fix the error listed above to save.')).toBeTruthy()
    })

    it('names the list, not the priority, for steps on a zone-limit rule', async () => {
      await openStored({ ...battery, detector: { ...battery.detector, steps } })
      expect(
        screen.getByText('/detector/steps: a rule has steps or a zone limit, never both')
      ).toBeTruthy()
      expect(screen.getByText('Fix the error listed above to save.')).toBeTruthy()
    })

    // The validator stops at the first malformed part, so a stored rule's
    // errors from several checks are given as the server could report them.
    const openWith = async (body: Record<string, unknown>, errors: FieldError[]) => {
      renderEditor({ invalid: { slug: String(body.slug), name: String(body.name), body, errors } })
      await formShown()
    }
    const stepsAndZones = {
      path: '/detector/steps',
      message: 'a rule has steps or a zone limit, never both'
    }

    it('names the list after the fields that show theirs', async () => {
      const { message: _message, ...body } = battery
      await openWith({ ...body, detector: { ...battery.detector, steps } }, [
        { path: '/message', message: 'is required' },
        stepsAndZones
      ])
      expect(description(textbox(/^Message/))).toContain('is required')
      expect(
        screen.getByText('Fill in the message and fix the error listed above to save.')
      ).toBeTruthy()
    })

    it('names a field to fix before the list', async () => {
      await openWith({ ...battery, detector: { ...battery.detector, steps } }, [
        { path: '/name', message: 'must not be empty' },
        stepsAndZones
      ])
      expect(screen.getByText('Fix the name and the error listed above to save.')).toBeTruthy()
    })

    it('names the field once a change shows the error there', async () => {
      await openStored({ ...rpm, signal: { ...rpm.signal, combinator: 'ratio', angular: true } })
      expect(screen.getByText('Fix the error listed above to save.')).toBeTruthy()
      openMoreOptions()
      choose('Combined combination', 'difference')
      const angles = checkbox(/Values are angles/)
      expect(angles.getAttribute('aria-invalid')).toBe('true')
      expect(description(angles)).toContain('ratio cannot wrap angles')
      expect(screen.queryByText(/^\/signal\/angular/)).toBeNull()
      // A ratio has no unit and a difference has its inputs', so the limit empties too.
      expect(
        screen.getByText('Fill in the limit and fix whether the values are angles to save.')
      ).toBeTruthy()
    })

    it('names the list once for several errors', async () => {
      const angular = { path: '/signal/angular', message: 'is not a known property' }
      await openWith(
        {
          ...battery,
          signal: { ...battery.signal, angular: true },
          detector: { ...battery.detector, steps }
        },
        [stepsAndZones, angular]
      )
      expect(screen.getByText(`${angular.path}: ${angular.message}`)).toBeTruthy()
      expect(screen.getByText(`${stepsAndZones.path}: ${stepsAndZones.message}`)).toBeTruthy()
      expect(screen.getByText('Fix the errors listed above to save.')).toBeTruthy()
    })
  })

  const withoutDirection = (rule: Rule): Rule => {
    const { direction: _direction, ...detector } = rule.detector as Extract<
      Rule['detector'],
      { direction: string }
    >
    return { ...rule, detector } as Rule
  }
  const gateWithoutDirection = (rule: Rule): Rule => {
    const { direction: _direction, ...gate } = { ...rule.gates?.[0] }
    return { ...rule, gates: [gate] } as Rule
  }
  it.each([
    [
      'a below-a-limit',
      'house-battery-low',
      withoutDirection,
      /^Alert when/,
      'below',
      'what should alert'
    ],
    [
      'a rate',
      'coolant-temperature-rising',
      withoutDirection,
      /^Changing/,
      'rising',
      'the direction'
    ],
    [
      'an Only while',
      'coolant-temperature-rising',
      gateWithoutDirection,
      /^Condition 1 holds while the input is/,
      'above',
      'the direction of Only while condition 1'
    ]
  ])(
    'opens %s condition without a direction unchosen, asking only for it, and saves it once chosen',
    async (_kind, slug, strip, control, choice, label) => {
      const rule = example(slug)
      const body = strip(rule)
      const result = validateRule(body)
      const { api, onSaved } = renderEditor({
        invalid: { slug, name: rule.name, body, errors: result.ok ? [] : result.errors }
      })
      await formShown()
      const direction = select(control)
      expect(direction).toHaveProperty('value', '')
      expect(direction.querySelector('option[value=""]')?.textContent).toBe('Choose…')
      expect(description(direction)).toContain('is required')
      expect(document.querySelectorAll('[aria-invalid="true"]')).toHaveLength(1)
      expect(screen.getByText(`Fill in ${label} to save.`)).toBeTruthy()
      choose(control, choice)
      click(button('Save'))
      await saved(onSaved)
      expect(api.updateRule).toHaveBeenCalledWith(slug, rule)
    }
  )

  it('offers below and above for a lost direction on a path whose value is not a number', async () => {
    const rule = example('house-battery-low')
    const body = withoutDirection({
      ...rule,
      signal: { path: 'electrical.switches.bilgePump.state' }
    })
    const result = validateRule(body)
    renderEditor({
      invalid: { slug: rule.slug, name: rule.name, body, errors: result.ok ? [] : result.errors }
    })
    await formShown()
    const offered = [...select(/^Alert when/).querySelectorAll('option')].map((o) => o.value)
    expect(offered).toEqual(expect.arrayContaining(['below', 'above']))
  })

  it('opens zones without a level unchosen, listing no zones until one is chosen', async () => {
    const body = { ...battery, detector: { ...battery.detector, limit: { kind: 'zone' } } }
    const result = validateRule(body)
    renderEditor({
      invalid: {
        slug: battery.slug,
        name: battery.name,
        body,
        errors: result.ok ? [] : result.errors
      }
    })
    await formShown()
    const level = select('Starting at the zone')
    expect(level).toHaveProperty('value', '')
    expect(level.getAttribute('aria-required')).toBe('true')
    expect(description(level)).toContain('is required')
    expect(screen.getByText('Choose the zone to start at.')).toBeTruthy()
    expect(screen.getByText('Fill in the zone to start at to save.')).toBeTruthy()
  })

  it('marks what a total counts while as required', async () => {
    const rule = example('engine-service-due')
    renderEditor({ editing: { entry: ruleEntry({ slug: rule.slug }), rule } })
    await formShown()
    expect(select('Count while the value is').getAttribute('aria-required')).toBe('true')
  })

  it('names a number the server already reports once, not again as emptied', async () => {
    const coolant = example('coolant-temperature-rising')
    const gate = { signal: { path: '' }, direction: 'above', limit: { kind: 'fixed' } }
    await openStored({ ...coolant, gates: [gate] })
    expect(description(textbox('Condition 1 limit')).match(/is required/g)).toHaveLength(1)
  })

  it('names no emptied number the form has no field for', async () => {
    const house = example('house-battery-low')
    const detector = { ...house.detector, steps: [{ limit: 12, priority: 'warning' }] }
    await openStored({ ...house, signal: { path: '' }, detector })
    expect(document.body.textContent).not.toContain('/detector/steps/0/limit')
  })

  it('opens a body without a signal naming the numbers to type again, saving without the clear margin', async () => {
    const { signal: _signal, ...rest } = battery
    const detector = {
      type: 'sustained',
      direction: 'below',
      steps: [{ limit: 11.8, priority: 'warning' }],
      duration: 60,
      hysteresis: 0.2,
      clearDuration: 30
    } as const
    const { api, onSaved } = renderEditor({
      invalid: {
        slug: battery.slug,
        name: battery.name,
        body: { ...rest, detector },
        errors: [{ path: '/signal', message: 'is required' }]
      }
    })
    await formShown()
    expect(description(textbox('Limit for step 1'))).toContain('Fill in the limit')
    expect(description(textbox('Clear margin'))).toContain(
      'must be typed again in the unit of the chosen path'
    )
    // The footer names the clear margin from the start, so Save need not stop for it.
    expect(
      screen.getByText(
        'Fill in the value to watch and the limit to save. The clear margin was emptied: type it again or leave it empty.'
      )
    ).toBeTruthy()
    type(select('Search by name or path'), HOUSE)
    // Moving to the limit takes focus from the search, which settles the path.
    fireEvent.blur(select('Search by name or path'))
    type(textbox('Limit for step 1'), '11.8')
    click(button('Save'))
    await saved(onSaved)
    const { hysteresis: _hysteresis, ...kept } = detector
    expect(api.updateRule).toHaveBeenCalledWith(battery.slug, {
      ...rest,
      signal: { path: HOUSE },
      detector: kept
    })
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
    const { api, onSaved } = renderEditor({ start: { path: HOUSE, kind: 'below' } })
    await formShown()
    openMoreOptions()
    click(checkbox(/Use the value's zones/))
    choose('Alert when', 'outside')
    expect(screen.queryByRole('checkbox', { name: /Use the value's zones/ })).toBeNull()
    expect(textbox('Low limit for step 1')).toBeTruthy()
    choose('Alert when', 'below')
    expect(checkbox(/Use the value's zones/)).toHaveProperty('checked', false)
    fillBelow()
    create()
    await saved(onSaved)
    const [[rule]] = api.createRule.mock.calls
    expect(rule.detector).toMatchObject({ type: 'sustained', direction: 'below' })
    expect(rule.detector).not.toHaveProperty('limit')
  })

  it('offers how long it must hold, the clear margin and the clear delay', async () => {
    renderEditor({ start: { path: HOUSE, kind: 'outside' } })
    await formShown()
    expect(textbox('For at least')).toBeTruthy()
    openMoreOptions()
    expect(description(textbox('Clear margin'))).toContain(
      'How far inside the range the value must come back to clear.'
    )
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

  it('says a single range must have its high limit above its low', async () => {
    const { api } = renderEditor({ start: { path: HOUSE, kind: 'outside' } })
    rejectWith(api, '/detector/steps/0/high', RANGE_INVERTED)
    await formShown()
    choose('Priority for step 1', 'warning')
    fillRange('14.8', '11.5')
    create()
    await waitFor(() => {
      expect(description(textbox('High limit for step 1'))).toContain(
        'The high limit must be above the low limit.'
      )
    })
    expect(description(textbox('High limit for step 1'))).not.toContain('Step 1')
  })

  it('shows a range whose high limit is not above its low on the high field', async () => {
    const { api } = renderEditor({ start: { path: HOUSE, kind: 'outside' } })
    rejectWith(api, '/detector/steps/1/high', RANGE_INVERTED)
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
    rejectWith(api, '/detector/steps/1/low', RANGE_NOT_WIDER)
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
    rejectWith(api, '/detector/steps/1/high', RANGE_NOT_WIDER)
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
    rejectWith(api, '/detector/steps/1/high', RANGE_NOT_WIDER)
    fillRange('11.5', '14.8', 2)
    create()
    await waitFor(() => {
      expect(description(textbox('High limit for step 2'))).toContain(
        "Step 2: an alarm's range must be wider than 11.5 to 14.8 V, the warning's range."
      )
    })
  })

  it("words the validator's own range errors", async () => {
    const { api } = renderEditor({ start: { path: HOUSE, kind: 'outside' } })
    api.createRule.mockImplementationOnce((rule: Rule) => {
      const result = validateRule(rule)
      return Promise.reject(
        new RuleRejectedError('invalid request body', result.ok ? [] : result.errors)
      )
    })
    await formShown()
    choose('Priority for step 1', 'warning')
    fillRange('11.5', '14.8')
    click(button('Escalate at…'))
    fillRange('11.8', '15', 2)
    click(button('Escalate at…'))
    fillRange('11', '10', 3)
    create()
    await waitFor(() => {
      expect(description(textbox('Low limit for step 2'))).toContain(
        "Step 2: an alarm's low limit must not be above 11.5 V, the warning's low limit."
      )
    })
    expect(description(textbox('High limit for step 3'))).toContain(
      'Step 3: the high limit must be above the low limit.'
    )
    expect(description(textbox('Low limit for step 2'))).not.toContain(RANGE_NOT_WIDER)
  })

  it.each([
    ['11.5', '14.8', '11.50', '14.80', '11.5 to 14.8 V'],
    ['11,5', '14.8', '11.5', '14,8', '11,5 to 14.8 V']
  ])('reads %s to %s and %s to %s as the same range', async (low1, high1, low2, high2, range) => {
    const { api } = renderEditor({ start: { path: HOUSE, kind: 'outside' } })
    rejectWith(api, '/detector/steps/1/low', RANGE_NOT_WIDER)
    await formShown()
    choose('Priority for step 1', 'warning')
    fillRange(low1, high1)
    click(button('Escalate at…'))
    fillRange(low2, high2, 2)
    create()
    await waitFor(() => {
      expect(description(textbox('Low limit for step 2'))).toContain(
        `Step 2: an alarm's range must be wider than ${range}, the warning's range.`
      )
    })
  })

  it('opens More options for a clear margin too wide for the range', async () => {
    const { api } = renderEditor({ start: { path: HOUSE, kind: 'outside' } })
    rejectWith(api, '/detector/hysteresis', RANGE_HYSTERESIS)
    await formShown()
    choose('Priority for step 1', 'warning')
    fillRange('11.5', '14.8')
    const more = screen.getByText('More options').closest('details')
    expect(more?.open).toBe(false)
    create()
    await waitFor(() => {
      expect(more?.open).toBe(true)
    })
    expect(description(textbox('Clear margin'))).toContain(
      "The clear margin must be less than 1.65 V, half the warning's range 11.5 to 14.8 V."
    )
    expect(description(textbox('Clear margin'))).not.toContain(RANGE_HYSTERESIS)
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

describe('RuleEditor, a path changed to one shown in another unit', () => {
  afterEach(cleanup)

  const SPEED = 'navigation.speedOverGround'
  const KNOT = 1 / 1.94384
  // A speed rule on a path the server does not report, its numbers shown in SI.
  const logSpeed: Rule = {
    name: 'Speed high',
    slug: 'speed-high',
    message: 'Speed is high',
    signal: { path: 'navigation.logSpeed' },
    detector: {
      type: 'sustained',
      direction: 'above',
      steps: [{ limit: 2.57, priority: 'warning' }],
      duration: 60,
      hysteresis: 0.1
    }
  }
  const editing = { entry: ruleEntry({ slug: logSpeed.slug }), rule: logSpeed }

  /** Types a path into the search, opening it first if need be, without settling it. */
  const typePath = (path: string) => {
    const change = screen.queryByRole('button', { name: 'Change the value to watch' })
    if (change !== null) click(change)
    type(select('Search by name or path'), path)
  }
  /** Types a path and settles it, as leaving the search does. */
  const changePath = (path: string) => {
    typePath(path)
    fireEvent.blur(select('Search by name or path'))
  }

  it('empties the limit and the clear margin once the path is settled, keeping the duration', async () => {
    const { api } = renderEditor({ editing })
    await formShown()
    expect(textbox('Limit for step 1')).toHaveProperty('value', '2.57')
    typePath(SPEED)
    expect(textbox('Limit for step 1')).toHaveProperty('value', '2.57')
    fireEvent.blur(select('Search by name or path'))
    expect(textbox('Limit for step 1')).toHaveProperty('value', '')
    expect(description(textbox('Limit for step 1'))).toContain('Fill in the limit')
    expect(textbox('Clear margin')).toHaveProperty('value', '')
    expect(description(textbox('Clear margin'))).toContain(
      'must be typed again in the unit of the chosen path'
    )
    expect(textbox('For at least')).toHaveProperty('value', '1')
    expect(
      screen.getByText(
        'Fill in the limit to save. The clear margin was emptied: type it again or leave it empty.'
      )
    ).toBeTruthy()
    click(button('Save'))
    expect(api.previewRule).not.toHaveBeenCalled()
  })

  const RETYPE = 'must be typed again in the unit of the chosen path'
  const MARGIN = 'The clear margin was emptied: type it again or leave it empty.'
  const MARGIN_ALONE = 'The clear margin was emptied: type it again, or Save leaves it empty.'
  /** What the footer says stops Save. */
  const footer = () => document.querySelector('.skar-editor-status')?.textContent ?? ''
  const savedDetector = (api: FakeApi) =>
    api.updateRule.mock.calls[0]?.[1].detector as Extract<Rule['detector'], { type: 'sustained' }>

  it('names the emptied clear margin in the footer, beside the limit', async () => {
    renderEditor({ editing })
    await formShown()
    changePath(SPEED)
    expect(footer()).toBe(`Fill in the limit to save. ${MARGIN}`)
    expect(description(textbox('Clear margin'))).toContain(RETYPE)
  })

  it('saves without the clear margin once a refused Save’s footer named it, limits retyped', async () => {
    const { api, onSaved } = renderEditor({ editing })
    await formShown()
    changePath(SPEED)
    click(button('Save'))
    expect(api.previewRule).not.toHaveBeenCalled()
    expect(footer()).toBe(`Fill in the limit to save. ${MARGIN}`)
    expect(description(textbox('Clear margin'))).toContain(RETYPE)
    type(textbox('Limit for step 1'), '5')
    click(button('Save'))
    await saved(onSaved)
    const [[, rule]] = api.updateRule.mock.calls
    expect(rule.signal).toEqual({ path: SPEED })
    const detector = savedDetector(api)
    expect(detector.steps?.[0]?.limit).toBeCloseTo(5 * KNOT)
    expect(detector.hysteresis).toBeUndefined()
    expect(detector.duration).toBe(60)
  })

  it('refuses once for a clear margin no refused Save named, the limit retyped first', async () => {
    const { api, onSaved } = renderEditor({ editing })
    await formShown()
    changePath(SPEED)
    type(textbox('Limit for step 1'), '5')
    click(button('Save'))
    expect(api.previewRule).not.toHaveBeenCalled()
    expect(footer()).toBe(MARGIN_ALONE)
    await waitFor(() => {
      expect(document.activeElement).toBe(textbox('Clear margin'))
    })
    click(button('Save'))
    await saved(onSaved)
    expect(savedDetector(api).hysteresis).toBeUndefined()
  })

  it('empties the numbers of a path typed and saved straight away, focus leaving for Save', async () => {
    const { api } = renderEditor({ editing })
    await formShown()
    typePath(SPEED)
    expect(document.activeElement).toBe(select('Search by name or path'))
    // A browser moves focus on the button's mousedown, a discrete event rendered before its click.
    act(() => {
      button('Save').focus()
    })
    click(button('Save'))
    expect(textbox('Limit for step 1')).toHaveProperty('value', '')
    expect(description(textbox('Limit for step 1'))).toContain('Fill in the limit')
    expect(footer()).toBe(`Fill in the limit to save. ${MARGIN}`)
    expect(api.previewRule).not.toHaveBeenCalled()
    expect(api.updateRule).not.toHaveBeenCalled()
  })

  it('saves a clear margin retyped after Save named it', async () => {
    const { api, onSaved } = renderEditor({ editing })
    await formShown()
    changePath(SPEED)
    click(button('Save'))
    type(textbox('Limit for step 1'), '5')
    type(textbox('Clear margin'), '0.5')
    click(button('Save'))
    await saved(onSaved)
    expect(savedDetector(api).hysteresis).toBeCloseTo(0.5 * KNOT)
  })

  it('names a clear margin again once another change of unit empties it again', async () => {
    const { api } = renderEditor({ editing })
    await formShown()
    changePath(SPEED)
    click(button('Save'))
    type(textbox('Limit for step 1'), '5')
    type(textbox('Clear margin'), '0.5')
    changePath(HOUSE)
    expect(textbox('Clear margin')).toHaveProperty('value', '')
    type(textbox('Limit for step 1'), '12')
    click(button('Save'))
    expect(api.previewRule).not.toHaveBeenCalled()
    expect(footer()).toBe(MARGIN_ALONE)
  })

  it('refuses a zone rule’s Save once, its footer naming the emptied clear margin, then saves', async () => {
    const zoned = example('house-battery-low')
    const { api, onSaved } = renderEditor({
      editing: { entry: ruleEntry({ slug: zoned.slug }), rule: zoned }
    })
    await formShown()
    typePath(SPEED)
    act(() => {
      button('Save').focus()
    })
    click(button('Save'))
    expect(textbox('Clear margin')).toHaveProperty('value', '')
    expect(description(textbox('Clear margin'))).toContain(RETYPE)
    expect(footer()).toBe(MARGIN_ALONE)
    expect(api.previewRule).not.toHaveBeenCalled()
    click(button('Save'))
    await saved(onSaved)
    const detector = savedDetector(api)
    expect(detector.hysteresis).toBeUndefined()
    expect(detector.limit).toEqual(zoned.detector.type === 'sustained' && zoned.detector.limit)
  })

  it('empties the numbers of a stored rule fixed by correcting its path', async () => {
    const { api, onSaved } = renderEditor({
      invalid: {
        slug: logSpeed.slug,
        name: logSpeed.name,
        body: { ...logSpeed, signal: { path: 'navigation..speedOverGround' } },
        errors: [{ path: '/signal/path', message: 'must be a Signal K path' }]
      }
    })
    await formShown()
    expect(textbox('Limit for step 1')).toHaveProperty('value', '2.57')
    changePath(SPEED)
    expect(textbox('Limit for step 1')).toHaveProperty('value', '')
    expect(description(textbox('Limit for step 1'))).toContain('Fill in the limit')
    click(button('Save'))
    expect(api.updateRule).not.toHaveBeenCalled()
    type(textbox('Limit for step 1'), '5')
    click(button('Save'))
    await saved(onSaved)
    const detector = api.updateRule.mock.calls[0]?.[1].detector as Extract<
      Rule['detector'],
      { type: 'sustained' }
    >
    expect(detector.steps?.[0]?.limit).toBeCloseTo(5 * KNOT)
  })

  it('empties a range’s low and high limits and its clear margin', async () => {
    const shore = example('shore-power-frequency')
    const { api } = renderEditor({
      editing: { entry: ruleEntry({ slug: shore.slug }), rule: shore }
    })
    await formShown()
    expect(textbox('Low limit for step 2')).toHaveProperty('value', '48')
    changePath(SPEED)
    for (const n of ['1', '2']) {
      expect(textbox(`Low limit for step ${n}`)).toHaveProperty('value', '')
      expect(textbox(`High limit for step ${n}`)).toHaveProperty('value', '')
    }
    expect(textbox('Clear margin')).toHaveProperty('value', '')
    expect(textbox('Each step must hold for at least')).toHaveProperty('value', '10')
    click(button('Save'))
    expect(api.previewRule).not.toHaveBeenCalled()
    expect(api.updateRule).not.toHaveBeenCalled()
  })

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
      duration: 60,
      hysteresis: 0.2
    }
  }
  const steppedEdit = { entry: ruleEntry({ slug: battery.slug }), rule: stepped }

  it('keeps the numbers for a path shown in the same unit', async () => {
    const { api, onSaved } = renderEditor({ editing: steppedEdit })
    await formShown()
    changePath('electrical.batteries.start.voltage')
    expect(textbox('Limit for step 1')).toHaveProperty('value', '12.2')
    expect(textbox('Limit for step 2')).toHaveProperty('value', '11.8')
    expect(textbox('Clear margin')).toHaveProperty('value', '0.2')
    click(button('Save'))
    await saved(onSaved)
    expect(api.updateRule.mock.calls[0]?.[1].detector).toEqual(stepped.detector)
  })

  it('keeps the numbers while a path in the same unit is typed through partial paths', async () => {
    renderEditor({ editing: steppedEdit })
    await formShown()
    typePath('electrical.batteries.st')
    expect(textbox('Limit for step 1')).toHaveProperty('value', '12.2')
    typePath('electrical.batteries.start')
    changePath('electrical.batteries.start.voltage')
    expect(textbox('Limit for step 1')).toHaveProperty('value', '12.2')
    expect(textbox('Limit for step 2')).toHaveProperty('value', '11.8')
    expect(textbox('Clear margin')).toHaveProperty('value', '0.2')
    expect(document.querySelectorAll('[aria-invalid="true"]')).toHaveLength(0)
    expect(screen.queryByText(/to save\.$/)).toBeNull()
  })

  it('keeps a count, its window and its event value, which have no unit', async () => {
    const bilge = example('bilge-pump-cycling')
    const { api, onSaved } = renderEditor({
      editing: { entry: ruleEntry({ slug: bilge.slug }), rule: bilge }
    })
    await formShown()
    changePath(HOUSE)
    expect(textbox('Limit for step 1')).toHaveProperty('value', '4')
    click(button('Save'))
    await saved(onSaved)
    expect(api.updateRule.mock.calls[0]?.[1].detector).toEqual(bilge.detector)
  })

  it('empties a combination’s limit when an input brings another unit, and a condition’s apart', async () => {
    const rpm = example('engine-rpm-mismatch')
    renderEditor({ editing: { entry: ruleEntry({ slug: rpm.slug }), rule: rpm } })
    await formShown()
    openMoreOptions()
    type(select('Condition 1 input path'), 'propulsion.port.coolantTemperature')
    expect(textbox('Condition 1 limit')).toHaveProperty('value', '480')
    fireEvent.blur(select('Condition 1 input path'))
    expect(textbox('Condition 1 limit')).toHaveProperty('value', '')
    expect(textbox('Condition 2 limit')).toHaveProperty('value', '480')
    expect(textbox('Limit for step 1')).toHaveProperty('value', '180')
    type(select('Combined path 1'), 'propulsion.port.coolantTemperature')
    fireEvent.blur(select('Combined path 1'))
    expect(textbox('Limit for step 1')).toHaveProperty('value', '')
    expect(textbox('Condition 2 limit')).toHaveProperty('value', '480')
  })

  it('empties a combination’s limit when another kind of combination changes its unit', async () => {
    const rpm = example('engine-rpm-mismatch')
    const { api } = renderEditor({ editing: { entry: ruleEntry({ slug: rpm.slug }), rule: rpm } })
    await formShown()
    openMoreOptions()
    choose('Combined combination', 'ratio')
    expect(textbox('Limit for step 1')).toHaveProperty('value', '')
    expect(description(textbox('Limit for step 1'))).toContain('Fill in the limit')
    expect(textbox('Condition 1 limit')).toHaveProperty('value', '480')
    click(button('Save'))
    expect(api.previewRule).not.toHaveBeenCalled()
  })

  describe('over paths the server does not report', () => {
    const unreported = (combinator: CombinatorKind): Rule => ({
      name: 'Tanks apart',
      slug: 'tanks-apart',
      message: 'Tanks apart',
      signal: {
        combinator,
        inputs: [{ path: 'tanks.fuel.port.level' }, { path: 'tanks.fuel.starboard.level' }]
      },
      detector: {
        type: 'sustained',
        direction: 'above',
        steps: [{ limit: 0.2, priority: 'warning' }],
        duration: 60
      }
    })
    const editingCombination = (combinator: CombinatorKind) => {
      const rule = unreported(combinator)
      return renderEditor({ editing: { entry: ruleEntry({ slug: rule.slug }), rule } })
    }

    it.each<[CombinatorKind, CombinatorKind]>([
      ['difference', 'ratio'],
      ['ratio', 'difference']
    ])('empties the limit of a %s changed to a %s', async (from, to) => {
      const { api } = editingCombination(from)
      await formShown()
      openMoreOptions()
      expect(textbox('Limit for step 1')).toHaveProperty('value', '0.2')
      choose('Combined combination', to)
      expect(textbox('Limit for step 1')).toHaveProperty('value', '')
      expect(description(textbox('Limit for step 1'))).toContain('Fill in the limit')
      click(button('Save'))
      expect(api.previewRule).not.toHaveBeenCalled()
    })

    it('keeps the limit of a difference changed to a sum', async () => {
      editingCombination('difference')
      await formShown()
      openMoreOptions()
      choose('Combined combination', 'sum')
      expect(textbox('Limit for step 1')).toHaveProperty('value', '0.2')
    })
  })

  it('keeps a combination’s limit when another kind of combination keeps its unit', async () => {
    const rpm = example('engine-rpm-mismatch')
    renderEditor({ editing: { entry: ruleEntry({ slug: rpm.slug }), rule: rpm } })
    await formShown()
    openMoreOptions()
    choose('Combined combination', 'difference')
    expect(textbox('Limit for step 1')).toHaveProperty('value', '180')
    expect(document.querySelectorAll('[aria-invalid="true"]')).toHaveLength(0)
  })
})

describe('ZONE_PRIORITY', () => {
  it('is the priority the model gives each zone level', () => {
    expect(ZONE_PRIORITY).toEqual(LEVEL_PRIORITY)
  })
})
