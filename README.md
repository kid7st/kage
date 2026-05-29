# kage 🥷（影分身）

A tiny CLI that casts **Kage Bunshin (影分身)** on your git repo — copying it into an isolated sibling folder,
dropping you straight into [pi](https://github.com/earendil-works) to work in parallel, then merging the session
memory back when you're done.

> 影分身术：造一个独立实体副本，带着本体的记忆出去独立行动；消散时记忆回流本体。

## Why

Running multiple agent sessions against the same repo at once → they edit the same files and collide on branches.
kage gives each parallel session its **own independent copy** of the repo — like a second engineer on a second
machine: separate working tree, separate commits/push/PR, merge on GitHub. On macOS APFS the copy is a `cp -c`
clonefile (copy-on-write): near-instant and space-free until files diverge, and it keeps `node_modules` / `.env` /
build caches intact, so the clone can build & test immediately.

## Install

```bash
git clone <this-repo> ~/coding/kage
npm link            # or: ln -s ~/coding/kage/bin/kage.mjs /usr/local/bin/kage
```

Requires `git`, `pi`, and Node ≥ 18 on your PATH.

## Usage

```bash
cd ~/code/my-app
kage                       # kage bunshin . → ../my-app--kage-<ts>, seed recent context, open pi -c
kage --name fix-login      # name the clone folder: ../my-app--fix-login
kage /path/to/other-repo   # clone a different repo (path defaults to cwd)
```

`kage` copies the repo, **does not create a branch** (you/the agent branch yourself, like a real second machine),
seeds the clone's pi session with your **last 5 turns** of context, and launches `pi -c` inside the clone.
When you quit pi you're back in your original shell. Then:

```bash
kage finish fix-login      # safety-check → merge session memory back → delete the clone
kage list                  # list active clones of this repo
kage pull .env config/x    # (run inside a clone) copy specific files back to the origin
```

### Commands

| Command | Where | What |
|---|---|---|
| `kage [path] [--name x] [--blank] [--recent N]` | origin repo | Copy repo to `../<repo>--<name>` (default name `kage-<ts>`), seed last N turns (default 5; `--blank` = none), launch `pi -c`. |
| `kage finish [name] [--force]` | origin (or inside clone) | Refuse if the clone has uncommitted / unpushed work (`--force` overrides), merge its session memory back (deduped), delete the clone. Auto-picks when there's one clone. |
| `kage list` | origin repo | List active clones. |
| `kage pull <path...>` | inside a clone | Copy specific files/dirs (even gitignored ones) back to the origin at the same relative path. |

## Design invariants

1. **Isolation** — the clone is a full independent copy (its own `.git`).
2. **Code flows back only via git/PR** — kage never copies the clone's working tree onto the origin (that would
   re-introduce the collisions it avoids). `finish` makes you commit + push first.
3. **Memory flows via `~/.pi`** — context is seeded in on create, and merged back on finish. These are session
   `.jsonl` files (not the working tree), so there's zero collision risk. The seeded prefix is **deduped** on the
   way back (only the clone's new turns are kept), so you don't get two overlapping sessions.
4. **The origin is read-only** to kage — it only copies out and writes session memory; it never touches the
   origin's working tree.

## Notes & caveats

- The copy is a snapshot of the origin's **current** state, including uncommitted changes.
- Context seed reads the origin's **most recent** session file. Use `--blank` if that's not the one you want.
- The clone stays on the origin's current branch — **create a feature branch before committing** (kage prints a reminder).
- `kage finish` deletes the clone; run it from the origin (after quitting pi), or from inside the clone (it'll tell you to `cd` back).
- **Submodule** repos: submodule `.git` pointers are absolute and break on copy — run `git submodule update` in the clone.
- Non-APFS / non-reflink filesystems fall back to a full (heavier) copy.
- Session storage is assumed at `~/.pi/agent/sessions`; override with `KAGE_SESSIONS_DIR`.

## License

MIT
