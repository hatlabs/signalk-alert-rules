/** A plain JSON object, as parsed input or a stored file may hold. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The message of a thrown value, which need not be an Error. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
