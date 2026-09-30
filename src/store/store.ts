import * as nodeFs from 'node:fs'
import { basename, dirname, join, relative } from 'node:path'
import { SLUG_PATTERN, type Rule } from '../model/rule.js'
import { errorMessage, isRecord } from '../util.js'

/**
 * The file operations the store uses, so a test can make a write fail midway.
 */
export type FileSystem = Pick<
  typeof nodeFs,
  | 'closeSync'
  | 'fsyncSync'
  | 'mkdirSync'
  | 'openSync'
  | 'readFileSync'
  | 'readdirSync'
  | 'renameSync'
  | 'rmSync'
> & { writeSync: (fd: number, buffer: Uint8Array, offset: number) => number }

/** A user rule file as read; the caller validates it. */
export interface StoredRule {
  slug: string
  value: unknown
}

/** Whether rules are evaluated at all, and who last changed that. */
export interface EvaluationSwitch {
  enabled: boolean
  actor?: string
  at?: string
}

/** Accumulator totals by rule id, then by instance segment (`''` for a rule without instances). */
export type Checkpoints = Record<string, Record<string, number>>

/** An operator action that changed what SKAR raises, with who did it and when. */
export type LogEntry = { at: string; actor: string } & (
  { action: 'delete' | 'reset'; rule: string } | { action: 'evaluation'; enabled: boolean }
)

export interface StoreContents {
  rules: StoredRule[]
  evaluation: EvaluationSwitch
  accumulators: Checkpoints
  /** Oldest first. */
  log: LogEntry[]
  /** Slugs of rule files that could not be read and are still in place. */
  unreadableRules: string[]
  /** Files that could not be read; each part started empty, and a corrupt file was moved aside where the filesystem allowed. */
  issues: string[]
}

const RULES_DIR = 'rules'
const EVALUATION_FILE = 'evaluation.json'
const ACCUMULATORS_FILE = 'accumulators.json'
const LOG_FILE = 'log.json'
const JSON_SUFFIX = '.json'
const TMP_SUFFIX = '.tmp'
const SLUG = new RegExp(SLUG_PATTERN)

function isEvaluationSwitch(value: unknown): value is EvaluationSwitch {
  return (
    isRecord(value) &&
    typeof value.enabled === 'boolean' &&
    (value.actor === undefined || typeof value.actor === 'string') &&
    (value.at === undefined || typeof value.at === 'string')
  )
}

function isCheckpoints(value: unknown): value is Checkpoints {
  return (
    isRecord(value) &&
    Object.values(value).every(
      (totals) =>
        isRecord(totals) &&
        Object.values(totals).every((t) => typeof t === 'number' && Number.isFinite(t))
    )
  )
}

function isLogEntry(value: unknown): value is LogEntry {
  if (!isRecord(value) || typeof value.at !== 'string' || typeof value.actor !== 'string') {
    return false
  }
  switch (value.action) {
    case 'delete':
    case 'reset':
      return typeof value.rule === 'string'
    case 'evaluation':
      return typeof value.enabled === 'boolean'
    default:
      return false
  }
}

function isLog(value: unknown): value is LogEntry[] {
  return Array.isArray(value) && value.every(isLogEntry)
}

const anything = (_value: unknown): _value is unknown => true

function checkSlug(slug: string): void {
  // The slug names a file; the pattern keeps it inside the rules directory.
  if (!SLUG.test(slug)) throw new Error(`invalid rule slug: ${JSON.stringify(slug)}`)
}

/**
 * SKAR's persistent state in the plugin's data directory:
 *
 * - `rules/<slug>.json`: one user rule per file, so saving one rule never
 *   rewrites another;
 * - `evaluation.json`: the evaluation switch;
 * - `accumulators.json`: accumulator totals, rewritten whole at each checkpoint;
 * - `log.json`: the recent operator actions, rewritten whole at each action.
 *
 * Every write goes to a temporary file in the same directory, is flushed to
 * disk and renamed over the target, so a crash or full disk leaves either
 * the old file or the new one; concurrent writes of one file are last write
 * wins. A file that cannot be parsed is renamed to `<name>.corrupt-<time>`
 * and its part starts empty: the bad content is kept for inspection, is not
 * read again, and cannot be silently overwritten by the next save. A
 * corrupt file that cannot be moved aside is reported and its part starts
 * empty too. A rule file that cannot be read at all is reported and skipped,
 * so the other rules still run; any other file that cannot be read fails
 * `load`, because starting that part empty would let the next write replace
 * the totals or the log.
 * `load` creates the directories and must run before any write.
 */
export class Store {
  constructor(
    private readonly dir: string,
    private readonly fs: FileSystem = nodeFs
  ) {}

  load(): StoreContents {
    const issues: string[] = []
    this.fs.mkdirSync(join(this.dir, RULES_DIR), { recursive: true })
    this.removeTemporaries(this.dir, issues)
    this.removeTemporaries(join(this.dir, RULES_DIR), issues)

    const rules: StoredRule[] = []
    const unreadableRules: string[] = []
    for (const file of this.fs.readdirSync(join(this.dir, RULES_DIR)).sort()) {
      if (file.startsWith('.') || !file.endsWith(JSON_SUFFIX)) continue
      const name = join(RULES_DIR, file)
      const slug = file.slice(0, -JSON_SUFFIX.length)
      let value: unknown
      try {
        value = this.read(name, anything, issues)
      } catch (err) {
        // One unreadable rule must not keep every other rule from running.
        issues.push(`${name} could not be read (${errorMessage(err)}); skipped`)
        unreadableRules.push(slug)
        continue
      }
      if (value !== undefined) rules.push({ slug, value })
    }
    return {
      rules,
      evaluation: this.read(EVALUATION_FILE, isEvaluationSwitch, issues) ?? { enabled: true },
      accumulators: this.read(ACCUMULATORS_FILE, isCheckpoints, issues) ?? {},
      log: this.read(LOG_FILE, isLog, issues) ?? [],
      unreadableRules,
      issues
    }
  }

  saveRule(rule: Rule): void {
    checkSlug(rule.slug)
    this.write(join(RULES_DIR, rule.slug + JSON_SUFFIX), rule)
  }

  deleteRule(slug: string): void {
    checkSlug(slug)
    this.fs.rmSync(join(this.dir, RULES_DIR, slug + JSON_SUFFIX), { force: true })
    this.syncDir(join(this.dir, RULES_DIR))
  }

  saveEvaluation(evaluation: EvaluationSwitch): void {
    this.write(EVALUATION_FILE, evaluation)
  }

  saveCheckpoints(checkpoints: Checkpoints): void {
    this.write(ACCUMULATORS_FILE, checkpoints)
  }

  saveLog(log: LogEntry[]): void {
    this.write(LOG_FILE, log)
  }

  /**
   * Reads a JSON file; undefined when it is missing or corrupt. Throws when
   * it cannot be read at all.
   */
  private read<T>(
    name: string,
    accepts: (value: unknown) => value is T,
    issues: string[]
  ): T | undefined {
    const path = join(this.dir, name)
    let text: string
    try {
      text = this.fs.readFileSync(path, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw err
    }
    let problem: string
    try {
      const value: unknown = JSON.parse(text)
      if (accepts(value)) return value
      problem = 'unexpected content'
    } catch (err) {
      problem = errorMessage(err)
    }
    const aside = `${name}.corrupt-${new Date().toISOString().replaceAll(':', '-')}`
    try {
      this.fs.renameSync(path, join(this.dir, aside))
    } catch (err) {
      // A filesystem remounted read-only after a power cut refuses the rename.
      issues.push(
        `${name} could not be read (${problem}) nor moved aside (${errorMessage(err)}); started empty`
      )
      return undefined
    }
    issues.push(`${name} could not be read (${problem}); moved to ${aside} and started empty`)
    return undefined
  }

  private write(name: string, value: unknown): void {
    const path = join(this.dir, name)
    const tmp = join(dirname(path), `.${basename(path)}.${String(process.pid)}${TMP_SUFFIX}`)
    const fd = this.fs.openSync(tmp, 'w')
    try {
      try {
        this.writeAll(fd, name, Buffer.from(JSON.stringify(value, null, 2) + '\n'))
        this.fs.fsyncSync(fd)
      } finally {
        this.fs.closeSync(fd)
      }
      this.fs.renameSync(tmp, path)
    } catch (err) {
      this.fs.rmSync(tmp, { force: true })
      throw err
    }
    this.syncDir(dirname(path))
  }

  /**
   * A write may take only part of the buffer without failing, as on a
   * nearly full disk; a truncated file must never replace a good one.
   */
  private writeAll(fd: number, name: string, data: Uint8Array): void {
    let written = 0
    while (written < data.length) {
      const n = this.fs.writeSync(fd, data, written)
      if (n <= 0) throw new Error(`${name}: the disk accepted no more data`)
      written += n
    }
  }

  /**
   * Flushes a rename or removal itself, so a power cut right after a save or
   * delete cannot bring back the old file or lose a new one. Windows cannot open a directory.
   */
  private syncDir(dir: string): void {
    if (process.platform === 'win32') return
    const fd = this.fs.openSync(dir, 'r')
    try {
      this.fs.fsyncSync(fd)
    } finally {
      this.fs.closeSync(fd)
    }
  }

  private removeTemporaries(dir: string, issues: string[]): void {
    for (const file of this.fs.readdirSync(dir)) {
      if (!file.startsWith('.') || !file.endsWith(TMP_SUFFIX)) continue
      try {
        this.fs.rmSync(join(dir, file), { force: true })
      } catch (err) {
        // A filesystem remounted read-only after a power cut refuses the
        // removal; the file is never read, so the rules can still load.
        issues.push(
          `${relative(this.dir, join(dir, file))} could not be removed (${errorMessage(err)})`
        )
      }
    }
  }
}
