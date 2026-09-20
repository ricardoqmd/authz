# Roadmap

The guiding principle is **stable over comprehensive**: get the core right and prove it
against a real consumer before widening the surface.

## Pre-1.0

While the version is `0.x`, the public surface may change in **minor** versions. That is
deliberate: the contract this library implements has not yet been exercised by a real
consumer, and freezing it before that would freeze its mistakes too.

- [ ] **v0.1.0** — core: the three questions, the state machine for context selection,
      fail-closed defaults, batch splitting, and invalidation on context change.
- [ ] **v0.2.0** — cross-tab coherence and the transport port documented as a stable seam.

Framework bindings are versioned on their own rather than in this train: they change when the framework
changes, not when the model does.

- [x] **`@ricardoqmd/authz-react`** — a React binding.
- [ ] A Vue binding.

## Criteria for 1.0.0

Written up front, so that `0.x` does not become permanent. All of them must hold:

- [ ] **Exercised by a real consumer**, end to end, against a real policy engine — not a
      demo and not a test double.
- [ ] **Public API reviewed and frozen**, with the internals of the state machine hidden
      from consumers.
- [ ] **Test coverage around 80%**, with the security-relevant paths covered by tests that
      fail when the behaviour is mutated — not by tests that merely execute the lines.
      Specifically: failing closed on a missing response, deny on a missing pair, discarding
      everything on a context change, and refusing a response that arrived after a context
      change.
- [ ] **Complete per-package documentation**, including what the library deliberately does
      not do.

## Post-1.0 — demand-driven

Built only when a concrete consumer needs them.

- [ ] Additional framework bindings.
- [ ] A published reference implementation of the transport port.
