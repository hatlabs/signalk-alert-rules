import { useEffect, useRef, useState } from 'react'

export interface EvaluationOffBannerProps {
  /** Resolves once the server has turned evaluation on; a rejection is shown. */
  turnOn: () => Promise<void>
  /** Set when the banner replaces the control the keyboard user just activated. */
  takeFocus?: boolean
}

/** Shown above every view while evaluation is off, as no rule raises an alert then. */
export function EvaluationOffBanner({ turnOn, takeFocus = false }: EvaluationOffBannerProps) {
  const [error, setError] = useState<string | undefined>(undefined)
  const button = useRef<HTMLButtonElement | null>(null)
  useEffect(() => {
    if (takeFocus) button.current?.focus()
  }, [takeFocus])
  const onClick = async () => {
    setError(undefined)
    try {
      await turnOn()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }
  return (
    <div className="alert alert-warning skar-evaluation">
      <p>
        <strong>Evaluation is off.</strong> No rule is evaluated and none raises an alert.
      </p>
      {error !== undefined && (
        <p role="alert" className="text-danger">
          {error}
        </p>
      )}
      <button
        ref={button}
        type="button"
        className="btn btn-secondary btn-sm"
        onClick={() => void onClick()}
      >
        Turn evaluation on
      </button>
    </div>
  )
}
