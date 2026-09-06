/**
 * The authorization context a subject is working under, as a state machine.
 *
 * A subject may hold several contexts and only one is active at a time. Everything derived
 * from a context — the permission menu, the decision cache — belongs to that context and to
 * no other, and this file exists so that a consumer never has to remember that.
 */

import type { Decision, PermissionEntry } from "./decision.js";
import { splitDecisionRequest } from "./batch.js";
import {
  AuthorizationTransportError,
  type AuthorizationContext,
  type AuthorizationTransport,
  type DecisionRequest,
} from "./transport.js";
import type { ContextSignal, ContextStore } from "./context-sync.js";

/**
 * Where the session is.
 *
 * Three of these are screens a consumer must render differently, and collapsing any two of
 * them is the mistake this type prevents:
 *
 * - `NO_CONTEXTS` — the subject holds none. Nothing to choose.
 * - `NO_ACCESS_IN_APP` — the context is real and does not open this application.
 * - `UNAVAILABLE` — no answer was obtained. **This is not an expired session and nothing
 *   here suggests re-authenticating.** Sending someone to sign in again because a decision
 *   point was unreachable teaches them that signing in fixes outages, and it does not.
 */
export type AuthorizationState =
  /**
   * Before `start()` is called, **or after `close()`**. Distinct from `LOADING`, which means a
   * call is in flight: a consumer that renders a spinner for `LOADING` would otherwise show one
   * for a session nobody has started yet.
   *
   * A closed session lands here on purpose rather than on a new state: the union does not grow a
   * second time, so no consumer's exhaustive `switch` breaks again.
   */
  | { readonly status: "IDLE" }
  | { readonly status: "LOADING" }
  | { readonly status: "NO_CONTEXTS" }
  | {
      readonly status: "CHOOSING_CONTEXT";
      readonly contexts: readonly AuthorizationContext[];
    }
  | { readonly status: "NO_ACCESS_IN_APP"; readonly contextId: string }
  | {
      readonly status: "READY";
      readonly contextId: string;
      readonly permissions: readonly PermissionEntry[];
    }
  /**
   * Something went wrong and this session cannot answer. **No `reason`, on purpose:** the
   * text would come from the consumer's own transport, which got it from a server, and this
   * package has no way to know what is safe to carry in someone else's error string — it
   * would be one `render` away from a screen, unbounded and unlabelled. Diagnostics belong
   * to the transport, which already holds the original error.
   */
  | { readonly status: "UNAVAILABLE" }
  /**
   * The context was changed in another tab, and this session is no longer answering.
   *
   * **The screen keeps its menu and the session stops answering, and both halves are deliberate.**
   * The menu is the consumer's DOM and this package does not touch it, so a half-typed form is not
   * lost. But the active context is gone: `decide()` returns the empty list, absent resolves to
   * `DENY` through `decisionFor`, and anything still in flight is dropped by the generation check.
   *
   * Denying is the honest answer, not the harsh one. The backend reads the active context from the
   * same shared place the other tab just wrote, so a button this session kept painting would be a
   * button the backend refuses. Fail-closed here means the screen agrees with what will happen.
   *
   * **There is no way to dismiss it.** It is left the way every other state is left — by calling
   * `start()`, which re-lists and restores the new context, or `selectContext()`. A dismissal would
   * let a consumer hide the banner and keep working in a context the subject has left, which is the
   * one outcome this state exists to prevent.
   */
  | {
      readonly status: "CONTEXT_CHANGED_ELSEWHERE";
      /** The context now active elsewhere. */
      readonly contextId: string;
      /**
       * The context this session was in.
       *
       * Carried because the consumer needs it and can recover it from nowhere else: it is what lets
       * a banner say which context the work on screen belongs to.
       */
      readonly previousContextId: string;
    };

/** What {@link createAuthorizationSession} needs to exist. */
export interface AuthorizationSessionOptions {
  /** The application being asked about. Passed to the transport unchanged. */
  readonly app: string;
  readonly transport: AuthorizationTransport;
  /**
   * The maximum number of (action, resource) pairs the decision point accepts in one call.
   *
   * **Required, and deliberately without a default.** A default would be a literal in this
   * package, and the maximum belongs to the engine that answers — see
   * {@link splitDecisionRequest}.
   */
  readonly maxPairsPerRequest: number;
  /**
   * The most decisions kept in memory at once. Default `5000`.
   *
   * **A memory bound, not a freshness policy.** Past it, the oldest entry is evicted — a
   * `Map` preserves insertion order, so the first key is the oldest. There is deliberately
   * no time-to-live: expiry is a separate decision and this package has not taken it.
   *
   * **Relate it to `maxPairsPerRequest`.** A value below it degrades the cache to pure
   * overhead: every pair a request writes is evicted by the next pair of that same request,
   * so no request is ever served from cache. This is not rejected and not warned about — a
   * small bound is a legitimate choice on a memory-constrained consumer — but it is a choice,
   * not a default anyone should arrive at by accident.
   */
  readonly maxCachedDecisions?: number;
  /**
   * Where the active context id is kept so it survives a reload. Optional.
   *
   * Supplying it turns on restoration at {@link AuthorizationSession.start} and persistence on every
   * activation. **Independent of {@link contextSignal}** — either may be supplied without the other,
   * and no path reads the store because a notice arrived.
   */
  readonly contextStore?: ContextStore;
  /**
   * How this tab tells the others the context changed, and hears about it. Optional.
   *
   * **Independent of {@link contextStore}** — a consumer that wants tabs to learn about each other
   * without writing anything into the browser supplies only this one, and no path announces because
   * a value was written.
   */
  readonly contextSignal?: ContextSignal;
}

/** The session. Everything on it is bound to the currently selected context. */
export interface AuthorizationSession {
  /** The current state. Synchronous, always defined. */
  getState(): AuthorizationState;
  /**
   * Observe changes. Returns a function that stops the subscription.
   *
   * **A listener owns its own errors.** If it throws, the throw is caught and discarded: the
   * other listeners still receive the emission, and the call that was publishing — `start()`,
   * `selectContext()`, `close()` — completes as if nothing had happened. Without that, one
   * consumer's render bug escaped into this package, and during `close()` it was permanent: the
   * listeners were never dropped, the signal never unsubscribed and the session never closed.
   *
   * **The throw is swallowed and NOT reported anywhere** — no callback, no console, no state.
   * This package deliberately has no diagnostic channel: `UNAVAILABLE` carries no `reason` for
   * the same reason, because an error string from someone else's code is one `render` away from
   * a screen. So a listener that throws silently loses that emission and nothing tells it. Do
   * your own error handling inside the listener.
   */
  subscribe(listener: (state: AuthorizationState) => void): () => void;
  /** Ask for the available contexts and settle into a state. */
  start(): Promise<void>;
  /**
   * Make a context active.
   *
   * @throws RangeError if the id is not one of the known contexts. That is a programming
   *     error — the ids come from this session — and the state does not change.
   */
  selectContext(contextId: string): Promise<void>;
  /** Instance-level decisions for the active context. See the method's own contract. */
  decide(request: DecisionRequest): Promise<readonly Decision[]>;
  /**
   * Stop listening and make the session inert. Idempotent.
   *
   * **The session stops answering.** It bumps the generation, empties the decision cache, drops the
   * active context and emits {@link AuthorizationState} `IDLE` — and only then drops the listeners
   * and unsubscribes from the signal. Afterwards `decide()` returns the empty list, so absent is
   * `DENY` through `decisionFor`; `start()` and `selectContext()` resolve without calling the
   * transport and without touching state — `selectContext()` does not even raise its `RangeError`;
   * `subscribe()` registers nothing; and `getState()` is `IDLE`.
   *
   * **It does not close the injected signal**: the consumer created that channel and closes it.
   *
   * ⚠️ **It cannot cancel a call already in flight** — this package never owned that `fetch`. What
   * it guarantees is that the answer is thrown away: the generation bump condemns it and nothing it
   * returns is cached or rendered.
   *
   * A single-page application that builds a session per route and never calls this accumulates one
   * live listener per navigation, each one holding a whole session alive.
   */
  close(): void;
}

export function createAuthorizationSession(
  options: AuthorizationSessionOptions,
): AuthorizationSession {
  const {
    app,
    transport,
    maxPairsPerRequest,
    maxCachedDecisions = 5000,
    contextStore,
    contextSignal,
  } = options;

  if (!Number.isInteger(maxCachedDecisions) || maxCachedDecisions < 1) {
    throw new RangeError(
      `maxCachedDecisions must be an integer greater than or equal to 1, received ${String(
        maxCachedDecisions,
      )}`,
    );
  }

  let state: AuthorizationState = { status: "IDLE" };
  let contexts: readonly AuthorizationContext[] = [];
  let activeContextId: string | undefined;

  /**
   * Incremented on every context selection, and compared when a call resolves.
   *
   * This is what drops a late answer. A permissions response for context A that arrives
   * after the subject switched to B must not paint A's menu over B's — the consumer would
   * be looking at a menu that belongs to a context it is not in, with no way to tell.
   *
   * A counter and not a timestamp: two selections within the same clock tick are
   * indistinguishable by time, and a clock that steps backwards makes the comparison lie.
   */
  let generation = 0;

  const listeners = new Set<(state: AuthorizationState) => void>();

  /** `contextId` + `resourceType` + `action` + `resourceId` -> the decision. */
  const decisionCache = new Map<string, Decision>();

  /** Set by {@link close}. A notice arriving afterwards changes nothing. */
  let closed = false;

  /**
   * Every call into either port goes through one of these four.
   *
   * **Neither port is allowed to take the session down.** A store throws in a private window and
   * when a quota is full; a channel throws once its document is discarded. A failure here degrades
   * to the behaviour of not having the port at all, which is a working session without persistence
   * — never a blacked-out one.
   */
  async function readStored(): Promise<string | null> {
    if (contextStore === undefined) {
      return null;
    }
    try {
      // The call is INSIDE the try so a synchronous throw is caught too, not only a rejection.
      return (await contextStore.read()) ?? null;
    } catch {
      return null;
    }
  }

  async function writeStored(contextId: string): Promise<void> {
    if (contextStore === undefined) {
      return;
    }
    try {
      await contextStore.write(contextId);
    } catch {
      // Ignored on purpose: the selection has already happened and is still valid.
    }
  }

  async function clearStored(): Promise<void> {
    if (contextStore === undefined) {
      return;
    }
    try {
      await contextStore.clear();
    } catch {
      // Ignored, same reason.
    }
  }

  function announce(contextId: string): void {
    if (contextSignal === undefined) {
      return;
    }
    try {
      contextSignal.announce(contextId);
    } catch {
      // Ignored: telling the other tabs is a courtesy, not part of selecting a context.
    }
  }

  /** Writes one decision, evicting the oldest first if the bound would be exceeded. */
  function cacheDecision(key: string, decision: Decision): void {
    if (!decisionCache.has(key) && decisionCache.size >= maxCachedDecisions) {
      const oldest = decisionCache.keys().next();
      if (!oldest.done) {
        decisionCache.delete(oldest.value);
      }
    }
    decisionCache.set(key, decision);
  }

  /**
   * Publish the state, and let no single listener stop the others from hearing it.
   *
   * **Neither an injected port nor a subscribed listener may take the session down.** It is the
   * same rule the four port wrappers above state, extended to the third thing a consumer hands in.
   * A render bug in one component must not deny the notification to every other subscriber, and
   * during `close()` it must not leave the session unclosable: an escaping throw there skipped the
   * listener drop, the signal unsubscribe and the `closed` flag, so every later `close()` threw
   * again and the session could never be closed at all.
   *
   * **The try wraps each listener, not the loop** — a loop-level try would stop at the first
   * thrower and the listeners after it would still lose the emission.
   */
  function setState(next: AuthorizationState): void {
    state = next;
    for (const listener of listeners) {
      try {
        listener(state);
      } catch {
        // Swallowed, and not reported anywhere. See `subscribe`.
      }
    }
  }

  function kindOf(error: unknown): "NO_ACCESS_IN_APP" | "UNAVAILABLE" {
    return error instanceof AuthorizationTransportError ? error.kind : "UNAVAILABLE";
  }

  /**
   * Make `context` active and load its menu.
   *
   * Everything derived from the previous context is discarded **before** the new call
   * starts, and the state goes to `LOADING` — never staying on the previous `READY`. A
   * consumer that kept rendering the old menu while the new one loaded would be showing
   * actions that belong to a context the subject already left.
   */
  async function activate(context: AuthorizationContext): Promise<number> {
    generation += 1;
    const issuedAt = generation;

    activeContextId = context.contextId;
    decisionCache.clear();

    if (!context.hasAccess) {
      // The menu is not fetched at all. Asking and inferring "no access" from an empty
      // answer would confuse "this context does not open this app" with "this context
      // opens it and may do nothing", which are different screens.
      setState({ status: "NO_ACCESS_IN_APP", contextId: context.contextId });
      return issuedAt;
    }

    setState({ status: "LOADING" });

    let menu;
    try {
      menu = await transport.fetchPermissions(app, context.contextId);
    } catch (error) {
      if (issuedAt !== generation) {
        return issuedAt;
      }
      // A failed fetch is never `READY` with an empty list: an empty menu is
      // indistinguishable from "you legitimately may do nothing", and the consumer would
      // render an empty screen instead of saying what happened.
      if (kindOf(error) === "NO_ACCESS_IN_APP") {
        setState({ status: "NO_ACCESS_IN_APP", contextId: context.contextId });
      } else {
        setState({ status: "UNAVAILABLE" });
      }
      return issuedAt;
    }

    if (issuedAt !== generation) {
      return issuedAt;
    }
    // A menu labelled with another context is a broken answer. Rendering it under the
    // requested label is exactly the confusion this state type exists to prevent, so it is
    // not `READY` with someone else's permissions — it is `UNAVAILABLE`.
    if (menu.contextId !== context.contextId || menu.app !== app) {
      setState({ status: "UNAVAILABLE" });
      return issuedAt;
    }
    // PERSISTED HERE AND NOWHERE ELSE: below the generation check, below the menu fetch and below
    // the label validation, so the only context ever written is one this session actually reached
    // READY under.
    //
    // Writing earlier — before the `hasAccess` branch, as this did until 003b — had three costs the
    // audit measured. A no-access context was written although the restore rule is guaranteed to
    // discard and clear it. A context whose menu fetch failed was persisted, so the subject landed
    // on UNAVAILABLE — a screen that carries no context list and offers no way out — reloaded to
    // escape, and was restored straight back into it, with the picker unreachable for the whole
    // outage. And a store whose `write()` hangs parked `selectContext()` with the picker still on
    // screen, before LOADING, so no spinner was even possible.
    //
    // Two accepted consequences. A selection superseded DURING THE MENU FETCH no longer writes,
    // because it returned at the check above: a context a superseded call chose has no business
    // being the one restored next time.
    //
    // ⚠️ NARROWED IN 003d, because the broad version was measured false. A selection superseded
    // during THE WRITE ITSELF does write — the write completes before the re-check below it, and
    // it cannot be otherwise: not writing would require knowing a supersession that has not
    // happened yet. It is acceptable for one reason and it is the same one the restore rule
    // rests on: the stored id is A HINT, re-validated against the server's list at `start()`, so
    // a stale write can cost a re-selection and never an access. Pinned by
    // "a selection superseded DURING the write does write" in `context-sync.test.ts`.
    //
    // And a selection that ends in no-access or a failed menu LEAVES THE PREVIOUS VALUE in
    // place — the store is not cleared on those paths. Restoring the last context that actually
    // worked is safer and less surprising than restoring one the subject cannot use, and clearing
    // would let one tab's failed attempt wipe a value every other tab is still using.
    //
    // AWAITED, and that is deliberate: a floating `void writeStored(...)` swallows the failure by
    // accident rather than by design, and its rejection escapes as an unhandled one.
    await writeStored(context.contextId);
    // THE RE-CHECK THAT BELONGS TO EVERY SUSPENSION POINT IN THIS FILE, and the write is one:
    // an injected store may be asynchronous, so `close()` and a cross-tab notice both land here.
    // Without it a closed session published a menu, and a session already showing
    // CONTEXT_CHANGED_ELSEWHERE was repainted READY under a context it had left — with its
    // subscribers still attached, because that path never dropped them.
    if (issuedAt !== generation) {
      return issuedAt;
    }
    setState({
      status: "READY",
      contextId: context.contextId,
      permissions: menu.permissions,
    });
    return issuedAt;
  }

  /**
   * A notice arrived from another tab.
   *
   * **The state change and the invalidation happen in the same step, before the state is emitted.**
   * The generation is bumped, the decision cache is cleared and the active context is dropped — so
   * by the time a subscriber sees `CONTEXT_CHANGED_ELSEWHERE`, the session is already refusing to
   * answer and anything still in flight is already condemned by the generation check. Emitting
   * first would leave a window in which a consumer re-rendering on the new state could still be
   * served a `PERMIT` from the old context's cache.
   */
  function onNotice(incoming: string): void {
    if (closed) {
      // DELIBERATELY REDUNDANT — one of SEVEN in this file. The other six: the `IDLE` guard and
      // the `previous === undefined` guard below, `start()`'s cache clear, `subscribe`'s `closed`
      // branch, and inside `close()` its idempotence guard and its `decisionCache.clear()`.
      //
      // 📐 WHICH GUARD ACTUALLY SUBSUMES THIS ONE, corrected in 003d and measured rather than
      // reasoned: THE `IDLE` GUARD, not `previous === undefined`. With this branch disabled, a
      // notice on a closed session is caught by `state.status === "IDLE"` — `close()` emits IDLE —
      // and control never reaches the guard below. The old comment credited the wrong one; the
      // declaration of redundancy was right, the mechanism named was not.
      //
      // It stays because "a closed session ignores notices" is the rule a reader comes here to
      // find, and because a channel that keeps delivering after `close()` is a real shape: the
      // consumer owns that channel and may not have closed it.
      return;
    }
    // Some channels echo to their own sender, and two tabs can legitimately select the same
    // context. Neither is a change.
    if (incoming === activeContextId) {
      return;
    }
    if (state.status === "IDLE") {
      // Nothing to invalidate, and the store already holds the new value, so the next start()
      // restores it.
      //
      // DELIBERATELY REDUNDANT, and not dead code — the same shape, and the same reasoning, as the
      // cache clear in `start()`. An IDLE session has no `activeContextId`, so the guard below
      // returns anyway and no test can distinguish the two. It stays because it states the rule
      // where a reader looks for it, and because the guard below is about a different question.
      return;
    }
    const previous = activeContextId;
    if (previous === undefined) {
      // Started but not in a context — CHOOSING_CONTEXT, or a start() still in flight. There is
      // nothing being answered and no previous context to name, and replacing a usable picker with
      // a banner would take away the only way forward. See the deviation section of the report.
      return;
    }

    generation += 1;
    decisionCache.clear();
    activeContextId = undefined;
    setState({
      status: "CONTEXT_CHANGED_ELSEWHERE",
      contextId: incoming,
      previousContextId: previous,
    });
  }

  let unsubscribeFromSignal: (() => void) | undefined;
  if (contextSignal !== undefined) {
    try {
      unsubscribeFromSignal = contextSignal.subscribe(onNotice);
    } catch {
      // A signal that cannot even be subscribed to leaves the session working without it.
      unsubscribeFromSignal = undefined;
    }
  }

  return {
    getState() {
      return state;
    },

    subscribe(listener) {
      if (closed) {
        // Registers nothing, and the returned function is still safe to call.
        //
        // ⚠️ THE STATUS OF THIS BRANCH DEPENDS ON `close()`, and 003d measured all three states
        // rather than declaring one. It used to say "unobservable"; the audit said "load-bearing
        // behaviour"; both are right about a different version of `close()`.
        //
        // 📐 Measured, one test — "a listener subscribed after close() receives nothing" — under
        // three configurations:
        //
        //   `closed` set BEFORE the emission (as it is now), branch removed  -> GREEN
        //   `closed` set AFTER  the emission (as it was),  branch removed    -> RED
        //   the shipped tree                                                 -> GREEN
        //
        // So the branch was load-bearing BEHAVIOUR only through the door MAJOR-A opened: a listener
        // re-entering `start()` from the final IDLE emission resurrected the session, and a late
        // subscriber then received its live state. Moving the flag above that emission closed that
        // door, AND THAT SUBSUMES THIS BRANCH — it is a bound again, and now genuinely one.
        //
        // It stays, and not out of caution: what it bounds is real — a consumer that keeps
        // subscribing to a session it forgot to drop would otherwise accumulate one entry per call,
        // forever — and the test above pins the rule where a reader looks for it, whichever of the
        // two mechanisms is holding it up.
        return () => {};
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    /**
     * List the contexts and, if there is exactly one, activate it.
     *
     * **`start()` is a re-initialisation and behaves like one.** It joins the same generation
     * protocol as {@link activate}: a session that is re-listing its contexts is not in a
     * context, so the active context and the decision cache are dropped on entry, and a call
     * that resolves after a later one has superseded it returns without touching state — and,
     * when it was superseded during the menu fetch, without writing either. See `activate`'s
     * persistence comment for the one window where a superseded selection does write.
     * Without this, a second `start()` repainted over a live `READY` while `activeContextId`
     * and the cache stayed on the old context.
     */
    async start() {
      if (closed) {
        // Silence, not an exception. A route guard already awaiting this must not blow up because
        // something closed the session a millisecond earlier; every other failure in this package
        // degrades to fail-closed silence and this one matches.
        return;
      }
      generation += 1;
      const issuedAt = generation;

      // Not in a context any more. Answering `decide` from the previous context's cache
      // while its contexts are being re-listed is answering for a context we left.
      activeContextId = undefined;
      // DELIBERATELY REDUNDANT, and not dead code. With `activeContextId` cleared on the line
      // above, `decide` returns before it ever reads the cache, and every path that sets a
      // context again goes through `activate`, which clears too — so no test can reach a state
      // where removing this line changes an answer, and the audit proved exactly that. It stays
      // because this cache gates authorization: one line of defence in depth is cheaper than
      // the reasoning needed to be sure the other two hold after the next change.
      decisionCache.clear();
      setState({ status: "LOADING" });

      let available: readonly AuthorizationContext[];
      try {
        available = await transport.listContexts(app);
      } catch {
        if (issuedAt !== generation) {
          return;
        }
        setState({ status: "UNAVAILABLE" });
        return;
      }

      if (issuedAt !== generation) {
        return;
      }

      contexts = available;

      if (available.length === 0) {
        setState({ status: "NO_CONTEXTS" });
        return;
      }
      const only = available[0];
      if (available.length === 1 && only !== undefined) {
        // One context is not a choice. Showing a picker with a single option asks the
        // subject to confirm something that has no alternative. This wins regardless of what
        // the store says: activating the only context there is produces the same outcome.
        await activate(only);
        return;
      }

      const stored = await readStored();
      if (issuedAt !== generation) {
        // A later start() or selectContext() superseded this one while the read was in flight.
        return;
      }
      if (stored !== null) {
        const match = available.find((c) => c.contextId === stored);
        // THE SECURITY RULE OF THIS FILE. A stored id is a HINT about which of the server's
        // contexts to prefer. It is NEVER a claim that the subject holds that context, so it is
        // only honoured when the list the decision point just returned contains it. An id that is
        // not in the list — an arrangement that ended, another application's value, one edited by
        // hand — is discarded, not asked about.
        //
        // `hasAccess === false` is a discard too, and for a different reason: restoring into
        // NO_ACCESS_IN_APP puts the subject on a screen that carries no context list and therefore
        // offers no way out. The picker is shown instead; picking it by hand still lands there,
        // with the whole explanation, which is today's behaviour and stays.
        if (match !== undefined && match.hasAccess) {
          await activate(match);
          return;
        }
        await clearStored();
        if (issuedAt !== generation) {
          return;
        }
      }
      setState({ status: "CHOOSING_CONTEXT", contexts: available });
    },

    async selectContext(contextId) {
      if (closed) {
        // Inert means inert: not even the RangeError an unknown id would raise. Same reason as
        // `start()`.
        return;
      }
      const context = contexts.find((c) => c.contextId === contextId);
      if (context === undefined) {
        throw new RangeError(`unknown contextId: ${contextId}`);
      }
      // Read BEFORE activate, which overwrites it.
      const previous = activeContextId;
      const issuedAt = await activate(context);
      // THE RE-CHECK THAT BELONGS TO EVERY SUSPENSION POINT IN THIS FILE. `await activate(...)`
      // is one, and until 003d it was the only one without it — which is why three rounds
      // described the symptom as "a closed session still announces" and none of them found it.
      //
      // The predicate is the GENERATION and not `closed`, and that choice is the fix:
      //
      // - `closed` is the right place with the wrong predicate. It closes the `close()` case and
      //   leaves the one that costs more: a LIVE session, superseded by a cross-tab notice, still
      //   announces the context it was selecting. Measured, it evicts the tab that legitimately
      //   won — that tab is knocked out of a context it had just correctly selected, and every tab
      //   is left naming a context NO TAB IS IN.
      // - Inside `announce` would be worse still: those four port wrappers have exactly one job —
      //   neither an injected port nor a subscribed listener may take the session down — and
      //   putting policy in one of them turns a wrapper into a decision point.
      // - The generation closes both for the reason every other suspension point in this file
      //   already obeys: A SUPERSEDED CALL MUST NOT SPEAK. `close()` bumps it, a notice bumps it,
      //   a later `start()` or `selectContext()` bumps it. One predicate, four supersessions.
      //
      // `activate` RETURNS its own `issuedAt` rather than the call site computing `generation + 1`:
      // that would reach into `activate` for the knowledge that it bumps exactly once on entry, and
      // no other re-check in this file knows anything about another function's internals.
      //
      // And it returns it on EVERY path, including the early ones. The question here is "was I
      // superseded", NOT "did I reach READY": a selection that ends in no-access or unavailable
      // MUST still announce, because the subject did switch and any tab that kept answering would
      // be painting permits the backend will refuse.
      if (issuedAt !== generation) {
        return;
      }
      // Announced from here and from nowhere else, and only on a real change.
      //
      // Not from the restore path: a tab that just reloaded has not changed anything, and
      // announcing would make every other tab display a change that never happened. Not from the
      // single-context auto-activation, for the same reason. Not on re-selecting the context that
      // is already active — that is not a change, and waking every other tab for it is how a
      // banner appears for no reason.
      if (previous !== context.contextId) {
        announce(context.contextId);
      }
    },

    close() {
      if (closed) {
        return;
      }
      // Idempotence is stated by that guard rather than emerging from the steps below. It is
      // DELIBERATELY REDUNDANT, and it is the one the count used to miss — the family is SEVEN,
      // not six; the list is in `onNotice`. A second pass would find the listeners already
      // cleared and `unsubscribeFromSignal` already undefined, so nothing observable happens
      // either way — but "calling it twice is not an error" is a promise, and a promise held by
      // accident is one the next edit breaks.
      //
      // ORDER MATTERS, and one step of it is the whole point.
      //
      // 1-3 make the session stop answering: the generation bump condemns anything in flight, the
      // cache is emptied and the active context is dropped, so `decide` returns [] and absent is
      // DENY through `decisionFor`.
      generation += 1;
      // DELIBERATELY REDUNDANT, one of the seven — see the list in `onNotice`. Dropping the active
      // context on the
      // line below makes `decide` return before it ever reads the cache, so emptying it changes
      // no answer and no test can reach the difference — measured, not assumed. It stays because
      // this cache gates authorization: one line of defence in depth is cheaper than the
      // reasoning needed to be sure the other two still hold after the next change.
      decisionCache.clear();
      activeContextId = undefined;

      // THE FLAG GOES HERE, BEFORE THE EMISSION, AND ITS POSITION IS THE POINT OF THIS STEP.
      //
      // It used to be set last, after the emission below, and that left a window with the shape of
      // the leak this method exists to close. During the final emission `closed` was still false,
      // so a listener that re-entered `start()` or `selectContext()` was served BY A SESSION THAT
      // WAS CLOSING. Worse, it was served correctly: `close()` bumps the generation before the
      // emission and nothing bumps it after, so the re-entrant call's own bump made it the newest
      // generation and every re-check in this file waved it through.
      //
      // Measured on the shipped code: a listener calling `start()` on the final IDLE left the
      // CLOSED session READY with a permission menu, the transport called AFTER `close()`, and
      // `decide()` answering PERMIT. That is exactly the leak, arriving through the one call that
      // was supposed to end it.
      //
      // Setting it here does NOT disturb the 4-before-5 ordering below: the emission still comes
      // first, so a framework binding still gets its one render to clear the screen. What changes
      // is only that the session stops ANSWERING during that render.
      closed = true;

      // 4 BEFORE 5. Dropping the listeners first would mean nobody hears the transition, and THE
      // PREVIOUS SUBJECT'S MENU STAYS PAINTED — which is the leak this exists to close. A framework
      // binding needs this one last emission in order to re-render empty.
      //
      // Why it matters: a different person signs in on the same browser and the token store is
      // shared across tabs, so the next refresh hands this tab a token for another subject. The
      // backend refuses that tab's requests — no data crosses — but the menu already painted and the
      // decisions already cached belong to the previous person. The new person does not see their
      // records; they see their SILHOUETTE: which sections existed, which actions were available,
      // whether that person was an administrator. In a package where the menu IS the permission,
      // the silhouette says plenty.
      setState({ status: "IDLE" });
      // DELIBERATELY REDUNDANT AS BEHAVIOUR SINCE THE RE-CHECK IN `activate`, and load-bearing as
      // a bound.
      //
      // The analogy this used to draw — "the same shape as the `closed` branch in `subscribe`" —
      // survives 003d, but only after the fact and for a reason worth writing down: that branch WAS
      // load-bearing behaviour while `closed` was set after the final emission, and stopped being
      // so when the flag moved above it. 📐 Measured, three configurations, in that branch's own
      // comment. Both lines are bounds again; neither was always one.
      //
      // It used to be observable, and that was the symptom of a defect rather than a feature: it
      // was the only thing keeping a stray READY, published by an `activate` parked in its store
      // write, out of a subscriber's render function. `activate` re-checks the generation now, so
      // there is no stray emission left to absorb, and removing this line leaves the whole suite
      // green — measured, 134/0 with the line and without it.
      //
      // What it still buys is a bound: a consumer that keeps subscribing to a session it never
      // dropped would otherwise hold every listener, and through them every closure, alive for as
      // long as it holds the session. No test can reach that, and inventing one that pretends to
      // would be worse than saying so here.
      listeners.clear();

      if (unsubscribeFromSignal !== undefined) {
        try {
          unsubscribeFromSignal();
        } catch {
          // A signal whose document is gone can throw on the way out too. Reaching here with the
          // listeners already dropped is why this cannot leak them.
        }
        unsubscribeFromSignal = undefined;
      }
    },

    /**
     * Instance-level decisions for the active context.
     *
     * The request is split by {@link splitDecisionRequest} and every chunk is asked
     * **concurrently**. Chunks are independent and a sequential loop would make the whole
     * call as slow as the sum of its parts for no gain.
     *
     * **Fail-closed per chunk.** A chunk whose call rejects contributes nothing to the
     * merged result, so every pair it carried is absent — and absent resolves to `DENY`
     * through `decisionFor`. One failed chunk never fails the whole call and never turns
     * into a permit. Nothing from a failed chunk is cached either: a transient outage must
     * not leave a denial behind that outlives it.
     *
     * With no active context the answer is the empty list, by the same rule: every pair
     * resolves to `DENY`.
     *
     * The cache is consulted only when it holds **every** pair requested. A partial hit
     * re-asks the whole request, because decomposing an arbitrary set of pairs back into
     * cross products is a different algorithm from the one this package closes.
     *
     * **The order of the returned array is unspecified.** It is a lookup table, not a
     * sequence: read it with `decisionFor`, never by position. The cold path returns pairs in
     * the order the responses arrived and the warm path in the order they were requested, so
     * the same request can answer in two different orders depending only on whether it was
     * cached.
     */
    async decide(request) {
      const contextId = activeContextId;
      if (contextId === undefined) {
        return [];
      }
      // The package advertises that a context without access to this app is not asked about.
      // That invariant has to hold for BOTH questions, not just the menu: `activeContextId`
      // is set before `activate` branches, so without this the decision point is asked for a
      // context we already know does not open the app.
      if (state.status === "NO_ACCESS_IN_APP") {
        return [];
      }

      const issuedAt = generation;
      const wanted = pairsOf(request);

      const cached: Decision[] = [];
      let allCached = wanted.length > 0;
      for (const { action, resourceId } of wanted) {
        const hit = decisionCache.get(
          cacheKey(contextId, request.resourceType, action, resourceId),
        );
        if (hit === undefined) {
          allCached = false;
          break;
        }
        cached.push(hit);
      }
      if (allCached) {
        return cached;
      }

      const chunks = splitDecisionRequest(request, maxPairsPerRequest);
      const settled = await Promise.allSettled(
        chunks.map((c) => transport.fetchDecisions(app, contextId, c)),
      );

      // The context changed while the answers were in flight: they belong to a context the
      // session is no longer in. Not merged, not cached, not returned.
      if (issuedAt !== generation) {
        return [];
      }

      // What was actually asked for. A decision outside this set was not requested, and
      // merging it would return a verdict nobody asked about — and then serve it as a cache
      // hit to the later genuine query, which is how an unrequested PERMIT becomes durable.
      const requested = new Set(
        wanted.map(({ action, resourceId }) => pairKey(action, resourceId)),
      );

      // AT MOST ONE ENTRY PER PAIR, collapsed here, before anything is returned or cached.
      //
      // A pair can arrive twice — in one response, or once from each of two chunks — and an
      // engine that returns one row per matching policy rather than one row per pair produces
      // duplicates by construction, so they are legitimate and discarding the answer would
      // break a correct consumer. What is not legitimate is disagreeing with ourselves: while
      // the array could hold two entries for one pair, `decisionFor` read the FIRST and the
      // cache kept the LAST, so a contradictory duplicate answered DENY once and PERMIT from
      // cache forever after. Collapsing removes the possibility rather than patching one
      // reader of it.
      const byPair = new Map<string, Decision>();
      for (const result of settled) {
        if (result.status !== "fulfilled") {
          continue;
        }
        const answer = result.value;
        // A response labelled with another context or another app is discarded WHOLE: not
        // merged, not cached. The port declares these fields; reading them is the point of
        // having declared them.
        if (answer.contextId !== contextId || answer.app !== app) {
          continue;
        }
        for (const decision of answer.decisions) {
          const pair = pairKey(decision.action, decision.resourceId);
          if (!requested.has(pair)) {
            continue;
          }
          const seen = byPair.get(pair);
          byPair.set(pair, seen === undefined ? decision : mostRestrictive(seen, decision));
        }
      }

      // The cache stores exactly what is returned, from the same collapsed map, so the two
      // can never disagree again.
      const merged: Decision[] = [];
      for (const decision of byPair.values()) {
        merged.push(decision);
        cacheDecision(
          cacheKey(contextId, request.resourceType, decision.action, decision.resourceId),
          decision,
        );
      }
      // Discarding is silent and fail-closed: the pairs simply stay absent, and absent is
      // DENY through `decisionFor`. There is no channel to report this on, and inventing one
      // is not part of this round.
      return merged;
    },
  };
}

/**
 * The cache key, with the context **inside** it.
 *
 * Keeping the context beside the cache instead of in the key is how a menu from one context
 * gets served to another: the lookup succeeds because the pair matches, and nothing in the
 * key says which context it was computed under. Selecting a context also clears the cache
 * outright — the key protects reads, the clear protects memory, and neither substitutes for
 * the other.
 *
 * **The encoding is injective, and that is a property of the encoding rather than of the
 * values.** Every part is emitted length-first (see {@link joinParts}), so no two distinct
 * tuples can produce the same key whatever characters the identifiers contain. The previous
 * version joined with `U+0000` and asserted that the character "cannot appear in an
 * identifier" — that was an assumption about the consumer's data, not a guarantee, and an id
 * carrying the separator could forge another pair's key: satisfy the requested-pair check, be
 * returned, be cached, and then be served as a durable `PERMIT`.
 */
function cacheKey(
  contextId: string,
  resourceType: string,
  action: string,
  resourceId: string,
): string {
  return joinParts(contextId, resourceType, action, resourceId);
}

/** The requested-pair key. Same encoding, same reason. */
function pairKey(action: string, resourceId: string): string {
  return joinParts(action, resourceId);
}

/**
 * Length-prefixed join: `<len>:<value>` per part.
 *
 * A separator alone only works while no value contains it, which is a promise about someone
 * else's identifiers. With the length written first, the reader of the key knows exactly how
 * many characters each part occupies before it looks at them, so a value that happens to
 * contain `:` or a digit changes nothing.
 */
function joinParts(...parts: readonly string[]): string {
  return parts.map((part) => `${part.length}:${part}`).join("");
}

/**
 * Deny-overrides, the same floor the decision engine itself applies: `DENY` beats
 * `CONDITIONAL` beats `PERMIT`.
 *
 * Fail-closed and still functional — a duplicate never widens what the subject may do, and a
 * legitimate one (an engine emitting a row per policy) still resolves to an answer.
 */
function mostRestrictive(a: Decision, b: Decision): Decision {
  // Only PERMIT ranks as permissive. Everything else — the two declared restrictive effects
  // AND anything outside the union that reached us at runtime — ranks above it. The previous
  // form defaulted the unknown to 0, so an effect this function does not understand was as
  // safe as PERMIT and could never restrict one arriving beside it. A collapse function in an
  // authorization package must not resolve "I do not know what this is" permissively.
  const rank = (effect: Decision["effect"]): number =>
    effect === "PERMIT" ? 0 : effect === "CONDITIONAL" ? 1 : 2;
  return rank(b.effect) > rank(a.effect) ? b : a;
}

function pairsOf(
  request: DecisionRequest,
): readonly { readonly action: string; readonly resourceId: string }[] {
  const out: { action: string; resourceId: string }[] = [];
  for (const action of request.actions) {
    for (const resourceId of request.resourceIds) {
      out.push({ action, resourceId });
    }
  }
  return out;
}
