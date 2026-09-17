# @ricardoqmd/authz-context

**Which authorization context is the subject working under?** This package lists the contexts a
subject holds, lets one be chosen, and **builds a permissions session per context, discarding it on
switch.**

> **Status: pre-1.0.** The public surface may change in minor versions until `1.0.0`.

[`@ricardoqmd/authz-core`](https://github.com/ricardoqmd/authz/tree/main/packages/authz-core) answers
one question — *what may this subject do in this application* — and knows nothing about contexts.
That separation is deliberate: the decision point the backend consults never sees a context either,
it resolves one into subject attributes and pushes those. **A consumer with no context concept needs
only the core.**

## Install

```bash
pnpm add @ricardoqmd/authz-context @ricardoqmd/authz-core
```

**Keep the two on the versions released together**: this package declares as its peer the minor of
`@ricardoqmd/authz-core` it is released with. Paired with another minor, an install ends one of four ways,
depending on the installer and its configuration: refused, and nothing changes; installed, with a warning;
installed, without a word; or it ends in an error, with the pair installed anyway. The package still on the
older release then lacks what the newer release added: an option it does not know is ignored when the code
runs, and a method it does not have throws a `TypeError` when called. The types say so for a method, and for
an option only when it is written in an object literal where the configuration is expected.

## The composition: two objects and a factory

```ts
import { createAuthorizationSession } from "@ricardoqmd/authz-core";
import { createContextSession } from "@ricardoqmd/authz-context";
import { createHttpTransport } from "@ricardoqmd/authz-http";

const session = createContextSession({
  app: "app-a",
  contextTransport: myContextTransport,
  buildSession: (contextId) =>
    createAuthorizationSession({
      app: "app-a",
      maxPairsPerRequest: 100,
      transport: createHttpTransport({
        baseUrl: "https://api.example.com",
        getToken: () => auth.accessToken ?? null,
        contextId,                       // bound here, by you
        contextHeader: "X-Context-Id",
      }),
    }),
});
```

**`buildSession` is yours, and that is the whole composition.** The factory closes over your own
transport and binds the context id into it — which is exactly what the HTTP adapter's optional
`contextId` + `contextHeader` pair exists for. **This package builds no transport and knows no URL.**

The port it does need is one method:

```ts
interface ContextTransport {
  listContexts(app: string): Promise<readonly AuthorizationContext[]>;
}
```

`getState()` · `lastListedContexts()` · `subscribe(listener)` · `start()` · `selectContext(id)` ·
`decide(request)` · `close()`.

**The permissions session is never handed out.** A consumer holding one could call `decide` past
this layer's guard, and a guard a layer cannot enforce is not a guard.

## The state, and why it nests

| State | Means |
|---|---|
| `IDLE` | Before `start()`, or after `close()`. |
| `LOADING_CONTEXTS` | The list is in flight. |
| `NO_CONTEXTS` | The subject holds none. Nothing to choose. |
| `CHOOSING_CONTEXT` | Two or more; `contexts` carries them. |
| `NO_ACCESS_IN_APP` | The context is real and does not open this application. **Carries the list.** |
| `IN_CONTEXT` | In a context; `permissions` carries the core session's own state. |
| `UNAVAILABLE` | **The context list** could not be obtained, or what arrived was not a list of contexts — not an array, one with elements none of whose `contextId`, read, is a string, or one with an element whose reading throws. Not an expired session — nothing here suggests re-authenticating. |

**`IN_CONTEXT` nests the core's state rather than flattening it.** Flattening would make this
package re-declare every state the core has, so every state the core ever adds would break this
package's types. Nested, you ask *which context am I in* and then *what does the permissions session
say* — the same question in the same order the architecture asks it.

**`UNAVAILABLE` here and `UNAVAILABLE` inside `IN_CONTEXT` are different screens.** This one says
the context list could not be obtained; that one says a context you are already in has a menu that
failed. One offers no context, the other offers a context whose menu failed.

**`NO_ACCESS_IN_APP` carries the context list.** That screen used to carry nothing and offer the
subject no way out.

**A subscriber can be called twice for one transition, with an equal value.** Settling into a
context emits once when the permissions session publishes and once more when the activation returns,
and nothing de-duplicates them. **It is the activation, not the switch** — measured on the
single-context path, where `start()` activates with no picker and `selectContext` is never called,
the last value still arrives twice. One context does not exempt you. Measured on `READY`,
`NO_ACCESS_IN_APP` and `UNAVAILABLE` alike: it is the transition, not the outcome. A render function
tolerates it; a counter, an analytics event or a one-shot navigation does not.

**And every emission is a fresh object, deliberately** — states are immutable data, never mutated in
place — so `prev === next` is always false and cannot be used to detect "unchanged". Compare by value
if you need to suppress the repeat.

### The list as of the last listing

`IN_CONTEXT` carries no list, so a context selector that stays on screen once a context is chosen —
in a header, say — can paint it from `lastListedContexts()`:

| when | `lastListedContexts()` |
|---|---|
| before any listing has ended, the first one in flight included | `undefined` |
| after a listing that named contexts — in `CHOOSING_CONTEXT`, `NO_ACCESS_IN_APP` and `IN_CONTEXT` alike | those contexts |
| while a later listing is in flight | still the last one |
| after a listing that named none | `[]` |
| after a listing that failed, or whose answer was not a list of contexts | `undefined` |
| after `close()` | `undefined` |

**It is not part of the state because nothing refreshes it:** a state says what is current, and this
list is only as current as the listing that returned it. `undefined` is no list held, and `[]` is a
listing that named no context. A listing superseded by a later `start()` or by `close()` is not the
last listing. Each call returns a new array, so writing into it changes nothing the session holds; its
elements are the contexts as the listing returned them, the same objects a state that carries
`contexts` holds. It already holds the new list when the state that follows the listing is emitted.

## Behaviour

- **`start()`** lists. None → `NO_CONTEXTS`. Exactly one → activated with no picker: *one context is
  not a choice.* Two or more → `CHOOSING_CONTEXT`. What is counted is the contexts the answer names:
  an element whose `contextId`, read, is not a string is left out, and an answer that is not an
  array, names no context among the elements it arrived with, or holds an element whose reading throws
  — the element itself, its `contextId` or its `hasAccess` — is `UNAVAILABLE`. So is one holding an
  element that is a function, or one that gains an element while it is read: neither is known to name
  no context. Each element's `contextId` and `hasAccess` are read once, there, and a context is
  entered as they read then.
- **A context with `hasAccess === false` is not asked about at all** — no session is built. Asking and
  inferring "no access" from an empty answer confuses two different screens.
- **Switching** closes the outgoing session, discards it, and builds the new one. **Discarded, not
  kept warm:** N contexts would otherwise mean N live decision caches, never mixed but bounded by
  nothing. The cost is paid on a switch *back* — the menu and every decision are asked again.
- **`selectContext(id)`** throws `RangeError` on an unknown id; the ids come from this session, so
  that is a programming error. A closed session does not raise it either: inert means inert. A context
  the list names more than once is entered the most restrictive way it is named: if one of them says
  it does not open the application, that one is taken.
- **`close()`** closes the active session, emits one final `IDLE` and then drops the listeners.

## Why something did not happen: `onDiagnostic`

```ts
createContextSession({ app: "app-a", contextTransport, buildSession, onDiagnostic: (event) => log(event) });
```

**Optional**, and nothing the session decides, emits or returns depends on whether you give it. It is
this session's own: a permissions session built by `buildSession` tells the callback that session was
given, if any — so pass one there too if you want to hear the core. Each event is a frozen object with
a `kind` and the fields that kind declares:

| `kind` | raised when | fields |
|---|---|---|
| `session-built` | `buildSession` returned: once for every activation of a context whose `hasAccess`, as read when the list was judged, is truthy — a context entered again is activated again. The context session then starts the session `buildSession` returned, which raises `menu-requested` to its own callback, if it has one: with `restart: false` unless it had already been started, and not at all if it was closed before that start | none |
| `listing-unavailable` | `start()` settles on `UNAVAILABLE` | `reason`: `rejected`, `not-a-list` |
| `answer-discarded` | what a call was waiting for arrives after a later `start()`, `selectContext()` or `close()`: the list of a `start()`, the menu an activation started, or the decisions of a `decide()`, which resolves with the empty list | `operation`: `listing`, `activation`, `decide` |

**Every field holds a value this package built.** None holds a context, an identifier, an error, or
anything read out of an answer.

**It is called in a task of its own.** Each event is handed over through `setTimeout`, never from
inside a call of this package, and nothing this package does waits for it: what it returns is not
read, so a promise it returns is not awaited and its rejection is not caught. **What it throws is
discarded**, and the session carries on as if it had not been called. Like any code, a callback that
blocks the thread blocks everything that runs on it. It must be a function, or the constructor throws
a `RangeError`.

## The seam, and its rule

**If you write your own layer on top of the core, you need this protocol too.**

The core's `generation` counter is a **per-session closure variable**. A layer that builds one session
per context therefore holds N independent counters, and **none of them can see a context change** —
that is an event of another object entirely.

**The trap, concretely.** A `decide()` issued under `ctx-a` resolves *correctly, for `ctx-a`*. If your
layer awaits it and the subject has since moved to `ctx-b`, **your layer paints `ctx-a`'s answers
under `ctx-b`'s label.** The session cannot detect it: it does not know what a context is.

> **The rule: keep your own generation counter in the context switch, bump it on every context change,
> and re-check it after every `await` a context change could supersede — before any observable action:
> emitting, caching, or returning.**

**Closing the outgoing session is necessary and not sufficient.** It stops that session emitting and
makes its `decide()` deny — but **a promise you already hold keeps resolving**, and you will act on it
unless your own counter says otherwise. Close *and* re-check.

The inventory of suspension points is a table in this package's source, in the same shape the core
uses. A new `await` is a new row in it.

## Not here yet

Persisting the chosen context across a reload, and hearing about a change from another tab. They
arrive separately.
