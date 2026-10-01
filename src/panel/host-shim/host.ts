/**
 * Reads one of the admin UI's React globals (declared in types.d.ts). Failing
 * loudly beats bundling a fallback copy: a second React would render but
 * break every hook.
 */
export function hostModule<K extends keyof Window>(key: K): NonNullable<Window[K]> {
  const value = window[key]
  if (value === undefined || value === null) {
    throw new Error(
      `signalk-alert-rules: window.${String(key)} is not set. The webapp needs a Signal K admin UI that shares its React with embedded webapps.`
    )
  }
  return value
}
