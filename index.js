// member-model 1.0.0 — spawn route capability only.
//
// No personal model is shipped. Fresh spawn follows the parent unless
// arm_spawn_route armed a one-shot for that agent. The one-shot is consumed
// by the next fresh spawn, then parent-following returns.
// A failed fresh spawn restores the one-shot unless clear_spawn_route or a
// newer arm superseded it first; clear_spawn_route drops an unconsumed one-shot.
// A configured provider/model is applied only when inherit is false.
// Fork (any provider other than "spawn") is never retargeted.
//
// The only kernel coupling is the start/startContinuable wrapper below.
import z from "@deepseek-ai/schemastery";

const SPAWN = "spawn";

export const name = "member-model";
export const inject = ["subagents", "tools"];

export const Config = z.object({
  inherit: z.boolean().default(true).volatile().description("true = fresh spawn follows the parent unless a one-shot route is armed"),
  provider: z.string().default("").volatile().description("optional fresh-spawn provider, used only when inherit is false"),
  model: z.string().default("").volatile().description("optional fresh-spawn model, used only when inherit is false"),
  reasoningEffort: z.string().default("").volatile().description("optional reasoning effort; empty = leave unset (may inherit; not necessarily the provider default)"),
});

function read(field, fallback) {
  const value = field != null && typeof field.get === "function" ? field.get() : field;
  return value === undefined || value === null ? fallback : value;
}

function settings(config) {
  return {
    inherit: read(config.inherit, true) !== false,
    provider: String(read(config.provider, "")).trim(),
    model: String(read(config.model, "")).trim(),
    reasoningEffort: String(read(config.reasoningEffort, "")).trim(),
  };
}

function routeFrom(provider, model, reasoningEffort) {
  if (!provider || !model) return undefined;
  return {
    provider,
    model,
    ...(reasoningEffort ? { reasoningEffort } : {}),
  };
}

function defaultRoute(state) {
  if (state.inherit) return undefined;
  return routeFrom(state.provider, state.model, state.reasoningEffort);
}

function routeLabel(route) {
  return `${route.provider}/${route.model}${route.reasoningEffort ? ` · ${route.reasoningEffort}` : ""}`;
}

// Per-agent generation: every arm commit and every clear advances it, even
// when the slot is empty. A stale generation must never resurrect a route.
function epochOf(epochs, key) {
  const value = epochs.get(key);
  return typeof value === "number" ? value : 0;
}

function bumpEpoch(epochs, key) {
  const next = epochOf(epochs, key) + 1;
  epochs.set(key, next);
  return next;
}

function takePending(pending, key) {
  const entry = key === undefined ? undefined : pending.get(key);
  if (entry !== undefined) pending.delete(key);
  return entry;
}

function withRoute(request, route) {
  const { provider: _provider, model: _model, reasoningEffort: _effort, ...rest } = request?.agentOptions ?? {};
  return { ...request, agentOptions: { ...rest, ...route } };
}

function agentKey(agent) {
  const id = agent?.id ?? agent?.session?.header?.id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

async function preflight(ctx, route, signal) {
  const llm = ctx.get("llm");
  if (llm === undefined || typeof llm.resolveCallConfig !== "function") return;
  try {
    await llm.resolveCallConfig({ ...route }, signal);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`member-model: spawn route ${routeLabel(route)} is unavailable: ${reason}`);
  }
}

function jsonTool(name, description, parameters, schema, execute) {
  return {
    name,
    description,
    parameters,
    output: {
      schema,
      render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
    },
    execute,
  };
}

const ROUTE_SCHEMA = {
  type: "object",
  properties: {
    provider: { type: "string" },
    model: { type: "string" },
    reasoningEffort: { type: "string" },
  },
  required: ["provider", "model"],
  additionalProperties: false,
};

const VIEW_SCHEMA = {
  type: "object",
  properties: {
    inherit: { type: "boolean" },
    configured: ROUTE_SCHEMA,
    activeDefault: ROUTE_SCHEMA,
    pending: ROUTE_SCHEMA,
  },
  required: ["inherit", "configured"],
  additionalProperties: false,
};

function view(state, pending) {
  const configured = routeFrom(state.provider, state.model, state.reasoningEffort) ?? {
    provider: state.provider,
    model: state.model,
    ...(state.reasoningEffort ? { reasoningEffort: state.reasoningEffort } : {}),
  };
  const activeDefault = defaultRoute(state);
  return {
    inherit: state.inherit,
    configured,
    ...(activeDefault === undefined ? {} : { activeDefault }),
    ...(pending === undefined ? {} : { pending }),
  };
}

// Installation registry: a stable symbol on the runtime (plus a module-local
// WeakMap for non-extensible runtimes) records the active installation, so a
// later apply never stacks another layer — not even when a third-party wrapper
// hides ours from the top of the own/prototype chain.
const ROUTE_REGISTRY = Symbol.for("member-model.spawn-route-registry");
const ROUTE_INSTALLATIONS = new WeakMap();
const WRAPPED_KEYS = ["start", "startContinuable"];

// The method a call reaches right now, read through the real lookup with the
// runtime as receiver: an own wrapper wins over the prototype chain, and an
// accessor anywhere on that chain sees the same `this` a caller would see.
function effectiveMethod(runtime, key) {
  if (runtime === null || runtime === undefined) return { value: undefined, own: undefined };
  return { value: Reflect.get(runtime, key, runtime), own: Object.getOwnPropertyDescriptor(runtime, key) };
}

function readInstallation(runtime) {
  if (runtime === null || runtime === undefined) return undefined;
  const local = ROUTE_INSTALLATIONS.get(runtime);
  if (local !== undefined) {
    if (local.active !== false) return local;
    ROUTE_INSTALLATIONS.delete(runtime);
    return undefined;
  }
  const shared = runtime[ROUTE_REGISTRY];
  if (typeof shared !== "object" || shared === null || shared.active === false) return undefined;
  return shared;
}

function writeInstallation(runtime, record) {
  ROUTE_INSTALLATIONS.set(runtime, record);
  try {
    Object.defineProperty(runtime, ROUTE_REGISTRY, { value: record, configurable: true, writable: true, enumerable: false });
    return true;
  } catch {
    // A non-extensible runtime keeps the module-local record only: another copy
    // of this plugin cannot see this installation and may add a second layer.
    return false;
  }
}

function clearInstallation(runtime, record) {
  if (ROUTE_INSTALLATIONS.get(runtime) === record) ROUTE_INSTALLATIONS.delete(runtime);
  if (runtime[ROUTE_REGISTRY] === record) {
    try { delete runtime[ROUTE_REGISTRY]; } catch { /* leave the stale record */ }
  }
}

function restoreOwn(runtime, key, descriptor) {
  if (descriptor === undefined) delete runtime[key];
  else Object.defineProperty(runtime, key, descriptor);
}

function installOwn(runtime, key, value, saved) {
  if (saved !== undefined && saved.configurable === false) {
    // A non-configurable writable data property can still change value; any
    // other non-configurable shape cannot be wrapped and must fail loudly.
    if (!("value" in saved) || saved.writable !== true) {
      throw new TypeError(`member-model: cannot wrap non-configurable property "${key}"`);
    }
    Object.defineProperty(runtime, key, { ...saved, value });
    return;
  }
  Object.defineProperty(runtime, key, { value, configurable: true, writable: true, enumerable: false });
}

function installRouteOverride(ctx, state, pending, epochs) {
  const runtime = ctx.subagents;
  const captured = WRAPPED_KEYS.map((key) => ({ key, ...effectiveMethod(runtime, key) }));
  if (captured.some((entry) => typeof entry.value !== "function")) {
    ctx.logger.warn("member-model: no start/startContinuable to wrap; route override disabled");
    return;
  }
  const rawStart = captured[0].value;
  const rawStartContinuable = captured[1].value;

  const resolve = (parent) => {
    const key = agentKey(parent);
    const entry = takePending(pending, key);
    return { key, entry, route: entry?.route ?? defaultRoute(state()) };
  };
  const restore = (key, entry) => {
    if (key === undefined || entry === undefined) return;
    if (epochOf(epochs, key) !== entry.epoch) return;
    if (pending.has(key)) return;
    pending.set(key, entry);
  };

  let disabled = false;

  const start = async function architectEditorStart(providerName, request, ...rest) {
    if (disabled) return rawStart.call(this, providerName, request, ...rest);
    if (providerName !== SPAWN) return rawStart.call(this, providerName, request, ...rest);
    const chosen = resolve(request?.parent);
    if (chosen.route === undefined) return rawStart.call(this, providerName, request, ...rest);
    try {
      await preflight(ctx, chosen.route, request?.signal);
      // A dispose during preflight ends route handling here: pass the original
      // call through, apply nothing and touch no state.
      if (disabled) return rawStart.call(this, providerName, request, ...rest);
      ctx.logger.info(`member-model: spawn child (one-shot) → ${routeLabel(chosen.route)}${chosen.entry !== undefined ? " (armed)" : ""}`);
      return await rawStart.call(this, providerName, withRoute(request, chosen.route), ...rest);
    } catch (error) {
      if (!disabled) restore(chosen.key, chosen.entry);
      throw error;
    }
  };

  const startContinuable = async function architectEditorStartContinuable(spec, ...rest) {
    if (disabled) return rawStartContinuable.call(this, spec, ...rest);
    if (spec?.provider !== SPAWN) return rawStartContinuable.call(this, spec, ...rest);
    const chosen = resolve(spec.request?.parent);
    if (chosen.route === undefined) return rawStartContinuable.call(this, spec, ...rest);
    try {
      await preflight(ctx, chosen.route, spec?.signal);
      // A dispose during preflight ends route handling here: pass the original
      // call through, apply nothing and touch no state.
      if (disabled) return rawStartContinuable.call(this, spec, ...rest);
      ctx.logger.info(`member-model: spawn child (continuable) → ${routeLabel(chosen.route)}${chosen.entry !== undefined ? " (armed)" : ""}`);
      return await rawStartContinuable.call(this, { ...spec, request: withRoute(spec.request, chosen.route) }, ...rest);
    } catch (error) {
      if (!disabled) restore(chosen.key, chosen.entry);
      throw error;
    }
  };

  const wrappers = [
    { key: captured[0].key, wrapper: start, saved: captured[0].own },
    { key: captured[1].key, wrapper: startContinuable, saved: captured[1].own },
  ];

  const record = { active: true };
  const installed = [];
  try {
    for (const entry of wrappers) {
      installOwn(runtime, entry.key, entry.wrapper, entry.saved);
      installed.push(entry);
    }
  } catch (error) {
    for (const entry of installed.reverse()) restoreOwn(runtime, entry.key, entry.saved);
    throw error;
  }
  if (!writeInstallation(runtime, record)) {
    ctx.logger.warn("member-model: subagent runtime is not extensible; duplicate-apply detection is limited to this plugin copy");
  }

  const disposeOverride = () => {
    // Idempotent: a stale effect must never clean up a newer installation.
    if (!record.active) return;
    record.active = false;
    // Deactivate first: an in-flight preflight that settles after this must not
    // apply the old route or restore state, and any later wrapper chaining
    // through ours only sees a pure pass-through.
    disabled = true;
    clearInstallation(runtime, record);
    for (const { key, wrapper, saved } of wrappers) {
      const own = Object.getOwnPropertyDescriptor(runtime, key);
      if (own === undefined || own.value !== wrapper) continue;
      restoreOwn(runtime, key, saved);
    }
  };
  ctx.effect(() => disposeOverride, "member-model: spawn route override");
  return disposeOverride;
}

function installTools(ctx, state, pending, epochs) {
  // A failed registration must not leave a partial tool set behind.
  const disposers = [];
  const register = (tool) => {
    try {
      const dispose = ctx.tools.register(tool);
      disposers.push(dispose);
      return dispose;
    } catch (error) {
      while (disposers.length > 0) disposers.pop()();
      throw error;
    }
  };
  const caller = (exec, toolName) => {
    const agent = exec?.agent;
    const key = agentKey(agent);
    if (key === undefined) throw new Error(`${toolName} requires a calling agent`);
    return { agent, key };
  };

  register(jsonTool(
    "get_spawn_route",
    "Read this agent's armed one-shot spawn route, if any. inherit true, or an empty configured route, means fresh spawn follows the parent unless a one-shot is armed. Fork is never retargeted.",
    { type: "object", properties: {}, additionalProperties: false },
    VIEW_SCHEMA,
    async (_args, exec) => {
      const { key } = caller(exec, "get_spawn_route");
      return view(state(), pending.get(key)?.route);
    },
  ));

  register(jsonTool(
    "arm_spawn_route",
    "Arm a provider, model, and optional reasoning effort for the next fresh spawn started by this agent. It is consumed once; after that fresh spawn follows the parent again unless inherit is false and a route is configured. Arming again replaces the unused one-shot. Returns armed:false without changing anything when a concurrent clear_spawn_route or an overlapping arm that committed first superseded this call; call get_spawn_route to see the current state then. Fork is not affected.",
    {
      type: "object",
      properties: {
        provider: { type: "string", description: "Provider id for the next fresh spawn." },
        model: { type: "string", description: "Model id for the next fresh spawn." },
        reasoningEffort: { type: "string", description: "Reasoning effort. Omit or leave empty to leave it unset (it may inherit the parent effort; it is not necessarily the provider default)." },
      },
      required: ["provider", "model"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        armed: { type: "boolean" },
        route: ROUTE_SCHEMA,
      },
      required: ["armed", "route"],
      additionalProperties: false,
    },
    async (args, exec) => {
      const { key } = caller(exec, "arm_spawn_route");
      const provider = String(args?.provider ?? "").trim();
      const model = String(args?.model ?? "").trim();
      const reasoningEffort = String(args?.reasoningEffort ?? "").trim();
      const route = routeFrom(provider, model, reasoningEffort);
      if (route === undefined) throw new Error("arm_spawn_route requires a non-empty provider and model");
      const before = epochOf(epochs, key);
      await preflight(ctx, route, exec?.signal);
      if (epochOf(epochs, key) !== before) {
        ctx.logger.warn("member-model: arm superseded by a concurrent clear or arm; nothing armed");
        return { armed: false, route };
      }
      const epoch = bumpEpoch(epochs, key);
      pending.set(key, { route, epoch });
      ctx.logger.info(`member-model: armed next fresh spawn → ${routeLabel(route)}`);
      return { armed: true, route };
    },
  ));

  register(jsonTool(
    "clear_spawn_route",
    "Clear this agent's unconsumed one-shot spawn route. It removes only the one-shot override, so the next fresh spawn uses the configured default route when inherit is false, or follows the parent otherwise. Only the calling agent is affected; the configured default route is never changed and a spawn that already started is never cancelled. An arm_spawn_route still awaiting preflight when this clear runs will not commit afterwards, and a failed spawn that consumed the route cannot restore it. cleared:false means no unconsumed registration was visible, for example because a spawn already consumed it. Fork is not affected.",
    { type: "object", properties: {}, additionalProperties: false },
    {
      type: "object",
      properties: {
        cleared: { type: "boolean" },
        route: ROUTE_SCHEMA,
      },
      required: ["cleared"],
      additionalProperties: false,
    },
    async (_args, exec) => {
      const { key } = caller(exec, "clear_spawn_route");
      const route = pending.get(key)?.route;
      pending.delete(key);
      bumpEpoch(epochs, key);
      if (route === undefined) return { cleared: false };
      ctx.logger.info(`member-model: cleared pending spawn route → ${routeLabel(route)}`);
      return { cleared: true, route };
    },
  ));

  ctx.effect(() => () => {
    while (disposers.length > 0) disposers.pop()();
  }, "member-model: spawn route tools");
}

export function apply(ctx, config) {
  const state = () => settings(config);
  if (readInstallation(ctx.subagents) !== undefined) {
    ctx.logger.warn("member-model: spawn route override already installed on this subagent runtime; skipping duplicate apply");
    return;
  }
  const pending = new Map();
  const epochs = new Map();
  const disposeOverride = installRouteOverride(ctx, state, pending, epochs);
  try {
    installTools(ctx, state, pending, epochs);
  } catch (error) {
    if (typeof disposeOverride === "function") disposeOverride();
    throw error;
  }
  ctx.logger.info("member-model: host ready (default spawn route + one-shot arm/clear)");
}
