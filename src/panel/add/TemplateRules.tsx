import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { Rule, TemplatePick } from '../../model/rule'
import type { Template } from '../../model/template'
import { proposeSlug } from '../../templates/instantiate'
import {
  isSlugTaken,
  RuleRejectedError,
  type FieldError,
  type ListedRule,
  type PanelApi,
  type RuleEntry,
  type TemplateSetEntry
} from '../api'
import { BackIcon } from '../detail/icons'
import { toRule, type RuleForm } from '../editor/formModel'
import { UnattachedErrors, useFocusInvalid, WithPaths } from '../editor/editorFrame'
import { useLeaveGuard } from '../editor/leaveGuard'
import { checkedErrors, RuleFields } from '../editor/RuleFields'
import { joined } from '../editor/words'
import { failureMessage } from '../failure'
import type { PathList, PathSource } from '../paths/selfPaths'
import type { UnitLookup } from '../signalUnits'
import { candidates, pickKey, ruleWatching, templateTitle, watchedPath } from './templatePicks'
import { copySettings, drafts, tabsHint } from './templateDrafts'

/**
 * How many slugs a create tries when the one proposed is taken by a stored
 * rule that is not listed, as one that failed to load.
 */
const SLUG_ATTEMPTS = 5

export interface TemplateRulesProps {
  api: PanelApi
  paths: PathSource
  set: TemplateSetEntry
  template: Template
  picks: readonly TemplatePick[]
  /** The listed rules, whose slugs the new rules must not take. */
  rules: readonly ListedRule[]
  /** Where the back link goes, and what it says. */
  back: { href: string; label: string }
  ruleName?: (slug: string) => string | undefined
  editHref?: (slug: string) => string
  /** A rule was created, before the others are; the list can show it. */
  onCreated: () => void
  /** Every rule was created. */
  onSaved: (entries: RuleEntry[]) => void
  /** The operator left, having confirmed the rules not created are lost. */
  onClose: () => void
}

/**
 * The rules a template's picks make, one tab each, each starting from the
 * template's values and edited on its own, all created with one save.
 */
export function TemplateRules(props: TemplateRulesProps) {
  return (
    <WithPaths source={props.paths}>
      {(paths, live) => <TabsForm {...props} paths={paths} live={live} />}
    </WithPaths>
  )
}

interface Tab {
  key: string
  pick: TemplatePick
  /** The pick as the user knows it. */
  label: string
  /** Nothing reports the value it watches yet. */
  waiting: boolean
  form: RuleForm
  /** The slug the template proposed; a slug the user typed is not changed on a conflict. */
  proposed: string
  errors: FieldError[]
  /**
   * The name of a rule from this template that already watches what the pick
   * does, as when the rules are opened again after some were created.
   */
  existing?: string
  /** The user chose to create the rule though one exists. */
  kept: boolean
  /**
   * A create got no answer, as when it timed out; it may have saved the rule,
   * so its slug being taken is not a reason to try the next one.
   */
  unanswered?: true
}

/** Whether Save creates the tab's rule: one that already exists only once the user keeps it. */
const included = (t: Tab) => t.existing === undefined || t.kept

interface FormProps extends Omit<TemplateRulesProps, 'paths'> {
  paths: PathList
  /** The paths as last read, for their values and sources now. */
  live: UnitLookup
}

function initialTabs(props: FormProps): Tab[] {
  const { set, template, picks, rules, live: units, paths } = props
  const reported = paths.status === 'ready' ? paths.paths : []
  const found = new Map(
    candidates(set.id, template, reported, rules).map((c) => [pickKey(c.pick), c])
  )
  const taken = new Set(rules.map((r) => r.slug))
  return drafts(set, template, picks, taken, units).map(({ pick, form }) => {
    const key = pickKey(pick)
    const candidate = found.get(key)
    const existing = ruleWatching(set.id, template, watchedPath(template, pick), pick.source, rules)
    return {
      key,
      pick,
      label: candidate?.label ?? pick.instance ?? pick.source ?? templateTitle(template),
      waiting: candidate?.entry === undefined,
      form,
      proposed: form.slug,
      errors: [],
      ...(existing === undefined ? {} : { existing }),
      kept: false
    }
  })
}

function rulesWord(n: number): string {
  return n === 1 ? '1 rule' : `${String(n)} rules`
}

function TabsForm(props: FormProps) {
  const { api, paths, live, template, back, onClose } = props
  // The units the rules opened with, which every conversion keeps.
  const [units] = useState(live)
  const id = useId()
  const ruleName = props.ruleName ?? (() => undefined)
  const [initial] = useState(() => initialTabs(props))
  const [tabs, setTabs] = useState(initial)
  const [activeKey, setActiveKey] = useState(() => initial.at(0)?.key)
  const [created, setCreated] = useState<RuleEntry[]>([])
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const [note, setNote] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const tabRefs = useRef(new Map<string, HTMLButtonElement>())
  const { formRef, focusInvalid } = useFocusInvalid()

  useEffect(() => {
    headingRef.current?.focus()
  }, [])

  // On a phone the tabs scroll sideways; Save may switch to one out of sight.
  useEffect(() => {
    if (activeKey !== undefined)
      tabRefs.current.get(activeKey)?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [activeKey])

  const dirty = useMemo(
    () =>
      JSON.stringify(tabs.map((t) => t.form)) !==
      JSON.stringify(initial.filter((t) => tabs.some((s) => s.key === t.key)).map((t) => t.form)),
    [tabs, initial]
  )
  const guard = useLeaveGuard({
    dirty,
    onClose,
    unsaved:
      tabs.length === 1
        ? 'The rule has not been created.'
        : `None of the ${String(tabs.length)} rules has been created.`
  })

  const title = templateTitle(template)
  if (tabs.length === 0 && created.length === 0) {
    return (
      <div className="skar-page">
        <a className="skar-back" href={back.href}>
          <BackIcon />
          <span>{back.label}</span>
        </a>
        <h2 ref={headingRef} tabIndex={-1} className="skar-title">
          {`New rules from “${title}”`}
        </h2>
        <p className="skar-banner" role="alert">
          <span>None of the picks fits this template. Choose again.</span>
        </p>
      </div>
    )
  }

  const active = tabs.find((t) => t.key === activeKey) ?? tabs.at(0)
  const checked = active && checkedErrors(active.form, active.errors, true, ruleName)

  const replaceTab = (key: string, patch: Partial<Tab>) => {
    setTabs((last) => last.map((t) => (t.key === key ? { ...t, ...patch } : t)))
  }

  const copyToOthers = () => {
    if (active === undefined) return
    const others = tabs.filter((t) => t.key !== active.key)
    const copies = new Map(others.map((t) => [t.key, copySettings(active.form, t.form, units)]))
    const copied = others.filter((t) => copies.get(t.key) !== undefined)
    const skipped = others.filter((t) => copies.get(t.key) === undefined)
    setTabs((last) =>
      last.map((t) => {
        const form = copies.get(t.key)
        return form === undefined ? t : { ...t, form }
      })
    )
    const names = (list: Tab[]) => joined(list.map((t) => t.label))
    setNote(
      [
        copied.length > 0 ? `Copied to ${names(copied)}.` : '',
        skipped.length > 0
          ? `Not copied to ${names(skipped)}, which ${skipped.length === 1 ? 'shows' : 'show'} values in other units: fill in this rule first.`
          : ''
      ]
        .filter((s) => s !== '')
        .join(' ')
    )
  }

  /**
   * Creates the rule, proposing the next slug while a rule that is not
   * listed holds the one tried; never for a slug the user typed.
   */
  const create = async (tab: Tab, rule: Rule): Promise<RuleEntry> => {
    const tried = new Set([...props.rules.map((r) => r.slug), ...tabs.map((t) => t.form.slug)])
    let attempt = rule
    for (let n = 1; ; n++) {
      try {
        return await api.createRule(attempt)
      } catch (err) {
        const retry =
          isSlugTaken(err) &&
          tab.unanswered === undefined &&
          rule.slug === tab.proposed &&
          n < SLUG_ATTEMPTS
        if (!retry) throw err
        tried.add(attempt.slug)
        attempt = { ...attempt, slug: proposeSlug(template.id, tab.pick.instance, tried) }
      }
    }
  }

  const save = async () => {
    setFailure(undefined)
    setNote(undefined)
    const read = tabs.filter(included).map((t) => ({ tab: t, result: toRule(t.form, units) }))
    const refused = read.filter(({ result }) => !result.ok)
    const errorsOf = new Map(
      read.map(({ tab, result }) => [tab.key, result.ok ? [] : result.errors])
    )
    setTabs(tabs.map((t) => ({ ...t, errors: errorsOf.get(t.key) ?? [] })))
    const firstRefused = refused.at(0)
    if (firstRefused !== undefined) {
      setActiveKey(firstRefused.tab.key)
      focusInvalid()
      return
    }
    setBusy(true)
    const done = [...created]
    const made = new Set<string>()
    // What befell the tab Save stopped at, applied over the tabs as they are by then.
    let stopped: { key: string; patch: Partial<Tab> } | undefined
    try {
      for (const { tab, result } of read) {
        if (!result.ok) continue
        try {
          done.push(await create(tab, result.rule))
        } catch (err) {
          if (err instanceof RuleRejectedError && err.errors.length > 0) {
            stopped = { key: tab.key, patch: { errors: err.errors } }
            focusInvalid()
          } else {
            stopped = { key: tab.key, patch: { unanswered: true } }
            setFailure(`${tab.label}: ${failureMessage(err)}`)
          }
          setActiveKey(tab.key)
          return
        }
        made.add(tab.key)
        props.onCreated()
      }
      guard.release()
      props.onSaved(done)
    } finally {
      setCreated(done)
      // Edits made while Save ran are kept: only its outcome is applied.
      setTabs((last) =>
        last
          .filter((t) => !made.has(t.key))
          .map((t) => (t.key === stopped?.key ? { ...t, ...stopped.patch } : t))
      )
      setBusy(false)
    }
  }

  const hint = tabsHint(tabs.map((t) => ({ label: t.label, form: t.form, errors: t.errors })))
  const createdNote =
    created.length === 0
      ? undefined
      : `Created ${rulesWord(created.length)}; ${created.length === 1 ? 'it is' : 'they are'} in the rule list.`
  const heading =
    created.length > 0
      ? `${rulesWord(tabs.length)} left from “${title}”${tabs.length === 1 && active !== undefined ? `: ${active.label}` : ''}`
      : tabs.length === 1
        ? `New rule from “${title}”`
        : `${String(tabs.length)} new rules from “${title}”`

  /** Arrow keys, Home and End move along the tabs, selecting as they go. */
  const onTabKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const at = tabs.findIndex((t) => t.key === active?.key)
    const to = new Map([
      ['ArrowRight', at + 1],
      ['ArrowLeft', at - 1],
      ['Home', 0],
      ['End', tabs.length - 1]
    ]).get(event.key)
    if (to === undefined) return
    event.preventDefault()
    const next = tabs.at((to + tabs.length) % tabs.length)
    if (next === undefined) return
    setActiveKey(next.key)
    tabRefs.current.get(next.key)?.focus()
  }
  const creating = tabs.filter(included).length
  const otherLabel = tabs.length === 2 ? tabs.find((t) => t.key !== active?.key)?.label : undefined

  return (
    <div className="skar-editor">
      <a className="skar-back" href={back.href}>
        <BackIcon />
        <span>{back.label}</span>
      </a>
      <h2 ref={headingRef} tabIndex={-1} className="skar-title">
        {heading}
      </h2>
      {tabs.length > 1 && (
        <div className="skar-tabs-row">
          <div
            className="skar-tabs"
            role="tablist"
            aria-label="Rules being created"
            onKeyDown={onTabKey}
          >
            {tabs.map((t) => (
              <button
                key={t.key}
                id={`${id}-tab-${t.key}`}
                ref={(el) => {
                  if (el === null) tabRefs.current.delete(t.key)
                  else tabRefs.current.set(t.key, el)
                }}
                type="button"
                role="tab"
                className="skar-tab"
                aria-selected={t.key === active?.key}
                tabIndex={t.key === active?.key ? 0 : -1}
                aria-controls={`${id}-panel`}
                onClick={() => {
                  setActiveKey(t.key)
                }}
              >
                <span>{t.label}</span>
                {t.waiting && <span className="skar-tab-note"> · not reporting yet</span>}
                {!included(t) && <span className="skar-tab-note"> · already has a rule</span>}
                {t.errors.length > 0 && <span className="skar-tab-error"> · needs fixing</span>}
              </button>
            ))}
          </div>
          <button type="button" className="skar-link-btn skar-link-small" onClick={copyToOthers}>
            {otherLabel === undefined
              ? `Copy these settings to the other ${String(tabs.length - 1)} rules`
              : `Copy these settings to ${otherLabel}`}
          </button>
        </div>
      )}
      {active !== undefined && !included(active) && (
        <div className="skar-banner" role="status">
          <span>
            {`Already has a rule from this template: ${active.existing ?? ''}. Save leaves it out.`}
          </span>
          <button
            type="button"
            className="skar-link-btn"
            onClick={() => {
              replaceTab(active.key, { kept: true })
            }}
          >
            Create another rule for it
          </button>
        </div>
      )}
      {active !== undefined && checked !== undefined && (
        <div className="skar-editor-grid">
          <form
            ref={formRef}
            id={`${id}-panel`}
            className="skar-card skar-editor-form"
            {...(tabs.length > 1
              ? { role: 'tabpanel', 'aria-labelledby': `${id}-tab-${active.key}` }
              : { 'aria-label': heading })}
            noValidate
            onSubmit={(event) => {
              event.preventDefault()
            }}
          >
            <RuleFields
              key={active.key}
              form={active.form}
              onChange={(form) => {
                replaceTab(active.key, { form })
              }}
              paths={paths}
              onStepsShifted={() => {
                replaceTab(active.key, {
                  errors: active.errors.filter((e) => !e.path.startsWith('/detector/steps/'))
                })
              }}
              units={units}
              live={live}
              isNew
              checked={checked}
              ruleName={ruleName}
              {...(props.editHref === undefined ? {} : { editHref: props.editHref })}
            />
          </form>
          {/* The history chart's place, beside the form on a tablet. */}
        </div>
      )}

      <div className="skar-editor-actions">
        <div className="skar-editor-status">
          {checked !== undefined && <UnattachedErrors errors={checked.attached.unattached} />}
          {failure !== undefined && (
            <p className="skar-error" role="alert">
              {failure}
            </p>
          )}
          {(createdNote !== undefined || hint !== undefined || note !== undefined) && (
            <p className="skar-hint" role="status">
              {[createdNote, hint, note].filter((s) => s !== undefined).join(' ')}
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
            disabled={busy || creating === 0}
            onClick={() => void save()}
          >
            {creating <= 1 ? 'Create rule' : `Create ${String(creating)} rules`}
          </button>
        </div>
      </div>

      {guard.prompt}
    </div>
  )
}
