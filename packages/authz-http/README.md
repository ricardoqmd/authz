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

| Method | Route by default |
|---|---|
| `fetchPermissions(app)` | `GET {baseUrl}/me/apps/{app}/permissions` |
| `fetchDecisions(app, request)` | `POST {baseUrl}/me/apps/{app}/decisions` |

**Those two paths are defaults, not constants** — see [The routes](#the-routes-are-yours) below. The
methods and the body shape are not configurable.

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

Every path segment is percent-encoded, and the four application ids that encoding cannot make safe
are **refused**, not encoded. **What that guarantees is the segment in the URL this package
constructs**; what a reverse proxy does with it afterwards is outside its reach. See
[Application ids that are refused](#application-ids-that-are-refused).

## Configuration

| Field | |
|---|---|
| `baseUrl` | Where the two routes hang from. A trailing slash is fine. |
| `contextId` | Optional. The authorization context to send and require an echo of. See the three modes above. |
| `contextHeader` | Required only when `contextId` is given. **Configuration, never a constant** — this package does not know what your deployment calls its authorization context. |
| `getToken` | Sync or async. Returning `null` omits the `Authorization` header **entirely**; an empty one is a different statement to a backend, and not the one we mean. |
| `fetch` | Optional; defaults to the global. Injectable so you can wrap it — retries, tracing, your own tests — without this package having an opinion about any of it. |
| `classifyError` | Optional. See below. |
| `paths` | Optional, both entries optional. Where the two routes live. Defaults to the paths in the table above. See below. |

**No environment reads.** No `process.env`, no `import.meta.env`, no ambient globals: you know your
bundler and this package must not.

## The routes are yours

**Pass nothing and nothing changes.** The defaults are the two paths this package used to hardcode,
so the call you write today is the call you keep writing:

```ts
createHttpTransport({ baseUrl: "https://api.example.com", getToken });
// GET  https://api.example.com/me/apps/app-a/permissions
// POST https://api.example.com/me/apps/app-a/decisions
```

Give `paths` when your backend puts them somewhere else. Either entry stands on its own:

```ts
createHttpTransport({
  baseUrl: "https://api.example.com",
  getToken,
  paths: {
    permissions: (encodedApp) => `/authz/${encodedApp}/menu`,
    // `decisions` omitted: it keeps /me/apps/{app}/decisions
  },
});
// GET https://api.example.com/authz/app-a/menu
```

⚠️ **`encodedApp` arrives percent-encoded. Interpolate it and nothing else.** This package encodes the
application id before your function sees it, so an id containing `/` or `?` cannot escape its segment
and reach a route nobody meant to call. Passing you the raw id would have handed you that guarantee
without saying so, and forgetting to encode is the ordinary mistake.

**Do not encode it again.** ⚠️ **For an ordinary id it changes nothing:**
`encodeURIComponent("app-a")` is `"app-a"`, and encoding it twice is still `"app-a"`, so a suite
whose application ids are all ordinary will not catch it. For an id with a `/`, a space or an accent
it produces `%252F`, `%2520` or `%25C3%25B1` and a route your backend does not recognise — **and
nothing announces that either.** Through a session a double-encoded `permissions` path shows
`UNAVAILABLE`, or `NO_ACCESS_IN_APP` if your backend answers `403` for an application it does not
know; a double-encoded `decisions` path shows `READY` with everything denied. Nothing is printed.

The returned path is joined to `baseUrl` verbatim, so it must be a non-empty string beginning with
`/`. A wrong URL built in silence is the one outcome this package refuses, so it is checked twice:

| when | what happens |
|---|---|
| at construction | each function you give is called **once**, with the probe id `"probe"`. A returned string that does not begin with `/` is a `RangeError` naming the option. If it throws or returns something that is not a string, the probe concludes nothing — a path looked up by id is entitled not to know one it has never been given. |
| at call time | every path is checked before it is used. A bad one is a `RangeError` naming the option — **to whoever called the transport directly**. See the warning below for what it looks like through a session. |

### ⚠️ What a wrong path looks like from above, and why you must exercise both

**Nothing prints anything.** Neither this package nor the core has a diagnostic channel, and no
published code of either calls `console`. Through `createAuthorizationSession` the `RangeError` is
caught and turned into state — and the two options do not produce the same state. 📐 Measured through
a real core session, against a backend that permits `read` on `r-1`:

| wrong option | session state | `decisionFor(read, r-1)` | console calls |
|---|---|---|---|
| `paths.permissions` | `UNAVAILABLE` | `PERMIT` | 0 |
| `paths.decisions` | `READY` | `DENY` | 0 |

🔴 **A wrong `paths.decisions` is the one to fear.** The menu loads, so the screen is `READY` and
complete. The decision call's chunk rejects; a rejected chunk contributes nothing — that is the core's
fail-closed contract for any decision failure — and what is absent reads as a denial. **You get a
working screen where everything is denied, and it is indistinguishable from a real denial.**

A wrong `paths.permissions` is milder: the screen says unavailable while `decide()`, whose path is
fine, keeps answering normally.

**No state will tell you the decisions path is wrong, so check it in a way that can fail:** call
`fetchPermissions` and `fetchDecisions` on the transport directly, or assert through a session a
`PERMIT` you know the subject has — a session shows a wrong decisions path as a denial — and do
it **for every application id you will use**, not one. A lookup that knows `app-a` and forgot
`app-b` passes construction, answers `app-a` correctly and fails for `app-b` alone.

⚠️ **A path is not a place to put a secret.** The route travels into every message this transport
throws, by design — see [Errors](#errors). Whatever you put in the path is part of the route, so a
token or a key does not belong there. This package cannot prevent it and does not try.

## Application ids that are refused

Four values are **refused with a `RangeError`, and no request is sent**: `".."`, `"."`, the empty
string, and **any id containing `/`**. They are not encoded, because encoding does not help — a
separator survives encoding only until something downstream decodes it back.

📐 `encodeURIComponent` leaves a dot alone, and the URL parser resolves dot segments before the
request goes out. Measured against a real HTTP server, on the default path:

| id | sent as | a server reached DIRECTLY received | an upstream behind `nginx proxy_pass .../api/;` received |
|---|---|---|---|
| `".."` | `/api/me/apps/../permissions` | `/api/me/permissions` | — |
| `"."` | `/api/me/apps/./permissions` | `/api/me/apps/permissions` | — |
| `""` | `/api/me/apps//permissions` | `/api/me/apps//permissions` | — |
| `"a/b"` | `/api/me/apps/a%2Fb/permissions` | `/api/me/apps/a%2Fb/permissions` | **`/api/me/apps/a/b/permissions`** |
| `"../secret"` | `/api/me/apps/..%2Fsecret/permissions` | unchanged | **`/api/me/secret/permissions`** |
| `"../.."` | `/api/me/apps/..%2F../permissions` | unchanged | **`/api/permissions`** |
| `"..."` | `/api/me/apps/.../permissions` | unchanged | unchanged |
| `"a..b"` | `/api/me/apps/a..b/permissions` | unchanged | unchanged |
| `"a\b"` | `/api/me/apps/a%5Cb/permissions` | unchanged | unchanged |

⚠️ **The column that used to be here said `escapes: yes/no`, and it was measured against a direct
server only.** A reader took that as a security statement, and behind the common `proxy_pass` form it
was wrong for three of its rows. The table now names the montage each column measured. The top four
rows are all refused now; the last three are sent, and `a\b` is in the table because it is the
measurement that decides where the line is drawn.

🔴 Before the refusal, that request left **with your `Authorization` header**, toward a route you did
not write. The answer was discarded — the core rejects an `app` that does not match — but the request
had already happened.

📐 And encoding the dots is not a fix: the parser decodes before it resolves, so `%2e%2e` and `%2E%2E`
reach the same `/api/me/permissions` that `..` does. The only faithful answer is to refuse.

**Why `/` is refused and `\` is not.** 📐 Measured against `nginx 1.29.3` with
`proxy_pass http://upstream/api/;`: `%2F` is decoded and the dot segments re-resolved, so `"a/b"`
arrived as two segments and `"../secret"` as `/api/me/secret/permissions` **with the `Authorization`
header**. `%5C` came through that proxy untouched. An application id containing a separator is always
a programming error, and until now it failed in the worst way to diagnose: the URL that left the
browser looked right and the one that reached the backend was a different route. The line is at `/`
because that is where the measurement is; `\` is not refused because nothing measured turns it back
into a separator.

⚠️ **And the bound on all of this:** what the package guarantees is **the segment in the URL it
constructs**. A proxy that percent-decodes `%2F` before resolving dot segments is outside its reach —
if yours does, `AllowEncodedSlashes NoDecode`, or a `proxy_pass` without a URI part, keeps it intact.

The empty id is refused for a different and milder reason: it occupies **no** segment, so
`/me/apps//permissions` is a differently shaped route rather than a route for an application — and
this package's guarantee is that the id is exactly one segment.

**Everything else is sent, encoded.** `"..."`, `"a..b"`, `"%2e%2e"` and `"a/b"` all stay inside their
segment, and all of them still work.

## The decisions request declares its content type

The decisions call sends `Content-Type: application/json`. The permissions call, which has no body,
sends none.

📐 Before this, the body was a string with no content type, so the platform labelled it
`text/plain;charset=UTF-8`. Measured against a real server that requires JSON on a `POST`: it answered
`415`, the chunk was dropped, and the session sat at **`READY` with zero decisions and `DENY`** for a
pair the backend would have permitted — a working screen with everything denied, indistinguishable
from a real denial.

🔴 **If you call this from a browser across origins, your backend must allow `Content-Type` in its
`Access-Control-Allow-Headers` before you update.**

📐 Measured in Chrome 152 and Firefox 151, page and backend on different origins, through a session:

- **In the first three configurations** the preflight asks for `content-type` beside `Authorization`
  or your context header. A backend whose `Access-Control-Allow-Headers` names only those two fails it.
- **In the fourth** — `getToken` returning `null` and no context pair — the content type is the only
  reason the decisions request is preflighted at all, and a backend that does not answer `OPTIONS`
  fails it.

Either way the browser never sends the `POST`, and nothing says so. The menu request carries no
content type and still loads, so **the screen is `READY` and every decision reads `DENY`**, for pairs
the backend permits too — a working screen with everything denied, the same one a strict JSON backend
produces when the content type is missing. With `Content-Type` among the allowed headers, all four
configurations answered what the backend said; with the page and the backend on one origin, neither
browser sent an `OPTIONS` in any configuration.

The headers this package puts on a request, by configuration — the part that depends on this code:

| configuration | headers |
|---|---|
| token + context pair | `Accept`, `Authorization`, `X-Context-Id`, and `Content-Type` on the decisions call |
| token, no context | `Accept`, `Authorization`, and `Content-Type` on the decisions call |
| no token, with context | `Accept`, `X-Context-Id`, and `Content-Type` on the decisions call |
| no token, no context | `Accept`, and `Content-Type` on the decisions call |

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
