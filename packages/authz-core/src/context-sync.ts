/**
 * The two ports through which an authorization context can outlive a reload and reach another tab.
 *
 * Both are **injected and optional**, and neither is implemented here. This package stays free of the
 * environment: it does not touch the DOM, `window`, `localStorage` or any global, and its tests run
 * without a browser. The browser implementations — a `BroadcastChannel`, a `localStorage` store and
 * the `storage`-event fallback — live in a separate package.
 *
 * **Neither port may take the session down.** Every call this package makes into either one is
 * wrapped, and a failure degrades to the behaviour of not having the port at all. `localStorage`
 * throws in a private window and when a quota is full, and a channel throws after its document is
 * discarded; a persistence convenience that can black out an authorization session is worse than no
 * persistence at all.
 */

/**
 * Where the active context id is kept so it survives a reload.
 *
 * **What is stored is a hint, never a claim.** The id says which of the server's contexts to prefer;
 * it never asserts that the subject holds it. The list from the decision point is the authority —
 * see the restore rule in the session.
 */
export interface ContextStore {
  /**
   * The stored id, or `null` when there is none.
   *
   * **May be asynchronous**, exactly like the token provider of the HTTP transport. `start()` is
   * already async so awaiting costs nothing, and it admits a store that is not `localStorage`
   * without a later breaking change.
   *
   * A `read` that throws or rejects is treated as **nothing persisted** — not as an outage.
   */
  read(): Promise<string | null> | string | null;

  /** Persist the id. A `write` that throws or rejects is **ignored**: the selection still completes. */
  write(contextId: string): Promise<void> | void;

  /** Forget whatever is stored. Ignored the same way `write` is. */
  clear(): Promise<void> | void;
}

/**
 * How a tab tells the others that the context changed, and hears about it.
 *
 * **There is no `close()`, on purpose.** The consumer created the channel and the consumer closes it;
 * `subscribe` returns its own unsubscribe function, which is all this package needs in order to stop
 * listening. Closing a resource you were handed is not this package's to do.
 */
export interface ContextSignal {
  /** Tell the other tabs. A throw is **ignored**: the selection still completes. */
  announce(contextId: string): void;

  /** Listen. The returned function stops this listener and nothing else. */
  subscribe(listener: (contextId: string) => void): () => void;
}
