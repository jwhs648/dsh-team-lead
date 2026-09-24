// 一次性路由生命周期基线：不依赖 clear_spawn_route 的既有行为断言。
// 运行：npm test（node --test，recursive 收集 *.test.mjs）
import test from "node:test";
import assert from "node:assert/strict";
import { createHarness, deferred, failingStart, makeAgent } from "./helpers/harness.mjs";

test("注册 arm/get 两个工具，并把 start/startContinuable 包装到实例上", () => {
  const h = createHarness();
  assert.ok(h.registered.has("arm_spawn_route"));
  assert.ok(h.registered.has("get_spawn_route"));
  assert.ok(Object.hasOwn(h.runtime, "start"));
  assert.ok(Object.hasOwn(h.runtime, "startContinuable"));
  assert.notEqual(h.runtime.start, h.proto.start);
});

test("dispose 后移除实例包装、还原原型，并注销全部已注册工具", () => {
  const h = createHarness();
  h.disposeAll();
  assert.equal(Object.hasOwn(h.runtime, "start"), false);
  assert.equal(Object.hasOwn(h.runtime, "startContinuable"), false);
  assert.equal(h.runtime.start, h.proto.start);
  assert.equal(h.registered.size, 0);
});

test("arm 返回 armed+route，get 暴露 pending 与 configured", async () => {
  const h = createHarness();
  const agent = makeAgent();
  const armed = await h.arm({ provider: "prov", model: "mod", reasoningEffort: "high" }, agent);
  assert.deepEqual(armed, { armed: true, route: { provider: "prov", model: "mod", reasoningEffort: "high" } });
  const view = await h.get(agent);
  assert.equal(view.inherit, true);
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
  assert.equal(await h.pending(agent), undefined);
});

test("arm 预检失败抛出 is unavailable 且不登记", async () => {
  const llm = { resolveCallConfig: async () => { throw new Error("unavailable-xyz"); } };
  const h = createHarness({ llm });
  const agent = makeAgent();
  await assert.rejects(h.arm({ provider: "bad", model: "b" }, agent), /member-model: spawn route bad\/b is unavailable: unavailable-xyz/);
  assert.equal(await h.pending(agent), undefined);
});

test("inherit=true 且未登记时原样透传 request（同一对象、无 agentOptions）", async () => {
  const h = createHarness();
  const request = { parent: makeAgent(), agentOptions: { temperature: 0.2 } };
  await h.start("spawn", request);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].request, request);
  assert.deepEqual(h.calls[0].request.agentOptions, { temperature: 0.2 });
});

test("登记后 spawn 合并 agentOptions 并保留其他键，且不改写原 request", async () => {
  const h = createHarness();
  const agent = makeAgent();
  await h.arm({ provider: "prov", model: "mod", reasoningEffort: "high" }, agent);
  const request = { parent: agent, agentOptions: { temperature: 0.2, provider: "stale", model: "stale-m", reasoningEffort: "low" } };
  await h.start("spawn", request);
  assert.deepEqual(h.calls[0].request.agentOptions, { temperature: 0.2, provider: "prov", model: "mod", reasoningEffort: "high" });
  assert.deepEqual(request.agentOptions, { temperature: 0.2, provider: "stale", model: "stale-m", reasoningEffort: "low" });
});

test("登记只消费一次", async () => {
  const h = createHarness();
  const agent = makeAgent();
  await h.arm({ provider: "prov", model: "mod" }, agent);
  await h.start("spawn", { parent: agent });
  assert.equal(await h.pending(agent), undefined);
  await h.start("spawn", { parent: agent });
  assert.equal(h.calls[1].request.agentOptions, undefined);
});

test("登记优先于 inherit=false 的 activeDefault", async () => {
  const h = createHarness({ config: { inherit: false, provider: "dp", model: "dm", reasoningEffort: "low" } });
  const agent = makeAgent();
  await h.arm({ provider: "op", model: "om" }, agent);
  await h.start("spawn", { parent: agent });
  assert.deepEqual(h.calls[0].request.agentOptions, { provider: "op", model: "om" });
});

test("inherit=false 无登记时使用 activeDefault", async () => {
  const h = createHarness({ config: { inherit: false, provider: "dp", model: "dm", reasoningEffort: "low" } });
  await h.start("spawn", { parent: makeAgent() });
  assert.deepEqual(h.calls[0].request.agentOptions, { provider: "dp", model: "dm", reasoningEffort: "low" });
});

test("fork 或其他 provider 不消费也不改写", async () => {
  const h = createHarness();
  const agent = makeAgent();
  await h.arm({ provider: "fp", model: "fm" }, agent);
  const forkRequest = { parent: agent, agentOptions: { temperature: 0.1 } };
  await h.start("fork", forkRequest);
  assert.equal(h.calls[0].request, forkRequest);
  const otherRequest = { parent: agent };
  await h.start("some-other-provider", otherRequest);
  assert.equal(h.calls[1].request, otherRequest);
  assert.deepEqual(await h.pending(agent), { provider: "fp", model: "fm" });
});

test("startContinuable 只在 provider=spawn 时消费并改写 spec.request", async () => {
  const h = createHarness();
  const agent = makeAgent();
  await h.arm({ provider: "cp", model: "cm" }, agent);
  const spec = { provider: "spawn", request: { parent: agent, agentOptions: { temperature: 0.3 } } };
  await h.startContinuable(spec);
  assert.deepEqual(h.calls[0].spec.request.agentOptions, { temperature: 0.3, provider: "cp", model: "cm" });
  assert.deepEqual(spec.request.agentOptions, { temperature: 0.3 });
  assert.equal(await h.pending(agent), undefined);
  await h.arm({ provider: "dp", model: "dm" }, agent);
  const other = { provider: "fork", request: { parent: agent } };
  await h.startContinuable(other);
  assert.equal(h.calls[1].spec, other);
  assert.deepEqual(await h.pending(agent), { provider: "dp", model: "dm" });
});

test("spawn 失败恢复未消费登记（重试友好）", async () => {
  const h = createHarness({ startImpl: failingStart("boom") });
  const agent = makeAgent();
  await h.arm({ provider: "p2", model: "m2" }, agent);
  await assert.rejects(h.start("spawn", { parent: agent }), /boom/);
  assert.deepEqual(await h.pending(agent), { provider: "p2", model: "m2" });
});

test("消费即删：spawn 进行中 get 已无 pending；失败后恢复", async () => {
  const d = deferred();
  const h = createHarness({ startImpl: () => d.promise });
  const agent = makeAgent();
  await h.arm({ provider: "p3", model: "m3" }, agent);
  const inflight = h.spawn({}, agent);
  assert.equal(await h.pending(agent), undefined);
  d.reject(new Error("boom"));
  await assert.rejects(inflight, /boom/);
  assert.deepEqual(await h.pending(agent), { provider: "p3", model: "m3" });
});

test("spawn 失败不覆盖期间新登记的 pending", async () => {
  const d = deferred();
  const h = createHarness({ startImpl: () => d.promise });
  const agent = makeAgent();
  await h.arm({ provider: "old", model: "om" }, agent);
  const inflight = h.spawn({}, agent);
  await h.arm({ provider: "new", model: "nm" }, agent);
  d.reject(new Error("boom"));
  await assert.rejects(inflight, /boom/);
  assert.deepEqual(await h.pending(agent), { provider: "new", model: "nm" });
});

test("spawn 时路由不可用：抛错、rawStart 不被调用、登记恢复", async () => {
  let preflights = 0;
  const llm = { resolveCallConfig: async () => { preflights += 1; if (preflights > 1) throw new Error("route gone"); } };
  const h = createHarness({ llm });
  const agent = makeAgent();
  await h.arm({ provider: "p", model: "m" }, agent);
  await assert.rejects(h.spawn({}, agent), /member-model: spawn route p\/m is unavailable: route gone/);
  assert.equal(h.calls.length, 0);
  assert.deepEqual(await h.pending(agent), { provider: "p", model: "m" });
});

test("不同 agent 的 pending 互相隔离", async () => {
  const h = createHarness();
  const a = makeAgent("agent-a");
  const b = makeAgent("agent-b");
  await h.arm({ provider: "ap", model: "am" }, a);
  assert.deepEqual(await h.pending(a), { provider: "ap", model: "am" });
  assert.equal(await h.pending(b), undefined);
  const bRequest = { parent: b };
  await h.start("spawn", bRequest);
  assert.equal(bRequest.agentOptions, undefined);
});

test("agentKey 回退到 session.header.id", async () => {
  const h = createHarness();
  const agent = { session: { header: { id: "sess-1" } } };
  await h.arm({ provider: "sp", model: "sm" }, agent);
  assert.deepEqual(await h.pending(agent), { provider: "sp", model: "sm" });
  await h.start("spawn", { parent: agent });
  assert.deepEqual(h.calls[0].request.agentOptions, { provider: "sp", model: "sm" });
});

test("缺少调用 agent 时 arm/get 抛错", async () => {
  const h = createHarness();
  await assert.rejects(h.call("arm_spawn_route", { provider: "p", model: "m" }, null), /requires a calling agent/);
  await assert.rejects(h.call("get_spawn_route", {}, null), /requires a calling agent/);
});

test("view 形状：configured 恒在，inherit=false 才有 activeDefault", async () => {
  const inherit = createHarness({ config: { inherit: true, provider: "cp", model: "cm" } });
  const v1 = await inherit.get(makeAgent());
  assert.equal(v1.inherit, true);
  assert.deepEqual(v1.configured, { provider: "cp", model: "cm" });
  assert.equal("activeDefault" in v1, false);
  assert.equal("pending" in v1, false);

  const fixed = createHarness({ config: { inherit: false, provider: "dp", model: "dm", reasoningEffort: "low" } });
  const v2 = await fixed.get(makeAgent());
  assert.equal(v2.inherit, false);
  assert.deepEqual(v2.configured, { provider: "dp", model: "dm", reasoningEffort: "low" });
  assert.deepEqual(v2.activeDefault, { provider: "dp", model: "dm", reasoningEffort: "low" });

  const empty = createHarness();
  const v3 = await empty.get(makeAgent());
  assert.equal("activeDefault" in v3, false);
  assert.deepEqual(v3.configured, { provider: "", model: "" });
});
