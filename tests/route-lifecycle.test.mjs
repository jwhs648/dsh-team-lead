// 一次性路由生命周期基线：工具、登记、消费与插件默认路由。
// 运行：npm test（node --test，recursive 收集 *.test.mjs）
import test from "node:test";
import assert from "node:assert/strict";
import { ROUTE_TOOLS, createHarness, deferred, makeAgent, noteOf } from "./helpers/harness.mjs";

const OPEN = { inherit: true, requireArm: false };

test("注册三个路由工具，包装 start/startContinuable，并挂上宿主事件", () => {
  const h = createHarness();
  for (const name of ROUTE_TOOLS) assert.ok(h.registered.has(name), name);
  assert.ok(Object.hasOwn(h.runtime, "start"));
  assert.ok(Object.hasOwn(h.runtime, "startContinuable"));
  assert.notEqual(h.runtime.start, h.proto.start);
  assert.equal(h.listenerCount("tools/execute"), 1);
  assert.equal(h.listenerCount("tools/post-execute"), 1);
  assert.equal(h.listenerCount("agent/created"), 1);
  assert.equal(h.listenerCount("agent/disposed"), 2);
});

test("dispose 后移除实例包装、还原原型，并注销全部工具与事件监听", () => {
  const h = createHarness();
  h.disposeAll();
  assert.equal(Object.hasOwn(h.runtime, "start"), false);
  assert.equal(Object.hasOwn(h.runtime, "startContinuable"), false);
  assert.equal(h.runtime.start, h.proto.start);
  assert.equal(h.registered.size, 0);
  for (const name of ["tools/execute", "tools/post-execute", "agent/created", "agent/disposed"]) {
    assert.equal(h.listenerCount(name), 0, name);
  }
});

test("arm 返回 armed+route，get 暴露 pending、configured 与 requireArm", async () => {
  const h = createHarness();
  const agent = makeAgent();
  const armed = await h.arm({ provider: "prov", model: "mod", reasoningEffort: "high" }, agent);
  assert.deepEqual(armed, { armed: true, route: { provider: "prov", model: "mod", reasoningEffort: "high" } });
  const view = await h.get(agent);
  assert.equal(view.inherit, true);
  assert.equal(view.requireArm, true);
  assert.deepEqual(view.configured, { provider: "", model: "" });
  assert.deepEqual(view.pending, { provider: "prov", model: "mod", reasoningEffort: "high" });
});

test("arm 省略 reasoningEffort 时 route 不含该键", async () => {
  const h = createHarness();
  const armed = await h.arm({ provider: "prov", model: "mod" }, makeAgent());
  assert.deepEqual(armed.route, { provider: "prov", model: "mod" });
});

test("arm 拒绝空 provider 或 model，且不登记", async () => {
  const h = createHarness();
  const agent = makeAgent();
  await assert.rejects(h.arm({ provider: "p", model: "" }, agent), /non-empty provider and model/);
  await assert.rejects(h.arm({ provider: "", model: "m" }, agent), /non-empty provider and model/);
  await assert.rejects(h.arm({ provider: "  ", model: "  " }, agent), /non-empty provider and model/);
  await assert.rejects(h.arm({ follow: false }, agent), /non-empty provider and model/);
  assert.equal(await h.pending(agent), undefined);
});

test("arm follow:true 登记「跟随队长」，不做预检；不能与 provider/model/强度同传", async () => {
  let preflights = 0;
  const h = createHarness({ llm: { resolveCallConfig: async () => { preflights += 1; } } });
  const agent = makeAgent();
  assert.deepEqual(await h.arm({ follow: true }, agent), { armed: true, follow: true });
  assert.equal(preflights, 0);
  assert.deepEqual(await h.pending(agent), { follow: true });
  await assert.rejects(h.arm({ follow: true, provider: "p", model: "m" }, agent), /cannot be combined/);
  await assert.rejects(h.arm({ follow: true, reasoningEffort: "high" }, agent), /cannot be combined/);
  assert.deepEqual(await h.pending(agent), { follow: true }, "非法调用不改变已有登记");
});

test("arm 预检失败抛出 is unavailable 且不登记", async () => {
  const llm = { resolveCallConfig: async () => { throw new Error("unavailable-xyz"); } };
  const h = createHarness({ llm });
  const agent = makeAgent();
  await assert.rejects(h.arm({ provider: "bad", model: "b" }, agent), /member-model: spawn route bad\/b is unavailable: unavailable-xyz/);
  assert.equal(await h.pending(agent), undefined);
});

test("inherit=true 时 start 原样透传 request（同一对象、无 agentOptions）", async () => {
  const h = createHarness();
  const request = { parent: makeAgent(), agentOptions: { temperature: 0.2 } };
  await h.start("spawn", request);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].request, request);
  assert.deepEqual(h.calls[0].request.agentOptions, { temperature: 0.2 });
});

test("登记后建队员：应用路由并消费登记", async () => {
  const h = createHarness();
  const agent = makeAgent();
  await h.arm({ provider: "prov", model: "mod", reasoningEffort: "high" }, agent);
  const result = await h.spawnTeammate({ name: "reviewer" }, agent);
  assert.equal(result.isError, false);
  assert.deepEqual(h.lastTeammateOptions(), { provider: "prov", model: "mod", reasoningEffort: "high" });
  assert.equal(h.teammateCalls()[0].spec.request.parent, agent);
  assert.equal(await h.pending(agent), undefined);
});

test("登记覆盖请求里已有的路由键，保留其他键，不改写原 request", async () => {
  let original;
  const h = createHarness({
    teammateImpl: async (_args, exec, { runtime }) => {
      original = { parent: exec.agent, agentOptions: { temperature: 0.2, provider: "stale", model: "stale-m", reasoningEffort: "low" } };
      await runtime.startContinuable({ childId: "c1", provider: "spawn", request: original });
      return { member: { id: "c1" } };
    },
  });
  const agent = makeAgent();
  await h.arm({ provider: "prov", model: "mod", reasoningEffort: "high" }, agent);
  await h.spawnTeammate({}, agent);
  assert.deepEqual(h.lastTeammateOptions(), { temperature: 0.2, provider: "prov", model: "mod", reasoningEffort: "high" });
  assert.deepEqual(original.agentOptions, { temperature: 0.2, provider: "stale", model: "stale-m", reasoningEffort: "low" });
});

test("登记只被紧接着的一次建队员消费", async () => {
  const h = createHarness({ config: OPEN });
  const agent = makeAgent();
  await h.arm({ provider: "prov", model: "mod" }, agent);
  await h.spawnTeammate({}, agent);
  assert.equal(await h.pending(agent), undefined);
  await h.spawnTeammate({}, agent);
  assert.equal(h.lastTeammateOptions(), undefined);
});

test("核心：登记后普通 fresh 子代理（start / 非建队员的 startContinuable）不消费也不改写", async () => {
  const h = createHarness();
  const agent = makeAgent();
  await h.arm({ provider: "prov", model: "mod", reasoningEffort: "high" }, agent);
  const workflowChild = { parent: agent, agentOptions: { provider: "provider-a", model: "model-c" } };
  await h.start("spawn", workflowChild);
  assert.equal(h.calls.at(-1).request, workflowChild);
  const background = { parent: agent };
  await h.start("spawn", background);
  assert.equal(h.calls.at(-1).request, background);
  const continuable = { provider: "spawn", request: { parent: agent } };
  await h.startContinuable(continuable);
  assert.equal(h.calls.at(-1).spec, continuable);
  assert.deepEqual(await h.pending(agent), { provider: "prov", model: "mod", reasoningEffort: "high" });
  await h.spawnTeammate({}, agent);
  assert.deepEqual(h.lastTeammateOptions(), { provider: "prov", model: "mod", reasoningEffort: "high" });
});

test("登记优先于 inherit=false 的 activeDefault", async () => {
  const h = createHarness({ config: { inherit: false, provider: "dp", model: "dm", reasoningEffort: "low" } });
  const agent = makeAgent();
  await h.arm({ provider: "op", model: "om" }, agent);
  await h.spawnTeammate({}, agent);
  assert.deepEqual(h.lastTeammateOptions(), { provider: "op", model: "om" });
});

test("inherit=false 无登记时：建队员与请求未写明模型的 fresh 子代理使用 activeDefault", async () => {
  const h = createHarness({ config: { inherit: false, provider: "dp", model: "dm", reasoningEffort: "low" } });
  const agent = makeAgent();
  const result = await h.spawnTeammate({ name: "x" }, agent);
  assert.equal(result.isError, false, "有插件默认路由时 requireArm 不拦截");
  assert.deepEqual(h.lastTeammateOptions(), { provider: "dp", model: "dm", reasoningEffort: "low" });
  await h.start("spawn", { parent: agent, agentOptions: { temperature: 0.1 } });
  assert.deepEqual(h.calls.at(-1).request.agentOptions, { temperature: 0.1, provider: "dp", model: "dm", reasoningEffort: "low" });
  await h.startContinuable({ provider: "spawn", request: { parent: agent } });
  assert.deepEqual(h.calls.at(-1).spec.request.agentOptions, { provider: "dp", model: "dm", reasoningEffort: "low" });
});

test("请求写明 provider 或 model 时 activeDefault 原样放行（两入口）", async () => {
  const h = createHarness({ config: { inherit: false, provider: "dp", model: "dm" } });
  const agent = makeAgent();
  const byModel = { parent: agent, agentOptions: { model: "own-model" } };
  await h.start("spawn", byModel);
  assert.equal(h.calls.at(-1).request, byModel);
  const byProvider = { provider: "spawn", request: { parent: agent, agentOptions: { provider: "own", model: "own-m" } } };
  await h.startContinuable(byProvider);
  assert.equal(h.calls.at(-1).spec, byProvider);
});

test("fork 或其他 provider 不消费也不改写，也不受 requireArm 拦截", async () => {
  const h = createHarness();
  const agent = makeAgent();
  await h.arm({ provider: "fp", model: "fm" }, agent);
  const forkRequest = { parent: agent, agentOptions: { temperature: 0.1 } };
  await h.start("fork", forkRequest);
  assert.equal(h.calls[0].request, forkRequest);
  const otherRequest = { parent: agent };
  await h.start("some-other-provider", otherRequest);
  assert.equal(h.calls[1].request, otherRequest);
  const forked = await h.spawnTeammate({ context: "fork" }, agent);
  assert.equal(forked.isError, false);
  assert.equal(h.teammateCalls().at(-1).spec.provider, "fork");
  assert.equal(h.lastTeammateOptions(), undefined);
  assert.deepEqual(await h.pending(agent), { provider: "fp", model: "fm" });

  await h.clear(agent);
  const unarmedFork = await h.spawnTeammate({ context: "fork" }, agent);
  assert.equal(unarmedFork.isError, false, "未登记的 fork 也不被拦截");
});

test("建队员失败恢复未消费登记（重试友好）", async () => {
  const h = createHarness({ continuableImpl: () => { throw new Error("boom"); } });
  const agent = makeAgent();
  await h.arm({ provider: "p2", model: "m2" }, agent);
  const result = await h.spawnTeammate({}, agent);
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /boom/);
  assert.deepEqual(await h.pending(agent), { provider: "p2", model: "m2" });
});

test("消费即删：建队员进行中 get 已无 pending；失败后恢复", async () => {
  const d = deferred();
  const h = createHarness({ continuableImpl: () => d.promise });
  const agent = makeAgent();
  await h.arm({ provider: "p3", model: "m3" }, agent);
  const inflight = h.spawnTeammate({}, agent);
  while (h.teammateCalls().length === 0) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await h.pending(agent), undefined);
  d.reject(new Error("boom"));
  assert.equal((await inflight).isError, true);
  assert.deepEqual(await h.pending(agent), { provider: "p3", model: "m3" });
});

test("建队员失败不覆盖期间新登记的 pending", async () => {
  const d = deferred();
  const h = createHarness({ continuableImpl: () => d.promise });
  const agent = makeAgent();
  await h.arm({ provider: "old", model: "om" }, agent);
  const inflight = h.spawnTeammate({}, agent);
  while (h.teammateCalls().length === 0) await new Promise((resolve) => setImmediate(resolve));
  await h.arm({ provider: "new", model: "nm" }, agent);
  d.reject(new Error("boom"));
  const result = await inflight;
  assert.equal(result.isError, true);
  assert.match(noteOf(result), /cleared or replaced meanwhile/);
  assert.deepEqual(await h.pending(agent), { provider: "new", model: "nm" });
});

test("建队员时路由不可用：返回错误、rawStart 不被调用、登记恢复", async () => {
  let preflights = 0;
  const llm = { resolveCallConfig: async () => { preflights += 1; if (preflights > 1) throw new Error("route gone"); } };
  const h = createHarness({ llm });
  const agent = makeAgent();
  await h.arm({ provider: "p", model: "m" }, agent);
  const result = await h.spawnTeammate({}, agent);
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /member-model: spawn route p\/m is unavailable: route gone/);
  assert.equal(h.calls.length, 0);
  assert.deepEqual(await h.pending(agent), { provider: "p", model: "m" });
});

test("不同队长的 pending 互相隔离", async () => {
  const h = createHarness({ config: OPEN });
  const a = makeAgent("agent-a");
  const b = makeAgent("agent-b");
  await h.arm({ provider: "ap", model: "am" }, a);
  assert.deepEqual(await h.pending(a), { provider: "ap", model: "am" });
  assert.equal(await h.pending(b), undefined);
  await h.spawnTeammate({}, b);
  assert.equal(h.lastTeammateOptions(), undefined);
  assert.deepEqual(await h.pending(a), { provider: "ap", model: "am" });
});

test("agentKey 回退到 session.header.id", async () => {
  const h = createHarness();
  const agent = { session: { header: { id: "sess-1" } } };
  await h.arm({ provider: "sp", model: "sm" }, agent);
  assert.deepEqual(await h.pending(agent), { provider: "sp", model: "sm" });
  await h.spawnTeammate({}, agent);
  assert.deepEqual(h.lastTeammateOptions(), { provider: "sp", model: "sm" });
});

test("缺少调用 agent 时 arm/get/clear 抛错", async () => {
  const h = createHarness();
  await assert.rejects(h.call("arm_spawn_route", { provider: "p", model: "m" }, null), /requires a calling agent/);
  await assert.rejects(h.call("get_spawn_route", {}, null), /requires a calling agent/);
  await assert.rejects(h.call("clear_spawn_route", {}, null), /requires a calling agent/);
});

test("view 形状：configured 与 requireArm 恒在，inherit=false 才有 activeDefault", async () => {
  const inherit = createHarness({ config: { inherit: true, provider: "cp", model: "cm" } });
  const v1 = await inherit.get(makeAgent());
  assert.equal(v1.inherit, true);
  assert.equal(v1.requireArm, true);
  assert.deepEqual(v1.configured, { provider: "cp", model: "cm" });
  assert.equal("activeDefault" in v1, false);
  assert.equal("pending" in v1, false);
  assert.equal("lastApplied" in v1, false);
  assert.equal("applied" in v1, false);

  const fixed = createHarness({ config: { inherit: false, provider: "dp", model: "dm", reasoningEffort: "low", requireArm: false } });
  const v2 = await fixed.get(makeAgent());
  assert.equal(v2.inherit, false);
  assert.equal(v2.requireArm, false);
  assert.deepEqual(v2.configured, { provider: "dp", model: "dm", reasoningEffort: "low" });
  assert.deepEqual(v2.activeDefault, { provider: "dp", model: "dm", reasoningEffort: "low" });

  const empty = createHarness();
  const v3 = await empty.get(makeAgent());
  assert.equal("activeDefault" in v3, false);
  assert.deepEqual(v3.configured, { provider: "", model: "" });
});

test("volatile 配置：读取 get() 包装的实时值", async () => {
  let requireArm = true;
  const h = createHarness({ config: { inherit: true, requireArm: { get: () => requireArm } } });
  const agent = makeAgent();
  assert.equal((await h.spawnTeammate({}, agent)).isError, true);
  requireArm = false;
  assert.equal((await h.spawnTeammate({}, agent)).isError, false);
});
