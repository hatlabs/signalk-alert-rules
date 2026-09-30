import { readFile, readdir, realpath, stat } from 'node:fs/promises'
import { extname, isAbsolute, join, relative } from 'node:path'
import { parseDocument, type YAMLError } from 'yaml'
import type { Ruleset } from '../model/ruleset.js'
import { validateRuleset } from '../model/validate.js'

/** package.json keyword marking a package as a ruleset provider. */
export const RULESET_KEYWORD = 'signalk-alert-ruleset'

/** package.json field naming the provider's ruleset file, relative to the package. */
export const RULESET_FIELD = 'signalk-alert-ruleset'

const RULESET_EXTENSIONS = new Set(['.yaml', '.yml', '.json'])

/**
 * Far above any hand-written ruleset. Parsing holds the whole text in memory,
 * and running out of memory is not an error discovery can catch.
 */
const MAX_RULESET_BYTES = 1024 * 1024

/** Well above what a hand-written ruleset needs, well below an alias bomb. */
const MAX_ALIAS_COUNT = 100

export interface DiscoveryDirs {
  /** A node_modules directory whose packages may provide rulesets. */
  nodeModules?: string
  /** A directory of ruleset files dropped in by the user. */
  dropIn?: string
}

export interface LoadedRuleset {
  slug: string
  /** Human-readable origin, e.g. `package some-name` or `file foo.yaml`. */
  source: string
  package?: { name: string; version: string }
  ruleset: Ruleset
}

export interface DiscoveryProblem {
  source: string
  message: string
  line?: number
}

export interface DiscoveryResult {
  rulesets: LoadedRuleset[]
  problems: DiscoveryProblem[]
}

interface Candidate {
  source: string
  package?: { name: string; version: string }
  file: string
}

class Malformed extends Error {
  constructor(
    message: string,
    readonly line?: number
  ) {
    super(message)
  }
}

/**
 * Finds rulesets in provider packages and the drop-in directory. Packages come
 * first, then drop-in files, each sorted by name, so which of two rulesets
 * sharing a slug loads does not depend on filesystem order.
 */
export async function discoverRulesets(dirs: DiscoveryDirs): Promise<DiscoveryResult> {
  const problems: DiscoveryProblem[] = []
  const candidates: Candidate[] = []
  if (dirs.nodeModules !== undefined)
    for (const dir of await packageDirs(dirs.nodeModules, problems)) {
      const pkg = await readPackageJson(dir)
      try {
        const candidate = await packageCandidate(dir, pkg)
        if (candidate !== undefined) candidates.push(candidate)
      } catch (err) {
        // The directory is what the operator installed, as npm names it.
        const label = typeof pkg?.name === 'string' ? pkg.name : relative(dirs.nodeModules, dir)
        problems.push(problemOf(`package ${label}`, err))
      }
    }
  if (dirs.dropIn !== undefined) candidates.push(...(await dropInCandidates(dirs.dropIn, problems)))

  const rulesets: LoadedRuleset[] = []
  const taken = new Map<string, string>()
  for (const candidate of candidates) {
    try {
      const ruleset = await loadRuleset(candidate.file)
      const holder = taken.get(ruleset.slug)
      if (holder !== undefined)
        throw new Malformed(`slug ${ruleset.slug} is already used by ${holder}`)
      taken.set(ruleset.slug, candidate.source)
      rulesets.push({
        slug: ruleset.slug,
        source: candidate.source,
        ...(candidate.package && { package: candidate.package }),
        ruleset
      })
    } catch (err) {
      problems.push(problemOf(candidate.source, err))
    }
  }
  return { rulesets, problems }
}

function problemOf(source: string, err: unknown): DiscoveryProblem {
  if (err instanceof Malformed)
    return { source, message: err.message, ...(err.line !== undefined && { line: err.line }) }
  return { source, message: err instanceof Error ? err.message : String(err) }
}

/**
 * An unreadable directory, such as a root-owned scope left by `sudo npm
 * install`, is reported and skipped so that it cannot hide every other ruleset.
 */
async function listDir(dir: string, problems: DiscoveryProblem[]): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((name) => !name.startsWith('.')).sort()
  } catch (err) {
    const { code } = err as NodeJS.ErrnoException
    if (code !== 'ENOENT' && code !== 'ENOTDIR') problems.push(problemOf(`directory ${dir}`, err))
    return []
  }
}

async function packageDirs(nodeModules: string, problems: DiscoveryProblem[]): Promise<string[]> {
  const dirs: string[] = []
  for (const name of await listDir(nodeModules, problems)) {
    if (name.startsWith('@'))
      for (const scoped of await listDir(join(nodeModules, name), problems))
        dirs.push(join(nodeModules, name, scoped))
    else dirs.push(join(nodeModules, name))
  }
  return dirs
}

async function readPackageJson(dir: string): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'))
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined
  } catch {
    // Not a package, or one we cannot read: either way not a ruleset provider.
    return undefined
  }
}

async function packageCandidate(
  dir: string,
  pkg: Record<string, unknown> | undefined
): Promise<Candidate | undefined> {
  if (!Array.isArray(pkg?.keywords) || !pkg.keywords.includes(RULESET_KEYWORD)) return undefined
  const { name, version } = pkg
  if (typeof name !== 'string' || typeof version !== 'string')
    throw new Malformed('package.json must have a name and a version')
  const field = pkg[RULESET_FIELD]
  if (typeof field !== 'string')
    throw new Malformed(`package.json field ${RULESET_FIELD} must name the ruleset file`)

  // Resolving symlinks on both sides keeps a link inside the package from
  // pointing the server at an arbitrary file elsewhere.
  const root = await realpath(dir)
  let file: string
  try {
    file = await realpath(join(root, field))
  } catch {
    throw new Malformed(`ruleset file ${field} not found`)
  }
  const inside = relative(root, file)
  if (inside === '' || inside.startsWith('..') || isAbsolute(inside))
    throw new Malformed(`ruleset file ${field} resolves outside the package`)
  if (!RULESET_EXTENSIONS.has(extname(file).toLowerCase()))
    throw new Malformed(`ruleset file ${field} must end in .yaml, .yml or .json`)
  return { source: `package ${name}`, package: { name, version }, file }
}

async function dropInCandidates(dir: string, problems: DiscoveryProblem[]): Promise<Candidate[]> {
  return (await listDir(dir, problems))
    .filter((name) => RULESET_EXTENSIONS.has(extname(name).toLowerCase()))
    .map((name) => ({ source: `file ${name}`, file: join(dir, name) }))
}

async function loadRuleset(file: string): Promise<Ruleset> {
  if ((await stat(file)).size > MAX_RULESET_BYTES)
    throw new Malformed('ruleset file is larger than 1 MiB')
  const document = parseRulesetText(await readFile(file, 'utf8'))
  const result = validateRuleset(document)
  if (!result.ok)
    throw new Malformed(result.errors.map((e) => `${e.path || '/'}: ${e.message}`).join('; '))
  return result.value
}

function lineOf(error: YAMLError): number | undefined {
  return error.linePos?.[0].line
}

/**
 * The core schema keeps `on`, `yes` and `no` strings, and JSON is a subset of
 * it. The yaml package only warns about an unknown tag and resolves it as a
 * plain value; a ruleset relying on one is rejected as malformed rather than
 * silently reinterpreted. Explicit YAML 1.1 tags such as `!!binary`, `!!set`
 * and `!!omap` still resolve under the core schema, to values that validation
 * then rejects wherever they appear.
 */
function parseRulesetText(text: string): unknown {
  const document = parseDocument(text, { schema: 'core', uniqueKeys: true })
  const error = [...document.errors, ...document.warnings].at(0)
  if (error !== undefined) {
    // The first line is the message and position; the rest is a source excerpt.
    const [summary = ''] = error.message.split('\n')
    throw new Malformed(summary.replace(/:$/, ''), lineOf(error))
  }
  try {
    return document.toJS({ maxAliasCount: MAX_ALIAS_COUNT })
  } catch (err) {
    // The yaml package signals alias exhaustion with a ReferenceError.
    if (err instanceof ReferenceError)
      throw new Malformed(`alias expansion exceeds the limit: ${err.message}`)
    throw err
  }
}
