import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { extname, isAbsolute, join, relative } from 'node:path'
import { parseDocument, type YAMLError } from 'yaml'
import { validateTemplateSet, type TemplateSet } from '../model/template.js'
import type { ValidationError } from '../model/validate.js'
import { errorMessage, isRecord } from '../util.js'

/** package.json keyword marking a package as providing a template set. */
export const TEMPLATES_KEYWORD = 'signalk-alert-templates'

/** package.json field naming the package's template set file, relative to the package. */
export const TEMPLATES_FIELD = 'signalk-alert-templates'

/**
 * The template set built into Alert Rules, shipped in its own package; the
 * path is the same from `src/templates/` and from `dist/templates/`.
 */
export const BUILTIN_TEMPLATES = join(import.meta.dirname, '..', '..', 'templates', 'builtin.yaml')

/** Where the built-in set is reported to come from. */
export const BUILTIN_SOURCE = 'built-in'

const SET_EXTENSIONS = new Set(['.yaml', '.yml', '.json'])

/** An npm package name, scoped or not; it names a directory inside node_modules. */
const PACKAGE_NAME = /^(?:@[^/.][^/]*\/)?[^/.][^/]*$/

/**
 * Far above any hand-written template set. Parsing holds the whole text in
 * memory, and running out of memory is not an error discovery can catch.
 */
const MAX_SET_BYTES = 1024 * 1024

/** Well above what a hand-written template set needs, well below an alias bomb. */
const MAX_ALIAS_COUNT = 100

export interface DiscoveryDirs {
  /** The built-in template set file. */
  builtin?: string
  /**
   * The server's config directory: the packages its package.json lists as
   * dependencies, installed in its node_modules, may provide template sets.
   */
  configDir?: string
  /** A directory of template set files dropped in by the user. */
  dropIn?: string
}

export interface LoadedTemplateSet {
  /** Where it was found: `built-in`, `package some-name` or `file foo.yaml`. */
  source: string
  package?: { name: string; version: string }
  set: TemplateSet
}

export interface DiscoveryProblem {
  source: string
  message: string
  line?: number
  /** For a set that does not validate: each error, its path a JSON pointer into the set. */
  errors?: ValidationError[]
}

export interface DiscoveryResult {
  sets: LoadedTemplateSet[]
  /** The sets that were not loaded, with the reason. */
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
    readonly line?: number,
    readonly errors?: ValidationError[]
  ) {
    super(message)
  }
}

/**
 * Finds template sets: the built-in one, then those of packages and then
 * drop-in files, each sorted by name, so which of two sets sharing an id
 * loads does not depend on filesystem order, and no other set can take the
 * built-in set's id. A set is data: nothing in a providing package is run.
 */
export function discoverTemplateSets(dirs: DiscoveryDirs): DiscoveryResult {
  const problems: DiscoveryProblem[] = []
  const candidates: Candidate[] = []
  if (dirs.builtin !== undefined) candidates.push({ source: BUILTIN_SOURCE, file: dirs.builtin })
  if (dirs.configDir !== undefined) {
    const nodeModules = join(dirs.configDir, 'node_modules')
    for (const name of installedPackages(dirs.configDir, problems)) {
      try {
        if (!PACKAGE_NAME.test(name)) throw new Malformed('not a package name')
        const dir = join(nodeModules, name)
        const pkg = readPackageJson(dir)
        const candidate = packageCandidate(dir, pkg)
        if (candidate !== undefined) candidates.push(candidate)
      } catch (err) {
        // The name is what the operator installed, as npm recorded it.
        problems.push(problemOf(`package ${name}`, err))
      }
    }
  }
  if (dirs.dropIn !== undefined) candidates.push(...dropInCandidates(dirs.dropIn, problems))

  const sets: LoadedTemplateSet[] = []
  const taken = new Map<string, string>()
  for (const candidate of candidates) {
    try {
      const set = loadSet(candidate.file)
      const holder = taken.get(set.id)
      if (holder !== undefined) throw new Malformed(`id ${set.id} is already used by ${holder}`)
      taken.set(set.id, candidate.source)
      sets.push({
        source: candidate.source,
        ...(candidate.package && { package: candidate.package }),
        set
      })
    } catch (err) {
      problems.push(problemOf(candidate.source, err))
    }
  }
  return { sets, problems }
}

function problemOf(source: string, err: unknown): DiscoveryProblem {
  if (err instanceof Malformed)
    return {
      source,
      message: err.message,
      ...(err.line !== undefined && { line: err.line }),
      ...(err.errors !== undefined && { errors: err.errors })
    }
  return { source, message: errorMessage(err) }
}

/**
 * An unreadable directory, such as a root-owned scope left by `sudo npm
 * install`, is reported and skipped so that it cannot hide every other set.
 */
function listDir(dir: string, problems: DiscoveryProblem[]): string[] {
  try {
    return readdirSync(dir)
      .filter((name) => !name.startsWith('.'))
      .sort()
  } catch (err) {
    const { code } = err as NodeJS.ErrnoException
    if (code !== 'ENOENT' && code !== 'ENOTDIR') problems.push(problemOf(`directory ${dir}`, err))
    return []
  }
}

/**
 * The packages the server installed, as its config directory's package.json
 * lists them: the server installs with `npm install --save` there and removes
 * the entry on uninstall. Reading only these, rather than every directory in
 * node_modules with its hundreds of transitive dependencies, keeps
 * synchronous discovery from stalling a start on slow storage.
 */
function installedPackages(configDir: string, problems: DiscoveryProblem[]): string[] {
  const file = join(configDir, 'package.json')
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (err) {
    const { code } = err as NodeJS.ErrnoException
    if (code !== 'ENOENT' && code !== 'ENOTDIR') problems.push(problemOf(`file ${file}`, err))
    return []
  }
  try {
    const parsed: unknown = JSON.parse(text)
    const dependencies = isRecord(parsed) ? parsed.dependencies : undefined
    return isRecord(dependencies) ? Object.keys(dependencies).sort() : []
  } catch (err) {
    problems.push(problemOf(`file ${file}`, err))
    return []
  }
}

function readPackageJson(dir: string): Record<string, unknown> | undefined {
  let text: string
  try {
    text = readFileSync(join(dir, 'package.json'), 'utf8')
  } catch (err) {
    // Listed but not installed, as after an interrupted npm run: nothing to load.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw err
  }
  try {
    const parsed: unknown = JSON.parse(text)
    return isRecord(parsed) ? parsed : undefined
  } catch {
    // A package we cannot parse is not a template set provider we could load.
    return undefined
  }
}

function packageCandidate(
  dir: string,
  pkg: Record<string, unknown> | undefined
): Candidate | undefined {
  if (!Array.isArray(pkg?.keywords) || !pkg.keywords.includes(TEMPLATES_KEYWORD)) return undefined
  const { name, version } = pkg
  if (typeof name !== 'string' || typeof version !== 'string')
    throw new Malformed('package.json must have a name and a version')
  const field = pkg[TEMPLATES_FIELD]
  if (typeof field !== 'string')
    throw new Malformed(`package.json field ${TEMPLATES_FIELD} must name the template set file`)

  // Resolving symlinks on both sides keeps a link inside the package from
  // pointing the server at an arbitrary file elsewhere.
  const root = realpathSync(dir)
  let file: string
  try {
    file = realpathSync(join(root, field))
  } catch {
    throw new Malformed(`template set file ${field} not found`)
  }
  const inside = relative(root, file)
  if (inside === '' || inside.startsWith('..') || isAbsolute(inside))
    throw new Malformed(`template set file ${field} resolves outside the package`)
  if (!SET_EXTENSIONS.has(extname(file).toLowerCase()))
    throw new Malformed(`template set file ${field} must end in .yaml, .yml or .json`)
  return { source: `package ${name}`, package: { name, version }, file }
}

function dropInCandidates(dir: string, problems: DiscoveryProblem[]): Candidate[] {
  return listDir(dir, problems)
    .filter((name) => SET_EXTENSIONS.has(extname(name).toLowerCase()))
    .map((name) => ({ source: `file ${name}`, file: join(dir, name) }))
}

function loadSet(file: string): TemplateSet {
  if (statSync(file).size > MAX_SET_BYTES)
    throw new Malformed('template set file is larger than 1 MiB')
  const document = parseSetText(readFileSync(file, 'utf8'))
  const result = validateTemplateSet(document)
  if (!result.ok) {
    const summary = result.errors.map((e) => `${e.path || '/'}: ${e.message}`).join('; ')
    throw new Malformed(summary, undefined, result.errors)
  }
  return result.value
}

function lineOf(error: YAMLError): number | undefined {
  return error.linePos?.[0].line
}

/**
 * The core schema keeps `on`, `yes` and `no` strings, and JSON is a subset of
 * it. The yaml package only warns about an unknown tag and resolves it as a
 * plain value; a set relying on one is rejected as malformed rather than
 * silently reinterpreted. Explicit YAML 1.1 tags such as `!!binary`, `!!set`
 * and `!!omap` still resolve under the core schema, to values that validation
 * then rejects wherever they appear.
 */
function parseSetText(text: string): unknown {
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
