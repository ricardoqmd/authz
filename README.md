# @ricardoqmd/authz

> Framework-agnostic authorization primitives for SPAs: permission menus, batched
> instance-level decisions, and a switchable authorization context — with a pluggable
> transport.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![pnpm](https://img.shields.io/badge/pnpm-9-orange)](https://pnpm.io/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-blue)](https://www.typescriptlang.org/)

> **Status: pre-1.0.** The public surface may change in minor versions until `1.0.0`.
> The criteria for reaching `1.0.0` are written in [ROADMAP.md](./ROADMAP.md).

## Why?

An SPA that renders a menu, a screen or a button according to what the user may do has
to answer three different questions, and answering them badly is how authorization bugs
are born:

1. **Under which context am I working?** A person can hold several concurrent
   authorization contexts — several employments, organizations, tenants — and the same
   person may hold a different role in each one. Only one is active at a time, and it is
   a choice made per session by the client, not a fact about the subject.
2. **What may I attempt in this application?** A type-level list, used to paint the menu.
3. **May I act on *these* records?** An instance-level answer, resolved in one batch per
   page — never one request per row.

This library packages those three questions once, together with the parts that are easy
to get wrong: failing closed, invalidating everything when the active context changes, and
splitting a batch that exceeds the decision endpoint's cap. Keeping several open tabs coherent is
not in any package yet.

## Design rules it enforces

- **The browser never reaches the policy engine.** The application's own backend is the
  enforcement point and resolves the subject from the validated token. **No type in this
  library accepts a subject, a role or a person identifier from the client** — if the type
  allowed it, some consumer would fill it in.
- **Fail closed.** No response means zero permissions; a pair missing from a decision
  response means *deny*. There is no mock adapter, and there will not be one.
- **"It depends" is rendered, not hidden.** A conditional decision paints the action:
  hiding on uncertainty turns *depends* into *no*, and that is what makes people ask for
  an administrator role for everything.
- **A forbidden response is a normal outcome**, not a broken session.
- **The transport is injected.** The library does not know which host answers, nor what
  the active context means in your domain — it only knows that when the context changes,
  everything derived from it must be discarded.

## Packages

| Package | Description |
| ------- | ----------- |
| `@ricardoqmd/authz-core` | What a subject may do in one application: the decision vocabulary, the render rule and the session. **No context concept.** |
| `@ricardoqmd/authz-context` | The authorization context a subject works under: listing, choosing, and one permissions session per context |
| `@ricardoqmd/authz-http` | A reference `AuthorizationTransport` over `fetch`, with an optional authorization-context header |

Bindings for React and Vue are planned; see [ROADMAP.md](./ROADMAP.md).

## Install

```bash
pnpm add @ricardoqmd/authz-core
```

## Development

```bash
pnpm install
pnpm build
pnpm test
```

## License

MIT © ricardoqmd
