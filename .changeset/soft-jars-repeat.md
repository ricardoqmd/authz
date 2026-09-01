---
"@ricardoqmd/authz-core": minor
---

Adds the transport port, the authorization-context state machine and batched decisions.
`AuthorizationTransport` is the interface a consumer implements — it takes no subject, no
role and no token, so the library can never assert an identity. `createAuthorizationSession`
turns the contexts a subject holds into a state machine that keeps "no contexts", "no access
in this app" and "no answer was obtained" apart, auto-selects when there is only one context,
and drops answers that arrive after the context changed. `splitDecisionRequest` breaks a
request into chunks within a cap the caller supplies, losing no pair and duplicating none;
a chunk whose call fails contributes nothing, so its pairs stay denied.

The session starts in `IDLE` and only leaves it when `start()` is called; `start()` is a
re-initialisation, so it drops the active context and the decision cache and ignores its own
late answers. `decide` accepts only what it asked for: a response labelled with another
context or another app is discarded whole, a pair that was not requested is discarded, and
discarding is silent and fail-closed — absent resolves to `DENY`. A menu labelled with another
context is `UNAVAILABLE`, not `READY`. `decide` also honours `NO_ACCESS_IN_APP` and asks
nothing. `UNAVAILABLE` no longer carries a `reason`: the core does not propagate transport
text it cannot vouch for. The decision cache is bounded by `maxCachedDecisions` (default
`5000`, oldest-first eviction), and `splitDecisionRequest` requires an integer cap.

A pair that comes back more than once — within a response or across two chunks — is collapsed
to a single entry under deny-overrides (`DENY` > `CONDITIONAL` > `PERMIT`) before anything is
returned or cached, so the returned array and the cache can never disagree about it. An effect
outside the declared union collapses restrictively rather than permissively, and the cache and
pair keys are length-prefixed so no identifier can forge another pair's key. The order of the
array `decide` returns is unspecified — it is a lookup table, read through `decisionFor`.
