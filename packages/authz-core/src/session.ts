/**
 * What a subject may do in one application, as a state machine.
 *
 * **This package answers one question and has no notion of an authorization context.** The
 * decision point the backend consults does not know what a context is either — the backend
 * resolves one into subject attributes and pushes those — so resolving a context and evaluating
 * permissions are separate responsibilities, and fusing them here would fuse what the rest of the
 * system deliberately keeps apart. A consumer with no context concept at all implements the
 * two-method port and needs nothing else.
 */

import {
  isRecord,
  mostRestrictive,
  namesAction,
  namesPair,
  type Decision,
  type PermissionEntry,
} from "./decision.js";
import { splitDecisionRequest } from "./batch.js";
import {
  AuthorizationTransportError,
  type AuthorizationTransport,
  type DecisionRequest,
} from "./transport.js";

/**
 * Where the session is.
 *
 * Two of these are screens a consumer must render differently, and collapsing them is the
 * mistake this type prevents:
 *
 * - `NO_ACCESS_IN_APP` — the decision point was reached and said this subject may not enter this
 *   application. **Not the same as a `READY` with an empty menu**, which says "you may enter and
 *   may do nothing". Two different screens.
 * - `UNAVAILABLE` — no answer was obtained. **This is not an expired session and nothing here
 *   suggests re-authenticating.** Sending someone to sign in again because a decision point was
 *   unreachable teaches them that signing in fixes outages, and it does not.
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
  | { readonly status: "NO_ACCESS_IN_APP" }
  /**
   * The menu arrived and is in use: `permissions` holds what it names.
   *
   * **`READY` with an empty `permissions` means exactly one thing: "you may enter and may do
   * nothing".** The decision point answered, and its answer was an empty menu. It never means
   * "the answer was unusable" — that is `UNAVAILABLE`, below — so the two can be rendered
   * differently:
   *
   * ```
   * permissions: []                                                -> READY, empty menu
   * permissions: [10 entries, none of which names its action]      -> UNAVAILABLE
   * permissions: [3 that name their action, 7 read that name none] -> READY, with those 3
   * ```
   *
   * An entry names its action when its `action`, read, is a string. `permissions` holds one entry for
   * each action the menu names, and nothing else. Two entries for the same action collapse to the
   * most restrictive — `DENY` over `CONDITIONAL` over `PERMIT` — and on a tie the FIRST one is kept
   * whole, `dependsOn` included. **The identity of an entry is its `action` alone**: fields the
   * type does not declare do not keep two entries apart, so a backend that answers per resource type
   * has to fold the type into the action to keep them distinct.
   */
  | {
      readonly status: "READY";
      readonly permissions: readonly PermissionEntry[];
    }
  /**
   * Something went wrong and this session cannot answer: the menu could not be fetched, it was not a
   * menu, it was labelled with another application, it arrived with entries and none of them names
   * its action, or one of its entries could not be read at all — reading its `action`, its keys, a
   * key's descriptor or its prototype threw, or reading the list at its position did, or the entry is
   * a function, or the list gained it while it was being read. Such an entry may be the `DENY` for an
   * action another entry permits, so the menu is not used. **No `reason`, on
   * purpose:** the
   * text would come from the consumer's own transport, which got it from a server, and this
   * package has no way to know what is safe to carry in someone else's error string — it
   * would be one `render` away from a screen, unbounded and unlabelled. Which rule put the session
   * here reaches `onDiagnostic`, when one is given, as a reason this package names, and never as
   * that text.
   */
  | { readonly status: "UNAVAILABLE" };

/**
 * What a session tells {@link AuthorizationSessionOptions.onDiagnostic}: why something did not happen,
 * and when an answer came from the cache instead of the transport.
 *
 * **Data, not a message.** Every event is a new frozen object with a `kind` and the fields its kind
 * declares, and every field holds a value this package built: a reason or an operation named here, a
 * count, a flag, or the `resourceType` of the request the call was made with. None holds a token, a
 * header, an error, or anything read out of an answer.
 */
export type AuthorizationDiagnostic =
  /**
   * `start()` asked the transport for the menu. `restart` is `false` for the first `start()` of a
   * session and `true` for every later one, so a screen that raises this more than once with
   * `restart: false` built more than one session. A context session builds one on every activation of a context
   * with access, and its `session-built` counts them: each accounts for at most one `restart: false`.
   */
  | { readonly kind: "menu-requested"; readonly restart: boolean }
  /**
   * `start()` settled on `UNAVAILABLE`, and `reason` says which rule put it there:
   *
   * - `rejected` — asking for the menu threw or rejected, with anything but a `NO_ACCESS_IN_APP` error;
   * - `not-a-menu` — the answer holds no list of entries, or cannot be read as one;
   * - `other-app` — the answer's `app` is not this application;
   * - `unreadable-entry` — an entry cannot be read at all, or the list gained one while it was read;
   * - `no-action-named` — the menu arrived with entries and none of them names its action.
   */
  | {
      readonly kind: "menu-unavailable";
      readonly reason: "rejected" | "not-a-menu" | "other-app" | "unreadable-entry" | "no-action-named";
    }
  /**
   * One chunk of a `decide()` call was refused whole, so the `pairs` it asked for are absent unless
   * another chunk of the call asked for them too. `reason`: `rejected` — asking for it threw or
   * rejected; `no-list` — its answer holds no list; `other-app` — its answer's `app` is not this
   * application.
   */
  | {
      readonly kind: "chunk-failed";
      readonly reason: "rejected" | "no-list" | "other-app";
      readonly resourceType: string;
      readonly pairs: number;
    }
  /**
   * A `decide()` call resolved with the empty list because an answer, or an element of one, could not
   * be read at all. `pairs` is the number of pairs the request asks for.
   */
  | { readonly kind: "call-emptied"; readonly resourceType: string; readonly pairs: number }
  /**
   * An answer arrived after a later `start()` or a `close()` and was not used: the menu of a `start()`,
   * or the answers of a `decide()`, which resolved with the empty list.
   */
  | { readonly kind: "answer-discarded"; readonly operation: "start" | "decide" }
  /**
   * A `decide()` call was answered from the cache, without asking the transport. `pairs` is the number
   * of pairs the request asks for.
   */
  | { readonly kind: "from-cache"; readonly resourceType: string; readonly pairs: number };

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
   * Told why something did not happen, as an {@link AuthorizationDiagnostic}. **Optional**, and nothing
   * the session decides, emits, caches or returns depends on whether it is given.
   *
   * **Called in a task of its own.** Each event is handed to it through `setTimeout`, never from inside
   * a call of this package, and nothing this package does waits for it: what it returns is not read, so
   * a promise it returns is not awaited and its rejection is not caught. Like any code, a callback that
   * blocks the thread blocks everything that runs on it.
   *
   * **What it throws is discarded**, and the session carries on as if it had not been called.
   *
   * It must be a function, or the constructor throws a `RangeError`.
   */
  readonly onDiagnostic?: (event: AuthorizationDiagnostic) => void;
}

/** The session. */
export interface AuthorizationSession {
  /** The current state. Synchronous, always defined. */
  getState(): AuthorizationState;
  /**
   * Observe changes. Returns a function that stops the subscription.
   *
   * **A listener owns its own errors.** If it throws, the throw is caught and discarded: the
   * other listeners still receive the emission, and the call that was publishing — `start()` or
   * `close()` — completes as if nothing had happened. Without that, one consumer's render bug
   * escaped into this package, and during `close()` it was permanent: the listeners were never
   * dropped and the session never closed.
   *
   * **The throw is swallowed and NOT reported anywhere** — not to `onDiagnostic`, not to the console,
   * not in the state: what a listener throws is the consumer's own error, and an event carries only
   * values this package built. So a listener that throws silently loses that emission and nothing
   * tells it. Do your own error handling inside the listener.
   */
  subscribe(listener: (state: AuthorizationState) => void): () => void;
  /** Load the menu and settle into a state. Safe to call again; see the implementation. */
  start(): Promise<void>;
  /**
   * Instance-level decisions for every pair a request asks about. Read the result with
   * `decisionFor`: a pair that is absent is `DENY`.
   *
   * **A request whose identifiers are not strings is refused.** If `resourceType`, an action or a
   * resource id is not a string — a number, a boxed string, `null` — the returned promise rejects with
   * a `RangeError` that names the field and the type it received, never the value, and neither the
   * cache nor the transport is touched.
   *
   * **Whether a request is judged depends on the state.** A session that is `IDLE` — never started,
   * or closed — or `NO_ACCESS_IN_APP` resolves every request with the empty list and does not judge
   * it: it has no answer to give, whatever the request says. `LOADING`, `READY` and `UNAVAILABLE`
   * judge it. So a malformed request passes unnoticed while the subject has no access to the app,
   * and is refused on the first call once they do.
   *
   * **The request is read once, when the call is made.** Changing the object afterwards — reusing it
   * for the next question while this one is in flight — changes nothing about this call. And the
   * decisions returned are the caller's: changing them changes no later answer.
   *
   * Chunks are asked concurrently and fail closed one by one: **a chunk that fails leaves absent the
   * pairs only it asked for, and nothing else; absent is `DENY`, and nothing from it is cached.** A
   * chunk fails when asking for it throws or rejects, when what it resolves to holds no list — it is
   * `null` or `undefined`, or reading its `decisions` gives one of them — or when its `app`, read, is
   * not this application. A pair is answered by a chunk that asked for it — by any of them, when a
   * request that names an identifier twice asks it in more than one — and what another chunk of the
   * same call says about it can make it more restrictive, and cannot answer it. The whole call rejects
   * only for a request that is refused, above, or that throws while it is read — a getter, a revoked
   * `Proxy` — with what it threw, or for a `maxPairsPerRequest` that {@link splitDecisionRequest}
   * refuses. The order of the returned array is unspecified.
   *
   * **An element that names no pair is dropped, and nothing else with it:** `null`, `undefined`, or
   * one whose `action` or `resourceId`, read, is not a string.
   *
   * **An answer, or an element of one, that cannot be read at all leaves every pair of the call
   * absent.** An element that throws when its `action` or `resourceId` is read, when the list is read at
   * its position, or when it is asked for its keys, a key's descriptor or its prototype; an element
   * that is a function; a position the list gained while it was being read; and every element of an
   * answer whose envelope throws when read, that is a function, or whose `decisions` is present, not
   * `null` or `undefined`, and is not an array — a `Set`, a `Map`'s values, an array-like — each may be
   * the `DENY` for a pair another element permits, in its own answer or in another chunk's, so the call
   * resolves with the empty list and nothing is cached.
   *
   * **The cache answers a pair with what the last call that asked for it returned, and with nothing
   * else.** A pair a call leaves absent is absent from the cache too, so the next call that asks for it
   * asks the transport. Of two calls in flight at once that ask for one pair, the last is the one
   * answered last, whichever of the two was made first.
   *
   * **Its price, on a connection that drops requests:** a request is served from the cache only once
   * one call has answered every pair of it, and a call that finds any pair missing asks for the whole
   * request again, every chunk. So a request of many chunks is asked, and shows the pairs of its failed
   * chunks as `DENY`, on every draw until one call completes — with one request in five failing, about
   * one call in nine for ten chunks. Ask for what you draw, and let the transport ask a failed request
   * once more: the package's README has the measured cost of both.
   */
  decide(request: DecisionRequest): Promise<readonly Decision[]>;
  /**
   * Stop listening and make the session inert. Idempotent.
   *
   * **The session stops answering.** It bumps the generation, empties the decision cache, marks
   * itself closed and emits {@link AuthorizationState} `IDLE` — and only then drops the
   * listeners. Afterwards `decide()` returns the empty list, so absent is `DENY` through
   * `decisionFor`; `start()` resolves without calling the transport and without touching state;
   * `subscribe()` registers nothing; and `getState()` is `IDLE`.
   *
   * **It cannot cancel a call already in flight** — this package never owned that `fetch`. What
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
  const { app, transport, maxPairsPerRequest, maxCachedDecisions = 5000, onDiagnostic } = options;

  if (!Number.isInteger(maxCachedDecisions) || maxCachedDecisions < 1) {
    throw new RangeError(
      `maxCachedDecisions must be an integer greater than or equal to 1, received ${String(
        maxCachedDecisions,
      )}`,
    );
  }
  const notify = notifier(onDiagnostic);

  let state: AuthorizationState = { status: "IDLE" };

  /**
   * THE SUPERSESSION PROTOCOL OF THIS FILE, stated as a rule rather than as a note on one line.
   *
   * **Every `await` that can be superseded is followed by a generation re-check before any
   * observable action. A suspension point followed by nothing needs none.** "Observable" means
   * emitting a state, writing the cache, or returning a value a caller will act on.
   *
   * The rule is stated as a shape because describing the symptom instead is how one instance
   * stayed missing for a long time. The table below is the inventory, and a new `await` in this
   * file is a new row in it.
   *
   *   suspension point                         superseded by            re-check
   *   ---------------------------------------  -----------------------  -----------------------
   *   start: await transport.fetchPermissions   a later start, close()   yes, on BOTH the
   *                                                                      resolved and the
   *                                                                      rejected path
   *   decide: await Promise.allSettled(...)     a later start, close()   yes, before merging,
   *                                                                      caching or returning
   *
   * Two supersessions remain in a package with no contexts, and neither is hypothetical:
   * **two overlapping `start()` calls**, and **`close()` landing during a `start()` in flight.**
   *
   * A counter and not a timestamp: two calls within the same clock tick are indistinguishable by
   * time, and a clock that steps backwards makes the comparison lie.
   */
  let generation = 0;

  const listeners = new Set<(state: AuthorizationState) => void>();

  /** `resourceType` + `action` + `resourceId` -> the decision. */
  const decisionCache = new Map<string, Decision>();

  /** Set by {@link close}. */
  let closed = false;

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
   * **A subscribed listener may not take the session down.** A render bug in one component must
   * not deny the notification to every other subscriber, and during `close()` it must not leave
   * the session unclosable: an escaping throw there skipped the listener drop and the `closed`
   * flag, so every later `close()` threw again and the session could never be closed at all.
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

  return {
    getState() {
      return state;
    },

    subscribe(listener) {
      if (closed) {
        // Registers nothing, and the returned function is still safe to call.
        //
        // A listener that subscribes while the final `IDLE` of `close()` is being delivered — from
        // inside another listener — lands here, because the flag is already set: without this branch
        // it would join the set being walked and receive that `IDLE`. A listener registered after
        // `close()` has returned would never be called either way. What the branch also bounds: a
        // consumer that keeps subscribing to a session it forgot to drop would otherwise accumulate
        // one entry per call, forever.
        return () => {};
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    /**
     * Load the menu and settle into a state.
     *
     * **`start()` is a re-initialisation and behaves like one.** A second call bumps the
     * generation, so the first one returns without touching state when it resolves late. Without
     * that, a slow first call repainted over the second one's result.
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

      // LOAD-BEARING, and it did not use to be. Until this package lost its context concept the
      // active context was dropped here too, which made `decide` return before it ever read the
      // cache — so clearing was defence in depth. With no context to drop, THIS LINE IS THE ONLY
      // THING that invalidates the cache across a re-start: without it, a decision cached before
      // `start()` is served after it, from a menu that has just been reloaded. It is not in the
      // family on `close()`.
      decisionCache.clear();
      setState({ status: "LOADING" });
      notify?.({ kind: "menu-requested", restart: issuedAt > 1 });

      let menu;
      try {
        menu = await transport.fetchPermissions(app);
      } catch (error) {
        if (issuedAt !== generation) {
          notify?.({ kind: "answer-discarded", operation: "start" });
          return;
        }
        // A failed fetch is never `READY` with an empty list: an empty menu is
        // indistinguishable from "you legitimately may do nothing", and the consumer would
        // render an empty screen instead of saying what happened.
        if (kindOf(error) === "NO_ACCESS_IN_APP") {
          setState({ status: "NO_ACCESS_IN_APP" });
        } else {
          setState({ status: "UNAVAILABLE" });
          notify?.({ kind: "menu-unavailable", reason: "rejected" });
        }
        return;
      }

      if (issuedAt !== generation) {
        notify?.({ kind: "answer-discarded", operation: "start" });
        return;
      }
      // A menu labelled with another application is a broken answer. Rendering it under the
      // requested label is exactly the confusion this state type exists to prevent, so it is
      // not `READY` with someone else's permissions — it is `UNAVAILABLE`.
      //
      // So is an answer that is not a menu at all. Reading `app` from `null` used to throw out of
      // `start()` and leave the state at `LOADING` for good.
      //
      // THE ENVELOPE IS READ ONCE, like every value that arrives from outside: `received` holds the
      // one read of its list, and the length and the entries below are that read. Read three times,
      // a list that answered differently each time was checked as one list and judged as another.
      const received = envelopeOf(menu, "permissions");
      if (received === undefined || received === UNREADABLE || received.app !== app) {
        setState({ status: "UNAVAILABLE" });
        notify?.({
          kind: "menu-unavailable",
          reason: received === undefined || received === UNREADABLE ? "not-a-menu" : "other-app",
        });
        return;
      }
      // An entry that does not name its action is discarded, as `decide` discards an element that
      // does not name its pair. No lookup could match it; a consumer iterating the menu would
      // throw on it.
      //
      // AT MOST ONE ENTRY PER ACTION, collapsed the way `decide` collapses a pair. A menu that
      // listed an action twice used to answer with whichever entry came first, so PERMIT then DENY
      // rendered and DENY then PERMIT did not.
      //
      // COPIED WHERE IT IS JUDGED, like a decision: the state holds the copy, never the object the
      // transport returned. A transport that reused that object for a later answer would otherwise
      // turn a DENY on screen into a PERMIT, with no emission to say so.
      //
      // AN ENTRY THAT CANNOT BE READ AT ALL IS NOT DISCARDED: it may be the DENY for an action another
      // entry permits, and dropped, that PERMIT would be painted. The menu is not used. See `copied`.
      const byAction = new Map<string, PermissionEntry>();
      for (const element of received.list) {
        const entry = copied(element as PermissionEntry, ENTRY_FIELDS, ENTRY_IDENTITY);
        if (entry === UNREADABLE) {
          setState({ status: "UNAVAILABLE" });
          notify?.({ kind: "menu-unavailable", reason: "unreadable-entry" });
          return;
        }
        if (!namesAction(entry)) {
          continue;
        }
        const seen = byAction.get(entry.action);
        byAction.set(entry.action, seen === undefined ? entry : mostRestrictive(seen, entry));
      }
      // A position the list gained while its entries were read was never read. Same rule.
      if (received.grew()) {
        setState({ status: "UNAVAILABLE" });
        notify?.({ kind: "menu-unavailable", reason: "unreadable-entry" });
        return;
      }
      // A MENU THAT ARRIVED WITH ENTRIES AND KEPT NONE IS NOT AN EMPTY MENU. An empty menu is a
      // legitimate answer — "you may enter and may do nothing" — and it has to keep meaning only
      // that. If it could also mean "the backend sent nothing usable", the two situations a
      // consumer most needs to tell apart would become the same screen. So `permissions: []` stays
      // `READY`, and a non-empty menu none of whose entries names its action is `UNAVAILABLE`.
      if (received.list.length > 0 && byAction.size === 0) {
        setState({ status: "UNAVAILABLE" });
        notify?.({ kind: "menu-unavailable", reason: "no-action-named" });
        return;
      }
      setState({ status: "READY", permissions: [...byAction.values()] });
    },

    close() {
      if (closed) {
        return;
      }
      // Idempotence is stated by that guard rather than emerging from the steps below.
      //
      // THE DELIBERATELY-REDUNDANT FAMILY OF THIS FILE. Each member is defence in depth: removing
      // it changes nothing a consumer can see today, because something else already guarantees the
      // same outcome — and each entry says what that something is. They are kept because that other
      // guarantee is one change away from going.
      //
      // WHAT THIS LIST DOES **NOT** SAY: that everything absent from it is load-bearing. Absence
      // from it means "not known to be redundant", and it does not mean "covered".
      //
      // The family is TWO:
      //
      //   1. `decisionCache.clear()` in this method — after `close()` the state is `IDLE`, and
      //      `decide` returns the empty list before it ever reads the cache
      //   2. `listeners.clear()` in this method — after `close()` nothing emits again: `start()`
      //      returns before its first emission, and nothing else publishes a state
      //
      // The `closed` branch in `subscribe` IS NOT ONE OF THEM, because a consumer can see it. Without
      // it, a listener that subscribes while the final `IDLE` is being delivered — from inside another
      // listener — joins the set being walked and receives that `IDLE`; with it, it receives nothing.
      // A listener registered after `close()` has returned is never called either way.
      //
      // `wanted.length > 0` in the cache short-circuit of `decide` IS NOT ONE OF THEM, because a
      // consumer can see it. With it, an empty request leaves the flag false and goes on to the
      // splitter, which returns no chunks under a usable pair cap — the empty list, and no transport
      // call — and refuses an unusable one with a `RangeError`, as it refuses a request that asks for
      // a pair. Without it the flag stays true and the empty list is returned before the splitter
      // sees the cap: a session built with a cap of `0`, `1.5` or none would resolve an empty
      // request and reject every other one.
      //
      // AND THIS GUARD IS NOT ONE OF THEM. Without it, a listener that re-enters `close()` from the
      // final `IDLE` runs the whole method again from inside its own emission, and again from that
      // one, until the stack runs out. Idempotence is behaviour here, not a promise held by
      // accident.
      //
      // `decisionCache.clear()` in `start()` left this family too, and for a reason worth knowing:
      // it was redundant only because dropping the active context made `decide` return before it
      // ever read the cache. With no context to drop, that other gate is gone and the clear is now
      // the only thing invalidating the cache across a re-start.
      //
      // ORDER MATTERS, and two steps of it are the whole point.
      //
      // 1-2 make the session stop answering: the generation bump condemns anything in flight and
      // the cache is emptied, so `decide` returns [] and absent is DENY through `decisionFor`.
      generation += 1;
      decisionCache.clear();

      // THE FLAG GOES HERE, BEFORE THE EMISSION, AND ITS POSITION IS LOAD-BEARING.
      //
      // Set after the emission instead, `closed` is still false while the final `IDLE` is being
      // delivered, so a listener that re-enters `start()` is served BY A SESSION THAT IS CLOSING
      // — and served correctly, because `close()` bumps the generation before the emission and
      // nothing bumps it after, so the re-entrant call's own bump makes it the newest generation
      // and every re-check waves it through. Measured, that left a CLOSED session `READY` with a
      // permission menu, the transport called after `close()`, and `decide()` answering `PERMIT`;
      // and with a listener that re-entered `close()` itself, 2205 frames of recursion ending in
      // a `RangeError`.
      //
      // It does not disturb the ordering below: the emission still comes first.
      closed = true;

      // EMISSION BEFORE THE LISTENER DROP, and that is the second load-bearing order. Dropping
      // the listeners first would mean nobody hears the transition, and THE PREVIOUS SUBJECT'S
      // MENU STAYS PAINTED — which is the leak this exists to close. A framework binding needs
      // this one last emission in order to re-render empty.
      //
      // Why it matters: a different person signs in on the same browser and the token store is
      // shared across tabs, so the next refresh hands this tab a token for another subject. The
      // backend refuses that tab's requests — no data crosses — but the menu already painted and
      // the decisions already cached belong to the previous person. The new person does not see
      // their records; they see their SILHOUETTE: which sections existed, which actions were
      // available, whether that person was an administrator. In a package where the menu IS the
      // permission, the silhouette says plenty.
      setState({ status: "IDLE" });

      // Family member 2. What it buys is a bound: a session a consumer forgot to drop would
      // otherwise hold every listener, and through them every closure, alive for as long as the
      // session itself is held. A consumer can see it only as memory that is never released.
      listeners.clear();
    },

    /**
     * Instance-level decisions.
     *
     * The request is split by {@link splitDecisionRequest} and every chunk is asked
     * **concurrently**. Chunks are independent and a sequential loop would make the whole
     * call as slow as the sum of its parts for no gain.
     *
     * **Fail-closed per chunk.** A chunk whose asking throws or rejects, whose answer holds no list,
     * or whose answer's `app` is not this application contributes nothing to the merged result,
     * so every pair only it asked for is absent — and absent resolves to `DENY` through `decisionFor`,
     * whatever a chunk that did not ask says about those pairs. It never turns into a permit, and its
     * failing takes nothing else with it. Nothing from a failed chunk is cached either: a transient
     * outage must not leave a denial behind that outlives it. What empties the whole call is an
     * answer, or an element of one, that cannot be read at all: see `copied` and `envelopeOf`.
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
      // A session nobody started, or one that has been closed, answers nothing: every pair
      // resolves to `DENY` through `decisionFor`.
      if (state.status === "IDLE") {
        return [];
      }
      // The package advertises that a subject without access to this app is not asked about.
      // That invariant has to hold for BOTH questions, not just the menu.
      if (state.status === "NO_ACCESS_IN_APP") {
        return [];
      }

      // THE REQUEST IS READ ONCE, HERE, INTO A COPY, AND THE COPY IS BOTH WHAT IS JUDGED AND WHAT IS
      // USED. A request of the wrong shape is refused before the cache is read or the transport is
      // called: it is a consumer's value, and the rule written above `namesPair` refuses those. An
      // identifier that is not a string used to be sent, answered, and then discarded on the way
      // back, so a subject was denied in silence and the backend was asked again on every call.
      //
      // And nothing after this line reads the consumer's object again. It is theirs and it can change
      // while the answers are in flight — one object reused for the next question is enough. Read
      // again after the `await`, the resource type filed one type's answers under another type's
      // cache key, and a later request for that other type was served them from the cache: a PERMIT
      // the backend never gave, without asking it. Read three times on the way in, a resource type
      // that answered differently each time was sent as one type and cached as another, with the
      // same result.
      //
      // Placed after the two states that answer nothing: a session that does not read the request
      // has nothing to judge it on, and a closed session keeps returning the empty list.
      const asked = readRequest(request);

      const issuedAt = generation;
      const wanted = pairsOf(asked);

      // A cached decision is never handed out itself, only a copy of it, made the way every copy in
      // this file is made: what a caller does to the array it receives cannot change what a later
      // call answers.
      const cached: Decision[] = [];
      let allCached = wanted.length > 0;
      for (const { action, resourceId } of wanted) {
        const hit = decisionCache.get(cacheKey(asked.resourceType, action, resourceId));
        if (hit === undefined) {
          allCached = false;
          break;
        }
        cached.push(transparentCopy(hit, DECISION_FIELDS));
      }
      if (allCached) {
        notify?.({ kind: "from-cache", resourceType: asked.resourceType, pairs: wanted.length });
        return cached;
      }

      const chunks = splitDecisionRequest(asked, maxPairsPerRequest);
      // EACH CHUNK IS ASKED INSIDE AN `async` FUNCTION, so whatever asking it does — a transport
      // that throws before returning, a `fetchDecisions` that is not a function, a promise whose
      // `then` or `constructor` throws when it is followed — becomes that chunk's rejection, and
      // only its pairs are left absent.
      //
      // AND EACH IS HANDED A COPY OF ITS CHUNK, never the chunk. What is handed over is the transport's
      // to reach, and the chunks are what this call reads after the answers arrive to know what was
      // asked — and every chunk holds the same `actions`. Handed the chunks themselves, an id a
      // transport added to its request was taken as asked and cached, and a transport that emptied its
      // request once it had sent it emptied the next chunk's too, and left every pair of the call absent.
      const settled = await Promise.allSettled(
        chunks.map(async (c) =>
          transport.fetchDecisions(app, {
            resourceType: c.resourceType,
            actions: [...c.actions],
            resourceIds: [...c.resourceIds],
          }),
        ),
      );

      // A later `start()` or a `close()` landed while the answers were in flight. Not merged,
      // not cached, not returned.
      if (issuedAt !== generation) {
        notify?.({ kind: "answer-discarded", operation: "decide" });
        return [];
      }

      // THE CACHE ANSWERS A PAIR WITH WHAT THE LAST CALL THAT ASKED FOR IT RETURNED, AND WITH NOTHING
      // ELSE. What it held for the pairs of this call is dropped here, before anything is judged, and
      // the merge below writes back what this call returns — so a pair this call leaves absent, on any
      // of the paths below, is absent from the cache too, and the next call that wants it asks the
      // transport. Kept instead, a PERMIT an earlier call cached answered from the cache after this
      // call had received that pair's DENY from a chunk that did not ask for it, and left it absent.
      for (const { action, resourceId } of wanted) {
        decisionCache.delete(cacheKey(asked.resourceType, action, resourceId));
      }

      // What was actually asked for, and WHICH CHUNKS asked for it: one, unless the request names an
      // identifier twice, and then every chunk that asked it is one that asked. A decision outside
      // this set was not requested, and merging it would return a verdict nobody asked about — and
      // then serve it as a cache hit to the later genuine query, which is how an unrequested PERMIT
      // becomes durable.
      const askedBy = new Map<string, Set<number>>();
      chunks.forEach((c, index) => {
        for (const action of c.actions) {
          for (const resourceId of c.resourceIds) {
            const key = pairKey(action, resourceId);
            const askers = askedBy.get(key) ?? new Set<number>();
            askers.add(index);
            askedBy.set(key, askers);
          }
        }
      });

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
      //
      // A PAIR IS ANSWERED BY A CHUNK THAT ASKED FOR IT. What another chunk of the same call says
      // about it can only make it more restrictive, never answer it: had the chunk that asked failed
      // — rejected, answered for another app, or answered something that is not a response — the
      // PERMIT another chunk sent for that pair would otherwise answer alone, and be cached, where
      // the chunk that asked may have carried its DENY. A pair only another chunk answered is left
      // absent, and absent is DENY — in what this call returns, and in the cache, which no longer
      // holds that pair: see above.
      const byPair = new Map<string, Decision>();
      const fromOthers = new Map<string, Decision>();
      const read: Envelope[] = [];
      for (let index = 0; index < settled.length; index += 1) {
        const result = settled[index];
        if (result === undefined || result.status !== "fulfilled") {
          notify?.(chunkFailed("rejected", chunks[index]));
          continue;
        }
        // A response labelled with another app is discarded WHOLE: not merged, not cached. The
        // port declares that field; reading it is the point of having declared it. So is one that
        // holds no list — `null`, `undefined`, or nothing under `decisions`: it used to throw, and one
        // chunk failed the whole call. The envelope is read once, as the menu's is.
        //
        // AN ENVELOPE THAT CANNOT BE READ AS A LIST IS NOT ONE THAT HOLDS NONE. One that throws when
        // read, one that is a function, and one whose `decisions` is present, not `null` or
        // `undefined`, and is not an array — a `Set`, a `Map`'s values, an array-like — is not read as a
        // list, so nothing shows that it holds no DENY for a pair another chunk permits: each leaves
        // every pair of the call absent, as an element that cannot be read does below.
        const answer = envelopeOf(result.value, "decisions");
        if (answer === UNREADABLE) {
          notify?.({ kind: "call-emptied", resourceType: asked.resourceType, pairs: wanted.length });
          return [];
        }
        if (answer === undefined || answer.app !== app) {
          notify?.(chunkFailed(answer === undefined ? "no-list" : "other-app", chunks[index]));
          continue;
        }
        read.push(answer);
        for (const element of answer.list) {
          // EACH ELEMENT IS COPIED WHERE IT IS JUDGED, and the copy is what is collapsed, cached and
          // returned. The transport can still reach the object it returned; had the cache kept that
          // object, a transport that reused it for a later answer would have rewritten a cached
          // decision — and a DENY rewritten to PERMIT is served from the cache without asking.
          const decision = copied(element as Decision, DECISION_FIELDS, DECISION_IDENTITY);
          // AN ELEMENT THAT CANNOT BE READ AT ALL LEAVES EVERY PAIR OF THE CALL ABSENT. It is not
          // discarded: it may be the DENY for a pair another element permits — in this answer, or in
          // another chunk's, since a pair can arrive from either — and dropped, that PERMIT would be
          // returned and cached. Nothing has been cached yet. See `copied`.
          if (decision === UNREADABLE) {
            notify?.({ kind: "call-emptied", resourceType: asked.resourceType, pairs: wanted.length });
            return [];
          }
          // An element that does not name its pair is discarded, like a pair nobody asked for,
          // and the elements beside it are not. It used to throw while its key was built, and
          // the call rejected with every well-formed answer in it.
          if (!namesPair(decision)) {
            continue;
          }
          const pair = pairKey(decision.action, decision.resourceId);
          const askers = askedBy.get(pair);
          if (askers === undefined) {
            continue;
          }
          const into = askers.has(index) ? byPair : fromOthers;
          const seen = into.get(pair);
          into.set(pair, seen === undefined ? decision : mostRestrictive(seen, decision));
        }
      }
      // A position a list gained while the answers were read was never read, and it may be the DENY
      // for any pair. Asked once every element has been judged, since reading an element can be what
      // makes a list grow — its own or another answer's. Nothing has been cached yet.
      if (read.some((answer) => answer.grew())) {
        notify?.({ kind: "call-emptied", resourceType: asked.resourceType, pairs: wanted.length });
        return [];
      }

      // The cache stores what is returned, from the same collapsed map, so the two can never
      // disagree again — and what is returned is a copy of what is stored, so a caller that writes
      // into its array changes nothing the cache will answer later.
      const merged: Decision[] = [];
      for (const [pair, answered] of byPair) {
        const other = fromOthers.get(pair);
        const decision = other === undefined ? answered : mostRestrictive(answered, other);
        merged.push(transparentCopy(decision, DECISION_FIELDS));
        cacheDecision(
          cacheKey(asked.resourceType, decision.action, decision.resourceId),
          decision,
        );
      }
      // Discarding is silent and fail-closed: the pairs simply stay absent, and absent is
      // DENY through `decisionFor`.
      return merged;
    },
  };
}

/**
 * The cache key.
 *
 * **The encoding is injective, and that is a property of the encoding rather than of the
 * values.** Every part is emitted length-first (see {@link joinParts}), so no two distinct
 * tuples can produce the same key whatever characters the identifiers contain. The previous
 * version joined with `U+0000` and asserted that the character "cannot appear in an
 * identifier" — that was an assumption about the consumer's data, not a guarantee, and an id
 * carrying the separator could forge another pair's key: satisfy the requested-pair check, be
 * returned, be cached, and then be served as a durable `PERMIT`.
 */
function cacheKey(resourceType: string, action: string, resourceId: string): string {
  return joinParts(resourceType, action, resourceId);
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
 * Reads a request once, into a copy, and refuses it if an identifier is not a string, naming the
 * first field that is wrong.
 *
 * **Every field and every element is read exactly once**, and the copy returned is made of those
 * reads — so what `decide()` checks and what it caches, splits and sends are the same values. An
 * array is read by index, up to the length it had when it was read; neither its iterator nor any
 * method on it is called.
 *
 * **A `RangeError`**, because that is the class every deliberate refusal of a caller's mistake in
 * these three packages uses — `@ricardoqmd/authz-http` refuses an application id that is not a
 * string with one too — so a consumer catches one class for one kind of mistake, and a `TypeError`
 * keeps meaning what it means everywhere else: something failed that nobody refused on purpose. The
 * message names the field and the TYPE it received, never the value: a resource id can be somebody's
 * data, and this message may end up in a log.
 */
function readRequest(request: unknown): DecisionRequest {
  if (!isRecord(request)) {
    throw new RangeError(`decide(): the request must be an object, received ${kindName(request)}`);
  }
  const resourceType = request.resourceType;
  if (typeof resourceType !== "string") {
    throw new RangeError(
      `decide(): resourceType must be a string, received ${kindName(resourceType)}`,
    );
  }
  const actions = readIdentifiers(request, "actions");
  const resourceIds = readIdentifiers(request, "resourceIds");
  return { resourceType, actions, resourceIds };
}

/** One identifier array of a request, read once by index into a copy. See {@link readRequest}. */
function readIdentifiers(
  request: Record<string, unknown>,
  field: "actions" | "resourceIds",
): readonly string[] {
  const values = request[field];
  if (!Array.isArray(values)) {
    throw new RangeError(`decide(): ${field} must be an array, received ${kindName(values)}`);
  }
  const length = values.length;
  const copy: string[] = [];
  for (let i = 0; i < length; i += 1) {
    const value: unknown = values[i];
    if (typeof value !== "string") {
      throw new RangeError(`decide(): ${field}[${i}] must be a string, received ${kindName(value)}`);
    }
    copy.push(value);
  }
  return copy;
}

/**
 * The fields a {@link Decision} declares, taken from a record whose type is the type's own keys: a
 * field the type declares and this record lacks, or a name the type does not declare, does not
 * compile. A field missing from the list would not be read once — it would travel as the element
 * had it, and be read again each time this package looks at it.
 */
const DECISION_FIELD_SET: { readonly [K in keyof Decision]-?: true } = {
  action: true,
  resourceId: true,
  effect: true,
};
const DECISION_FIELDS: readonly string[] = Object.keys(DECISION_FIELD_SET);

/** The fields a {@link PermissionEntry} declares, tied to the type the same way. */
const ENTRY_FIELD_SET: { readonly [K in keyof PermissionEntry]-?: true } = {
  action: true,
  effect: true,
  dependsOn: true,
};
const ENTRY_FIELDS: readonly string[] = Object.keys(ENTRY_FIELD_SET);

/** The fields that say what a {@link Decision} answers: its pair. */
const DECISION_IDENTITY = ["action", "resourceId"] as const satisfies readonly (keyof Decision)[];

/** The field that says what a {@link PermissionEntry} answers: its action. */
const ENTRY_IDENTITY = ["action"] as const satisfies readonly (keyof PermissionEntry)[];

/** What {@link copied} returns for an element that cannot be read at all. */
const UNREADABLE: unique symbol = Symbol("unreadable");

/**
 * A copy of an element a backend returned, taken once, where it is judged — or {@link UNREADABLE}
 * when the element cannot be read at all.
 *
 * **Every value but `null` and `undefined` is read.** A string, a number or a boolean is read as an
 * ordinary read of `value.action` reads it — through the prototype every value of its kind shares —
 * and copied from the object that holds it, so the predicate judges what that read gave, as it does
 * for an object. `null` and `undefined` hold no field and have no prototype: nothing can be read from
 * them, and they are returned as they are, for the predicate to discard.
 *
 * "Cannot be read at all" means that asking for its prototype, its keys or a key's descriptor threw —
 * which an ordinary object never does and a revoked `Proxy` does — or that reading a field that says
 * what it answers threw: its `action`, and a decision's `resourceId`. A function counts too: it can
 * carry every field the type declares, and it is not data.
 *
 * **Such an element is not discarded.** Discarding is safe for an element that names no pair,
 * because nothing it says can be about a pair that was asked. One that cannot be read may name any
 * of them, and it may be a `DENY`: dropped, a `PERMIT` for the same pair beside it would answer
 * alone. So a menu holding one is `UNAVAILABLE`, and an answer holding one leaves every pair of its
 * call absent.
 */
function copied<T>(
  element: T,
  declared: readonly string[],
  identity: readonly string[],
): T | typeof UNREADABLE {
  // A position whose read threw arrives already marked: see `envelopeOf`.
  if (element === UNREADABLE) {
    return UNREADABLE;
  }
  if (element === null || element === undefined) {
    return element;
  }
  if (typeof element === "function") {
    return UNREADABLE;
  }
  const threw: string[] = [];
  let copy: T;
  try {
    // `Object(element)` is the element itself when it is an object, and the object that holds it when
    // it is a string, a number or a boolean: the one an ordinary read of its fields goes through.
    copy = transparentCopy(Object(element) as T & object, declared, threw);
  } catch {
    return UNREADABLE;
  }
  return identity.some((key) => threw.includes(key)) ? UNREADABLE : copy;
}

/**
 * A copy of what a transport returned: the fields this package judges are read once and held as the
 * copy's own data, and the rest of the element's own properties are carried without being read.
 *
 * - **It has the element's prototype.** What an object keeps outside its own properties — private
 *   fields, state held elsewhere for that instance — is not on the copy: a method or an accessor of
 *   that prototype that reads such state does not find it there.
 * - **Every own property the published type does not declare is copied by its descriptor** — string
 *   keys and symbol keys, enumerable or not — so an accessor is carried across without being called.
 *   One that throws when read throws for whoever reads it, and takes nothing down while the copy is
 *   made.
 * - **Every field the type declares is read once and defined on the copy as data**, with an ordinary
 *   read — what `element.effect` gives, through its accessor if it has one, and not what its
 *   descriptor says — and also when the element lacks it — then as `undefined`. A declared field
 *   that throws when read is `undefined` on the copy. So the fields this package judges are the copy's
 *   own, and nothing reached through the prototype can answer for one of them after the copy is made.
 *   A declared field the element does not hold as its own is not enumerable on the copy, so
 *   `Object.keys` and `JSON.stringify` see what they saw on the element.
 * - **The copy is as frozen, as sealed and as extensible as the element.**
 * - **Nothing is assigned: every property is DEFINED.** A JSON body parsed by `response.json()` can
 *   carry a field named `__proto__`, and on the parsed element it is a field like any other. Assigned,
 *   that key sets the copy's prototype instead, and what the field holds answers through the copy: an
 *   entry that names no action read as a `PERMIT` for the action inside it. Defined, it stays a field.
 *
 * The element's own code that runs while it is copied is the read of each declared field, once — its
 * accessor, or a `Proxy`'s `get` — and the other traps of a `Proxy`. Identity is not kept: the copy
 * is a new object every time.
 *
 * Copying a copy runs none of the element's code, because a copy holds its declared fields as data.
 */
function transparentCopy<T extends object>(
  source: T,
  declared: readonly string[],
  threw?: string[],
): T {
  const copy: object = Object.create(Reflect.getPrototypeOf(source));
  for (const key of Reflect.ownKeys(source)) {
    const descriptor = Reflect.getOwnPropertyDescriptor(source, key);
    if (descriptor === undefined) {
      continue;
    }
    if (typeof key === "string" && declared.includes(key)) {
      // A DECLARED FIELD IS WHAT READING IT GIVES, whatever its descriptor says. For an ordinary
      // object the two are the same value; a `Proxy` can answer its descriptor with one value — or
      // with none, `{ enumerable: true, configurable: true }` — and a read with another, and the
      // read is what the element says. Taken from the descriptor, a DENY whose `action`,
      // `resourceId` and `effect` read as a pair and `DENY` was judged as an element naming no pair
      // and dropped, and the PERMIT beside it for that pair answered alone.
      const value = readOnce(source, key, threw);
      Object.defineProperty(
        copy,
        key,
        "value" in descriptor
          ? { ...descriptor, value }
          : { value, enumerable: descriptor.enumerable === true, writable: true, configurable: true },
      );
    } else {
      Object.defineProperty(copy, key, descriptor);
    }
  }
  for (const key of declared) {
    if (!Object.prototype.hasOwnProperty.call(copy, key)) {
      Object.defineProperty(copy, key, {
        value: readOnce(source, key, threw),
        enumerable: false,
        writable: true,
        configurable: true,
      });
    }
  }
  // An extensible object is neither sealed nor frozen, so the two checks run only when it is not.
  if (!Object.isExtensible(source)) {
    if (Object.isFrozen(source)) {
      Object.freeze(copy);
    } else if (Object.isSealed(source)) {
      Object.seal(copy);
    } else {
      Object.preventExtensions(copy);
    }
  }
  return copy as T;
}

/** One read of a field, or `undefined` if reading it throws — and then its key is added to `threw`. */
function readOnce(source: object, key: string, threw?: string[]): unknown {
  try {
    return (source as Record<string, unknown>)[key];
  } catch {
    threw?.push(key);
    return undefined;
  }
}

/** The envelope of an answer, read once. See {@link envelopeOf}. */
interface Envelope {
  readonly app: unknown;
  readonly list: readonly unknown[];
  /**
   * Whether the list holds more positions now than when it was read, or can no longer say how many
   * it holds. Asked once everything in the answer has been judged: a position the list gained while
   * it was being read was never read, so it is not known to name no pair.
   */
  grew(): boolean;
}

/**
 * The envelope of an answer, read once: its `app`, and its list read once by index into an array —
 * or `undefined` when the answer holds no list, and {@link UNREADABLE} when what it holds cannot be
 * read as one.
 *
 * **An answer holds no list when reading its `field` gives `null` or `undefined`**, or when it is
 * `null` or `undefined` itself: nothing is there to hold an element. Every other answer that is not a
 * function is read with an ordinary read, whatever it is, as {@link copied} reads an element; a
 * function is not data, and nothing is read from it here. **A list is read only when it
 * is an array.** Anything else under `field` that is present, not `null` or `undefined` — a `Set`, a
 * `Map`'s values, an array-like, a string — is not read as a list, so what it holds, if anything, is
 * never read, and an answer that is a function is not data: each is {@link UNREADABLE}, as an answer
 * whose reading throws is, because nothing read shows that it holds no element — and so no `DENY` for
 * a pair another answer permits. See {@link copied} for why that is not the same as absent.
 *
 * The list is read up to the length it had when it was read — the length is asked once more, by
 * `grew`, and only to tell whether the list gained a position — and neither its iterator nor any method
 * on it is called. An element whose read throws is kept as {@link UNREADABLE}: it cannot be read at
 * all.
 */
function envelopeOf(
  answer: unknown,
  field: "permissions" | "decisions",
): Envelope | typeof UNREADABLE | undefined {
  try {
    if (answer === null || answer === undefined) {
      return undefined;
    }
    if (typeof answer === "function") {
      return UNREADABLE;
    }
    const app = (answer as Record<string, unknown>).app;
    const values = (answer as Record<string, unknown>)[field];
    if (values === null || values === undefined) {
      return undefined;
    }
    if (!Array.isArray(values)) {
      return UNREADABLE;
    }
    const length = values.length;
    const list: unknown[] = [];
    for (let i = 0; i < length; i += 1) {
      const threw: string[] = [];
      const element = readOnce(values, String(i), threw);
      list.push(threw.length > 0 ? UNREADABLE : element);
    }
    const grew = (): boolean => {
      try {
        return !(values.length <= length);
      } catch {
        return true;
      }
    };
    return { app, list, grew };
  } catch {
    return UNREADABLE;
  }
}

/** The kind of a value, for a message: never the value itself. */
function kindName(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "an array";
  }
  return typeof value === "object" ? "an object" : typeof value;
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

/**
 * How a session tells `onDiagnostic`, or `undefined` when no callback was given, and then no event is built
 * and nothing is scheduled.
 *
 * The event is handed over in a task of its own, inside a `try`: the callback is the consumer's code,
 * and neither what it throws nor how long it takes belongs to the call that raised the event.
 */
function notifier(onDiagnostic: unknown): ((event: AuthorizationDiagnostic) => void) | undefined {
  if (onDiagnostic === undefined) {
    return undefined;
  }
  if (typeof onDiagnostic !== "function") {
    throw new RangeError(`onDiagnostic must be a function, received ${typeName(onDiagnostic)}`);
  }
  const callback = onDiagnostic as (event: AuthorizationDiagnostic) => void;
  return (event) => {
    const frozen = Object.freeze(event);
    setTimeout(() => {
      try {
        callback(frozen);
      } catch {
        // Discarded. See `onDiagnostic`.
      }
    }, 0);
  };
}

/** The type of a value a caller gave, for a message that must not carry the value itself. */
function typeName(value: unknown): string {
  return value === null ? "null" : Array.isArray(value) ? "an array" : typeof value;
}

function chunkFailed(
  reason: "rejected" | "no-list" | "other-app",
  chunk: DecisionRequest | undefined,
): AuthorizationDiagnostic {
  return {
    kind: "chunk-failed",
    reason,
    resourceType: chunk?.resourceType ?? "",
    pairs: chunk === undefined ? 0 : chunk.actions.length * chunk.resourceIds.length,
  };
}
