import { useId, useLayoutEffect, useRef, useState, type CSSProperties, type Ref } from 'react'
import type { TemplatePick } from '../../model/rule'
import type { Slot, Template } from '../../model/template'
import { SOURCE_PICK, picked, slotsOf } from '../../templates/instantiate'
import type { ListedRule } from '../api'
import { BackIcon } from '../detail/icons'
import { LIVE_POLL_MS, type PathEntry, type PathSource } from '../paths/selfPaths'
import { rulesWord } from '../editor/words'
import { formatValue } from '../rules/describe'
import { useUnits } from '../signalUnits'
import {
  candidates,
  instanceError,
  onlySlot,
  openPattern,
  pickKey,
  ruleWatching,
  slotCandidates,
  slotPattern,
  templateTitle,
  typedCandidate,
  watchedPath,
  watchedSlots,
  type Candidate
} from './templatePicks'

export interface TemplatePickerProps {
  paths: PathSource
  setId: string
  template: Template
  /** The listed rules, to mark the picks that already have a rule from the template. */
  rules: readonly ListedRule[]
  /** Picks already made, as when coming back from the rules they make. */
  picked?: readonly TemplatePick[]
  /** Where the back link goes, and what it says. */
  back: { href: string; label: string }
  /** Goes on to the rules the picks make. */
  onContinue: (picks: TemplatePick[]) => void
  headingRef?: Ref<HTMLHeadingElement>
}

function shownValue(entry: PathEntry | undefined): string {
  return entry?.value === undefined
    ? 'no data'
    : formatValue(entry.value, { kind: 'absolute', unit: entry.unit })
}

/**
 * From a template, second step: what it should watch, each its own rule; a
 * template with two or more slots is picked in rows, one rule per row.
 */
export function TemplatePicker(props: TemplatePickerProps) {
  return slotsOf(props.template).length > 1 ? (
    <SlotRows {...props} />
  ) : (
    <InstancePicker {...props} />
  )
}

/** The instances or sources a template with at most one slot should watch, as a checkbox list. */
function InstancePicker(props: TemplatePickerProps) {
  const { paths: source, template, back, headingRef } = props
  const { paths } = useUnits(source, LIVE_POLL_MS)
  const sourceOpen = template.open?.includes(SOURCE_PICK) === true
  const nothingOpen = slotsOf(template).length === 0 && !sourceOpen
  // A typed instance has no sources to offer, so it is only typed while the source is fixed.
  const typedSlot = sourceOpen ? undefined : onlySlot(template)
  const typedIn = (p: TemplatePick) =>
    typedSlot === undefined ? undefined : picked(p, typedSlot.name)
  const reported = paths.status === 'ready' ? paths.paths : []
  const found = candidates(props.setId, template, reported, props.rules)
  const [typed, setTyped] = useState<TemplatePick[]>(() =>
    (props.picked ?? []).filter((p) => typedIn(p) !== undefined)
  )
  const [chosen, setChosen] = useState<ReadonlySet<string>>(
    () => new Set((props.picked ?? []).map(pickKey))
  )
  const foundKeys = new Set(found.map((c) => pickKey(c.pick)))
  const typedRows = typed.flatMap((p) => {
    const instance = typedIn(p)
    return typedSlot === undefined || instance === undefined || foundKeys.has(pickKey(p))
      ? []
      : [typedCandidate(props.setId, template, typedSlot, instance, reported, props.rules)]
  })
  const rows = [...found, ...typedRows]
  // A template with nothing open makes its one rule.
  const only = nothingOpen ? rows[0] : undefined
  const isChosen = (c: Candidate) => c === only || chosen.has(pickKey(c.pick))
  const picks = rows.filter(isChosen).map((c) => c.pick)

  const toggle = (c: Candidate, on: boolean) => {
    const next = new Set(chosen)
    if (on) next.add(pickKey(c.pick))
    else next.delete(pickKey(c.pick))
    setChosen(next)
  }

  return (
    <div className="skar-page">
      <a className="skar-back" href={back.href}>
        <BackIcon />
        <span>{back.label}</span>
      </a>
      <div>
        <h2 ref={headingRef} tabIndex={-1} className="skar-title">
          {templateTitle(template)}
        </h2>
        <p className="skar-lead">
          {template.description}
          {nothingOpen
            ? ' It watches one value and makes one rule.'
            : ' Choose what it should watch. Each one becomes its own rule.'}
        </p>
      </div>
      {paths.status === 'loading' ? (
        <p role="status">Loading paths…</p>
      ) : (
        <>
          {paths.status === 'failed' && (
            <p className="skar-banner" role="alert">
              <span>{`Could not load paths: ${paths.error}.`}</span>
            </p>
          )}
          {!nothingOpen && <h3 className="skar-label">Reporting now</h3>}
          {rows.length > 0 && (
            <ul className="skar-rows" aria-label="Picks">
              {rows.map((c) => (
                <PickRow
                  key={pickKey(c.pick)}
                  candidate={c}
                  checked={isChosen(c)}
                  fixed={c === only}
                  onChange={(on) => {
                    toggle(c, on)
                  }}
                />
              ))}
            </ul>
          )}
          {found.length === 0 && !nothingOpen && (
            <p className="skar-hint">
              {`Nothing reports ${openPattern(template) ?? 'this value'} yet.`}
              {typedSlot !== undefined && ' Type the name it will have in the path below.'}
            </p>
          )}
          {typedSlot !== undefined && (
            <TypedInstance
              label="Not listed?"
              placeholder="The name in the path, e.g. windlass"
              pattern={openPattern(template) ?? ''}
              onAdd={(instance) => {
                const pick = { [typedSlot.name]: instance }
                setTyped((last) =>
                  last.some((p) => pickKey(p) === pickKey(pick)) ? last : [...last, pick]
                )
                setChosen(new Set(chosen).add(pickKey(pick)))
              }}
            />
          )}
        </>
      )}
      <button
        type="button"
        className="skar-btn skar-btn-primary skar-btn-wide"
        disabled={picks.length === 0}
        onClick={() => {
          props.onContinue(picks)
        }}
      >
        {picks.length === 0 ? 'Choose at least one' : `Continue with ${rulesWord(picks.length)}`}
      </button>
    </div>
  )
}

function PickRow({
  candidate: c,
  checked,
  fixed,
  onChange
}: {
  candidate: Candidate
  checked: boolean
  fixed: boolean
  onChange: (on: boolean) => void
}) {
  return (
    <li>
      <label className="skar-row skar-pick">
        <input
          type="checkbox"
          checked={checked}
          disabled={fixed}
          onChange={(e) => {
            onChange(e.target.checked)
          }}
        />
        <span className="skar-row-main">
          <span className="skar-row-name">{c.label}</span>
          <span className="skar-mono">{c.path}</span>
          {c.ruleName !== undefined && (
            <span className="skar-warning">
              {`Already has a rule from this template: ${c.ruleName}`}
            </span>
          )}
          {c.typed === true && c.entry === undefined && (
            <span className="skar-hint">Typed by you: not reporting yet</span>
          )}
        </span>
        <span className={c.entry?.value === undefined ? 'skar-muted' : 'skar-row-value'}>
          {shownValue(c.entry)}
        </span>
      </label>
    </li>
  )
}

function TypedInstance({
  label,
  placeholder,
  pattern,
  onAdd
}: {
  label: string
  placeholder: string
  /** The path the name goes in, as the user reads it. */
  pattern: string
  onAdd: (instance: string) => void
}) {
  const id = useId()
  const [text, setText] = useState('')
  const [error, setError] = useState<string | undefined>(undefined)
  const add = () => {
    const instance = text.trim()
    const refused = instanceError(instance)
    setError(refused)
    if (refused !== undefined) return
    onAdd(instance)
    setText('')
  }
  return (
    <div className="skar-field">
      <label className="skar-label" htmlFor={id}>
        {label}
      </label>
      <div className="skar-input-row">
        <input
          id={id}
          className={error === undefined ? 'skar-input' : 'skar-input skar-input-invalid'}
          autoComplete="off"
          spellCheck={false}
          placeholder={placeholder}
          aria-describedby={`${id}-hint`}
          aria-invalid={error !== undefined}
          value={text}
          onChange={(e) => {
            setText(e.target.value)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') add()
          }}
        />
        <button type="button" className="skar-btn skar-btn-ghost" onClick={add}>
          Add
        </button>
      </div>
      <span id={`${id}-hint`} className="skar-hint">
        {error !== undefined && (
          <span className="skar-error" role="alert">
            {error}{' '}
          </span>
        )}
        {`For one that is not reporting yet, as ${pattern}. Its rule shows No data until it does.`}
      </span>
    </div>
  )
}

/** One rule being picked: each slot's choice and the source, under a key that outlives its place. */
interface SlotRow {
  key: number
  pick: TemplatePick
}

/** The select to focus once rendered: a row's first unchosen slot, or its first select. */
interface FocusTarget {
  key: number
  firstEmpty: boolean
}

const withArticle = (word: string) => `${/^[aeiou]/i.test(word) ? 'an' : 'a'} ${word}`

/** "a battery and an engine", "a battery, a charger and an engine". */
function labelsJoined(slots: readonly Slot[]): string {
  const words = slots.map((s) => withArticle(s.label.toLowerCase()))
  const last = words.pop() ?? ''
  return words.length === 0 ? last : `${words.join(', ')} and ${last}`
}

function without(pick: TemplatePick, key: string): TemplatePick {
  return Object.fromEntries(Object.entries(pick).filter(([k]) => k !== key))
}

/** The first reason the rows cannot continue, in rule order: a missing choice before a repeat. */
function rowsProblem(
  template: Template,
  sourceOpen: boolean,
  picks: readonly TemplatePick[]
): string | undefined {
  for (const [i, pick] of picks.entries()) {
    const rule = String(i + 1)
    const missing = slotsOf(template).find((slot) => picked(pick, slot.name) === undefined)
    if (missing !== undefined)
      return `Choose ${withArticle(missing.label.toLowerCase())} for rule ${rule}`
    if (sourceOpen && picked(pick, SOURCE_PICK) === undefined)
      return `Choose a source for rule ${rule}`
  }
  const keys = picks.map(pickKey)
  for (const [i, key] of keys.entries()) {
    const j = keys.indexOf(key, i + 1)
    if (j >= 0) return `Rules ${String(i + 1)} and ${String(j + 1)} are the same`
  }
  return undefined
}

interface Choice {
  value: string
  text: string
}

/** The choices of a select, keeping the one chosen though nothing reports it any more. */
function keepingChosen(listed: Choice[], chosen: string | undefined): Choice[] {
  return chosen === undefined || listed.some((c) => c.value === chosen)
    ? listed
    : [...listed, { value: chosen, text: `${chosen} · not reporting` }]
}

/**
 * The row picker of a template with two or more slots: one select per slot
 * in each row, and a source when the template leaves it open; each row
 * becomes its own rule.
 */
function SlotRows(props: TemplatePickerProps) {
  const { paths: source, template, back, headingRef } = props
  const { paths } = useUnits(source, LIVE_POLL_MS)
  const id = useId()
  const slots = slotsOf(template)
  const sourceOpen = template.open?.includes(SOURCE_PICK) === true
  const signalSlots = watchedSlots(template)
  // A typed instance has no sources to offer, so a slot in the signal path is
  // only typed while the source is fixed.
  const typedSlots = sourceOpen
    ? slots.filter((slot) => !signalSlots.some((s) => s.name === slot.name))
    : slots
  const reported = paths.status === 'ready' ? paths.paths : []
  const byPath = new Map(reported.map((p) => [p.path, p]))
  const nextKey = useRef(0)
  const newRow = (pick: TemplatePick): SlotRow => ({ key: nextKey.current++, pick })
  const [rows, setRows] = useState<SlotRow[]>(() =>
    props.picked !== undefined && props.picked.length > 0
      ? props.picked.map((p) => newRow({ ...p }))
      : [newRow({})]
  )
  const [typed, setTyped] = useState<Partial<Record<string, string[]>>>({})
  const [removed, setRemoved] = useState<number | undefined>(undefined)
  const [prefilled, setPrefilled] = useState(false)
  const selects = useRef(new Map<string, HTMLSelectElement>())
  const focusNext = useRef<FocusTarget | undefined>(undefined)

  const choices = new Map(
    slots.map((slot) => [
      slot.name,
      slotCandidates(template, slot.name, reported, typed[slot.name])
    ])
  )
  /** The pick with each unchosen slot that exactly one instance reports filled in. */
  const prefill = (pick: TemplatePick): TemplatePick => {
    const filled = { ...pick }
    for (const slot of slots) {
      const reporting = (choices.get(slot.name) ?? []).filter((c) => c.typed !== true)
      const only = reporting.at(0)
      if (reporting.length === 1 && only !== undefined && picked(pick, slot.name) === undefined)
        filled[slot.name] = only.instance
    }
    return filled
  }
  // Once, when the paths first arrive: polling never changes a choice already made.
  if (!prefilled && paths.status === 'ready') {
    setPrefilled(true)
    setRows(rows.map((r) => ({ ...r, pick: prefill(r.pick) })))
  }

  useLayoutEffect(() => {
    const target = focusNext.current
    if (target === undefined) return
    focusNext.current = undefined
    const at = rows.find((r) => r.key === target.key)
    if (at === undefined) return
    const empty = target.firstEmpty
      ? slots.find((slot) => picked(at.pick, slot.name) === undefined)
      : undefined
    const slot = empty ?? slots.at(0)
    if (slot !== undefined) selects.current.get(`${String(at.key)}:${slot.name}`)?.focus()
  })

  const edit = (next: SlotRow[]) => {
    setRemoved(undefined)
    setRows(next)
  }
  const choose = (key: number, name: string, value: string) => {
    edit(
      rows.map((r) => {
        if (r.key !== key) return r
        const pick = { ...r.pick, [name]: value }
        // The sources offered are those of the path the signal's slots make.
        const moved = signalSlots.some((s) => s.name === name) && picked(r.pick, name) !== value
        return { ...r, pick: moved ? without(pick, SOURCE_PICK) : pick }
      })
    )
  }
  const addRow = () => {
    const added = newRow(prefill({}))
    focusNext.current = { key: added.key, firstEmpty: true }
    edit([...rows, added])
  }
  const removeRow = (index: number) => {
    const next = rows.filter((_, i) => i !== index)
    const focus = next.at(index) ?? next.at(index - 1)
    if (focus !== undefined) focusNext.current = { key: focus.key, firstEmpty: false }
    setRows(next)
    setRemoved(index + 1)
  }
  const addTyped = (name: string, instance: string) => {
    setTyped((last) => {
      const names = last[name] ?? []
      return names.includes(instance) ? last : { ...last, [name]: [...names, instance] }
    })
    edit(
      rows.map((r) =>
        picked(r.pick, name) === undefined ? { ...r, pick: { ...r.pick, [name]: instance } } : r
      )
    )
  }

  const slotChoices = (name: string, chosen: string | undefined): Choice[] =>
    keepingChosen(
      (choices.get(name) ?? []).map((c) => ({
        value: c.instance,
        text: `${c.label} · ${c.typed === true ? 'not reporting yet' : shownValue(c.entry)}`
      })),
      chosen
    )

  const picks = rows.map((r) => r.pick)
  const problem = paths.status === 'loading' ? undefined : rowsProblem(template, sourceOpen, picks)
  const status = [removed === undefined ? undefined : `Rule ${String(removed)} removed.`, problem]
    .filter((s) => s !== undefined)
    .join(' ')

  return (
    <div className="skar-page">
      <a className="skar-back" href={back.href}>
        <BackIcon />
        <span>{back.label}</span>
      </a>
      <div>
        <h2 ref={headingRef} tabIndex={-1} className="skar-title">
          {templateTitle(template)}
        </h2>
        <p className="skar-lead">
          {template.description}
          {` Choose ${labelsJoined(slots)} for each rule. Each row becomes its own rule.`}
        </p>
      </div>
      {paths.status === 'loading' ? (
        <p role="status">Loading paths…</p>
      ) : (
        <>
          {paths.status === 'failed' && (
            <p className="skar-banner" role="alert">
              <span>{`Could not load paths: ${paths.error}.`}</span>
            </p>
          )}
          <div className="skar-slot-rows">
            {rows.map((r, index) => {
              const n = String(index + 1)
              const complete = slots.every((slot) => picked(r.pick, slot.name) !== undefined)
              const covered = complete
                ? ruleWatching(props.setId, template, r.pick, props.rules)
                : undefined
              const waiting = signalSlots.filter((s) => picked(r.pick, s.name) === undefined)
              const chosenSource = picked(r.pick, SOURCE_PICK)
              const sources = keepingChosen(
                waiting.length > 0
                  ? []
                  : (byPath.get(watchedPath(template, r.pick))?.sources ?? []).map((s) => ({
                      value: s,
                      text: s
                    })),
                chosenSource
              )
              return (
                <fieldset key={r.key} className="skar-slot-row">
                  <legend>{`Rule ${n}`}</legend>
                  <div
                    className="skar-slot-cells"
                    style={{ '--skar-cells': slots.length + (sourceOpen ? 1 : 0) } as CSSProperties}
                  >
                    {slots.map((slot) => {
                      const chosen = picked(r.pick, slot.name)
                      const listed = slotChoices(slot.name, chosen)
                      const at = `${String(r.key)}:${slot.name}`
                      return (
                        <ChoiceSelect
                          key={slot.name}
                          id={`${id}-${String(r.key)}-${slot.name}`}
                          label={slot.label}
                          prompt={
                            listed.length === 0
                              ? 'Nothing reports yet'
                              : `Choose ${withArticle(slot.label.toLowerCase())}`
                          }
                          choices={listed}
                          value={chosen}
                          selectRef={(el) => {
                            if (el === null) selects.current.delete(at)
                            else selects.current.set(at, el)
                          }}
                          onChange={(value) => {
                            choose(r.key, slot.name, value)
                          }}
                        />
                      )
                    })}
                    {sourceOpen && (
                      <ChoiceSelect
                        id={`${id}-${String(r.key)}-source`}
                        label="Source"
                        prompt={
                          waiting.length > 0
                            ? `Choose ${labelsJoined(waiting)} first`
                            : sources.length === 0
                              ? 'Nothing reports yet'
                              : 'Choose a source'
                        }
                        choices={sources}
                        value={chosenSource}
                        disabled={waiting.length > 0}
                        onChange={(value) => {
                          choose(r.key, SOURCE_PICK, value)
                        }}
                      />
                    )}
                  </div>
                  {covered !== undefined && (
                    <span className="skar-warning">
                      {`Already has a rule from this template: ${covered}`}
                    </span>
                  )}
                  {rows.length > 1 && (
                    <div>
                      <button
                        type="button"
                        className="skar-btn skar-btn-ghost skar-btn-small"
                        onClick={() => {
                          removeRow(index)
                        }}
                      >
                        {`Remove rule ${n}`}
                      </button>
                    </div>
                  )}
                </fieldset>
              )
            })}
          </div>
          <div className="skar-slot-typed">
            {typedSlots.map((slot) => (
              <TypedInstance
                key={slot.name}
                label={`${slot.label} not listed?`}
                placeholder="The name in the path"
                pattern={slotPattern(template, slot.name)}
                onAdd={(instance) => {
                  addTyped(slot.name, instance)
                }}
              />
            ))}
          </div>
          <div>
            <button
              type="button"
              className="skar-btn skar-btn-ghost skar-btn-small"
              onClick={addRow}
            >
              Add another
            </button>
          </div>
          <p className="skar-hint skar-picker-status" role="status">
            {status}
          </p>
        </>
      )}
      <button
        type="button"
        className="skar-btn skar-btn-primary skar-btn-wide"
        disabled={paths.status === 'loading' || problem !== undefined}
        onClick={() => {
          props.onContinue(picks)
        }}
      >
        {`Continue with ${rulesWord(rows.length)}`}
      </button>
    </div>
  )
}

function ChoiceSelect({
  id,
  label,
  prompt,
  choices,
  value,
  disabled = false,
  selectRef,
  onChange
}: {
  id: string
  label: string
  /** The disabled first option, shown while nothing is chosen. */
  prompt: string
  choices: readonly Choice[]
  value: string | undefined
  disabled?: boolean
  selectRef?: Ref<HTMLSelectElement>
  onChange: (value: string) => void
}) {
  return (
    <div className="skar-field">
      <label className="skar-label" htmlFor={id}>
        {label}
      </label>
      <select
        ref={selectRef}
        id={id}
        className={value === undefined ? 'skar-input skar-select-empty' : 'skar-input'}
        disabled={disabled}
        value={value ?? ''}
        onChange={(e) => {
          onChange(e.target.value)
        }}
      >
        <option value="" disabled>
          {prompt}
        </option>
        {choices.map((c) => (
          <option key={c.value} value={c.value}>
            {c.text}
          </option>
        ))}
      </select>
    </div>
  )
}
