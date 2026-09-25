#!/usr/bin/env node
// 新版 DSH 内核的快速兼容复查：下载与 dsh 同版本发布的内核包，静态核对 member-model
// 依赖的每个耦合点、以及 team-lead skill 依赖的宿主工具与团队策略是否还在，逐项输出
// PASS/FAIL 和「文件:行号」证据。
//
// 用法：
//   node scripts/kernel-check.mjs <dsh 版本> [--cache <目录>] [--registry <url>] [--proxy <url>] [--offline]
//
//   --cache     包缓存目录，默认 node_modules/.cache/kernel-check/<版本>（已下载的包直接复用；
//               放在 node_modules 下，不会被 git 跟踪，也不会被 node --test 当成测试收集）
//   --registry  传给 npm pack 的 registry
//   --proxy     传给 npm pack 的 --proxy 与 --https-proxy
//   --offline   不下载，只检查缓存里已有的包
//
// 退出码：0 = 全部 PASS；1 = 有 FAIL；2 = 参数或下载错误。
// 全部 PASS 只说明静态耦合点仍在，不能代替 scripts/live-checklist.md 的实机验收。
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, normalize, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";

const SCOPE = "@deepseek-ai";
export const PACKAGES = [
  "dsh",
  "dsh-subagent",
  "dsh-agent",
  "dsh-tools",
  "dsh-scope",
  "dsh-llm",
  "dsh-app-boot",
  "dsh-experimental-agent-team",
  "dsh-experimental-tool-agent-team",
  "dsh-experimental-agent-team-profile",
  "dsh-subagent-fork-in-process",
  "dsh-agent-loop",
];
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const SAFE_ARG = /^[^\s&|<>^"'`]+$/;

// team-lead skill 的文件（相对仓库根目录）。
export const SKILL_FILES = ["skills/team-lead/SKILL.md", "skills/team-lead/references/spawn-route.md"];
const PLUGIN_TOOLS = new Set(["arm_spawn_route", "get_spawn_route", "clear_spawn_route"]);
// skill 里出现、但不是 Agent Teams 工具的 snake_case 词：宿主工具的参数名，以及宿主
// 自带的 run_code（PTC 传输工具，由 dsh-tools 提供，不在 Agent Teams 工具集里）。
const TOOL_PARAMETERS = new Set(["timeout_ms", "run_code"]);

// skill 不再复述、交给宿主 team:policy 的规则。宿主改写或删掉任何一条，都要人工确认
// skill 是否需要补回相应说明。
export const POLICY_RULES = [
  ["target 用法", /Use the target returned by spawn_teammate or list_agents for send_message and interrupt_agent/],
  ["queued 已持久化、不要重发", /A successful send is already durable even when its result says queued; do not resend it\./],
  ["inactive 不代表完成", /inactive means no turn is executing; it does not describe task completion/],
  ["任务板流程：list、get、带 revision claim、完成", /Shared-task workflow is list, get, claim with the current revision, perform the work, then complete\./],
  ["任务就绪不会启动 owner", /Task readiness never starts an owner\./],
  ["等待前先 list_agents、先唤醒 inactive 成员", /Before wait_agent, use list_agents and make sure another required member is running or provisioning; use send_message first when the required member is inactive\./],
  ["FS_STALE_VERSION 的处理", /If a file operation returns FS_STALE_VERSION, read the current file, rebase your intended change onto the new content, and retry\./],
  ["写入范围只是提示", /Write-scope overlap is advisory, not a lock\./],
  ["脚本、格式化要显式协调", /coordinate them explicitly/],
  ["队长必须等必要队员完成", /The Lead must wait for required teammates before giving the final answer\./],
];

// skill 提到的宿主工具名：反引号或正文里的 snake_case 小写词，去掉插件自己的工具和参数名。
export function skillHostTools(text) {
  const names = new Set(text.match(/\b[a-z]+(?:_[a-z]+)+\b/g) ?? []);
  return [...names].filter((name) => !PLUGIN_TOOLS.has(name) && !TOOL_PARAMETERS.has(name)).sort();
}

// ---------- 下载与解包 ----------

function untar(buffer, destination) {
  const data = gunzipSync(buffer);
  let offset = 0;
  let longName;
  let paxPath;
  const root = resolve(destination);
  while (offset + 512 <= data.length) {
    const header = data.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const field = (start, length) => header.subarray(start, start + length).toString("utf8").replace(/\0[\s\S]*$/, "");
    const size = parseInt(field(124, 12).trim() || "0", 8);
    const type = String.fromCharCode(header[156] || 48);
    const body = data.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;
    if (type === "L") { longName = body.toString("utf8").replace(/\0[\s\S]*$/, ""); continue; }
    if (type === "x") {
      for (const record of body.toString("utf8").split("\n")) {
        const match = /^\d+ path=(.*)$/.exec(record);
        if (match) paxPath = match[1];
      }
      continue;
    }
    if (type === "g") continue;
    const prefix = field(345, 155);
    const name = longName ?? paxPath ?? (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100));
    longName = undefined;
    paxPath = undefined;
    const target = resolve(root, normalize(name));
    if (target !== root && !target.startsWith(root + sep)) throw new Error(`tar entry escapes destination: ${name}`);
    if (type === "5") { mkdirSync(target, { recursive: true }); continue; }
    if (type !== "0" && type !== "7") continue;
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, body);
  }
}

function npmPack(spec, cwd, flags) {
  const args = ["pack", spec, "--silent", ...flags];
  // Windows 上 npm 是 .cmd，需要 shell；参数已校验，不含空格与 shell 元字符。
  const result = spawnSync("npm", args, { cwd, encoding: "utf8", shell: process.platform === "win32" });
  if (result.status !== 0) throw new Error(`npm pack ${spec} 失败：${(result.stderr || result.stdout || String(result.error)).trim()}`);
  const file = result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
  if (!file || !existsSync(join(cwd, file))) throw new Error(`npm pack ${spec} 没有产出 tarball`);
  return join(cwd, file);
}

export function fetchPackages(version, cache, { registry, proxy, offline } = {}) {
  const flags = [];
  if (registry) flags.push(`--registry=${registry}`);
  if (proxy) flags.push(`--proxy=${proxy}`, `--https-proxy=${proxy}`);
  const tarballs = join(cache, "_tgz");
  for (const name of PACKAGES) {
    if (existsSync(join(cache, name, "package", "package.json"))) continue;
    if (offline) throw new Error(`缓存里没有 ${name}（--offline）`);
    mkdirSync(tarballs, { recursive: true });
    process.stdout.write(`下载 ${SCOPE}/${name}@${version} … `);
    const file = npmPack(`${SCOPE}/${name}@${version}`, tarballs, flags);
    untar(readFileSync(file), join(cache, name));
    process.stdout.write("ok\n");
  }
}

// ---------- 静态检查 ----------

function source(cache, name, file) {
  const path = join(cache, name, "package", file);
  if (!existsSync(path)) return undefined;
  return { label: `${name}/${file}`, lines: readFileSync(path, "utf8").split(/\r?\n/) };
}

function hits(src, pattern, limit = 3) {
  if (src === undefined) return [];
  const found = [];
  src.lines.forEach((text, index) => {
    if (found.length < limit && pattern.test(text)) found.push({ where: `${src.label}:${index + 1}`, text: text.trim() });
  });
  return found;
}

// 从匹配行开始按括号配对截出一个调用块，用于检查调用参数的形状。
function block(src, pattern) {
  if (src === undefined) return undefined;
  const start = src.lines.findIndex((text) => pattern.test(text));
  if (start < 0) return undefined;
  let depth = 0;
  let seen = false;
  const taken = [];
  for (let index = start; index < src.lines.length && index < start + 80; index += 1) {
    const text = src.lines[index];
    taken.push(text);
    for (const char of text) {
      if (char === "(" || char === "{") { depth += 1; seen = true; }
      if (char === ")" || char === "}") depth -= 1;
    }
    if (seen && depth <= 0) break;
  }
  return { where: `${src.label}:${start + 1}`, text: taken.join("\n") };
}

function requireAll(src, patterns) {
  const evidence = [];
  const missing = [];
  for (const [label, pattern] of patterns) {
    const found = hits(src, pattern, 1);
    if (found.length === 0) missing.push(label);
    else evidence.push(...found);
  }
  return { pass: missing.length === 0, evidence, missing };
}

function peerVersions(manifest) {
  const range = manifest.peerDependencies?.[`${SCOPE}/dsh`] ?? "";
  return range.split("||").map((part) => part.trim()).filter(Boolean);
}

export function runChecks(cache, version, manifest, skillText = "") {
  const src = (name, file = "lib/index.js") => source(cache, name, file);
  const subagent = src("dsh-subagent");
  const agent = src("dsh-agent");
  const tools = src("dsh-tools");
  const scope = src("dsh-scope");
  const llm = src("dsh-llm");
  const boot = src("dsh-app-boot");
  const team = src("dsh-experimental-agent-team");
  const teamTool = src("dsh-experimental-tool-agent-team");
  const profile = src("dsh-experimental-agent-team-profile", "cordis.patch.yml");
  const fork = src("dsh-subagent-fork-in-process");
  const loop = src("dsh-agent-loop");
  const results = [];
  const add = (id, title, outcome, level = "FAIL") => results.push({ id, title, level: outcome.pass ? "PASS" : level, ...outcome });

  // K01：所有被检查的内核包都以同一版本发布（插件按 dsh 版本整体固定兼容范围）
  {
    const evidence = [];
    const missing = [];
    for (const name of PACKAGES) {
      const own = src(name, "package.json");
      const ownVersion = own === undefined ? undefined : JSON.parse(own.lines.join("\n")).version;
      if (ownVersion === version) evidence.push({ where: `${name}/package.json`, text: `"version": "${ownVersion}"` });
      else missing.push(`${name} 版本 ${ownVersion ?? "缺失"}，应为 ${version}`);
    }
    add("K01", "内核包与 dsh 同版本发布", { pass: missing.length === 0, evidence: evidence.slice(0, 2).concat(evidence.length > 2 ? [{ where: "…", text: `共 ${evidence.length} 个包版本一致` }] : []), missing });
  }

  // K02：peer 声明（信息项）
  {
    const declared = peerVersions(manifest);
    const pass = declared.includes(version);
    add("K02", `peerDependencies 是否已声明 ${version}`, {
      pass,
      evidence: [{ where: "package.json", text: `"${SCOPE}/dsh": "${manifest.peerDependencies?.[`${SCOPE}/dsh`] ?? ""}"` }],
      missing: pass ? [] : ["尚未声明：静态检查与实机验收都通过后，再加入 peerDependencies、package-lock.json 和 compatibility-manifest 测试"],
    }, "INFO");
  }

  add("K03", "subagents.start / startContinuable 仍是服务方法（插件包装点）", requireAll(subagent, [
    ["async start(name, request)", /^\s*async start\(\s*\w+\s*,\s*\w+\s*\)\s*\{/],
    ["async startContinuable(spec)", /^\s*async startContinuable\(\s*\w+\s*\)\s*\{/],
  ]));

  add("K04", "子 agent 路由合并：继承父路由（请求头优先）、换路由未写强度时清掉强度、写入 subagentDepth", requireAll(subagent, [
    ["function resolveChildAgentOptions(", /function resolveChildAgentOptions\(/],
    ["父路由取自最近一次请求头（插件的 leadRoute 按同样规则核实跟随）", /const requestConfig = parent\.session\.requestHeader\(\)\?\.config;/],
    ["resolveChildAgentOptions 用 parentAgentOptionsForDelegation(parent)", /const parentOptions = parentAgentOptionsForDelegation\(parent\);/],
    ["换路由且未请求强度时 delete reasoningEffort", /provider !== \w+ \|\| \w+\.model !== \w+\) && \w+\?\.reasoningEffort === void 0\) delete \w+\.reasoningEffort/],
    ["subagentDepth: childDepth", /subagentDepth: childDepth/],
    ["startContinuable 用 resolveChildAgentOptions(parent, request.agentOptions, …)", /resolveChildAgentOptions\(parent, request\.agentOptions,/],
  ]));

  add("K05", "委派深度 = max(header.delegationDepth, options.subagentDepth)", requireAll(subagent, [
    ["function delegationDepthOf(", /function delegationDepthOf\(/],
    ["Math.max(agent.session.header.delegationDepth ?? 0, runtime ?? 0)", /Math\.max\(agent\.session\.header\.delegationDepth \?\? 0, runtime \?\? 0\)/],
  ]));

  {
    const chain = requireAll(team, [
      ["spawnTeammate → this.roster.spawn(caller, request)", /return await this\.roster\.spawn\(caller, request\)/],
      ["spawn → this.spawnAdmitted(caller, request)", /const operation = this\.spawnAdmitted\(caller, request\)/],
      ["spawnAdmitted 只允许 lead（TEAM_LEAD_REQUIRED）", /membership\.role !== "lead"\) throw new TeamError\("only the Team Lead can create teammates", "TEAM_LEAD_REQUIRED"\)/],
    ]);
    const call = block(team, /await this\.ctx\.subagents\.startContinuable\(\{/);
    if (call === undefined) chain.missing.push("spawnAdmitted 里的 this.ctx.subagents.startContinuable({ … })");
    else {
      chain.evidence.push({ where: call.where, text: "await this.ctx.subagents.startContinuable({" });
      if (!/\bchildId\b/.test(call.text)) chain.missing.push("startContinuable 调用带 childId");
      if (!/parent: root\b/.test(call.text)) chain.missing.push("startContinuable 调用的 request.parent 为 Team root（队长）");
      if (/agentOptions/.test(call.text)) chain.missing.push("startContinuable 调用不应自带 agentOptions（出现了：需重新评估登记与显式路由的优先级）");
    }
    chain.pass = chain.missing.length === 0;
    add("K06", "建队员调用链：spawnTeammate → roster.spawn → spawnAdmitted → startContinuable（同一 await 链，ALS 可传递）", chain);
  }

  add("K07", "spawn_teammate 工具：名字、context 参数与 fresh/fork provider 选择", requireAll(teamTool, [
    ['name: "spawn_teammate"', /name: "spawn_teammate"/],
    ['context enum ["fresh", "fork"]', /enum: \["fresh", "fork"\]/],
    ['args.context ?? "fresh"', /const context = args\.context \?\? "fresh"/],
    ["provider: context === \"fork\" ? config.forkProvider : config.freshProvider", /provider: context === "fork" \? config\.forkProvider : config\.freshProvider/],
  ]));

  add("K08", "Agent Teams profile：freshProvider spawn，forkProvider fork", requireAll(profile, [
    ["freshProvider: spawn", /^\s*freshProvider: spawn\s*$/],
    ["forkProvider: fork", /^\s*forkProvider: fork\s*$/],
  ]));

  add("K09", "工具分发：tools/execute waterfall 包住工具本体；工具抛错转为错误结果、监听器抛错成为最终结果；exec 带 token", requireAll(tools, [
    ['waterfall(carrier, "tools/execute", mutableExec, …)', /waterfall\(carrier, "tools\/execute", mutableExec,/],
    ["工具本体抛错 → return toolErrorResult(error)（仍经过 post-execute）", /^\s*return toolErrorResult\(error\);/],
    ['kind: "final-result"', /kind: "final-result"/],
    ["createExecution 生成 token", /const token = createExecutionToken\(\)/],
  ]));

  add("K10", "tools/post-execute：accept 可替换 content，block 与 additionalContexts 语义不变", requireAll(tools, [
    ['waterfall(…, "tools/post-execute", exec, result, …)', /"tools\/post-execute", exec, result,/],
    ["accept 替换 content", /decision\.content !== void 0 \? \{ content: decision\.content \}/],
    ['block 分支 decision.kind === "block"', /if \(decision\.kind === "block"\)/],
    ["不能同时替换 value 与 content", /cannot replace both value and content/],
    ["additionalContexts 合并", /const additionalContexts = \[\.\.\.result\.additionalContexts \?\? \[\], \.\.\.decisionContexts\]/],
  ]));

  add("K11", "作用域过滤：不带作用域的插件监听器收到所有 agent 的事件", requireAll(scope, [
    ["function scopeTarget(", /function scopeTarget\(/],
    ["if (tag === void 0) return true;", /if \(tag === void 0\) return true;/],
  ]));

  add("K12", "agent 事件与注册表：agent/created 串行、agent/disposed、get(id)、list()", requireAll(agent, [
    ['serial(entry.carrier, "agent/created", …)', /await this\.ctx\.serial\(entry\.carrier, "agent\/created", \{/],
    ['"agent/disposed"', /"agent\/disposed",/],
    ["get(id)", /^\s*get\(id\) \{/],
    ["list()", /^\s*list\(\) \{/],
  ]));

  add("K13", "工具屏蔽：agent.ctx.tools.restrict({ deny }) 可屏蔽继承的全局工具", requireAll(tools, [
    ["restrict(filter)", /^\s*restrict\(filter\) \{/],
    ["restrictableNames", /restrictableNames\.add\(name\)/],
    ["未知工具名报错", /names unknown global tool/],
  ]));

  add("K14", "路由预检：llm.resolveCallConfig(config, signal)", requireAll(llm, [
    ["async resolveCallConfig(config, signal)", /async resolveCallConfig\(config, signal\)/],
  ]));

  {
    const view = block(team, /^\s*memberView\(member\) \{/);
    const outcome = { pass: false, evidence: [], missing: [] };
    if (view === undefined) outcome.missing.push("memberView(member)");
    else {
      outcome.evidence.push({ where: view.where, text: "memberView(member) {" });
      if (/live\?\.options\.model === void 0 \? \{\} : \{ model: live\.options\.model \}/.test(view.text)) outcome.evidence.push({ where: view.where, text: "…live?.options.model === void 0 ? {} : { model: live.options.model }" });
      else outcome.missing.push("memberView 的 model 取自 live.options.model");
    }
    outcome.pass = outcome.missing.length === 0;
    add("K15", "spawn_teammate 返回的 member.model 取自 live agent 的 options.model", outcome);
  }

  add("K16", "list_agents 对不在运行的队员显示队长的模型（references/spawn-route.md 的提示依赖这一点）", requireAll(team, [
    ["live?.options.model ?? root.options.model", /live\?\.options\.model \?\? root\.options\.model/],
  ]), "INFO");

  add("K17", "插件元数据：按 exports 读取 locale/*.json，图标支持 SVG", requireAll(boot, [
    ["`${specifier}/locale/${entry.name}`", /`\$\{specifier\}\/locale\/\$\{entry\.name\}`/],
    ['[".svg", "image/svg+xml"]', /\["\.svg", "image\/svg\+xml"\]/],
  ]));

  // K18：skill 把这些交给宿主。缺了任何一项，skill 的说明就不再成立。
  {
    const tools = skillHostTools(skillText);
    const outcome = requireAll(teamTool, [
      ...tools.map((tool) => [`skill 提到的宿主工具 ${tool}`, new RegExp(`name: "${tool}"`)]),
      ...POLICY_RULES.map(([label, pattern]) => [`team:policy 规则：${label}`, pattern]),
      ["interrupt_agent 保留未处理的消息", /Interrupt one teammate's current turn while preserving its pending inbox/],
    ]);
    if (tools.length === 0) {
      outcome.missing.push("没有读到 skill 提到的宿主工具（skill 文件缺失？）");
      outcome.pass = false;
    }
    if (!outcome.pass) outcome.missing.push("宿主改写或删掉了上面的工具或规则：确认 skill 是否要补回相应说明，再放宽 peer 范围");
    add("K18", "team-lead skill 依赖的宿主工具与 team:policy 规则仍在", { ...outcome, evidence: outcome.evidence.slice(0, 4).concat(outcome.evidence.length > 4 ? [{ where: "…", text: `共 ${outcome.evidence.length} 项` }] : []) });
  }

  // K19（信息项）：skill 引用的宿主限制与数值。变化不影响插件，但 skill 的说法需要跟着改。
  add("K19", "skill 引用的宿主限制：创建失败也占名额和名字、队长可释放或改派任务、wait_agent 超时 10 秒到 1 小时、fork 只继承已完成的轮次", {
    ...(() => {
      const members = requireAll(team, [
        ["名字永久占用（包括失败的成员）", /if \(state\.members\.some\(\(member\) => member\.name === name\)\) throw new TeamError/],
        ["名额按全部成员计数（包括失败的）", /if \(state\.members\.length >= this\.maxMembers\) throw new TeamError/],
        ["release/edit 允许 owner 或队长", /if \(!lead && !owner\) throw new TeamError\("task mutation requires its owner or Team Lead"/],
        ["reassign 只允许队长", /if \(!lead\) throw new TeamError\("only the Team Lead can reassign tasks"/],
      ]);
      const wait = requireAll(teamTool, [["wait_agent timeout_ms 范围 10000–3600000", /timeoutMs < 1e4 \|\| timeoutMs > 36e5/]]);
      const seed = requireAll(fork, [
        ["fork 种子截到最后一个 turn/end（进行中的轮次不在内）", /const lastEnd = events\.findLast\(\(e\) => e\.type === "turn\/end"\)/],
        ["fork 用 completedTurnPrefix(request.parent) 作种子", /const seed = completedTurnPrefix\(request\.parent\)/],
      ]);
      return {
        pass: members.pass && wait.pass && seed.pass,
        evidence: [...members.evidence, ...wait.evidence, ...seed.evidence],
        missing: [...members.missing, ...wait.missing, ...seed.missing],
      };
    })(),
  }, "INFO");

  // K20：skill 允许把「arm_spawn_route → spawn_teammate」写在同一步，依赖宿主把两者当独占调用、
  // 在同一步里按模型给出的顺序逐个执行（前一个结束后下一个才开始）。
  {
    const outcome = requireAll(loop, [
      ["同一步的调用：独占调用单独成组，按顺序 await", /const outcome = await runGroup\(ctx, turn, step, mode === "parallel" \? planned\.slice\(next\) : \[first\], mode, signal, acceptContext\)/],
    ]);
    const tools2 = requireAll(tools, [["没有 isConcurrencySafe 的工具按独占调用处理", /if \(!tool\?\.isConcurrencySafe\) return \{ kind: "exclusive" \};/]]);
    outcome.evidence.push(...tools2.evidence);
    outcome.missing.push(...tools2.missing);
    if (teamTool === undefined) outcome.missing.push("dsh-experimental-tool-agent-team/lib/index.js");
    else {
      const start = teamTool.lines.findIndex((text) => /name: "spawn_teammate"/.test(text));
      const end = teamTool.lines.findIndex((text, index) => index > start && /register\(scoped\.tools\.register\(/.test(text));
      const definition = start < 0 ? "" : teamTool.lines.slice(start, end < 0 ? undefined : end).join("\n");
      if (start < 0) outcome.missing.push('name: "spawn_teammate"');
      else if (/isConcurrencySafe/.test(definition)) outcome.missing.push("spawn_teammate 声明了 isConcurrencySafe：可能与其他调用并行，skill 不能再允许同一步写 arm → spawn");
      else outcome.evidence.push({ where: `${teamTool.label}:${start + 1}`, text: "spawn_teammate 未声明 isConcurrencySafe（独占调用）" });
    }
    outcome.pass = outcome.missing.length === 0;
    add("K20", "同一步里的 arm_spawn_route → spawn_teammate 按顺序逐个执行（两者都是独占调用）", outcome);
  }

  // K21：run_code 里的子调用拿不到结果文本，插件的说明改走 additionalContexts；
  // 依赖宿主把子调用的 additionalContexts 转交给 run_code 的结果，并给子调用标上 parent。
  add("K21", "run_code 子调用：带 parent，结果的 additionalContexts 转交给 run_code", requireAll(tools, [
    ["子调用带 parent: exec.token", /^\s*parent: exec\.token,$/],
    ["子调用的 additionalContexts → exec.deferContext", /for \(const context of result\.additionalContexts \?\? \[\]\) exec\.deferContext\(context\);/],
  ]));

  return results;
}

function print(results, version, cache) {
  console.log(`\nkernel-check ${SCOPE}/dsh ${version}（缓存：${cache}）\n`);
  for (const result of results) {
    console.log(`${result.level.padEnd(4)} ${result.id} ${result.title}`);
    for (const item of result.evidence) console.log(`       ${item.where}  ${item.text.length > 120 ? `${item.text.slice(0, 117)}...` : item.text}`);
    for (const item of result.missing) console.log(`       缺少：${item}`);
  }
  const count = (level) => results.filter((result) => result.level === level).length;
  console.log(`\n结果：${count("PASS")} PASS，${count("FAIL")} FAIL，${count("INFO")} INFO`);
  if (count("FAIL") > 0) console.log("有 FAIL：先对照证据位置阅读新版源码，确认插件的对应逻辑是否需要调整，不要直接放宽 peer 范围。");
  else console.log("静态耦合点都在。下一步按 scripts/live-checklist.md 做实机验收，通过后再更新 peerDependencies。");
}

function parseArgs(argv) {
  const options = { version: undefined, cache: undefined, registry: undefined, proxy: undefined, offline: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--offline") options.offline = true;
    else if (arg === "--cache" || arg === "--registry" || arg === "--proxy") {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`${arg} 需要一个值`);
      options[arg.slice(2)] = value;
      index += 1;
    } else if (arg.startsWith("--")) throw new Error(`未知参数 ${arg}`);
    else if (options.version === undefined) options.version = arg;
    else throw new Error(`多余的参数 ${arg}`);
  }
  if (options.version === undefined || !VERSION.test(options.version)) throw new Error("用法：node scripts/kernel-check.mjs <dsh 版本，如 0.1.7-rc.3> [--cache <目录>] [--registry <url>] [--proxy <url>] [--offline]");
  for (const key of ["registry", "proxy"]) {
    if (options[key] !== undefined && !SAFE_ARG.test(options[key])) throw new Error(`--${key} 的值不能包含空白或 shell 元字符`);
  }
  return options;
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const cache = resolve(options.cache ?? join(repo, "node_modules", ".cache", "kernel-check", options.version));
  const manifest = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
  try {
    mkdirSync(cache, { recursive: true });
    fetchPackages(options.version, cache, options);
  } catch (error) {
    console.error(`\n${error.message}`);
    process.exit(2);
  }
  const skillText = SKILL_FILES.map((file) => {
    const path = join(repo, file);
    return existsSync(path) ? readFileSync(path, "utf8") : "";
  }).join("\n");
  const results = runChecks(cache, options.version, manifest, skillText);
  print(results, options.version, relative(process.cwd(), cache) || ".");
  process.exit(results.some((result) => result.level === "FAIL") ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();

export { untar };
