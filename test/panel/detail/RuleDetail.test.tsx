// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RuleEntry } from '../../../src/panel/api'
import { RuleDetail, type RuleDetailProps } from '../../../src/panel/detail/RuleDetail'
import type { HistoryPoint, HistorySource } from '../../../src/panel/history/historySource'
import type { PathEntry } from '../../../src/panel/paths/selfPaths'
import { unitLookup } from '../../../src/panel/signalUnits'
import { displayUnit } from '../../../src/panel/units'
import { instance, ruleEntry } from '../fixtures'

const NOW = Date.parse('2026-09-30T12:00:00.000Z')
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString()
const HOUSE = 'electrical.batteries.house.voltage'

const paths: PathEntry[] = [
  { path: HOUSE, units: 'V', unit: displayUnit({ units: 'V' }) },
  {
    path: 'propulsion.port.coolantTemperature',
    units: 'K',
    unit: displayUnit({ units: 'K', displayUnits: { formula: 'value - 273.15', symbol: '°C' } })
  }
]
const units = unitLookup(paths, displayUnit({ units: 'm' }))

const alertingStatus = {
  condition: 'alerting',
  reason: 'alertActive',
  priority: 'warning',
  step: 0,
  value: 11.6,
  limit: 12,
  message: 'House voltage below 12 V for 30 s: 11.6 V',
  changedAt: ago(4)
} as const

/** The approved mock-up's rule: one step, alerting, from a template. */
const houseLow = ruleEntry({
  slug: 'house-low',
  rule: {
    name: 'House bank voltage low',
    alertPath: 'electrical.batteries.house.voltageLow',
    priority: 'warning',
    steps: [{ limit: 12, priority: 'warning' }],
    duration: 30,
    message: '{instance} voltage below {limit} for {duration}: {value}',
    signal: { paths: [HOUSE] },
    template: { set: 'builtin', id: 'lifepo4-voltage-low', pick: { instance: 'house' } }
  },
  status: {
    ...alertingStatus,
    instances: [instance({ ...alertingStatus })]
  }
})

/** The escalation addendum's rule: warning below 12.2 V, alarm below 11.8 V, at the alarm. */
const stepped = ruleEntry({
  slug: 'house-low',
  rule: {
    name: 'House bank voltage low',
    priority: 'warning',
    steps: [
      { limit: 12.2, priority: 'warning' },
      { limit: 11.8, priority: 'alarm' }
    ],
    duration: 30,
    signal: { paths: [HOUSE] }
  },
  status: {
    ...alertingStatus,
    priority: 'alarm',
    step: 1,
    limit: 11.8,
    instances: [instance({ ...alertingStatus, priority: 'alarm', step: 1, limit: 11.8 })]
  }
})

const disabledHouse = ruleEntry({
  ...houseLow,
  rule: houseLow.rule,
  disabled: { since: ago(2 * 24 * 60), actor: 'skipper', note: 'Shunt cable loose' },
  status: {
    ruleState: 'disabled',
    condition: 'present',
    reason: 'conditionPresent',
    value: 11.9,
    limit: 12,
    changedAt: ago(2 * 24 * 60)
  }
})

const engineHours = ruleEntry({
  slug: 'engine-hours',
  rule: {
    name: 'Engine service due',
    steps: [{ limit: 360000, priority: 'caution' }],
    detector: { type: 'accumulator', measure: 'time' },
    signal: { paths: ['propulsion.*.revolutions'] }
  },
  status: {
    instances: [
      instance({
        instance: { name: 'port', segment: 'port' },
        progress: { kind: 'total', total: 7200, limit: 360000 }
      }),
      instance({
        instance: { name: 'stbd', segment: 'stbd' },
        progress: { kind: 'total', total: 3600, limit: 360000 }
      })
    ]
  }
})

function admin() {
  return {
    edit: vi.fn(),
    reset: vi.fn(() => Promise.resolve()),
    disable: vi.fn((_note: string) => Promise.resolve()),
    enable: vi.fn(() => Promise.resolve()),
    remove: vi.fn(() => Promise.resolve())
  }
}

function renderDetail(entry: RuleEntry, props: Partial<RuleDetailProps> = {}) {
  return render(<RuleDetail entry={entry} backHref="#/list" units={units} now={NOW} {...props} />)
}

async function click(element: HTMLElement) {
  await act(async () => {
    fireEvent.click(element)
    await Promise.resolve()
  })
}

const fact = (term: RegExp) => screen.getByRole('definition', { name: term }).textContent

describe('RuleDetail', () => {
  afterEach(cleanup)

  describe('alerting', () => {
    it('shows the rule with its state, priority and a way back to the list', () => {
      renderDetail(houseLow)
      expect(screen.getByRole('heading', { name: 'House bank voltage low' })).toBeTruthy()
      expect(screen.getByRole('link', { name: 'Alert rules' }).getAttribute('href')).toBe('#/list')
      const state = screen.getByRole('group', { name: 'State' })
      expect(state.textContent).toBe('AlertingWarning')
    })

    it('explains the state in one sentence', () => {
      renderDetail(houseLow)
      expect(screen.getByText(/has been/).closest('p')?.textContent).toBe(
        'House voltage has been below 12 V for 4 min. Now 11.6 V.'
      )
    })

    it('lists what the rule watches and when it alerts', () => {
      renderDetail(houseLow)
      expect(fact(/watches/i)).toBe(HOUSE)
      expect(fact(/source/i)).toBe('Preferred source')
      expect(fact(/alerts when/i)).toBe('below 12 V for at least 30 s')
      expect(fact(/^priority/i)).toBe('Warning')
      expect(fact(/alert path/i)).toBe('alerts.electrical.batteries.house.voltageLow')
      expect(fact(/message/i)).toBe('House voltage below 12 V for 30 s: 11.6 V')
      expect(fact(/from template/i)).toBe('lifepo4-voltage-low (builtin)')
    })

    it('gives the stored message and the pinned source of a rule that is not alerting', () => {
      renderDetail(ruleEntry({ rule: { message: 'Oil pressure {value}', source: 'n2k.115' } }))
      expect(fact(/message/i)).toBe('Oil pressure {value}')
      expect(fact(/source/i)).toBe('n2k.115')
      expect(screen.queryByRole('definition', { name: /from template/i })).toBeNull()
    })

    it('offers Edit, Disable and Delete to an administrator, and points to the alert console', () => {
      renderDetail(houseLow, admin())
      const rule = screen.getByRole('group', { name: 'Rule' })
      expect(
        within(rule)
          .getAllByRole('button')
          .map((b) => b.textContent)
      ).toEqual(['Edit', 'Disable', 'Delete'])
      expect(
        screen.getByText('To acknowledge or silence the alert itself, use the alert console.')
      ).toBeTruthy()
    })
  })

  describe('steps', () => {
    it('shows the ladder with the step reached marked and the earlier one passed', () => {
      renderDetail(stepped)
      const ladder = screen.getByRole('list', { name: 'Steps' })
      const rungs = within(ladder).getAllByRole('listitem')
      expect(rungs.map((r) => r.textContent)).toEqual([
        'Warningbelow 12.2 Vpassed',
        'Alarmbelow 11.8 Vreached'
      ])
      expect(rungs[1].getAttribute('aria-current')).toBe('step')
      expect(rungs[0].getAttribute('aria-current')).toBeNull()
      expect(screen.getByText(/^Clears when/).textContent).toBe(
        'Clears when the value is back above 12.2 V. It stays an alarm until then.'
      )
    })

    it('shows the priority reached next to the state, and each step in the facts', () => {
      renderDetail(stepped)
      expect(screen.getByRole('group', { name: 'State' }).textContent).toBe('AlertingAlarm')
      expect(fact(/alerts when/i)).toBe(
        'below 12.2 V (warning), below 11.8 V (alarm), each for at least 30 s'
      )
      expect(screen.queryByRole('definition', { name: /^priority/i })).toBeNull()
    })

    it('marks no step while the rule is not alerting', () => {
      renderDetail({ ...stepped, status: { ...stepped.status, ...ruleEntry().status } })
      const rungs = within(screen.getByRole('list', { name: 'Steps' })).getAllByRole('listitem')
      expect(rungs.map((r) => r.textContent)).toEqual(['Warningbelow 12.2 V', 'Alarmbelow 11.8 V'])
      expect(screen.getByText(/^Clears when/).textContent).toBe(
        'Clears when the value is back above 12.2 V.'
      )
    })

    it('shows no ladder for a rule with one step', () => {
      renderDetail(houseLow)
      expect(screen.queryByRole('list', { name: 'Steps' })).toBeNull()
    })
  })

  describe('an outside rule', () => {
    const HEEL = 'navigation.heel'
    const heelUnits = unitLookup(
      [{ path: HEEL, units: '°', unit: displayUnit({ units: '°' }) }],
      displayUnit({ units: 'm' })
    )
    const heelAlert = {
      ...alertingStatus,
      value: 27,
      limit: 25,
      passed: 'high',
      message: 'Heel 27 °'
    } as const
    const heel = ruleEntry({
      slug: 'heel',
      rule: {
        name: 'Heel',
        alertPath: 'navigation.heelOutOfRange',
        priority: 'warning',
        steps: [
          { low: -25, high: 25, priority: 'warning' },
          { low: -35, high: 35, priority: 'alarm' }
        ],
        duration: 10,
        detector: { type: 'outside' },
        signal: { paths: [HEEL] }
      },
      status: { ...heelAlert, instances: [instance({ ...heelAlert })] }
    })

    it('explains the side and limit passed while active', () => {
      renderDetail(heel, { units: heelUnits })
      expect(screen.getByText(/has been/).closest('p')?.textContent).toBe(
        'Heel has been outside -25 to 25 ° for 4 min and went above 25 °. Now 27 °.'
      )
    })

    it('shows each step’s range, and clears back between the first step’s limits', () => {
      renderDetail(heel, { units: heelUnits })
      const rungs = within(screen.getByRole('list', { name: 'Steps' })).getAllByRole('listitem')
      expect(rungs.map((r) => r.textContent)).toEqual([
        'Warningoutside -25 to 25 °reached',
        'Alarmoutside -35 to 35 °'
      ])
      expect(fact(/alerts when/i)).toBe(
        'outside -25 to 25 ° (warning), outside -35 to 35 ° (alarm), each for at least 10 s'
      )
      expect(screen.getByText(/^Clears when/).textContent).toBe(
        'Clears when the value is back between -25 and 25 °. It stays a warning until then.'
      )
    })

    it('renders a normal state with no limit', () => {
      const normal = { ...ruleEntry().status, value: 3 }
      renderDetail(
        { ...heel, status: { ...normal, instances: [instance({ value: 3 })] } },
        { units: heelUnits }
      )
      expect(screen.getByText(/^Within limits/).textContent).toBe('Within limits. Now 3 °.')
      expect(screen.getByText(/^Clears when/).textContent).toBe(
        'Clears when the value is back between -25 and 25 °.'
      )
    })

    it('charts the lowest and highest heel against both limits of each step', async () => {
      const bucket = (i: number) => Date.now() - 86_400_000 + i * 600_000
      const lows = Array.from({ length: 144 }, (_, i) => ({ time: bucket(i), value: -27 }))
      const highs = Array.from({ length: 144 }, (_, i) => ({ time: bucket(i), value: 36 }))
      const values = vi.fn(() => Promise.resolve([lows, highs]))
      renderDetail(heel, {
        units: heelUnits,
        history: { hasProvider: () => Promise.resolve(true), values }
      })
      for (let i = 0; i < 2; i++) {
        await act(async () => {
          await Promise.resolve()
        })
      }
      expect(values).toHaveBeenCalledWith(expect.objectContaining({ methods: ['min', 'max'] }))
      const chart = screen.getByRole('img', { name: 'Last 24 hours with the limits' })
      for (const label of ['warning -25 °', 'warning 25 °', 'alarm -35 °', 'alarm 35 °']) {
        expect(chart.textContent).toContain(label)
      }
      expect(
        screen.getByText(
          /^Lowest -27 ° at .+; highest 36 ° at .+\. It went below the warning limit and above the alarm limit\.$/
        )
      ).toBeTruthy()
    })
  })

  describe('disabled', () => {
    it('says who disabled it, when and why, and whether the condition is still present', () => {
      renderDetail(disabledHouse)
      expect(screen.getByRole('group', { name: 'State' }).textContent).toBe('Disabled')
      expect(screen.getByText('Disabled by skipper, 2 d ago')).toBeTruthy()
      expect(screen.getByText('“Shunt cable loose”')).toBeTruthy()
      expect(screen.getByText(/still present/).closest('p')?.textContent).toBe(
        'Condition still present: below 12 V for at least 2 d, now 11.9 V.'
      )
    })

    it('says "just now" and leaves out the time held for a rule disabled under a minute ago', () => {
      renderDetail({
        ...disabledHouse,
        disabled: { since: new Date(NOW - 10_000).toISOString(), actor: 'skipper' },
        status: { ...disabledHouse.status, changedAt: new Date(NOW - 10_000).toISOString() }
      })
      expect(screen.getByText('Disabled by skipper, just now')).toBeTruthy()
      expect(screen.getByText(/still present/).closest('p')?.textContent).toBe(
        'Condition still present: below 12 V, now 11.9 V.'
      )
    })

    it('names the actor "someone" when nobody was logged in', () => {
      renderDetail({
        ...disabledHouse,
        disabled: { since: ago(5), actor: 'unauthenticated' }
      })
      expect(screen.getByText('Disabled by someone, 5 min ago')).toBeTruthy()
    })

    it('offers Enable rule first, then Edit and Delete, and no Disable', () => {
      renderDetail(disabledHouse, admin())
      expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual([
        'Enable rule',
        'Edit',
        'Delete'
      ])
    })

    it('enables at once, without a confirmation', async () => {
      const controls = admin()
      renderDetail(disabledHouse, controls)
      await click(screen.getByRole('button', { name: 'Enable rule' }))
      expect(controls.enable).toHaveBeenCalledOnce()
      expect(screen.queryByRole('alertdialog')).toBeNull()
    })

    it("shows the server's message when enabling is refused", async () => {
      const controls = admin()
      controls.enable.mockRejectedValue(new Error('no such rule'))
      renderDetail(disabledHouse, controls)
      await click(screen.getByRole('button', { name: 'Enable rule' }))
      expect(screen.getByRole('alert').textContent).toContain('no such rule')
    })

    it('returns focus to Enable rule once the request finishes', async () => {
      const controls = admin()
      let finish: () => void = () => undefined
      controls.enable.mockReturnValue(
        new Promise<void>((resolve) => {
          finish = resolve
        })
      )
      renderDetail(disabledHouse, controls)
      const button = screen.getByRole<HTMLButtonElement>('button', { name: 'Enable rule' })
      button.focus()
      await click(button)
      expect(button.disabled).toBe(true)
      // A browser drops focus to the page as the button is disabled; jsdom does
      // that only when the focused element goes.
      const elsewhere = document.body.appendChild(document.createElement('input'))
      elsewhere.focus()
      elsewhere.remove()
      await act(async () => {
        finish()
        await Promise.resolve()
      })
      expect(document.activeElement).toBe(button)
    })

    it('moves focus to Disable once the rule shows enabled', async () => {
      const controls = admin()
      const { rerender } = renderDetail(disabledHouse, controls)
      const button = screen.getByRole('button', { name: 'Enable rule' })
      button.focus()
      await click(button)
      rerender(
        <RuleDetail entry={houseLow} backHref="#/list" units={units} now={NOW} {...controls} />
      )
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Disable' }))
    })

    it('leaves focus alone when a poll shows the rule enabled by someone else', () => {
      const controls = admin()
      const { rerender } = renderDetail(disabledHouse, controls)
      screen.getByRole('button', { name: 'Enable rule' }).focus()
      rerender(
        <RuleDetail entry={houseLow} backHref="#/list" units={units} now={NOW} {...controls} />
      )
      expect(document.activeElement).toBe(document.body)
    })
  })

  describe('by access level', () => {
    it('offers a read-only user no controls', () => {
      renderDetail(houseLow)
      expect(screen.queryAllByRole('button')).toEqual([])
      expect(screen.queryByRole('group', { name: 'Rule' })).toBeNull()
    })

    it('offers a read/write user Disable only', () => {
      const { disable, enable } = admin()
      renderDetail(houseLow, { disable, enable })
      expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['Disable'])
    })

    it('offers the total reset to an administrator, for an accumulator only', () => {
      renderDetail(engineHours, admin())
      expect(screen.getByRole('button', { name: 'Reset total…' })).toBeTruthy()
      cleanup()
      renderDetail(houseLow, admin())
      expect(screen.queryByRole('button', { name: /reset/i })).toBeNull()
    })
  })

  describe('the Disable sheet', () => {
    it('asks to confirm, naming the rule and the alert it clears, with an optional note', async () => {
      const controls = admin()
      renderDetail(houseLow, controls)
      const trigger = screen.getByRole('button', { name: 'Disable' })
      fireEvent.click(trigger)
      const sheet = screen.getByRole('alertdialog', {
        name: 'Disable the rule “House bank voltage low”?'
      })
      expect(sheet.textContent).toContain(
        'This disables the rule. It raises no alerts until someone enables it again, and its current alert is cleared now.'
      )
      expect(sheet.textContent).toContain(
        'To acknowledge or silence the alert instead, use the alert console.'
      )
      const note = within(sheet).getByRole<HTMLInputElement>('textbox', { name: /why/i })
      expect(note.maxLength).toBe(500)
      fireEvent.change(note, { target: { value: ' Shunt cable loose ' } })
      expect(controls.disable).not.toHaveBeenCalled()
      await click(within(sheet).getByRole('button', { name: 'Disable rule' }))
      expect(controls.disable).toHaveBeenCalledWith('Shunt cable loose')
      expect(screen.queryByRole('alertdialog')).toBeNull()
      expect(document.activeElement).toBe(trigger)
    })

    it('moves focus to Enable rule once the rule shows disabled', async () => {
      const controls = admin()
      const { rerender } = renderDetail(houseLow, controls)
      fireEvent.click(screen.getByRole('button', { name: 'Disable' }))
      await click(screen.getByRole('button', { name: 'Disable rule' }))
      rerender(
        <RuleDetail entry={disabledHouse} backHref="#/list" units={units} now={NOW} {...controls} />
      )
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Enable rule' }))
    })

    it('moves focus to Enable rule when the rule shows disabled before the request answers', async () => {
      const controls = admin()
      let finish: () => void = () => undefined
      controls.disable.mockReturnValue(
        new Promise<void>((resolve) => {
          finish = resolve
        })
      )
      const { rerender } = renderDetail(houseLow, controls)
      fireEvent.click(screen.getByRole('button', { name: 'Disable' }))
      await click(screen.getByRole('button', { name: 'Disable rule' }))
      rerender(
        <RuleDetail entry={disabledHouse} backHref="#/list" units={units} now={NOW} {...controls} />
      )
      await act(async () => {
        finish()
        await Promise.resolve()
      })
      expect(screen.queryByRole('alertdialog')).toBeNull()
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Enable rule' }))
    })

    it('closes when a poll shows the rule disabled by someone else, and stays closed', () => {
      const controls = admin()
      const { rerender } = renderDetail(houseLow, controls)
      fireEvent.click(screen.getByRole('button', { name: 'Disable' }))
      const show = (entry: RuleEntry) => {
        rerender(
          <RuleDetail entry={entry} backHref="#/list" units={units} now={NOW} {...controls} />
        )
      }
      show(disabledHouse)
      expect(screen.queryByRole('alertdialog')).toBeNull()
      expect(document.activeElement).toBe(document.body)
      show(houseLow)
      expect(screen.queryByRole('alertdialog')).toBeNull()
      expect(controls.disable).not.toHaveBeenCalled()
    })

    it('names the count of the current alerts it clears', () => {
      const firing = { condition: 'alerting', reason: 'alertActive', priority: 'warning' } as const
      renderDetail(
        ruleEntry({
          rule: { name: 'Battery low', signal: { paths: ['electrical.batteries.*.voltage'] } },
          status: {
            instances: [
              instance({ instance: { name: 'house', segment: 'house' }, ...firing }),
              instance({ instance: { name: 'start', segment: 'start' }, ...firing })
            ]
          }
        }),
        admin()
      )
      fireEvent.click(screen.getByRole('button', { name: 'Disable' }))
      expect(screen.getByRole('alertdialog').textContent).toContain(
        'It raises no alerts until someone enables it again, and its 2 current alerts are cleared now.'
      )
    })

    it('does not mention an alert for a rule that raises none', () => {
      renderDetail(ruleEntry({ rule: { name: 'Oil pressure low' } }), admin())
      fireEvent.click(screen.getByRole('button', { name: 'Disable' }))
      const sheet = screen.getByRole('alertdialog')
      expect(sheet.textContent).toContain(
        'This disables the rule. It raises no alerts until someone enables it again.'
      )
      expect(sheet.textContent).not.toMatch(/cleared|alert console/)
    })

    it('disables without a note', async () => {
      const controls = admin()
      renderDetail(houseLow, controls)
      fireEvent.click(screen.getByRole('button', { name: 'Disable' }))
      await click(screen.getByRole('button', { name: 'Disable rule' }))
      expect(controls.disable).toHaveBeenCalledWith('')
    })

    it('cancels without disabling, by the button or Escape', () => {
      const controls = admin()
      renderDetail(houseLow, controls)
      fireEvent.click(screen.getByRole('button', { name: 'Disable' }))
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
      expect(screen.queryByRole('alertdialog')).toBeNull()
      fireEvent.click(screen.getByRole('button', { name: 'Disable' }))
      fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Escape' })
      expect(screen.queryByRole('alertdialog')).toBeNull()
      expect(controls.disable).not.toHaveBeenCalled()
    })

    it('stays open with the error and the typed note when disabling fails', async () => {
      const controls = admin()
      controls.disable.mockRejectedValue(new Error('the plugin is not running'))
      renderDetail(houseLow, controls)
      fireEvent.click(screen.getByRole('button', { name: 'Disable' }))
      fireEvent.change(screen.getByRole('textbox', { name: /why/i }), {
        target: { value: 'typed' }
      })
      await click(screen.getByRole('button', { name: 'Disable rule' }))
      const sheet = screen.getByRole('alertdialog')
      expect(within(sheet).getByRole('alert').textContent).toBe('the plugin is not running')
      expect(within(sheet).getByRole<HTMLInputElement>('textbox').value).toBe('typed')
    })
  })

  describe('Delete', () => {
    it('confirms naming the rule, then deletes', async () => {
      const controls = admin()
      renderDetail(houseLow, controls)
      fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
      const sheet = screen.getByRole('alertdialog', {
        name: 'Delete the rule “House bank voltage low”?'
      })
      expect(sheet.textContent).toMatch(/clears its alerts.*cannot be undone/i)
      expect(controls.remove).not.toHaveBeenCalled()
      await click(within(sheet).getByRole('button', { name: 'Delete rule' }))
      expect(controls.remove).toHaveBeenCalledOnce()
    })

    it('keeps the confirmation open with the error when deleting fails', async () => {
      const controls = admin()
      controls.remove.mockRejectedValue(new Error('no such rule'))
      renderDetail(houseLow, controls)
      fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
      await click(screen.getByRole('button', { name: 'Delete rule' }))
      expect(within(screen.getByRole('alertdialog')).getByRole('alert').textContent).toBe(
        'no such rule'
      )
    })
  })

  describe('the total reset', () => {
    it('confirms, listing the totals it discards, before resetting', async () => {
      const controls = admin()
      renderDetail(engineHours, controls)
      fireEvent.click(screen.getByRole('button', { name: 'Reset total…' }))
      const sheet = screen.getByRole('alertdialog')
      expect(sheet.textContent).toMatch(/port: 2 h/)
      expect(sheet.textContent).toMatch(/stbd: 60 min/)
      expect(sheet.textContent).toMatch(/clears its active alerts/i)
      await click(within(sheet).getByRole('button', { name: 'Reset total' }))
      expect(controls.reset).toHaveBeenCalledOnce()
      expect(screen.queryByRole('alertdialog')).toBeNull()
    })

    it('keeps the confirmation open with the error when the reset fails', async () => {
      const controls = admin()
      controls.reset.mockRejectedValue(new Error('only an accumulator rule can be reset'))
      renderDetail(engineHours, controls)
      fireEvent.click(screen.getByRole('button', { name: 'Reset total…' }))
      await click(screen.getByRole('button', { name: 'Reset total' }))
      expect(screen.getByRole('alert').textContent).toContain(
        'only an accumulator rule can be reset'
      )
    })
  })

  describe('a wildcard rule', () => {
    const batteries = ruleEntry({
      slug: 'battery-low',
      rule: {
        name: 'Battery low',
        alertPath: 'electrical.batteries.*.voltageLow',
        signal: { paths: ['electrical.batteries.*.voltage'] }
      },
      status: {
        condition: 'alerting',
        reason: 'alertActive',
        priority: 'alarm',
        instance: { name: 'start', segment: 'start' },
        value: 11.5,
        limit: 12,
        issues: ['instance a.b was not admitted'],
        instances: [
          instance({ instance: { name: 'house', segment: 'house' }, value: 12.6, limit: 12 }),
          instance({
            instance: { name: 'start', segment: 'start' },
            condition: 'alerting',
            reason: 'alertActive',
            priority: 'alarm',
            value: 11.5,
            limit: 12
          }),
          instance({
            instance: { name: 'Aft', segment: 'aft' },
            condition: 'noData',
            reason: 'neverReported',
            value: undefined
          })
        ]
      }
    })

    it('lists every instance with its own state', () => {
      renderDetail(batteries)
      const list = screen.getByRole('list', { name: 'Instances' })
      expect(
        within(list)
          .getAllByRole('listitem')
          .map((i) => i.textContent)
      ).toEqual([
        'house12.6 V, limit 12 VNormal',
        'start11.5 V, limit 12 VAlertingAlarm',
        'AftNo value since the plugin startedNo data'
      ])
      expect(screen.getByText('instance a.b was not admitted')).toBeTruthy()
    })

    it('marks the instance a link names', () => {
      renderDetail(batteries, { instance: 'aft' })
      const linked = screen
        .getAllByRole('listitem')
        .filter((i) => i.getAttribute('aria-current') === 'true')
      expect(linked.map((i) => i.textContent)).toEqual([
        'AftNo value since the plugin startedNo data'
      ])
    })

    it('says so when the linked instance is not there', () => {
      renderDetail(batteries, { instance: 'bow' })
      expect(screen.getByRole('status').textContent).toMatch(/no instance bow/i)
    })
  })

  it('shows the errors of a rule whose evaluation fails', () => {
    renderDetail(
      ruleEntry({
        status: {
          condition: 'problem',
          reason: 'evaluationError',
          errors: ['evaluation threw', 'subscription refused']
        }
      })
    )
    const errors = screen.getByRole('list', { name: /errors/i })
    expect(
      within(errors)
        .getAllByRole('listitem')
        .map((i) => i.textContent)
    ).toEqual(['evaluation threw', 'subscription refused'])
  })

  it('says values are in SI units when no display unit applies', () => {
    renderDetail(ruleEntry())
    expect(screen.getByText(/values are in SI units/i)).toBeTruthy()
  })

  it('shows values in the display unit, without the SI note', () => {
    renderDetail(
      ruleEntry({
        rule: {
          steps: [{ limit: 373.15, priority: 'alarm' }],
          detector: { type: 'sustained', direction: 'above' },
          signal: { paths: ['propulsion.port.coolantTemperature'] }
        },
        status: { value: 368.15 }
      })
    )
    expect(fact(/alerts when/i)).toBe('above 100 °C')
    expect(screen.queryByText(/values are in SI units/i)).toBeNull()
  })

  describe('history', () => {
    const day: HistoryPoint[] = Array.from({ length: 144 }, (_, i) => ({
      time: Date.now() - 86_400_000 + i * 600_000,
      value: 12.5
    }))
    const history = (
      values: () => Promise<HistoryPoint[][]> = () => Promise.resolve([day])
    ): HistorySource => ({ hasProvider: () => Promise.resolve(true), values })

    async function settle() {
      for (let i = 0; i < 2; i++) {
        await act(async () => {
          await Promise.resolve()
        })
      }
    }

    it('charts the path with the limit, after the steps and before the facts', async () => {
      renderDetail(stepped, { history: history() })
      await settle()
      const chart = screen.getByRole('img', { name: 'Last 24 hours with the limits' })
      expect(chart.textContent).toContain('warning 12.2 V')
      expect(chart.textContent).toContain('alarm 11.8 V')
      const card = chart.closest('section')
      const steps = screen.getByRole('heading', { name: 'Steps' })
      const facts = screen.getByRole('definition', { name: /watches/i })
      expect(steps.compareDocumentPosition(card as Node)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
      expect(facts.compareDocumentPosition(card as Node)).toBe(Node.DOCUMENT_POSITION_PRECEDING)
    })

    it('names the chart after the path, as the server names it', async () => {
      const named = unitLookup(
        [{ ...paths[0], displayName: 'House bank voltage' }],
        displayUnit({ units: 'm' })
      )
      renderDetail(houseLow, { history: history(), units: named })
      await settle()
      expect(screen.getByRole('heading', { name: 'House bank voltage' })).toBeTruthy()
      expect(screen.getByRole('img', { name: 'Last 24 hours with the limit' })).toBeTruthy()
    })

    it('leaves the rest of the rule as it is when the history fails', async () => {
      renderDetail(houseLow, {
        history: history(() => Promise.reject(new Error('timed out')))
      })
      await settle()
      expect(screen.getByText('History unavailable.')).toBeTruthy()
      expect(fact(/alerts when/i)).toBe('below 12 V for at least 30 s')
      expect(screen.queryByRole('alert')).toBeNull()
    })

    it('has no chart for a rule over several instances', async () => {
      const wildcard = ruleEntry({
        rule: { signal: { paths: ['electrical.batteries.*.voltage'] } }
      })
      renderDetail(wildcard, { history: history() })
      await settle()
      expect(screen.queryByText(/Loading history/)).toBeNull()
      expect(screen.queryByRole('group', { name: 'Span' })).toBeNull()
    })
  })
})
