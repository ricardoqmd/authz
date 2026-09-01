# @ricardoqmd/authz-http

A reference `AuthorizationTransport` over `fetch`, for
[`@ricardoqmd/authz-core`](https://github.com/ricardoqmd/authz/tree/main/packages/authz-core).

One function. It does not manage state, does not cache and does not decide anything — the core does
all of that. This turns the core's port into three HTTP calls, and enforces one contract on the
answers.

```bash
pnpm add @ricardoqmd/authz-http @ricardoqmd/authz-core
```

```ts
import { createAuthorizationSession } from "@ricardoqmd/authz-core";
import { createHttpTransport } from "@ricardoqmd/authz-http";

const session = createAuthorizationSession({
  app: "app-a",
  maxPairsPerRequest: 200,
  transport: createHttpTransport({
    baseUrl: "https://api.example.com",
    contextHeader: "X-Context-Id",
    getToken: () => auth.accessToken ?? null,
  }),
});
```

## The contract it enforces on your backend

**Every answer must echo the `app` and the `contextId` it was asked about**, and this adapter
**rejects loudly when it does not** — with a message naming the missing field and the route.

That strictness is the entire reason this package exists, so it is worth being explicit about why.
The core discards an answer whose `app` or `contextId` does not match what it asked, **silently and
fail-closed** — which is right, because an answer about a context the subject is not in is worse than
no answer at all. But it means an adapter that never populates those fields produces a **fully denied
application with no error state anywhere**: every menu `UNAVAILABLE`, every decision `DENY`, and
nothing to explain it, because from the core's point of view nothing went wrong. It asked, and it got
answers about something else.

So this adapter fails at the edge, where the failure is a message a developer reads, instead of
quietly at the core, where it would be a screen a user cannot explain.

It also **reads those fields from the response body** and never fills them in from what it asked.
Copying the request's own values would make the core's guard tautological, and a backend answering
for the wrong context would go unnoticed — which is the exact failure this is here to surface.

The same applies to the payloads. A menu needs a `permissions` array, a decision set needs a
`decisions` array, and the contexts call needs a top-level array whose elements carry `contextId`,
`label` and a boolean `hasAccess`. Anything else rejects. **The package never guesses a shape.**

## The three routes

| Call | Method and path | Context header |
|---|---|---|
| `listContexts(app)` | `GET {baseUrl}/me/apps/{app}/contracts` | no — this is the call that asks which contexts exist |
| `fetchPermissions(app, contextId)` | `GET {baseUrl}/me/apps/{app}/permissions` | yes |
| `fetchDecisions(app, contextId, request)` | `POST {baseUrl}/me/apps/{app}/decisions` | yes |

Every path segment is percent-encoded, so an identifier containing `/` or `?` cannot escape its
segment.

## Configuration

| Field | |
|---|---|
| `baseUrl` | Where the three routes hang from. A trailing slash is fine. |
| `contextHeader` | The header the `contextId` travels in. **Configuration, never a constant** — this package does not know what your deployment calls its authorization context. |
| `getToken` | Sync or async. Returning `null` omits the `Authorization` header **entirely**; an empty one is a different statement to a backend, and not the one we mean. |
| `fetch` | Optional; defaults to the global. Injectable so you can wrap it — retries, tracing, your own tests — without this package having an opinion about any of it. |
| `classifyError` | Optional. See below. |

**No environment reads.** No `process.env`, no `import.meta.env`, no ambient globals: you know your
bundler and this package must not.

## Errors

`403` classifies as `NO_ACCESS_IN_APP`; every other non-2xx, a network failure and a body that is not
JSON classify as `UNAVAILABLE`. Everything is thrown as the core's `AuthorizationTransportError`.

`classifyError(status, body)` overrides that, and returning `undefined` falls through to the default.
It receives the parsed body **when the body parsed**, so a backend that distinguishes several kinds
of `403` can be understood by its own error code without this package knowing any of them:

```ts
classifyError: (status, body) =>
  status === 403 && (body as { code?: string })?.code === "CONTEXT_EXPIRED"
    ? "UNAVAILABLE"
    : undefined,
```

**Nothing from a response body ever reaches a thrown message** — nor does the token, nor the header
value. The message is built from the route and the status and from nothing else. The core removed its
own `reason` field precisely so that server text could not arrive one `render` away from a screen;
this does not reintroduce the leak from below.
