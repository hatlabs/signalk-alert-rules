/** A plain JSON object, as parsed input or a stored file may hold. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The message of a thrown value, which need not be an Error. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * A record's own entry for a key. Keys such as paths and instance names come
 * from outside, so one named like an Object property must not read it.
 */
export function own<T>(record: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined
}
