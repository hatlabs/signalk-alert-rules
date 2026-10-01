import * as nodeFs from 'node:fs'
import { basename, dirname, join, relative } from 'node:path'
import type { EditBasis } from '../engine/evaluator.js'
import type { FrozenGates } from '../engine/suppression.js'
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

/**
 * A rule's accumulator totals by instance segment (`''` for a rule without
 * instances), with the measure they were built under: a rule of another
 * measure must not take them over, whatever else on disk says.
 */
export interface StoredTotals {
  measure: string
  totals: Record<string, number>
}

/** Accumulator totals by rule id. */
export type Checkpoints = Record<string, StoredTotals>

/** A suppression of a rule or an input path, with who started it and when. */
export interface Suppression {
  /** Wall time the suppression started. */
  since: string
  actor: string
  note?: string
  /** Seconds the condition must stay clear for the suppression to end by itself; manual when absent. */
  autoEndAfter?: number
}

/** A suppression of an input path, with the gate states it froze when it started. */
export interface InputSuppression extends Suppression {
  frozen?: FrozenGates
}

/** An operator's settings for one rule; a rule without them is enabled, unsuppressed and has no note. */
export interface RuleControl {
  enabled: boolean
  note?: string
  suppression?: Suppression
}

/** Something an upgrade or rescan changed that the operator should know, kept until dismissed. */
export interface RulesetNotice {
  at: string
  message: string
}

/** An operator's settings for one ruleset, with what was loaded last to tell what an upgrade changed. */
export interface RulesetControl {
  enabled: boolean
  /** Values the operator set, by parameter name; the rest take their defaults. */
  parameters: Record<string, number | string>
  version: string
  /** The rules last loaded, by slug, with the gates an edit of each compares. */
  rules: Record<string, EditBasis>
  notices: RulesetNotice[]
}

export interface Controls {
  /** By rule id, `<origin>.<slug>`. */
  rules: Record<string, RuleControl>
  /** By exact concrete path. */
  inputs: Record<string, InputSuppression>
  /** By ruleset slug; a ruleset without an entry is disabled. Absent when no ruleset was ever seen. */
  rulesets?: Record<string, RulesetControl>
}

const RULE_ACTIONS = ['delete', 'reset', 'enable', 'disable', 'note'] as const
const SUPPRESSION_ACTIONS = ['suppress', 'unsuppress'] as const
const RULESET_ACTIONS = ['enable', 'disable', 'parameters', 'dismiss'] as const

/** An operator action that changed what SKAR raises, with who did it and when. */
export type LogEntry = { at: string; actor: string } & (
  | { action: (typeof RULE_ACTIONS)[number]; rule: string }
  | { action: (typeof SUPPRESSION_ACTIONS)[number]; rule: string }
  | { action: (typeof SUPPRESSION_ACTIONS)[number]; path: string }
  | { action: (typeof RULESET_ACTIONS)[number]; ruleset: string }
  | { action: 'rescan' }
)

export interface StoreContents {
  rules: StoredRule[]
  accumulators: Checkpoints
  controls: Controls
  /** Oldest first. */
  log: LogEntry[]
  /** Slugs of rule files that could not be read and are still in place. */
  unreadableRules: string[]
  /** Files that could not be read; each part started empty, and a corrupt file was moved aside where the filesystem allowed. */
  issues: string[]
}

const RULES_DIR = 'rules'
const ACCUMULATORS_FILE = 'accumulators.json'
const LOG_FILE = 'log.json'
const CONTROLS_FILE = 'controls.json'
const JSON_SUFFIX = '.json'
const TMP_SUFFIX = '.tmp'
const SLUG = new RegExp(SLUG_PATTERN)

function isStoredTotals(value: unknown): value is StoredTotals {
  return (
    isRecord(value) &&
    typeof value.measure === 'string' &&
    isRecord(value.totals) &&
    Object.values(value.totals).every((t) => typeof t === 'number' && Number.isFinite(t))
  )
}

const optional = (value: unknown, type: 'string' | 'number') =>
  value === undefined || typeof value === type

function isSuppression(value: unknown): value is Suppression {
  return (
    isRecord(value) &&
    typeof value.since === 'string' &&
    typeof value.actor === 'string' &&
    optional(value.note, 'string') &&
    optional(value.autoEndAfter, 'number')
  )
}

const recordOf =
  <T>(accepts: (value: unknown) => value is T) =>
  (value: unknown): value is Record<string, T> =>
    isRecord(value) && Object.values(value).every(accepts)

const isCheckpoints = recordOf(isStoredTotals)

const isFrozenGates = recordOf(
  recordOf(recordOf((holds): holds is boolean => typeof holds === 'boolean'))
)

function isInputSuppression(value: unknown): value is InputSuppression {
  return (
    isRecord(value) &&
    (value.frozen === undefined || isFrozenGates(value.frozen)) &&
    isSuppression(value)
  )
}

function isRuleControl(value: unknown): value is RuleControl {
  return (
    isRecord(value) &&
    typeof value.enabled === 'boolean' &&
    optional(value.note, 'string') &&
    (value.suppression === undefined || isSuppression(value.suppression))
  )
}

function isNotice(value: unknown): value is RulesetNotice {
  return isRecord(value) && typeof value.at === 'string' && typeof value.message === 'string'
}

const isParameterValues = recordOf(
  (v): v is number | string =>
    typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v))
)

function isEditBasis(value: unknown): value is EditBasis {
  return isRecord(value) && Array.isArray(value.gates)
}

function isRulesetControl(value: unknown): value is RulesetControl {
  return (
    isRecord(value) &&
    typeof value.enabled === 'boolean' &&
    isParameterValues(value.parameters) &&
    typeof value.version === 'string' &&
    recordOf(isEditBasis)(value.rules) &&
    Array.isArray(value.notices) &&
    value.notices.every(isNotice)
  )
}

function isControls(value: unknown): value is Controls {
  return (
    isRecord(value) &&
    isRecord(value.rules) &&
    Object.values(value.rules).every(isRuleControl) &&
    isRecord(value.inputs) &&
    Object.values(value.inputs).every(isInputSuppression) &&
    (value.rulesets === undefined || recordOf(isRulesetControl)(value.rulesets))
  )
}

const isOneOf = <T extends string>(values: readonly T[], value: unknown): value is T =>
  (values as readonly unknown[]).includes(value)

function isLogEntry(value: unknown): value is LogEntry {
  if (!isRecord(value) || typeof value.at !== 'string' || typeof value.actor !== 'string') {
    return false
  }
  if (value.action === 'rescan') return true
  if (isOneOf(RULESET_ACTIONS, value.action) && typeof value.ruleset === 'string') return true
  if (isOneOf(RULE_ACTIONS, value.action)) return typeof value.rule === 'string'
  if (isOneOf(SUPPRESSION_ACTIONS, value.action)) {
    return typeof value.rule === 'string' || typeof value.path === 'string'
  }
  return false
}

/** An action SKAR does not record, skipped so an older data directory still loads its log. */
const isRetiredEntry = (value: unknown) => isRecord(value) && value.action === 'evaluation'

function isLog(value: unknown): value is unknown[] {
  return Array.isArray(value) && value.every((v) => isLogEntry(v) || isRetiredEntry(v))
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
 * - `accumulators.json`: accumulator totals, each with the measure it was
 *   built under, rewritten whole at each checkpoint;
 * - `controls.json`: per-rule enable, note and suppression, input
 *   suppressions, and per-ruleset enable, parameter values and notices,
 *   rewritten whole at each change;
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
      accumulators: this.read(ACCUMULATORS_FILE, isCheckpoints, issues) ?? {},
      controls: this.read(CONTROLS_FILE, isControls, issues) ?? { rules: {}, inputs: {} },
      log: (this.read(LOG_FILE, isLog, issues) ?? []).filter(isLogEntry),
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

  saveCheckpoints(checkpoints: Checkpoints): void {
    this.write(ACCUMULATORS_FILE, checkpoints)
  }

  saveControls(controls: Controls): void {
    this.write(CONTROLS_FILE, controls)
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
