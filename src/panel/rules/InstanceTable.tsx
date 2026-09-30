import type { GateStatus, InputState, InstanceStatus, Progress } from '../api'
import { formatDuration, instanceName, type RuleDisplay } from './describe'
import { StatusBadge } from './StatusBadge'

const INPUT_TEXT: Readonly<Record<InputState, string>> = {
  value: '',
  unavailable: 'unavailable',
  neverSeen: 'never seen'
}

function valueText(i: InstanceStatus, display: RuleDisplay): string {
  if (i.value !== undefined) return display.value(i.value)
  return i.input === undefined ? '' : INPUT_TEXT[i.input]
}

function ProgressCell({ progress, display }: { progress?: Progress; display: RuleDisplay }) {
  if (progress === undefined) return null
  switch (progress.kind) {
    case 'timer': {
      const text = `${formatDuration(progress.elapsed)} of ${formatDuration(progress.target)} toward ${progress.toward}`
      return (
        // Beside the bar the text wraps mid-phrase in a narrow table; under it, it stays whole.
        <>
          <progress
            className="d-block w-100"
            value={progress.elapsed}
            max={progress.target}
            aria-label={text}
          />
          <span className="small text-nowrap">{text}</span>
        </>
      )
    }
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
}

/** One row per instance: its status, value, limit, progress and gate states. */
export function InstanceTable({ instances, display }: InstanceTableProps) {
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
            <tr key={i.instance?.segment ?? index}>
              {named && <th scope="row">{instanceName(i)}</th>}
              <td>
                <StatusBadge status={i} />
                {i.active === true && i.priority !== undefined && (
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
