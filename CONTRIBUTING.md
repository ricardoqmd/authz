# Contributing

Thanks for your interest. This is a small, opinionated library; the fastest way to get a
change merged is to open an issue first and agree on the shape.

## Ground rules

- **Security defaults are not negotiable.** Anything that makes the library fail *open* —
  a mock adapter, a default that grants permissions when a response is missing, a type that
  accepts a subject or a role from the client — will be declined regardless of how
  convenient it is.
- **Behaviour is proven by tests that fail when the behaviour changes.** A test that passes
  whether or not the guard is there does not count as coverage of that guard.
- **Conventional Commits.** Versioning is derived from changesets, not from commit
  messages, but the history stays readable.

## Working locally

```bash
pnpm install
pnpm build
pnpm test
pnpm typecheck
```

## Submitting a change

1. Branch from `main` (`feat/`, `fix/`, `chore/`, `docs/`, `refactor/`).
2. Add a changeset: `pnpm changeset`.
3. Open a pull request using the template. CI must be green.
