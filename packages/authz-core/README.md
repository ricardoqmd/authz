# @ricardoqmd/authz-core

Framework-agnostic authorization primitives: the decision vocabulary, the render rule
and the fail-closed lookups that every consumer would otherwise reimplement.

> **Status: pre-1.0.** The public surface may change in minor versions until `1.0.0`.

## Install

```bash
pnpm add @ricardoqmd/authz-core
```

## What it gives you today

```ts
import { decisionFor, isRenderable, permissionFor } from "@ricardoqmd/authz-core";

// Type level — what the user may attempt in this application.
isRenderable(permissionFor(menu, "approve")); // conditional renders; absent denies

// Instance level — may the user act on this record?
isRenderable(decisionFor(decisions, "approve", record.id));
```

Both lookups return `DENY` when the pair is absent, and that is the point: a truncated
response, a failed batch chunk or a pair the decision point never returned must not be
able to produce a permit.

`CONDITIONAL` renders. Hiding an action because the answer is "it depends" turns
*depends* into *no*.

## Contexts, transport and batched decisions

A subject may hold several authorization contexts and only one is active at a time. The
session turns that into a state machine, and the states are deliberately not collapsible:
`NO_CONTEXTS`, `NO_ACCESS_IN_APP` and `UNAVAILABLE` are three different screens.

| State | Means |
|---|---|
| `IDLE` | `start()` has not been called yet. Distinct from `LOADING`: a consumer that shows a spinner for `LOADING` should not show one for a session nobody started. |
| `LOADING` | A call is in flight. |
| `NO_CONTEXTS` | The subject holds none. |
| `CHOOSING_CONTEXT` | More than one, and none chosen. One context is auto-selected, so a picker never appears with a single option. |
| `NO_ACCESS_IN_APP` | The active context does not open this application. Neither the menu nor `decide` asks about it. |
| `READY` | A context is active and its menu is loaded. |
| `UNAVAILABLE` | No answer was obtained. |

`UNAVAILABLE` carries **no `reason`**, deliberately. The text would come from your transport,
which got it from a server, and this package has no way to know what is safe to carry in
someone else's error string — it would be one `render` away from a screen, unbounded and
unlabelled. Diagnostics belong to your transport, which still holds the original error.

`subscribe` does not emit on subscription: `getState()` is synchronous and always defined, so
emitting would give the same information twice by two mechanisms.

The decision cache is bounded by `maxCachedDecisions` (default `5000`), evicting oldest-first.
It is a **memory bound, not a freshness policy**: there is no time-to-live, because expiry is a
separate decision this package has not taken.

```ts
import { createAuthorizationSession } from "@ricardoqmd/authz-core";

const session = createAuthorizationSession({
  app: "app-a",
  transport, // yours; see below
  maxPairsPerRequest: 200, // your decision point's maximum, not ours
});

session.subscribe((state) => render(state));
await session.start(); // one context auto-selects; two or more offer a picker

const decisions = await session.decide({
  resourceType: "orders",
  actions: ["read", "approve"],
  resourceIds: visibleRows.map((r) => r.id),
});
```

You implement `AuthorizationTransport` — three methods, and **none of them takes a subject,
a role or a token**. Your implementation gets the caller's identity however it already does;
this library never sees it and therefore can never assert it.

### Writing a transport: the one mistake that costs you the whole application

**Your transport must echo `app` and `contextId` back in every answer**, matching the values it
was called with. `PermissionMenu` and `DecisionSet` both declare them, and the session checks
them: an answer labelled with another app or another context is **discarded, silently, and
fail-closed**. That is deliberate — an answer about a context the subject is not in is worse
than no answer — but it means a transport that never populates those fields produces a
**fully denied application with no error state anywhere**. Every menu is `UNAVAILABLE`, every
decision is `DENY`, and nothing in the state machine says why, because there is nothing wrong
from its point of view: it asked, and it got answers about something else.

The line that causes it is this one:

```ts
// ✗ the cast makes the compiler agree with a body that has neither field
const set = (await res.json()) as DecisionSet;
```

`as` silences exactly the check that would have caught it. Build the object instead, so the
compiler asks you for the fields:

```ts
// ✓ app and contextId come from the call, not from the body's hope of carrying them
async fetchDecisions(app, contextId, request) {
  const res = await fetch(url, { method: "POST", body: JSON.stringify(request) });
  const body = (await res.json()) as { decisions: Decision[] };
  return { app, contextId, decisions: body.decisions };
}
```

If your decision point does return the labels, compare them and let the mismatch surface as a
transport error — you have somewhere to log it, and this package does not.

`decide` splits the request into chunks that fit `maxPairsPerRequest`, asks them
concurrently and merges. **A chunk whose call fails contributes nothing**, so its pairs are
absent and `decisionFor` denies them. One failed chunk never fails the whole call, and never
becomes a permit.

Switching context discards the previous menu and the decision cache before the new fetch
starts, and an answer that arrives after the switch is dropped rather than rendered over the
new context.

## Surviving a reload, and knowing another tab changed the context

Two **optional, injected** ports. Neither is implemented here: this package touches no DOM, no
`window` and no `localStorage`, and its tests run without a browser. **The browser implementations —
a `BroadcastChannel`, a `localStorage` store and the `storage`-event fallback — arrive in a separate
package.**

```ts
const session = createAuthorizationSession({
  app: "app-a",
  transport,
  maxPairsPerRequest: 200,
  contextStore,  // optional: read / write / clear a context id
  contextSignal, // optional: announce / subscribe
});
```

**They are independent.** Supply the signal alone to let tabs learn about each other without writing
anything into the browser; supply the store alone to survive a reload with no channel. No path reads
the store because a notice arrived, and none announces because a value was written. A selection
that was superseded before it finished announces nothing at all.

**The stored context is a HINT; the server's list is the AUTHORITY.** At `start()` a stored id is
honoured only when the list the decision point just returned contains it *and* that context grants
access. Anything else — an arrangement that ended, another application's value, one edited by hand —
is discarded and the store is cleared. A stored id never asserts that the subject holds a context.

**A context is stored only once the session reaches `READY` under it**, and nowhere else. A selection
that turns out to have no access, whose menu fetch fails, or whose menu comes back labelled with
another context **writes nothing and leaves the previous value alone** — so a reload restores the last
context that actually worked, instead of dropping the subject back into the screen they were trying to
escape.

A selection superseded **during the menu fetch** does not write either. One superseded **during the
write itself may write** — the write completes before the check that follows it, and not writing
would require knowing a supersession that has not happened yet. That costs nothing: the stored id is
a hint, re-validated against the decision point's list at `start()`, so a stale one can cost a
re-selection and never an access.

**Neither port can take the session down.** A `read` that throws or rejects is treated as nothing
persisted; a `write`, `clear` or `announce` that throws is ignored and the selection still completes.
`localStorage` throws in a private window and when a quota is full, and a channel throws once its
document is discarded.

### `CONTEXT_CHANGED_ELSEWHERE`

When another tab announces a different context, the session moves to this state and — in the same
step — drops its active context, clears its decision cache and bumps its generation.

**The screen keeps its menu and the session stops answering.** The menu is your DOM and this package
does not touch it, so a half-typed form is not lost. But `decide()` returns the empty list, and absent
resolves to `DENY` through `decisionFor`. That is the honest answer, not the harsh one: the backend
reads the active context from the same shared place the other tab just wrote, so a button this session
kept painting would be a button the backend refuses.

It carries `contextId` (the one now active elsewhere) and `previousContextId` (the one this session
was in) — the second is what lets a banner say which context the work on screen belongs to.

**There is no `dismiss()`.** The state is left the way every other state is left: `start()`, which
re-lists and restores, or `selectContext()`. A dismissal would let a consumer hide the banner and keep
working in a context the subject has left.

### `close()`

**The session stops answering.** It marks itself closed, drops its active context, empties its
decision cache, bumps its generation and **emits one final `IDLE`** — in that order, emission before
the listeners are dropped, so a binding gets the one render it needs to clear the screen. It is marked
closed **before** that emission, so a listener that re-enters `start()` or `selectContext()` from it
is served by a session that is already inert. Afterwards `decide()` returns the empty
list (absent is `DENY`), `start()` and `selectContext()` resolve without calling the transport and
without touching state — `selectContext()` does not even raise its `RangeError` — `subscribe()`
registers nothing, and `getState()` is `IDLE`. Silence rather than exceptions, so a route guard that
was already awaiting `start()` does not blow up because something closed the session first.

**Why it stops answering, and not just unsubscribes:** a different person signing in on the same
browser gets a token for another subject on the next refresh. The backend refuses that tab — no data
crosses — but the menu already painted and the decisions already cached belong to the previous person.
The new person does not see their records; they see their silhouette: which sections existed, which
actions were available, whether that person was an administrator. In a package where the menu *is* the
permission, that says plenty. The consumer's half is to watch the subject and call `close()`; this is
the package's half.

⚠️ **It cannot cancel a call already in flight** — this package never owned that `fetch`. What it
guarantees is that the answer is thrown away.

Idempotent. **It does not close the injected signal** — you created that channel, you close it. An
application that builds a session per route and never calls this accumulates one live listener per
navigation, each holding a whole session alive.

## What it does not do

- It does not talk to a policy engine. The browser never reaches one; the application's
  backend is the enforcement point and re-decides every action.
- It does not accept a subject, a role or a person identifier from the caller.
- It has no mock adapter, and will not get one.
- It does not speak HTTP. There is no URL, no header and no client here; the transport is
  yours.
- It does not read the environment. No `process.env`, no `import.meta.env`, no ambient
  global — configuration arrives as arguments, so the package does not tie you to one
  bundler or one runtime.
- It does not carry your decision point's maximum batch size. `maxPairsPerRequest` is
  required and has no default, because a default would be somebody else's number.
- `UNAVAILABLE` is not an expired session. Nothing here will suggest re-authenticating
  because a decision point was unreachable.

## License

MIT © ricardoqmd
