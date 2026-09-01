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
