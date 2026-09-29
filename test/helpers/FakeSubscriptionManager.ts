import type {
  Delta,
  Path,
  PathValueState,
  SourceRef,
  SubscribeCallback,
  SubscribeMessage,
  SubscriptionManager,
  Timestamp,
  Unsubscribes,
  Value
} from '@signalk/server-api'

interface Entry {
  path: string
  source: string
  value: Value
  state?: PathValueState
}

interface Subscription {
  matches: (path: string) => boolean
  all: boolean
  callback: SubscribeCallback
}

// The server's subscription path matcher: `*` becomes `.*`, so a wildcard can
// span several segments and the plugin has to narrow the match itself.
function pathMatcher(pattern: string): (path: string) => boolean {
  const regex = new RegExp('^' + pattern.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$')
  return (path) => regex.test(path)
}

/**
 * Stands in for the server's subscription manager on the self context: a
 * subscribe-time replay of the latest value per path and source, and live
 * delivery filtered to the preferred source unless `sourcePolicy` is `all`.
 * The preferred source is the best-ranked one that has published the path,
 * without the server's failover timeouts.
 */
export class FakeSubscriptionManager implements SubscriptionManager {
  private readonly cache = new Map<string, Entry>()
  private readonly subscriptions = new Set<Subscription>()

  constructor(private readonly ranking: readonly string[] = []) {}

  get activeSubscriptions(): number {
    return this.subscriptions.size
  }

  subscribe(
    command: SubscribeMessage,
    unsubscribes: Unsubscribes,
    _errorCallback: (err: unknown) => void,
    callback: SubscribeCallback
  ): void {
    const all = command.sourcePolicy === 'all'
    for (const row of command.subscribe) {
      const sub: Subscription = { matches: pathMatcher(row.path ?? '*'), all, callback }
      this.subscriptions.add(sub)
      unsubscribes.push(() => this.subscriptions.delete(sub))
      for (const entry of this.cache.values()) {
        if (sub.matches(entry.path) && (all || this.isPreferred(entry)))
          callback(this.toDelta(entry))
      }
    }
  }

  unsubscribe(): void {
    throw new Error('not used by the plugin')
  }

  publish(path: string, source: string, value: Value, state?: PathValueState): void {
    const entry: Entry = { path, source, value, state }
    this.cache.set(`${path}|${source}`, entry)
    const preferred = this.isPreferred(entry)
    for (const sub of [...this.subscriptions]) {
      if (sub.matches(path) && (sub.all || preferred)) sub.callback(this.toDelta(entry))
    }
  }

  timeOut(path: string, source: string): void {
    this.publish(path, source, null, { timedOut: true })
  }

  private rank(source: string): number {
    const i = this.ranking.indexOf(source)
    return i === -1 ? this.ranking.length : i
  }

  private isPreferred(entry: Entry): boolean {
    for (const other of this.cache.values()) {
      if (other.path === entry.path && this.rank(other.source) < this.rank(entry.source))
        return false
    }
    return true
  }

  private toDelta(entry: Entry): Delta {
    return {
      context: 'vessels.urn:mrn:signalk:uuid:fake' as Delta['context'],
      updates: [
        {
          $source: entry.source as SourceRef,
          timestamp: new Date().toISOString() as Timestamp,
          values: [
            {
              path: entry.path as Path,
              value: entry.value,
              ...(entry.state ? { state: entry.state } : {})
            }
          ]
        }
      ]
    }
  }
}
