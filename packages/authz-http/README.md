# @ricardoqmd/authz-http

A reference `AuthorizationTransport` over `fetch`, for
[`@ricardoqmd/authz-core`](https://github.com/ricardoqmd/authz/tree/main/packages/authz-core).

One function. It does not manage state, does not cache and does not decide anything — the core does
all of that. This turns the core's two-method port into two HTTP calls, and enforces one contract on the
answers.

```bash
pnpm add @ricardoqmd/authz-http @ricardoqmd/authz-core
```

**Keep the two on the versions released together**: this package declares as its peer the minor of
`@ricardoqmd/authz-core` it is released with. Paired with another minor, an install ends one of four ways,
depending on the installer and its configuration: refused, and nothing changes; installed, with a warning;
installed, without a word; or it ends in an error, with the pair installed anyway. The package still on the
older release then lacks what the newer release added: an option it does not know is ignored when the code
runs — a `contextField` given to an older release of this package leaves the echo read from `contextId`, so an
answer is used or refused on that field and not on the one you named. The types say so for an option only when
it is written in an object literal where the configuration is expected.

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
| present | present | The header carries the id, and **an answer whose echo field does not echo it is rejected loudly** — as is one that omits the field. The echo field is `contextId`, or the name you give as `contextField`. |
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

Two preconditions on `contextId`, because the symptom of breaking either is an opaque failure
rather than a message: it is sent **as a header value**, so it must be a valid one; and **leading or
trailing whitespace is not preserved** — the platform trims it on the wire, silently.

The rejection follows the same message discipline as every other one here: **the route and the field,
never the body, never the token, never the header value.**

An application id must be a non-empty sequence of **RFC 3986 `unreserved` characters** — letters,
digits, `-`, `.`, `_`, `~` — and must not be `"."` or `".."`. Anything else is **refused with a
`RangeError` and no request is sent**; nothing is encoded into safety, because encoding a separator
only hides it until something downstream decodes it back. **What that guarantees is the segment in the
URL this package constructs**, and no accepted id contains a character any front door measured here
transforms, so that segment now survives them too. See
[Application ids that are refused](#application-ids-that-are-refused).

### The echo field is configuration too

A backend that echoes the context under another name is not wrong, so the name is yours to give, as
the header's is:

```ts
createHttpTransport({
  baseUrl: "https://api.example.com",
  getToken: () => auth.accessToken ?? null,
  contextId: currentContextId,
  contextHeader: "X-Context-Id",
  contextField: "tenantId", // the answer carries { "app": ..., "tenantId": ..., ... }
});
```

**The name changes where the echo is read, and nothing about how it is judged.** An answer is used only
when that field, read once, is a string equal to `contextId`; a missing field, one that is not a
string, and one that echoes a different context are rejected, and the default name does not count
once you give another. Measured through a session over HTTP, against a backend that echoes the
context only under another name: without `contextField` the session is `UNAVAILABLE` and every
decision `DENY`; with it, `READY` and what the backend permits.

`contextField` must be a non-empty string, or the constructor throws a `RangeError` — an empty name,
or one that is not a string, names no field an answer could carry. Without the context pair, no
answer is asked to carry it.

## Configuration

| Field | |
|---|---|
| `baseUrl` | Where the two routes hang from. A trailing slash is fine. |
| `contextId` | Optional. The authorization context to send and require an echo of. See the three modes above. |
| `contextHeader` | Required only when `contextId` is given. **Configuration, never a constant** — this package does not know what your deployment calls its authorization context. |
| `contextField` | Optional; `"contextId"` when omitted. The field of the answer that must echo `contextId`. See [The echo field is configuration too](#the-echo-field-is-configuration-too). |
| `getToken` | Sync or async. Returning `null` omits the `Authorization` header **entirely**; an empty one is a different statement to a backend, and not the one we mean. |
| `fetch` | Optional; defaults to the global. Injectable so you can wrap it — retries, tracing, your own tests — without this package having an opinion about any of it. This package asks each request once. On a connection that drops requests, a `fetch` that asks a failed one once more is what keeps a large screen from being asked again, and shown partly `DENY`, draw after draw: the core README has what it costs without one. |
| `classifyError` | Optional. See below. |
| `paths` | Optional, both entries optional. Where the two routes live. Defaults to the paths in the table above. See below. |
| `onDiagnostic` | Optional. Told which rule refused a call. See [`onDiagnostic`](#ondiagnostic). |

**No environment reads.** No `process.env`, no `import.meta.env`, no ambient globals: you know your
bundler and this package must not.

## The routes are yours

**The defaults are a convenience, and the paths are configuration.** They are two paths this package
chose, and nothing ties them to what your backend serves. If your deployment depends on where the
routes are, set `paths` — then the URL is the one you wrote, whatever the defaults are.

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

**`encodedApp` arrives percent-encoded, and it has already been through the rule. Interpolate it
and nothing else.** An id that is not a sequence of unreserved characters never reaches your function
at all — the refusal runs first, so a configured path cannot walk around it. Passing you the raw id
would have handed you that job without saying so, and forgetting to encode is the ordinary mistake.

**Do not encode it again** — though what that costs you has changed, and the honest version is worth
the paragraph. Measured: over the 66 characters the rule admits, `encodeURIComponent` alters **none**, so for
every id this package will ever hand you it is the identity, and encoding it a second time is the
identity as well: measured over the whole unreserved set and over eleven accepted ids, **0 differ**.
The `%252F` a `/` used to produce cannot happen, because a `/` never gets here.

**So the mistake is currently unreachable, not harmless.** It is the rule that is keeping it
unreachable, and it is one widening away from mattering again — the day an id is allowed to contain
anything encoding touches, a double-encoded path becomes a route your backend does not recognise, and
nothing announces it — measured through a session, a double-encoded `permissions` path shows
`UNAVAILABLE`, or `NO_ACCESS_IN_APP` if your backend answers `403` for an application it does
not know, and a double-encoded `decisions` path shows `READY` with everything denied. Nothing is
printed in any of those cases. That is the failure the instruction is worth avoiding, and it is
why the parameter is still named `encodedApp`.

The returned path is joined to `baseUrl` verbatim, so it must be a non-empty string beginning with
`/`. A wrong URL built in silence is the one outcome this package refuses, so it is checked twice:

| when | what happens |
|---|---|
| at construction | each function you give is called **once**, with the probe id `"probe"`. A returned string that does not begin with `/` is a `RangeError` naming the option. If it throws or returns something that is not a string, the probe concludes nothing — a path looked up by id is entitled not to know one it has never been given. |
| at call time | every path is checked before it is used. A bad one is a `RangeError` naming the option — **to whoever called the transport directly**. See the warning below for what it looks like through a session. |

### What a wrong path looks like from above, and why you must exercise both

**Nothing prints anything.** No published code of either package calls `console`. Through
`createAuthorizationSession` the `RangeError` is caught and turned into state, and no diagnostic event
names the option: this transport's `onDiagnostic` is told only of an `AuthorizationTransportError`,
which this is not, and what a session's `onDiagnostic` hears of it is the reason `rejected`. And the
two options do not produce the same state. Measured through a real core session, against a backend
that permits `read` on `r-1`:

| wrong option | session state | `decisionFor(read, r-1)` | console calls |
|---|---|---|---|
| `paths.permissions` | `UNAVAILABLE` | `PERMIT` | 0 |
| `paths.decisions` | `READY` | `DENY` | 0 |

**A wrong `paths.decisions` is the one to fear.** The menu loads, so the screen is `READY` and
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

**A path is not a place to put a secret.** The route travels into every message this transport
throws, by design — see [Errors](#errors). Whatever you put in the path is part of the route, so a
token or a key does not belong there. This package cannot prevent it and does not try.

## Application ids that are refused

An application id is **refused with a `RangeError`, and no request is sent**, unless it is a non-empty
sequence of **RFC 3986 `unreserved`** characters — `ALPHA / DIGIT / "-" / "." / "_" / "~"` — and is
neither `"."` nor `".."`. Nothing outside that set is encoded into safety, because encoding a separator
only hides it until something downstream decodes it back.

A value that is not a string — `undefined`, `null`, a number, an array — is refused the same
way. The rule is checked on the value itself and not on its conversion to a string: measured,
before that check `[".."]` passed as `".."` and the request reached `/me/permissions` with the
`Authorization` header.

**The rule says what is permitted, not what is dangerous**, and that is the whole reason it is written
this way. Its four ancestors each named a value that had been measured harmful, which meant every
character nobody had thought to measure was permitted by default. `unreserved` is the set the standard
already defines as safe anywhere in a URI with no encoding and no interpretation; a character outside
it is refused whether or not anyone has measured what a front door does with it.

### What the refused ids used to do

`encodeURIComponent` leaves a dot alone, and the URL parser resolves dot segments before the request
goes out. Measured against a real HTTP server, on the default path:

| id | sent as | a server reached DIRECTLY received | an upstream behind `nginx proxy_pass .../api/;` received |
|---|---|---|---|
| `".."` | `/api/me/apps/../permissions` | `/api/me/permissions` | `/api/me/permissions` |
| `"."` | `/api/me/apps/./permissions` | `/api/me/apps/permissions` | `/api/me/apps/permissions` |
| `""` | `/api/me/apps//permissions` | `/api/me/apps//permissions` | **`/api/me/apps/permissions`** (`merge_slashes`) |
| `"a/b"` | `/api/me/apps/a%2Fb/permissions` | `/api/me/apps/a%2Fb/permissions` | **`/api/me/apps/a/b/permissions`** |
| `"../secret"` | `/api/me/apps/..%2Fsecret/permissions` | unchanged | **`/api/me/secret/permissions`** |
| `"../.."` | `/api/me/apps/..%2F../permissions` | unchanged | **`/api/permissions`** |
| `"..;"` | `/api/me/apps/..%3B/permissions` | unchanged | `/api/me/apps/..;/permissions` |
| `"a\b"` | `/api/me/apps/a%5Cb/permissions` | unchanged | unchanged |
| `"..."` | `/api/me/apps/.../permissions` | unchanged | unchanged |
| `"a..b"` | `/api/me/apps/a..b/permissions` | unchanged | unchanged |

**Every row above the last two is refused now.** The last two are sent: `"..."` and `"a..b"` are
unreserved, and the rule refuses only the exact values `"."` and `".."`, not dots in general.

**A column that used to be here said `escapes: yes/no`, and it was measured against a direct server
only.** It read as a security statement, and behind `proxy_pass` with a URI part it was wrong for
three of its rows. The columns now name the setup each one measured, and no cell is `—`.

Before the refusal, each of those requests left **with your `Authorization` header**, toward a route
you did not write. The answer was discarded — the core rejects an `app` that does not match — but the
request had already happened.

And encoding the dots is not a fix: measured, the parser decodes before it resolves, so `%2e%2e` and
`%2E%2E` reach the same `/api/me/permissions` that `..` does. The only faithful answer is to refuse.

The empty id is refused for a different and milder reason: it occupies **no** segment, so
`/me/apps//permissions` is a differently shaped route rather than a route for an application — and what
this package guarantees is that the id is exactly one segment.

### What each front door does, measured

Measured against two reverse proxies, six configurations, with a client that still sent everything:

| id, as sent | `nginx 1.29.3`, `proxy_pass .../api/;` | `nginx`, `proxy_pass` with **no URI part** | Apache 2.4.67, default | `AllowEncodedSlashes On` | `NoDecode` | `NoDecode` + `nocanon` |
|---|---|---|---|---|---|---|
| `%2F` | decoded, dot segments re-resolved | intact | **`404`, never arrives** | decoded, as nginx | intact | intact |
| `%3B` | **decoded to `;`** | intact | **decoded to `;`** | **decoded to `;`** | **decoded to `;`** | intact |
| `%5C` | intact | intact | intact | intact | intact | intact |

**`AllowEncodedSlashes NoDecode` is not the way out, and this README used to offer it as one.** It
keeps `%2F` intact and decodes `%3B` anyway. Of everything measured, only **`nocanon`** on Apache
and a **`proxy_pass` without a URI part** on nginx left every segment untouched.

And a decoded `;` is not cosmetic, because a Servlet container strips `;parameters` from each segment
**before** normalising the path. Measured: `"..;"` through `nginx` (URI part) into **Tomcat 11.0.22**
arrives as `pathInfo=/me/permissions` — the escape, **with the `Authorization` header** — and it arrives
the same way through Apache with `NoDecode`. Directly into Tomcat it stays the literal `..;`. On
**Quarkus 3.15.0** the route does not move, but the `@PathParam` is a different id: `"..;"` → `app=".."`,
`"a;b"` → `app="a"`, i.e. **a question about another application**. Neither is reachable now: `;` is not
unreserved.

**And the bound, which the rule has changed.** What this package guarantees is **the segment in the
URL it constructs**; what a front door does afterwards has always been outside its reach. What has
changed is what there is to act on: **an accepted id cannot contain any of the three escapes above** —
nor a `%` to write one with, nor a space, nor anything outside ASCII — so none of the transformations
measured here has an input. Measured: all 66 unreserved characters, in 30 accepted ids that include
`"..."`, `"...."`, `"a..b"`, `"..~"` and `"~.."`, arrived unchanged through all six
configurations in the table and through a direct connection, each with its `Authorization` header.

**Read that as a consequence of the rule and not as a property of proxies**: the guarantee did not get
stronger, the input got narrower — and it holds only as long as the rule does. What is not measured:
IIS, managed load balancers and CDNs. None of the six configurations transformed an *unreserved*
character; a door that does is outside this bound.

Measured: `%5C` was decoded by neither door in any of the six configurations, and Tomcat 11 answers
`400` to `%5C` and to a raw `\`. So `\` is refused for the reason the rule gives — it is not
unreserved — and not because anything measured turned it back into a separator.

## The decisions request declares its content type

The decisions call sends `Content-Type: application/json`. The permissions call, which has no body,
sends none.

Before this, the body was a string with no content type, so the platform labelled it
`text/plain;charset=UTF-8`. Measured against a real server that requires JSON on a `POST`: it answered
`415`, the chunk was dropped, and the session sat at **`READY` with zero decisions and `DENY`** for a
pair the backend would have permitted — a working screen with everything denied, indistinguishable
from a real denial.

**If you call this from a browser across origins, your backend must allow `Content-Type` in its
`Access-Control-Allow-Headers` before you update.**

Measured in Chrome 152 and Firefox 151, page and backend on different origins, through a session:

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

### `onDiagnostic`

```ts
createHttpTransport({ baseUrl, getToken, onDiagnostic: (event) => log(event) });
```

**Optional**, and nothing the transport sends, returns or rejects with depends on whether you give
it. Every call that rejects with an `AuthorizationTransportError` raises one event,
`{ kind: "call-failed", operation, reason }`, a frozen object: `operation` is `permissions` for
`fetchPermissions` and `decisions` for `fetchDecisions`, and `reason` is the rule that refused it.

| `reason` | the rule |
|---|---|
| `no-response` | no response arrived: the token could not be obtained, or the request did not complete |
| `status` | the response status is not in the 2xx range |
| `not-json` | the body is not JSON |
| `not-an-object` | the body is not an object |
| `no-app` | the body's `app` is missing or not a string |
| `no-list` | the body's `permissions` or `decisions` is missing or not an array |
| `no-context-echo` | a `contextId` was configured and the echo field is missing or not a string |
| `other-context` | the echo field echoes a different context |

**Every field holds a value this package built.** No event holds a token, a header, a route, a status,
a body, or anything else read out of a response. A `RangeError` — a path or an application id refused
at call time — raises none.

**It is called in a task of its own.** Each event is handed over through `setTimeout`, never from
inside a call of this package, and nothing this package does waits for it: what it returns is not
read, so a promise it returns is not awaited and its rejection is not caught. **What it throws is
discarded**, and the transport carries on as if it had not been called. Like any code, a callback that
blocks the thread blocks everything that runs on it. It must be a function, or the constructor throws
a `RangeError`.

A session built on this transport takes a callback of its own: the core's `onDiagnostic` tells what
the session did with the rejection — a chunk that failed, a menu that became unavailable — and this one
tells why the call was refused.
