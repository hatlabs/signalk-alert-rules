import type { Ref } from 'react'
import type { GateStatus, InputState, InstanceStatus, Progress } from '../api'
import { instanceName, type RuleDisplay } from './describe'
import { StateChip } from '../list/StateChip'

const INPUT_TEXT: Readonly<Record<InputState, string>> = {
  value: '',
  unavailable: 'unavailable',
  neverSeen: 'never seen'
}

function valueText(i: InstanceStatus, display: RuleDisplay): string {
  if (i.value !== undefined) return display.value(i.value)
  if (i.reason === 'inputUnavailable') return INPUT_TEXT.unavailable
  return i.reason === 'neverReported' ? INPUT_TEXT.neverSeen : ''
}

function ProgressCell({ progress, display }: { progress?: Progress; display: RuleDisplay }) {
  if (progress === undefined) return null
  switch (progress.kind) {
    case 'events':
      return (
        <span>
          {progress.count} of {progress.limit} events
        </span>
      )
    case 'total':
      return (
        <span>
          {display.total(progress.total)} of {display.total(progress.limit)}
        </span>
      )
  }
}

function gateText(gate: GateStatus, index: number): string {
  const holds = gate.holds ? 'holds' : 'does not hold'
  const input = gate.input === 'value' ? '' : `, input ${INPUT_TEXT[gate.input]}`
  return `Gate ${String(index + 1)}: ${holds}${input}`
}

export interface InstanceTableProps {
  instances: InstanceStatus[]
  display: RuleDisplay
  /** The instance a link names, by its name or alert path segment, to highlight. */
  linked?: string
  /** The linked instance's row, which takes focus when the operator follows the link. */
  linkedRef?: Ref<HTMLTableRowElement>
}

/** Whether an instance is the one a link names: an alert path carries the segment, people the name. */
export function isLinked(i: InstanceStatus, linked: string | undefined): boolean {
  return linked !== undefined && (i.instance?.name === linked || i.instance?.segment === linked)
}

/** One row per instance: its status, value, limit, progress and gate states. */
export function InstanceTable({ instances, display, linked, linkedRef }: InstanceTableProps) {
  const named = instances.some((i) => i.instance !== undefined)
  return (
    <div className="table-responsive">
      <table className="table table-sm align-middle skar-instances">
        <thead>
          <tr>
            {named && <th scope="col">Instance</th>}
            <th scope="col">Status</th>
            <th scope="col">Value</th>
            <th scope="col">Limit</th>
            <th scope="col">Progress</th>
            <th scope="col">Gates</th>
          </tr>
        </thead>
        <tbody>
          {instances.map((i, index) => (
            <tr
              key={i.instance?.segment ?? index}
              {...(isLinked(i, linked)
                ? {
                    ref: linkedRef,
                    tabIndex: -1,
                    'aria-current': true,
                    className: 'table-active skar-linked'
                  }
                : {})}
            >
              {named && <th scope="row">{instanceName(i)}</th>}
              <td>
                <StateChip kind={i.condition} />
                {i.condition === 'alerting' && i.priority !== undefined && (
                  <div className="skar-instance-summary">at {i.priority}</div>
                )}
              </td>
              {/* A number wrapped apart from its unit reads as two values. */}
              <td className="text-nowrap">{valueText(i, display)}</td>
              <td className="text-nowrap">{i.limit === undefined ? '' : display.value(i.limit)}</td>
              <td>
                <ProgressCell progress={i.progress} display={display} />
              </td>
              <td>
                {i.gates.map((gate, n) => (
                  <div key={n}>{gateText(gate, n)}</div>
                ))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
