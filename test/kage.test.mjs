import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync, chmodSync, mkdirSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const CLI = new URL("../bin/kage.mjs", import.meta.url).pathname;

function run(args, opts = {}) {
	return spawnSync("node", [CLI, ...args], { encoding: "utf8", ...opts });
}

function tmp() {
	return mkdtempSync(join(tmpdir(), "kage-test-"));
}

function initRepo(dir) {
	spawnSync("git", ["init", "-q"], { cwd: dir });
	spawnSync("git", ["config", "user.email", "t@t.co"], { cwd: dir });
	spawnSync("git", ["config", "user.name", "t"], { cwd: dir });
	writeFileSync(join(dir, "a.txt"), "hi\n");
	spawnSync("git", ["add", "."], { cwd: dir });
	spawnSync("git", ["commit", "-qm", "init"], { cwd: dir });
}

/** A PATH containing a fake `pi` that exits immediately, so `kage new` can run headless. */
function fakePiPath(root) {
	const bin = join(root, "bin");
	mkdirSync(bin, { recursive: true });
	const pi = join(bin, "pi");
	writeFileSync(pi, "#!/bin/sh\nexit 0\n");
	chmodSync(pi, 0o755);
	return `${bin}:${process.env.PATH}`;
}

test("--help prints usage", () => {
	const r = run(["--help"]);
	assert.equal(r.status, 0);
	assert.match(r.stderr, /Shadow Clone Jutsu/);
	assert.match(r.stderr, /kage finish/);
});

test("--version prints the package version", () => {
	const r = run(["--version"]);
	assert.equal(r.status, 0);
	assert.match(r.stderr, /\d+\.\d+\.\d+/);
});

test("errors outside a git repo", () => {
	const d = tmp();
	try {
		const r = run(["list"], { cwd: d });
		assert.equal(r.status, 1);
		assert.match(r.stderr, /not a git repository/);
	} finally {
		rmSync(d, { recursive: true, force: true });
	}
});

test("list reports no clones in a fresh repo", () => {
	const root = tmp();
	const repo = join(root, "repo");
	mkdirSync(repo);
	initRepo(repo);
	try {
		const r = run(["list"], { cwd: repo });
		assert.equal(r.status, 0);
		assert.match(r.stderr, /No shadow clones/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("new creates a clone, list shows it, finish removes it", () => {
	const root = tmp();
	const repo = join(root, "repo");
	mkdirSync(repo);
	initRepo(repo);
	const env = { ...process.env, PATH: fakePiPath(root), KAGE_SESSIONS_DIR: join(root, "sessions") };
	const clone = join(root, "repo--t1");
	try {
		const r = run(["--name", "t1"], { cwd: repo, env });
		assert.equal(r.status, 0);
		assert.ok(existsSync(clone), "clone dir should exist");
		assert.ok(existsSync(join(clone, ".kage.json")), "marker should exist");
		assert.ok(existsSync(join(clone, "a.txt")), "files should be copied");

		const list = run(["status"], { cwd: repo, env });
		assert.match(list.stderr, /Shadow clones of repo/);
		assert.match(list.stderr, /t1/);
		assert.match(list.stderr, /not pushed/); // status dashboard column

		// status also works from INSIDE the clone (resolves the origin via the marker)
		const inside = run(["status"], { cwd: clone, env });
		assert.match(inside.stderr, /Shadow clones of repo/);
		assert.match(inside.stderr, /t1/);

		// nothing committed/pushed in the clone -> needs --force
		const finish = run(["finish", "t1", "--force"], { cwd: repo, env });
		assert.equal(finish.status, 0);
		assert.ok(!existsSync(clone), "clone dir should be removed");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("shell-init prints a cd wrapper and completion", () => {
	const r = run(["shell-init"]);
	assert.equal(r.status, 0);
	assert.match(r.stdout, /KAGE_CD_FILE/);
	assert.match(r.stdout, /compdef _kage kage|complete -F _kage kage/);
});

test("origin history is copied into the clone, and new clone work merges back without duplicating it", () => {
	const root = tmp();
	const repo = join(root, "repo");
	mkdirSync(repo);
	initRepo(repo);
	const sessions = join(root, "sessions");
	const env = { ...process.env, PATH: fakePiPath(root), KAGE_SESSIONS_DIR: sessions };

	// seed the origin's session dir with one history file (encoded by the real toplevel path)
	const top = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: repo, encoding: "utf8" }).stdout.trim();
	const enc = (abs) => `--${abs.replace(/^\//, "").replace(/\//g, "-")}--`;
	const originDir = join(sessions, enc(top));
	mkdirSync(originDir, { recursive: true });
	const histName = "2026-01-01T00-00-00-000Z_aaaaaaaa-0000-0000-0000-000000000000.jsonl";
	writeFileSync(join(originDir, histName), JSON.stringify({ type: "session", version: 3, id: "hist", cwd: top }) + "\n");

	const clone = join(root, "repo--h1");
	try {
		run(["--name", "h1"], { cwd: repo, env });
		const cloneSessDir = join(sessions, readdirSync(sessions).find((d) => d.endsWith("repo--h1--")));
		// the origin's history is copied into the clone (resumable there)
		assert.ok(existsSync(join(cloneSessDir, histName)), "origin history should be copied into the clone");

		// simulate new clone work: a brand-new session file the clone created
		const newName = "2026-02-02T00-00-00-000Z_bbbbbbbb-0000-0000-0000-000000000000.jsonl";
		writeFileSync(join(cloneSessDir, newName), JSON.stringify({ type: "session", version: 3, id: "new", cwd: clone }) + "\n");

		run(["finish", "h1", "--force"], { cwd: repo, env });
		const originFiles = readdirSync(originDir);
		assert.ok(originFiles.includes(histName), "origin keeps its original history file");
		assert.ok(originFiles.includes(newName), "clone's new session merges back into the origin");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("finish --push pushes the branch then finishes", () => {
	const root = tmp();
	spawnSync("git", ["init", "-q", "--bare", join(root, "remote.git")]);
	spawnSync("git", ["clone", "-q", join(root, "remote.git"), join(root, "repo")]);
	const repo = join(root, "repo");
	spawnSync("git", ["config", "user.email", "t@t.co"], { cwd: repo });
	spawnSync("git", ["config", "user.name", "t"], { cwd: repo });
	writeFileSync(join(repo, "a.txt"), "hi\n");
	spawnSync("git", ["add", "."], { cwd: repo });
	spawnSync("git", ["commit", "-qm", "init"], { cwd: repo });
	spawnSync("git", ["push", "-q", "-u", "origin", "HEAD"], { cwd: repo });
	const env = { ...process.env, PATH: fakePiPath(root), KAGE_SESSIONS_DIR: join(root, "sessions") };
	const clone = join(root, "repo--p1");
	try {
		run(["--name", "p1"], { cwd: repo, env });
		// make a committed-but-unpushed change in the clone on a new branch
		spawnSync("git", ["switch", "-qc", "feat"], { cwd: clone });
		writeFileSync(join(clone, "b.txt"), "x\n");
		spawnSync("git", ["add", "."], { cwd: clone });
		spawnSync("git", ["commit", "-qm", "work"], { cwd: clone });

		const r = run(["finish", "p1", "--push"], { cwd: repo, env });
		assert.equal(r.status, 0, r.stderr);
		assert.ok(!existsSync(clone), "clone removed");
		// the branch should now exist on the remote
		const ls = spawnSync("git", ["ls-remote", "--heads", join(root, "remote.git"), "feat"], { encoding: "utf8" });
		assert.match(ls.stdout, /refs\/heads\/feat/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("finish with no remote preserves the clone's commits into the origin as kage/<name>", () => {
	const root = tmp();
	const repo = join(root, "repo");
	mkdirSync(repo);
	initRepo(repo); // a plain repo with NO remote
	const env = { ...process.env, PATH: fakePiPath(root), KAGE_SESSIONS_DIR: join(root, "sessions") };
	const clone = join(root, "repo--local");
	try {
		run(["--name", "local"], { cwd: repo, env });
		// commit work in the clone (still on the base branch, no remote to push to)
		writeFileSync(join(clone, "b.txt"), "x\n");
		spawnSync("git", ["add", "."], { cwd: clone });
		spawnSync("git", ["commit", "-qm", "local work"], { cwd: clone });
		const cloneHead = spawnSync("git", ["rev-parse", "HEAD"], { cwd: clone, encoding: "utf8" }).stdout.trim();

		// finish without --force should succeed (no remote -> preserve locally, not refuse)
		const r = run(["finish", "local"], { cwd: repo, env });
		assert.equal(r.status, 0, r.stderr);
		assert.ok(!existsSync(clone), "clone removed");

		// the commits now live in the origin under refs/heads/kage/local
		const ref = spawnSync("git", ["rev-parse", "kage/local"], { cwd: repo, encoding: "utf8" });
		assert.equal(ref.stdout.trim(), cloneHead, "origin has kage/local pointing at the clone's commit");
		// origin's working tree was left untouched (no b.txt checked out)
		assert.ok(!existsSync(join(repo, "b.txt")), "origin working tree untouched");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("rm discards a clone (with --force)", () => {
	const root = tmp();
	const repo = join(root, "repo");
	mkdirSync(repo);
	initRepo(repo);
	const env = { ...process.env, PATH: fakePiPath(root), KAGE_SESSIONS_DIR: join(root, "sessions") };
	const clone = join(root, "repo--gone");
	try {
		run(["--name", "gone"], { cwd: repo, env });
		assert.ok(existsSync(clone));
		// give the clone local-only committed work
		writeFileSync(join(clone, "b.txt"), "x\n");
		spawnSync("git", ["add", "."], { cwd: clone });
		spawnSync("git", ["commit", "-qm", "work"], { cwd: clone });
		// without --force: refuses (local-only work would be discarded without merging)
		const refused = run(["rm", "gone"], { cwd: repo, env });
		assert.notEqual(refused.status, 0);
		assert.ok(existsSync(clone), "clone should still exist after refused rm");
		// with --force: gone
		const r = run(["rm", "gone", "--force"], { cwd: repo, env });
		assert.equal(r.status, 0);
		assert.ok(!existsSync(clone), "clone should be removed");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
