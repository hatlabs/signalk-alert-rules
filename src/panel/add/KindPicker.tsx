import { useId, useState, type Ref } from 'react'
import { BackIcon } from '../detail/icons'
import { kindsFor, type ConditionKind, type KindInfo } from '../editor/conditionKinds'
import { emptySignal } from '../editor/formModel'
import { subjectOf } from '../editor/words'
import type { PathSource } from '../paths/selfPaths'
import { formatValue } from '../rules/describe'
import { useUnits } from '../signalUnits'
import { KindSketch } from './KindSketch'

export interface KindPickerProps {
  paths: PathSource
  /** The value chosen. */
  path: string
  backHref: string
  /** Goes on to the editor with the kind chosen. */
  choose: (kind: ConditionKind) => void
  headingRef?: Ref<HTMLHeadingElement>
}

function KindRows({
  kinds,
  name,
  chosen,
  onChoose
}: {
  kinds: readonly KindInfo[]
  name: string
  chosen: ConditionKind | undefined
  onChoose: (kind: ConditionKind) => void
}) {
  return (
    <div className="skar-rows skar-kinds">
      {kinds.map((k) => (
        <label key={k.kind} className="skar-row skar-kind">
          <input
            type="radio"
            name={name}
            value={k.kind}
            checked={chosen === k.kind}
            onChange={() => {
              onChoose(k.kind)
            }}
          />
          <KindSketch kind={k.kind} />
          <span className="skar-row-main">
            <span className="skar-row-name">{k.label}</span>
            <span className="skar-row-fact">{k.example}</span>
          </span>
        </label>
      ))}
    </div>
  )
}

/** From a path, second step: what about the value should alert. */
export function KindPicker({ paths, path, backHref, choose, headingRef }: KindPickerProps) {
  const name = useId()
  const { units, ready } = useUnits(paths)
  const [chosen, setChosen] = useState<ConditionKind | undefined>(undefined)
  const entry = units.entry(path)
  const kinds = kindsFor(entry?.value, entry?.valueType)
  const main = kinds.filter((k) => k.main)
  const more = kinds.filter((k) => !k.main)
  const subject = subjectOf({ ...emptySignal(), slots: [{ path, source: '' }] }, units)
  const zones = [...new Set((entry?.zones ?? []).map((z) => z.state))]
  return (
    <div className="skar-page">
      <a className="skar-back" href={backHref}>
        <BackIcon />
        <span>Which value?</span>
      </a>
      <div>
        <h2 ref={headingRef} tabIndex={-1} className="skar-title">
          What should alert?
        </h2>
        {ready && (
          <p className="skar-lead">
            {entry?.value === undefined ? (
              `${subject} is not reporting now.`
            ) : (
              <>
                {`${subject}, now `}
                <strong>{formatValue(entry.value, { kind: 'absolute', unit: entry.unit })}</strong>.
              </>
            )}{' '}
            {zones.length === 0
              ? 'Its metadata has no zones.'
              : `Its metadata has zones: ${zones.join(', ')}.`}
          </p>
        )}
      </div>
      <fieldset className="skar-kind-set">
        <legend className="skar-visually-hidden">What should alert</legend>
        <KindRows kinds={main} name={name} chosen={chosen} onChoose={setChosen} />
        {more.length > 0 && (
          <details className="skar-card skar-more-kinds" open={more.some((k) => k.kind === chosen)}>
            <summary>More kinds</summary>
            <KindRows kinds={more} name={name} chosen={chosen} onChoose={setChosen} />
          </details>
        )}
      </fieldset>
      <button
        type="button"
        className="skar-btn skar-btn-primary skar-btn-wide"
        disabled={chosen === undefined}
        onClick={() => {
          if (chosen !== undefined) choose(chosen)
        }}
      >
        Continue
      </button>
    </div>
  )
}
