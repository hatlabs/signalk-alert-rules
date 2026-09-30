// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RuleEntry, Suppression, SuppressionRequest } from '../../../src/panel/api'
import type { PathSource } from '../../../src/panel/paths/selfPaths'
import { RuleDetail } from '../../../src/panel/rules/RuleDetail'
import { RulesView } from '../../../src/panel/rules/RulesView'
import { inputPaths } from '../../../src/panel/suppression/SuppressButton'
import type { SuppressContext } from '../../../src/panel/suppression/SuppressDialog'
import { instance, ruleEntry } from '../fixtures'

const oil = ruleEntry()
const batteries = ruleEntry({
  slug: 'battery-low',
  rule: {
    name: 'Battery low',
    signal: { paths: ['electrical.batteries.*.voltage'] },
    gates: [{ paths: ['electrical.chargers.shore.state'] }]
  },
  status: {
    instances: [
      instance({ instance: { name: 'house', segment: 'house' } }),
      instance({ instance: { name: 'start', segment: 'start' } })
    ]
  }
})

const paths: PathSource = {
  selfPaths: () => Promise.resolve([]),
  distanceUnit: () => Promise.reject(new Error('not used'))
}

function context(rules: RuleEntry[]) {
  return {
    api: {
      suppressRule: vi.fn((_o: string, _s: string, _r: SuppressionRequest) => Promise.resolve(oil)),
      suppressInput: vi.fn((path: string, _r: SuppressionRequest) =>
        Promise.resolve<Suppression>({ scope: 'input', path, since: '', actor: 'admin' })
      ),
      previewInputSuppression: vi.fn((path: string) =>
        Promise.resolve({ path, suppresses: [], freezes: [] })
      )
    },
    rules,
    paths,
    done: vi.fn()
  } satisfies SuppressContext
}

async function click(element: HTMLElement) {
  await act(async () => {
    fireEvent.click(element)
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

describe('suppression entry points', () => {
  afterEach(cleanup)

  it('suppresses a rule from its row and returns focus to the row action', async () => {
    const ctx = context([oil, batteries])
    render(<RulesView rules={[oil, batteries]} ruleHref={() => '#'} suppression={ctx} />)
    const trigger = screen.getByRole('button', { name: 'Suppress Oil pressure low' })
    fireEvent.click(trigger)
    const dialog = screen.getByRole('dialog', { name: 'Suppress Oil pressure low' })
    await click(within(dialog).getByRole('button', { name: 'Suppress' }))
    expect(ctx.api.suppressRule).toHaveBeenCalledWith('user', 'oil-pressure-low', {})
    expect(ctx.done).toHaveBeenCalledOnce()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('suppresses a rule from its detail view', async () => {
    const ctx = context([oil])
    render(
      <RuleDetail entry={oil} backHref="#" reset={() => Promise.resolve()} suppression={ctx} />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Suppress…' }))
    await click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Suppress' }))
    expect(ctx.api.suppressRule).toHaveBeenCalledWith('user', 'oil-pressure-low', {})
  })

  it("offers each of a rule's exact input paths as a chip that suppresses it", async () => {
    const ctx = context([batteries])
    render(
      <RuleDetail
        entry={batteries}
        backHref="#"
        reset={() => Promise.resolve()}
        suppression={ctx}
      />
    )
    const chips = within(screen.getByRole('group', { name: /suppress an input/i })).getAllByRole(
      'button'
    )
    expect(chips.map((c) => c.textContent)).toEqual([
      'electrical.batteries.house.voltage',
      'electrical.batteries.start.voltage',
      'electrical.chargers.shore.state'
    ])
    const chip = screen.getByRole('button', {
      name: 'Suppress input electrical.batteries.start.voltage'
    })
    await click(chip)
    expect(ctx.api.previewInputSuppression).toHaveBeenCalledWith(
      'electrical.batteries.start.voltage'
    )
    const dialog = screen.getByRole('dialog', {
      name: 'Suppress input electrical.batteries.start.voltage'
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(chip)
  })

  it('offers no suppression where it is not wired', () => {
    render(<RulesView rules={[oil]} ruleHref={() => '#'} />)
    expect(screen.queryByRole('button', { name: /suppress/i })).toBeNull()
  })
})

describe('inputPaths', () => {
  it('binds a wildcard to each instance the rule has, and keeps exact paths', () => {
    expect(inputPaths(batteries)).toEqual([
      'electrical.batteries.house.voltage',
      'electrical.batteries.start.voltage',
      'electrical.chargers.shore.state'
    ])
  })

  it('reads every combinator input once', () => {
    const combined = ruleEntry({
      rule: { signal: { paths: ['a.b', 'a.c'], combinator: 'max' }, gates: [{ paths: ['a.b'] }] }
    })
    expect(inputPaths(combined)).toEqual(['a.b', 'a.c'])
  })
})
