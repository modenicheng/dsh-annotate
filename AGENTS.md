# Agent rules for this repository

These rules bind every AI agent (any harness, any session) working in this
repository. They are not suggestions. Human maintainers may do more; agents
may not.

## Git hooks are load-bearing

- **Never bypass a git hook.** No `git commit --no-verify` / `-n`, no
  `--no-post-rewrite`, no disabling `core.hooksPath`, no
  `git commit` with `HUSKY=0`-style escapes. When `pre-commit` or
  `commit-msg` prints a "bypass once with …" hint, that hint is for human
  maintainers, not for you.
- Hooks exist precisely to constrain agent behavior. A red hook is a signal
  to fix the change (or the environment so the hook can actually run —
  e.g. request the wider sandbox the hook's child processes need), never a
  signal to skip the gate.
- If a hook cannot run for environmental reasons (sandbox EPERM on spawned
  processes, missing toolchain), stop and say so. Do not work around it by
  committing without the hook.

## Releases and packaging are CI-only

- **Never create or push a tag unless the user asks.** A tag is a release
  trigger, not a side effect of committing or pushing `main`. "Commit", "push",
  or "prepare a release" is not a request to tag; if the instruction is
  ambiguous, stop and ask. This applies to every tag, `v*` or otherwise.
- **Agents never publish.** No `npm publish`, no Chrome Web Store / AMO / Edge
  upload, no `gh release upload`, and no local zip presented as a release
  artifact. A release is the tag plus what `.github/workflows/release.yml`
  builds and publishes from it.
- **Local builds are never deliverables.** `node scripts/build-extension.mjs`
  and everything it writes under `dist/` exist for tests, inspection, and local
  QA. Their output must not be uploaded to a store, attached to a release, sent
  to a user, or compared to the published checksums.
- **Even a manual upload uses CI bytes.** The first submission to a store, and
  any manual retry, downloads the artifact from the CI run (or the draft GitHub
  Release it produced), verifies the checksum from `checksums.txt`, and uploads
  that file. The upload is a delivery step, not a build step.
- **If the CI artifact is missing or wrong, fix CI.** Re-run the build for the
  tag, or carry the fix in the next patch version. Never rebuild locally and
  upload it to "save time"; the published bytes and the checksummed bytes must
  be the same bytes.
- Do not create a tag merely to obtain a zip for local testing. Build locally
  for QA, say that it is a QA build, and leave the release path alone.

## Git hygiene

- Run `git status` before any git operation, and read it. If the tree has
  uncommitted changes you did not make, they belong to a parallel session
  or the user: never stash-drop, reset, checkout, or clean them away.
- Commit atomically: one commit is one logical change (feature, fix, or
  docs entry that belongs together). Split mixed working trees by staging
  per file or per hunk instead of lumping unrelated work into one commit.
- Never edit anything under `.git/` directly; only git commands touch it.
- Destructive commands (`reset --hard`, `checkout -- <path>`,
  `clean -fd`, `stash drop`) require: clean confirmation that nothing
  uncommitted will be lost, or an explicit backup (branch or stash) made
  first, in the same command sequence.

## Parallel sessions

Multiple agent sessions share this working tree. Before committing, verify
the staged diff is exactly your change (read `git diff --cached`). Never
`git add -A` across a tree that carries someone else's in-flight work
unless splitting it into separate atomic commits in the same pass.
