---
"@ricardoqmd/authz-context": minor
---

Adds `@ricardoqmd/authz-context`: the layer that lists the authorization contexts a subject holds,
lets one be chosen, and **builds a permissions session per context, discarding it on switch.**

`@ricardoqmd/authz-core` answers one question and knows nothing about contexts. This package composes
on top of it through a factory the consumer supplies:

```ts
createContextSession({
  app: "app-a",
  contextTransport,
  buildSession: (contextId) => createAuthorizationSession({ app: "app-a", transport: transportFor(contextId), maxPairsPerRequest: 100 }),
});
```

The factory closes over the consumer's own transport and binds the context id into it — which is what
`@ricardoqmd/authz-http`'s optional `contextId` + `contextHeader` pair exists for. **This package
builds no transport and knows no URL.**

The state nests rather than flattens: `IN_CONTEXT` carries the permissions session's own state, so a
consumer asks *which context am I in* and then *what does the permissions session say*. Flattening
would make this package re-declare every state the core has, and every state the core ever added
would break this package's types.

⚠️ **It keeps its own generation counter, and that is the reason this package is not a thin wrapper.**
The core's counter is a per-session closure variable, so a layer holding one session per context has N
independent counters and **none of them can see a context change** — that is an event of another
object. A `decide()` issued under one context resolves *correctly, for that context*; returning it
after the subject has switched would paint one context's answers under another's label. Every `await`
a context change can supersede is followed by a re-check before anything observable, and the
suspension inventory is a table in the source.

`NO_ACCESS_IN_APP` carries the context list, so that screen offers a way out instead of stranding the
subject on it.

The persistence port and the cross-tab signal are not here yet; they arrive separately.
