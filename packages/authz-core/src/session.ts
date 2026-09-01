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
   * Before `start()` is called. Distinct from `LOADING`, which means a call is in flight:
   * a consumer that renders a spinner for `LOADING` would otherwise show one for a session
   * nobody has started yet.
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

/** The session. Everything on it is bound to the currently selected context. */
export interface AuthorizationSession {
  /** The current state. Synchronous, always defined. */
  getState(): AuthorizationState;
  /** Observe changes. Returns a function that stops the subscription. */
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

  function setState(next: AuthorizationState): void {
    state = next;
    for (const listener of listeners) {
      listener(state);
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
  async function activate(context: AuthorizationContext): Promise<void> {
    generation += 1;
    const issuedAt = generation;

    activeContextId = context.contextId;
    decisionCache.clear();

    if (!context.hasAccess) {
      // The menu is not fetched at all. Asking and inferring "no access" from an empty
      // answer would confuse "this context does not open this app" with "this context
      // opens it and may do nothing", which are different screens.
      setState({ status: "NO_ACCESS_IN_APP", contextId: context.contextId });
      return;
    }

    setState({ status: "LOADING" });

    let menu;
    try {
      menu = await transport.fetchPermissions(app, context.contextId);
    } catch (error) {
      if (issuedAt !== generation) {
        return;
      }
      // A failed fetch is never `READY` with an empty list: an empty menu is
      // indistinguishable from "you legitimately may do nothing", and the consumer would
      // render an empty screen instead of saying what happened.
      if (kindOf(error) === "NO_ACCESS_IN_APP") {
        setState({ status: "NO_ACCESS_IN_APP", contextId: context.contextId });
      } else {
        setState({ status: "UNAVAILABLE" });
      }
      return;
    }

    if (issuedAt !== generation) {
      return;
    }
    // A menu labelled with another context is a broken answer. Rendering it under the
    // requested label is exactly the confusion this state type exists to prevent, so it is
    // not `READY` with someone else's permissions — it is `UNAVAILABLE`.
    if (menu.contextId !== context.contextId || menu.app !== app) {
      setState({ status: "UNAVAILABLE" });
      return;
    }
    setState({
      status: "READY",
      contextId: context.contextId,
      permissions: menu.permissions,
    });
  }

  return {
    getState() {
      return state;
    },

    subscribe(listener) {
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
     * that resolves after a later one has superseded it returns without touching state.
     * Without this, a second `start()` repainted over a live `READY` while `activeContextId`
     * and the cache stayed on the old context.
     */
    async start() {
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
        // subject to confirm something that has no alternative.
        await activate(only);
        return;
      }
      setState({ status: "CHOOSING_CONTEXT", contexts: available });
    },

    async selectContext(contextId) {
      const context = contexts.find((c) => c.contextId === contextId);
      if (context === undefined) {
        throw new RangeError(`unknown contextId: ${contextId}`);
      }
      await activate(context);
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
