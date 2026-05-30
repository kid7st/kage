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
 *   3. Memory flows via ~/.pi — the origin's session history is copied into the clone on create
 *      (resumable, never replayed) and the clone's new sessions are merged back on finish. These
 *      are session .jsonl files, not the working tree, so there's no collision.
 *   4. The origin is read-only to kage — it only copies out and writes session memory.
 *
 * Commands:
 *   kage [path] [--name x]                           clone repo + launch a fresh pi (no args: interactive)
 *   kage status [--pr]                               dashboard of clones (+ PR status via gh)
 *   kage finish [name] [--force]                     check -> merge memory back -> delete clone
 *   kage rm [name] [--force]                         discard a clone (no merge)
 *   kage pull <path...>                              (inside a clone) copy files back to the origin
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import readline from "node:readline";

const MARKER = ".kage.json";
const SESSIONS = process.env.KAGE_SESSIONS_DIR || join(homedir(), ".pi", "agent", "sessions");
const RECENT_SESSIONS = 5; // how many of the origin's most-recent sessions to copy into a clone

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

/** Copy a whole directory: clonefile on macOS, reflink on Linux, plain copy as fallback. */
function copyTree(src, dst) {
	const isMac = process.platform === "darwin";
	let r = sh("cp", isMac ? ["-c", "-R", src, dst] : ["--reflink=auto", "-R", src, dst]);
	if (!r.ok) r = sh("cp", ["-R", src, dst]);
	return r;
}

/** An indeterminate spinner on stderr (no-op when not a TTY). Returns { stop() }. */
function spinner(label) {
	if (!process.stderr.isTTY) return { stop() {} };
	const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
	const t0 = Date.now();
	let i = 0;
	const tick = () => {
		const s = ((Date.now() - t0) / 1000).toFixed(1);
		process.stderr.write(`\r\x1b[2K${paint.cyan(frames[(i = (i + 1) % frames.length)])} ${label} ${paint.dim(`${s}s`)}`);
	};
	tick();
	const id = setInterval(tick, 80);
	return {
		stop() {
			clearInterval(id);
			process.stderr.write("\r\x1b[2K");
		},
	};
}

/** Copy the repo with a spinner (the copy can be slow on non-reflink filesystems). */
async function copyRepo(src, dst) {
	const isMac = process.platform === "darwin";
	const primary = isMac ? ["-c", "-R", src, dst] : ["--reflink=auto", "-R", src, dst];
	const tryCp = (args) =>
		new Promise((res) => {
			const p = spawn("cp", args, { stdio: ["ignore", "ignore", "pipe"] });
			let err = "";
			p.stderr.on("data", (d) => (err += d));
			p.on("error", (e) => res({ ok: false, err: e.message }));
			p.on("close", (code) => res({ ok: code === 0, err: err.trim() }));
		});
	const sp = spinner(`copying ${basename(dst)}`);
	let r = await tryCp(primary);
	if (!r.ok) r = await tryCp(["-R", src, dst]);
	sp.stop();
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

async function ask(prompt, prefill) {
	if (!process.stdin.isTTY) return "";
	const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
	const a = await new Promise((r) => {
		rl.question(prompt, (x) => (rl.close(), r(x)));
		if (prefill) rl.write(prefill); // pre-fill an editable default: Enter accepts, or edit it
	});
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

// ── copy the origin's session history into the clone ─────────────────────────
/**
 * Copies the origin's most recent session files (up to RECENT_SESSIONS, by mtime) into the
 * clone's session dir, so `pi` resume inside the clone surfaces them (you decide whether to
 * resume any of it). The clone itself opens a fresh session — kage never replays turns or
 * fabricates a "resumed" conversation. On merge-back these copied files already exist in
 * the origin (same filename) and are skipped, so only the clone's new sessions return.
 */
function copyOriginHistory(originRepo, cloneDir) {
	const srcDir = sessionDirFor(originRepo);
	if (!existsSync(srcDir)) return 0;
	const destDir = sessionDirFor(cloneDir);
	mkdirSync(destDir, { recursive: true });
	const recent = readdirSync(srcDir)
		.filter((f) => f.endsWith(".jsonl"))
		.map((f) => ({ f, m: statSync(join(srcDir, f)).mtimeMs }))
		.sort((a, b) => b.m - a.m)
		.slice(0, RECENT_SESSIONS);
	let n = 0;
	for (const { f } of recent) {
		const lines = readFileSync(join(srcDir, f), "utf8").split("\n");
		try {
			const header = JSON.parse(lines[0]);
			header.cwd = cloneDir;
			lines[0] = JSON.stringify(header);
		} catch {
			/* leave malformed header as-is */
		}
		writeFileSync(join(destDir, f), lines.join("\n"));
		n++;
	}
	return n;
}

// ── merge the clone's new sessions back into the origin ──────────────────────
/**
 * Copies the clone's session files into the origin's session dir. Files that already exist
 * (the origin history we copied in on create) are skipped, so only sessions the clone
 * created return. No dedup/slicing — the clone's sessions are independent of the origin's.
 */
function mergeBack(cloneDir, originRepo) {
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
		writeFileSync(dest, [JSON.stringify(header), ...lines.slice(1)].join("\n") + "\n");
		n++;
	}
	try {
		rmSync(srcDir, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
	return n;
}

/** Ask the shell wrapper (kage shell-init) to cd somewhere after we exit. */
function requestCd(path) {
	const f = process.env.KAGE_CD_FILE;
	if (f) {
		try {
			writeFileSync(f, path);
		} catch {
			/* ignore */
		}
	}
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
	if (!path && !flags.name && process.stdin.isTTY) {
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
			const idx = await select(`Shadow clones of ${basename(repoRoot)} — pick one, or create:`, labels);
			if (idx < 0) return info("cancelled");
			if (idx > 0) {
				const clone = clones[idx - 1];
				const act = await select(`${clone.name}:`, [
					"Enter (resume pi)",
					"Finish (merge memory & remove)",
					"Remove (discard)",
					"Cancel",
				]);
				if (act === 0) return launchPi(clone.dir, ["-c"]);
				if (act === 1) return cmdFinish([clone.name]);
				if (act === 2) return cmdRm([clone.name]);
				return info("cancelled");
			}
			// idx === 0: "create" — fall through to the name prompt below.
		}
	}

	const targetPath = path ? resolve(path) : process.cwd();

	const repoRoot = repoTopLevel(targetPath);
	if (!repoRoot) die(`not a git repository: ${targetPath}`);
	if (existsSync(join(repoRoot, MARKER))) die("already inside a clone; run kage from the origin repo");

	// Resolve the clone name: explicit --name wins; otherwise show the full folder name with
	// the fixed "<repo>--" prefix in the prompt and an editable default suffix — press Enter to
	// accept, or edit the suffix (non-interactive falls back to the default).
	let name = typeof flags.name === "string" && flags.name ? flags.name : "";
	if (!name) {
		const def = tsName();
		const prompt = `Kage name: ${basename(repoRoot)}--`;
		name = (process.stdin.isTTY ? await ask(prompt, def) : "") || def;
	}
	const safe = name.replace(/\//g, "-");
	const cloneDir = join(dirname(repoRoot), `${basename(repoRoot)}--${safe}`);
	if (existsSync(cloneDir)) die(`directory already exists: ${cloneDir}`);

	const cp = await copyRepo(repoRoot, cloneDir);
	if (!cp.ok) die(`copy failed: ${cp.err}`);

	// kage does NOT create a branch — the clone stays on the origin's current branch.
	const histN = copyOriginHistory(repoRoot, cloneDir);
	const marker = {
		originRepo: repoRoot,
		name: safe,
		createdAt: new Date().toISOString(),
	};
	writeFileSync(join(cloneDir, MARKER), JSON.stringify(marker, null, 2));

	const curBranch = git(cloneDir, ["rev-parse", "--abbrev-ref", "HEAD"]).out || "?";
	info("");
	info(`🥷 ${paint.bold("Shadow clone ready")}: ${cloneDir}`);
	info(`   origin: ${repoRoot}   branch: ${paint.cyan(curBranch)}`);
	if (histN > 0) info(paint.dim(`   origin's ${histN} session(s) are available via resume (pi: pick from the list)`));
	info(paint.dim(`   when done: kage finish ${safe}`));
	info("");

	launchPi(cloneDir, []);
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

	const n = mergeBack(clone.dir, originRepo);
	try {
		process.chdir(originRepo);
	} catch {
		/* ignore */
	}
	rmSync(clone.dir, { recursive: true, force: true });

	info(`💨 Clone dispelled: merged ${n} session(s) back, removed ${clone.dir}`);
	if (insideClone) {
		requestCd(originRepo);
		info(paint.dim(`   cd back to: ${originRepo}  (auto with: eval "$(kage shell-init)")`));
	}
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
	if (insideClone) {
		requestCd(originRepo);
		info(paint.dim(`   cd back to: ${originRepo}  (auto with: eval "$(kage shell-init)")`));
	}
}

function cmdList(argv) {
	const { flags } = parseArgs(argv);
	const here = repoTopLevel(process.cwd());
	if (!here) die("not a git repository");
	// Works from inside a clone too: resolve to the origin via the marker, then list its clones.
	const repoRoot = readMarker(here)?.originRepo || here;
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
	info(paint.dim("  finish <name> to merge & remove · rm <name> to discard · status --pr for PR status"));
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

const SHELL_INIT = `# kage shell integration — add to ~/.zshrc or ~/.bashrc:  eval "$(kage shell-init)"
kage() {
  local f; f="$(mktemp "\${TMPDIR:-/tmp}/kage-cd.XXXXXX")"
  KAGE_CD_FILE="$f" command kage "$@"; local rc=$?
  if [ -s "$f" ]; then cd "$(cat "$f")"; fi
  rm -f "$f"
  return $rc
}
if [ -n "$ZSH_VERSION" ]; then
  _kage() {
    if (( CURRENT == 2 )); then compadd new status finish rm pull; return; fi
    case "\${words[2]}" in
      finish|rm) compadd $(command kage __clones 2>/dev/null);;
    esac
  }
  compdef _kage kage
elif [ -n "$BASH_VERSION" ]; then
  _kage() {
    local cur="\${COMP_WORDS[COMP_CWORD]}"
    if [ "$COMP_CWORD" -eq 1 ]; then COMPREPLY=( $(compgen -W "new status finish rm pull" -- "$cur") ); return; fi
    case "\${COMP_WORDS[1]}" in
      finish|rm) COMPREPLY=( $(compgen -W "$(command kage __clones 2>/dev/null)" -- "$cur") );;
    esac
  }
  complete -F _kage kage
fi`;

function cmdClones() {
	const repoRoot = repoTopLevel(process.cwd());
	if (!repoRoot) return;
	for (const c of listClones(repoRoot)) process.stdout.write(`${c.name}\n`);
}

const HELP = `kage 🥷 — Shadow Clone Jutsu for your git repo

Usage:
  kage [path] [--name <x>]                             clone repo + launch a fresh pi
                                                       (no args inside a repo with clones: interactive menu)
  kage status [--pr]                                   dashboard of clones (--pr adds PR status via gh)
  kage finish [name] [--force] [--push] [--pr]         check -> merge memory back -> delete clone
                                                       (--push: push first · --pr: push + open a PR via gh)
  kage rm [name] [--force]                             discard a clone without merging
  kage pull <path...>                                  (inside a clone) copy files back to the origin
  kage shell-init                                      shell wrapper (cd-back) + tab completion
  kage --help | --version                              show this help / print the version

With no args inside a repo that already has clones, kage opens an interactive menu
(create a new clone, or enter / finish / remove an existing one).

Options:
  --name <x>    name the clone folder /<repo>--<x> (default: kage-<timestamp>); skips the name prompt
  --pr          (finish) push the branch and open a GitHub PR via gh, then finish
  --push        (finish) push the branch before finishing (implied by --pr)
  --force       skip the safety checks: uncommitted/unpushed guard (finish) or local-only guard (rm)

Examples:
  kage                          # clone the current repo, pick a name, open a fresh pi to work in
  kage --name fix-login         # same, but name the clone ../<repo>--fix-login (no prompt)
  kage ~/code/other-repo        # clone a different repo instead of the current dir

  kage status                   # in the origin: list your clones + their git state
  kage status --pr              # ...also show each clone's PR state (needs gh)

  # after you've worked in a clone (committed your changes), from the origin:
  kage finish fix-login         # you already pushed -> merge memory back, delete the clone
  kage finish fix-login --pr    # push the branch + open a PR via gh, then finish
  kage finish fix-login --force # finish even with uncommitted/unpushed work
  kage rm experiment            # throw a clone away without merging its memory

  kage pull .env                # inside a clone: copy a gitignored file back to the origin

Env:
  KAGE_SESSIONS_DIR   pi session storage (default: ~/.pi/agent/sessions)`;

async function main() {
	const [sub, ...rest] = process.argv.slice(2);
	switch (sub) {
		case undefined:
		case "new":
			return cmdNew(sub === "new" ? rest : process.argv.slice(2));
		case "status":
		case "list": // alias
			return cmdList(rest);
		case "finish":
			return cmdFinish(rest);
		case "rm":
			return cmdRm(rest);
		case "pull":
			return cmdPull(rest);
		case "shell-init":
		case "completion":
			return process.stdout.write(SHELL_INIT + "\n");
		case "__clones":
			return cmdClones();
		case "-h":
		case "--help":
			return info(HELP);
		case "-v":
		case "--version":
			return info(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version);
		default:
			// `kage <path>` clones another repo, but a bare word that isn't an existing directory
			// is a mistyped command (e.g. `kage statsu`) — fail clearly instead of "not a git repository".
			if (!sub.startsWith("-") && !(existsSync(resolve(sub)) && statSync(resolve(sub)).isDirectory())) {
				die(`unknown command or path: ${sub}  (run 'kage --help')`);
			}
			return cmdNew(process.argv.slice(2)); // `kage <path>` or `kage <flags>`
	}
}

main();
