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

test("--version prints the package version and stays in sync", () => {
	const r = run(["--version"]);
	assert.equal(r.status, 0);
	assert.match(r.stderr, /\d+\.\d+\.\d+/);
	// the embedded VERSION constant must match package.json (single-file installs have no package.json)
	const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
	assert.equal(r.stderr.trim(), pkg.version);
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

test("new --blank creates a clone, list shows it, finish removes it", () => {
	const root = tmp();
	const repo = join(root, "repo");
	mkdirSync(repo);
	initRepo(repo);
	const env = { ...process.env, PATH: fakePiPath(root), KAGE_SESSIONS_DIR: join(root, "sessions") };
	const clone = join(root, "repo--t1");
	try {
		const r = run(["--blank", "--name", "t1"], { cwd: repo, env });
		assert.equal(r.status, 0);
		assert.ok(existsSync(clone), "clone dir should exist");
		assert.ok(existsSync(join(clone, ".kage.json")), "marker should exist");
		assert.ok(existsSync(join(clone, "a.txt")), "files should be copied");

		const list = run(["list"], { cwd: repo, env });
		assert.match(list.stderr, /Shadow clones of repo/);
		assert.match(list.stderr, /t1/);
		assert.match(list.stderr, /not pushed/); // status dashboard column

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

test("a blank clone gets an in-context kage reminder", () => {
	const root = tmp();
	const repo = join(root, "repo");
	mkdirSync(repo);
	initRepo(repo);
	const sessions = join(root, "sessions");
	const env = { ...process.env, PATH: fakePiPath(root), KAGE_SESSIONS_DIR: sessions };
	const clone = join(root, "repo--h1");
	try {
		run(["--blank", "--name", "h1"], { cwd: repo, env });
		const encName = readdirSync(sessions).find((d) => d.endsWith("repo--h1--"));
		assert.ok(encName, "clone session dir should exist");
		const dir = join(sessions, encName);
		const file = join(dir, readdirSync(dir)[0]);
		const lines = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
		const last = lines[lines.length - 1];
		assert.equal(last.type, "custom_message");
		assert.equal(last.customType, "kage");
		assert.match(last.content, /shadow clone/);
		assert.match(last.content, /feature branch/);
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
		run(["--blank", "--name", "p1"], { cwd: repo, env });
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

test("rm discards a clone (with --force)", () => {
	const root = tmp();
	const repo = join(root, "repo");
	mkdirSync(repo);
	initRepo(repo);
	const env = { ...process.env, PATH: fakePiPath(root), KAGE_SESSIONS_DIR: join(root, "sessions") };
	const clone = join(root, "repo--gone");
	try {
		run(["--blank", "--name", "gone"], { cwd: repo, env });
		assert.ok(existsSync(clone));
		// without --force and non-interactive: refuses (local-only work / can't confirm)
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
