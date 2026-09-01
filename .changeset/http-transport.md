---
"@ricardoqmd/authz-http": minor
---

Adds `@ricardoqmd/authz-http`: a reference `AuthorizationTransport` over `fetch`, built by
`createHttpTransport`. Every part of it is configuration — the base URL, the header the
authorization context travels in, how a token is obtained, and `fetch` itself, which is injectable
and defaults to the global.

It exists to close a documented trap in the core. The core discards a response whose `app` or
`contextId` does not match what it asked about, silently and fail-closed, so an adapter that casts a
body without those fields produces a fully denied application with no error state anywhere. This one
**reads both from the response body** — never filling them in from what it asked, which would make
the core's guard tautological — and rejects with a message naming the missing field and the route.
The same applies to the payloads: a `permissions` array, a `decisions` array, and contexts carrying
`contextId`, `label` and a boolean `hasAccess`. The package never guesses a shape.

`403` classifies as `NO_ACCESS_IN_APP` and everything else as `UNAVAILABLE`, overridable through
`classifyError`, which sees the parsed body so a backend that distinguishes several kinds of `403`
can be understood without this package knowing any of them. A `classifyError` that **throws** is
treated as one that returned nothing: the default classification stands and the hook's error is
swallowed, because a bug in consumer code should not turn a handled error into an unhandled one.
`getToken` returning an empty string omits the `Authorization` header just as `null` does — an empty
bearer is the absence of a token, not a token. No text from a response body, no token
and no header value ever reaches a thrown message: the core removed its own `reason` field to keep
server text away from a screen, and this does not reintroduce the leak from below.
