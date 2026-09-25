// clear_spawn_route 隔离回归：取消、失败恢复与 arm/clear 竞态。
// API：
//   clear_spawn_route({}) -> { cleared: boolean, route?: Route, follow?: true }
//   - 空槽返回 cleared:false 且不抛错；只作用调用者；不改 configured/activeDefault
//   - 不 abort 已开始的创建；每次调用无条件推进代次
//   - 普通失败与 AbortError 保留原恢复语义，除非期间发生 clear 或新 arm
//   - arm 在 preflight 前捕获代次，preflight 后比对；不同则返回 { armed:false, route } 且不提交
// 登记只由建队员调用（spawn_teammate）消费；竞态用 entered barrier 定序，不用 sleep。
import test from "node:test";
import assert from "node:assert/strict";
import {
  abortError,
  createHarness,
  gatedLlm,
  makeAgent,
  noteOf,
  oncePendingStart,
} from "./helpers/harness.mjs";

const OPEN = { inherit: true, requireArm: false };

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
  await fixed.spawnTeammate({}, fixedAgent);
  assert.deepEqual(fixed.lastTeammateOptions(), { provider: "dp", model: "dm", reasoningEffort: "low" });
});

test("clear 登记的 follow：返回 cleared:true 与 follow:true", async () => {
  const h = createHarness();
  const agent = makeAgent();
  await h.arm({ follow: true }, agent);
  assert.deepEqual(await h.clear(agent), { cleared: true, follow: true });
  assert.equal(await h.pending(agent), undefined);
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
  assert.equal("epoch" in (await h.get(agent)).pending, false);
  await h.arm({ follow: true }, agent);
  assert.deepEqual((await h.get(agent)).pending, { follow: true });
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

test("arm 越过 preflight 期间的 follow 登记：先提交的 follow 生效", async () => {
  const { llm, gates } = gatedLlm();
  const h = createHarness({ llm });
  const agent = makeAgent();
  const arming = h.arm({ provider: "b1", model: "bm" }, agent);
  assert.deepEqual(await h.arm({ follow: true }, agent), { armed: true, follow: true });
  gates[0].resolve({});
  assert.equal((await arming).armed, false);
  assert.deepEqual(await h.pending(agent), { follow: true });
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
  await h.spawnTeammate({}, agent);
  assert.deepEqual(h.lastTeammateOptions(), { provider: "two", model: "tm" });
});

test("clear 只清调用者自己的未消费登记", async () => {
  const h = createHarness({ config: OPEN });
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
  await h.spawnTeammate({}, a);
  assert.equal(h.lastTeammateOptions(), undefined);
});

test("clear 后 get 无 pending；requireArm 下再建 fresh 队员会被拦截", async () => {
  const h = createHarness();
  const agent = makeAgent();
  await h.arm({ provider: "p", model: "m", reasoningEffort: "high" }, agent);
  const result = await h.clear(agent);
  assert.equal(result.cleared, true);
  assert.deepEqual(result.route, { provider: "p", model: "m", reasoningEffort: "high" });
  assert.equal((await h.get(agent)).pending, undefined);
  const refused = await h.spawnTeammate({}, agent);
  assert.equal(refused.isError, true);
  assert.equal(refused.error.info.code, "MEMBER_MODEL_ARM_REQUIRED");
  assert.equal(h.calls.length, 0);
});

test("核心：in-flight 消费后 clear，失败不得复活，且此后可正常创建", async () => {
  const { impl, entered, gate, starts } = oncePendingStart();
  const h = createHarness({ continuableImpl: impl, config: OPEN });
  const agent = makeAgent();
  await h.arm({ provider: "p", model: "m" }, agent);
  const inflight = h.spawnTeammate({}, agent);
  await entered.promise;
  assert.equal(await h.pending(agent), undefined);
  const cleared = await h.clear(agent);
  assert.equal(cleared.cleared, false);
  gate.reject(new Error("boom"));
  const failed = await inflight;
  assert.equal(failed.isError, true);
  assert.match(noteOf(failed), /cleared or replaced meanwhile and was not restored/);
  assert.equal(await h.pending(agent), undefined);
  await h.spawnTeammate({}, agent);
  assert.equal(starts(), 2);
  assert.equal(h.lastTeammateOptions(), undefined);
});

test("clear 期间新 arm，旧创建失败不复活旧路由且保留新 route", async () => {
  const { impl, entered, gate } = oncePendingStart();
  const h = createHarness({ continuableImpl: impl });
  const agent = makeAgent();
  await h.arm({ provider: "old", model: "om" }, agent);
  const inflight = h.spawnTeammate({}, agent);
  await entered.promise;
  await h.clear(agent);
  await h.arm({ provider: "new", model: "nm" }, agent);
  gate.reject(new Error("boom"));
  assert.equal((await inflight).isError, true);
  assert.deepEqual(await h.pending(agent), { provider: "new", model: "nm" });
});

test("新 route 已被消费后旧创建失败，不得复活旧路由", async () => {
  const { impl, entered, gate, starts } = oncePendingStart();
  const h = createHarness({ continuableImpl: impl });
  const agent = makeAgent();
  await h.arm({ provider: "old", model: "om" }, agent);
  const oldSpawn = h.spawnTeammate({}, agent);
  await entered.promise;
  await h.arm({ provider: "new", model: "nm" }, agent);
  await h.spawnTeammate({}, agent);
  assert.equal(starts(), 2);
  gate.reject(new Error("boom"));
  assert.equal((await oldSpawn).isError, true);
  assert.equal(await h.pending(agent), undefined);
});

test("clear 不中止已开始的创建", async () => {
  const { impl, entered, gate } = oncePendingStart();
  const h = createHarness({ continuableImpl: impl });
  const agent = makeAgent();
  await h.arm({ provider: "p", model: "m" }, agent);
  const inflight = h.spawnTeammate({}, agent);
  await entered.promise;
  const cleared = await h.clear(agent);
  assert.equal(cleared.cleared, false);
  gate.resolve({ ok: "spawned" });
  const result = await inflight;
  assert.equal(result.isError, false);
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.lastTeammateOptions(), { provider: "p", model: "m" });
  assert.equal(await h.pending(agent), undefined);
});

test("建队员的 preflight 期间 clear 后 reject：不恢复、rawStart 未被调用", async () => {
  const { llm, gates } = gatedLlm();
  const h = createHarness({ llm });
  const agent = makeAgent();
  const arming = h.arm({ provider: "p", model: "m" }, agent);
  gates[0].resolve({});
  assert.equal((await arming).armed, true);
  const inflight = h.spawnTeammate({}, agent);
  while (gates.length < 2) await new Promise((resolve) => setImmediate(resolve));
  const cleared = await h.clear(agent);
  assert.equal(cleared.cleared, false);
  gates[1].reject(new Error("route gone"));
  const result = await inflight;
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /member-model: spawn route p\/m is unavailable: route gone/);
  assert.equal(h.calls.length, 0);
  assert.equal(await h.pending(agent), undefined);
});

test("无 clear 的普通失败仍恢复登记，并在结果里说明", async () => {
  const h = createHarness({ continuableImpl: () => { throw new Error("boom"); } });
  const agent = makeAgent();
  await h.arm({ provider: "p", model: "m" }, agent);
  const result = await h.spawnTeammate({}, agent);
  assert.equal(result.isError, true);
  assert.match(noteOf(result), /the armed route p\/m stays armed for a retry/);
  assert.deepEqual(await h.pending(agent), { provider: "p", model: "m" });
});

test("工具在调用 startContinuable 之前失败（如名字已用）也恢复登记", async () => {
  const h = createHarness({ teammateImpl: () => { throw new Error("teammate name \"a\" was already used in this Team"); } });
  const agent = makeAgent();
  await h.arm({ follow: true }, agent);
  const result = await h.spawnTeammate({ name: "a" }, agent);
  assert.equal(result.isError, true);
  assert.match(noteOf(result), /the armed follow stays armed for a retry/);
  assert.deepEqual(await h.pending(agent), { follow: true });
});

test("AbortError 且无 clear 时仍恢复登记", async () => {
  const h = createHarness({ continuableImpl: () => { throw abortError(); } });
  const agent = makeAgent();
  await h.arm({ provider: "p", model: "m" }, agent);
  const result = await h.spawnTeammate({}, agent);
  assert.equal(result.isError, true);
  assert.deepEqual(await h.pending(agent), { provider: "p", model: "m" });
});

test("AbortError 且期间 clear：不恢复", async () => {
  const { impl, entered, gate } = oncePendingStart();
  const h = createHarness({ continuableImpl: impl });
  const agent = makeAgent();
  await h.arm({ provider: "p", model: "m" }, agent);
  const inflight = h.spawnTeammate({}, agent);
  await entered.promise;
  await h.clear(agent);
  gate.reject(abortError());
  assert.equal((await inflight).isError, true);
  assert.equal(await h.pending(agent), undefined);
});

test("tools/execute 下游抛错（非工具本体错误）时同样恢复登记", async () => {
  const h = createHarness();
  const agent = makeAgent();
  await h.arm({ provider: "p", model: "m" }, agent);
  // 在插件之后挂一个会抛错的 around-dispatch 监听器，模拟其他插件失败。
  h.ctx.on("tools/execute", () => { throw new Error("wrapper failed"); });
  const result = await h.spawnTeammate({}, agent);
  assert.equal(result.isError, true);
  assert.equal(result.final, true, "监听器抛错成为最终错误");
  assert.deepEqual(await h.pending(agent), { provider: "p", model: "m" });
});
