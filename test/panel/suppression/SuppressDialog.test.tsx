// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  RuleRejectedError,
  SessionExpiredError,
  type InputSuppressionPreview,
  type RuleEntry,
  type Suppression,
  type SuppressionRequest
} from '../../../src/panel/api'
import type { PathSource } from '../../../src/panel/paths/selfPaths'
import { SuppressDialog, type SuppressTarget } from '../../../src/panel/suppression/SuppressDialog'
import { displayUnit } from '../../../src/panel/units'
import { instance, ruleEntry } from '../fixtures'

const RPM = 'propulsion.port.revolutions'

const rpmHigh = ruleEntry({ slug: 'rpm-high', rule: { name: 'RPM high' } })
const rpmEach = ruleEntry({ slug: 'rpm-each', rule: { name: 'RPM high, each engine' } })
const coolant = ruleEntry({ slug: 'coolant-high', rule: { name: 'Coolant high' } })
const oil = ruleEntry({
  status: {
    badge: 'alertActive',
    instances: [instance({ badge: 'alertActive', active: true })]
  }
})
const rules = [rpmHigh, rpmEach, coolant, oil]

const preview: InputSuppressionPreview = {
  path: RPM,
  suppresses: [
    { rule: 'user.rpm-high', origin: 'user', slug: 'rpm-high' },
    { rule: 'user.rpm-each', origin: 'user', slug: 'rpm-each', instance: 'port' }
  ],
  freezes: [
    {
      rule: 'user.coolant-high',
      origin: 'user',
      slug: 'coolant-high',
      gate: 0,
      states: [{ holds: true }]
    }
  ]
}

const paths: PathSource = {
  selfPaths: () =>
    Promise.resolve([{ path: RPM, units: 'Hz', unit: displayUnit({ units: 'Hz' }) }]),
  distanceUnit: () => Promise.resolve(displayUnit({ units: 'm' }))
}

function renderDialog(target: SuppressTarget, answer = preview) {
  const api = {
    suppressRule: vi.fn((_o: string, _s: string, _r: SuppressionRequest) =>
      Promise.resolve<RuleEntry>(oil)
    ),
    suppressInput: vi.fn((path: string, _r: SuppressionRequest) =>
      Promise.resolve<Suppression>({ scope: 'input', path, since: '', actor: 'admin' })
    ),
    previewInputSuppression: vi.fn((_path: string) => Promise.resolve(answer))
  }
  const onDone = vi.fn()
  const onClose = vi.fn()
  render(
    <SuppressDialog
      target={target}
      context={{ api, rules, paths, done: onDone }}
      onClose={onClose}
    />
  )
  return { api, onDone, onClose }
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

async function click(element: HTMLElement) {
  await act(async () => {
    fireEvent.click(element)
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

const dialog = () => screen.getByRole('dialog')

describe('SuppressDialog', () => {
  afterEach(cleanup)

  describe('an input', () => {
    it('lists the rules it suppresses and the gated rules it freezes', async () => {
      const { api } = renderDialog({ kind: 'input', path: RPM })
      await settle()
      expect(api.previewInputSuppression).toHaveBeenCalledWith(RPM)
      expect(screen.getByRole('heading', { name: `Suppress input ${RPM}` })).toBeTruthy()
      const suppressed = screen.getByRole('list', { name: /rules it suppresses/i })
      expect(
        within(suppressed)
          .getAllByRole('listitem')
          .map((i) => i.textContent)
      ).toEqual(['RPM high', 'RPM high, each engine: instance port'])
      const frozen = screen.getByRole('list', { name: /gated rules it freezes/i })
      expect(
        within(frozen)
          .getAllByRole('listitem')
          .map((i) => i.textContent)
      ).toEqual(['Coolant high: gate 1 frozen as holding'])
    })

    it('suppresses with a note and ends manually by default', async () => {
      const { api, onDone, onClose } = renderDialog({ kind: 'input', path: RPM })
      await settle()
      expect(screen.getByRole<HTMLInputElement>('radio', { name: /manually/i }).checked).toBe(true)
      fireEvent.change(screen.getByRole('textbox', { name: 'Note' }), {
        target: { value: 'Tachometer sender faulty' }
      })
      await click(within(dialog()).getByRole('button', { name: 'Suppress' }))
      expect(api.suppressInput).toHaveBeenCalledWith(RPM, { note: 'Tachometer sender faulty' })
      expect(onClose).toHaveBeenCalledOnce()
      expect(onDone).toHaveBeenCalledOnce()
    })

    it('says so when no rule reads the path', async () => {
      renderDialog({ kind: 'input', path: 'a.b' }, { path: 'a.b', suppresses: [], freezes: [] })
      await settle()
      expect(dialog().textContent).toMatch(/no rule reads this path/i)
    })

    it('picks the path, then shows what it suppresses before suppressing', async () => {
      const { api } = renderDialog({ kind: 'input' })
      await settle()
      const suppress = within(dialog()).getByRole<HTMLButtonElement>('button', { name: 'Suppress' })
      expect(suppress.disabled).toBe(true)
      fireEvent.change(screen.getByRole('combobox', { name: 'Input path' }), {
        target: { value: RPM }
      })
      await click(screen.getByRole('button', { name: /show what it suppresses/i }))
      expect(api.previewInputSuppression).toHaveBeenCalledWith(RPM)
      expect(screen.getByRole('list', { name: /rules it suppresses/i })).toBeTruthy()
      expect(suppress.disabled).toBe(false)
      fireEvent.change(screen.getByRole('combobox', { name: 'Input path' }), {
        target: { value: 'propulsion.stbd.revolutions' }
      })
      expect(screen.queryByRole('list', { name: /rules it suppresses/i })).toBeNull()
      expect(suppress.disabled).toBe(true)
    })

    it("shows the server's message when the preview is refused", async () => {
      const { api } = renderDialog({ kind: 'input' })
      api.previewInputSuppression.mockRejectedValue(
        new RuleRejectedError('invalid request body', [
          { path: '/path', message: 'must be a path without a wildcard' }
        ])
      )
      fireEvent.change(screen.getByRole('combobox', { name: 'Input path' }), {
        target: { value: 'propulsion.*.revolutions' }
      })
      await click(screen.getByRole('button', { name: /show what it suppresses/i }))
      expect(screen.getByRole('alert').textContent).toMatch(/must be a path without a wildcard/)
    })
  })

  describe('a rule', () => {
    it('tells suppressing from disabling and names the alerts it clears', () => {
      renderDialog({ kind: 'rule', entry: oil })
      expect(screen.getByRole('heading', { name: 'Suppress Oil pressure low' })).toBeTruthy()
      expect(dialog().textContent).toMatch(/temporarily.*known fault.*keeps evaluating/i)
      expect(dialog().textContent).toMatch(/off until.*disable it instead/i)
      expect(dialog().textContent).toMatch(/clears its 1 active alert\b/i)
    })

    it('suppresses with an auto-end after a duration in the chosen unit', async () => {
      const { api, onDone } = renderDialog({ kind: 'rule', entry: oil })
      fireEvent.click(screen.getByRole('radio', { name: /by itself/i }))
      fireEvent.change(screen.getByRole('textbox', { name: /clear for/i }), {
        target: { value: '10' }
      })
      fireEvent.change(screen.getByRole('combobox', { name: /clear for.*unit/i }), {
        target: { value: 'min' }
      })
      await click(within(dialog()).getByRole('button', { name: 'Suppress' }))
      expect(api.suppressRule).toHaveBeenCalledWith('user', 'oil-pressure-low', {
        autoEndAfter: 600
      })
      expect(onDone).toHaveBeenCalledOnce()
    })

    it('asks for a duration before sending an auto-end', async () => {
      const { api } = renderDialog({ kind: 'rule', entry: oil })
      fireEvent.click(screen.getByRole('radio', { name: /by itself/i }))
      await click(within(dialog()).getByRole('button', { name: 'Suppress' }))
      expect(api.suppressRule).not.toHaveBeenCalled()
      const field = screen.getByRole('textbox', { name: /clear for/i })
      expect(field.getAttribute('aria-invalid')).toBe('true')
      expect(dialog().textContent).toMatch(/must be a number/i)
    })

    it('says it replaces a suppression the rule has', () => {
      renderDialog({
        kind: 'rule',
        entry: { ...oil, suppression: { since: '2026-09-30T12:00:00.000Z', actor: 'admin' } }
      })
      expect(dialog().textContent).toMatch(/replaces the suppression/i)
    })
  })

  it("keeps the dialog open with the server's message when refused", async () => {
    const { api, onDone } = renderDialog({ kind: 'rule', entry: oil })
    api.suppressRule.mockRejectedValue(new Error('no such rule'))
    await click(within(dialog()).getByRole('button', { name: 'Suppress' }))
    expect(screen.getByRole('alert').textContent).toContain('no such rule')
    expect(dialog()).toBeTruthy()
    expect(onDone).not.toHaveBeenCalled()
  })

  it('keeps what was typed when the session expires during the dialog', async () => {
    const { api, onDone } = renderDialog({ kind: 'input', path: RPM })
    await settle()
    api.suppressInput.mockRejectedValue(new SessionExpiredError())
    fireEvent.change(screen.getByRole('textbox', { name: 'Note' }), { target: { value: 'typed' } })
    await click(within(dialog()).getByRole('button', { name: 'Suppress' }))
    expect(screen.getByRole('alert').textContent).toMatch(/session has expired.*log in/i)
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Note' }).value).toBe('typed')
    expect(onDone).not.toHaveBeenCalled()
  })

  it('takes focus on its heading and cancels with Escape', async () => {
    const { onClose, onDone } = renderDialog({ kind: 'input', path: RPM })
    await settle()
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: /suppress input/i }))
    fireEvent.keyDown(dialog(), { key: 'Escape' })
    expect(onClose).toHaveBeenCalledOnce()
    expect(onDone).not.toHaveBeenCalled()
  })
})
