// scripts/sync-skill.mjs：安装和升级 skill 时保留三项默认路由，发现本地改动时默认不覆盖。
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  KNOWN_REFERENCE_FILES,
  KNOWN_SKILL_TEMPLATES,
  applySync,
  fillRoute,
  planSync,
  readRoute,
  templateFingerprint,
} from "../scripts/sync-skill.mjs";

const repo = fileURLToPath(new URL("..", import.meta.url));
const sourceDir = join(repo, "skills", "team-lead");
const script = join(repo, "scripts", "sync-skill.mjs");
const version = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")).version;
const template = readFileSync(join(sourceDir, "SKILL.md"), "utf8");
const reference = readFileSync(join(sourceDir, "references", "spawn-route.md"), "utf8");
const released111 = readFileSync(new URL("./fixtures/team-lead-skill-1.1.1.md", import.meta.url), "utf8");
const ROUTE = { provider: "provider-a", model: "model-a", reasoningEffort: "high" };

// 模拟你电脑上那份：1.1.1 模板，填了三项值，安装时把第一句改成了「已按用户选择写好。」，CRLF 换行。
const installed111 = fillRoute(released111, ROUTE).replace("这里还没设置。", "已按用户选择写好。").replace(/\n/g, "\r\n");

function workspace(files = {}) {
  const root = mkdtempSync(join(tmpdir(), "sync-skill-"));
  const target = join(root, "skills", "team-lead");
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(target, path, ".."), { recursive: true });
    writeFileSync(join(target, path), content);
  }
  return { root, target, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });

test("当前版本的 SKILL.md 与 references 指纹已登记（发布新版 skill 时要更新登记）", () => {
  assert.deepEqual(KNOWN_SKILL_TEMPLATES[version], templateFingerprint(template));
  const normalized = reference.replace(/\r\n?/g, "\n").split("\n").map((line) => line.replace(/[ \t]+$/, "")).join("\n").trim();
  const referenceHash = createHash("sha256").update(normalized, "utf8").digest("hex").slice(0, 16);
  assert.ok(Object.values(KNOWN_REFERENCE_FILES["references/spawn-route.md"]).includes(referenceHash));
  const plan = planSync({ sourceDir, targetDir: sourceDir });
  assert.equal(plan.matched, version);
  assert.deepEqual(plan.customized, []);
  assert.deepEqual(plan.writes, []);
});

test("新装：写入模板和 references，默认路由为空", () => {
  const { target, cleanup } = workspace();
  try {
    const plan = planSync({ sourceDir, targetDir: target });
    assert.equal(plan.fresh, true);
    assert.deepEqual(plan.writes.map(({ path, action }) => [path, action]), [["SKILL.md", "新增"], ["references/spawn-route.md", "新增"]]);
    const { backupDir } = applySync(plan, { stamp: "t1" });
    assert.equal(backupDir, undefined);
    assert.equal(readFileSync(join(target, "SKILL.md"), "utf8"), template.replace(/\r\n?/g, "\n"));
    assert.equal(readFileSync(join(target, "references", "spawn-route.md"), "utf8"), reference);
    assert.deepEqual(readRoute(readFileSync(join(target, "SKILL.md"), "utf8")), { provider: "", model: "", reasoningEffort: "" });
  } finally {
    cleanup();
  }
});

test("从 1.1.x 升级：认出模板版本，保留三项值，旧文件备份在 skill 目录内部", () => {
  const { root, target, cleanup } = workspace({ "SKILL.md": installed111 });
  try {
    const plan = planSync({ sourceDir, targetDir: target });
    assert.equal(plan.matched, "1.1.x");
    assert.deepEqual(plan.customized, []);
    assert.deepEqual(plan.route, ROUTE);
    const { backupDir } = applySync(plan, { stamp: "t2" });
    const upgraded = readFileSync(join(target, "SKILL.md"), "utf8");
    assert.deepEqual(readRoute(upgraded), ROUTE);
    assert.equal(upgraded, fillRoute(template, ROUTE));
    assert.equal(readFileSync(join(backupDir, "SKILL.md"), "utf8"), installed111);
    // DSH 只把 <skills>/<目录>/SKILL.md 当成 skill；备份至少深两层，不会成为第二个 team-lead。
    const depth = relative(join(root, "skills"), join(backupDir, "SKILL.md")).split(sep).length;
    assert.ok(depth >= 4, `备份路径深度 ${depth}`);
  } finally {
    cleanup();
  }
});

test("有本地改动的章节：指出章节名，默认不写入（退出码 1），--force 才覆盖并备份", () => {
  const edited = installed111.replace("## 约束\r\n", "## 约束\r\n\r\n- 我自己加的规矩。\r\n");
  const { target, cleanup } = workspace({ "SKILL.md": edited });
  try {
    const plan = planSync({ sourceDir, targetDir: target });
    assert.equal(plan.matched, undefined);
    assert.ok(plan.customized.some((item) => item.includes("「约束」")), plan.customized.join("\n"));
    const refused = run("--target", target, "--write");
    assert.equal(refused.status, 1, refused.stdout + refused.stderr);
    assert.match(refused.stdout, /发现本地改动，未写入/);
    assert.equal(readFileSync(join(target, "SKILL.md"), "utf8"), edited);
    const forced = run("--target", target, "--write", "--force");
    assert.equal(forced.status, 0, forced.stdout + forced.stderr);
    assert.deepEqual(readRoute(readFileSync(join(target, "SKILL.md"), "utf8")), ROUTE);
    const backups = readdirSync(join(target, ".backup"));
    assert.equal(backups.length, 1);
    assert.equal(readFileSync(join(target, ".backup", backups[0], "SKILL.md"), "utf8"), edited);
  } finally {
    cleanup();
  }
});

test("默认路由不是三项格式时视为本地改动", () => {
  const broken = installed111.replace(/- reasoningEffort: `high`/, "- effort: `high`");
  const { target, cleanup } = workspace({ "SKILL.md": broken });
  try {
    const plan = planSync({ sourceDir, targetDir: target });
    assert.ok(plan.customized.some((item) => item.includes("不是三项格式")));
  } finally {
    cleanup();
  }
});

test("已是最新：不写入；预览模式也不写入", () => {
  const current = fillRoute(template, ROUTE);
  const { target, cleanup } = workspace({ "SKILL.md": current, "references/spawn-route.md": reference });
  try {
    const plan = planSync({ sourceDir, targetDir: target });
    assert.equal(plan.matched, version);
    assert.deepEqual(plan.writes, []);
    const result = run("--target", target);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /已是最新，无需写入/);
  } finally {
    cleanup();
  }
  const fresh = workspace();
  try {
    const preview = run("--target", fresh.target);
    assert.equal(preview.status, 0, preview.stdout + preview.stderr);
    assert.match(preview.stdout, /预览完成：加 --write 执行/);
    assert.equal(existsSync(join(fresh.target, "SKILL.md")), false);
  } finally {
    fresh.cleanup();
  }
});

test("references 被改过时视为本地改动；目标里的额外文件保留并提示", () => {
  const { target, cleanup } = workspace({
    "SKILL.md": fillRoute(template, ROUTE),
    "references/spawn-route.md": `${reference}\n我的笔记\n`,
    "references/my-notes.md": "自己的文件\n",
  });
  try {
    const plan = planSync({ sourceDir, targetDir: target });
    assert.ok(plan.customized.includes("references/spawn-route.md 有本地改动"));
    assert.ok(plan.notes.some((note) => note.includes("references/my-notes.md")));
    applySync(plan, { stamp: "t3" });
    assert.equal(readFileSync(join(target, "references", "my-notes.md"), "utf8"), "自己的文件\n");
  } finally {
    cleanup();
  }
});

test("未知参数：退出码 2 并给出用法", () => {
  const result = run("--bogus");
  assert.equal(result.status, 2);
  assert.match(result.stderr, /用法：node scripts\/sync-skill\.mjs/);
});

test("默认目标：DSH_HOME 下的 skills/team-lead，支持 ~ 开头", () => {
  const home = mkdtempSync(join(tmpdir(), "dsh-home-"));
  try {
    const env = { ...process.env, DSH_HOME: home };
    const result = spawnSync(process.execPath, [script], { encoding: "utf8", env });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.ok(result.stdout.includes(`目标：${join(home, "skills", "team-lead")}`), result.stdout);
    const tilde = spawnSync(process.execPath, [script], { encoding: "utf8", env: { ...process.env, DSH_HOME: "~/dsh-home-test-unused" } });
    assert.ok(tilde.stdout.includes(`目标：${join(homedir(), "dsh-home-test-unused", "skills", "team-lead")}`), tilde.stdout);
    assert.equal(existsSync(join(homedir(), "dsh-home-test-unused")), false, "预览不写入");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("写入失败（目标是一个文件）：退出码 2 并说明原因", () => {
  const root = mkdtempSync(join(tmpdir(), "sync-skill-file-"));
  const file = join(root, "not-a-dir");
  writeFileSync(file, "x");
  try {
    const result = run("--target", file, "--write");
    assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.match(result.stderr, /写入失败/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("从验收前装过的 1.2.0 升级：认出 1.2.0-pre，SKILL.md 与 references 都按已发布版本更新", () => {
  const pre = readFileSync(new URL("./fixtures/team-lead-skill-1.2.0-pre.md", import.meta.url), "utf8");
  const preReference = readFileSync(new URL("./fixtures/spawn-route-1.2.0-pre.md", import.meta.url), "utf8");
  const { target, cleanup } = workspace({ "SKILL.md": fillRoute(pre, ROUTE).replace(/\n/g, "\r\n"), "references/spawn-route.md": preReference });
  try {
    const plan = planSync({ sourceDir, targetDir: target });
    assert.equal(plan.matched, "1.2.0-pre");
    assert.deepEqual(plan.customized, []);
    assert.deepEqual(plan.writes.map(({ path, action }) => [path, action]), [["SKILL.md", "更新"], ["references/spawn-route.md", "更新"]]);
    applySync(plan, { stamp: "t4" });
    assert.equal(readFileSync(join(target, "SKILL.md"), "utf8"), fillRoute(template, ROUTE));
    assert.equal(readFileSync(join(target, "references", "spawn-route.md"), "utf8"), reference);
  } finally {
    cleanup();
  }
});
