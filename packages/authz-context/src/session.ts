/**
 * The authorization context a subject is working under, as a state machine — and one permissions
 * session per context, discarded when the subject switches.
 *
 * `@ricardoqmd/authz-core` answers one question and knows nothing about contexts. This package is
 * the layer above it: it lists the contexts a subject holds, lets one be chosen, and composes a
 * permissions session bound to that context. The two responsibilities stay apart because the
 * decision point the backend consults keeps them apart — it resolves a context into subject
 * attributes and never sees a context itself.
 */

import type {
  AuthorizationSession,
  AuthorizationState,
  Decision,
  DecisionRequest,
} from "@ricardoqmd/authz-core";

import type { AuthorizationContext, ContextTransport } from "./context.js";

/**
 * Where the context session is.
 *
 * Three of these are screens a consumer must render differently, and collapsing any two of them is
 * the mistake this type prevents:
 *
 * - `NO_CONTEXTS` — the subject holds none. Nothing to choose.
 * - `NO_ACCESS_IN_APP` — the context is real and does not open this application.
 * - `UNAVAILABLE` — no usable answer was obtained about the CONTEXT LIST. **This is not an expired session
 *   and nothing here suggests re-authenticating.** Sending someone to sign in again because a
 *   decision point was unreachable teaches them that signing in fixes outages, and it does not.
 *
 * **And `UNAVAILABLE` here is not the permissions session's `UNAVAILABLE`.** This one says "the
 * context list could not be obtained"; that one says "the menu for a context we are already in could
 * not be obtained", and it arrives nested inside {@link ContextSessionState} `IN_CONTEXT`. Two
 * different screens: one offers no context, the other offers a context whose menu failed.
 */
export type ContextSessionState =
  /**
   * Before `start()` is called, **or after `close()`**. Distinct from `LOADING_CONTEXTS`, which
   * means a call is in flight: a consumer that renders a spinner for the latter would otherwise
   * show one for a session nobody has started yet.
   *
   * A closed session lands here on purpose rather than on a new state: the union does not grow a
   * second time, so no consumer's exhaustive `switch` breaks again.
   */
  | { readonly status: "IDLE" }
  | { readonly status: "LOADING_CONTEXTS" }
  | { readonly status: "NO_CONTEXTS" }
  | {
      readonly status: "CHOOSING_CONTEXT";
      readonly contexts: readonly AuthorizationContext[];
    }
  /**
   * The context is real and does not open this application.
   *
   * **It carries the context list, and that is a fix rather than an accident.** In the design this
   * package replaces, that screen carried no list and offered the subject no way out: they landed
   * on it, had nothing to pick from, and reloading restored them straight back into it. This layer
   * holds the list — so it gives it to them.
   */
  | {
      readonly status: "NO_ACCESS_IN_APP";
      readonly contextId: string;
      readonly contexts: readonly AuthorizationContext[];
    }
  /**
   * In a context, with a permissions session running under it.
   *
   * **Nested rather than flattened, deliberately.** Flattening would make this package re-declare
   * every state the core has, so every state the core ever adds would break this package's types.
   * Nested, a consumer asks *which context am I in* and then *what does the permissions session
   * say* — the same question in the same order the architecture asks it.
   */
  | {
      readonly status: "IN_CONTEXT";
      readonly contextId: string;
      readonly permissions: AuthorizationState;
    }
  /**
   * The context list could not be obtained, or what arrived was not a list of contexts: not an array,
   * or an array that arrived with elements and held none that names a context — one whose
   * `contextId`, read, is a string; or a list in which reading an element, its `contextId` or its
   * `hasAccess` throws, one holding an element that is a function, or one that gained an element
   * while it was being read. An empty array is `NO_CONTEXTS`, and an element that names no context is
   * left out, and nothing else with it. **No `reason`, on purpose:** the text would come from
   * the consumer's own transport, which got it from a server, and this package has no way to know
   * what is safe to carry in someone else's error string — it would be one `render` away from a
   * screen, unbounded and unlabelled.
   */
  | { readonly status: "UNAVAILABLE" };

/** What {@link createContextSession} needs to exist. */
export interface ContextSessionOptions {
  /** The application being asked about. Passed to the transport unchanged. */
  readonly app: string;
  readonly contextTransport: ContextTransport;
  /**
   * Builds a permissions session bound to one context. Called **once per activation**.
   *
   * **This is the whole composition, and it is the consumer's half.** The factory closes over the
   * consumer's own transport and binds the context id into it — which is exactly what the HTTP
   * adapter's optional `contextId` + `contextHeader` pair exists for. **This package builds no
   * transport and knows no URL.**
   *
   * A fresh session per activation and not a cached one: see the note on discarding in
   * {@link ContextSession.close}.
   */
  readonly buildSession: (contextId: string) => AuthorizationSession;
}

/** The session. */
export interface ContextSession {
  /** The current state. Synchronous, always defined. */
  getState(): ContextSessionState;
  /**
   * Observe changes. Returns a function that stops the subscription.
   *
   * **A listener owns its own errors.** If it throws, the throw is caught and discarded: the other
   * listeners still receive the emission, and the call that was publishing completes as if nothing
   * had happened. It is **not reported anywhere** — no callback, no console, no state — because
   * this package deliberately has no diagnostic channel, for the same reason `UNAVAILABLE` carries
   * no `reason`.
   *
   * **A LISTENER CAN BE CALLED MORE THAN ONCE FOR THE SAME TRANSITION, WITH AN EQUAL VALUE.**
   * Settling into a context notifies twice: the subscription this package holds on the permissions
   * session repaints when that session publishes, and **the activation** repaints again on its own
   * when `start()` returns. Nothing de-duplicates them. **It is the activation and not the
   * switch**, so a consumer that never calls `selectContext` is not exempt: measured on the
   * single-context path, where `start()` activates with no picker and `selectContext` is never
   * called, the sequence is the same and the last value still arrives twice.
   *
   * Measured against a real permissions session on every settled status — `READY`,
   * `NO_ACCESS_IN_APP` and `UNAVAILABLE` alike — so it is a property of the transition and not of
   * one outcome.
   *
   * **Write listeners that tolerate it.** A render function does; a counter, an analytics event, a
   * one-shot navigation or a non-idempotent store write does not. If you need to suppress the
   * repeat, compare BY VALUE: **every emission is a fresh object**, deliberately — states are plain
   * immutable data and are never mutated in place, so reference equality never signals "unchanged"
   * and a `prev === next` guard suppresses nothing.
   */
  subscribe(listener: (state: ContextSessionState) => void): () => void;
  /** List the contexts and settle into a state. */
  start(): Promise<void>;
  /**
   * Make a context active.
   *
   * A context the list names more than once is entered the most restrictive way it is named: if one
   * of them says it does not open this application, that one is taken.
   *
   * @throws RangeError if the id is not one of the known contexts. That is a programming error —
   *     the ids come from this session — and the state does not change. **A closed session does not
   *     raise it either: inert means inert.**
   */
  selectContext(contextId: string): Promise<void>;
  /**
   * Instance-level decisions from the active context's permissions session.
   *
   * With no active session — no context chosen yet, a context without access to the app, or a closed
   * session — every request resolves with the empty list and is not judged. Otherwise the request goes
   * to that session's `decide()`, and a request whose identifiers are not strings can be refused there:
   * with `@ricardoqmd/authz-core`, a `RangeError` naming the field, unless that session is itself in a
   * state that does not judge it. An answer that arrives after the subject moved to another context is
   * dropped, and the call resolves with the empty list.
   */
  decide(request: DecisionRequest): Promise<readonly Decision[]>;
  /**
   * Close the active permissions session, drop the listeners and make this session inert.
   * Idempotent.
   */
  close(): void;
}

export function createContextSession(options: ContextSessionOptions): ContextSession {
  const { app, contextTransport, buildSession } = options;

  let state: ContextSessionState = { status: "IDLE" };
  /** The contexts the last usable list named, each with what was read of it. See {@link contextsOf}. */
  let contexts: readonly Listed[] = [];
  let activeSession: AuthorizationSession | undefined;
  let unsubscribeFromSession: (() => void) | undefined;

  /**
   * THE SUPERSESSION PROTOCOL OF THIS PACKAGE, and it exists because the core's does not reach
   * here.
   *
   * **The core's `generation` is a per-session closure variable**, and its own inventory says so:
   * *"two supersessions remain in a package with no contexts"*. A layer that builds ONE SESSION PER
   * CONTEXT therefore has N independent counters, **and none of them can see a context change** —
   * that is an event of another object entirely.
   *
   * **The trap, concretely.** A `decide()` issued under `ctx-a` resolves *correctly, for `ctx-a`*.
   * If this layer awaits it and the subject has since moved to `ctx-b`, **this layer paints
   * `ctx-a`'s answers under `ctx-b`'s label.** The session cannot detect it; it does not know what a
   * context is. This is not the core's old defect repeating — it is the same defect one level up,
   * where the core's protocol does not reach.
   *
   * **THE RULE. Every `await` a context change could supersede is followed by a generation re-check
   * before any observable action — emitting, caching, or returning a value a caller will act on. A
   * suspension point followed by nothing needs none.**
   *
   * It is stated as a shape and inventoried, and that is not ceremony: the same defect in the core
   * stayed alive for a long time because every attempt fixed the instance it could see. Adding a
   * re-check wherever a test happens to fail repeats the method that already failed. **A new
   * `await` in this file is a new row in the table.**
   *
   * Three events supersede a call in flight — a second `start()`, a `selectContext()` and a
   * `close()` — and each of them bumps `generation`, so every re-check below answers all three alike.
   * The rejected path of `start` is its own row: it is a separate re-check.
   *
   *   suspension point                       re-check
   *   -------------------------------------  ----------------
   *   start: await listContexts — resolved   before painting
   *   start: await listContexts — rejected   before painting
   *   activate: await session.start()        before emitting
   *   decide: await session.decide(...)      before returning
   *
   * **The file has five `await`s and this table has four rows, and that is the rule holding rather
   * than a row missing.** The two `await activate(...)` calls are each followed by a `return` — one
   * at the end of the single-context branch of `start()`, one at the end of `selectContext()` — so
   * by the rule above they are suspension points followed by nothing. The re-check they are often
   * credited with lives INSIDE `activate`, after `await session.start()`, and that is the third row.
   *
   * **Each row is about the re-check named in its second column, and not about the guard inside the
   * `subscribe` callback below.** That one runs on every emission the built session makes; it is
   * not a suspension point and it is not in this table. The two are easy to confuse — they sit
   * fifteen lines apart and both compare `issuedAt` against `generation`.
   *
   * **What a consumer sees when a re-check is removed**, pair by pair: each suspension point above
   * against each of the three events that supersede it. Always a form of the defect the rule exists
   * to prevent — something from the context the subject left, painted or returned after they left
   * it — and not always the same form. Measured with the real core. The `decide()` column names the
   * context an answer belongs to, because that is what tells the label and the answer apart; the last
   * column is what `selectContext()` then does for a context the server returned, where it was asked:
   *
   *   re-check removed x superseded by    state             label  menu   decide()      selectContext
   *   ----------------------------------  ----------------  -----  -----  ------------  -------------
   *   listContexts resolved  x start      CHOOSING_CONTEXT  -      -      answer:ctx-c  RangeError
   *   listContexts resolved  x select     CHOOSING_CONTEXT  -      -      answer:ctx-a  -
   *   listContexts resolved  x close()    CHOOSING_CONTEXT  -      -      []            -
   *   listContexts rejected  x start      UNAVAILABLE       -      -      answer:ctx-c  RangeError
   *   listContexts rejected  x select     UNAVAILABLE       -      -      answer:ctx-a  RangeError
   *   listContexts rejected  x close()    UNAVAILABLE       -      -      []            -
   *   await session.start()  x start      IN_CONTEXT        ctx-a  IDLE   answer:ctx-b  -
   *   await session.start()  x select     IN_CONTEXT        ctx-a  IDLE   answer:ctx-b  -
   *   await session.start()  x close()    IN_CONTEXT        ctx-a  IDLE   []            -
   *   await session.decide() x each       no change with the real core — see below
   *
   * With every re-check in place the same twelve end on the screen of the call that superseded: in
   * the context that call chose, with its menu and its answers, or `IDLE` after `close()`.
   *
   * **The `decide()` row is decided by the session, and that is why the re-check stays.** With the
   * real core, removing it changes nothing a consumer sees under any of the three: the discarded
   * session is closed first, and a closed core answers the empty list. With a session of the
   * consumer's own that still answers after `close()` — `buildSession` is theirs — the call in flight
   * returns the answers of the context left: under the new context's label after a `start()` or a
   * `selectContext()`, and after `close()` on a closed screen.
   *
   * **What holds in the other nine:** `decide()` never returns a DISCARDED session's answers. The
   * session it consults is always the live one, because `discardSession()` drops the reference before
   * anything else. **What does not hold:** it is not empty in six of them, and in two of those the
   * label belongs to the abandoned context while the answer belongs to the new one.
   *
   *   **The rows of `await session.start()` superseded by a `start()` and by a `close()` are what the
   *   REAL core produces**, and two things the abandoned session does decide them — JOINTLY
   *   sufficient and individually insufficient, in all four combinations:
   *
   *     close() sets idle   start() declines to emit    nested state      carries a menu
   *     ------------------  --------------------------  ----------------  --------------
   *          no                     no                  READY, stale      yes
   *          yes                    no                  READY, stale      yes
   *          no                     yes                 LOADING           no
   *          yes                    yes                 IDLE              no   <- the real core
   *
   *   **What one factor decides on its own: the stale menu.** Whatever `close()` does, there is no
   *   menu on screen as soon as the abandoned `start()` declines to emit after being superseded —
   *   rows three and four both carry no permissions at all. Drop that re-check and the stale menu is
   *   painted whatever `close()` does.
   *
   *   **What the two decide jointly: which menu-less state.** `IDLE` needs both; with only the
   *   re-check the state is whatever the session last published before its await, which is
   *   `LOADING` — a screen that says "still loading" about a context nobody is in. The real core
   *   does both, which is why those rows read `IDLE`. Neither factor can be called irrelevant:
   *   each changes the cell once the other is switched.
   *
   *   - **Three answer under the wrong label, or under none.** The re-check after
   *     `await session.start()` superseded by a `start()` or by a `selectContext()`: the state's
   *     context id is the abandoned one, **and `decide()` answers for the new one.** With the real
   *     core the nested state is `IDLE`, so the screen shows the abandoned context's NAME over no
   *     permissions at all. It is the trap described above, reached from the mirror image — there the
   *     answer was stale under a fresh label, here the label is stale over a fresh answer. And a
   *     resolved listing superseded by a `selectContext()` paints its late list as a picker over the
   *     context the subject just chose, while `decide()` answers for that context.
   *   - **Three degrade to a stale screen.** Each re-check on the way into a context, superseded by
   *     `close()`, repaints or keeps something the subject already left: a picker, `UNAVAILABLE`, or
   *     the context left over an `IDLE` menu. All three are fail-closed: `decide()` is empty.
   *   - **Three lock the subject out.** A listing superseded by a second `start()`, resolved or
   *     rejected, and a rejected listing superseded by a `selectContext()`: the late answer leaves the
   *     context list either **superseded** (the resolved path keeps the stale list) or **emptied**
   *     (the rejected path's late `catch` clears it after the call that superseded it succeeded).
   *     `selectContext()` then raises `RangeError` **for a context the server does return**, and the
   *     only way out is another `start()`. In all three `decide()` answers from the live session
   *     while the screen offers no way to reach it: with the resolved path's re-check removed, a
   *     second start that returns `[ctx-c]` leaves the picker showing `[ctx-a, ctx-b]`, and
   *     `selectContext("ctx-c")` throws.
   *
   * That last trio is the shape `NO_ACCESS_IN_APP` carries a context list to avoid — a screen that
   * offers the subject no way out — reached from a different direction.
   *
   * **A new `await` here is a new row, and a row is not finished until it says what a consumer sees
   * when its re-check is missing.**
   *
   * **`close()` on a discarded session is necessary and not sufficient.** It stops that session
   * emitting and makes its `decide()` deny — but **a promise this layer already holds keeps
   * resolving**, and this layer would act on it. Close the abandoned session AND re-check.
   *
   * A counter and not a timestamp: two switches within the same clock tick are indistinguishable by
   * time, and a clock that steps backwards makes the comparison lie.
   */
  let generation = 0;

  const listeners = new Set<(state: ContextSessionState) => void>();

  /** Set by {@link close}. */
  let closed = false;

  /**
   * Publish the state, and let no single listener stop the others from hearing it.
   *
   * **The try wraps each listener, not the loop** — a loop-level try would stop at the first thrower
   * and the listeners after it would lose the emission, which during `close()` means the previous
   * context's screen stays painted.
   */
  function setState(next: ContextSessionState): void {
    state = next;
    for (const listener of listeners) {
      try {
        listener(state);
      } catch {
        // Swallowed, and not reported anywhere. See `subscribe`.
      }
    }
  }

  /** Closes the outgoing permissions session and forgets it. */
  function discardSession(): void {
    if (unsubscribeFromSession !== undefined) {
      try {
        unsubscribeFromSession();
      } catch {
        // A consumer's unsubscribe may throw; it must not leave this layer holding the session.
      }
      unsubscribeFromSession = undefined;
    }
    if (activeSession !== undefined) {
      try {
        activeSession.close();
      } catch {
        // Same rule: a session that throws on the way out does not keep this layer from moving on.
      }
      activeSession = undefined;
    }
  }

  /**
   * Make `context` active: build its permissions session, subscribe, and re-emit under
   * `IN_CONTEXT`.
   *
   * Everything derived from the previous context is discarded **before** the new session is built,
   * so a consumer never renders the old menu while the new one loads: those are actions that belong
   * to a context the subject already left.
   *
   * **Discarded and not kept warm.** N contexts would otherwise mean N live decision caches — never
   * mixed, because each session keys its own, but growing with the number of contexts visited and
   * bounded by nothing. The cost is paid on a switch BACK: the menu and every decision are asked
   * again. That is the trade this package takes deliberately.
   */
  async function activate(context: Listed): Promise<void> {
    generation += 1;
    const issuedAt = generation;

    // THE CONTEXT WAS READ ONCE, WHERE THE LIST WAS JUDGED, and every use is what was read then —
    // never the element read again. The object is the one the list arrived with, and the consumer
    // holds it too — it is inside the `contexts` of the state it was shown. Read again after
    // `await session.start()`, or on each emission of the session, a `contextId` changed in between
    // labelled one context's answers with another context's id: the session asked for `ctx-a`, and the
    // screen said `ctx-b` over them. Read again here, a `hasAccess` that could be read when the list
    // was judged could throw out of `start()`, and one that said no could say yes.
    const contextId = context.contextId;
    const hasAccess = context.hasAccess;

    discardSession();

    if (!hasAccess) {
      // The session is not built at all. Asking and inferring "no access" from an empty answer
      // would confuse "this context does not open this app" with "this context opens it and may do
      // nothing", which are different screens.
      setState({
        status: "NO_ACCESS_IN_APP",
        contextId,
        contexts: contexts.map((listed) => listed.context),
      });
      return;
    }

    const session = buildSession(contextId);
    activeSession = session;
    unsubscribeFromSession = session.subscribe((permissions) => {
      // A late emission from a session this layer has already discarded must not paint. The
      // subscription is dropped on switch, but a consumer's own session implementation may emit
      // synchronously from inside `close()`, so the guard is here too.
      if (issuedAt !== generation || session !== activeSession) {
        return;
      }
      setState({ status: "IN_CONTEXT", contextId, permissions });
    });

    // THE OPTIMISTIC PAINT. Emitted BEFORE `start()` so the screen carries the new context the
    // moment it is chosen. Delete it and, until the consumer's `start()` emits, `getState()` keeps
    // returning the PREVIOUS context in full — its label and its menu — while `decide()` already
    // answers for the new one.
    //
    // Measured: the core's own session closes that window by itself, and closes it completely — its
    // `start()` emits `LOADING` before its first `await`, so the subscription just registered
    // repaints in the SAME SYNCHRONOUS TURN. Measured against the REAL core through this factory,
    // with its permissions fetch parked: `selectContext()` is called and not awaited, and by the
    // time it returns its promise the listener has already recorded `IN_CONTEXT/IDLE` from this
    // paint and `IN_CONTEXT/LOADING` after it. Not one microtask later — none. With the real core
    // the window never opens at all. It opens only with a consumer session that emits AFTER its
    // first await — and `buildSession` is the consumer's by design, so this cannot be assumed away.
    setState({
      status: "IN_CONTEXT",
      contextId,
      permissions: session.getState(),
    });

    await session.start();
    // THE RE-CHECK. `start()` is a suspension point a context change can supersede.
    if (issuedAt !== generation) {
      return;
    }
    setState({
      status: "IN_CONTEXT",
      contextId,
      permissions: session.getState(),
    });
  }

  return {
    getState() {
      return state;
    },

    subscribe(listener) {
      if (closed) {
        // Registers nothing, and the returned function is still safe to call.
        //
        // A FAIL-CLOSED PROPERTY: the permission state of a closed session does not reach a listener
        // that subscribes after `close()`. In the shipped flag position this branch keeps out one
        // listener a consumer can see: one that subscribes while the final idle state is being
        // delivered — from inside another listener — lands here, because the flag is already set, and
        // without the branch it would join the set being walked and receive that `IDLE`. With the flag
        // moved after the emission it is also the barrier the table below measures.
        //
        // What it protects is what a late subscriber RECEIVES, with a listener that resurrects the
        // session from the final idle state and a second listener that subscribes after `close()`
        // has returned. Four cells:
        //
        //     branch   flag             the late subscriber receives
        //     -------  ---------------  --------------------------------------------------
        //     present  before (shipped) nothing
        //     present  after            nothing
        //     removed  before (shipped) nothing
        //     removed  after            IN_CONTEXT/IDLE, LOADING, READY, READY
        //
        // One cell differs, and the branch is what makes the difference in it. With the flag after
        // the emission the session is resurrected in every case — `closed` is still false while the
        // final idle is delivered, so a re-entrant `start()` is served — and THIS BRANCH IS THE
        // SECOND BARRIER FOR NOTIFICATIONS: the resurrected session's states never reach a listener
        // registered after the close. Remove both and they do. It is not a barrier for reads:
        // `getState()` returns the resurrected state in both of those cells, so with the flag moved a
        // late reader sees it whatever this branch does. Only the flag's position keeps that closed.
        //
        // So with the flag where it is, removing this branch changes what a listener subscribing during
        // the final emission receives, and nothing for one that subscribes after `close()` returned;
        // with the flag moved after the emission, it is also the difference between that late
        // subscriber hearing nothing and hearing a closed session come back.
        //
        // It also buys a bound, and that is real too: a consumer that keeps subscribing to a session
        // it forgot to drop would otherwise accumulate one entry per call, forever.
        return () => {};
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    async start() {
      if (closed) {
        // Silence, not an exception. A route guard already awaiting this must not blow up because
        // something closed the session a millisecond earlier.
        return;
      }
      generation += 1;
      const issuedAt = generation;

      discardSession();
      setState({ status: "LOADING_CONTEXTS" });

      let available: readonly AuthorizationContext[];
      try {
        available = await contextTransport.listContexts(app);
      } catch {
        if (issuedAt !== generation) {
          return;
        }
        // THE LIST IS CLEARED, and that is a decision rather than tidiness. `contexts` is server
        // truth: it is the set the decision point said this subject holds. A start that failed
        // obtained no truth, so there is none to hold on to.
        //
        // Keeping the previous list would let `selectContext` build a session for a context the
        // server may no longer return — revoked, renamed, or never theirs after a role change.
        // The backend validates ownership on every call, so either way the subject gets nothing
        // they should not have; what changes is WHERE they find out. With a stale list they get a
        // session that looks real and denies everything; with an empty one they get a `RangeError`
        // at the call site, and the only way forward is a start that succeeded.
        contexts = [];
        setState({ status: "UNAVAILABLE" });
        return;
      }

      if (issuedAt !== generation) {
        return;
      }
      // AN ANSWER THAT IS NOT A LIST OF CONTEXTS IS NOT A LIST. `null` used to throw out of `start()`
      // and leave the state at `LOADING_CONTEXTS` for good, and so did a list holding a `null`; a
      // string was offered as a picker with one context per character. It is `UNAVAILABLE`, and the
      // list is cleared for the reason the failed path above clears it.
      const listed = contextsOf(available);
      if (listed === undefined) {
        contexts = [];
        setState({ status: "UNAVAILABLE" });
        return;
      }
      contexts = listed;

      if (listed.length === 0) {
        setState({ status: "NO_CONTEXTS" });
        return;
      }
      const only = listed[0];
      if (listed.length === 1 && only !== undefined) {
        // One context is not a choice. Showing a picker with a single option asks the subject to
        // confirm something that has no alternative.
        await activate(only);
        return;
      }
      setState({ status: "CHOOSING_CONTEXT", contexts: listed.map((l) => l.context) });
    },

    async selectContext(contextId) {
      if (closed) {
        // Inert means inert: not even the RangeError an unknown id would raise. Same reason as
        // `start()`.
        return;
      }
      // A CONTEXT LISTED MORE THAN ONCE IS ENTERED THE MOST RESTRICTIVE WAY IT IS LISTED: one that
      // says it does not open this application is taken over one that says it does, as a menu action
      // listed twice collapses to the most restrictive. Taking the first would leave out the one that
      // says no.
      let context: Listed | undefined;
      for (const listed of contexts) {
        if (listed.contextId !== contextId) {
          continue;
        }
        if (context === undefined || (context.hasAccess && !listed.hasAccess)) {
          context = listed;
        }
      }
      if (context === undefined) {
        throw new RangeError(`unknown contextId: ${contextId}`);
      }
      await activate(context);
    },

    async decide(request) {
      const session = activeSession;
      if (session === undefined) {
        // No context, or a context without access: every pair resolves to DENY through
        // `decisionFor`.
        return [];
      }
      const issuedAt = generation;
      const decisions = await session.decide(request);
      // THE RE-CHECK THAT THIS PACKAGE EXISTS FOR. The answer is correct FOR THE CONTEXT IT WAS
      // ASKED UNDER; returning it now would paint it under whichever context the subject moved to.
      // `close()` on the outgoing session is not enough on its own — this promise was already in
      // flight and resolves regardless.
      if (issuedAt !== generation) {
        return [];
      }
      return decisions;
    },

    close() {
      if (closed) {
        return;
      }
      generation += 1;
      discardSession();

      // THE FLAG BEFORE THE EMISSION. Set after it instead, a listener re-entering `start()` or
      // `selectContext()` from the final IDLE would be served by a session that is closing — and
      // served correctly, because `close()` bumps the generation before the emission and nothing
      // bumps it after. In the core that left a closed session answering PERMIT, and with a
      // re-entrant listener it recursed until the stack ran out.
      closed = true;

      // EMISSION BEFORE THE LISTENER DROP. Dropping first would mean nobody hears the transition
      // and the previous context's screen stays painted, which is the leak this exists to close: a
      // framework binding needs this one last emission in order to re-render empty.
      setState({ status: "IDLE" });

      listeners.clear();
    },
  };
}

/**
 * A context a list kept: the element as it arrived, which is what a state shows, and the two fields
 * this package uses, as they were read when the list was judged.
 */
interface Listed {
  readonly context: AuthorizationContext;
  readonly contextId: string;
  readonly hasAccess: unknown;
}

/**
 * The contexts a list names, read once by index — its length is asked once more afterwards, only to
 * tell whether it grew — or `undefined` when it is not an array, when it
 * arrived with elements and names none, when reading it throws — the list at a position, or an
 * element's `contextId` or `hasAccess` — when an element is a function, or when the list gained a
 * position while it was being read.
 *
 * An element names a context when its `contextId`, read, is a string — an object's, and a string's
 * or a number's too, read through the prototype its kind shares. One that names none — `null`,
 * `undefined`, or one whose `contextId`, read, is not a string — is left out, and nothing else with
 * it. An element that cannot be read is not left out: it is not known to name no context, and
 * leaving it out could leave one other context to be entered with no choice.
 * The elements kept are the ones that arrived, not copies; their `contextId` and `hasAccess` are read
 * here, once each, and nothing reads them from the element again.
 */
function contextsOf(value: unknown): readonly Listed[] | undefined {
  try {
    if (!Array.isArray(value)) {
      return undefined;
    }
    const length = value.length;
    const kept: Listed[] = [];
    for (let i = 0; i < length; i += 1) {
      const element: unknown = value[i];
      // A function can carry every field a context declares, and it is not data: not known to name
      // no context, so the list is not used, as when an element cannot be read.
      if (typeof element === "function") {
        return undefined;
      }
      // `null` and `undefined` hold nothing. Every other element is read — a string or a number too,
      // through the prototype its kind shares — so what is left out is what its read did not name.
      if (element === null || element === undefined) {
        continue;
      }
      const contextId = (element as { contextId?: unknown }).contextId;
      if (typeof contextId !== "string") {
        continue;
      }
      // Read here, with the id, so that an element whose `hasAccess` cannot be read makes the list
      // unusable, as one whose `contextId` cannot be read does, and so that what is entered later is
      // what was read now.
      const hasAccess = (element as { hasAccess?: unknown }).hasAccess;
      kept.push({ context: element as AuthorizationContext, contextId, hasAccess });
    }
    // A position the list gained while it was being read was never read. Same rule.
    if (!(value.length <= length)) {
      return undefined;
    }
    return length > 0 && kept.length === 0 ? undefined : kept;
  } catch {
    return undefined;
  }
}
