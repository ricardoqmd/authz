# @ricardoqmd/authz-core

Framework-agnostic authorization primitives: the decision vocabulary, the render rule
and the fail-closed lookups that every consumer would otherwise reimplement.

> **Status: pre-1.0.** The public surface may change in minor versions until `1.0.0`.

## Install

```bash
pnpm add @ricardoqmd/authz-core
```

## What it gives you today

```ts
import { decisionFor, isRenderable, permissionFor } from "@ricardoqmd/authz-core";

// Type level — what the user may attempt in this application.
isRenderable(permissionFor(menu, "approve")); // conditional renders; absent denies

// Instance level — may the user act on this record?
isRenderable(decisionFor(decisions, "approve", record.id));
```

Both lookups return `DENY` when the pair is absent, and that is the point: a truncated
response, a failed batch chunk or a pair the decision point never returned must not be
able to produce a permit.

`CONDITIONAL` renders. Hiding an action because the answer is "it depends" turns
*depends* into *no*.

## What it does not do

- It does not talk to a policy engine. The browser never reaches one; the application's
  backend is the enforcement point and re-decides every action.
- It does not accept a subject, a role or a person identifier from the caller.
- It has no mock adapter, and will not get one.

## License

MIT © ricardoqmd
