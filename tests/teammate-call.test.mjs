// 建队员调用（spawn_teammate）专项：登记只交给这一次调用（A）、
// 未登记拦截与 follow（C2）、结果里的实际路由说明与 applied（B）。
import test from "node:test";
import assert from "node:assert/strict";
import {
  createHarness,
  deferred,
  makeAgent,
  noteOf,
  resolveChildOptions,
} from "./helpers/harness.mjs";
import { leadRoute } from "../lib/routes.js";

const LEAD_OPTIONS = { provider: "lp", model: "lm", reasoningEffort: "medium" };
const lead = (id = "lead") => makeAgent(id, { options: { ...LEAD_OPTIONS } });
const tick = () => new Promise((resolve) => setImmediate(resolve));

test("复现旧问题已消失：登记后后台 workflow 子代理带显式模型，不被改写也不偷走登记", async () => {
  const h = createHarness();
  const agent = lead();
  await h.arm({ provider: "provider-a", model: "model-a", reasoningEffort: "high" }, agent);
  const workflowChild = { parent: agent, agentOptions: { provider: "provider-a", model: "模型C" } };
  await h.start("spawn", workflowChild);
  assert.equal(h.calls.at(-1).request, workflowChild);
  assert.deepEqual(h.calls.at(-1).request.agentOptions, { provider: "provider-a", model: "模型C" });

  const result = await h.spawnTeammate({ name: "reviewer" }, agent);
  assert.equal(result.isError, false);
  assert.deepEqual(h.lastTeammateOptions(), { provider: "provider-a", model: "model-a", reasoningEffort: "high" });
  assert.equal(noteOf(result), 'member-model: "reviewer" → provider-a/model-a · high (armed route; verified on the live teammate).');
});

test("建队员进行中，并发的其他创建（同一队长的后台子代理）拿不到这次登记", async () => {
  const gate = deferred();
  const entered = deferred();
  let first = true;
  const h = createHarness({
    continuableImpl: async () => {
      if (first) {
        first = false;
        entered.resolve();
        await gate.promise;
      }
      return { ok: true };
    },
  });
  const agent = lead();
  await h.arm({ provider: "p", model: "m" }, agent);
  const inflight = h.spawnTeammate({ name: "a" }, agent);
  await entered.promise;
  // 另一条异步链：不在这次 spawn_teammate 调用内部。
  const other = { provider: "spawn", request: { parent: agent, agentOptions: { temperature: 1 } } };
  await h.startContinuable(other);
  assert.equal(h.calls.at(-1).spec, other, "调用外的 startContinuable 原样透传");
  await h.start("spawn", { parent: agent });
  assert.equal(h.calls.at(-1).request.agentOptions, undefined);
  gate.resolve();
  assert.equal((await inflight).isError, false);
  assert.deepEqual(h.teammateCalls()[0].spec.request.agentOptions, { provider: "p", model: "m" });
});

test("同一次调用内：只有第一次、且父 agent 是该队长的 fresh 创建拿到登记", async () => {
  const other = makeAgent("someone-else");
  const h = createHarness({
    teammateImpl: async (_args, exec, { runtime }) => {
      await runtime.startContinuable({ childId: "x1", provider: "spawn", request: { parent: other } });
      await runtime.startContinuable({ childId: "x2", provider: "spawn", request: { parent: exec.agent } });
      await runtime.startContinuable({ childId: "x3", provider: "spawn", request: { parent: exec.agent } });
      return { member: { id: "x2" } };
    },
  });
  const agent = lead();
  await h.arm({ provider: "p", model: "m", reasoningEffort: "high" }, agent);
  const result = await h.spawnTeammate({ name: "b" }, agent);
  const [x1, x2, x3] = h.teammateCalls();
  assert.equal(x1.spec.request.agentOptions, undefined, "父 agent 不匹配");
  assert.deepEqual(x2.spec.request.agentOptions, { provider: "p", model: "m", reasoningEffort: "high" });
  assert.equal(x3.spec.request.agentOptions, undefined, "一次调用只消费一次");
  assert.match(noteOf(result), /"b" → p\/m · high \(armed route; verified/);
});

test("requireArm（默认开）：顶层队长未登记的 fresh 建队员被拒绝，不创建任何成员", async () => {
  const h = createHarness();
  const agent = lead();
  const result = await h.spawnTeammate({ name: "c" }, agent);
  assert.equal(result.isError, true);
  assert.equal(result.error.info.code, "MEMBER_MODEL_ARM_REQUIRED");
  assert.match(result.content[0].text, /^Error: member-model: arm a route before creating a fresh teammate/);
  assert.match(result.content[0].text, /arm_spawn_route\(\{"follow":true\}\)/);
  assert.equal(result.content.length, 1, "拒绝时不再附加说明行");
  assert.equal(h.calls.length, 0);
});

test("requireArm 关闭时：未登记的 fresh 队员跟随队长，并在结果里说明", async () => {
  const h = createHarness({ config: { inherit: true, requireArm: false } });
  const agent = lead();
  const result = await h.spawnTeammate({ name: "d" }, agent);
  assert.equal(result.isError, false);
  assert.equal(h.lastTeammateOptions(), undefined);
  assert.equal(noteOf(result), 'member-model: "d" → lp/lm · medium (nothing armed, follows the lead; requireArm is off; verified on the live teammate).');
});

test("非顶层调用者（delegation depth > 0）不受 requireArm 拦截", async () => {
  const h = createHarness();
  const nested = makeAgent("nested-lead", { options: { ...LEAD_OPTIONS, subagentDepth: 1 } });
  const result = await h.spawnTeammate({ name: "e" }, nested);
  assert.equal(result.isError, false);
  assert.match(noteOf(result), /nothing armed, follows the lead; verified/);
});

test("arm follow：不传路由、绕过 activeDefault，结果核对与队长一致", async () => {
  const h = createHarness({ config: { inherit: false, provider: "dp", model: "dm", reasoningEffort: "low" } });
  const agent = lead();
  await h.arm({ follow: true }, agent);
  const result = await h.spawnTeammate({ name: "f" }, agent);
  assert.equal(result.isError, false);
  assert.equal(h.lastTeammateOptions(), undefined, "follow 不写 agentOptions，也不套插件默认路由");
  assert.equal(noteOf(result), 'member-model: "f" → lp/lm · medium (armed follow, same as the lead; verified on the live teammate).');
  assert.equal(await h.pending(agent), undefined, "follow 同样只用一次");
});

test("插件默认路由（inherit=false）：说明行注明来源", async () => {
  const h = createHarness({ config: { inherit: false, provider: "dp", model: "dm", reasoningEffort: "low" } });
  const result = await h.spawnTeammate({ name: "g" }, lead());
  assert.equal(noteOf(result), 'member-model: "g" → dp/dm · low (plugin default route; verified on the live teammate).');
});

test("说明行附在原结果之后，原 JSON 内容不变", async () => {
  const h = createHarness();
  const agent = lead();
  await h.arm({ provider: "p", model: "m" }, agent);
  const result = await h.spawnTeammate({ name: "h1" }, agent);
  assert.equal(result.content.length, 2);
  const member = JSON.parse(result.content[0].text).member;
  assert.equal(member.name, "h1");
  assert.equal(member.model, "m");
  assert.match(result.content[1].text, /^member-model: "h1" → p\/m · effort unset \(armed route; verified/);
});

test("登记不写强度：只核对 provider 与 model；换路由时宿主清掉继承的强度", async () => {
  const h = createHarness();
  const agent = lead();
  await h.arm({ provider: "p", model: "m" }, agent);
  const result = await h.spawnTeammate({ name: "i" }, agent);
  assert.match(noteOf(result), /"i" → p\/m · effort unset \(armed route; verified/);
  const same = lead("lead-2");
  await h.arm({ provider: "lp", model: "lm" }, same);
  const inherited = await h.spawnTeammate({ name: "j" }, same);
  assert.match(noteOf(inherited), /"j" → lp\/lm · medium \(armed route; verified/, "同路由时强度继承自队长");
});

test("实际路由与登记不符时给出 WARNING", async () => {
  const h = createHarness({ childOptions: () => ({ provider: "lp", model: "lm", reasoningEffort: "medium" }) });
  const agent = lead();
  await h.arm({ provider: "p", model: "m", reasoningEffort: "high" }, agent);
  const result = await h.spawnTeammate({ name: "k" }, agent);
  assert.equal(result.isError, false);
  assert.equal(noteOf(result), 'member-model: WARNING "k" should run p/m · high (armed route) but the live teammate reports lp/lm · medium. Stop and tell the user.');
  const view = await h.get(agent);
  assert.deepEqual(view.applied.at(-1), { teammate: "k", source: "armed", route: { provider: "lp", model: "lm", reasoningEffort: "medium" }, verified: false });
  assert.ok(h.warnings.some((message) => message.includes("WARNING")));
});

test("follow 却与队长不一致时给出 WARNING", async () => {
  const h = createHarness({ childOptions: () => ({ provider: "x", model: "y" }) });
  const agent = lead();
  await h.arm({ follow: true }, agent);
  const result = await h.spawnTeammate({ name: "l" }, agent);
  assert.equal(noteOf(result), 'member-model: WARNING "l" should run the lead\'s route lp/lm · medium (armed follow, same as the lead) but the live teammate reports x/y · effort unset. Stop and tell the user.');
});

test("找不到 live 队员时注明未核实", async () => {
  const h = createHarness({ registerChildren: false });
  const agent = lead();
  await h.arm({ provider: "p", model: "m", reasoningEffort: "high" }, agent);
  const result = await h.spawnTeammate({ name: "m1" }, agent);
  assert.equal(noteOf(result), 'member-model: "m1" → p/m · high (armed route; live teammate not found, unverified).');
  const view = await h.get(agent);
  assert.deepEqual(view.applied.at(-1), { teammate: "m1", source: "armed", route: { provider: "p", model: "m", reasoningEffort: "high" }, verified: false });
});

test("调用成功但没有看到该队长的 fresh 创建：登记未被应用，给出 WARNING", async () => {
  const h = createHarness({
    teammateImpl: async (_args, exec, { runtime }) => {
      await runtime.startContinuable({ childId: "r1", provider: "remote-spawn", request: { parent: exec.agent } });
      return { member: { id: "r1" } };
    },
  });
  const agent = lead();
  await h.arm({ provider: "p", model: "m" }, agent);
  const result = await h.spawnTeammate({ name: "n" }, agent);
  assert.match(noteOf(result), /^member-model: WARNING "n" was created without the armed p\/m: no fresh spawn for this lead was seen inside the call/);
  assert.equal((await h.get(agent)).applied.at(-1).source, "not-applied");
  assert.equal(await h.pending(agent), undefined, "登记已随这次调用用掉，需要重新登记");
});

test("get_spawn_route 的 applied 最后一条是最近一次建队员的实际路由", async () => {
  const h = createHarness();
  const agent = lead();
  await h.arm({ provider: "p", model: "m", reasoningEffort: "high" }, agent);
  await h.spawnTeammate({ name: "o" }, agent);
  assert.deepEqual((await h.get(agent)).applied.at(-1), { teammate: "o", source: "armed", route: { provider: "p", model: "m", reasoningEffort: "high" }, verified: true });
  await h.arm({ follow: true }, agent);
  await h.spawnTeammate({ name: "p" }, agent);
  assert.deepEqual((await h.get(agent)).applied.at(-1), { teammate: "p", source: "follow", route: { ...LEAD_OPTIONS }, verified: true });
  assert.equal((await h.get(lead("other"))).applied, undefined, "按队长隔离");
});

test("fork 时仍有登记：说明登记还在，等下一位 fresh 队员", async () => {
  const h = createHarness();
  const agent = lead();
  await h.arm({ provider: "p", model: "m" }, agent);
  const result = await h.spawnTeammate({ name: "q", context: "fork" }, agent);
  assert.equal(result.isError, false);
  assert.equal(noteOf(result), "member-model: fork follows the lead; the p/m stays armed for the next fresh teammate (clear_spawn_route drops it).");
  const bare = await createHarness().spawnTeammate({ name: "r", context: "fork" }, lead());
  assert.equal(noteOf(bare), undefined, "没有登记时 fork 不附加说明");
});

test("teammateTool 可配置：只拦截配置的工具名", async () => {
  const h = createHarness({ config: { inherit: true, teammateTool: "create_member" }, teammateTool: "create_member" });
  const agent = lead();
  const refused = await h.spawnTeammate({ name: "s" }, agent);
  assert.equal(refused.error?.info?.code, "MEMBER_MODEL_ARM_REQUIRED");
  await h.arm({ provider: "p", model: "m" }, agent);
  const ok = await h.spawnTeammate({ name: "t" }, agent);
  assert.match(noteOf(ok), /"t" → p\/m/);
  const other = await h.dispatch("spawn_teammate", { name: "u" }, agent);
  assert.match(other.content[0].text, /UNKNOWN_TOOL/, "旧工具名不再被当作建队员");
});

test("其他工具调用不受影响：不消费、不附加说明", async () => {
  const h = createHarness();
  const agent = lead();
  await h.arm({ provider: "p", model: "m" }, agent);
  const viewed = await h.dispatch("get_spawn_route", {}, agent);
  assert.equal(viewed.isError, false);
  assert.equal(noteOf(viewed), undefined);
  assert.deepEqual(JSON.parse(viewed.content[0].text).pending, { provider: "p", model: "m" });
});

test("tools/post-execute 下游替换 content：说明行接在替换后的内容之后", async () => {
  const h = createHarness();
  h.ctx.on("tools/post-execute", async () => ({ kind: "accept", content: [{ type: "text", text: "redacted" }] }));
  const agent = lead();
  await h.arm({ provider: "p", model: "m" }, agent);
  const result = await h.spawnTeammate({ name: "v" }, agent);
  assert.equal(result.content[0].text, "redacted");
  assert.match(result.content[1].text, /^member-model: "v" → p\/m/);
});

test("tools/post-execute 下游 block 或替换 value：说明行改用附加上下文", async () => {
  for (const decision of [
    { kind: "block", feedback: [{ type: "text", text: "blocked by hook" }] },
    { kind: "accept", value: { member: { id: "z" } } },
  ]) {
    const h = createHarness();
    h.ctx.on("tools/post-execute", async () => decision);
    const agent = lead();
    await h.arm({ provider: "p", model: "m" }, agent);
    const result = await h.spawnTeammate({ name: "w" }, agent);
    assert.equal(noteOf(result), undefined);
    const [context] = result.additionalContexts;
    assert.equal(context.role, "user");
    assert.equal(context.source.kind, "member-model");
    assert.equal(context.source.form, "notice");
    assert.match(context.content[0].text, /^member-model: "w" → p\/m/);
    assert.ok(context.source.summary.length <= 120);
    assert.equal(typeof context.id, "string");
  }
});

test("卸载发生在建队员途中：不恢复登记、不附加说明", async () => {
  const gate = deferred();
  const h = createHarness({ continuableImpl: () => gate.promise.then(() => { throw new Error("boom"); }) });
  const agent = lead();
  await h.arm({ provider: "p", model: "m" }, agent);
  const inflight = h.spawnTeammate({ name: "y" }, agent);
  while (h.teammateCalls().length === 0) await tick();
  h.disposeAll();
  gate.resolve();
  const result = await inflight;
  assert.equal(result.isError, true);
  assert.equal(noteOf(result), undefined);
});

test("applied 按顺序记下本队长最近的队员（最多 16 条），不再单独返回 lastApplied", async () => {
  const h = createHarness();
  const agent = lead();
  for (let index = 1; index <= 18; index += 1) {
    await h.arm({ provider: "p", model: `m${index}` }, agent);
    await h.spawnTeammate({ name: `t${index}` }, agent);
  }
  const view = await h.get(agent);
  assert.equal(view.applied.length, 16);
  assert.deepEqual(view.applied.map((entry) => entry.teammate), Array.from({ length: 16 }, (_, index) => `t${index + 3}`));
  assert.equal("lastApplied" in view, false);
  assert.deepEqual(view.applied[0], { teammate: "t3", source: "armed", route: { provider: "p", model: "m3" }, verified: true });
  assert.equal((await h.get(lead("other"))).applied, undefined, "按队长隔离");
});

// 宿主把没有 isConcurrencySafe 的工具当独占调用：同一步里的多个调用按模型给出的顺序逐个执行，
// 前一个（含 post-execute）结束后下一个才开始。下面按这个顺序依次 await 来模拟一步里的调用。
test("路由工具都是独占调用：没有 isConcurrencySafe", () => {
  const h = createHarness();
  for (const name of ["arm_spawn_route", "get_spawn_route", "clear_spawn_route"]) {
    assert.equal(h.registered.get(name).isConcurrencySafe, undefined, name);
  }
});

test("同一步里 arm→spawn、arm→spawn：各队员拿到各自登记的路由", async () => {
  const h = createHarness();
  const agent = lead();
  await h.arm({ provider: "p1", model: "m1", reasoningEffort: "high" }, agent);
  const first = await h.spawnTeammate({ name: "one" }, agent);
  await h.arm({ provider: "p2", model: "m2", reasoningEffort: "low" }, agent);
  const second = await h.spawnTeammate({ name: "two" }, agent);
  assert.deepEqual(h.teammateCalls().map((entry) => entry.spec.request.agentOptions), [
    { provider: "p1", model: "m1", reasoningEffort: "high" },
    { provider: "p2", model: "m2", reasoningEffort: "low" },
  ]);
  assert.match(noteOf(first), /^member-model: "one" → p1\/m1 · high \(armed route; verified/);
  assert.match(noteOf(second), /^member-model: "two" → p2\/m2 · low \(armed route; verified/);
});

test("错误顺序：先连续登记再连续创建时，后一次登记顶掉前一次，第二位被 requireArm 拒绝", async () => {
  const h = createHarness();
  const agent = lead();
  await h.arm({ provider: "p1", model: "m1" }, agent);
  await h.arm({ provider: "p2", model: "m2" }, agent);
  const first = await h.spawnTeammate({ name: "one" }, agent);
  const second = await h.spawnTeammate({ name: "two" }, agent);
  assert.match(noteOf(first), /^member-model: "one" → p2\/m2/, "第一位拿到的是第二次登记的路由");
  assert.equal(second.isError, true);
  assert.equal(second.error.info.code, "MEMBER_MODEL_ARM_REQUIRED");
  assert.equal(h.teammateCalls().length, 1, "第二位没有被创建");
});

test("同一步里登记失败（路由不可用）后，紧随的创建被拒绝，不会创建队员", async () => {
  const h = createHarness({ llm: { resolveCallConfig: async () => { throw new Error("unknown model"); } } });
  const agent = lead();
  await assert.rejects(h.arm({ provider: "p", model: "missing" }, agent), /spawn route p\/missing is unavailable: unknown model/);
  const result = await h.spawnTeammate({ name: "one" }, agent);
  assert.equal(result.isError, true);
  assert.equal(result.error.info.code, "MEMBER_MODEL_ARM_REQUIRED");
  assert.equal(h.teammateCalls().length, 0);
});

// 工具说明每一步都在、不会被压缩：调用时必须遵守的约定要在这里有一句。
test("工具说明写明调用约定：每次 fresh 创建前登记、成对写、fork 不用登记、汇报用 applied", () => {
  const h = createHarness();
  const arm = h.registered.get("arm_spawn_route");
  assert.match(arm.description, /Call it right before each fresh spawn_teammate/);
  assert.match(arm.description, /arm→spawn pairs may share one step, but never arm twice before a spawn/);
  assert.match(arm.description, /Fork needs no arm/);
  assert.match(arm.parameters.properties.reasoningEffort.description, /keeps the lead's effort only when provider and model match the lead's, otherwise leaves it unset/);
  assert.match(h.registered.get("get_spawn_route").description, /Use applied for the final report/);
});

test("拒绝信息提示在看不到默认路由时重新加载 skill", async () => {
  const h = createHarness();
  const result = await h.spawnTeammate({ name: "x" }, lead());
  assert.match(result.error.message, /reload the team-lead skill if you no longer see it/);
});

// 插件插在每次 spawn_teammate 中间：它自己出错时，不能把已经建好的队员报成失败。
test("生成结果行出错：调用仍然成功，附 WARNING 说明路由未核实", async () => {
  const h = createHarness();
  const agent = lead();
  await h.arm({ provider: "p", model: "m", reasoningEffort: "high" }, agent);
  h.ctx.get("agents").get = () => { throw new Error("registry unavailable"); };
  const result = await h.spawnTeammate({ name: "safe" }, agent);
  assert.equal(result.isError, false);
  assert.equal(noteOf(result), 'member-model: WARNING "safe" was created, but its route could not be checked: registry unavailable. Stop and tell the user.');
  assert.equal(h.teammateCalls().length, 1);
  const last = (await h.get(agent)).applied.at(-1);
  assert.deepEqual(last, { teammate: "safe", source: "armed", route: { provider: "p", model: "m", reasoningEffort: "high" }, verified: false });
  assert.ok(h.warnings.some((line) => line.includes("could not be checked")));
});

test("post-execute 追加说明时出错：原样返回下游结果，不抛错", async () => {
  const h = createHarness();
  h.ctx.on("tools/post-execute", async () => ({ kind: "accept", content: 42 }));
  const agent = lead();
  await h.arm({ provider: "p", model: "m" }, agent);
  const result = await h.spawnTeammate({ name: "odd" }, agent);
  assert.equal(result.isError, false);
  assert.equal(result.content, 42);
  assert.ok(h.warnings.some((line) => line.includes("could not attach the route note")));
});

test("下游 post-execute 自己抛错：照常传出，不被插件吞掉", async () => {
  const h = createHarness();
  h.ctx.on("tools/post-execute", async () => { throw new Error("hook crashed"); });
  const agent = lead();
  await h.arm({ provider: "p", model: "m" }, agent);
  await assert.rejects(h.spawnTeammate({ name: "boom" }, agent), /hook crashed/);
});

test("说明行改走附加上下文时，摘要截到 120 字以内并以省略号结尾，正文保持完整", async () => {
  const h = createHarness();
  h.ctx.on("tools/post-execute", async () => ({ kind: "accept", value: { member: { id: "z" } } }));
  const agent = lead();
  const name = `very-long-teammate-name-${"x".repeat(100)}`;
  await h.arm({ provider: "p", model: "m" }, agent);
  const result = await h.spawnTeammate({ name }, agent);
  const [context] = result.additionalContexts;
  const text = context.content[0].text;
  assert.ok(text.length > 120);
  assert.ok(text.includes(name));
  assert.equal(context.source.summary.length, 120);
  assert.ok(context.source.summary.endsWith("…"));
  assert.equal(context.source.summary.slice(0, 119), text.slice(0, 119));
});

// 宿主现在的建队员调用不带 agentOptions（kernel-check K06 盯着）；一旦带了，行为如下。
test("建队员调用自带路由：有登记时登记优先；没有登记且关闭 requireArm 时按请求路由报告并核实", async () => {
  const withRequestRoute = async (args, exec, { runtime, live }) => {
    const childId = `own-${args.name}`;
    await runtime.startContinuable({
      childId,
      provider: "spawn",
      label: "d",
      request: { prompt: [], parent: exec.agent, agentOptions: { provider: "xp", model: "xm" } },
      signal: exec.signal,
    });
    return { member: { id: childId, name: args.name, model: live.get(childId)?.options?.model } };
  };
  const armed = createHarness({ teammateImpl: withRequestRoute });
  const agent = lead();
  await armed.arm({ provider: "p", model: "m", reasoningEffort: "high" }, agent);
  const first = await armed.spawnTeammate({ name: "a" }, agent);
  assert.deepEqual(armed.lastTeammateOptions(), { provider: "p", model: "m", reasoningEffort: "high" });
  assert.match(noteOf(first), /^member-model: "a" → p\/m · high \(armed route; verified/);

  const open = createHarness({ teammateImpl: withRequestRoute, config: { inherit: true, requireArm: false } });
  const second = await open.spawnTeammate({ name: "b" }, agent);
  assert.deepEqual(open.lastTeammateOptions(), { provider: "xp", model: "xm" });
  assert.match(noteOf(second), /^member-model: "b" → xp\/xm · effort unset \(the request's own route; verified on the live teammate\)\.$/);
  assert.equal((await open.get(agent)).applied.at(-1).source, "explicit");
});

// —— 实机验收发现的两个问题（2026-09-25） ——

// 宿主给子 agent 继承的是队长「最近一次请求头」里的路由（界面切换的模型会体现在这里），
// 创建参数只在第一次请求之前才作数。夹具按同样的规则生成子 agent 的 options。
const hostChildOptions = (parentOptions, requested, parent) => {
  const config = parent?.session?.requestHeader?.()?.config;
  const inherited = config === undefined
    ? parentOptions
    : { provider: config.provider, model: config.model, ...(config.reasoningEffort === undefined ? {} : { reasoningEffort: config.reasoningEffort }) };
  return resolveChildOptions(inherited, requested);
};
const switchedLead = (id = "lead") => makeAgent(id, {
  options: { provider: "provider-a", model: "model-a" },
  session: { header: { id }, requestHeader: () => ({ config: { provider: "provider-b", model: "model-b", reasoningEffort: "medium", maxTokens: 128000 } }) },
});

test("队长在界面切换过模型：follow 按队长当前路由核实，不再误报", async () => {
  const h = createHarness({ childOptions: hostChildOptions });
  const agent = switchedLead();
  await h.arm({ follow: true }, agent);
  const result = await h.spawnTeammate({ name: "follower" }, agent);
  assert.equal(noteOf(result), 'member-model: "follower" → provider-b/model-b · medium (armed follow, same as the lead; verified on the live teammate).');
  assert.deepEqual((await h.get(agent)).applied.at(-1), { teammate: "follower", source: "follow", route: { provider: "provider-b", model: "model-b", reasoningEffort: "medium" }, verified: true });
});

test("队长在界面切换过模型：关闭 requireArm 后未登记跟随，同样按当前路由核实", async () => {
  const h = createHarness({ childOptions: hostChildOptions, config: { inherit: true, requireArm: false } });
  const agent = switchedLead();
  const result = await h.spawnTeammate({ name: "plain" }, agent);
  assert.equal(noteOf(result), 'member-model: "plain" → provider-b/model-b · medium (nothing armed, follows the lead; requireArm is off; verified on the live teammate).');
});

test("队长路由：请求头优先；还没发过请求或读取出错时退回创建参数", () => {
  assert.deepEqual(leadRoute(switchedLead()), { provider: "provider-b", model: "model-b", reasoningEffort: "medium" });
  assert.deepEqual(leadRoute(makeAgent("a", { options: { provider: "p", model: "m", reasoningEffort: "low" }, session: { requestHeader: () => undefined } })), { provider: "p", model: "m", reasoningEffort: "low" });
  assert.deepEqual(leadRoute(makeAgent("b", { options: { provider: "p", model: "m" }, session: { requestHeader: () => { throw new Error("closed"); } } })), { provider: "p", model: "m" });
  assert.deepEqual(leadRoute(makeAgent("c", { options: { provider: "p", model: "m", reasoningEffort: "high" }, session: { requestHeader: () => ({ config: { provider: "q", model: "n" } }) } })), { provider: "q", model: "n" }, "请求头没写强度时不沿用创建参数里的强度");
});

// run_code（PTC）里调用工具时，程序拿到的是结构化值，看不到结果文本；
// 宿主会把子调用的 additionalContexts 转交给 run_code 的结果，所以说明改走这条路。
const RUN_CODE = { parent: Symbol("run_code") };

test("run_code 里建队员：说明不写进结果文本，改作附加上下文送达队长", async () => {
  const h = createHarness();
  const agent = lead();
  await h.arm({ provider: "p", model: "m", reasoningEffort: "high" }, agent);
  const result = await h.spawnTeammate({ name: "ptc" }, agent, RUN_CODE);
  assert.equal(result.isError, false);
  assert.equal(noteOf(result), undefined, "结果文本里没有说明");
  const [context] = result.additionalContexts;
  assert.equal(context.role, "user");
  assert.equal(context.source.kind, "member-model");
  assert.equal(context.content[0].text, 'member-model: "ptc" → p/m · high (armed route; verified on the live teammate).');
});

test("run_code 里 WARNING、创建失败和 fork 的说明也走附加上下文", async () => {
  const followH = createHarness();
  const agent = switchedLead();
  await followH.arm({ provider: "p", model: "m" }, agent);
  const mismatch = createHarness({ childOptions: () => ({ provider: "x", model: "y" }) });
  await mismatch.arm({ provider: "p", model: "m" }, agent);
  const warned = await mismatch.spawnTeammate({ name: "w" }, agent, RUN_CODE);
  assert.match(warned.additionalContexts[0].content[0].text, /^member-model: WARNING "w" should run p\/m/);

  const failing = createHarness({ continuableImpl: async () => { throw new Error("provider down"); } });
  await failing.arm({ provider: "p", model: "m" }, agent);
  const failed = await failing.spawnTeammate({ name: "f" }, agent, RUN_CODE);
  assert.equal(failed.isError, true);
  assert.match(failed.additionalContexts[0].content[0].text, /stays armed for a retry/);

  const fork = await followH.spawnTeammate({ name: "k", context: "fork" }, agent, RUN_CODE);
  assert.match(fork.additionalContexts[0].content[0].text, /^member-model: fork follows the lead; the p\/m stays armed/);
  assert.equal(noteOf(fork), undefined);
});
