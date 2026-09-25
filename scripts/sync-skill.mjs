#!/usr/bin/env node
// 把同一个包里的 team-lead skill 同步到用户的 skills 目录：保留已填写的三项默认路由；
// 现有副本若有模板以外的本地改动，默认不覆盖。
//
// 用法：
//   node scripts/sync-skill.mjs [--target <目录>] [--write] [--force]
//
//   --target  目标 skill 目录，默认 $DSH_HOME/skills/team-lead（未设置 DSH_HOME 时为 ~/.dsh）
//   --write   真正写入；不加时只预览
//   --force   现有副本有本地改动时仍然覆盖（会先备份）
//
// 退出码：0 = 完成或预览正常；1 = 发现本地改动而未覆盖；2 = 参数或读写错误。
// 覆盖前把要被替换的文件备份到 <目标>/.backup/<时间>/。备份放在 skill 目录内部，
// DSH 不会把它当成另一个 team-lead skill。
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROUTE_TITLE = "默认路由";
const PREAMBLE = "(开头)";
const ROUTE_FIELDS = ["provider", "model", "reasoningEffort"];

// 已发布的 SKILL.md 模板指纹：每节正文的 sha256 前 16 位，「默认路由」一节不计。
// 1.2.0-pre 是 2026-09-25 实机验收前装过的 1.2.0 版本，登记在这里，才能把它平滑升级到修复后的 1.2.0。
// 发布新版 skill 时在这里登记新版本（tests/sync-skill.test.mjs 会检查当前版本已登记）。
export const KNOWN_SKILL_TEMPLATES = {
  "1.0.0": {
    "(开头)": "4c39b85032c5d23a",
    "什么时候建队员": "7d7251c173bbc9d4",
    "怎么沟通": "6ad2f17fea31f734",
    "每次创建": "1a6686f280a43c47",
    "约束": "3e62d570f530ac1b",
  },
  "1.1.x": {
    "(开头)": "c91c83258d0d99e8",
    "什么时候委派": "9b9501a612bc01e7",
    "怎么交代任务": "fc4fb98fa5c818e0",
    "怎么持续沟通": "1fe2c78b6cf3c39b",
    "怎么等待和验收": "e8dcf5a35e48720f",
    "每次创建": "99fce34207e5bf57",
    "约束": "6e0bd017268530bc",
  },
  "1.2.0-pre": {
    "(开头)": "586c599aedfae758",
    "分工": "4233f5732a599357",
    "工作流程": "49c99dd1cead78f2",
    "什么时候委派": "b47737ba6039c1ca",
    "怎么交代任务": "e697b199b5b76ce4",
    "怎么持续沟通": "7688c642fdc07c22",
    "怎么等待和验收": "733b0d81f76c0889",
    "每次创建": "9b487ab3bea10445",
    "约束": "e25c3728a9cc0b98",
  },
  "1.2.0": {
    "(开头)": "586c599aedfae758",
    "分工": "4233f5732a599357",
    "工作流程": "49c99dd1cead78f2",
    "什么时候委派": "b47737ba6039c1ca",
    "怎么交代任务": "1b8347eba5077e5b",
    "怎么持续沟通": "7688c642fdc07c22",
    "怎么等待和验收": "733b0d81f76c0889",
    "每次创建": "90f4d97f12975f44",
    "约束": "e25c3728a9cc0b98",
  },
};

// 已发布的 references 文件指纹（整文件 sha256 前 16 位）。
export const KNOWN_REFERENCE_FILES = {
  "references/spawn-route.md": {
    "1.2.0-pre": "988b2708c1e75391",
    "1.2.0": "986f05c10a4e12ee",
  },
};

const hash = (text) => createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
const normalize = (text) => text.replace(/\r\n?/g, "\n").split("\n").map((line) => line.replace(/[ \t]+$/, "")).join("\n").trim();

export function splitSections(text) {
  const sections = [];
  let title = PREAMBLE;
  let lines = [];
  for (const line of normalize(text).split("\n")) {
    const heading = /^## (.+)$/.exec(line);
    if (heading) {
      sections.push({ title, body: lines.join("\n").trim() });
      title = heading[1].trim();
      lines = [];
    } else lines.push(line);
  }
  sections.push({ title, body: lines.join("\n").trim() });
  return sections;
}

export function templateFingerprint(text) {
  const fingerprint = {};
  for (const { title, body } of splitSections(text)) {
    if (title !== ROUTE_TITLE) fingerprint[title] = hash(body);
  }
  return fingerprint;
}

export function readRoute(text) {
  const section = splitSections(text).find((entry) => entry.title === ROUTE_TITLE);
  if (section === undefined) return undefined;
  const route = {};
  for (const line of section.body.split("\n")) {
    const match = /^- (provider|model|reasoningEffort): `([^`]*)`$/.exec(line);
    if (match) route[match[1]] = match[2];
  }
  return ROUTE_FIELDS.every((field) => field in route) ? route : undefined;
}

export function fillRoute(template, route) {
  let filled = template.replace(/\r\n?/g, "\n");
  for (const field of ROUTE_FIELDS) {
    const pattern = new RegExp(`^- ${field}: \`[^\`]*\`$`, "m");
    if (!pattern.test(filled)) throw new Error(`模板的「${ROUTE_TITLE}」缺少 ${field} 行`);
    filled = filled.replace(pattern, `- ${field}: \`${route[field] ?? ""}\``);
  }
  return filled;
}

function sameFingerprint(left, right) {
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every((key) => left[key] === right[key]);
}

// 哪些章节是本地改动：该节正文不等于任何已发布模板里同名章节的正文。
function customizedSections(fingerprint, known) {
  const changed = [];
  for (const [title, value] of Object.entries(fingerprint)) {
    if (!Object.values(known).some((template) => template[title] === value)) changed.push(title);
  }
  return changed;
}

function listFiles(root, base = root) {
  if (!existsSync(root)) return [];
  const files = [];
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    if (statSync(path).isDirectory()) files.push(...listFiles(path, base));
    else files.push(relative(base, path).split(sep).join("/"));
  }
  return files.sort();
}

export function planSync({ sourceDir, targetDir, knownTemplates = KNOWN_SKILL_TEMPLATES, knownReferences = KNOWN_REFERENCE_FILES }) {
  const template = readFileSync(join(sourceDir, "SKILL.md"), "utf8");
  const plan = { sourceDir, targetDir, writes: [], customized: [], notes: [], route: undefined, matched: undefined, fresh: false };
  const targetSkill = join(targetDir, "SKILL.md");
  let route = { provider: "", model: "", reasoningEffort: "" };
  if (!existsSync(targetSkill)) {
    plan.fresh = true;
    plan.notes.push("目标还没有 team-lead skill，将新装；默认路由为空，首次组队时队长会先问你。");
  } else {
    const current = readFileSync(targetSkill, "utf8");
    const found = readRoute(current);
    if (found === undefined) plan.customized.push(`SKILL.md「${ROUTE_TITLE}」一节不是三项格式，读不到 provider、model、reasoningEffort`);
    else route = found;
    const fingerprint = templateFingerprint(current);
    plan.matched = Object.entries(knownTemplates).find(([, known]) => sameFingerprint(fingerprint, known))?.[0];
    if (plan.matched === undefined) {
      const changed = customizedSections(fingerprint, knownTemplates);
      plan.customized.push(changed.length > 0
        ? `SKILL.md 有本地改动的章节：${changed.map((title) => `「${title}」`).join("、")}`
        : "SKILL.md 的章节组成与任何已发布版本都不同（有章节被增删或改名）");
    }
  }
  plan.route = route;
  const nextSkill = fillRoute(template, route);
  const currentSkill = plan.fresh ? undefined : readFileSync(targetSkill, "utf8").replace(/\r\n?/g, "\n");
  if (currentSkill !== nextSkill) plan.writes.push({ path: "SKILL.md", action: plan.fresh ? "新增" : "更新", content: nextSkill });

  for (const file of listFiles(join(sourceDir, "references"))) {
    const path = `references/${file}`;
    const content = readFileSync(join(sourceDir, path), "utf8");
    const target = join(targetDir, path);
    if (!existsSync(target)) {
      plan.writes.push({ path, action: "新增", content });
      continue;
    }
    const existing = readFileSync(target, "utf8");
    if (normalize(existing) === normalize(content)) continue;
    const knownHashes = Object.values(knownReferences[path] ?? {});
    if (!knownHashes.includes(hash(normalize(existing)))) plan.customized.push(`${path} 有本地改动`);
    plan.writes.push({ path, action: "更新", content });
  }
  const shipped = new Set(listFiles(join(sourceDir, "references")).map((file) => `references/${file}`));
  for (const file of listFiles(join(targetDir, "references"))) {
    if (!shipped.has(`references/${file}`)) plan.notes.push(`保留目标里的额外文件 references/${file}`);
  }
  return plan;
}

export function applySync(plan, { stamp = new Date().toISOString().replace(/[:.]/g, "-") } = {}) {
  const backups = [];
  const backupDir = join(plan.targetDir, ".backup", stamp);
  for (const { path } of plan.writes) {
    const target = join(plan.targetDir, path);
    if (!existsSync(target)) continue;
    const copy = join(backupDir, path);
    mkdirSync(dirname(copy), { recursive: true });
    copyFileSync(target, copy);
    backups.push(copy);
  }
  for (const { path, content } of plan.writes) {
    const target = join(plan.targetDir, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, "utf8");
  }
  return { backupDir: backups.length > 0 ? backupDir : undefined, backups };
}

function defaultTarget() {
  const configured = process.env.DSH_HOME?.trim();
  const expand = (path) => (path === "~" ? homedir() : /^~[\\/]/.test(path) ? join(homedir(), path.slice(2)) : path);
  return join(resolve(configured ? expand(configured) : join(homedir(), ".dsh")), "skills", "team-lead");
}

function parseArgs(argv) {
  const options = { target: undefined, write: false, force: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--write") options.write = true;
    else if (arg === "--force") options.force = true;
    else if (arg === "--target") {
      options.target = argv[index + 1];
      if (options.target === undefined) throw new Error("--target 需要一个目录");
      index += 1;
    } else throw new Error(`未知参数 ${arg}\n用法：node scripts/sync-skill.mjs [--target <目录>] [--write] [--force]`);
  }
  return options;
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const version = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")).version;
  const sourceDir = join(repo, "skills", "team-lead");
  const targetDir = resolve(options.target ?? defaultTarget());
  let plan;
  try {
    plan = planSync({ sourceDir, targetDir });
  } catch (error) {
    console.error(`读取失败：${error.message}`);
    process.exit(2);
  }
  const route = plan.route;
  console.log(`member-model ${version} · team-lead skill 同步${options.write ? "" : "（预览）"}`);
  console.log(`来源：${sourceDir}`);
  console.log(`目标：${targetDir}`);
  if (!plan.fresh) console.log(`现有副本：${plan.matched ? `${plan.matched} 版模板，没有其他本地改动` : "与已发布模板不一致"}`);
  console.log(`默认路由：provider=\`${route.provider}\`，model=\`${route.model}\`，reasoningEffort=\`${route.reasoningEffort}\`${plan.fresh ? "" : "（沿用现有副本）"}`);
  for (const note of plan.notes) console.log(`说明：${note}`);
  for (const item of plan.customized) console.log(`本地改动：${item}`);
  if (plan.writes.length === 0) {
    console.log("已是最新，无需写入。");
    return;
  }
  for (const { path, action } of plan.writes) console.log(`${action}：${path}`);
  if (plan.customized.length > 0 && !options.force) {
    console.log("发现本地改动，未写入。先把需要保留的改动记下来；确认可以覆盖时加 --force（会先备份）。");
    process.exit(1);
  }
  if (!options.write) {
    console.log("预览完成：加 --write 执行。");
    return;
  }
  try {
    const { backupDir } = applySync(plan);
    if (backupDir) console.log(`已备份到：${backupDir}`);
    console.log("已写入。新开会话后生效。");
  } catch (error) {
    console.error(`写入失败：${error.message}`);
    process.exit(2);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
