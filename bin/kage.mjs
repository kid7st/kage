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
 *   kage [path] [--name x] [--blank] [--recent N]   clone repo + launch pi (no args: interactive)
 *   kage list [--pr]                                 dashboard of clones (+ PR status via gh)
 *   kage finish [name] [--force]                     check -> merge memory back -> delete clone
 *   kage rm [name] [--force]                         discard a clone (no merge)
 *   kage pull <path...>                              (inside a clone) copy files back to the origin
 */

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import readline from "node:readline";

const MARKER = ".kage.json";
const SESSIONS = process.env.KAGE_SESSIONS_DIR || join(homedir(), ".pi", "agent", "sessions");

// ── output helpers ───────────────────────────────────────────────────────────
const TTY = process.stderr.isTTY;
const col = (code, s) => (TTY ? `\x1b[${code}m${s}\x1b[0m` : s);
const paint = {
	bold: (s) => col("1", s),
	dim: (s) => col("90", s),
	red: (s) => col("31", s),
	green: (s) => col("32", s),
	yellow: (s) => col("33", s),
	blue: (s) => col("34", s),
	magenta: (s) => col("35", s),
	cyan: (s) => col("36", s),
};
const info = (msg) => console.error(msg);
const die = (msg) => {
	console.error(`✗ ${msg}`);
	process.exit(1);
};

// ── shell / git helpers ──────────────────────────────────────────────────────
function sh(cmd, args, opts = {}) {
	const r = spawnSync(cmd, args, { encoding: "utf8", ...opts });
	return { ok: r.status === 0, out: (r.stdout || "").trim(), err: (r.stderr || "").trim(), code: r.status };
}
const git = (cwd, args) => sh("git", args, { cwd });

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

// ── clone discovery & status ─────────────────────────────────────────────────
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

function cloneStatus(dir) {
	const branch = git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]).out || "?";
	const st = git(dir, ["status", "--porcelain"]).out;
	const dirty = st.split("\n").some((l) => l.trim() && l.slice(3).trim() !== MARKER);
	const up = git(dir, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
	let ahead = 0;
	let behind = 0;
	if (up.ok) {
		const rl = git(dir, ["rev-list", "--left-right", "--count", "@{u}...HEAD"]);
		if (rl.ok) {
			const [b, a] = rl.out.split(/\s+/).map(Number);
			behind = b || 0;
			ahead = a || 0;
		}
	}
	return { branch, dirty, ahead, behind, hasUpstream: up.ok };
}

/** Best-effort PR lookup via gh; returns { state, number, url } or undefined. */
function prInfo(dir, branch) {
	const r = sh("gh", ["pr", "view", branch, "--json", "state,number,url"], { cwd: dir });
	if (!r.ok) return undefined;
	try {
		return JSON.parse(r.out);
	} catch {
		return undefined;
	}
}

/** True when the clone has no local-only work (clean + pushed) -> safe to remove. */
const isSafeToClean = (s) => !s.dirty && s.hasUpstream && s.ahead === 0;

// ── interactive picker (TUI-lite, arrow keys, no deps) ───────────────────────
/** Returns the chosen index, or -1 when cancelled / non-interactive. */
function select(title, labels) {
	return new Promise((resolve) => {
		if (!process.stdin.isTTY || labels.length === 0) return resolve(-1);
		let idx = 0;
		const n = labels.length;
		const out = process.stderr;
		readline.emitKeypressEvents(process.stdin);
		process.stdin.setRawMode(true);
		process.stdin.resume();
		out.write(`${title}\n`);
		const draw = () =>
			labels.forEach((l, i) => out.write(`\x1b[2K${i === idx ? paint.cyan("❯ ") : "  "}${l}\n`));
		draw();
		const done = (r) => {
			process.stdin.removeListener("keypress", onKey);
			process.stdin.setRawMode(false);
			process.stdin.pause();
			out.write("\n");
			resolve(r);
		};
		const onKey = (str, key) => {
			if (key.name === "up" || str === "k") idx = (idx - 1 + n) % n;
			else if (key.name === "down" || str === "j") idx = (idx + 1) % n;
			else if (key.name === "return") return done(idx);
			else if (key.name === "escape" || str === "q" || (key.ctrl && key.name === "c")) return done(-1);
			else return;
			out.write(`\x1b[${n}A`);
			draw();
		};
		process.stdin.on("keypress", onKey);
	});
}

async function ask(prompt) {
	if (!process.stdin.isTTY) return "";
	const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
	const a = await new Promise((r) => rl.question(prompt, (x) => (rl.close(), r(x))));
	return a.trim();
}

async function confirm(msg) {
	if (!process.stdin.isTTY) return false;
	return /^y(es)?$/i.test(await ask(`${msg} [y/N] `));
}

/** Resolve which clone to act on: inside a clone, by name, only-one, or interactive pick. */
async function pickClone(action, name) {
	const here = repoTopLevel(process.cwd());
	const hm = here && readMarker(here);
	if (hm && !name) return { originRepo: hm.originRepo, clone: { dir: here, name: hm.name || basename(here), marker: hm } };
	const originRepo = hm ? hm.originRepo : here;
	if (!originRepo) die("not a git repository");
	const clones = listClones(originRepo);
	if (clones.length === 0) die("no shadow clones found for this repo");
	if (name) {
		const c = clones.find((x) => x.name === name || basename(x.dir) === name);
		if (!c) die(`no clone named ${name}`);
		return { originRepo, clone: c };
	}
	if (clones.length === 1) return { originRepo, clone: clones[0] };
	const idx = await select(
		`Multiple clones — pick one to ${action}:`,
		clones.map((c) => `${c.name}  ${paint.dim(cloneStatus(c.dir).branch)}`),
	);
	if (idx < 0) return null;
	return { originRepo, clone: clones[idx] };
}

// ── seed: write the origin's last N turns into the clone's session dir ────────
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
	const outl = [JSON.stringify(header)];
	let prev = null;
	for (const e of kept) {
		outl.push(JSON.stringify({ ...e, parentId: prev }));
		prev = e.id;
	}
	writeFileSync(join(destDir, fname), outl.join("\n") + "\n");

	// First user message of the seed, for a transparency hint.
	const firstUser = kept.find((e) => e.message?.role === "user");
	const preview = firstUser ? snippet(firstUser.message.content) : undefined;
	return { seedFile: fname, seedLeafId: prev, turns: userIdx.length > recentTurns ? recentTurns : userIdx.length, preview };
}

function snippet(content) {
	const text = typeof content === "string" ? content : (content || []).map((c) => c.text || "").join(" ");
	const one = text.replace(/\s+/g, " ").trim();
	return one.length > 60 ? one.slice(0, 57) + "…" : one;
}

// ── merge session memory back (deduped) ──────────────────────────────────────
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
				if (body.length === 0) continue;
				const first = JSON.parse(body[0]);
				first.parentId = null;
				body[0] = JSON.stringify(first);
			}
		}
		writeFileSync(dest, [JSON.stringify(header), ...body].join("\n") + "\n");
		n++;
	}
	try {
		rmSync(srcDir, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
	return n;
}

function launchPi(cwd, args) {
	const r = spawnSync("pi", args, { cwd, stdio: "inherit" });
	if (r.error) {
		if (r.error.code === "ENOENT") die("pi not found (make sure it is installed and on your PATH)");
		die(`failed to launch pi: ${r.error.message}`);
	}
}

// ── subcommands ───────────────────────────────────────────────────────────────
async function cmdNew(argv) {
	const { positional, flags } = parseArgs(argv);
	let path = positional[0];

	// Interactive launcher: `kage` with no args, inside a repo that already has clones.
	if (!path && !flags.name && !flags.blank && process.stdin.isTTY) {
		const repoRoot = repoTopLevel(process.cwd());
		const clones = repoRoot ? listClones(repoRoot) : [];
		if (clones.length > 0) {
			const labels = [
				"＋ Create a new shadow clone",
				...clones.map((c) => {
					const s = cloneStatus(c.dir);
					const tag = s.dirty ? paint.yellow(" ●") : isSafeToClean(s) ? paint.green(" ✓") : "";
					return `→ Enter ${c.name}  ${paint.cyan(s.branch)}${tag}`;
				}),
			];
			const idx = await select(`Shadow clones of ${basename(repoRoot)}:`, labels);
			if (idx < 0) return info("cancelled");
			if (idx > 0) return launchPi(clones[idx - 1].dir, ["-c"]); // enter existing clone
			const nm = await ask("Name (blank = auto): ");
			if (nm) flags.name = nm;
		}
	}

	const targetPath = path ? resolve(path) : process.cwd();
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

	// kage does NOT create a branch — the clone stays on the origin's current branch.
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
	info(`🥷 ${paint.bold("Shadow clone ready")}: ${cloneDir}`);
	info(`   origin: ${repoRoot}   branch: ${paint.cyan(curBranch)}`);
	if (seed) {
		info(`   seeded with the last ${seed.turns} turn(s) (pi -c resumes them)`);
		if (seed.preview) info(paint.dim(`     ↳ "${seed.preview}"`));
	} else {
		info(paint.dim("   blank clone (no context)"));
	}
	info(paint.yellow(`   ⚠  create a feature branch before committing (clone is on ${curBranch})`));
	info(paint.dim(`   when done: kage finish ${safe}`));
	info("");

	launchPi(cloneDir, seed ? ["-c"] : []);
	info("");
	info(`↩︎  left the clone's pi. To finish: ${paint.bold(`kage finish ${safe}`)}`);
}

async function cmdFinish(argv) {
	const { positional, flags } = parseArgs(argv);
	const force = !!flags.force;
	const pr = !!flags.pr;
	const push = pr || !!flags.push; // --pr implies --push
	const picked = await pickClone("finish", positional[0]);
	if (!picked) return info("cancelled");
	const { originRepo, clone } = picked;
	const insideClone = repoTopLevel(process.cwd()) === clone.dir;

	// Optional convenience: push the branch (and open a PR) before finishing.
	if (push) {
		const s = cloneStatus(clone.dir);
		if (s.dirty) die(`${clone.name} has uncommitted changes — commit them first (kage won't auto-commit)`);
		if (!s.hasUpstream) {
			const r = git(clone.dir, ["push", "-u", "origin", s.branch]);
			if (!r.ok) die(`push failed: ${r.err}`);
			info(`⬆  pushed ${s.branch} to origin`);
		} else if (s.ahead > 0) {
			const r = git(clone.dir, ["push"]);
			if (!r.ok) die(`push failed: ${r.err}`);
			info(`⬆  pushed ${s.ahead} commit(s)`);
		}
		if (pr) {
			const existing = prInfo(clone.dir, s.branch);
			if (existing) {
				info(`🔗 PR already open: ${existing.url}`);
			} else {
				const r = sh("gh", ["pr", "create", "--fill"], { cwd: clone.dir });
				if (!r.ok) die(`gh pr create failed: ${r.err || r.out || "is gh installed & authed?"}`);
				info(`🔗 opened PR: ${r.out.split("\n").pop()}`);
			}
		}
	}

	if (!force) {
		const s = cloneStatus(clone.dir);
		const problems = [];
		if (s.dirty) problems.push("uncommitted changes");
		if (!s.hasUpstream) problems.push("branch not pushed (no upstream)");
		else if (s.ahead > 0) problems.push(`${s.ahead} unpushed commit(s)`);
		if (problems.length) die(`${clone.name}: ${problems.join(", ")} — push your work, or pass --force`);
	}

	const n = mergeBack(clone.dir, originRepo, clone.marker);
	try {
		process.chdir(originRepo);
	} catch {
		/* ignore */
	}
	rmSync(clone.dir, { recursive: true, force: true });

	info(`💨 Clone dispelled: merged ${n} session(s) back, removed ${clone.dir}`);
	if (insideClone) info(paint.dim(`   your shell is still in the deleted dir; cd back to: ${originRepo}`));
}

async function cmdRm(argv) {
	const { positional, flags } = parseArgs(argv);
	const force = !!flags.force;
	const picked = await pickClone("remove", positional[0]);
	if (!picked) return info("cancelled");
	const { originRepo, clone } = picked;
	const insideClone = repoTopLevel(process.cwd()) === clone.dir;

	if (!force) {
		const s = cloneStatus(clone.dir);
		if (s.dirty || !s.hasUpstream || s.ahead > 0) {
			die(`${clone.name} has local-only work — use 'kage finish' to keep it, or 'kage rm --force' to discard`);
		}
		if (!(await confirm(`Discard clone ${clone.name} without merging its memory?`))) return info("aborted");
	}

	try {
		process.chdir(originRepo);
	} catch {
		/* ignore */
	}
	try {
		rmSync(sessionDirFor(clone.dir), { recursive: true, force: true });
	} catch {
		/* ignore */
	}
	rmSync(clone.dir, { recursive: true, force: true });
	info(`🗑  Removed clone ${clone.name} (${clone.dir})`);
	if (insideClone) info(paint.dim(`   cd back to: ${originRepo}`));
}

function cmdList(argv) {
	const { flags } = parseArgs(argv);
	const repoRoot = repoTopLevel(process.cwd());
	if (!repoRoot) die("not a git repository");
	const clones = listClones(repoRoot);
	if (clones.length === 0) return info("No shadow clones.");

	const rows = clones.map((c) => {
		const s = cloneStatus(c.dir);
		return { c, s, pr: flags.pr ? prInfo(c.dir, s.branch) : undefined };
	});
	const nameW = Math.max(...rows.map((r) => r.c.name.length), 4);
	const brW = Math.max(...rows.map((r) => r.s.branch.length), 6);

	info(paint.bold(`Shadow clones of ${basename(repoRoot)}:`));
	info("");
	for (const { c, s, pr } of rows) {
		const dirty = s.dirty ? paint.yellow("● dirty") : paint.green("clean  ");
		let sync;
		if (!s.hasUpstream) sync = paint.dim("not pushed");
		else {
			const parts = [];
			if (s.ahead) parts.push(`↑${s.ahead}`);
			if (s.behind) parts.push(`↓${s.behind}`);
			sync = parts.length ? parts.join(" ") : paint.dim("in sync");
		}
		const prStr = pr ? `  ${prState(pr)}` : "";
		const safe = isSafeToClean(s) ? paint.green("  ✓ safe to clean") : "";
		info(`  ${c.name.padEnd(nameW)}  ${paint.cyan(s.branch.padEnd(brW))}  ${dirty}  ${sync}${prStr}${safe}`);
	}
	info("");
	info(paint.dim("  finish <name> to merge & remove · rm <name> to discard · list --pr for PR status"));
}

function prState(pr) {
	const f = { OPEN: paint.green, MERGED: paint.magenta, CLOSED: paint.red }[pr.state] || paint.dim;
	return f(`PR #${pr.number} ${pr.state.toLowerCase()}`);
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
  kage [path] [--name <x>] [--blank] [--recent <N>]   clone repo + launch pi
                                                       (no args inside a repo with clones: interactive menu)
  kage list [--pr]                                     dashboard of clones (--pr adds PR status via gh)
  kage finish [name] [--force] [--push] [--pr]         check -> merge memory back -> delete clone
                                                       (--push: push first · --pr: push + open a PR via gh)
  kage rm [name] [--force]                             discard a clone without merging
  kage pull <path...>                                  (inside a clone) copy files back to the origin

Options:
  --name <x>    name the clone folder /<repo>--<x> (default: kage-<timestamp>)
  --blank       don't seed the clone with the origin's recent context
  --recent <N>  number of recent turns to seed (default: 5)
  --force       skip the safety checks (finish/rm)

Env:
  KAGE_SESSIONS_DIR   pi session storage (default: ~/.pi/agent/sessions)`;

async function main() {
	const [sub, ...rest] = process.argv.slice(2);
	switch (sub) {
		case undefined:
		case "new":
			return cmdNew(sub === "new" ? rest : process.argv.slice(2));
		case "list":
			return cmdList(rest);
		case "finish":
			return cmdFinish(rest);
		case "rm":
			return cmdRm(rest);
		case "pull":
			return cmdPull(rest);
		case "-h":
		case "--help":
			return info(HELP);
		case "-v":
		case "--version":
			return info(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version);
		default:
			return cmdNew(process.argv.slice(2)); // unknown subcommand -> treat as `kage <path>`
	}
}

main();
