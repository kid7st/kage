/**
 * kage（影分身）— 给 pi session 造一个带记忆的分身，独立并行干活，干完记忆回流本体
 *
 * 痛点：多个 pi session 同时改同一个 repo，互相踩、分支冲突。
 * 方案：把整个 repo 目录复制一份到同级新目录（含 .git / node_modules / .env），
 *      像"在第二台机器上克隆了仓库"。新目录里开一个 pi session 独立干活，
 *      独立分支、独立 push、独立 PR，最终在 GitHub 上合并。
 *
 * 影分身术的对应：
 *   - 造独立实体副本   → 整目录复制（macOS APFS clonefile，秒级、几乎不占空间）
 *   - 分身带本体记忆   → seed 最近若干回合的对话进分身 session
 *   - 独立行动         → 隔离工作区，互不干扰
 *   - 消散记忆回流本体 → /kage finish 把分身的 session 合并回本体
 *
 * 为什么不用 git worktree：worktree 共享同一个 .git，导致"同分支不能 checkout、
 * 共享 stash、缺 node_modules/.env"等一堆耦合问题。整目录复制 = 真正独立的第二台机器。
 *
 * 注意：pi 无法在运行中切换自己的 cwd，分身 session 需你自己到新目录手动打开。
 *
 * 命令：
 *   /kage new [branch] [--blank] [--recent=N]
 *                         复制当前 repo 到 ../<repo>--<branch>，建/切到该分支，打印进入命令
 *                         （branch 省略时自动用 kage-<时间戳>）
 *                         默认把本体最近 N=5 个用户回合的上下文 seed 进分身（用 pi -c 打开接上）
 *                         --blank 不带上下文；--recent=N 调整携带的回合数
 *   /kage finish [--force]  在分身里收尾：安全检查 → 合并 session 回本体 → 删分身目录
 *   /kage pull <path...>    在分身里，把指定文件/目录（哪怕没进 git）拷回本体同位置
 *   /kage list              列出当前 repo 的所有分身工作区
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";

const MARKER = ".kage.json";

interface Marker {
	originRepo: string;
	branch: string;
	createdAt: string;
}

/** 待删除的分身目录（finish 置位，session_shutdown 时执行） */
let pendingRemove: { copyDir: string; originRepo: string } | undefined;

async function git(
	pi: ExtensionAPI,
	cwd: string,
	args: string[],
): Promise<{ ok: boolean; out: string; err: string }> {
	const r = await pi.exec("git", args, { cwd });
	return { ok: r.code === 0, out: r.stdout.trim(), err: r.stderr.trim() };
}

/** 把绝对路径编码成 pi 的 session 目录名：/a/b -> --a-b-- */
function encodeCwd(abs: string): string {
	return `--${abs.replace(/^\//, "").replace(/\//g, "-")}--`;
}

/** session 存储根目录（不写死 ~/.pi，从当前 session 目录推导） */
function sessionsRoot(ctx: ExtensionCommandContext): string {
	return dirname(ctx.sessionManager.getSessionDir());
}

/** 把一个目录下的所有 session 复制到本体的 session 目录，并改写 header.cwd */
function mergeSessionsBack(srcDir: string, destDir: string, originRepo: string): number {
	if (!existsSync(srcDir)) return 0;
	mkdirSync(destDir, { recursive: true });
	let copied = 0;
	for (const f of readdirSync(srcDir)) {
		if (!f.endsWith(".jsonl")) continue;
		const dest = join(destDir, f);
		if (existsSync(dest)) continue; // 幂等：已存在则跳过
		const lines = readFileSync(join(srcDir, f), "utf8").split("\n");
		if (lines.length > 0 && lines[0].trim()) {
			try {
				const header = JSON.parse(lines[0]);
				if (header.type === "session") {
					header.cwd = originRepo;
					lines[0] = JSON.stringify(header);
				}
			} catch {
				// header 解析失败就原样复制，不阻断
			}
		}
		writeFileSync(dest, lines.join("\n"));
		copied++;
	}
	return copied;
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("kage", {
		description: "影分身隔离工作区：new [branch] | finish [--force] | pull <path...> | list",
		handler: async (args, ctx) => {
			const [sub, ...rest] = args.trim().split(/\s+/);
			switch (sub) {
				case "new":
					return cmdNew(pi, ctx, rest);
				case "finish":
					return cmdFinish(pi, ctx, rest);
				case "pull":
					return cmdPull(pi, ctx, rest);
				case "list":
					return cmdList(pi, ctx);
				default:
					ctx.ui.notify(
						"用法：/kage new [branch] | /kage finish [--force] | /kage pull <path...> | /kage list",
						"error",
					);
			}
		},
		getArgumentCompletions: (prefix) => {
			const subs = ["new", "finish", "pull", "list"];
			const items = subs.filter((s) => s.startsWith(prefix)).map((s) => ({ value: s, label: s }));
			return items.length > 0 ? items : null;
		},
	});

	// finish 触发关闭后，在这里真正删分身目录（先把进程挪出去再删）
	pi.on("session_shutdown", async (event, _ctx) => {
		if (!pendingRemove) return;
		if (event.reason !== "quit") return; // 只在真正退出时删，避免 /reload 等误删
		const { copyDir, originRepo } = pendingRemove;
		pendingRemove = undefined;
		try {
			process.chdir(originRepo); // 离开待删目录，否则删不干净
		} catch {
			// ignore
		}
		try {
			rmSync(copyDir, { recursive: true, force: true });
		} catch {
			// ignore
		}
	});
}

function defaultBranch(): string {
	const d = new Date();
	const p = (n: number) => String(n).padStart(2, "0");
	return `kage-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * 把本体当前 session 最近 recentTurns 个用户回合 seed 进分身路径的 session 目录。
 * 只保留 message 条目，重新串成线性链（首条 parentId=null），header.cwd 指向分身。
 * 返回写入的条目数；无法 seed（非持久 / 无消息）返回 0。
 */
function seedSession(
	ctx: ExtensionCommandContext,
	copyDir: string,
	rootDir: string,
	recentTurns: number,
): number {
	const srcFile = ctx.sessionManager.getSessionFile();
	if (!srcFile) return 0;
	const branch = ctx.sessionManager.getBranch(); // 时间正序：root 在前
	const messages = branch.filter((e) => e.type === "message");
	if (messages.length === 0) return 0;

	// 找到倒数第 recentTurns 个用户消息的位置作为起点
	const userIdx: number[] = [];
	messages.forEach((e, i) => {
		if ((e as { message?: { role?: string } }).message?.role === "user") userIdx.push(i);
	});
	const start = userIdx.length > recentTurns ? userIdx[userIdx.length - recentTurns] : 0;
	const kept = messages.slice(start);

	const destDir = join(rootDir, encodeCwd(copyDir));
	mkdirSync(destDir, { recursive: true });
	const id = randomUUID();
	const ts = new Date().toISOString();
	const fileTs = ts.replace(/[:.]/g, "-");
	const file = join(destDir, `${fileTs}_${id}.jsonl`);
	const header = { type: "session", version: 3, id, timestamp: ts, cwd: copyDir, parentSession: srcFile };
	const lines = [JSON.stringify(header)];
	let prevId: string | null = null;
	for (const e of kept) {
		lines.push(JSON.stringify({ ...e, parentId: prevId }));
		prevId = e.id;
	}
	writeFileSync(file, lines.join("\n") + "\n");
	return kept.length;
}

async function cmdNew(pi: ExtensionAPI, ctx: ExtensionCommandContext, rest: string[]) {
	const flags = rest.filter((a) => a.startsWith("--"));
	const positional = rest.filter((a) => !a.startsWith("--"));
	const blank = flags.includes("--blank");
	const recentFlag = flags.find((f) => f.startsWith("--recent="));
	const recentTurns = recentFlag ? Math.max(1, parseInt(recentFlag.split("=")[1], 10) || 5) : 5;
	const branch = positional[0] || defaultBranch();

	const top = await git(pi, ctx.cwd, ["rev-parse", "--show-toplevel"]);
	if (!top.ok) {
		ctx.ui.notify("当前目录不是 git 仓库", "error");
		return;
	}
	const repoRoot = top.out;

	// 已经在某个分身里就别再嵌套复制了
	if (existsSync(join(repoRoot, MARKER))) {
		ctx.ui.notify("你已经在一个分身工作区里了，请回到本体 repo 再 /kage new", "error");
		return;
	}

	const safeBranch = branch.replace(/\//g, "-");
	const copyDir = join(dirname(repoRoot), `${basename(repoRoot)}--${safeBranch}`);
	if (existsSync(copyDir)) {
		ctx.ui.notify(`目录已存在：${copyDir}`, "error");
		return;
	}

	// 整目录复制：macOS 优先用 clonefile（cp -c，写时复制，秒级且省空间），失败回退普通复制
	let cp = await pi.exec("cp", ["-c", "-R", repoRoot, copyDir], { cwd: dirname(repoRoot) });
	if (cp.code !== 0) {
		cp = await pi.exec("cp", ["-R", repoRoot, copyDir], { cwd: dirname(repoRoot) });
	}
	if (cp.code !== 0) {
		ctx.ui.notify(`复制失败：${cp.stderr.trim()}`, "error");
		return;
	}

	// 分身是独立 .git，可以随便切分支：分支已存在则切过去，否则新建
	const exists = await git(pi, copyDir, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
	const sw = exists.ok
		? await git(pi, copyDir, ["switch", branch])
		: await git(pi, copyDir, ["switch", "-c", branch]);
	if (!sw.ok) {
		ctx.ui.notify(`切换分支失败：${sw.err || sw.out}`, "error");
		return;
	}

	const marker: Marker = { originRepo: repoRoot, branch, createdAt: new Date().toISOString() };
	writeFileSync(join(copyDir, MARKER), JSON.stringify(marker, null, 2));

	// seed 上下文（默认开；--blank 跳过）
	let seeded = 0;
	if (!blank) {
		try {
			seeded = seedSession(ctx, copyDir, sessionsRoot(ctx), recentTurns);
		} catch {
			seeded = 0; // seed 失败不阻断创建，退化为空白
		}
	}
	const openCmd = seeded > 0 ? "pi -c" : "pi";

	// 把进入命令留在对话里方便复制（本体可能在忙，notify 会消失）
	pi.sendMessage({
		customType: "kage",
		content:
			`🥷 影分身已就位（分支 ${branch}${exists.ok ? "，切到已有分支" : "，新建分支"}）\n` +
			(seeded > 0
				? `已带上本体最近 ${recentTurns} 个回合的记忆（${seeded} 条），用 pi -c 打开即接上。\n`
				: blank
					? `空白模式：分身不带本体的记忆。\n`
					: `（未能 seed 记忆，分身将是空白会话。）\n`) +
			`\n到新目录手动开一个 pi session：\n\n    cd "${copyDir}" && ${openCmd}\n\n` +
			`它是独立的 repo（含 node_modules / .env），可直接 build/test，独立 push 开 PR。\n` +
			`干完后在那个 session 里跑 /kage finish 收尾。`,
		display: true,
	});
	ctx.ui.notify(`影分身: ${copyDir}${seeded > 0 ? `（seed ${seeded} 条）` : ""}`, "info");
}

async function cmdFinish(pi: ExtensionAPI, ctx: ExtensionCommandContext, rest: string[]) {
	const force = rest.includes("--force");

	const top = await git(pi, ctx.cwd, ["rev-parse", "--show-toplevel"]);
	if (!top.ok) {
		ctx.ui.notify("当前目录不是 git 仓库", "error");
		return;
	}
	const copyDir = top.out;
	const markerPath = join(copyDir, MARKER);
	if (!existsSync(markerPath)) {
		ctx.ui.notify("这里不是 /kage new 创建的分身（找不到 .kage.json），拒绝操作", "error");
		return;
	}
	const marker: Marker = JSON.parse(readFileSync(markerPath, "utf8"));

	// —— 安全检查（失败要可见，别默默删代码）——
	if (!force) {
		const status = await git(pi, copyDir, ["status", "--porcelain"]);
		// marker 本身是 untracked，排除掉它再判断是否真有改动
		const dirty = status.out.split("\n").filter((l) => l.trim() && l.slice(3).trim() !== MARKER);
		if (dirty.length > 0) {
			ctx.ui.notify("有未提交改动，先 commit 或用 /kage finish --force", "error");
			return;
		}
		const upstream = await git(pi, copyDir, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
		if (!upstream.ok) {
			ctx.ui.notify(`分支 ${marker.branch} 还没 push 到远端（无 upstream），先 push 或用 --force`, "error");
			return;
		}
		const unpushed = await git(pi, copyDir, ["rev-list", "@{u}..HEAD", "--count"]);
		if (unpushed.ok && unpushed.out !== "0") {
			ctx.ui.notify(`有 ${unpushed.out} 个提交未 push，先 push 或用 --force`, "error");
			return;
		}
	}

	// —— 合并 session 回本体 ——
	const root = sessionsRoot(ctx);
	const srcDir = ctx.sessionManager.getSessionDir();
	const destDir = join(root, encodeCwd(marker.originRepo));
	const n = mergeSessionsBack(srcDir, destDir, marker.originRepo);

	// —— 安排删除分身目录（在 shutdown 里执行，先把进程挪出去）——
	pendingRemove = { copyDir, originRepo: marker.originRepo };

	pi.sendMessage({
		customType: "kage",
		content:
			`💨 分身消散：已把 ${n} 个 session 的记忆合并回本体（${marker.originRepo}）。\n` +
			`即将删除分身目录并退出本 session。回到本体的 session 用 /resume 可看到合并进来的记录。`,
		display: true,
	});
	ctx.ui.notify(`合并 ${n} 个 session，退出后删除分身目录`, "info");

	ctx.shutdown();
}

async function cmdPull(pi: ExtensionAPI, ctx: ExtensionCommandContext, rest: string[]) {
	const top = await git(pi, ctx.cwd, ["rev-parse", "--show-toplevel"]);
	if (!top.ok) {
		ctx.ui.notify("当前目录不是 git 仓库", "error");
		return;
	}
	const copyDir = top.out;
	const markerPath = join(copyDir, MARKER);
	if (!existsSync(markerPath)) {
		ctx.ui.notify("这里不是 /kage new 创建的分身，pull 只在分身里用（本体直接改就行）", "error");
		return;
	}
	const marker: Marker = JSON.parse(readFileSync(markerPath, "utf8"));
	const originRepo = marker.originRepo;

	if (rest.length === 0) {
		ctx.ui.notify("用法：/kage pull <相对路径> [更多路径...]", "error");
		return;
	}

	const copyRoot = copyDir.endsWith(sep) ? copyDir : copyDir + sep;
	const originRoot = originRepo.endsWith(sep) ? originRepo : originRepo + sep;
	let done = 0;

	for (const rel of rest) {
		const src = resolve(copyDir, rel);
		const dest = resolve(originRepo, rel);
		// 越界保护：必须落在分身/本体之内
		if (!src.startsWith(copyRoot) || !dest.startsWith(originRoot)) {
			ctx.ui.notify(`路径越界，跳过：${rel}`, "error");
			continue;
		}
		if (!existsSync(src)) {
			ctx.ui.notify(`分身里不存在，跳过：${rel}`, "error");
			continue;
		}
		if (existsSync(dest)) {
			const ok = ctx.hasUI ? await ctx.ui.confirm("覆盖确认", `本体已存在 ${rel}，覆盖？`) : true;
			if (!ok) {
				ctx.ui.notify(`跳过：${rel}`, "info");
				continue;
			}
			rmSync(dest, { recursive: true, force: true }); // 干净替换，避免 cp -R 拷进目录里
		}
		mkdirSync(dirname(dest), { recursive: true });
		let cp = await pi.exec("cp", ["-c", "-R", src, dest], { cwd: copyDir });
		if (cp.code !== 0) cp = await pi.exec("cp", ["-R", src, dest], { cwd: copyDir });
		if (cp.code !== 0) {
			ctx.ui.notify(`拷贝失败 ${rel}：${cp.stderr.trim()}`, "error");
			continue;
		}
		done++;
	}

	pi.sendMessage({
		customType: "kage",
		content: `📤 已把 ${done}/${rest.length} 个路径从分身拷回本体（${originRepo}）。`,
		display: true,
	});
	ctx.ui.notify(`pull 完成：${done}/${rest.length}`, "info");
}

async function cmdList(pi: ExtensionAPI, ctx: ExtensionCommandContext) {
	const top = await git(pi, ctx.cwd, ["rev-parse", "--show-toplevel"]);
	if (!top.ok) {
		ctx.ui.notify("当前目录不是 git 仓库", "error");
		return;
	}
	const repoRoot = top.out;
	const parent = dirname(repoRoot);
	const found: string[] = [];
	for (const name of readdirSync(parent)) {
		const dir = join(parent, name);
		const mp = join(dir, MARKER);
		if (!existsSync(mp)) continue;
		try {
			const m: Marker = JSON.parse(readFileSync(mp, "utf8"));
			if (m.originRepo === repoRoot) found.push(`  ${dir}  [${m.branch}]  ${m.createdAt}`);
		} catch {
			// ignore
		}
	}
	pi.sendMessage({
		customType: "kage",
		content: found.length ? "当前影分身：\n\n" + found.join("\n") : "没有影分身。",
		display: true,
	});
}
