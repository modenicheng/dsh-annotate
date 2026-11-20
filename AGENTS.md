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
