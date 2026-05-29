# kage 🥷（影分身）

A [pi](https://github.com/earendil-works) extension that spins off a **memory-carrying shadow clone** of your
current session so two agent sessions can work the same repo in parallel — without stepping on each other's
files or branches. When the clone is done, its conversation memory flows back to the original.

> 影分身术：造一个独立实体副本，带着本体的记忆出去独立行动；消散时记忆回流本体。

## The problem

Running multiple pi sessions against the same repo at once → they edit the same files, fight over the working
tree, and collide on branches. The fix is to give each parallel session its **own independent copy of the repo**,
like a second engineer on a second machine: separate branch, separate push, separate PR, merge on GitHub.

## Why a full folder copy (not `git worktree`)

A `git worktree` shares one `.git`, which causes coupling headaches:

- can't `checkout` the same branch in two worktrees
- shared stash / refs / config
- fresh checkout means **no `node_modules`, no `.env`, no build cache** → the clone can't build/test until you reinstall

A full directory copy is a truly independent repo (own `.git`, with `node_modules`/`.env`/caches intact). On macOS
APFS, `cp -c` (clonefile, copy-on-write) makes copying the whole tree near-instant and space-free until files diverge.

## Install

Clone-and-link for local use (auto-discovered + hot-reloadable via `/reload`):

```bash
git clone <this-repo> ~/coding/kage
ln -s ~/coding/kage ~/.pi/agent/extensions/kage
```

Or add the path in `~/.pi/agent/settings.json`:

```json
{ "extensions": ["/Users/you/coding/kage/index.ts"] }
```

## Usage

In your **main** session (the "本体"):

```
/kage new fix-login        # copy repo → ../<repo>--fix-login, switch to branch fix-login,
                           # seed the clone with your last 5 turns of context
```

It prints a `cd "<path>" && pi -c` line. Open that in a new terminal — the clone (`分身`) starts as a
**continuation of your conversation**, but isolated in its own copy. Work, commit, push, open a PR — all independent.

When done, in the **clone** session:

```
/kage finish               # safety-check (refuses if uncommitted / unpushed) →
                           # merge the clone's sessions back into the main repo →
                           # delete the clone dir → exit this session
```

### Commands

| Command | Where | What |
|---|---|---|
| `/kage new [branch] [--blank] [--recent=N]` | main repo | Copy repo to a sibling dir, create/switch branch, seed context. `branch` defaults to `kage-<timestamp>`. `--blank` = no context. `--recent=N` = carry last N user turns (default 5). |
| `/kage finish [--force]` | clone | Safety-check, merge clone sessions back, delete clone, quit. `--force` skips the uncommitted/unpushed guard. |
| `/kage pull <path...>` | clone | Copy specific files/dirs (even gitignored ones) back to the main repo at the same relative path. Out-of-tree paths rejected; overwrites confirmed. |
| `/kage list` | anywhere in repo | List active clones of the current repo. |

## How sync-back works

- **Code** flows back via git/PR. `finish` forces you to commit + push first (or `--force`).
- **Conversation memory** flows back: `finish` copies the clone's session `.jsonl` files into the main repo's
  pi session dir (rewriting the recorded `cwd`), so `/resume` in the main repo shows the clone's work.
- **Gitignored files** (`.env`, build output) are **not** auto-synced — use `/kage pull <path>` for specific ones.
  Auto-merging whole working trees back would re-introduce the collisions this tool avoids.

## Notes & caveats

- pi can't change a running session's cwd, so the clone must be opened manually (`pi -c` to resume the seeded session).
- `finish` ends the clone session (it deletes its own working dir on exit, after `chdir`-ing out).
- Copy is a snapshot of the main repo's **current** state, including uncommitted changes.
- **Submodule** repos: submodule `.git` pointers are absolute paths and break on copy — run `git submodule update` in the clone.
- Non-APFS filesystems have no copy-on-write, so the copy becomes a real (heavier) copy.

## License

MIT
