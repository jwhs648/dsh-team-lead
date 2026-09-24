// clear_spawn_route 隔离回归：取消、失败恢复与 arm/clear 竞态。
// 最终 API（lead 定稿）：
//   clear_spawn_route({}) -> { cleared: boolean, route?: Route }
//   - 空槽返回 cleared:false 且不抛错；只作用调用者；不改 configured/activeDefault
//   - 不 abort 已开始的 spawn；每次调用无条件推进代次
//   - 普通失败与 AbortError 保留原恢复语义，除非期间发生 clear 或新 arm
//   - arm 在 preflight 前捕获代次，preflight 后比对；不同则返回 { armed:false, route } 且不提交
// start / startContinuable 两个 fresh spawn 入口全部参数化；竞态用 entered barrier 定序，不用 sleep。
import test from "node:test";
import assert from "node:assert/strict";
import {
  ENTRY_POINTS,
  abortError,
  createHarness,
  deferred,
  gatedLlm,
  makeAgent,
  oncePendingStart,
} from "./helpers/harness.mjs";

test("clear 空槽返回 cleared=false 且不抛错，不改 configured/activeDefault", async () => {
  const plain = createHarness({ config: { inherit: true, provider: "cp", model: "cm" } });
  const agent = makeAgent();
  const before = await plain.get(agent);
  const result = await plain.clear(agent);
  assert.equal(result.cleared, false);
  assert.equal("route" in result, false);
  assert.deepEqual(await plain.get(agent), before);

  const fixed = createHarness({ config: { inherit: false, provider: "dp", model: "dm", reasoningEffort: "low" } });
  const fixedAgent = makeAgent();
  await fixed.clear(fixedAgent);
  const view = await fixed.get(fixedAgent);
  assert.equal(view.inherit, false);
  assert.deepEqual(view.activeDefault, { provider: "dp", model: "dm", reasoningEffort: "low" });
  await fixed.spawnEntry("start", { agent: fixedAgent });
  assert.deepEqual(fixed.applied("start").agentOptions, { provider: "dp", model: "dm", reasoningEffort: "low" });
});

test("插件必须通过 ctx.effect 注销包括 clear 在内的全部工具", () => {
  const h = createHarness();
  assert.ok(h.registered.has("arm_spawn_route"));
  assert.ok(h.registered.has("get_spawn_route"));
  assert.ok(h.registered.has("clear_spawn_route"));
  h.disposeAll();
  assert.equal(h.registered.size, 0);
  assert.equal(Object.hasOwn(h.runtime, "start"), false);
});

test("get_spawn_route 不暴露内部 epoch", async () => {
  const h = createHarness();
  const agent = makeAgent();
  await h.arm({ provider: "p", model: "m" }, agent);
  assert.equal("epoch" in (await h.get(agent)), false);
  await h.clear(agent);
  assert.equal("epoch" in (await h.get(agent)), false);
});

test("arm 越过 preflight 期间 clear：返回 armed=false、不提交、不抛错", async () => {
  const { llm, gates } = gatedLlm();
  const h = createHarness({ llm });
  const agent = makeAgent();
  const arming = h.arm({ provider: "b1", model: "bm" }, agent);
  assert.equal(gates.length, 1);
  const cleared = await h.clear(agent);
  assert.equal(cleared.cleared, false);
  gates[0].resolve({});
  const armed = await arming;
  assert.equal(armed.armed, false);
  assert.deepEqual(armed.route, { provider: "b1", model: "bm" });
  assert.equal(await h.pending(agent), undefined);
});

test("两次重叠 arm：先调用者先提交时生效，后提交者 armed=false", async () => {
  const { llm, gates } = gatedLlm();
  const h = createHarness({ llm });
  const agent = makeAgent();
  const first = h.arm({ provider: "first", model: "fm" }, agent);
  const second = h.arm({ provider: "second", model: "sm" }, agent);
  assert.equal(gates.length, 2);
  gates[0].resolve({});
  assert.deepEqual(await first, { armed: true, route: { provider: "first", model: "fm" } });
  gates[1].resolve({});
  const loser = await second;
  assert.equal(loser.armed, false);
  assert.deepEqual(loser.route, { provider: "second", model: "sm" });
  assert.deepEqual(await h.pending(agent), { provider: "first", model: "fm" });
});

test("两次重叠 arm：后调用者先完成 preflight 也由首个成功提交者生效", async () => {
  const { llm, gates } = gatedLlm();
  const h = createHarness({ llm });
  const agent = makeAgent();
  const first = h.arm({ provider: "first", model: "fm" }, agent);
  const second = h.arm({ provider: "second", model: "sm" }, agent);
  assert.equal(gates.length, 2);
  gates[1].resolve({});
  const winner = await second;
  assert.equal(winner.armed, true);
  assert.deepEqual(winner.route, { provider: "second", model: "sm" });
  gates[0].resolve({});
  const loser = await first;
  assert.equal(loser.armed, false);
  assert.deepEqual(loser.route, { provider: "first", model: "fm" });
  assert.deepEqual(await h.pending(agent), { provider: "second", model: "sm" });
});

test("顺序 arm 仍替换并生效", async () => {
  const h = createHarness();
  const agent = makeAgent();
  assert.equal((await h.arm({ provider: "one", model: "om" }, agent)).armed, true);
  assert.equal((await h.arm({ provider: "two", model: "tm" }, agent)).armed, true);
  assert.deepEqual(await h.pending(agent), { provider: "two", model: "tm" });
  await h.spawnEntry("start", { agent });
  assert.deepEqual(h.applied("start").agentOptions, { provider: "two", model: "tm" });
});

for (const entry of ENTRY_POINTS) {
  test("[" + entry + "] clear 只清调用者自己的未消费登记", async () => {
    const h = createHarness();
    const a = makeAgent("agent-a");
    const b = makeAgent("agent-b");
    await h.arm({ provider: "ap", model: "am" }, a);
    const other = await h.clear(b);
    assert.equal(other.cleared, false);
    assert.deepEqual(await h.pending(a), { provider: "ap", model: "am" });
    const mine = await h.clear(a);
    assert.equal(mine.cleared, true);
    assert.deepEqual(mine.route, { provider: "ap", model: "am" });
    assert.equal(await h.pending(a), undefined);
    await h.spawnEntry(entry, { agent: a });
    assert.equal(h.applied(entry).agentOptions, undefined);
  });

  test("[" + entry + "] clear 后 get 无 pending，后续 spawn 走默认", async () => {
    const h = createHarness();
    const agent = makeAgent();
    await h.arm({ provider: "p", model: "m", reasoningEffort: "high" }, agent);
    const result = await h.clear(agent);
    assert.equal(result.cleared, true);
    assert.deepEqual(result.route, { provider: "p", model: "m", reasoningEffort: "high" });
    assert.equal((await h.get(agent)).pending, undefined);
    await h.spawnEntry(entry, { agent });
    assert.equal(h.applied(entry).agentOptions, undefined);
  });

  test("[" + entry + "] 核心：in-flight 消费后 clear，失败不得复活，且此后可正常创建", async () => {
    const { impl, entered, gate, starts } = oncePendingStart();
    const h = createHarness({ startImpl: impl, continuableImpl: impl });
    const agent = makeAgent();
    await h.arm({ provider: "p", model: "m" }, agent);
    const inflight = h.spawnEntry(entry, { agent });
    await entered.promise;
    assert.equal(await h.pending(agent), undefined);
    const cleared = await h.clear(agent);
    assert.equal(cleared.cleared, false);
    gate.reject(new Error("boom"));
    await assert.rejects(inflight, /boom/);
    assert.equal(await h.pending(agent), undefined);
    await h.spawnEntry(entry, { agent });
    assert.equal(starts(), 2);
    assert.equal(h.applied(entry).agentOptions, undefined);
  });

  test("[" + entry + "] clear 期间新 arm，旧 spawn 失败不复活旧路由且保留新 route", async () => {
    const { impl, entered, gate } = oncePendingStart();
    const h = createHarness({ startImpl: impl, continuableImpl: impl });
    const agent = makeAgent();
    await h.arm({ provider: "old", model: "om" }, agent);
    const inflight = h.spawnEntry(entry, { agent });
    await entered.promise;
    await h.clear(agent);
    await h.arm({ provider: "new", model: "nm" }, agent);
    gate.reject(new Error("boom"));
    await assert.rejects(inflight, /boom/);
    assert.deepEqual(await h.pending(agent), { provider: "new", model: "nm" });
  });

  test("[" + entry + "] 新 route 已被消费后旧 spawn 失败，不得复活旧路由", async () => {
    const { impl, entered, gate, starts } = oncePendingStart();
    const h = createHarness({ startImpl: impl, continuableImpl: impl });
    const agent = makeAgent();
    await h.arm({ provider: "old", model: "om" }, agent);
    const oldSpawn = h.spawnEntry(entry, { agent });
    await entered.promise;
    await h.arm({ provider: "new", model: "nm" }, agent);
    await h.spawnEntry(entry, { agent });
    assert.equal(starts(), 2);
    gate.reject(new Error("boom"));
    await assert.rejects(oldSpawn, /boom/);
    assert.equal(await h.pending(agent), undefined);
  });

  test("[" + entry + "] clear 不中止已开始的 spawn", async () => {
    const { impl, entered, gate } = oncePendingStart();
    const h = createHarness({ startImpl: impl, continuableImpl: impl });
    const agent = makeAgent();
    await h.arm({ provider: "p", model: "m" }, agent);
    const inflight = h.spawnEntry(entry, { agent });
    await entered.promise;
    const cleared = await h.clear(agent);
    assert.equal(cleared.cleared, false);
    gate.resolve({ ok: "spawned" });
    assert.deepEqual(await inflight, { ok: "spawned" });
    assert.equal(h.calls.length, 1);
    assert.equal(await h.pending(agent), undefined);
  });

  test("[" + entry + "] spawn 的 preflight 期间 clear 后 reject：不恢复、rawStart 未被调用", async () => {
    const { llm, gates } = gatedLlm();
    const h = createHarness({ llm });
    const agent = makeAgent();
    const arming = h.arm({ provider: "p", model: "m" }, agent);
    gates[0].resolve({});
    assert.equal((await arming).armed, true);
    const inflight = h.spawnEntry(entry, { agent });
    assert.equal(gates.length, 2);
    const cleared = await h.clear(agent);
    assert.equal(cleared.cleared, false);
    gates[1].reject(new Error("route gone"));
    await assert.rejects(inflight, /member-model: spawn route p\/m is unavailable: route gone/);
    assert.equal(h.calls.length, 0);
    assert.equal(await h.pending(agent), undefined);
  });

  test("[" + entry + "] 无 clear 的普通失败仍恢复登记", async () => {
    const h = createHarness({
      startImpl: () => { throw new Error("boom"); },
      continuableImpl: () => { throw new Error("boom"); },
    });
    const agent = makeAgent();
    await h.arm({ provider: "p", model: "m" }, agent);
    await assert.rejects(h.spawnEntry(entry, { agent }), /boom/);
    assert.deepEqual(await h.pending(agent), { provider: "p", model: "m" });
  });

  test("[" + entry + "] AbortError 且无 clear 时仍恢复登记", async () => {
    const h = createHarness({
      startImpl: () => { throw abortError(); },
      continuableImpl: () => { throw abortError(); },
    });
    const agent = makeAgent();
    await h.arm({ provider: "p", model: "m" }, agent);
    await assert.rejects(h.spawnEntry(entry, { agent }), (error) => error.name === "AbortError");
    assert.deepEqual(await h.pending(agent), { provider: "p", model: "m" });
  });

  test("[" + entry + "] AbortError 且期间 clear：不恢复", async () => {
    const { impl, entered, gate } = oncePendingStart();
    const h = createHarness({ startImpl: impl, continuableImpl: impl });
    const agent = makeAgent();
    await h.arm({ provider: "p", model: "m" }, agent);
    const inflight = h.spawnEntry(entry, { agent });
    await entered.promise;
    await h.clear(agent);
    gate.reject(abortError());
    await assert.rejects(inflight, (error) => error.name === "AbortError");
    assert.equal(await h.pending(agent), undefined);
  });
}
