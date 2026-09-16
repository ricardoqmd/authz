# @ricardoqmd/authz-context

## 0.1.0

### Minor Changes

- 39df26d: Adds `@ricardoqmd/authz-context`: the layer that lists the authorization contexts a subject holds,
  lets one be chosen, and **builds a permissions session per context, discarding it on switch.**

  `@ricardoqmd/authz-core` answers one question and knows nothing about contexts. This package composes
  on top of it through a factory the consumer supplies:

  ```ts
  createContextSession({
    app: "app-a",
    contextTransport,
    buildSession: (contextId) =>
      createAuthorizationSession({
        app: "app-a",
        transport: transportFor(contextId),
        maxPairsPerRequest: 100,
      }),
  });
  ```

  The factory closes over the consumer's own transport and binds the context id into it — which is what
  `@ricardoqmd/authz-http`'s optional `contextId` + `contextHeader` pair exists for. **This package
  builds no transport and knows no URL.**

  The state nests rather than flattens: `IN_CONTEXT` carries the permissions session's own state, so a
  consumer asks _which context am I in_ and then _what does the permissions session say_. Flattening
  would make this package re-declare every state the core has, and every state the core ever added
  would break this package's types.

  **It keeps its own generation counter, and that is the reason this package is not a thin wrapper.**
  The core's counter is a per-session closure variable, so a layer holding one session per context has N
  independent counters and **none of them can see a context change** — that is an event of another
  object. A `decide()` issued under one context resolves _correctly, for that context_; returning it
  after the subject has switched would paint one context's answers under another's label. Every `await`
  a context change can supersede is followed by a re-check before anything observable, and the
  suspension inventory is a table in the source.

  `NO_ACCESS_IN_APP` carries the context list, so that screen offers a way out instead of stranding the
  subject on it.

  A context list that is not a list of contexts is `UNAVAILABLE`, like one that could not be fetched: an
  answer that is not an array, or an array that arrived with elements and names no context. An element
  names a context when its `contextId`, read, is a string; one that names none — `null`, `undefined`, or
  one whose `contextId` is not a string — is left out, and nothing else with it, and an empty list is
  still `NO_CONTEXTS`. A list holding an element whose
  reading throws — the element itself, its `contextId` or its `hasAccess` — is `UNAVAILABLE`: that element
  is not known to name no context. So is a list holding an element that is a function, or one that gains
  an element while it is read. Each element's `contextId` and `hasAccess` are read once, when the list is
  judged, and a context is entered as they read then. A context the list names more than once is entered
  the most restrictive way it is named: if one of them says it does not open the application, that one is
  taken.

  The persistence port and the cross-tab signal are not here yet; they arrive separately.

### Patch Changes

- Updated dependencies [fc599d2]
  - @ricardoqmd/authz-core@0.1.0
