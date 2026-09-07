# @ricardoqmd/authz-core

**What may this subject do in this application?** That is the whole question this package answers:
the decision vocabulary, the render rule, the fail-closed lookups every consumer would otherwise
reimplement, and a session that holds the answer.

> **Status: pre-1.0.** The public surface may change in minor versions until `1.0.0`.

**It has no notion of an authorization context**, and that is deliberate. The decision point the
backend consults does not know what a context is either — the backend resolves one into subject
attributes and pushes those — so resolving a context and evaluating permissions are separate
responsibilities, and fusing them here would fuse what the rest of the system keeps apart.

**A consumer with no context concept needs nothing extra.** Implement two methods and you are done.

## Install

```bash
pnpm add @ricardoqmd/authz-core
```

## The two lookups

```ts
import { decisionFor, isRenderable, permissionFor } from "@ricardoqmd/authz-core";

// Type level — what the subject may attempt at all in this application.
isRenderable(permissionFor(menu, "approve")); // conditional renders; absent denies

// Instance level — may the subject act on this record?
isRenderable(decisionFor(decisions, "approve", record.id));
```

Both return `DENY` when the pair is absent, and that is the point: a truncated response, a failed
batch chunk or a pair the decision point never returned must not be able to produce a permit.

`CONDITIONAL` renders. Hiding an action because the answer is "it depends" turns *depends* into *no*.

## The port: two methods, and that is all

```ts
interface AuthorizationTransport {
  fetchPermissions(app: string): Promise<PermissionMenu>;
  fetchDecisions(app: string, request: DecisionRequest): Promise<DecisionSet>;
}
```

Nothing in it speaks HTTP: no URL, no header, no client. **No method takes a subject, a role, a
person identifier or a token**, and that is the point of the shape — the implementation obtains the
caller's identity however it wants, this package never sees it and therefore can never assert it.

`@ricardoqmd/authz-http` is a reference implementation over `fetch`.

**Both answers must echo the `app` they were asked about.** An answer whose `app` does not match is
discarded, silently and fail-closed: an answer about another application is worse than no answer.

## The session

```ts
const session = createAuthorizationSession({ app: "app-a", transport, maxPairsPerRequest: 100 });

const stop = session.subscribe((state) => render(state));
await session.start();
const decisions = await session.decide({
  resourceType: "orders",
  actions: ["read", "approve"],
  resourceIds: ["r-1", "r-2"],
});
session.close();
```

`getState()` · `subscribe(listener)` · `start()` · `decide(request)` · `close()`.

### The five states, and why none of them collapses into another

| State | Means |
|---|---|
| `IDLE` | Before `start()`, or after `close()`. Not a spinner. |
| `LOADING` | A call is in flight. |
| `READY` | The menu is loaded; `permissions` carries it. |
| `NO_ACCESS_IN_APP` | The decision point was reached and said this subject may not enter this application. |
| `UNAVAILABLE` | **No answer was obtained.** Not an expired session — nothing here suggests re-authenticating. |

⚠️ **`NO_ACCESS_IN_APP` is not a `READY` with an empty menu.** *"You may not enter"* and *"you may
enter and may do nothing"* are two different screens, and collapsing them is the mistake the type
prevents.

⚠️ **`UNAVAILABLE` carries no `reason`, on purpose.** The text would come from your transport, which
got it from a server, and this package cannot know what is safe to carry in someone else's error
string — it would be one `render` away from a screen. Diagnostics belong to the transport, which
still holds the original error.

### `decide()`

The request is the cross product of `actions` and `resourceIds` over one resource type. It is split
into chunks of at most `maxPairsPerRequest` and every chunk is asked **concurrently**.

- **Fail-closed per chunk.** A chunk whose call rejects contributes nothing, so its pairs are absent
  and absent is `DENY`. One failed chunk never fails the whole call and never becomes a permit, and
  nothing from it is cached.
- **The cache is consulted only when it holds every pair requested.** A partial hit re-asks.
- **The order of the returned array is unspecified.** It is a lookup table: read it with
  `decisionFor`, never by position.
- A session that has not started, or one that has been closed, answers the empty list.

### `close()`

**The session stops answering.** It bumps its generation, empties the decision cache, marks itself
closed and emits one final `IDLE` — and only then drops the listeners. Afterwards `decide()` returns
the empty list, `start()` resolves without calling the transport, `subscribe()` registers nothing and
`getState()` is `IDLE`. Silence rather than exceptions, so a route guard already awaiting `start()`
does not blow up because something closed the session first.

**Why it stops answering rather than just unsubscribing:** a different person signs in on the same
browser and the next refresh hands this tab a token for another subject. The backend refuses that
tab — no data crosses — but the menu already painted and the decisions already cached belong to the
previous person. The new person does not see their records; they see their *silhouette*: which
sections existed, which actions were available, whether that person was an administrator. In a
package where the menu **is** the permission, that says plenty. Your half is to watch the subject and
call `close()`.

⚠️ **It cannot cancel a call already in flight** — this package never owned that `fetch`. What it
guarantees is that the answer is thrown away.

### A listener owns its own errors

If a listener throws, the throw is caught and discarded: the other listeners still receive the
emission and the publishing call completes. **It is not reported anywhere** — no callback, no
console, no state — because this package deliberately has no diagnostic channel. Do your own error
handling inside the listener.

## What is not here

Authorization contexts — listing them, choosing one, persisting the choice, hearing about a change
from another tab — are a separate package. They are not a smaller version of this one: they are a
different responsibility, and a consumer that has no context endpoint should not carry them.
