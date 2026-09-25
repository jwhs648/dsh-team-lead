// 可见性（D）与生命周期清理（G）：子 agent 看不到三个路由工具；agent 释放后清理登记。
import test from "node:test";
import assert from "node:assert/strict";
import { apply } from "../index.js";
import {
  ROUTE_TOOLS,
  createCtx,
  createHarness,
  makeAgent,
  makeScopedAgent,
  noteOf,
  oncePendingStart,
} from "./helpers/harness.mjs";

test("agent/created：delegation depth > 0 的子 agent 被屏蔽三个路由工具，顶层 agent 不受影响", async () => {
  const h = createHarness();
  const top = makeScopedAgent("top", { depth: 0 });
  const child = makeScopedAgent("kid", { depth: 1 });
  await h.emit("agent/created", { agent: top });
  await h.emit("agent/created", { agent: child });
  assert.equal(top.restrictions.length, 0);
  assert.equal(child.restrictions.length, 1);
  assert.deepEqual(child.restrictions[0].filter, { deny: ROUTE_TOOLS });
});

test("深度取持久化 header 与运行时 options 的较大值", async () => {
  const h = createHarness();
  const byHeader = makeScopedAgent("h1", { depth: 0, headerDepth: 2 });
  const byOptions = makeScopedAgent("o1", { depth: 1, headerDepth: 0 });
  await h.emit("agent/created", { agent: byHeader });
  await h.emit("agent/created", { agent: byOptions });
  assert.equal(byHeader.restrictions.length, 1);
  assert.equal(byOptions.restrictions.length, 1);
});

test("同一个 agent 多次 agent/created（如恢复）只屏蔽一次", async () => {
  const h = createHarness();
  const child = makeScopedAgent("kid", { depth: 1 });
  await h.emit("agent/created", { agent: child });
  await h.emit("agent/created", { agent: child });
  assert.equal(child.restrictions.length, 1);
});

test("apply 时已存在的子 agent 也被屏蔽", () => {
  const existing = makeScopedAgent("old-kid", { depth: 1 });
  const top = makeScopedAgent("old-top", { depth: 0 });
  const base = createCtx({ agents: [top, existing] });
  apply(base.ctx, { inherit: true });
  assert.equal(existing.restrictions.length, 1);
  assert.equal(top.restrictions.length, 0);
});

test("经 spawn_teammate 创建的队员在创建时即被屏蔽", async () => {
  const h = createHarness();
  const agent = makeAgent("lead", { options: { provider: "lp", model: "lm" } });
  await h.arm({ provider: "p", model: "m" }, agent);
  const result = await h.spawnTeammate({ name: "a" }, agent);
  const member = JSON.parse(result.content[0].text).member;
  const child = h.live.get(member.id);
  assert.equal(child.restrictions.length, 1);
  assert.deepEqual(child.restrictions[0].filter, { deny: ROUTE_TOOLS });
});

test("restrict 抛错不影响 agent 创建，只记 warn", async () => {
  const h = createHarness();
  const child = makeScopedAgent("kid", { depth: 1, restrict: () => { throw new Error("tools.restrict() names unknown global tool"); } });
  await h.emit("agent/created", { agent: child });
  assert.ok(h.warnings.some((message) => message.includes("could not hide route tools") && message.includes("kid")));
});

test("没有 agent.ctx.tools.restrict 的 agent 被安静跳过", async () => {
  const h = createHarness();
  await h.emit("agent/created", { agent: { id: "plain", options: { subagentDepth: 1 } } });
  await h.emit("agent/created", { agent: undefined });
  await h.emit("agent/created", {});
  assert.equal(h.warnings.length, 0);
});

test("卸载插件时解除全部屏蔽；已释放的 agent 不再解除", async () => {
  const h = createHarness();
  const kept = makeScopedAgent("kept", { depth: 1 });
  const gone = makeScopedAgent("gone", { depth: 2 });
  await h.emit("agent/created", { agent: kept });
  await h.emit("agent/created", { agent: gone });
  await h.emit("agent/disposed", { agent: gone });
  h.disposeAll();
  assert.equal(kept.restrictions[0].lifted, true);
  assert.equal(gone.restrictions[0].lifted, false, "agent 作用域已自行回收，不重复解除");
  const late = makeScopedAgent("late", { depth: 1 });
  await h.emit("agent/created", { agent: late });
  assert.equal(late.restrictions.length, 0, "卸载后不再屏蔽");
});

test("agent/disposed：清理该队长的登记与 applied", async () => {
  const h = createHarness();
  const agent = makeAgent("lead", { options: { provider: "lp", model: "lm" } });
  await h.arm({ provider: "p", model: "m" }, agent);
  await h.spawnTeammate({ name: "a" }, agent);
  await h.arm({ follow: true }, agent);
  const before = await h.get(agent);
  assert.deepEqual(before.pending, { follow: true });
  assert.equal(before.applied.at(-1).teammate, "a");
  await h.emit("agent/disposed", { agent });
  const after = await h.get(agent);
  assert.equal(after.pending, undefined);
  assert.equal(after.applied, undefined);
});

test("agent 释放并重新登记后，释放前的在途失败不得复活旧路由", async () => {
  const { impl, entered, gate } = oncePendingStart();
  const h = createHarness({ continuableImpl: impl });
  const agent = makeAgent("lead");
  await h.arm({ provider: "old", model: "om" }, agent);
  const inflight = h.spawnTeammate({ name: "a" }, agent);
  await entered.promise;
  await h.emit("agent/disposed", { agent });
  await h.arm({ provider: "new", model: "nm" }, agent);
  await h.spawnTeammate({ name: "b" }, agent);
  assert.equal(await h.pending(agent), undefined);
  gate.reject(new Error("boom"));
  const failed = await inflight;
  assert.equal(failed.isError, true);
  assert.match(noteOf(failed), /was not restored/);
  assert.equal(await h.pending(agent), undefined, "全局递增代次保证旧登记不会与新代次重合");
});

// 屏蔽失败绝不能拖垮 agent 创建或插件加载。
test("restrict 抛错：agent/created 照常完成，只记警告", async () => {
  const h = createHarness();
  const child = makeScopedAgent("kid", { depth: 1, restrict: () => { throw new Error("unknown global tool"); } });
  await h.emit("agent/created", { agent: child });
  assert.ok(h.warnings.some((line) => line.includes('could not hide route tools from child agent kid: unknown global tool')), h.warnings.join("\n"));
});

test("卸载时解除屏蔽抛错：其余清理照常进行", async () => {
  const h = createHarness();
  const child = makeScopedAgent("kid", { depth: 1, restrict: () => () => { throw new Error("scope already gone"); } });
  await h.emit("agent/created", { agent: child });
  assert.doesNotThrow(() => h.disposeAll());
  assert.equal(h.registered.size, 0, "工具已注销");
  assert.equal(h.listenerCount("agent/created"), 0);
});

test("启动时扫描已有 agent 抛错：插件照常加载，只记警告", () => {
  const base = createCtx();
  base.ctx.get("agents").list = () => { throw new Error("registry busy"); };
  apply(base.ctx, { inherit: true });
  assert.equal(base.registered.size, 3);
  assert.ok(base.warnings.some((line) => line.includes("could not scan existing agents: registry busy")));
});
