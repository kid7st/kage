#!/usr/bin/env node
/**
 * kage 🥷 — 给当前 repo 造一个带记忆的影分身（独立文件夹副本），直接进 pi 并行干活，
 *           干完用 `kage finish` 把记忆回流本体、删掉副本。
 *
 * 不变量（设计自洽的根基）：
 *   1. 隔离：分身 = 整目录独立副本（独立 .git）。
 *   2. 代码单向经 git/PR 回本体，文件系统从不反向覆盖本体工作树。
 *   3. 记忆双向经 ~/.pi：创建时 seed 本体最近若干回合；finish 时分身记忆回流（去重）。
 *   4. 本体只读：kage 对本体只复制 + 往 ~/.pi 写记忆，绝不动本体工作树。
 *
 * 命令：
 *   kage [path] [--name x] [--blank] [--recent N]   影分身 + 进 pi（path 默认 cwd）
 *   kage finish [name] [--force]                     收尾：检查 → 记忆回流 → 删分身
 *   kage list                                        列出当前 repo 的分身
 *   kage pull <path...>                              在分身里把指定文件拷回本体
 */

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";

const MARKER = ".kage.json";
const SESSIONS = process.env.KAGE_SESSIONS_DIR || join(homedir(), ".pi", "agent", "sessions");

// ── 小工具 ────────────────────────────────────────────────────────────────
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

/** 绝对路径 → pi 的 session 目录名：/a/b -> --a-b-- */
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

/** 复制整目录：mac 用 clonefile，linux 用 reflink，都不行就普通复制 */
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

// ── seed：把本体最近 N 回合写进分身 session 目录 ────────────────────────────
/** 返回 { seedFile, seedLeafId } 或 undefined（无法 seed） */
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

	// 从最后一条 entry 顺 parentId 走到根，得到时间正序的当前分支
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

function mtime(p) {
	try {
		return statSync(p).mtimeMs;
	} catch {
		return 0;
	}
}

// ── 记忆回流（去重）────────────────────────────────────────────────────────
/** 把分身 session 目录回流本体；seed 那段按 seedLeafId 裁掉。返回写入文件数。 */
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

		// 去重：若这是 seed 的那条 session，裁掉 seedLeafId 及之前的部分
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
				if (body.length === 0) continue; // 分身没在这条 session 上新增内容
				const first = JSON.parse(body[0]);
				first.parentId = null; // 重新挂根
				body[0] = JSON.stringify(first);
			}
			// 找不到 seedLeafId → 整条回拷（兜底，宁可重叠不损坏）
		}
		writeFileSync(dest, [JSON.stringify(header), ...body].join("\n") + "\n");
		n++;
	}
	// 清理分身在 ~/.pi 的孤儿 session 目录（pi 已退出，安全删）
	try {
		rmSync(srcDir, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
	return n;
}

// ── 子命令 ──────────────────────────────────────────────────────────────────
function cmdNew(argv) {
	const { positional, flags } = parseArgs(argv);
	const targetPath = positional[0] ? resolve(positional[0]) : process.cwd();
	const blank = !!flags.blank;
	const recent = Math.max(1, parseInt(flags.recent, 10) || 5);

	const repoRoot = repoTopLevel(targetPath);
	if (!repoRoot) die(`不是 git 仓库：${targetPath}`);
	if (existsSync(join(repoRoot, MARKER))) die("这里已经是一个影分身了，请回到本体 repo 再 kage");

	const name = (typeof flags.name === "string" && flags.name) || tsName();
	const safe = name.replace(/\//g, "-");
	const cloneDir = join(dirname(repoRoot), `${basename(repoRoot)}--${safe}`);
	if (existsSync(cloneDir)) die(`目录已存在：${cloneDir}`);

	const cp = copyTree(repoRoot, cloneDir);
	if (!cp.ok) die(`复制失败：${cp.err}`);

	// 注意：默认不建分支——分身停在本体当前分支，分支由你/AI 自己来（像第二台机器）

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
	info(`🥷 影分身就位：${cloneDir}`);
	info(`   本体：${repoRoot}　当前分支：${curBranch}`);
	info(seed ? `   已带上本体最近 ${recent} 个回合的记忆（pi -c 接上）` : `   空白分身（不带记忆）`);
	info(`   ⚠️  commit 前先建一个 feature 分支再 push / 开 PR（分身停在 ${curBranch} 上）`);
	info(`   干完回到本体跑：kage finish ${safe}`);
	info("");

	// 直接进 pi（seed 了就 -c 续上），pi 退出后回到原 shell
	const piArgs = seed ? ["-c"] : [];
	const r = spawnSync("pi", piArgs, { cwd: cloneDir, stdio: "inherit" });
	if (r.error) {
		if (r.error.code === "ENOENT") die("找不到 pi 命令（确认已安装并在 PATH 里）");
		die(`启动 pi 失败：${r.error.message}`);
	}
	info("");
	info(`↩︎  已退出分身的 pi。收尾：kage finish ${safe}`);
}

function cmdFinish(argv) {
	const { positional, flags } = parseArgs(argv);
	const force = !!flags.force;

	// 定位分身：在分身里跑 / 在本体里跑（按 name 或唯一性）
	const here = repoTopLevel(process.cwd());
	let cloneDir, originRepo, marker;
	const hereMarker = here && readMarker(here);
	if (hereMarker) {
		cloneDir = here;
		marker = hereMarker;
		originRepo = marker.originRepo;
	} else {
		if (!here) die("不是 git 仓库");
		originRepo = here;
		const clones = listClones(originRepo);
		if (clones.length === 0) die("没有找到这个 repo 的影分身");
		const pick = positional[0]
			? clones.find((c) => c.name === positional[0] || basename(c.dir) === positional[0])
			: clones.length === 1
				? clones[0]
				: undefined;
		if (!pick) {
			info("有多个分身，请指定名字：");
			clones.forEach((c) => info(`  ${c.name}`));
			process.exit(1);
		}
		cloneDir = pick.dir;
		marker = pick.marker;
	}

	// 安全检查（失败要可见，别默默删代码）
	if (!force) {
		const status = git(cloneDir, ["status", "--porcelain"]);
		const dirty = status.out.split("\n").filter((l) => l.trim() && l.slice(3).trim() !== MARKER);
		if (dirty.length > 0) die("分身有未提交改动，先 commit 或加 --force");
		const up = git(cloneDir, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
		if (!up.ok) die("分身当前分支没 push 到远端（无 upstream），先 push 或加 --force");
		const ahead = git(cloneDir, ["rev-list", "@{u}..HEAD", "--count"]);
		if (ahead.ok && ahead.out !== "0") die(`分身有 ${ahead.out} 个提交未 push，先 push 或加 --force`);
	}

	const n = mergeBack(cloneDir, originRepo, marker);

	// 删分身目录（先把自己挪出去，避免删 cwd）
	try {
		process.chdir(originRepo);
	} catch {
		/* ignore */
	}
	rmSync(cloneDir, { recursive: true, force: true });

	info(`💨 分身消散：回流 ${n} 个 session 到本体，已删除 ${cloneDir}`);
	if (hereMarker) info(`   你的 shell 还在已删目录里，请 cd 回：${originRepo}`);
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
	if (!repoRoot) die("不是 git 仓库");
	const clones = listClones(repoRoot);
	if (clones.length === 0) {
		info("没有影分身。");
		return;
	}
	info("当前影分身：");
	for (const c of clones) {
		const br = git(c.dir, ["rev-parse", "--abbrev-ref", "HEAD"]).out || "?";
		info(`  ${c.name}  [${br}]  ${c.dir}`);
	}
}

function cmdPull(argv) {
	const { positional } = parseArgs(argv);
	const cloneDir = repoTopLevel(process.cwd());
	const marker = cloneDir && readMarker(cloneDir);
	if (!marker) die("pull 只能在影分身里跑（本体直接改就行）");
	if (positional.length === 0) die("用法：kage pull <相对路径> [更多路径...]");
	const originRepo = marker.originRepo;
	const cloneRoot = cloneDir.endsWith(sep) ? cloneDir : cloneDir + sep;
	const originRoot = originRepo.endsWith(sep) ? originRepo : originRepo + sep;
	let done = 0;
	for (const rel of positional) {
		const src = resolve(cloneDir, rel);
		const dst = resolve(originRepo, rel);
		if (!src.startsWith(cloneRoot) || !dst.startsWith(originRoot)) {
			info(`✗ 路径越界，跳过：${rel}`);
			continue;
		}
		if (!existsSync(src)) {
			info(`✗ 分身里不存在，跳过：${rel}`);
			continue;
		}
		if (existsSync(dst)) rmSync(dst, { recursive: true, force: true });
		mkdirSync(dirname(dst), { recursive: true });
		const cp = copyTree(src, dst);
		if (!cp.ok) {
			info(`✗ 拷贝失败 ${rel}：${cp.err}`);
			continue;
		}
		done++;
	}
	info(`📤 已把 ${done}/${positional.length} 个路径从分身拷回本体（${originRepo}）`);
}

// ── 入口 ──────────────────────────────────────────────────────────────────
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
			info(
				[
					"kage 🥷 — 影分身并行开发",
					"",
					"  kage [path] [--name x] [--blank] [--recent N]   影分身 + 进 pi（path 默认 cwd）",
					"  kage finish [name] [--force]                     收尾：检查 → 记忆回流 → 删分身",
					"  kage list                                        列出当前 repo 的分身",
					"  kage pull <path...>                              在分身里把指定文件拷回本体",
				].join("\n"),
			);
			return;
		default:
			// 没匹配子命令 → 当作 `kage <path>`（path 语义）
			return cmdNew(process.argv.slice(2));
	}
}

main();
