import {
  Fragment,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type Ref
} from 'react'
import type { TemplatePick } from '../../model/rule'
import type { Slot, Template } from '../../model/template'
import { SOURCE_PICK, picked, slotsOf } from '../../templates/instantiate'
import type { ListedRule } from '../api'
import { BackIcon } from '../detail/icons'
import { Combobox, hasWords, type ComboboxOption } from '../paths/Combobox'
import { LIVE_POLL_MS, type PathEntry, type PathSource } from '../paths/selfPaths'
import { rulesWord } from '../editor/words'
import { formatValue } from '../rules/describe'
import { pathParts, useUnits } from '../signalUnits'
import {
  candidates,
  instanceError,
  labelsJoined,
  onlySlot,
  openPattern,
  pickKey,
  placeholder,
  restoredPick,
  rowsProblem,
  ruleWatching,
  slotCandidates,
  slotError,
  slotPath,
  templateTitle,
  typedCandidate,
  watchedPath,
  watchedSlots,
  withArticle,
  type Candidate,
  type SlotCandidate
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

/** The field to focus once rendered: a row's first unchosen slot, or its first field. */
interface FocusTarget {
  key: number
  firstEmpty: boolean
}

function without(pick: TemplatePick, key: string): TemplatePick {
  return Object.fromEntries(Object.entries(pick).filter(([k]) => k !== key))
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

const NOT_REPORTING = 'Not reporting. Its rule shows No data until it does.'

/** `<battery>`, `<solararray>`: one segment, so the path still breaks only at its dots. */
const slotHole = (label: string) => `<${label.toLowerCase().replace(/\s+/g, '')}>`

const plural = (word: string) => `${word.replace(/([^aeiou])y$/, '$1ie')}s`

interface SlotOption extends ComboboxOption {
  candidate: SlotCandidate
}

/** Every whitespace-separated word occurs in the instance's name or its label. */
function slotFilter(option: SlotOption, query: string): boolean {
  const { instance, label } = option.candidate
  return hasWords(`${instance} ${label}`, query)
}

/** A path broken only at its dots, the segment a slot fills marked. */
function MarkedPath({ segments, marked }: { segments: readonly string[]; marked: number }) {
  return (
    <span className="skar-mono skar-combo-path">
      {segments.map((segment, i) => (
        <Fragment key={i}>
          {i === marked ? <span className="skar-combo-seg">{segment}</span> : segment}
          {i < segments.length - 1 && (
            <>
              .<wbr />
            </>
          )}
        </Fragment>
      ))}
    </span>
  )
}

/** A path's segments, its pointer kept on the last. */
function segmentsOf(path: string): string[] {
  const { base, pointer } = pathParts(path)
  return base.map((part, i) => (i === base.length - 1 ? `${part}${pointer}` : part))
}

function slotOption(c: SlotCandidate): SlotOption {
  return {
    value: c.instance,
    primary: c.label === c.instance ? '' : c.label,
    secondary: <MarkedPath segments={segmentsOf(c.entry.path)} marked={c.segment} />,
    trailing: shownValue(c.entry),
    candidate: c
  }
}

/** What a slot's name is: a reporting instance's label and live value, or that it does not report. */
function slotLine(name: string, choices: readonly SlotCandidate[]): string | undefined {
  if (name === '') return undefined
  const c = choices.find((choice) => choice.instance === name)
  if (c === undefined) return NOT_REPORTING
  const value =
    c.entry.value === undefined
      ? 'no value yet'
      : `${formatValue(c.entry.value, { kind: 'absolute', unit: c.entry.unit })} now`
  if (c.label !== c.instance) return `${c.label} · ${value}`
  return value.charAt(0).toUpperCase() + value.slice(1)
}

/**
 * The row picker of a template with two or more slots: in each row, one
 * field per slot that lists the instances reporting and takes any name
 * typed, and a source when the template leaves it open; each row becomes
 * its own rule.
 */
function SlotRows(props: TemplatePickerProps) {
  const { paths: source, template, back, headingRef } = props
  const { paths } = useUnits(source, LIVE_POLL_MS)
  const id = useId()
  const slots = slotsOf(template)
  const sourceOpen = template.open?.includes(SOURCE_PICK) === true
  const signalSlots = watchedSlots(template)
  const reported = paths.status === 'ready' ? paths.paths : []
  const byPath = new Map(reported.map((p) => [p.path, p]))
  const nextKey = useRef(0)
  const newRow = (pick: TemplatePick): SlotRow => ({ key: nextKey.current++, pick })
  const [rows, setRows] = useState<SlotRow[]>(() =>
    props.picked !== undefined && props.picked.length > 0
      ? props.picked.map((p) => newRow(restoredPick(template, p)))
      : [newRow({})]
  )
  // A field's text while it differs from the row's pick: the row takes it once committed.
  const [drafts, setDrafts] = useState<Partial<Record<string, string>>>({})
  const [removed, setRemoved] = useState<number | undefined>(undefined)
  const [prefilled, setPrefilled] = useState(false)
  const fields = useRef(new Map<string, HTMLInputElement>())
  const focusNext = useRef<FocusTarget | undefined>(undefined)

  const choices = new Map(
    slots.map((slot) => [slot.name, slotCandidates(template, slot.name, reported)])
  )
  /** The pick with each unchosen slot that exactly one instance reports filled in. */
  const prefill = (pick: TemplatePick): TemplatePick => {
    const filled = { ...pick }
    for (const slot of slots) {
      const reporting = choices.get(slot.name) ?? []
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

  const fieldKey = (key: number, name: string) => `${String(key)}:${name}`

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
    if (slot !== undefined) fields.current.get(fieldKey(at.key, slot.name))?.focus()
  })

  const setDraft = (at: string, text: string | undefined) => {
    setDrafts((last) => {
      const { [at]: _, ...rest } = last
      return text === undefined ? rest : { ...rest, [at]: text }
    })
  }
  const choose = (key: number, name: string, value: string | undefined) => {
    setRemoved(undefined)
    // From the latest rows: a commit on blur lands just before the click that caused it.
    setRows((last) =>
      last.map((r) => {
        if (r.key !== key || picked(r.pick, name) === value) return r
        const pick = value === undefined ? without(r.pick, name) : { ...r.pick, [name]: value }
        // The sources offered are those of the path the signal's slots make.
        const moved = signalSlots.some((s) => s.name === name)
        return { ...r, pick: moved ? without(pick, SOURCE_PICK) : pick }
      })
    )
  }
  /**
   * The text is settled: the row takes it trimmed, spelled as a reporting
   * instance is when it differs only in case, as paths are case-sensitive.
   */
  const commit = (key: number, name: string, text: string) => {
    setDraft(fieldKey(key, name), undefined)
    const typed = text.trim()
    const reporting = choices.get(name) ?? []
    const instance =
      reporting.find((c) => c.instance === typed) ??
      reporting.find((c) => c.instance.toLowerCase() === typed.toLowerCase())
    choose(key, name, typed === '' ? undefined : (instance?.instance ?? typed))
  }
  const addRow = () => {
    const added = newRow(prefill({}))
    focusNext.current = { key: added.key, firstEmpty: true }
    setRemoved(undefined)
    setRows([...rows, added])
  }
  const removeRow = (index: number) => {
    const next = rows.filter((_, i) => i !== index)
    const focus = next.at(index) ?? next.at(index - 1)
    if (focus !== undefined) focusNext.current = { key: focus.key, firstEmpty: false }
    setRows(next)
    setRemoved(index + 1)
  }

  const picks = rows.map((r) => r.pick)
  const problem =
    paths.status === 'loading' ? undefined : rowsProblem(template, sourceOpen, picks, reported)
  const status = [removed === undefined ? undefined : `Rule ${String(removed)} removed.`, problem]
    .filter((s) => s !== undefined)
    .join(' ')

  const slotField = (r: SlotRow, slot: Slot) => {
    const at = fieldKey(r.key, slot.name)
    const committed = picked(r.pick, slot.name) ?? ''
    const draft = drafts[at]
    const text = draft ?? committed
    const name = text.trim()
    const listed = choices.get(slot.name) ?? []
    const word = slot.label.toLowerCase()
    // Shown once committed, then checked again as the text changes until it is fixed.
    const refused = committed === '' ? undefined : slotError(template, slot, committed, reported)
    const error =
      refused === undefined || name === ''
        ? undefined
        : draft === undefined
          ? refused
          : slotError(template, slot, name, reported)
    const line = paths.status === 'ready' ? slotLine(name, listed) : undefined
    const pattern = slotPath(template, slot.name)
    const segments = segmentsOf(pattern).map((part) =>
      slots.reduce((filled, s) => {
        const value = s.name === slot.name ? name : (picked(r.pick, s.name) ?? '')
        return filled.replaceAll(placeholder(s.name), value === '' ? slotHole(s.label) : value)
      }, part)
    )
    const marked = segmentsOf(pattern).findIndex((part) => part.includes(placeholder(slot.name)))
    return (
      <Combobox
        key={slot.name}
        label={slot.label}
        value={text}
        source={
          paths.status === 'failed'
            ? { status: 'failed', message: paths.error }
            : { status: 'ready', options: listed.map(slotOption) }
        }
        filter={slotFilter}
        matchStatus={(matching, filtered) => {
          if (listed.length === 0)
            return `Nothing reports ${withArticle(word)} yet. Type the name it will have.`
          if (!filtered) return `${String(matching)} ${plural(word)}`
          if (matching === 0) return `No ${word} matches; the typed name is used as is.`
          return matching === 1 ? `1 ${word} matches` : `${String(matching)} ${plural(word)} match`
        }}
        onChange={(value) => {
          setDraft(at, value)
        }}
        onCommit={(value) => {
          commit(r.key, slot.name, value)
        }}
        context={<MarkedPath segments={segments} marked={marked} />}
        {...(error !== undefined
          ? { errors: [error] }
          : line === undefined
            ? {}
            : { hint: <span className="skar-combo-line">{line}</span> })}
        inputRef={(el) => {
          if (el === null) fields.current.delete(at)
          else fields.current.set(at, el)
        }}
        placeholder={
          paths.status === 'ready' && listed.length === 0
            ? `Type ${withArticle(word)} name`
            : `Choose or type ${withArticle(word)}`
        }
        optionLayout="stacked"
        opener
        progressStatus={false}
      />
    )
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
                    {slots.map((slot) => slotField(r, slot))}
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
  onChange
}: {
  id: string
  label: string
  /** The disabled first option, shown while nothing is chosen. */
  prompt: string
  choices: readonly Choice[]
  value: string | undefined
  disabled?: boolean
  onChange: (value: string) => void
}) {
  return (
    <div className="skar-field">
      <label className="skar-label" htmlFor={id}>
        {label}
      </label>
      <select
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
