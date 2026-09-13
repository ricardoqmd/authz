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

import type { Decision, PermissionEntry } from "./decision.js";
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
  | {
      readonly status: "READY";
      readonly permissions: readonly PermissionEntry[];
    }
  /**
   * Something went wrong and this session cannot answer. **No `reason`, on purpose:** the
   * text would come from the consumer's own transport, which got it from a server, and this
   * package has no way to know what is safe to carry in someone else's error string — it
   * would be one `render` away from a screen, unbounded and unlabelled. Diagnostics belong
   * to the transport, which already holds the original error.
   */
  | { readonly status: "UNAVAILABLE" };

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
   * **The throw is swallowed and NOT reported anywhere** — no callback, no console, no state.
   * This package deliberately has no diagnostic channel: `UNAVAILABLE` carries no `reason` for
   * the same reason, because an error string from someone else's code is one `render` away from
   * a screen. So a listener that throws silently loses that emission and nothing tells it. Do
   * your own error handling inside the listener.
   */
  subscribe(listener: (state: AuthorizationState) => void): () => void;
  /** Load the menu and settle into a state. Safe to call again; see the implementation. */
  start(): Promise<void>;
  /** Instance-level decisions. See the method's own contract. */
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
  const { app, transport, maxPairsPerRequest, maxCachedDecisions = 5000 } = options;

  if (!Number.isInteger(maxCachedDecisions) || maxCachedDecisions < 1) {
    throw new RangeError(
      `maxCachedDecisions must be an integer greater than or equal to 1, received ${String(
        maxCachedDecisions,
      )}`,
    );
  }

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
        // DELIBERATELY REDUNDANT — member 3 of the family listed on `close()`, and measured so:
        // nothing can change the state of a closed session, so a listener registered here would
        // never fire either way, and removing this branch leaves the whole suite green, both ways.
        // What it bounds is real: a consumer that keeps subscribing to a session it forgot to drop
        // would otherwise accumulate one entry per call, forever.
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
      // THING that invalidates the cache across a re-start: neutralise it and "a re-start clears
      // the cache" goes red. Measured, not assumed. It is not in the family on `close()`.
      decisionCache.clear();
      setState({ status: "LOADING" });

      let menu;
      try {
        menu = await transport.fetchPermissions(app);
      } catch (error) {
        if (issuedAt !== generation) {
          return;
        }
        // A failed fetch is never `READY` with an empty list: an empty menu is
        // indistinguishable from "you legitimately may do nothing", and the consumer would
        // render an empty screen instead of saying what happened.
        if (kindOf(error) === "NO_ACCESS_IN_APP") {
          setState({ status: "NO_ACCESS_IN_APP" });
        } else {
          setState({ status: "UNAVAILABLE" });
        }
        return;
      }

      if (issuedAt !== generation) {
        return;
      }
      // A menu labelled with another application is a broken answer. Rendering it under the
      // requested label is exactly the confusion this state type exists to prevent, so it is
      // not `READY` with someone else's permissions — it is `UNAVAILABLE`.
      if (menu.app !== app) {
        setState({ status: "UNAVAILABLE" });
        return;
      }
      setState({ status: "READY", permissions: menu.permissions });
    },

    close() {
      if (closed) {
        return;
      }
      // Idempotence is stated by that guard rather than emerging from the steps below.
      //
      // THE DELIBERATELY-REDUNDANT FAMILY OF THIS FILE, and it is a map rather than a list of
      // labels: EVERY CANDIDATE WAS NEUTRALISED AND THE SUITE RE-RUN, so membership is measured
      // and not asserted. A line that is here is defence in depth — removing it turns nothing red.
      //
      // WHAT THIS LIST DOES **NOT** SAY, and it used to: it is not a claim that everything
      // absent from it is load-bearing and has a test. That sentence was here, it was false, and
      // the instrument that built this very list disproved it — three neutralisations in this file
      // were green and none of them was listed. Two of them were plain gaps and now have tests
      // (`pairsOf` iterating every action; the collapse being stable on a rank tie); the third was
      // genuinely redundant and joins the family below.
      //
      // Absence from this list means "not measured as redundant". It does not mean "covered".
      //
      // The family is FOUR:
      //
      //   1. `decisionCache.clear()` in this method
      //   2. `listeners.clear()` in this method
      //   3. the `closed` branch in `subscribe`
      //   4. `wanted.length > 0` in the cache short-circuit of `decide` — with an empty request
      //      the loop never runs, so the flag stays true and returns the empty array; without it
      //      the request splits into zero chunks and returns the empty array too, with no
      //      transport call on either path
      //
      // AND THIS GUARD IS NOT ONE OF THEM ANY MORE. It was redundant while nothing re-entered
      // `close()`; neutralise it now and "a listener that re-enters close() from the final IDLE
      // does not recurse" goes red with **2298 emissions** before the stack runs out. Idempotence
      // is behaviour here, not a promise held by accident.
      //
      // `decisionCache.clear()` in `start()` left this family too, and for a reason worth knowing:
      // it was redundant only because dropping the active context made `decide` return before it
      // ever read the cache. With no context to drop, that other gate is gone and the clear is now
      // the only thing invalidating the cache across a re-start.
      //
      // No absolute suite count is quoted anywhere in this file, and that is deliberate: a number
      // in a comment goes stale the next time a test is added, and it did, repeatedly. The
      // invariant is "the whole suite, both ways" and it does not rot.
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

      // Family member 3. What it buys is a bound: a consumer that keeps subscribing to a session
      // it never dropped would otherwise hold every listener, and through them every closure,
      // alive for as long as it holds the session. No test can reach that, and inventing one that
      // pretends to would be worse than saying so here.
      listeners.clear();
    },

    /**
     * Instance-level decisions.
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

      const issuedAt = generation;
      const wanted = pairsOf(request);

      const cached: Decision[] = [];
      let allCached = wanted.length > 0;
      for (const { action, resourceId } of wanted) {
        const hit = decisionCache.get(cacheKey(request.resourceType, action, resourceId));
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
        chunks.map((c) => transport.fetchDecisions(app, c)),
      );

      // A later `start()` or a `close()` landed while the answers were in flight. Not merged,
      // not cached, not returned.
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
        // A response labelled with another app is discarded WHOLE: not merged, not cached. The
        // port declares that field; reading it is the point of having declared it.
        if (answer.app !== app) {
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
          cacheKey(request.resourceType, decision.action, decision.resourceId),
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
