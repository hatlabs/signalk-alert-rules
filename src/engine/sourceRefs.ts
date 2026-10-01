import type { PathInput, Rule, Signal } from '../model/rule.js'
import { isRecord, own } from '../util.js'

/** Maps a `$source` ref to the form rules store and match. */
export type Canonicalise = (ref: string) => string

// Fields of a connection in the sources tree that are not devices.
const CONNECTION_FIELDS = new Set(['label', 'type'])
const DOT = '.'.charCodeAt(0)

/**
 * The canonical form of a `$source` ref, read from the Signal K `sources`
 * tree the way the server's source-priority engine reads it (signalk-server
 * `buildSrcToCanonicalMap`): `<label>.<src>` of an NMEA 2000 device the tree
 * knows a CAN name for is `<label>.<canName>`. A provider with `useCanName`
 * off reports the bus address as `src`, which changes when the device claims
 * another address; the CAN name does not. Any other ref is its own canonical
 * form. The tree is read on every call because the server mutates it in place
 * as devices claim addresses.
 */
export function canonicalSourceRef(sources: unknown, ref: string): string {
  if (!isRecord(sources)) return ref
  for (const label in sources) {
    if (ref.charCodeAt(label.length) !== DOT || !ref.startsWith(label)) continue
    const src = ref.slice(label.length + 1)
    if (CONNECTION_FIELDS.has(src)) continue
    const connection = own(sources, label)
    const device = isRecord(connection) ? own(connection, src) : undefined
    const n2k = isRecord(device) ? device.n2k : undefined
    const canName = isRecord(n2k) ? n2k.canName : undefined
    if (typeof canName === 'string' && canName.length > 0) return `${label}.${canName}`
  }
  return ref
}

function canonicalInput(input: PathInput, canonical: Canonicalise): PathInput {
  return input.source === undefined ? input : { ...input, source: canonical(input.source) }
}

function canonicalSignal(signal: Signal, canonical: Canonicalise): Signal {
  if (!('combinator' in signal)) return canonicalInput(signal, canonical)
  return { ...signal, inputs: signal.inputs.map((i) => canonicalInput(i, canonical)) }
}

/** The rule with every pinned source, of its signal and its gates, in canonical form. */
export function canonicalSources(rule: Rule, canonical: Canonicalise): Rule {
  const { gates } = rule
  return {
    ...rule,
    signal: canonicalSignal(rule.signal, canonical),
    ...(gates === undefined
      ? {}
      : { gates: gates.map((g) => ({ ...g, signal: canonicalSignal(g.signal, canonical) })) })
  }
}
