import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { Rule } from '../../model/rule'
import { RuleRejectedError, type FieldError, type PanelApi, type RuleEntry } from '../api'
import { BackIcon } from '../detail/icons'
import { failureMessage } from '../failure'
import { FormHistory } from '../history/FormHistory'
import type { HistorySource } from '../history/historySource'
import type { PathList, PathSource } from '../paths/selfPaths'
import { ConfirmSheet, useSheet } from '../rules/Confirm'
import { discardedTotals, ruleDisplay } from '../rules/describe'
import type { UnitLookup } from '../signalUnits'
import { withKind, type ConditionKind } from './conditionKinds'
import { editConsequences } from './consequences'
import { UnattachedErrors, useFocusInvalid, WithPaths } from './editorFrame'
import { useLeaveGuard } from './leaveGuard'
import {
  emptyForm,
  fromBody,
  fromRule,
  forgetNamed,
  marginUnnamed,
  standingRetypes,
  toRule,
  withoutGate,
  withUnitErrors,
  type RuleForm
} from './formModel'
import { withGenerated } from './message'
import { checkedErrors, RuleFields } from './RuleFields'
import { fieldPointers, saveHint } from './sections'

export interface RuleEditorProps {
  api: PanelApi
  paths: PathSource
  /** The server's recorded values, for the chart beside the form; absent, there is none. */
  history?: HistorySource
  /** The rule to edit, with its current entry; absent for a new rule. */
  editing?: { entry: RuleEntry; rule: Rule }
  /** A stored rule that does not run, to fix: its slug, name, body as stored and errors. */
  invalid?: { slug: string; name: string; body: unknown; errors: FieldError[] }
  /** A new rule's value and condition kind, as From a path chose them. */
  start?: { path: string; kind: ConditionKind }
  /** Where the back link goes, and what it says. */
  back: { href: string; label: string }
  /** A listed rule's name by its slug, for the rule whose alert path a save clashes with. */
  ruleName?: (slug: string) => string | undefined
  /** The link that opens a rule's editor. */
  editHref?: (slug: string) => string
  /** The rule was saved; the form is done. */
  onSaved: (entry: RuleEntry) => void
  /** The operator left the form, having confirmed any unsaved changes are lost. */
  onClose: () => void
}

/**
 * The rule editor: one form whose fields follow the choices made, with what
 * most rules leave alone under More options.
 */
export function RuleEditor(props: RuleEditorProps) {
  return (
    <WithPaths source={props.paths}>
      {(paths, live) => <EditorForm {...props} paths={paths} live={live} />}
    </WithPaths>
  )
}

interface FormProps extends Omit<RuleEditorProps, 'paths'> {
  paths: PathList
  /** The paths as last read, for their values and sources now. */
  live: UnitLookup
}

/**
 * The form as it opens, with the errors it opens with: a stored rule's own,
 * and each number its reading left to type again.
 */
function initialForm(
  props: FormProps,
  units: UnitLookup
): { form: RuleForm; errors: FieldError[] } {
  const { editing, invalid, start } = props
  if (editing !== undefined) return { form: fromRule(editing.rule, units), errors: [] }
  if (invalid !== undefined) {
    const { form, emptied } = fromBody(invalid.body, units)
    // A number the server already names, or one the form has no field for, is not named again.
    const named = new Set(invalid.errors.map((e) => e.path))
    const shown = new Set(fieldPointers(form, false))
    const retype = emptied.filter((e) => !named.has(e.path) && shown.has(e.path))
    // Saved to the slug it is stored under, which the form does not show for an edit.
    return { form: { ...form, slug: invalid.slug }, errors: [...invalid.errors, ...retype] }
  }
  if (start === undefined) return { form: emptyForm(), errors: [] }
  const form = withKind(emptyForm(), start.kind)
  form.signal.slots[0] = { path: start.path, source: '' }
  return { form: withGenerated(form, units), errors: [] }
}

function EditorForm(props: FormProps) {
  const { api, paths, live, history, editing, invalid, back, onSaved, onClose } = props
  const ruleName = props.ruleName ?? (() => undefined)
  const isNew = editing === undefined && invalid === undefined
  // The form's numbers are text in the units it opened with, so every
  // conversion keeps those units; a unit reported later would rescale them.
  const [units] = useState(live)
  const [opened] = useState(() => initialForm(props, units))
  const initial = opened.form
  const [form, setForm] = useState<RuleForm>(initial)
  const [errors, setErrors] = useState<FieldError[]>(opened.errors)
  // The emptied clear margins a footer has named: on opening, and at each refused Save.
  const [named, setNamed] = useState<ReadonlySet<string>>(
    () => new Set(standingRetypes(initial, opened.errors).map((e) => e.path))
  )
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  // Held with the form it was previewed for: a field changed under the
  // confirmation would otherwise be dropped from the rule it stores.
  const confirming = useSheet<{ form: RuleForm; rule: Rule; lines: string[] }>()
  const pending = confirming.value
  const headingRef = useRef<HTMLHeadingElement>(null)
  const { formRef, focusInvalid } = useFocusInvalid()

  // The form only ever opens on the operator's action and replaces the view that held focus, so
  // focus moves to its heading. A layout effect, because the form mounts in a default-priority
  // update once its data has loaded, whose passive effects React runs in a later task, after the
  // operator could already have moved focus.
  useLayoutEffect(() => {
    headingRef.current?.focus()
  }, [])

  const dirty = useMemo(() => JSON.stringify(form) !== JSON.stringify(initial), [form, initial])
  const guard = useLeaveGuard({
    dirty,
    onClose,
    unsaved: 'The changes to this rule have not been saved.'
  })

  const showErrors = (next: FieldError[]) => {
    setErrors(next)
    focusInvalid()
  }

  const checked = checkedErrors(form, errors, isNew, ruleName)
  // A Save's errors keep the notes on numbers emptied for a unit until each is typed again.
  const retypes = standingRetypes(form, errors)
  const keepingNotes = (next: readonly FieldError[]) => withUnitErrors(next, retypes)

  const refused = (err: unknown) => {
    if (err instanceof RuleRejectedError && err.errors.length > 0)
      showErrors(keepingNotes(err.errors))
    else setFailure(failureMessage(err))
  }

  const store = async (rule: Rule) => {
    const saved =
      editing !== undefined
        ? await api.updateRule(editing.entry.slug, rule)
        : invalid !== undefined
          ? await api.updateRule(invalid.slug, rule)
          : await api.createRule(rule)
    guard.release()
    onSaved(saved)
  }

  const save = async () => {
    setFailure(undefined)
    const result = toRule(form, units)
    if (!result.ok || marginUnnamed(retypes, named)) {
      showErrors(keepingNotes(result.ok ? [] : result.errors))
      // The footer of this refused Save names every margin still empty.
      setNamed(new Set([...named, ...retypes.map((e) => e.path)]))
      return
    }
    setErrors(retypes)
    setBusy(true)
    try {
      if (editing !== undefined) {
        const preview = await api.previewRule(editing.entry.slug, result.rule)
        const totals = discardedTotals(
          editing.entry,
          ruleDisplay(editing.entry.rule, units).total
        ).map(({ name, total }) => (name === '' ? total : `${name}: ${total}`))
        const lines = editConsequences(preview, totals)
        if (lines.length > 0) {
          confirming.show({ form, rule: result.rule, lines })
          return
        }
      }
      await store(result.rule)
    } catch (err) {
      refused(err)
    } finally {
      setBusy(false)
    }
  }

  const title =
    editing !== undefined
      ? `Edit “${editing.entry.rule.name}”`
      : invalid !== undefined
        ? `Fix “${invalid.name}”`
        : 'New rule'
  const hint = saveHint(checked.errors, form, named)

  return (
    <div className="skar-editor">
      <a className="skar-back" href={back.href}>
        <BackIcon />
        <span>{back.label}</span>
      </a>
      <h2 ref={headingRef} tabIndex={-1} className="skar-title">
        {title}
      </h2>
      {invalid !== undefined && (
        <p className="skar-hint">
          The stored rule is not valid, so it does not run. Fix the fields marked below and save.
        </p>
      )}
      <div className="skar-editor-grid">
        <form
          ref={formRef}
          className="skar-card skar-editor-form"
          aria-label={title}
          noValidate
          // Enter in a field, or a tablet keyboard's Go, submits a form; a
          // rule half edited would be saved, so only the button saves.
          onSubmit={(event) => {
            event.preventDefault()
          }}
        >
          <RuleFields
            form={form}
            onChange={setForm}
            onStepsShifted={() => {
              setErrors(errors.filter((e) => !e.path.startsWith('/detector/steps/')))
            }}
            onGateRemoved={(index) => {
              const moved = withoutGate(errors, named, index)
              setErrors(moved.errors)
              setNamed(moved.named)
            }}
            onUnitChange={(emptied) => {
              setErrors((last) => withUnitErrors(last, emptied))
              setNamed((last) => forgetNamed(last, emptied))
            }}
            paths={paths}
            units={units}
            live={live}
            isNew={isNew}
            checked={checked}
            ruleName={ruleName}
            {...(props.editHref === undefined ? {} : { editHref: props.editHref })}
          />
        </form>
        <FormHistory history={history} form={form} units={units} />
      </div>

      <div className="skar-editor-actions">
        <div className="skar-editor-status">
          <UnattachedErrors errors={checked.attached.unattached} />
          {failure !== undefined && (
            <p className="skar-error" role="alert">
              {failure}
            </p>
          )}
          {hint !== undefined && (
            <p className="skar-hint" role="status">
              {hint}
            </p>
          )}
        </div>
        <div className="skar-editor-buttons">
          <button
            type="button"
            className="skar-btn skar-btn-ghost"
            disabled={busy}
            onClick={() => {
              guard.leave()
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            className="skar-btn skar-btn-primary"
            disabled={busy}
            onClick={() => void save()}
          >
            {isNew ? 'Create rule' : 'Save'}
          </button>
        </div>
      </div>

      {pending?.form === form && (
        <ConfirmSheet
          title={`Save “${form.name}”?`}
          confirmLabel="Save"
          tone="dark"
          onConfirm={async () => {
            try {
              await store(pending.rule)
            } catch (err) {
              if (!(err instanceof RuleRejectedError) || err.errors.length === 0) throw err
              confirming.close(false)
              showErrors(keepingNotes(err.errors))
            }
          }}
          onCancel={() => {
            confirming.close()
          }}
        >
          {pending.lines.map((line) => (
            <p key={line}>{line}</p>
          ))}
        </ConfirmSheet>
      )}
      {guard.prompt}
    </div>
  )
}
