import type { GateStatus, InputState, InstanceStatus, Progress } from '../api'
import { formatValue } from './describe'
import { StatusBadge } from './StatusBadge'

const INPUT_TEXT: Readonly<Record<InputState, string>> = {
  value: '',
  unavailable: 'unavailable',
  neverSeen: 'never seen'
}

export function instanceName(i: InstanceStatus): string {
  return i.instance?.name ?? i.instance?.segment ?? ''
}

function valueText(i: InstanceStatus): string {
  if (i.value !== undefined) return formatValue(i.value)
  return i.input === undefined ? '' : INPUT_TEXT[i.input]
}

function ProgressCell({ progress, totalUnit }: { progress?: Progress; totalUnit?: string }) {
  if (progress === undefined) return null
  switch (progress.kind) {
    case 'timer': {
      const text = `${formatValue(progress.elapsed, 's')} of ${formatValue(progress.target, 's')} toward ${progress.toward}`
      return (
        <>
          <progress value={progress.elapsed} max={progress.target} aria-label={text} />{' '}
          <span>{text}</span>
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
          {formatValue(progress.total, totalUnit)} of {formatValue(progress.limit, totalUnit)}
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
  /** The unit of an accumulator's total, when the panel knows it. */
  totalUnit?: string
}

/** One row per instance: its status, value, limit, progress and gate states. */
export function InstanceTable({ instances, totalUnit }: InstanceTableProps) {
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
              <td>{valueText(i)}</td>
              <td>{i.limit === undefined ? '' : formatValue(i.limit)}</td>
              <td>
                <ProgressCell progress={i.progress} totalUnit={totalUnit} />
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
