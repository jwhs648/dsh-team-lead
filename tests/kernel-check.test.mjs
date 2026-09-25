// scripts/kernel-check.mjs 的离线自检：用最小化的假内核包验证 PASS/FAIL 判定与证据定位，
// 不访问网络。真实版本请运行 node scripts/kernel-check.mjs <版本>。
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { PACKAGES, POLICY_RULES, SKILL_FILES, runChecks, skillHostTools, untar } from "../scripts/kernel-check.mjs";

const VERSION = "9.9.9-rc.1";
const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const skillText = SKILL_FILES.map((file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8")).join("\n");

// 宿主 team:policy 的最小替身：与真实策略相同的规则句子，各占一行。
const POLICY = [
  "Write-scope overlap is advisory, not a lock.",
  "If a file operation returns FS_STALE_VERSION, read the current file, rebase your intended change onto the new content, and retry. Bash, formatters, code generators, and scripts are not fully protected by the filesystem version guard; coordinate them explicitly and have the Lead review the final diff and run tests.",
  "Use the target returned by spawn_teammate or list_agents for send_message and interrupt_agent, or as owner when assigning or filtering shared tasks. inactive means no turn is executing; it does not describe task completion, success, failure, or waiting for other agents. A successful send is already durable even when its result says queued; do not resend it. Shared-task workflow is list, get, claim with the current revision, perform the work, then complete. Task readiness never starts an owner. Before wait_agent, use list_agents and make sure another required member is running or provisioning; use send_message first when the required member is inactive. The Lead must wait for required teammates before giving the final answer.",
].join("\n\n");

// 每个文件只放各检查项的锚点行，结构与真实内核一致。
const FILES = {
  "dsh-subagent/lib/index.js": `
function delegationDepthOf(agent) {
\tconst runtime = agent.options.subagentDepth;
\treturn Math.max(agent.session.header.delegationDepth ?? 0, runtime ?? 0);
}
function parentAgentOptionsForDelegation(parent) {
\tconst requestConfig = parent.session.requestHeader()?.config;
}
function resolveChildAgentOptions(parent, requested, childDepth) {
\tconst parentOptions = parentAgentOptionsForDelegation(parent);
\tconst resolved = { subagentDepth: childDepth };
\tif ((resolved.provider !== parentProvider || resolved.model !== parentModel) && requested?.reasoningEffort === void 0) delete resolved.reasoningEffort;
}
class Runtime {
\tasync startContinuable(spec) {
\t\tconst agentOptions = resolveChildAgentOptions(parent, request.agentOptions, childDepth);
\t}
\tasync start(name, request) {
\t}
}`,
  "dsh-agent/lib/index.js": `
\t\tconst args = [
\t\t\tentry.carrier,
\t\t\t"agent/disposed",
\t\t];
\t\t\tawait this.ctx.serial(entry.carrier, "agent/created", {
\tget(id) {
\tlist() {`,
  "dsh-tools/lib/index.js": `
\trestrict(filter) {
\t\tif (unknown.length > 0) throw new Error(\`tools.restrict() names unknown global tool\`);
\t\t\trestrictableNames.add(name);
\t\tconst token = createExecutionToken();
\t\t\t\t\tparent: exec.token,
\t\t\t\t\t\t\tfor (const context of result.additionalContexts ?? []) exec.deferContext(context);
\t\tif (!tool?.isConcurrencySafe) return { kind: "exclusive" };
\t\t\tconst result = await this.ctx.waterfall(carrier, "tools/execute", mutableExec, () => this.dispatchToolBody(mutableExec));
\t\t\treturn toolErrorResult(error);
\t\t\t\tkind: "final-result",
\t\tconst decision = await this.ctx.waterfall(scopeTarget(this, exec.agent), "tools/post-execute", exec, result, () => Promise.resolve({ kind: "accept" }));
\t\tif (decision.kind === "block") {
\t\tif (Object.hasOwn(decision, "content") && Object.hasOwn(decision, "value")) throw new TypeError("tools/post-execute accept decision cannot replace both value and content");
\t\tconst additionalContexts = [...result.additionalContexts ?? [], ...decisionContexts];
\t\t\t...decision.content !== void 0 ? { content: decision.content } : {},`,
  "dsh-scope/lib/index.js": `
function scopeTarget(base, key) {
\t\tif (tag === void 0) return true;
}`,
  "dsh-llm/lib/index.js": `
\t\tasync resolveCallConfig(config, signal) {`,
  "dsh-app-boot/lib/index.js": `
\t[".svg", "image/svg+xml"],
\t\tconst resource = \`\${specifier}/locale/\${entry.name}\`;`,
  "dsh-experimental-agent-team/lib/index.js": `
\t\t\tconst model = live?.options.model ?? root.options.model;
\t\t\tif (state.members.some((member) => member.name === name)) throw new TeamError(\`teammate name "\${name}" was already used in this Team\`, "TEAM_MEMBER_NAME_TAKEN");
\t\t\tif (state.members.length >= this.maxMembers) throw new TeamError(\`Team member limit \${this.maxMembers} reached\`, "TEAM_MEMBER_LIMIT");
\t\t\t\tif (!lead && !owner) throw new TeamError("task mutation requires its owner or Team Lead", "TEAM_TASK_UNAUTHORIZED");
\t\t\t\t\tif (!lead) throw new TeamError("only the Team Lead can reassign tasks", "TEAM_LEAD_REQUIRED");
\t\tconst operation = this.spawnAdmitted(caller, request);
\tasync spawnAdmitted(caller, request) {
\t\tif (membership.role !== "lead") throw new TeamError("only the Team Lead can create teammates", "TEAM_LEAD_REQUIRED");
\t\t\tstarted = await this.ctx.subagents.startContinuable({
\t\t\t\tchildId,
\t\t\t\tprovider: request.provider,
\t\t\t\trequest: {
\t\t\t\t\tprompt: request.prompt,
\t\t\t\t\tparent: root
\t\t\t\t},
\t\t\t\tsignal
\t\t\t});
\t}
\tmemberView(member) {
\t\tconst live = this.ctx.agents.get(member.id);
\t\treturn {
\t\t\t...live?.options.model === void 0 ? {} : { model: live.options.model },
\t\t};
\t}
\tasync spawnTeammate(caller, request) {
\t\treturn await this.roster.spawn(caller, request);
\t}`,
  "dsh-experimental-tool-agent-team/lib/index.js": `
const POLICY = \`${POLICY}\`;
\t\t\tname: "send_message",
\t\t\tname: "list_agents",
\t\t\tname: "wait_agent",
\t\t\t\tif (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1e4 || timeoutMs > 36e5) return await ctx.agentTeams.waitForChange(caller, timeoutMs, exec.signal);
\t\t\tname: "interrupt_agent",
\t\t\tdescription: "Interrupt one teammate's current turn while preserving its pending inbox. Team Lead only.",
\t\t\tname: "team_task_create",
\t\t\tname: "team_task_update",
\t\t\tname: "spawn_teammate",
\t\t\t\t\tenum: ["fresh", "fork"],
\t\t\t\tconst context = args.context ?? "fresh";
\t\t\t\t\tprovider: context === "fork" ? config.forkProvider : config.freshProvider,
\t\tregister(scoped.tools.register(defineTool({`,
  "dsh-agent-loop/lib/index.js": `
\t\tconst outcome = await runGroup(ctx, turn, step, mode === "parallel" ? planned.slice(next) : [first], mode, signal, acceptContext);`,
  "dsh-subagent-fork-in-process/lib/index.js": `
function completedTurnPrefix(parent) {
\tconst events = parent.session.snapshotEvents();
\tconst lastEnd = events.findLast((e) => e.type === "turn/end");
\tif (lastEnd === void 0) return [];
\treturn events.slice(0, lastEnd.seq + 1);
}
\t\tconst seed = completedTurnPrefix(request.parent);`,
  "dsh-experimental-agent-team-profile/cordis.patch.yml": `
    - id: tool-agent-team
      config:
        freshProvider: spawn
        forkProvider: fork
`,
};

function fixture(overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), "kernel-check-"));
  for (const name of PACKAGES) {
    mkdirSync(join(root, name, "package"), { recursive: true });
    writeFileSync(join(root, name, "package", "package.json"), JSON.stringify({ name: `@deepseek-ai/${name}`, version: VERSION }));
  }
  for (const [path, text] of Object.entries({ ...FILES, ...overrides })) {
    const [name, ...rest] = path.split("/");
    const target = join(root, name, "package", ...rest);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, text);
  }
  return root;
}

const levels = (results) => Object.fromEntries(results.map((result) => [result.id, result.level]));

test("锚点齐全时全部 PASS，未声明的版本只给 INFO", () => {
  const root = fixture();
  try {
    const results = runChecks(root, VERSION, manifest, skillText);
    const byId = levels(results);
    assert.equal(byId.K02, "INFO");
    for (const [id, level] of Object.entries(byId)) if (id !== "K02") assert.equal(level, "PASS", id);
    const k06 = results.find((result) => result.id === "K06");
    assert.ok(k06.evidence.some((item) => /dsh-experimental-agent-team\/lib\/index\.js:\d+$/.test(item.where)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("建队员调用开始自带 agentOptions 时 K06 FAIL 并说明原因", () => {
  const original = FILES["dsh-experimental-agent-team/lib/index.js"];
  const root = fixture({
    "dsh-experimental-agent-team/lib/index.js": original.replace("\t\t\t\tchildId,\n", "\t\t\t\tchildId,\n\t\t\t\tagentOptions: request.agentOptions,\n"),
  });
  try {
    const k06 = runChecks(root, VERSION, manifest, skillText).find((result) => result.id === "K06");
    assert.equal(k06.level, "FAIL");
    assert.ok(k06.missing.some((item) => item.includes("不应自带 agentOptions")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("耦合点消失时对应项 FAIL；缺包时版本项 FAIL", () => {
  const root = fixture({ "dsh-tools/lib/index.js": FILES["dsh-tools/lib/index.js"].replace("restrict(filter) {", "mask(filter) {") });
  rmSync(join(root, "dsh-llm"), { recursive: true, force: true });
  try {
    const byId = levels(runChecks(root, VERSION, manifest, skillText));
    assert.equal(byId.K13, "FAIL");
    assert.equal(byId.K14, "FAIL");
    assert.equal(byId.K01, "FAIL");
    assert.equal(byId.K10, "PASS");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("已声明的版本 K02 PASS", () => {
  const root = fixture();
  try {
    const declared = { ...manifest, peerDependencies: { "@deepseek-ai/dsh": `0.1.7-rc.2 || ${VERSION}` } };
    assert.equal(levels(runChecks(root, VERSION, declared, skillText)).K02, "PASS");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("宿主策略删掉 skill 依赖的规则时 K18 FAIL，并指出是哪一条", () => {
  const original = FILES["dsh-experimental-tool-agent-team/lib/index.js"];
  const root = fixture({
    "dsh-experimental-tool-agent-team/lib/index.js": original.replace("A successful send is already durable even when its result says queued; do not resend it. ", ""),
  });
  try {
    const k18 = runChecks(root, VERSION, manifest, skillText).find((result) => result.id === "K18");
    assert.equal(k18.level, "FAIL");
    assert.ok(k18.missing.some((item) => item.includes("queued 已持久化、不要重发")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("skill 提到宿主没有的工具时 K18 FAIL；读不到 skill 时也 FAIL", () => {
  const root = fixture();
  try {
    const extra = runChecks(root, VERSION, manifest, `${skillText}\n用 \`team_task_archive\` 归档。`).find((result) => result.id === "K18");
    assert.equal(extra.level, "FAIL");
    assert.ok(extra.missing.some((item) => item.includes("team_task_archive")));
    const empty = runChecks(root, VERSION, manifest, "").find((result) => result.id === "K18");
    assert.equal(empty.level, "FAIL");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("skillHostTools 只收宿主工具名，不收插件工具和参数名", () => {
  assert.deepEqual(skillHostTools("先 `arm_spawn_route`，再 `spawn_teammate`；`wait_agent` 的 `timeout_ms`；send_message 给 lead"), ["send_message", "spawn_teammate", "wait_agent"]);
  assert.ok(POLICY_RULES.length >= 10);
});

test("spawn_teammate 变成可并行调用时 K20 FAIL", () => {
  const original = FILES["dsh-experimental-tool-agent-team/lib/index.js"];
  const root = fixture({
    "dsh-experimental-tool-agent-team/lib/index.js": original.replace('\t\t\tname: "spawn_teammate",', '\t\t\tname: "spawn_teammate",\n\t\t\tisConcurrencySafe: () => true,'),
  });
  try {
    const k20 = runChecks(root, VERSION, manifest, skillText).find((result) => result.id === "K20");
    assert.equal(k20.level, "FAIL");
    assert.ok(k20.missing.some((item) => item.includes("isConcurrencySafe")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("宿主不再把子调用的 additionalContexts 转交给 run_code 时 K21 FAIL", () => {
  const original = FILES["dsh-tools/lib/index.js"];
  const root = fixture({ "dsh-tools/lib/index.js": original.replace("for (const context of result.additionalContexts ?? []) exec.deferContext(context);", "") });
  try {
    const k21 = runChecks(root, VERSION, manifest, skillText).find((result) => result.id === "K21");
    assert.equal(k21.level, "FAIL");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("解包器：支持 ustar prefix 长路径，拒绝越出目标目录的条目", () => {
  const entry = (name, body, prefix = "") => {
    const header = Buffer.alloc(512);
    header.write(name, 0, "utf8");
    header.write("0000644\0", 100);
    header.write(body.length.toString(8).padStart(11, "0") + "\0", 124);
    header.write("0", 156);
    header.write("ustar\0", 257);
    header.write(prefix, 345, "utf8");
    const data = Buffer.alloc(Math.ceil(body.length / 512) * 512);
    Buffer.from(body).copy(data);
    return Buffer.concat([header, data]);
  };
  const root = mkdtempSync(join(tmpdir(), "untar-"));
  try {
    const good = gzipSync(Buffer.concat([entry("index.js", "ok", "package/lib"), Buffer.alloc(1024)]));
    untar(good, root);
    assert.equal(readFileSync(join(root, "package", "lib", "index.js"), "utf8"), "ok");
    const evil = gzipSync(Buffer.concat([entry("../escape.js", "x"), Buffer.alloc(1024)]));
    assert.throws(() => untar(evil, join(root, "inner")), /escapes destination/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// 命令行入口：维护者真正用的是它。用假内核包离线运行，不联网。
const script = fileURLToPath(new URL("../scripts/kernel-check.mjs", import.meta.url));
const cli = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });

test("命令行：离线检查全部通过时退出码 0，输出逐项结果和汇总", () => {
  const root = fixture();
  try {
    const result = cli(VERSION, "--cache", root, "--offline");
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /^PASS K06 /m);
    assert.match(result.stdout, /^INFO K02 /m);
    assert.match(result.stdout, /结果：\d+ PASS，0 FAIL，1 INFO/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("命令行：有 FAIL 时退出码 1，并给出下一步提示", () => {
  const original = FILES["dsh-experimental-agent-team/lib/index.js"];
  const root = fixture({ "dsh-experimental-agent-team/lib/index.js": original.replace("\t\t\t\tchildId,\n", "\t\t\t\tchildId,\n\t\t\t\tagentOptions: request.agentOptions,\n") });
  try {
    const result = cli(VERSION, "--cache", root, "--offline");
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /^FAIL K06 /m);
    assert.match(result.stdout, /不要直接放宽 peer 范围/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("命令行：参数错误或离线缺包时退出码 2", () => {
  const bad = cli("not-a-version");
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /用法：node scripts\/kernel-check\.mjs/);
  assert.equal(cli(VERSION, "--registry", "http://x & y").status, 2);
  const empty = mkdtempSync(join(tmpdir(), "kernel-check-empty-"));
  try {
    const missing = cli(VERSION, "--cache", empty, "--offline");
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /缓存里没有 dsh（--offline）/);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});
