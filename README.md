# kage 🥷

[![CI](https://github.com/kid7st/kage/actions/workflows/ci.yml/badge.svg)](https://github.com/kid7st/kage/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/pi-kage)](https://www.npmjs.com/package/pi-kage)
[![license](https://img.shields.io/npm/l/pi-kage)](./LICENSE)

> **影分身の術** — cast the **Shadow Clone Jutsu** on your git repo.

<p align="center"><img src="./assets/demo.svg" alt="kage demo" width="100%"></p>

`kage` copies your repo into an isolated sibling folder, drops you straight into
[pi](https://github.com/earendil-works) to work in parallel, and when you're done merges the
session memory back into the original and dispels the clone.

```bash
npm install -g pi-kage
cd my-app
kage                 # 🥷 clone → ../my-app--kage-<ts>, open pi with your recent context
#   ...work in the clone: commit, push, open a PR, quit pi...
kage finish          # 💨 merge the session memory back, delete the clone
```

---

## The problem

Running **multiple agent sessions on the same repo at once** is a mess: they edit the same files,
fight over the working tree, and collide on branches. You end up babysitting merge conflicts
instead of shipping.

## The idea

A shadow clone is a **full, independent copy** of the repo — like a second engineer on a second
machine. Each parallel session gets its own working tree, its own branch, its own commits and PR.
Code merges the normal way: on GitHub. No local collisions, ever.

And like a real Naruto shadow clone, it **carries your memory out** (the clone's pi session is
seeded with your recent conversation) and **returns it on dispel** (the clone's session is merged
back into the original when you `finish`).

Why a full folder copy instead of `git worktree`? A worktree shares one `.git`, which means you
can't check out the same branch twice, you share stash/refs, and you get a *fresh* checkout with no
`node_modules` / `.env` / build cache. A real copy avoids all of that. On macOS APFS the copy is a
`cp -c` clonefile (copy-on-write): near-instant and space-free until files diverge.

## Install

```bash
npm install -g pi-kage     # then use `kage` anywhere
# or, no install:
npx pi-kage
```

From source:

```bash
git clone https://github.com/kid7st/kage
cd kage && npm link
```

Requires **git**, [**pi**](https://github.com/earendil-works), and **Node ≥ 18** on your `PATH`.

## Lifecycle

```
  origin repo (you)                         shadow clone (independent copy)
  ─────────────────                         ──────────────────────────────
  $ kage --name fix-login   ──copy + seed──►  ../my-app--fix-login
                                              $ pi -c   (your recent context, resumed)
                                                · git switch -c fix-login
                                                · edit / commit / push / open PR
                                                · quit pi
  $ kage finish fix-login   ◄──merge memory──  (session .jsonl, deduped)
        · safety check (committed? pushed?)
        · merge session back into ~/.pi
        · delete the clone folder
  code arrives via the merged GitHub PR ✓
```

## Usage

```bash
cd ~/code/my-app

kage                       # clone . → ../my-app--kage-<ts>, seed recent context, open `pi -c`
kage --name fix-login      # name the clone folder/branch suffix: ../my-app--fix-login
kage /path/to/other-repo   # clone a different repo (path defaults to cwd)
kage --blank               # don't carry any context into the clone
kage --recent 10           # seed the last 10 turns instead of the default 5

# back in the origin after you quit the clone's pi:
kage list                  # show active clones of this repo
kage finish fix-login      # check → merge memory back → delete the clone
kage finish --force        # skip the uncommitted/unpushed guard

# inside a clone, to retrieve a non-git file (e.g. a generated .env):
kage pull .env config/local.json
```

### Commands

| Command | Run from | What it does |
|---|---|---|
| `kage [path] [--name x] [--blank] [--recent N]` | origin repo | Copy the repo to `../<repo>--<name>` (default `kage-<ts>`), seed the clone's pi session with the last N turns (default 5; `--blank` for none), and launch `pi -c`. |
| `kage finish [name] [--force]` | origin (or inside the clone) | Refuse if the clone has uncommitted or unpushed work (`--force` overrides), merge its session memory back (deduped), then delete the clone. Auto-selects when there's only one. |
| `kage list` | origin repo | List active clones of the current repo. |
| `kage pull <path...>` | inside a clone | Copy specific files/dirs (even gitignored ones) back to the origin at the same relative path. |
| `kage --help` / `--version` | anywhere | Usage / version. |

## How it works

Four invariants keep parallel work safe and lossless:

1. **Isolation** — a clone is a full independent copy with its own `.git`.
2. **Code flows back only via git/PR.** kage never copies the clone's working tree onto the origin —
   that would re-create the very collisions it avoids. `finish` makes you commit + push first.
3. **Memory flows through `~/.pi`.** Context is *seeded in* on create and *merged back* on finish.
   These are pi session `.jsonl` files (not the working tree), so there's zero collision risk. The
   seeded prefix is **deduped** on the way back — only the clone's new turns are kept, so you don't
   end up with two overlapping sessions.
4. **The origin is read-only to kage** — it only copies out and writes session memory; it never
   touches the origin's working tree, even while another session is live there.

## Notes & caveats

- The copy is a snapshot of the origin's **current** state, **including uncommitted changes**.
- kage **doesn't create a branch** — the clone stays on the origin's current branch, so create a
  feature branch before committing (kage prints a reminder).
- Context seeding reads the origin's **most recent** session file. Pass `--blank` if that isn't the
  one you want carried over.
- **Submodules**: a submodule's `.git` pointer is an absolute path and breaks on copy — run
  `git submodule update --init` in the clone.
- Non-APFS / non-reflink filesystems fall back to a full (heavier) copy.
- Session storage is assumed at `~/.pi/agent/sessions`; override with `KAGE_SESSIONS_DIR`.

## Development

```bash
npm run lint     # syntax check
npm test         # node:test smoke tests (temp repos, no network)
```

Releases publish automatically: bump `version` in `package.json`, then

```bash
git tag vX.Y.Z && git push origin main vX.Y.Z
```

CI runs lint + tests and `npm publish --provenance` on any `v*` tag.

## License

[MIT](./LICENSE)
