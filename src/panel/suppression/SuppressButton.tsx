import { useEffect, useId, useRef, useState } from 'react'
import type { RuleEntry } from '../api'
import type { PathSource } from '../paths/selfPaths'
import { useConfirmation } from '../rules/Confirm'
import { SuppressDialog, type SuppressionApi, type SuppressTarget } from './SuppressDialog'

/** What a suppression entry point needs; views without it offer no suppression. */
export interface SuppressContext {
  api: SuppressionApi
  /** The rules, to name those an input preview lists. */
  rules: RuleEntry[]
  paths: PathSource
  /** Called once a suppression is in force, to show its effect. */
  done: () => void
}

/**
 * The exact paths a rule reads, which an input suppression can name: its
 * signal's and gates' paths, with a wildcard bound to each instance the rule
 * has, since an input suppression takes no wildcard.
 */
export function inputPaths(entry: RuleEntry): string[] {
  const names = entry.status.instances.flatMap((i) =>
    i.instance?.name === undefined ? [] : [i.instance.name]
  )
  const bind = (path: string) =>
    path.split('.').includes('*')
      ? names.map((name) =>
          path
            .split('.')
            .map((s) => (s === '*' ? name : s))
            .join('.')
        )
      : [path]
  const all = [entry.rule.signal.paths, ...entry.rule.gates.map((g) => g.paths)].flat()
  return [...new Set(all.flatMap(bind))]
}

/** A button that opens the suppress dialog below it, and takes focus back when it closes. */
export function SuppressButton({
  target,
  context
}: {
  target: SuppressTarget
  context: SuppressContext
}) {
  const dialog = useConfirmation()
  return (
    <>
      <button
        ref={dialog.trigger}
        type="button"
        className="btn btn-outline-secondary btn-sm me-2"
        disabled={dialog.open}
        onClick={dialog.show}
      >
        Suppress…
      </button>
      {dialog.open && (
        <SuppressDialog
          target={target}
          api={context.api}
          rules={context.rules}
          paths={context.paths}
          onDone={() => {
            dialog.close()
            context.done()
          }}
          onCancel={dialog.close}
        />
      )}
    </>
  )
}

/** A rule's input paths as chips, each opening the suppress dialog for that path. */
export function InputChips({ entry, context }: { entry: RuleEntry; context: SuppressContext }) {
  const [open, setOpen] = useState<string | undefined>(undefined)
  const triggers = useRef(new Map<string, HTMLButtonElement>())
  const closed = useRef<string | undefined>(undefined)
  const labelId = useId()
  const chips = inputPaths(entry)

  // As useConfirmation does: the dialog held focus, which would otherwise drop to the page body.
  useEffect(() => {
    if (open === undefined && closed.current !== undefined) {
      triggers.current.get(closed.current)?.focus()
      closed.current = undefined
    }
  }, [open])

  if (chips.length === 0) return null
  const close = () => {
    closed.current = open
    setOpen(undefined)
  }
  return (
    <>
      <div className="skar-chips" role="group" aria-labelledby={labelId}>
        <span id={labelId} className="skar-chips-label">
          Suppress an input:
        </span>
        {chips.map((path) => (
          <button
            key={path}
            ref={(el) => {
              if (el === null) triggers.current.delete(path)
              else triggers.current.set(path, el)
            }}
            type="button"
            className="btn btn-outline-secondary btn-sm rounded-pill skar-path"
            aria-label={`Suppress input ${path}`}
            disabled={open === path}
            onClick={() => {
              setOpen(path)
            }}
          >
            {path}
          </button>
        ))}
      </div>
      {open !== undefined && (
        <SuppressDialog
          key={open}
          target={{ kind: 'input', path: open }}
          api={context.api}
          rules={context.rules}
          paths={context.paths}
          onDone={() => {
            close()
            context.done()
          }}
          onCancel={close}
        />
      )}
    </>
  )
}
