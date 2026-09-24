// 包装链生命周期兼容性（task-7）：own wrapper 保留与 descriptor 复原、后装 wrapper 安全、
// 卸载后残留 wrapper 纯透传、同 runtime 重复 apply no-op（runtime 级识别）、
// 不可配置属性 / 第二方法安装失败 / 工具注册失败都不留半安装、this/额外参数/返回/异常透传。
// 全部使用假 runtime，不请求模型、不碰安装副本。48 条既有基线保持不变。
import test from "node:test";
import assert from "node:assert/strict";
import { apply } from "../index.js";
import { ENTRY_POINTS, createCtx, gatedLlm, makeAgent } from "./helpers/harness.mjs";

const START = "start";
const CONT = "startContinuable";

function own(runtime, key) {
  return Object.getOwnPropertyDescriptor(runtime, key);
}

function defineOwn(runtime, key, descriptor) {
  Object.defineProperty(runtime, key, descriptor);
}

function applyTracked(base, config) {
  const before = base.effectDisposers.length;
  apply(base.ctx, config);
  return base.effectDisposers.slice(before);
}

function disposeList(disposers) {
  for (let i = disposers.length - 1; i >= 0; i -= 1) disposers[i]();
}

// 原型完全没有 start/startContinuable 的极端 runtime。
function bareCtx(protoMembers) {
  const registered = new Map();
  const runtime = Object.create(protoMembers);
  const warnings = [];
  const ctx = {
    subagents: runtime,
    tools: {
      register(tool) {
        registered.set(tool.name, tool);
        return () => {
          if (registered.get(tool.name) === tool) registered.delete(tool.name);
        };
      },
    },
    logger: { info() {}, warn: (message) => warnings.push(message) },
    get() { return undefined; },
    effect(fn) { return fn(); },
  };
  return { ctx, runtime, registered, warnings };
}

test("无 own 前置：apply 安装实例包装，卸载后 delete 并回到原型方法", () => {
  const base = createCtx();
  assert.equal(own(base.runtime, START), undefined);
  apply(base.ctx, { inherit: true });
  const installed = own(base.runtime, START);
  assert.equal(typeof installed.value, "function");
  assert.equal(installed.configurable, true);
  assert.equal(installed.writable, true);
  assert.equal(installed.enumerable, false);
  assert.notEqual(base.runtime[START], base.proto[START]);
  base.disposeAll();
  assert.equal(Object.hasOwn(base.runtime, START), false);
  assert.equal(Object.hasOwn(base.runtime, CONT), false);
  assert.equal(base.runtime[START], base.proto[START]);
  assert.equal(base.runtime[CONT], base.proto[CONT]);
});

test("卸载幂等：连续两次 dispose 不抛错且状态不变", () => {
  const base = createCtx();
  apply(base.ctx, { inherit: true });
  base.disposeAll();
  const snapshot = own(base.runtime, START);
  base.disposeAll();
  assert.deepEqual(own(base.runtime, START), snapshot);
  assert.equal(Object.hasOwn(base.runtime, START), false);
});

test("apply 前已有 own 包装：作为下一层，卸载后 descriptor 原样还原", async () => {
  const base = createCtx();
  const seen = [];
  const previous = async function (provider, request) {
    seen.push({ provider, request, receiver: this });
    return base.proto[START].call(this, provider, request);
  };
  defineOwn(base.runtime, START, { value: previous, configurable: true, writable: true, enumerable: false });
  const before = own(base.runtime, START);

  apply(base.ctx, { inherit: true });
  assert.notEqual(base.runtime[START], previous);

  const request = { parent: makeAgent() };
  const result = await base.runtime[START]("spawn", request);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].request, request);
  assert.deepEqual(result, { ok: true, provider: "spawn", request });

  base.disposeAll();
  assert.equal(base.runtime[START], previous);
  assert.deepEqual(own(base.runtime, START), before);
});

test("descriptor 复原保真：writable/enumerable/configurable 原样恢复", () => {
  const base = createCtx();
  const previous = function () { return base.proto[START].apply(this, arguments); };
  defineOwn(base.runtime, START, { value: previous, configurable: true, writable: false, enumerable: true });
  const before = own(base.runtime, START);
  apply(base.ctx, { inherit: true });
  assert.equal(own(base.runtime, START).writable, true);
  base.disposeAll();
  assert.deepEqual(own(base.runtime, START), before);
  assert.equal(own(base.runtime, START).writable, false);
  assert.equal(own(base.runtime, START).enumerable, true);
});

test("apply 前 own 属性是 accessor：卸载后 accessor descriptor 原样恢复", async () => {
  const base = createCtx();
  const impl = function () { return base.proto[START].apply(this, arguments); };
  defineOwn(base.runtime, START, { get: () => impl, set: () => {}, configurable: true, enumerable: false });
  const before = own(base.runtime, START);
  apply(base.ctx, { inherit: true });
  const result = await base.runtime[START]("spawn", { parent: makeAgent() });
  assert.equal(result.ok, true);
  base.disposeAll();
  const after = own(base.runtime, START);
  assert.equal(typeof after.get, "function");
  assert.equal(typeof after.set, "function");
  assert.deepEqual(after, before);
});

test("后装第三方包装：dispose 不覆盖它，且我们的旧 wrapper 卸载后纯透传", async () => {
  const base = createCtx();
  apply(base.ctx, { inherit: false, provider: "dp", model: "dm" });
  const ours = base.runtime[START];
  const later = async function (provider, request) {
    return ours.call(this, provider, request);
  };
  defineOwn(base.runtime, START, { value: later, configurable: true, writable: true, enumerable: false });

  const before = { parent: makeAgent() };
  await base.runtime[START]("spawn", before);
  assert.deepEqual(base.calls.at(-1).request.agentOptions, { provider: "dp", model: "dm" });

  base.disposeAll();
  assert.equal(own(base.runtime, START).value, later);

  const after = { parent: makeAgent() };
  const result = await base.runtime[START]("spawn", after);
  assert.equal(result.ok, true);
  assert.equal(base.calls.at(-1).request, after);
  assert.equal(base.calls.at(-1).request.agentOptions, undefined);
});

test("卸载后残留 wrapper 纯透传：被捕获的 start/startContinuable 不再解析路由", async () => {
  const base = createCtx();
  apply(base.ctx, { inherit: false, provider: "dp", model: "dm" });
  const oursStart = base.runtime[START];
  const oursCont = base.runtime[CONT];
  base.disposeAll();

  const request = { parent: makeAgent() };
  const result = await Reflect.apply(oursStart, base.runtime, ["spawn", request]);
  assert.equal(base.calls.at(-1).request, request);
  assert.equal(base.calls.at(-1).request.agentOptions, undefined);
  assert.equal(result.request, request);

  const spec = { provider: "spawn", request: { parent: makeAgent() } };
  const result2 = await Reflect.apply(oursCont, base.runtime, [spec]);
  assert.equal(base.calls.at(-1).spec, spec);
  assert.equal(base.calls.at(-1).spec.request.agentOptions, undefined);
  assert.equal(result2.ok, true);
});

test("同 runtime 重复 apply：整体 no-op + warn，不叠加、不注册第二套工具、不应用第二份配置", async () => {
  const base = createCtx();
  const firstDisposers = applyTracked(base, { inherit: false, provider: "dp", model: "dm" });
  const firstWrapper = base.runtime[START];
  const toolsAfterFirst = new Map(base.registered);
  const warnings = [];
  base.ctx.logger.warn = (message) => warnings.push(message);

  const secondDisposers = applyTracked(base, { inherit: true, provider: "other", model: "om" });

  assert.ok(warnings.length >= 1, "重复 apply 必须 warn");
  assert.equal(base.runtime[START], firstWrapper, "不得叠加第二层 wrapper");
  assert.equal(base.registered.size, toolsAfterFirst.size, "不得注册第二套工具");
  for (const [name, tool] of toolsAfterFirst) assert.equal(base.registered.get(name), tool);

  const agent = makeAgent();
  await base.runtime[START]("spawn", { parent: agent });
  assert.deepEqual(base.calls.at(-1).request.agentOptions, { provider: "dp", model: "dm" }, "第二份配置不得生效");

  disposeList(secondDisposers);
  assert.equal(base.runtime[START], firstWrapper, "卸载无效的第二份不得影响第一份");
  await base.registered.get("arm_spawn_route").execute({ provider: "rp", model: "rm" }, { agent });
  await base.runtime[START]("spawn", { parent: agent });
  assert.deepEqual(base.calls.at(-1).request.agentOptions, { provider: "rp", model: "rm" });

  disposeList(firstDisposers);
  assert.equal(Object.hasOwn(base.runtime, START), false);
  assert.equal(base.runtime[START], base.proto[START]);
  assert.equal(base.registered.size, 0);
});

test("第一次 wrapper 被第三方包住后，第二次 apply 仍整体 no-op", () => {
  const base = createCtx();
  apply(base.ctx, { inherit: true });
  const ours = base.runtime[START];
  const later = function (...args) { return ours.apply(this, args); };
  defineOwn(base.runtime, START, { value: later, configurable: true, writable: true, enumerable: false });
  const toolsBefore = new Map(base.registered);
  const warnings = [];
  base.ctx.logger.warn = (message) => warnings.push(message);

  apply(base.ctx, { inherit: true });

  assert.ok(warnings.length >= 1, "即使最外层被第三方包住，仍须识别出活跃安装");
  assert.equal(base.runtime[START], later, "不得重新包装第三方 wrapper");
  assert.equal(base.registered.size, toolsBefore.size);
  for (const [name, tool] of toolsBefore) assert.equal(base.registered.get(name), tool);
});

test("完全卸载后再 apply 能正常安装并生效", async () => {
  const base = createCtx();
  apply(base.ctx, { inherit: true });
  base.disposeAll();
  assert.equal(Object.hasOwn(base.runtime, START), false);

  apply(base.ctx, { inherit: false, provider: "dp", model: "dm" });
  const agent = makeAgent();
  await base.runtime[START]("spawn", { parent: agent });
  assert.deepEqual(base.calls.at(-1).request.agentOptions, { provider: "dp", model: "dm" });
  base.disposeAll();
  assert.equal(Object.hasOwn(base.runtime, START), false);
});

test("this 透传：无路由、有路由、continuable 三条路径都用调用者 receiver", async () => {
  const base = createCtx();
  apply(base.ctx, { inherit: true });
  const agent = makeAgent();

  const receiver1 = { tag: "r1" };
  await Reflect.apply(base.runtime[START], receiver1, ["spawn", { parent: agent }]);
  assert.equal(base.calls[0].receiver, receiver1);

  await base.registered.get("arm_spawn_route").execute({ provider: "p", model: "m" }, { agent });
  const receiver2 = { tag: "r2" };
  await Reflect.apply(base.runtime[START], receiver2, ["spawn", { parent: agent }]);
  assert.equal(base.calls[1].receiver, receiver2);

  const receiver3 = { tag: "r3" };
  await Reflect.apply(base.runtime[CONT], receiver3, [{ provider: "spawn", request: { parent: agent } }]);
  assert.equal(base.calls[2].receiver, receiver3);
});

test("额外实参透传：非 spawn、spawn 无路由、spawn 有路由、continuable 都不吞参数", async () => {
  const base = createCtx();
  apply(base.ctx, { inherit: true });
  const agent = makeAgent();

  await Reflect.apply(base.runtime[START], base.runtime, ["fork", { parent: agent }, "extra", 42]);
  assert.deepEqual(base.calls.at(-1).args, ["fork", { parent: agent }, "extra", 42]);

  await Reflect.apply(base.runtime[START], base.runtime, ["spawn", { parent: agent }, "extra"]);
  assert.equal(base.calls.at(-1).args.length, 3);
  assert.equal(base.calls.at(-1).args[2], "extra");

  await base.registered.get("arm_spawn_route").execute({ provider: "p", model: "m" }, { agent });
  await Reflect.apply(base.runtime[START], base.runtime, ["spawn", { parent: agent }, "extra", 7]);
  assert.equal(base.calls.at(-1).args.length, 4);
  assert.equal(base.calls.at(-1).args[2], "extra");
  assert.equal(base.calls.at(-1).args[3], 7);

  await Reflect.apply(base.runtime[CONT], base.runtime, [{ provider: "spawn", request: { parent: agent } }, "extra"]);
  assert.equal(base.calls.at(-1).args.length, 2);
  assert.equal(base.calls.at(-1).args[1], "extra");
});

test("非 spawn provider：request/spec 与返回值 identity 透传（两入口）", async () => {
  const base = createCtx();
  apply(base.ctx, { inherit: false, provider: "dp", model: "dm" });
  const request = { parent: makeAgent() };
  const result = await base.runtime[START]("fork", request);
  assert.equal(base.calls[0].request, request);
  assert.equal(result.request, request);

  const spec = { provider: "fork", request: { parent: makeAgent() } };
  const result2 = await base.runtime[CONT](spec);
  assert.equal(base.calls[1].spec, spec);
  assert.equal(result2.spec, spec);
});

test("spawn 无路由：request 与返回值 identity 透传", async () => {
  const base = createCtx();
  apply(base.ctx, { inherit: true });
  const request = { parent: makeAgent(), agentOptions: { temperature: 0.1 } };
  const result = await base.runtime[START]("spawn", request);
  assert.equal(base.calls[0].request, request);
  assert.equal(result.request, request);
});

test("异常透传：无路由时下一层同步抛非 Error，原样抛出", async () => {
  const thrown = "boom-string";
  const base = createCtx({ startImpl: () => { throw thrown; } });
  apply(base.ctx, { inherit: true });
  let caught;
  try {
    await base.runtime[START]("spawn", { parent: makeAgent() });
  } catch (error) {
    caught = error;
  }
  assert.equal(caught, thrown);
});

test("异常透传：消费路由后下一层抛 Error，identity 抛出且登记恢复", async () => {
  const thrown = new Error("raw-boom");
  const base = createCtx({ startImpl: () => { throw thrown; } });
  apply(base.ctx, { inherit: true });
  const agent = makeAgent();
  await base.registered.get("arm_spawn_route").execute({ provider: "p", model: "m" }, { agent });
  let caught;
  try {
    await base.runtime[START]("spawn", { parent: agent });
  } catch (error) {
    caught = error;
  }
  assert.equal(caught, thrown);
  const view = await base.registered.get("get_spawn_route").execute({}, { agent });
  assert.deepEqual(view.pending, { provider: "p", model: "m" });
});

test("异常透传：reject/throw 的非 Error 值原样透传（两入口）", async () => {
  const reason = { code: 42 };
  const base = createCtx({ startImpl: () => Promise.reject(reason) });
  apply(base.ctx, { inherit: true });
  let caught;
  try {
    await base.runtime[START]("spawn", { parent: makeAgent() });
  } catch (error) {
    caught = error;
  }
  assert.equal(caught, reason);

  const thrown = "cont-throw";
  const base2 = createCtx({ continuableImpl: () => { throw thrown; } });
  apply(base2.ctx, { inherit: true });
  let caught2;
  try {
    await base2.runtime[CONT]({ provider: "spawn", request: { parent: makeAgent() } });
  } catch (error) {
    caught2 = error;
  }
  assert.equal(caught2, thrown);
});

test("第二个方法不可包装（非 configurable 且不可写）：apply 抛 TypeError，第一个方法安装被回滚", () => {
  const base = createCtx();
  const original = function () { return base.proto[CONT].apply(this, arguments); };
  defineOwn(base.runtime, CONT, { value: original, configurable: false, writable: false, enumerable: false });

  assert.throws(() => apply(base.ctx, { inherit: true }), TypeError);

  assert.equal(Object.hasOwn(base.runtime, START), false);
  assert.equal(base.runtime[START], base.proto[START]);
  assert.equal(base.runtime[CONT], original);
  assert.equal(base.registered.size, 0);
  base.disposeAll();
  assert.equal(Object.hasOwn(base.runtime, START), false);
});

test("非 configurable 但可写的数据属性：就地换 value 安装，dispose 后 value 与属性位原样恢复", () => {
  const base = createCtx();
  const original = function () { return base.proto[START].apply(this, arguments); };
  defineOwn(base.runtime, START, { value: original, configurable: false, writable: true, enumerable: false });
  const before = own(base.runtime, START);

  apply(base.ctx, { inherit: true });

  const installed = own(base.runtime, START);
  assert.equal(installed.configurable, false);
  assert.equal(installed.writable, true);
  assert.equal(installed.enumerable, false);
  assert.notEqual(installed.value, original);
  assert.equal(base.runtime[START], installed.value);
  assert.equal(base.registered.size, 3);

  base.disposeAll();
  assert.deepEqual(own(base.runtime, START), before);
  assert.equal(base.runtime[START], original);
  assert.equal(base.registered.size, 0);
});

test("第二个方法是非 configurable accessor：apply 抛 TypeError 且第一个方法安装被回滚", () => {
  const base = createCtx();
  const original = function () { return base.proto[CONT].apply(this, arguments); };
  defineOwn(base.runtime, CONT, { get: () => original, set: () => {}, configurable: false, enumerable: false });

  assert.throws(() => apply(base.ctx, { inherit: true }), TypeError);

  assert.equal(Object.hasOwn(base.runtime, START), false);
  assert.equal(base.runtime[START], base.proto[START]);
  assert.equal(base.runtime[CONT], original);
  assert.equal(base.registered.size, 0);
});

test("第一个方法不可包装（非 configurable 且不可写）：apply 抛 TypeError，第二个方法不被安装", () => {
  const base = createCtx();
  const original = function () { return base.proto[START].apply(this, arguments); };
  defineOwn(base.runtime, START, { value: original, configurable: false, writable: false, enumerable: false });
  assert.throws(() => apply(base.ctx, { inherit: true }), TypeError);
  assert.equal(base.runtime[START], original);
  assert.equal(Object.hasOwn(base.runtime, CONT), false);
  assert.equal(base.registered.size, 0);
});

test("第一个方法是非 configurable accessor：apply 抛 TypeError 且不安装第二个方法", () => {
  const base = createCtx();
  const original = function () { return base.proto[START].apply(this, arguments); };
  defineOwn(base.runtime, START, { get: () => original, set: () => {}, configurable: false, enumerable: false });
  assert.throws(() => apply(base.ctx, { inherit: true }), TypeError);
  assert.equal(base.runtime[START], original);
  assert.equal(Object.hasOwn(base.runtime, CONT), false);
  assert.equal(base.registered.size, 0);
});

test("半安装失败后再 apply 仍不残留", () => {
  const base = createCtx();
  const original = function () { return base.proto[CONT].apply(this, arguments); };
  defineOwn(base.runtime, CONT, { value: original, configurable: false, writable: false, enumerable: false });
  assert.throws(() => apply(base.ctx, { inherit: true }), TypeError);
  assert.throws(() => apply(base.ctx, { inherit: true }), TypeError);
  assert.equal(Object.hasOwn(base.runtime, START), false);
  assert.equal(base.registered.size, 0);
  assert.equal(base.runtime[CONT], original);
});

for (const failAt of [1, 2, 3]) {
  test("工具第 " + failAt + " 次注册失败：apply 抛错且不留半安装", () => {
    const base = createCtx();
    const realRegister = base.ctx.tools.register;
    let registrations = 0;
    base.ctx.tools.register = (tool) => {
      registrations += 1;
      if (registrations === failAt) throw new Error("register denied");
      return realRegister(tool);
    };

    assert.throws(() => apply(base.ctx, { inherit: true }), /register denied/);

    assert.equal(Object.hasOwn(base.runtime, START), false);
    assert.equal(Object.hasOwn(base.runtime, CONT), false);
    assert.equal(base.runtime[START], base.proto[START]);
    assert.equal(base.registered.size, 0, "已注册的工具必须全部回滚");
    base.disposeAll();
    assert.equal(base.registered.size, 0);

    // 失败不留安装记录：修好注册后再次 apply 必须能真正安装，而不是被判为重复 apply
    base.ctx.tools.register = realRegister;
    apply(base.ctx, { inherit: true });
    assert.equal(Object.hasOwn(base.runtime, START), true);
    assert.equal(base.registered.size, 3);
    base.disposeAll();
    assert.equal(Object.hasOwn(base.runtime, START), false);
    assert.equal(base.registered.size, 0);
  });
}

test("原型缺 start/startContinuable：warn 一次、不安装、工具照常注册", () => {
  const b = bareCtx({});
  apply(b.ctx, { inherit: true });
  assert.equal(b.warnings.length, 1);
  assert.ok(b.warnings[0].includes("no start/startContinuable"));
  assert.equal(Object.hasOwn(b.runtime, START), false);
  assert.equal(Object.hasOwn(b.runtime, CONT), false);
  assert.equal(b.registered.size, 3);
});

test("原型只有 start：warn 一次且两个键都不安装（不半安装）", () => {
  const b = bareCtx({ async start() { return { ok: true }; } });
  apply(b.ctx, { inherit: true });
  assert.equal(b.warnings.length, 1);
  assert.equal(Object.hasOwn(b.runtime, START), false);
  assert.equal(Object.hasOwn(b.runtime, CONT), false);
  assert.equal(b.registered.size, 3);
});

test("dispose 时 preflight 中的 spawn：解析后转为纯透传，不应用路由（两入口）", async () => {
  for (const entry of ENTRY_POINTS) {
    const { llm, gates } = gatedLlm();
    const base = createCtx({ llm });
    const disposers = applyTracked(base, { inherit: true });
    const agent = makeAgent();

    const arming = base.registered.get("arm_spawn_route").execute({ provider: "p", model: "m" }, { agent });
    assert.equal(gates.length, 1);
    gates[0].resolve({});
    assert.equal((await arming).armed, true);

    const request = { parent: agent };
    const inflight = entry === "start"
      ? base.runtime[START]("spawn", request)
      : base.runtime[CONT]({ provider: "spawn", request });
    assert.equal(gates.length, 2, "spawn preflight 已开始");

    disposeList(disposers);
    gates[1].resolve({});

    const result = await inflight;
    assert.equal(result.ok, true);
    assert.equal(base.calls.length, 1);
    const seen = entry === "start" ? base.calls[0].request : base.calls[0].spec.request;
    assert.equal(seen, request, "卸载后必须原样透传原 request");
    assert.equal(seen.agentOptions, undefined);
  }
});

test("dispose 时 preflight 中的 spawn：失败后原样抛出且不调用下一层（两入口）", async () => {
  for (const entry of ENTRY_POINTS) {
    const { llm, gates } = gatedLlm();
    const base = createCtx({ llm });
    const disposers = applyTracked(base, { inherit: true });
    const agent = makeAgent();

    const arming = base.registered.get("arm_spawn_route").execute({ provider: "p", model: "m" }, { agent });
    gates[0].resolve({});
    await arming;

    const request = { parent: agent };
    const inflight = entry === "start"
      ? base.runtime[START]("spawn", request)
      : base.runtime[CONT]({ provider: "spawn", request });
    assert.equal(gates.length, 2);

    disposeList(disposers);
    gates[1].reject(new Error("route gone"));

    await assert.rejects(inflight, /is unavailable: route gone/);
    assert.equal(base.calls.length, 0, "preflight 失败不得调用下一层");
  }
});

test("原型 accessor 方法依赖 this===runtime：必须按 runtime 读取有效方法", async () => {
  const base = createCtx({
    prepare(runtime, proto) {
      const originalStart = proto.start;
      Object.defineProperty(proto, START, {
        get() { return this === runtime ? originalStart : undefined; },
        configurable: true,
      });
    },
  });
  const warnings = [];
  base.ctx.logger.warn = (message) => warnings.push(message);

  apply(base.ctx, { inherit: false, provider: "dp", model: "dm" });

  assert.equal(warnings.length, 0, "读错 receiver 会把有效方法判为缺失");
  assert.equal(Object.hasOwn(base.runtime, START), true, "必须安装 own wrapper");
  const agent = makeAgent();
  await base.runtime[START]("spawn", { parent: agent });
  assert.deepEqual(base.calls.at(-1).request.agentOptions, { provider: "dp", model: "dm" });

  base.disposeAll();
  assert.equal(Object.hasOwn(base.runtime, START), false);
  assert.equal(typeof base.runtime[START], "function", "卸载后经原型 getter 仍取得到方法");
  const agent2 = makeAgent();
  await base.runtime[START]("spawn", { parent: agent2 });
  assert.equal(base.calls.at(-1).request.agentOptions, undefined);
});

test("own configurable accessor 的 getter 被实际调用，其返回方法作为下一层", async () => {
  const base = createCtx();
  const seen = [];
  const getterReturn = async function (provider, request) {
    seen.push({ provider, request, receiver: this });
    return base.proto[START].call(this, provider, request);
  };
  let getterCalls = 0;
  Object.defineProperty(base.runtime, START, {
    get() { getterCalls += 1; return getterReturn; },
    set() {},
    configurable: true,
    enumerable: false,
  });

  apply(base.ctx, { inherit: true });
  const request = { parent: makeAgent() };
  await base.runtime[START]("spawn", request);

  assert.ok(getterCalls >= 1, "必须调用 getter 取有效方法");
  assert.equal(seen.length, 1, "getter 返回的方法必须作为下一层被调用");
  assert.equal(seen[0].request, request);

  base.disposeAll();
  const after = own(base.runtime, START);
  assert.equal(typeof after.get, "function");
  await base.runtime[START]("spawn", { parent: makeAgent() });
  assert.equal(seen.length, 2, "卸载后 getter 仍是有效入口");
});

test("旧 disposer 多次调用、且在新安装后再调用，不得拆掉新安装", async () => {
  const base = createCtx();
  const firstDisposers = applyTracked(base, { inherit: true });
  const firstWrapper = base.runtime[START];
  disposeList(firstDisposers);
  assert.equal(Object.hasOwn(base.runtime, START), false);

  const secondDisposers = applyTracked(base, { inherit: false, provider: "dp", model: "dm" });
  const secondWrapper = base.runtime[START];
  const secondTools = new Map(base.registered);
  assert.notEqual(secondWrapper, firstWrapper);
  assert.equal(secondTools.size, 3);

  disposeList(firstDisposers);
  disposeList(firstDisposers);

  assert.equal(base.runtime[START], secondWrapper, "旧 disposer 不得拆掉新安装");
  assert.equal(Object.hasOwn(base.runtime, START), true);
  assert.equal(base.registered.size, 3, "旧 disposer 不得注销新安装的工具");
  for (const [name, tool] of secondTools) assert.equal(base.registered.get(name), tool);

  const agent = makeAgent();
  await base.registered.get("arm_spawn_route").execute({ provider: "rp", model: "rm" }, { agent });
  await base.runtime[START]("spawn", { parent: agent });
  assert.deepEqual(base.calls.at(-1).request.agentOptions, { provider: "rp", model: "rm" });

  await base.runtime[START]("spawn", { parent: makeAgent() });
  assert.deepEqual(base.calls.at(-1).request.agentOptions, { provider: "dp", model: "dm" });

  disposeList(secondDisposers);
  disposeList(secondDisposers);
  assert.equal(Object.hasOwn(base.runtime, START), false);
  assert.equal(base.runtime[START], base.proto[START]);
  assert.equal(base.registered.size, 0);
});

test("非扩展 runtime：就地安装并 warn not extensible，同副本二次 apply 仍 no-op", () => {
  const base = createCtx();
  const originalStart = function () { return base.proto[START].apply(this, arguments); };
  const originalCont = function () { return base.proto[CONT].apply(this, arguments); };
  defineOwn(base.runtime, START, { value: originalStart, configurable: true, writable: true, enumerable: false });
  defineOwn(base.runtime, CONT, { value: originalCont, configurable: true, writable: true, enumerable: false });
  Object.preventExtensions(base.runtime);

  const warnings = [];
  base.ctx.logger.warn = (message) => warnings.push(message);

  apply(base.ctx, { inherit: true });

  assert.ok(warnings.some((message) => message.includes("not extensible")), "非扩展 runtime 必须显式 warn");
  const installed = own(base.runtime, START);
  assert.equal(typeof installed.value, "function");
  assert.notEqual(installed.value, originalStart);
  assert.equal(installed.configurable, true);
  assert.equal(base.registered.size, 3);

  const wrapper = base.runtime[START];
  const tool = base.registered.get("arm_spawn_route");
  apply(base.ctx, { inherit: true });
  assert.equal(base.runtime[START], wrapper, "同副本二次 apply 必须整体 no-op");
  assert.equal(base.registered.get("arm_spawn_route"), tool);
  assert.equal(base.registered.size, 3);
  assert.ok(warnings.some((message) => message.includes("skipping duplicate apply")));

  base.disposeAll();
  assert.equal(own(base.runtime, START).value, originalStart);
  assert.equal(own(base.runtime, CONT).value, originalCont);
  assert.equal(own(base.runtime, START).configurable, true);
  assert.equal(base.registered.size, 0);
});

test("原型 accessor（startContinuable）的 getter 必须以 runtime 为 receiver", async () => {
  const seenThis = [];
  const base = createCtx({
    prepare(runtime, proto) {
      const original = proto[CONT];
      Object.defineProperty(proto, CONT, {
        get() { seenThis.push(this); return this === runtime ? original : undefined; },
        configurable: true,
      });
    },
  });
  const warnings = [];
  base.ctx.logger.warn = (message) => warnings.push(message);

  apply(base.ctx, { inherit: false, provider: "dp", model: "dm" });

  assert.equal(warnings.length, 0, "读错 receiver 会把有效方法判为缺失");
  assert.ok(seenThis.length >= 1);
  assert.equal(seenThis[0], base.runtime);
  assert.equal(Object.hasOwn(base.runtime, CONT), true, "必须安装 own wrapper");

  const agent = makeAgent();
  await base.runtime[CONT]({ provider: "spawn", request: { parent: agent } });
  assert.deepEqual(base.calls.at(-1).spec.request.agentOptions, { provider: "dp", model: "dm" });

  base.disposeAll();
  assert.equal(Object.hasOwn(base.runtime, CONT), false);
  assert.equal(typeof base.runtime[CONT], "function", "卸载后经原型 getter 仍取得到方法");
  const descriptor = Object.getOwnPropertyDescriptor(base.proto, CONT);
  assert.equal(typeof descriptor.get, "function");
  assert.equal(descriptor.configurable, true);

  const agent2 = makeAgent();
  await base.runtime[CONT]({ provider: "spawn", request: { parent: agent2 } });
  assert.equal(base.calls.at(-1).spec.request.agentOptions, undefined);
});
