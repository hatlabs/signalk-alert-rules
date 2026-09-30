// The worked examples named in the MVP success criteria, keyed by slug: every
// detector, gates, a zone limit, latching, and the absDifference (plain and
// angular) and positionSpread combinators. They live in examples/rules as
// standalone rule files so reviewers read the same rules the tests run.

import { readdirSync, readFileSync } from 'node:fs'

const EXAMPLES_DIR = new URL('../../examples/rules/', import.meta.url)

export const workedExamples: Record<string, unknown> = Object.fromEntries(
  readdirSync(EXAMPLES_DIR)
    .filter((file) => file.endsWith('.json'))
    .sort()
    .map((file) => [
      file.slice(0, -'.json'.length),
      JSON.parse(readFileSync(new URL(file, EXAMPLES_DIR), 'utf8')) as unknown
    ])
)
