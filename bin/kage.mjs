#!/usr/bin/env node
/**
 * kage 🥷 — cast the Shadow Clone Jutsu on a git repo.
 *
 * Copy the current repo into an isolated sibling folder (its own working tree and .git),
 * drop straight into `pi` to work in parallel, then `kage finish` merges the session memory
 * back into the original and deletes the clone.
 *
 * Design invariants:
 *   1. Isolation   — a clone is a full independent copy (its own .git).
 *   2. Code flows back only via git/PR — kage never copies the working tree back onto the origin.
 *   3. Memory flows via ~/.pi — recent context is seeded in on create and merged back on finish
 *      (deduped). These are session .jsonl files, not the working tree, so there's no collision.
 *   4. The origin is read-only to kage — it only copies out and writes session memory.
 *
 * Commands:
 *   kage [path] [--name x] [--blank] [--recent N]   clone repo + launch pi (path defaults to cwd)
 *   kage finish [name] [--force]                     check -> merge memory back -> delete clone
 *   kage list                                        list clones of the current repo
 *   kage pull <path...>                              (inside a clone) copy files back to the origin
 */

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";

const MARKER = ".kage.json";
const SESSIONS = process.env.KAGE_SESSIONS_DIR || join(homedir(), ".pi", "agent", "sessions");

// ── helpers ────────────────────────────────────────────────────────────────
function sh(cmd, args, opts = {}) {
	const r = spawnSync(cmd, args, { encoding: "utf8", ...opts });
	return { ok: r.status === 0, out: (r.stdout || "").trim(), err: (r.stderr || "").trim(), code: r.status };
}
const git = (cwd, args) => sh("git", args, { cwd });
const die = (msg) => {
	console.error(`✗ ${msg}`);
	process.exit(1);
};
const info = (msg) => console.error(msg);

/** Absolute path -> pi's session dir name: /a/b -> --a-b-- */
const encodeCwd = (abs) => `--${abs.replace(/^\//, "").replace(/\//g, "-")}--`;
const sessionDirFor = (repoAbs) => join(SESSIONS, encodeCwd(repoAbs));

function repoTopLevel(cwd) {
	const r = git(cwd, ["rev-parse", "--show-toplevel"]);
	return r.ok ? r.out : undefined;
}

function readMarker(dir) {
	const p = join(dir, MARKER);
	if (!existsSync(p)) return undefined;
	try {
		return JSON.parse(readFileSync(p, "utf8"));
	} catch {
		return undefined;
	}
}

function mtime(p) {
	try {
		return statSync(p).mtimeMs;
	} catch {
		return 0;
	}
}

/** Copy a whole directory: clonefile on macOS, reflink on Linux, plain copy as fallback. */
function copyTree(src, dst) {
	const isMac = process.platform === "darwin";
	let r = sh("cp", isMac ? ["-c", "-R", src, dst] : ["--reflink=auto", "-R", src, dst]);
	if (!r.ok) r = sh("cp", ["-R", src, dst]);
	return r;
}

function tsName() {
	const d = new Date();
	const p = (n) => String(n).padStart(2, "0");
	return `kage-${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function parseArgs(argv) {
	const positional = [];
	const flags = {};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a.startsWith("--")) {
			const eq = a.indexOf("=");
			if (eq >= 0) flags[a.slice(2, eq)] = a.slice(eq + 1);
			else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) flags[a.slice(2)] = argv[++i];
			else flags[a.slice(2)] = true;
		} else positional.push(a);
	}
	return { positional, flags };
}

// ── seed: write the origin's last N turns into the clone's session dir ───────
/** Returns { seedFile, seedLeafId } or undefined when seeding isn't possible. */
function seedSession(originRepo, cloneDir, recentTurns) {
	const srcDir = sessionDirFor(originRepo);
	if (!existsSync(srcDir)) return undefined;
	const files = readdirSync(srcDir)
		.filter((f) => f.endsWith(".jsonl"))
		.map((f) => ({ f, m: mtime(join(srcDir, f)) }))
		.sort((a, b) => b.m - a.m);
	if (files.length === 0) return undefined;
	const srcFile = join(srcDir, files[0].f);

	const lines = readFileSync(srcFile, "utf8").split("\n").filter((l) => l.trim());
	if (lines.length < 2) return undefined;
	const entries = lines.slice(1).map((l) => JSON.parse(l));
	const byId = new Map(entries.map((e) => [e.id, e]));

	// Walk from the last entry up via parentId to get the current branch in chronological order.
	let cur = entries[entries.length - 1];
	const branch = [];
	while (cur) {
		branch.unshift(cur);
		cur = cur.parentId ? byId.get(cur.parentId) : undefined;
	}
	const messages = branch.filter((e) => e.type === "message");
	if (messages.length === 0) return undefined;

	const userIdx = [];
	messages.forEach((e, i) => {
		if (e.message?.role === "user") userIdx.push(i);
	});
	const start = userIdx.length > recentTurns ? userIdx[userIdx.length - recentTurns] : 0;
	const kept = messages.slice(start);

	const destDir = sessionDirFor(cloneDir);
	mkdirSync(destDir, { recursive: true });
	const id = randomUUID();
	const ts = new Date().toISOString();
	const fname = `${ts.replace(/[:.]/g, "-")}_${id}.jsonl`;
	const header = { type: "session", version: 3, id, timestamp: ts, cwd: cloneDir, parentSession: srcFile };
	const out = [JSON.stringify(header)];
	let prev = null;
	for (const e of kept) {
		out.push(JSON.stringify({ ...e, parentId: prev }));
		prev = e.id;
	}
	writeFileSync(join(destDir, fname), out.join("\n") + "\n");
	return { seedFile: fname, seedLeafId: prev };
}

// ── merge session memory back (deduped) ─────────────────────────────────────
/** Copy the clone's session dir back to the origin; strip the seeded prefix via seedLeafId. */
function mergeBack(cloneDir, originRepo, marker) {
	const srcDir = sessionDirFor(cloneDir);
	if (!existsSync(srcDir)) return 0;
	const destDir = sessionDirFor(originRepo);
	mkdirSync(destDir, { recursive: true });
	let n = 0;
	for (const f of readdirSync(srcDir)) {
		if (!f.endsWith(".jsonl")) continue;
		const dest = join(destDir, f);
		if (existsSync(dest)) continue;
		const lines = readFileSync(join(srcDir, f), "utf8").split("\n").filter((l) => l.trim());
		if (lines.length === 0) continue;
		let header;
		try {
			header = JSON.parse(lines[0]);
		} catch {
			continue;
		}
		header.cwd = originRepo;
		let body = lines.slice(1);

		// Dedupe: if this is the seeded session, drop everything up to and including seedLeafId.
		if (marker?.seedFile === f && marker?.seedLeafId) {
			const idx = body.findIndex((l) => {
				try {
					return JSON.parse(l).id === marker.seedLeafId;
				} catch {
					return false;
				}
			});
			if (idx >= 0) {
				body = body.slice(idx + 1);
				if (body.length === 0) continue; // clone added nothing on top of the seed
				const first = JSON.parse(body[0]);
				first.parentId = null; // re-root
				body[0] = JSON.stringify(first);
			}
			// seedLeafId not found -> copy the whole thing (safe fallback, may overlap)
		}
		writeFileSync(dest, [JSON.stringify(header), ...body].join("\n") + "\n");
		n++;
	}
	// Remove the clone's now-orphaned session dir under ~/.pi (pi has exited, safe to delete).
	try {
		rmSync(srcDir, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
	return n;
}

// ── subcommands ─────────────────────────────────────────────────────────────
function cmdNew(argv) {
	const { positional, flags } = parseArgs(argv);
	const targetPath = positional[0] ? resolve(positional[0]) : process.cwd();
	const blank = !!flags.blank;
	const recent = Math.max(1, parseInt(flags.recent, 10) || 5);

	const repoRoot = repoTopLevel(targetPath);
	if (!repoRoot) die(`not a git repository: ${targetPath}`);
	if (existsSync(join(repoRoot, MARKER))) die("already inside a clone; run kage from the origin repo");

	const name = (typeof flags.name === "string" && flags.name) || tsName();
	const safe = name.replace(/\//g, "-");
	const cloneDir = join(dirname(repoRoot), `${basename(repoRoot)}--${safe}`);
	if (existsSync(cloneDir)) die(`directory already exists: ${cloneDir}`);

	const cp = copyTree(repoRoot, cloneDir);
	if (!cp.ok) die(`copy failed: ${cp.err}`);

	// Note: kage does NOT create a branch. The clone stays on the origin's current branch,
	// just like a fresh checkout on a second machine; you/the agent branch yourself.

	const seed = blank ? undefined : seedSession(repoRoot, cloneDir, recent);
	const marker = {
		originRepo: repoRoot,
		name: safe,
		createdAt: new Date().toISOString(),
		seedFile: seed?.seedFile,
		seedLeafId: seed?.seedLeafId,
	};
	writeFileSync(join(cloneDir, MARKER), JSON.stringify(marker, null, 2));

	const curBranch = git(cloneDir, ["rev-parse", "--abbrev-ref", "HEAD"]).out || "?";
	info("");
	info(`🥷 Shadow clone ready: ${cloneDir}`);
	info(`   origin: ${repoRoot}   branch: ${curBranch}`);
	info(seed ? `   seeded with the origin's last ${recent} turns (pi -c resumes them)` : `   blank clone (no context)`);
	info(`   ⚠️  create a feature branch before committing (the clone is on ${curBranch})`);
	info(`   when done, from the origin run: kage finish ${safe}`);
	info("");

	// Launch pi (resume the seeded session with -c). Returns to your shell when pi exits.
	const piArgs = seed ? ["-c"] : [];
	const r = spawnSync("pi", piArgs, { cwd: cloneDir, stdio: "inherit" });
	if (r.error) {
		if (r.error.code === "ENOENT") die("pi not found (make sure it is installed and on your PATH)");
		die(`failed to launch pi: ${r.error.message}`);
	}
	info("");
	info(`↩︎  left the clone's pi. To finish: kage finish ${safe}`);
}

function cmdFinish(argv) {
	const { positional, flags } = parseArgs(argv);
	const force = !!flags.force;

	// Locate the clone: either we're inside it, or we're in the origin (by name or uniqueness).
	const here = repoTopLevel(process.cwd());
	let cloneDir, originRepo, marker;
	const hereMarker = here && readMarker(here);
	if (hereMarker) {
		cloneDir = here;
		marker = hereMarker;
		originRepo = marker.originRepo;
	} else {
		if (!here) die("not a git repository");
		originRepo = here;
		const clones = listClones(originRepo);
		if (clones.length === 0) die("no shadow clones found for this repo");
		const pick = positional[0]
			? clones.find((c) => c.name === positional[0] || basename(c.dir) === positional[0])
			: clones.length === 1
				? clones[0]
				: undefined;
		if (!pick) {
			info("multiple clones — specify a name:");
			clones.forEach((c) => info(`  ${c.name}`));
			process.exit(1);
		}
		cloneDir = pick.dir;
		marker = pick.marker;
	}

	// Safety checks (fail visibly; don't silently delete work).
	if (!force) {
		const status = git(cloneDir, ["status", "--porcelain"]);
		const dirty = status.out.split("\n").filter((l) => l.trim() && l.slice(3).trim() !== MARKER);
		if (dirty.length > 0) die("clone has uncommitted changes; commit them or pass --force");
		const up = git(cloneDir, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
		if (!up.ok) die("clone's branch has no upstream (not pushed); push it or pass --force");
		const ahead = git(cloneDir, ["rev-list", "@{u}..HEAD", "--count"]);
		if (ahead.ok && ahead.out !== "0") die(`clone has ${ahead.out} unpushed commit(s); push them or pass --force`);
	}

	const n = mergeBack(cloneDir, originRepo, marker);

	// Delete the clone (move out of it first so we don't delete our own cwd).
	try {
		process.chdir(originRepo);
	} catch {
		/* ignore */
	}
	rmSync(cloneDir, { recursive: true, force: true });

	info(`💨 Clone dispelled: merged ${n} session(s) back, removed ${cloneDir}`);
	if (hereMarker) info(`   your shell is still in the deleted dir; cd back to: ${originRepo}`);
}

function listClones(originRepo) {
	const parent = dirname(originRepo);
	const out = [];
	for (const name of readdirSync(parent)) {
		const dir = join(parent, name);
		const m = readMarker(dir);
		if (m && m.originRepo === originRepo) out.push({ dir, name: m.name || basename(dir), marker: m });
	}
	return out;
}

function cmdList() {
	const repoRoot = repoTopLevel(process.cwd());
	if (!repoRoot) die("not a git repository");
	const clones = listClones(repoRoot);
	if (clones.length === 0) {
		info("No shadow clones.");
		return;
	}
	info("Shadow clones:");
	for (const c of clones) {
		const br = git(c.dir, ["rev-parse", "--abbrev-ref", "HEAD"]).out || "?";
		info(`  ${c.name}  [${br}]  ${c.dir}`);
	}
}

function cmdPull(argv) {
	const { positional } = parseArgs(argv);
	const cloneDir = repoTopLevel(process.cwd());
	const marker = cloneDir && readMarker(cloneDir);
	if (!marker) die("kage pull only runs inside a clone (edit the origin directly otherwise)");
	if (positional.length === 0) die("usage: kage pull <relative-path> [more paths...]");
	const originRepo = marker.originRepo;
	const cloneRoot = cloneDir.endsWith(sep) ? cloneDir : cloneDir + sep;
	const originRoot = originRepo.endsWith(sep) ? originRepo : originRepo + sep;
	let done = 0;
	for (const rel of positional) {
		const src = resolve(cloneDir, rel);
		const dst = resolve(originRepo, rel);
		if (!src.startsWith(cloneRoot) || !dst.startsWith(originRoot)) {
			info(`✗ path escapes the repo, skipped: ${rel}`);
			continue;
		}
		if (!existsSync(src)) {
			info(`✗ not found in clone, skipped: ${rel}`);
			continue;
		}
		if (existsSync(dst)) rmSync(dst, { recursive: true, force: true });
		mkdirSync(dirname(dst), { recursive: true });
		const cp = copyTree(src, dst);
		if (!cp.ok) {
			info(`✗ copy failed ${rel}: ${cp.err}`);
			continue;
		}
		done++;
	}
	info(`📤 Pulled ${done}/${positional.length} path(s) from the clone back to the origin (${originRepo})`);
}

const HELP = `kage 🥷 — Shadow Clone Jutsu for your git repo

Usage:
  kage [path] [--name <x>] [--blank] [--recent <N>]   clone repo + launch pi (path defaults to cwd)
  kage finish [name] [--force]                         check -> merge memory back -> delete clone
  kage list                                            list clones of the current repo
  kage pull <path...>                                  (inside a clone) copy files back to the origin

Options:
  --name <x>    name the clone folder/<repo>--<x> (default: kage-<timestamp>)
  --blank       don't seed the clone with the origin's recent context
  --recent <N>  number of recent turns to seed (default: 5)
  --force       skip the uncommitted/unpushed safety check in finish

Env:
  KAGE_SESSIONS_DIR   pi session storage (default: ~/.pi/agent/sessions)`;

// ── entry ───────────────────────────────────────────────────────────────────
function main() {
	const [sub, ...rest] = process.argv.slice(2);
	switch (sub) {
		case undefined:
		case "new":
			return cmdNew(sub === "new" ? rest : process.argv.slice(2));
		case "finish":
			return cmdFinish(rest);
		case "list":
			return cmdList();
		case "pull":
			return cmdPull(rest);
		case "-h":
		case "--help":
			return info(HELP);
		case "-v":
		case "--version": {
			const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
			return info(pkg.version);
		}
		default:
			// Unknown subcommand -> treat as `kage <path>`.
			return cmdNew(process.argv.slice(2));
	}
}

main();
