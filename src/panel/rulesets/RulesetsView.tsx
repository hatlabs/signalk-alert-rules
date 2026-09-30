import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { RuleEntry } from '../api'
import { failureMessage } from '../failure'
import type { PathList } from '../paths/selfPaths'
import { displayUnit } from '../units'
import type { DiscoveryProblem, Parameter, RulesetEntry, RulesetListing, RulesetsApi } from './api'
import { parameterUnit } from './parameters'
import { RulesetCard } from './RulesetCard'
import './rulesets.css'

export interface RulesetsViewProps {
  api: RulesetsApi
  /** Every rule entry; each ruleset shows the status of its own. */
  rules: RuleEntry[]
  /** The server's paths, whose display units the parameters are entered in. */
  paths: PathList
  ruleHref: (origin: string, slug: string) => string
  /** Reads the rules again, so the other views show what an action changed. */
  refresh: () => void
  /** The ruleset to focus once shown, as when a rule's detail view links to it. */
  focusSlug?: string
}

function Problems({ problems }: { problems: DiscoveryProblem[] }) {
  const headingId = useId()
  return (
    <section className="alert alert-warning" aria-labelledby={headingId}>
      <h4 id={headingId} className="h6">
        Rulesets that could not be loaded
      </h4>
      <ul className="mb-0">
        {problems.map((p) => (
          <li key={`${p.source} ${p.message}`} className="skar-path">
            {p.source}
            {p.line === undefined ? '' : `, line ${String(p.line)}`}: {p.message}
          </li>
        ))}
      </ul>
    </section>
  )
}

const plural = (n: number, word: string) => `${String(n)} ${word}${n === 1 ? '' : 's'}`

function found(listing: RulesetListing): string {
  const { rulesets, problems } = listing
  const failed = problems.length === 0 ? '' : `; ${String(problems.length)} could not be loaded`
  return `Rescan found ${plural(rulesets.length, 'ruleset')}${failed}.`
}

/**
 * The Rulesets view. It reads the listing again whenever the rules do, since
 * the shell polls those and a ruleset's missing paths change with them.
 */
export function RulesetsView({
  api,
  rules,
  paths,
  ruleHref,
  refresh,
  focusSlug
}: RulesetsViewProps) {
  const [listing, setListing] = useState<RulesetListing | undefined>(undefined)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const [rescanning, setRescanning] = useState(false)
  const [announcement, setAnnouncement] = useState('')
  // An answer that arrives after a newer one, as a poll overtaken by a
  // rescan, would show the older state.
  const generation = useRef(0)

  const read = useCallback(async (request: () => Promise<RulesetListing>) => {
    const mine = ++generation.current
    const answer = await request()
    if (mine === generation.current) {
      setListing(answer)
      setFailure(undefined)
    }
    return answer
  }, [])

  useEffect(() => {
    read(() => api.list()).catch((err: unknown) => {
      setFailure(`Cannot read the rulesets: ${failureMessage(err)}`)
    })
  }, [api, rules, read])

  const unitsReady = paths.status !== 'loading'
  const unitOf = useCallback(
    (p: Parameter) =>
      p.type === 'number'
        ? parameterUnit(p.unit, paths.status === 'ready' ? paths.paths : [])
        : displayUnit({}),
    [paths]
  )

  const rescan = () => {
    setRescanning(true)
    read(() => api.rescan())
      .then((answer) => {
        setAnnouncement(found(answer))
        refresh()
      })
      .catch((err: unknown) => {
        setFailure(`The rescan failed: ${failureMessage(err)}`)
      })
      .finally(() => {
        setRescanning(false)
      })
  }

  const changed = (entry?: RulesetEntry) => {
    if (entry !== undefined) {
      generation.current++
      setListing((last) =>
        last === undefined
          ? last
          : { ...last, rulesets: last.rulesets.map((r) => (r.slug === entry.slug ? entry : r)) }
      )
    }
    refresh()
  }

  return (
    <div className="skar-rulesets-view">
      <h3 className="visually-hidden">Rulesets</h3>
      <div className="skar-toolbar">
        <p className="mb-0">
          Rulesets come from installed packages and from files in the plugin&apos;s rulesets
          directory. A new ruleset starts disabled.
        </p>
        <button
          type="button"
          className="btn btn-outline-primary btn-sm"
          disabled={rescanning}
          onClick={rescan}
        >
          Rescan
        </button>
      </div>
      <div role="status" className="visually-hidden">
        {announcement}
      </div>
      {failure !== undefined && (
        <div className="alert alert-danger" role="alert">
          {failure}
        </div>
      )}
      {listing === undefined ? (
        failure === undefined && <p>Loading the rulesets…</p>
      ) : (
        <>
          {listing.problems.length > 0 && <Problems problems={listing.problems} />}
          {listing.rulesets.length === 0 && (
            <p className="skar-empty">
              No ruleset is installed. Install a package that provides one, or add a ruleset file,
              then rescan.
            </p>
          )}
          {listing.rulesets.map((r) => (
            <RulesetCard
              key={r.slug}
              api={api}
              ruleset={r}
              rules={rules.filter((e) => e.origin === r.slug)}
              ruleHref={ruleHref}
              unitOf={unitsReady ? unitOf : undefined}
              changed={changed}
              announce={setAnnouncement}
              takeFocus={r.slug === focusSlug}
            />
          ))}
        </>
      )}
    </div>
  )
}
