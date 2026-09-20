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

## Release checklist

Each package carries its own version and its own changeset; they do not move as a set. The reasons, and
what is still coupled while the core is `0.x`, are in
[ADR-001](./docs/decisions/001-independent-versioning.md).

1. Collapse the pending changesets into one that describes the release (see below).
2. **When the core's new version falls outside the range, bump it by hand, before the version step.
   While the core is `0.x`, that is every minor.** The range is the literal peer range, and there are
   now **three** files that carry one: `packages/authz-http/package.json`,
   `packages/authz-context/package.json` and `packages/authz-react/package.json` — and the last carries
   **two** ranges, the core's and `@ricardoqmd/authz-context`'s. All of them, or the one you forget
   publishes a compatibility claim nobody verified. For a core going from `0.1.0` to `0.2.0` it is this
   line, in all three:

   ```diff
      "peerDependencies": {
   -    "@ricardoqmd/authz-core": "^0.1.0"
   +    "@ricardoqmd/authz-core": "^0.2.0"
      },
   ```

   `@ricardoqmd/authz-react` is versioned on its own, so the changeset of the release does not move it: give
   it a changeset of its own with its raised ranges. Without one it keeps the version it has and is not
   published, and the registry goes on declaring the previous ranges.

3. Run the version step on a copy and read its output (see below). **At the release that took the core
   to `0.2.0`, with both ranges raised, it printed
   `Package "@ricardoqmd/authz-context" must depend on the current version of "@ricardoqmd/authz-core":
   "0.1.0" vs "^0.2.0"` twice, the same line for `@ricardoqmd/authz-http` twice, then `All files have
   been updated`, and exited `0`; the three packages came out on `0.2.0` and both ranges stayed
   `^0.2.0`.** With `@ricardoqmd/authz-react` it also prints its own two lines twice each: one for the
   core and one for `@ricardoqmd/authz-context`. A package missing from those lines is one whose range was
   not raised, and it comes out on `1.0.0`: measured with only `authz-http` forgotten, `authz-context` and
   the core came out on `0.2.0` and `authz-http` on `1.0.0`, and measured with only the core's range of
   `authz-react` raised, `authz-react` came out on `1.0.0`.

   **Those lines belong to a release that moves the core, and a release that does not move it prints
   none of them.** Measured at the release of `@ricardoqmd/authz-react@0.1.0`, where the core stayed on
   `0.2.0`: the version step printed `All files have been updated` and nothing else, because no package
   the others declare was entering the release. Their absence is not a finding there. What is read
   instead is the diff — exactly two files, the consumed changeset and one line of the released
   package's `package.json` — plus the version number itself, which `--stat` does not show:

   ```bash
   git --no-pager diff packages/<released>/package.json
   ls packages/<released>/CHANGELOG.md
   ```

4. Release, and then **verify against the registry** — see below.

## After a release: the tool's success message is not proof

**`changeset publish` can report success for a package that never reached the registry, and it creates
the git tag anyway.** Measured at the release of `@ricardoqmd/authz-react@0.1.0`: the npm CLI died
mid-authentication with `Exit handler never called!`, Changesets printed
`success packages published successfully` and `New tag: ...`, and the registry answered `404` to
`npm view` three minutes later. The success line reports that the child process ended, not that the
tarball landed.

The last step of every release is therefore a read of the registry itself, and nothing else counts:

```bash
npm view <package> versions
```

Two things this rule needs in order to be usable:

- **The account's package listing on the website is not the registry.** It is a cached index and it
  lags behind both a successful publish and a failed one, in both directions.
- **A `404` right after publishing is ambiguous**, and the way to resolve it is to publish again rather
  than to guess: `npm publish --access public` from the package directory answers `E403` with
  `cannot publish over the previously published version` if it was in fact published, and otherwise
  publishes it. Never resolve it by bumping the version — that publishes a number no change
  corresponds to, and leaves the git tag pointing at something the registry does not have.

## Before a release: run the version step on a copy and read its output

**Always, and before every release:**

```bash
cp -R . /tmp/release-check && cd /tmp/release-check
npx changeset version
git --no-pager diff --stat        # which versions actually came out, and what the notes say
```

Then throw the copy away.

Two things need reading, and neither is visible from the changeset files alone.

**The version numbers.** A `minor` in a changeset is not a promise about the number that comes out.
Changesets applies a **major** to a package whose *peer* dependency was bumped out of range, so a
package declaring `"@ricardoqmd/authz-core": "workspace:^"` under `peerDependencies` goes to `1.0.0`
from two `minor` changesets and nothing in either file says so.

**What decides it is the range, not the fact that it is a peer.** `workspace:^` and `workspace:*`
resolve against the version the core has *right now*, so bumping the core takes them out of range and
the major follows. A **literal** range already covers the version about to be published, stays in
range, and no major happens. Measured, all four combinations **at the first release** — the one that
takes both packages from `0.0.0` to `0.1.0`:

| peer range | experimental flag | `authz-http` comes out |
|---|---|---|
| `workspace:^` | either | `1.0.0` |
| `workspace:*` | either | `1.0.0` |
| `^0.1.0` | either | `0.1.0` |
| `>=0.1.0` | either | `0.1.0` |

**That table measured the first release and says nothing about any other.** Measured again at the
**second** — a core-only `minor`, with the published range left alone — the experimental flag stops
being irrelevant and becomes the only thing separating the two outcomes:

| peer range | experimental flag | core | `authz-http` comes out | peer range afterwards |
|---|---|---|---|---|
| `^0.1.0` | off | `0.2.0` | `1.0.0` | `^0.2.0` |
| `^0.1.0` | on | `0.2.0` | `1.0.0` | `^0.2.0` |
| `>=0.1.0` | off | `0.2.0` | `1.0.0` | `>=0.2.0` |
| `>=0.1.0` | on | `0.2.0` | `0.1.0` | `>=0.1.0` |

That is why this repository declares a literal range — `"@ricardoqmd/authz-core": "^0.1.0"` at the first
release, `"^0.2.0"` at the second. It publishes the same range
`workspace:^` would have published, and keeps the dependency a peer — a consumer must not end up with
two copies of the core's types. The experimental flag changes nothing for it at either release, which
is why what keeps this range true is the checklist item below and not an option.

**A configuration that survives repeated releases exists, and it must not be used. It survives by
ceasing to maintain the range — and a range that is not maintained lies.** A literal range on a `0.x`
package covers only its minor line; that is semver, and no option changes it without breaking
something else. The checklist item is the correct mechanism, because the alternative publishes a
compatibility claim nobody verified.

That is measured and not argued. The surviving row is the last one above, and taking the same
configuration through a core **major** is what disqualifies it:

| peer range | experimental flag | core | `authz-http` comes out | peer range afterwards |
|---|---|---|---|---|
| `>=0.1.0` | on | `1.0.0` | `0.1.0` | `>=0.1.0` |

`authz-http@0.1.0` reaches the registry declaring it works with `>=0.1.0` of a core that has just
broken compatibility, and a consumer installing the pair gets no peer warning at all — and that
warning is the one thing a peer range exists to produce. The range survived by no longer describing
anything. The option that buys this is called
`___experimentalUnsafeOptions_WILL_CHANGE_IN_PATCH`.

**Its one real cost, and it is a checklist item:** a literal range does **not** follow the core by
itself. **When the core's new version falls outside the range, bump it by hand. While the core is
`0.x`, that is every minor.** The ranges live in the three files the release checklist names;
`workspace:^` did that automatically, and this does not.

**Why the raised range does not bring the major with it.** Between raising the range and the version
step, the range names the version about to be published and not the one on disk, so `changeset version`
prints `must depend on the current version of "@ricardoqmd/authz-core"` with the version on disk and the
range — `"0.0.0" vs "^0.1.0"` at the first release, `"0.1.0" vs "^0.2.0"` at the second — and does not
count that package as a dependent of the core while it does. A package that is not a dependent is not
bumped for the core's bump: it comes out on the version its own changeset asks for. The line resolves
the moment the bump lands, and `install`, `build` and `test` are green on both sides of it — at the second
release, `typecheck` too.

**The release notes.** The notes are assembled from every pending changeset, so a feature added and
removed across several unpublished rounds is announced twice — once as an addition and once as a
removal — with no way for a reader to tell which sentence describes the code they installed. A
changelog declares what changed **between two published versions**, not what happened in the working
tree. Collapse the pending changesets before releasing, and describe what the release *is*.

Neither defect is reachable by tests, types or coverage: they live in the release tooling. Running
the command is the only way to see them.
