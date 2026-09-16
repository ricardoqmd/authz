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
batch chunk or a pair the decision point never returned must not be able to produce a permit. An
element that does not name its pair — or, in a menu, its action — with a string counts as absent,
and one found with no string `effect` reads `DENY`. **Every element is read**, not the first one
that names the pair: a pair listed more than once reads as the most restrictive of the elements that
name it, and an element that is a function makes every pair `DENY`.

**Neither lookup ever throws.** They are called while a screen is drawn, where a throw takes the
render down, so anything they cannot use reads as absent: a collection that is not an array —
`state.permissions` read off a state that is not `READY`, say — is `DENY`, and so is a key that is not a
string, and so is anything that throws while they look — a revoked `Proxy`, a `find` that throws, an
element whose `effect` throws when read.

`CONDITIONAL` renders. Hiding an action because the answer is "it depends" turns *depends* into *no*.

**A lookup reads the whole collection, every time** — that is what lets a `DENY` listed after a
`PERMIT` count. Every lookup reads all `n` elements of the answer — a screen that makes `k` lookups
per draw reads `k` times `n` elements each time it draws — so with a large answer:

- **Keep it out of a store that tracks every element.** Held in a Vue `reactive()` — or any store that
  wraps each element in a tracking proxy — every lookup reads every element through that proxy, and a
  render depends on every element it read: it runs again when any of them changes, even one for a row
  it does not draw. Hold the array as one value instead — `shallowRef`, `markRaw`, or what your
  framework has for it — and replace it with the next array `decide()` returns. Nothing in that array
  changes unless your code changes it: it is a copy, and it is yours.
- **Ask for what you draw.** The cost of a lookup grows with the answer, not with the screen, so asking
  `decide()` for the rows on screen keeps each answer, and each lookup, the size of the page.

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

**Each decisions answer carries the pairs its own request asked for.** A pair is answered only by the
answer to a request that asked for it; what another call's answer says about that pair can make it
more restrictive, and cannot answer it. So a transport that groups concurrent calls into one has to
hand each call the decisions for the pairs in the request that call was given: delivering the
combined answer to one call and an empty one to the rest leaves the pairs of the rest absent, and
absent is `DENY`.

**An answer whose `decisions` is present — not `null`, not `undefined` — and is not an array leaves
every pair of the call `DENY`** — the pairs the other chunks of the call answered too. A page of results
(`{ items, next }`), a map serialised as an object, `{}`, a string, a number, a boolean, a `Set`: none
of them is read as a list, and none is taken for an empty one; the package does not look inside a value
that is not an array. It happens silently and on every call: the call resolves, nothing rejects, the
session stays `READY`, and since nothing of that call is cached the next one asks again and gets the
same. A transport you write yourself should check that `decisions` is an array before it returns the
answer, and reject otherwise: a rejection leaves absent only the pairs of the request it answers. An
answer with no `decisions` at all, or `null` there, holds no element, and it too leaves absent only the
pairs of its own request. `@ricardoqmd/authz-http` already rejects an answer whose `decisions` is not an
array.

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
| `READY` | The menu is loaded and in use. `permissions` holds one entry for each action the menu names with a string, and nothing else; an action listed twice is collapsed to one entry the way `decide()` collapses a pair. |
| `NO_ACCESS_IN_APP` | The decision point was reached and said this subject may not enter this application. |
| `UNAVAILABLE` | **No usable answer was obtained.** Not an expired session — nothing here suggests re-authenticating. A menu whose `permissions`, read, is not an array lands here too, and so does a menu that arrived with entries of which none names its action, or with one entry that could not be read at all. |

**`NO_ACCESS_IN_APP` is not a `READY` with an empty menu.** *"You may not enter"* and *"you may
enter and may do nothing"* are two different screens, and collapsing them is the mistake the type
prevents.

**And a `READY` with an empty menu means only that.** An empty menu is the decision point's answer
`permissions: []`. A menu that arrived with entries and kept none of them is not that answer — it is
an answer that could not be used — so it is `UNAVAILABLE`:

| the decision point answered | state |
|---|---|
| `permissions: []` | `READY`, empty menu |
| ten entries, none of which names its action | `UNAVAILABLE` |
| ten entries: three that name their action, seven read that name none | `READY`, with those three |

**A menu entry is identified by its `action` alone.** `PermissionEntry` declares `action`, `effect`
and `dependsOn`, and `permissionFor` looks an entry up by `action`, so fields the type does not declare
— a resource type, for instance — do not keep two entries apart: they collapse to the most restrictive,
and on a tie the first one is kept whole, `dependsOn` included. A backend that answers per resource type
has to fold the type into the action (`orders:read`) to keep the entries distinct.

**`UNAVAILABLE` carries no `reason`, on purpose.** The text would come from your transport, which
got it from a server, and this package cannot know what is safe to carry in someone else's error
string — it would be one `render` away from a screen. Diagnostics belong to the transport, which
still holds the original error.

### `decide()`

The request is the cross product of `actions` and `resourceIds` over one resource type. It is split
into chunks of at most `maxPairsPerRequest` and every chunk is asked **concurrently**.

- **Identifiers are strings, and a request that says otherwise is refused.** If `resourceType`, an
  action or a resource id is not a string — a number, a boxed string, `null` — `decide()` rejects
  with a `RangeError` that names the field and the type it received (never the value), before the
  cache is read or the transport is called. It is the class `@ricardoqmd/authz-http` uses for an
  application id that is not a string, so one `catch` covers both. Nothing is coerced: `String(42)`
  would be a guess about your data, and `String(null)` is `"null"`, a valid-looking id that can collide
  with a real one. A session that answers nothing — idle, closed, or without access to the app —
  returns `[]` without judging the request; a loading, ready or unavailable one judges it. So a
  malformed request passes unnoticed while a subject has no access, and is refused once they do.
- **The request is read once, when you call `decide()`.** Reusing the object for the next question
  while this one is in flight changes nothing about this call, and what comes back is yours: writing
  into the returned decisions changes no later answer. What your transport returns is copied where it
  is checked, too, so a transport that reuses its objects — or changes their prototype — cannot rewrite
  a cached decision or a menu already on screen.
- **A transport returns data.** Whatever it returns is read once and judged as it was read — the
  length of a list is asked once more, only to tell whether the list grew while it was read — and what
  cannot be read is not used (below). What `decide()` hands back, and what the state holds, is a copy:
  it is not the object your transport returned, and whatever an object keeps outside its own fields —
  private fields, state held elsewhere for that instance — does not survive the copy.

- **Fail-closed per chunk.** A chunk that fails leaves absent the pairs only it asked for, and
  nothing else; absent is `DENY`, and nothing from it is cached. A chunk fails when asking for it
  throws or rejects, when what it resolves to holds no list — it is `null` or `undefined`, or reading
  its `decisions` gives one of them — or when its `app` is not this application. A pair is answered by
  a chunk that asked for it — by any of them, when a request that names an identifier twice asks it in
  more than one — and what another chunk of the same call says about it can make it more restrictive,
  and cannot answer it. `decide()` rejects only for a request that is refused, above, or that throws
  while it is read — with what it threw — or for a `maxPairsPerRequest` the splitter refuses.
- **An element that names no pair is dropped, and nothing else with it.** `null`, `undefined`, and an
  element whose `action` or `resourceId`, read, is not a string are dropped the way a pair nobody asked
  for is: silently, uncached, and absent is `DENY`. An element that names its pair but has no string
  `effect` is kept and reads `DENY`; dropping it would let a `PERMIT` for the same pair answer alone.
- **What cannot be read at all is not discarded.** An element that throws when its `action` or
  `resourceId` is read, when the list is read at its position, or when it is asked for its keys, a
  key's descriptor or its prototype — a revoked `Proxy`, say — may be the `DENY` for a pair another
  element permits, in its answer or in another chunk's. So may an element that is a function, a
  position the list gained while it was being read, and every element of an answer whose envelope
  throws when read, that is a function, or whose `decisions` is present, not `null` or `undefined`,
  and is not an array — a `Set`, a `Map`'s values, an array-like: a list is read only when it is an
  array. So the call resolves with the empty list, every pair reads `DENY`, and nothing is cached. In a
  menu, one such entry makes the session `UNAVAILABLE`.
- **The cache is consulted only when it holds every pair requested.** A partial hit re-asks.
- **The order of the returned array is unspecified.** It is a lookup table: read it with
  `decisionFor`, never by position.
- A session that has not started, or one that has been closed, answers the empty list.
- **The cache answers a pair with what the last call that asked for it returned, and with nothing
  else.** A pair a call leaves absent is absent from the cache too, so the next call that asks for it
  asks the decision point. Of two calls in flight at once that ask for one pair, the last is the one
  answered last: what it returned replaces what the other returned, whichever of the two was made
  first. `start()` and `close()` clear the cache outright, and `maxCachedDecisions` (default 5000)
  bounds it, evicting oldest-first. There is no time-to-live and no clock: until one of those happens,
  a decision a call returned is served from memory.
- **What that costs on a connection that drops requests.** A request is served from the cache only
  once one call has answered every pair of it, and a call that finds any pair missing asks for the
  whole request again — every chunk, not only the one that failed. So until one call completes, every
  draw asks every chunk and shows the pairs of the chunks that failed as `DENY`, and a call completes
  only when all of its chunks answer: with one request in five failing, that is about one call in nine
  for a request of ten chunks and one in 87 for twenty. Measured over HTTP through
  `@ricardoqmd/authz-http`, forty draws of one screen: a request of one chunk costs what it would if a
  failed chunk's pairs were answered from what an earlier call had cached; a request of ten chunks sent
  86 requests and hid a permitted action on 8 draws, where that would have been 23 requests and 2
  draws; a list that grows to twenty chunks hid a permitted action on 35 of its 40 draws, and on most
  screens was still hiding one at the fortieth. Two things bring it back: **ask for what you draw**, so
  a request spans few chunks; and **let your transport ask a failed request once more before it gives
  up** — `@ricardoqmd/authz-http` takes the `fetch` it uses, so wrapping that is enough. Measured the
  same way, one more attempt took the request of ten chunks to 19 requests and a permitted action
  hidden on fewer than one draw in 40, and the one of twenty to 7 draws in 40.

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

**It cannot cancel a call already in flight** — this package never owned that `fetch`. What it
guarantees is that the answer is thrown away.

### A listener owns its own errors

If a listener throws, the throw is caught and discarded: the other listeners still receive the
emission and the publishing call completes. **It is not reported anywhere** — no callback, no
console, no state — because this package deliberately has no diagnostic channel. Do your own error
handling inside the listener.

## What is not here

Authorization contexts — listing them and choosing one — are a separate package,
`@ricardoqmd/authz-context`. They are not a smaller version of this one: they are a different
responsibility, and a consumer that has no context endpoint should not carry them. Persisting the
chosen context and hearing about a change from another tab are in neither package yet.
