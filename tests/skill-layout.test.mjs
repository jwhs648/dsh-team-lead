// skill 与插件是一个整体：skill 引用的工具名、错误码和结果行措辞必须真实存在于插件里；
// 默认路由段保持三字段格式，安装时才能原样保留用户已填写的值。
import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { skillHostTools } from "../scripts/kernel-check.mjs";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const skill = await read("skills/team-lead/SKILL.md");
const reference = await read("skills/team-lead/references/spawn-route.md");
// 插件源码：入口加 lib/ 下的全部模块。
const pluginFiles = ["index.js", ...(await readdir(new URL("../lib/", import.meta.url))).filter((file) => file.endsWith(".js")).sort().map((file) => `lib/${file}`)];
const plugin = (await Promise.all(pluginFiles.map(read))).join("\n");

test("SKILL.md 带 front matter，名字为 team-lead", () => {
  assert.match(skill, /^---\nname: team-lead\ndescription: >-\n/);
});

test("默认路由段保持三字段格式", () => {
  const section = skill.slice(skill.indexOf("## 默认路由"), skill.indexOf("## 每次创建"));
  const fields = [...section.matchAll(/^- (\w+): `([^`]*)`$/gm)].map((match) => match[1]);
  assert.deepEqual(fields, ["provider", "model", "reasoningEffort"]);
});

test("默认路由段的说明与是否已填写无关：安装和升级只替换三项值", () => {
  const section = skill.slice(skill.indexOf("## 默认路由"), skill.indexOf("## 每次创建"));
  assert.match(section, /已填写时/);
  assert.match(section, /为空时/);
  assert.doesNotMatch(section, /还没设置|已按用户选择写好/);
});

test("协作要求是一段可原样附进 fresh 和 fork 开场任务的固定文字", () => {
  const block = skill.match(/```text\n(协作要求：\n[\s\S]*?)```/);
  assert.ok(block, "缺少 ```text 协作要求块");
  const lines = block[1].trim().split("\n");
  assert.ok(lines.slice(1).every((line) => line.startsWith("- ")), "协作要求块应为逐条列表");
  for (const phrase of ["自主推进", "send_message 告诉 lead", "继续做不受影响的部分", "不要再委派", "验证命令与结果", "消息里只给路径", "长度上限", "标记 complete"]) {
    assert.ok(block[1].includes(phrase), `协作要求缺少：${phrase}`);
  }
  assert.match(skill, /fresh 和 fork 的开场任务末尾都附上下面这段协作要求/);
});

test("skill 提到的宿主工具是已知集合（新版 DSH 由 kernel-check K18 核对仍然存在）", () => {
  assert.deepEqual(skillHostTools(`${skill}\n${reference}`), ["interrupt_agent", "list_agents", "send_message", "spawn_teammate", "team_task_create", "team_task_update", "wait_agent"]);
});

test("交给宿主策略的规则不再在 skill 里复述", () => {
  assert.match(skill, /以宿主 Agent Teams 策略为准/);
  for (const restated of ["FS_STALE_VERSION", "revision", "queued", "noProgress"]) {
    assert.ok(!skill.includes(restated), `skill 仍在复述宿主策略：${restated}`);
  }
});

test("SKILL.md 指向的 references 文件存在", () => {
  const referenced = [...skill.matchAll(/`(references\/[^`]+\.md)`/g)].map((match) => match[1]);
  assert.deepEqual(referenced, ["references/spawn-route.md"]);
  assert.ok(reference.startsWith("# 队员路由细节"));
});

test("skill 提到的工具名都由插件注册", () => {
  for (const name of ["arm_spawn_route", "get_spawn_route", "clear_spawn_route"]) {
    assert.ok(skill.includes(name) || reference.includes(name), name);
    assert.ok(plugin.includes(`"${name}"`), name);
  }
});

test("skill 引用的错误码与结果行措辞与插件输出一致", () => {
  const phrases = [
    "MEMBER_MODEL_ARM_REQUIRED",
    "member-model:",
    "WARNING",
    "stays armed for a retry",
    "was cleared or replaced meanwhile and was not restored",
    "armed route; verified on the live teammate",
    "armed follow, same as the lead",
    "plugin default route",
    "nothing armed, follows the lead; requireArm is off",
    "live teammate not found, unverified",
    "effort unset",
  ];
  for (const phrase of phrases) {
    assert.ok(skill.includes(phrase) || reference.includes(phrase), `skill 缺少：${phrase}`);
  }
  // 插件里这些措辞可能由模板拼接，逐段核对。
  for (const piece of ["MEMBER_MODEL_ARM_REQUIRED", "member-model:", "WARNING", "stays armed for a retry", "was cleared or replaced meanwhile and was not restored", "armed route", "verified on the live teammate", "armed follow, same as the lead", "plugin default route", "nothing armed, follows the lead", "requireArm is off", "live teammate not found, unverified", "effort unset"]) {
    assert.ok(plugin.includes(piece), `插件缺少：${piece}`);
  }
});

test("applied 的 source 取值与插件一致", () => {
  const listed = reference.match(/`source`（([^）]+)）/)[1].split("、");
  const declared = JSON.parse(plugin.match(/const SOURCES = (\[[^\]]+\]);/)[1]);
  assert.deepEqual(listed, declared);
});

const headings = [...skill.matchAll(/^## (.+)$/gm)].map((match) => match[1]);
const sectionOf = (title) => {
  const start = skill.indexOf(`## ${title}`);
  const next = skill.indexOf("\n## ", start + 1);
  return skill.slice(start, next < 0 ? undefined : next);
};

test("章节顺序：分工 → 工作流程 → 方法 → 路由 → 约束", () => {
  assert.deepEqual(headings, ["分工", "工作流程", "什么时候委派", "怎么交代任务", "怎么持续沟通", "怎么等待和验收", "默认路由", "每次创建", "约束"]);
});

test("分工写明用户、队长、队员、宿主与插件四方", () => {
  const section = sectionOf("分工");
  for (const role of ["- 用户：", "- 队长：", "- 队员：", "- 宿主与插件："]) assert.ok(section.includes(role), role);
});

test("工作流程先确认前提：没有 Agent Teams 或插件不支持 follow 时告诉用户，不静默跟随队长", () => {
  const section = sectionOf("工作流程");
  assert.match(section, /先确认前提/);
  assert.match(section, /`spawn_teammate`/);
  assert.match(section, /支持 `follow` 参数的 `arm_spawn_route`/);
  assert.match(section, /只有用户明确同意时才让队员跟随队长/);
  const steps = [...section.matchAll(/^(\d+)\. /gm)].map((match) => Number(match[1]));
  assert.deepEqual(steps, [1, 2, 3, 4, 5, 6]);
});

test("写明 fork 只继承已完成的轮次，开场任务同样要写清任务", () => {
  assert.match(sectionOf("怎么交代任务"), /fork 队员只继承队长已完成的轮次，看不到当前这一轮/);
  assert.match(sectionOf("每次创建"), /需要队长之前几轮的对话时，用 `fork`/);
});

test("/team-lead 调用视为授权；汇报前用 get_spawn_route 的 applied 列出各队员的实际路由", () => {
  assert.match(skill, /用户用 `\/team-lead` 调用本 skill 也视为授权/);
  assert.match(sectionOf("怎么等待和验收"), /汇报前调用一次 `get_spawn_route`，按其中的 `applied` 列出各队员负责的部分和实际路由/);
  assert.match(reference, /## applied：各队员的实际路由/);
  assert.doesNotMatch(reference, /lastApplied/);
});

test("任务板分派：队长在开场任务里指定，队员开工自己认领，队长不再 reassign 同一个任务", () => {
  assert.match(skill, /开场任务写明某个任务归你时，开工先认领（claim）它，完成后标记 complete/);
  assert.match(sectionOf("怎么持续沟通"), /谁做哪个任务由队长在开场任务里写明，队员开工时自己认领；队长不要再 reassign 同一个任务/);
  assert.doesNotMatch(skill, /创建队员后用 `team_task_update` 的 reassign 把任务分给他/);
});

test("登记和创建可以写在同一步，但必须一对一对地写", () => {
  const section = sectionOf("每次创建");
  assert.match(section, /两者可以写在同一步里，宿主会按顺序逐个执行/);
  assert.match(section, /不要先连续登记再连续创建，后一次登记会顶掉前一次/);
  assert.match(reference, /## 同一步里登记和创建/);
  assert.match(reference, /错误写法：`arm A → arm B → spawn A → spawn B`/);
});

test("核对时只看 member-model 行；上下文被压缩后重新加载 skill", () => {
  assert.match(sectionOf("每次创建"), /结果 JSON 里的 `provider` 是创建方式（spawn 或 fork），不是模型供应商/);
  assert.match(sectionOf("每次创建"), /把这一行原样告诉用户，并用中文说明哪里不一致/);
  assert.match(sectionOf("怎么交代任务"), /先重新加载 team-lead skill，不要凭记忆改写/);
});

test("公共文件和共享产物有明确负责人", () => {
  assert.match(sectionOf("什么时候委派"), /公共文件（入口、配置、依赖清单、锁文件等）指定一位负责人/);
  assert.match(sectionOf("约束"), /全量构建、测试、格式化等会改共享产物的命令由队长安排/);
});

test("README 写明 /team-lead 用法，并用同步脚本安装 skill", async () => {
  const readme = await read("README.md");
  assert.match(readme, /## 怎么开始/);
  assert.match(readme, /输入 `\/team-lead` 加任务描述/);
  assert.match(readme, /scripts\/sync-skill\.mjs --write/);
  assert.doesNotMatch(readme, /再把「默认路由」一节的三项改回用户原来的值/);
});

test("references 开头的索引指向的章节都存在，并按四组编排", () => {
  const referenceHeadings = [...reference.matchAll(/^#{2,3} (.+)$/gm)].map((match) => match[1]);
  for (const group of ["规则", "看结果", "出问题时", "配置相关"]) assert.ok(referenceHeadings.includes(group), group);
  const rows = [...reference.matchAll(/^\| [^|]+ \| ([^|]+) \|$/gm)].map((match) => match[1].trim()).filter((target) => target !== "看" && !/^-+$/.test(target));
  assert.ok(rows.length >= 8);
  for (const target of rows) {
    assert.ok(referenceHeadings.some((heading) => heading.startsWith(target)), `索引指向不存在的章节：${target}`);
  }
});

test("README 分为使用与维护两部分，历史验收只留在 CHANGELOG", async () => {
  const readme = await read("README.md");
  const order = ["## 安装时请 agent 按这个顺序做", "## 怎么开始", "## 装好之后的行为（摘要）", "## 插件配置", "## 停用与卸载", "## 常见情况", "## 插件细节（维护者）", "## 新版 DSH 的兼容复查", "## 开发与验证"];
  const positions = order.map((heading) => readme.indexOf(heading));
  assert.ok(positions.every((position) => position >= 0), positions.join(","));
  assert.deepEqual([...positions].sort((a, b) => a - b), positions);
  assert.doesNotMatch(readme, /### 1\.1\.1 rc\.2 适配验收/);
  assert.match(readme, /三项无法表示「默认跟随」/);
});
