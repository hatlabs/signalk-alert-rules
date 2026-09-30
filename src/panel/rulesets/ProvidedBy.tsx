import type { RuleSource } from '../api'

/**
 * Where a ruleset rule comes from. Its body is read-only, so this also says
 * where the operator can tune it instead.
 */
export function ProvidedBy({ source, open }: { source: RuleSource; open?: () => void }) {
  return (
    <div className="skar-provided-by">
      <p className="mb-1">{`Provided by ${source.name} v${source.version}`}</p>
      <p className="form-text mt-0">
        A ruleset rule cannot be edited; its ruleset&apos;s parameters tune it.{' '}
        {open !== undefined && (
          <button
            type="button"
            className="btn btn-link btn-sm p-0 align-baseline"
            aria-label={`Open ruleset ${source.name}`}
            onClick={open}
          >
            Open ruleset
          </button>
        )}
      </p>
    </div>
  )
}
