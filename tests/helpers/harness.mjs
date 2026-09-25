// 隔离测试夹具：不启动真实模型、不读写宿主安装副本。
// 只按相对路径 import 仓库内的 ../../index.js，路径由 import.meta.url 推导，便于移植。
//
// 模拟的宿主行为（按 DSH 0.1.7-rc.1/rc.2 源码）：
// - 工具调用：tools/execute 包住工具本体；工具本体抛错会变成 isError 结果；
//   tools/execute 监听器自己抛错则直接成为最终错误、跳过 tools/post-execute。
// - tools/post-execute：accept 可替换 content 或附加 additionalContexts，block 改为错误结果。
// - spawn_teammate：只有队长调用；fresh 用 provider "spawn"，fork 用 "fork"；
//   通过 subagents.startContinuable({ childId, provider, label, request: { prompt, parent: 队长 } }) 创建。
// - 子 agent 的 options：继承父 agent，再叠加请求的 agentOptions；换了路由却没写强度时清掉强度；
//   subagentDepth = 父深度 + 1。创建成功后触发 agent/created。
import { apply } from "../../index.js";

export const DEFAULT_AGENT_ID = "lead";
export const TEAMMATE_TOOL = "spawn_teammate";
export const ROUTE_TOOLS = ["get_spawn_route", "arm_spawn_route", "clear_spawn_route"];

export function makeAgent(id = DEFAULT_AGENT_ID, extra = {}) {
  return { id, ...extra };
}

// 带 agent.ctx.tools.restrict 的 agent，用于可见性测试。restrictions 记录每次屏蔽及是否已解除。
export function makeScopedAgent(id, { depth = 0, headerDepth, options = {}, restrict } = {}) {
  const restrictions = [];
  const agent = {
    id,
    options: { ...options, ...(depth > 0 ? { subagentDepth: depth } : {}) },
    session: { header: { id, ...(headerDepth ?? depth ? { delegationDepth: headerDepth ?? depth } : {}) } },
    restrictions,
    ctx: {
      tools: {
        restrict: restrict ?? ((filter) => {
          const record = { filter, lifted: false };
          restrictions.push(record);
          return () => { record.lifted = true; };
        }),
      },
    },
  };
  return agent;
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
// 插件默认路由（inherit=false）对两者一致，故相关用例按此参数化。
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

function depthOf(agent) {
  const header = agent?.session?.header?.delegationDepth;
  const runtime = agent?.options?.subagentDepth;
  return Math.max(Number.isSafeInteger(header) ? header : 0, Number.isSafeInteger(runtime) ? runtime : 0);
}

// 按 rc.2 resolveChildAgentOptions 的规则算子 agent 的路由。
export function resolveChildOptions(parentOptions = {}, requested = {}) {
  const next = {};
  for (const field of ["provider", "model", "reasoningEffort"]) {
    if (parentOptions[field] !== undefined) next[field] = parentOptions[field];
  }
  let routeChanged = false;
  for (const field of ["provider", "model"]) {
    if (requested[field] === undefined) continue;
    if (requested[field] !== next[field]) routeChanged = true;
    next[field] = requested[field];
  }
  if (requested.reasoningEffort !== undefined) next.reasoningEffort = requested.reasoningEffort;
  else if (routeChanged) delete next.reasoningEffort;
  return next;
}

function toolErrorResult(error) {
  const message = error instanceof Error ? error.message : String(error);
  return { isError: true, error: { message }, content: [{ type: "text", text: `Error: ${message}` }] };
}

// 低层夹具：构造假 ctx 与假 runtime，但不 apply。
// 包装兼容性测试要自己控制安装/卸载时序与失败注入，故单独暴露。
export function createCtx(options = {}) {
  const {
    startImpl,
    continuableImpl,
    teammateImpl,
    childOptions = resolveChildOptions,
    registerChildren = true,
    teammateTool = TEAMMATE_TOOL,
    llm = { resolveCallConfig: async () => ({}) },
    agents: initialAgents = [],
    prepare,
  } = options;

  const calls = [];
  const registered = new Map();
  const effectDisposers = [];
  const listeners = new Map();
  const live = new Map(initialAgents.map((agent) => [agent.id, agent]));
  const warnings = [];
  const infos = [];
  let childSeq = 0;
  let callSeq = 0;

  const emit = async (name, payload) => {
    for (const listener of [...(listeners.get(name) ?? [])]) await listener(payload);
  };

  const materializeChild = async (spec) => {
    if (!registerChildren || typeof spec?.childId !== "string") return;
    const parent = spec.request?.parent;
    const depth = depthOf(parent) + 1;
    const child = makeScopedAgent(spec.childId, {
      depth,
      options: childOptions(parent?.options ?? {}, spec.request?.agentOptions ?? {}, parent),
    });
    child.session.header.parentSession = parent?.id;
    live.set(child.id, child);
    await emit("agent/created", { agent: child, source: { kind: "new" } });
  };

  const proto = {
    async start(provider, request, ...rest) {
      calls.push({ kind: "start", provider, request, receiver: this, args: [provider, request, ...rest] });
      if (typeof startImpl === "function") return startImpl.call(this, provider, request, ...rest);
      return { ok: true, provider, request };
    },
    async startContinuable(spec, ...rest) {
      calls.push({ kind: "startContinuable", spec, receiver: this, args: [spec, ...rest] });
      const value = typeof continuableImpl === "function"
        ? await continuableImpl.call(this, spec, ...rest)
        : { ok: true, spec };
      await materializeChild(spec);
      return value;
    },
  };

  const runtime = Object.create(proto);
  if (typeof prepare === "function") prepare(runtime, proto);

  const agentRegistry = {
    get: (id) => live.get(id),
    list: () => [...live.values()],
  };

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
    logger: { info: (message) => infos.push(message), warn: (message) => warnings.push(message) },
    get(name) {
      if (name === "llm") return llm;
      if (name === "agents") return agentRegistry;
      return undefined;
    },
    effect(fn) {
      const dispose = fn();
      if (typeof dispose === "function") effectDisposers.push(dispose);
      return dispose;
    },
    // 与 cordis 一致：返回的 dispose 幂等。
    on(name, listener) {
      const list = listeners.get(name) ?? [];
      list.push(listener);
      listeners.set(name, list);
      return () => {
        const current = listeners.get(name) ?? [];
        const index = current.indexOf(listener);
        if (index >= 0) current.splice(index, 1);
      };
    },
  };

  const waterfall = (name, args, final) => {
    const list = [...(listeners.get(name) ?? [])];
    const run = (index) => (index < list.length
      ? Promise.resolve().then(() => list[index](...args, () => run(index + 1)))
      : Promise.resolve().then(final));
    return run(0);
  };

  // 默认的 spawn_teammate 本体：按 Agent Teams 的实际调用形状创建成员。
  const teammateBody = async (args, exec) => {
    if (typeof teammateImpl === "function") return teammateImpl(args, exec, { runtime, live });
    const context = args?.context ?? "fresh";
    childSeq += 1;
    const childId = `child-${childSeq}`;
    await runtime.startContinuable({
      childId,
      provider: context === "fork" ? "fork" : "spawn",
      label: args?.description ?? "",
      request: { prompt: [{ type: "text", text: args?.prompt ?? "" }], parent: exec.agent },
      signal: exec.signal,
    });
    const model = live.get(childId)?.options?.model;
    return { member: { id: childId, name: args?.name, context, ...(model === undefined ? {} : { model }) } };
  };

  // 模拟工具注册表的一次完整调用：tools/execute → 工具本体 → tools/post-execute。
  const dispatch = async (name, args = {}, agent = makeAgent(), extra = {}) => {
    callSeq += 1;
    const exec = {
      callId: `call-${callSeq}`,
      rootCallId: `call-${callSeq}`,
      token: Symbol(`exec-${callSeq}`),
      name,
      arguments: args,
      agent,
      signal: extra.signal ?? new AbortController().signal,
      // run_code 里的子调用：宿主给它带上 parent（run_code 那次执行的 token）。
      ...(extra.parent !== undefined ? { parent: extra.parent } : {}),
    };
    const body = async () => {
      try {
        let value;
        if (name === teammateTool) value = await teammateBody(args, exec);
        else {
          const tool = registered.get(name);
          if (tool === undefined) throw new Error(`UNKNOWN_TOOL ${name}`);
          value = await tool.execute(args, exec);
        }
        return { isError: false, value, content: [{ type: "text", text: JSON.stringify(value) }] };
      } catch (error) {
        return toolErrorResult(error);
      }
    };
    let result;
    try {
      result = await waterfall("tools/execute", [exec], body);
    } catch (error) {
      return { ...toolErrorResult(error), final: true };
    }
    const decision = await waterfall("tools/post-execute", [exec, result], () => ({ kind: "accept" }));
    const contexts = [...(result.additionalContexts ?? []), ...(decision.additionalContexts ?? [])];
    if (decision.kind === "block") {
      return {
        isError: true,
        error: { message: decision.feedback.map((block) => block.text).join("\n") },
        content: decision.feedback,
        ...(contexts.length > 0 ? { additionalContexts: contexts } : {}),
      };
    }
    return {
      ...result,
      ...(decision.content !== undefined ? { content: decision.content } : {}),
      ...(contexts.length > 0 ? { additionalContexts: contexts } : {}),
    };
  };

  return {
    ctx,
    runtime,
    proto,
    calls,
    registered,
    effectDisposers,
    listeners,
    live,
    warnings,
    infos,
    emit,
    dispatch,
    listenerCount: (name) => (listeners.get(name) ?? []).length,
    // 只跑 ctx.effect 收集到的 disposer，模拟真实卸载路径。
    disposeAll() {
      while (effectDisposers.length > 0) effectDisposers.pop()();
    },
  };
}

// 结果里 member-model 附加的那一行（没有则 undefined）。
export function noteOf(result) {
  const blocks = (result?.content ?? []).filter((block) => block?.type === "text" && block.text.startsWith("member-model:"));
  return blocks.at(-1)?.text;
}

// 构造假 ctx + 假 subagents runtime，并立即 apply。每次调用都是全新实例。
export function createHarness(options = {}) {
  const { config = { inherit: true } } = options;
  const base = createCtx(options);
  apply(base.ctx, config);
  let mateSeq = 0;

  const call = (name, args = {}, agent = makeAgent()) => {
    const tool = base.registered.get(name);
    if (tool === undefined) throw new Error("未注册的工具：" + name);
    return tool.execute(args, { agent });
  };

  const teammateCalls = () => base.calls.filter((entry) => entry.kind === "startContinuable");

  return {
    ...base,
    config,
    call,
    arm: (args, agent) => call("arm_spawn_route", args, agent),
    get: (agent) => call("get_spawn_route", {}, agent),
    pending: async (agent) => (await call("get_spawn_route", {}, agent)).pending,
    clear: (agent) => call("clear_spawn_route", {}, agent),
    start: (provider, request) => base.runtime.start(provider, request),
    spawn: (request = {}, agent = makeAgent()) => base.runtime.start("spawn", { parent: agent, ...request }),
    startContinuable: (spec) => base.runtime.startContinuable(spec),
    // 队长调用一次 spawn_teammate（经 tools/execute 与 tools/post-execute）。
    spawnTeammate: (args = {}, agent = makeAgent(), extra = {}) => {
      mateSeq += 1;
      return base.dispatch(options.teammateTool ?? TEAMMATE_TOOL, { name: `mate-${mateSeq}`, description: "d", prompt: "p", ...args }, agent, extra);
    },
    // 最近一次 startContinuable 收到的 agentOptions。
    lastTeammateOptions: () => teammateCalls().at(-1)?.spec?.request?.agentOptions,
    teammateCalls,
    applied: (entry, index = -1) => {
      const entryCall = base.calls.at(index);
      if (entryCall === undefined) throw new Error("rawStart 未被调用");
      return entry === "start" ? entryCall.request : entryCall.spec.request;
    },
  };
}
