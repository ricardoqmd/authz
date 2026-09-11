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

✅ **`buildSession` is yours, and that is the whole composition.** The factory closes over your own
transport and binds the context id into it — which is exactly what the HTTP adapter's optional
`contextId` + `contextHeader` pair exists for. **This package builds no transport and knows no URL.**

The port it does need is one method:

```ts
interface ContextTransport {
  listContexts(app: string): Promise<readonly AuthorizationContext[]>;
}
```

`getState()` · `subscribe(listener)` · `start()` · `selectContext(id)` · `decide(request)` ·
`close()`.

⚠️ **The permissions session is never handed out.** A consumer holding one could call `decide` past
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
| `UNAVAILABLE` | **The context list** could not be obtained. Not an expired session — nothing here suggests re-authenticating. |

✅ **`IN_CONTEXT` nests the core's state rather than flattening it.** Flattening would make this
package re-declare every state the core has, so every state the core ever adds would break this
package's types. Nested, you ask *which context am I in* and then *what does the permissions session
say* — the same question in the same order the architecture asks it.

⚠️ **`UNAVAILABLE` here and `UNAVAILABLE` inside `IN_CONTEXT` are different screens.** This one says
the context list could not be obtained; that one says a context you are already in has a menu that
failed. One offers no context, the other offers a context whose menu failed.

✅ **`NO_ACCESS_IN_APP` carries the context list.** That screen used to carry nothing and offer the
subject no way out.

⚠️ **A subscriber can be called twice for one transition, with an equal value.** Settling into a
context emits once when the permissions session publishes and once more when the activation returns,
and nothing de-duplicates them. **It is the activation, not the switch** — 📐 measured on the
single-context path, where `start()` activates with no picker and `selectContext` is never called,
the last value still arrives twice. One context does not exempt you. 📐 Measured on `READY`,
`NO_ACCESS_IN_APP` and `UNAVAILABLE` alike: it is the transition, not the outcome. A render function
tolerates it; a counter, an analytics event or a one-shot navigation does not.

**And every emission is a fresh object, deliberately** — states are immutable data, never mutated in
place — so `prev === next` is always false and cannot be used to detect "unchanged". Compare by value
if you need to suppress the repeat.

## Behaviour

- **`start()`** lists. None → `NO_CONTEXTS`. Exactly one → activated with no picker: *one context is
  not a choice.* Two or more → `CHOOSING_CONTEXT`.
- **A context with `hasAccess === false` is not asked about at all** — no session is built. Asking and
  inferring "no access" from an empty answer confuses two different screens.
- **Switching** closes the outgoing session, discards it, and builds the new one. **Discarded, not
  kept warm:** N contexts would otherwise mean N live decision caches, never mixed but bounded by
  nothing. The cost is paid on a switch *back* — the menu and every decision are asked again.
- **`selectContext(id)`** throws `RangeError` on an unknown id; the ids come from this session, so
  that is a programming error. A closed session does not raise it either: inert means inert.
- **`close()`** closes the active session, emits one final `IDLE` and then drops the listeners.

## 🔴 The seam, and its rule

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

⚠️ **Closing the outgoing session is necessary and not sufficient.** It stops that session emitting and
makes its `decide()` deny — but **a promise you already hold keeps resolving**, and you will act on it
unless your own counter says otherwise. Close *and* re-check.

The inventory of suspension points is a table in this package's source, in the same shape the core
uses. A new `await` is a new row in it.

## Not here yet

Persisting the chosen context across a reload, and hearing about a change from another tab. They
arrive separately.
