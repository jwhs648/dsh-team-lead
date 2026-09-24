// 隔离测试夹具：不启动真实模型、不读写宿主安装副本。
// 只按相对路径 import 仓库内的 ../../index.js，路径由 import.meta.url 推导，便于移植。
import { apply } from "../../index.js";

export const DEFAULT_AGENT_ID = "lead";

export function makeAgent(id = DEFAULT_AGENT_ID) {
  return { id };
}

export function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

export function failingStart(message = "spawn failed") {
  return () => { throw new Error(message); };
}

export function abortError(message = "aborted") {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

// 两种 fresh spawn 入口：runtime.start 与 runtime.startContinuable。
// clear / 失败恢复 / arm 竞态的行为必须对两者一致，故相关用例按此参数化。
export const ENTRY_POINTS = ["start", "startContinuable"];

// 可手动放行的 preflight 闸门，用于制造 arm 与 clear / 另一次 arm 的竞态。
export function gatedLlm() {
  const gates = [];
  return {
    gates,
    llm: {
      resolveCallConfig() {
        const gate = deferred();
        gates.push(gate);
        return gate.promise;
      },
    },
  };
}

// 第一次进入 rawStart 时放行 entered barrier 并挂起，后续调用直接成功。
// 用于在不 sleep 的前提下确定「已进入 rawStart 的 in-flight 窗口」。
export function oncePendingStart() {
  const entered = deferred();
  const gate = deferred();
  let count = 0;
  const impl = () => {
    count += 1;
    if (count === 1) {
      entered.resolve();
      return gate.promise;
    }
    return { ok: true };
  };
  return { impl, entered, gate, starts: () => count };
}

// 低层夹具：构造假 ctx 与假 runtime，但不 apply。
// 包装兼容性测试要自己控制安装/卸载时序与失败注入，故单独暴露。
export function createCtx(options = {}) {
  const {
    startImpl,
    continuableImpl,
    llm = { resolveCallConfig: async () => ({}) },
    prepare,
  } = options;

  const calls = [];
  const registered = new Map();
  const effectDisposers = [];

  const proto = {
    async start(provider, request, ...rest) {
      calls.push({ kind: "start", provider, request, receiver: this, args: [provider, request, ...rest] });
      if (typeof startImpl === "function") return startImpl.call(this, provider, request, ...rest);
      return { ok: true, provider, request };
    },
    async startContinuable(spec, ...rest) {
      calls.push({ kind: "startContinuable", spec, receiver: this, args: [spec, ...rest] });
      if (typeof continuableImpl === "function") return continuableImpl.call(this, spec, ...rest);
      return { ok: true, spec };
    },
  };

  const runtime = Object.create(proto);
  if (typeof prepare === "function") prepare(runtime, proto);

  const ctx = {
    subagents: runtime,
    tools: {
      // 只登记。卸载必须由插件在自己的 ctx.effect 里调用这里返回的 dispose；
      // 夹具不代劳，否则会掩盖插件漏注销工具的缺陷。
      // dispose 只移除它自己登记的那一次，同名重注册后陈旧 dispose 不会误删新登记。
      register(tool) {
        registered.set(tool.name, tool);
        return () => {
          if (registered.get(tool.name) === tool) registered.delete(tool.name);
        };
      },
    },
    logger: { info() {}, warn() {} },
    get(name) {
      return name === "llm" ? llm : undefined;
    },
    effect(fn) {
      const dispose = fn();
      if (typeof dispose === "function") effectDisposers.push(dispose);
      return dispose;
    },
  };

  return {
    ctx,
    runtime,
    proto,
    calls,
    registered,
    effectDisposers,
    // 只跑 ctx.effect 收集到的 disposer，模拟真实卸载路径。
    disposeAll() {
      while (effectDisposers.length > 0) effectDisposers.pop()();
    },
  };
}

// 构造假 ctx + 假 subagents runtime，并立即 apply。每次调用都是全新实例。
export function createHarness(options = {}) {
  const { config = { inherit: true } } = options;
  const base = createCtx(options);
  apply(base.ctx, config);

  const call = (name, args = {}, agent = makeAgent()) => {
    const tool = base.registered.get(name);
    if (tool === undefined) throw new Error("未注册的工具：" + name);
    return tool.execute(args, { agent });
  };

  return {
    ...base,
    config,
    call,
    arm: (args, agent) => call("arm_spawn_route", args, agent),
    get: (agent) => call("get_spawn_route", {}, agent),
    pending: async (agent) => (await call("get_spawn_route", {}, agent)).pending,
    start: (provider, request) => base.runtime.start(provider, request),
    spawn: (request = {}, agent = makeAgent()) => base.runtime.start("spawn", { parent: agent, ...request }),
    startContinuable: (spec) => base.runtime.startContinuable(spec),
    clear: (agent) => call("clear_spawn_route", {}, agent),
    spawnEntry: (entry, { agent = makeAgent(), request = {} } = {}) => {
      if (entry === "start") return base.runtime.start("spawn", { parent: agent, ...request });
      return base.runtime.startContinuable({ provider: "spawn", request: { parent: agent, ...request } });
    },
    applied: (entry, index = -1) => {
      const entryCall = base.calls.at(index);
      if (entryCall === undefined) throw new Error("rawStart 未被调用");
      return entry === "start" ? entryCall.request : entryCall.spec.request;
    },
  };
}
