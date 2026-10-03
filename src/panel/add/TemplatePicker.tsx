import { useId, useState, type Ref } from 'react'
import type { TemplatePick } from '../../model/rule'
import type { Template } from '../../model/template'
import type { ListedRule } from '../api'
import { BackIcon } from '../detail/icons'
import { LIVE_POLL_MS, type PathEntry, type PathSource } from '../paths/selfPaths'
import { rulesWord } from '../editor/words'
import { formatValue } from '../rules/describe'
import { useUnits } from '../signalUnits'
import {
  candidates,
  instanceError,
  openPattern,
  pickKey,
  templateTitle,
  typedCandidate,
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

/** From a template, second step: the instances or sources it should watch, each its own rule. */
export function TemplatePicker(props: TemplatePickerProps) {
  const { paths: source, template, back, headingRef } = props
  const { paths } = useUnits(source, LIVE_POLL_MS)
  const open = template.open ?? []
  const typable = open.includes('instance') && !open.includes('source')
  const reported = paths.status === 'ready' ? paths.paths : []
  const found = candidates(props.setId, template, reported, props.rules)
  const [typed, setTyped] = useState<TemplatePick[]>(() =>
    typable ? (props.picked ?? []).filter((p) => p.instance !== undefined) : []
  )
  const [chosen, setChosen] = useState<ReadonlySet<string>>(
    () => new Set((props.picked ?? []).map(pickKey))
  )
  const foundKeys = new Set(found.map((c) => pickKey(c.pick)))
  const typedRows = typed
    .filter((p) => !foundKeys.has(pickKey(p)))
    .map((p) => typedCandidate(template, p.instance ?? '', reported))
  const rows = [...found, ...typedRows]
  // A template with nothing open makes its one rule.
  const only = open.length === 0 ? rows[0] : undefined
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
          {open.length === 0
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
          {open.length > 0 && <h3 className="skar-label">Reporting now</h3>}
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
          {found.length === 0 && open.length > 0 && (
            <p className="skar-hint">
              {`Nothing reports ${openPattern(template) ?? 'this value'} yet.`}
              {typable && ' Type the name it will have in the path below.'}
            </p>
          )}
          {typable && (
            <TypedInstance
              template={template}
              onAdd={(instance) => {
                setTyped((last) =>
                  last.some((p) => p.instance === instance) ? last : [...last, { instance }]
                )
                setChosen(new Set(chosen).add(pickKey({ instance })))
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
  template,
  onAdd
}: {
  template: Template
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
        Not listed?
      </label>
      <div className="skar-input-row">
        <input
          id={id}
          className={error === undefined ? 'skar-input' : 'skar-input skar-input-invalid'}
          autoComplete="off"
          spellCheck={false}
          placeholder="The name in the path, e.g. windlass"
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
        {`For one that is not reporting yet, as ${openPattern(template) ?? ''}. Its rule shows No data until it does.`}
      </span>
    </div>
  )
}
