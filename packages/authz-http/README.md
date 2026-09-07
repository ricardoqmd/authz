# @ricardoqmd/authz-http

A reference `AuthorizationTransport` over `fetch`, for
[`@ricardoqmd/authz-core`](https://github.com/ricardoqmd/authz/tree/main/packages/authz-core).

One function. It does not manage state, does not cache and does not decide anything — the core does
all of that. This turns the core's two-method port into two HTTP calls, and enforces one contract on the
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
    getToken: () => auth.accessToken ?? null,
  }),
});
```

## The contract it enforces on your backend

**Every answer must echo the `app` it was asked about**, and this adapter reads it from the body and
rejects when it is missing. The core discards an answer whose `app` does not match, **silently and
fail-closed** — which is right, because an answer about another application is worse than no answer,
but it means an adapter that cast a body without that field would produce a fully denied application
with no error state anywhere. Failing here is a message a developer reads; failing there is a screen
a user cannot explain.

It is read from the body and **not filled in from what was asked**: doing that would make the core's
guard tautological.

The permissions answer needs a `permissions` array and the decisions answer a `decisions` array.

| Method | Route |
|---|---|
| `fetchPermissions(app)` | `GET {baseUrl}/me/apps/{app}/permissions` |
| `fetchDecisions(app, request)` | `POST {baseUrl}/me/apps/{app}/decisions` |

## The authorization context is optional, and there are exactly three modes

The core has no context concept. If your deployment has one, this adapter carries it — and checks
that the answer is about it.

| `contextId` | `contextHeader` | What happens |
|---|---|---|
| absent | absent | **No header is sent and no echo is required.** A backend that has never heard of contexts works unchanged. This is the default. |
| present | present | The header carries the id, and **an answer whose `contextId` does not echo it is rejected loudly** — as is one that omits the field. |
| one of the two | the other missing | **`RangeError` at construction**, naming which is missing. |

```ts
createHttpTransport({
  baseUrl: "https://api.example.com",
  getToken: () => auth.accessToken ?? null,
  // Optional, and only as a pair:
  contextId: currentContextId,
  contextHeader: "X-Context-Id",
});
```

A header name with nothing to put in it, or an id with nowhere to send it, is a configuration
mistake. Rejecting it at construction costs one line; discovering it as a `401` in an environment
costs an afternoon.

⚠️ Two preconditions on `contextId`, because the symptom of breaking either is an opaque failure
rather than a message: it is sent **as a header value**, so it must be a valid one; and **leading or
trailing whitespace is not preserved** — the platform trims it on the wire, silently.

The rejection follows the same message discipline as every other one here: **the route and the field,
never the body, never the token, never the header value.**

Every path segment is percent-encoded, so an identifier containing `/` or `?` cannot escape its
segment.

## Configuration

| Field | |
|---|---|
| `baseUrl` | Where the two routes hang from. A trailing slash is fine. |
| `contextId` | Optional. The authorization context to send and require an echo of. See the three modes above. |
| `contextHeader` | Required only when `contextId` is given. **Configuration, never a constant** — this package does not know what your deployment calls its authorization context. |
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
