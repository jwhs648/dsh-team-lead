// member-model 0.4.2 — spawn route capability only.
//
// No personal model is shipped. Fresh spawn follows the parent unless
// arm_spawn_route armed a one-shot for that agent. The one-shot is consumed
// by the next fresh spawn, then parent-following returns.
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
  reasoningEffort: z.string().default("").volatile().description("optional reasoning effort; empty = provider default"),
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

function installRouteOverride(ctx, state, pending) {
  const runtime = ctx.subagents;
  const proto = Object.getPrototypeOf(runtime);
  const rawStart = proto?.start;
  const rawStartContinuable = proto?.startContinuable;
  if (typeof rawStart !== "function" || typeof rawStartContinuable !== "function") {
    ctx.logger.warn("member-model: no start/startContinuable to wrap; route override disabled");
    return;
  }

  const resolve = (parent) => {
    const key = agentKey(parent);
    const once = key === undefined ? undefined : pending.get(key);
    if (key !== undefined && once !== undefined) pending.delete(key);
    return { key, once, route: once ?? defaultRoute(state()) };
  };
  const restore = (key, once) => {
    if (key !== undefined && once !== undefined && !pending.has(key)) pending.set(key, once);
  };

  const start = async function architectEditorStart(providerName, request) {
    if (providerName !== SPAWN) return rawStart.call(this, providerName, request);
    const chosen = resolve(request?.parent);
    if (chosen.route === undefined) return rawStart.call(this, providerName, request);
    try {
      await preflight(ctx, chosen.route, request?.signal);
      ctx.logger.info(`member-model: spawn child (one-shot) → ${routeLabel(chosen.route)}${chosen.once ? " (armed)" : ""}`);
      return await rawStart.call(this, providerName, withRoute(request, chosen.route));
    } catch (error) {
      restore(chosen.key, chosen.once);
      throw error;
    }
  };

  const startContinuable = async function architectEditorStartContinuable(spec) {
    if (spec?.provider !== SPAWN) return rawStartContinuable.call(this, spec);
    const chosen = resolve(spec.request?.parent);
    if (chosen.route === undefined) return rawStartContinuable.call(this, spec);
    try {
      await preflight(ctx, chosen.route, spec?.signal);
      ctx.logger.info(`member-model: spawn child (continuable) → ${routeLabel(chosen.route)}${chosen.once ? " (armed)" : ""}`);
      return await rawStartContinuable.call(this, { ...spec, request: withRoute(spec.request, chosen.route) });
    } catch (error) {
      restore(chosen.key, chosen.once);
      throw error;
    }
  };

  const wrappers = [["start", start], ["startContinuable", startContinuable]];
  for (const [key, wrapper] of wrappers) {
    Object.defineProperty(runtime, key, { value: wrapper, configurable: true, writable: true, enumerable: false });
  }
  ctx.effect(() => () => {
    for (const [key, wrapper] of wrappers) {
      const own = Object.getOwnPropertyDescriptor(runtime, key);
      if (own !== undefined && own.value === wrapper) delete runtime[key];
    }
  }, "member-model: spawn route override");
}

function installTools(ctx, state, pending) {
  const caller = (exec, toolName) => {
    const agent = exec?.agent;
    const key = agentKey(agent);
    if (key === undefined) throw new Error(`${toolName} requires a calling agent`);
    return { agent, key };
  };

  const disposeGet = ctx.tools.register(jsonTool(
    "get_spawn_route",
    "Read this agent's armed one-shot spawn route, if any. inherit true, or an empty configured route, means fresh spawn follows the parent unless a one-shot is armed. Fork is never retargeted.",
    { type: "object", properties: {}, additionalProperties: false },
    VIEW_SCHEMA,
    async (_args, exec) => {
      const { key } = caller(exec, "get_spawn_route");
      return view(state(), pending.get(key));
    },
  ));

  const disposeArm = ctx.tools.register(jsonTool(
    "arm_spawn_route",
    "Arm a provider, model, and optional reasoning effort for the next fresh spawn started by this agent. It is consumed once; after that fresh spawn follows the parent again unless inherit is false and a route is configured. Arming again before that spawn replaces the unused one-shot. Fork is not affected.",
    {
      type: "object",
      properties: {
        provider: { type: "string", description: "Provider id for the next fresh spawn." },
        model: { type: "string", description: "Model id for the next fresh spawn." },
        reasoningEffort: { type: "string", description: "Reasoning effort. Omit or leave empty for the provider default." },
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
      await preflight(ctx, route, exec?.signal);
      pending.set(key, route);
      ctx.logger.info(`member-model: armed next fresh spawn → ${routeLabel(route)}`);
      return { armed: true, route };
    },
  ));

  ctx.effect(() => () => {
    disposeArm();
    disposeGet();
  }, "member-model: spawn route tools");
}

export function apply(ctx, config) {
  const state = () => settings(config);
  const pending = new Map();
  installRouteOverride(ctx, state, pending);
  installTools(ctx, state, pending);
  ctx.logger.info("member-model: host ready (default spawn route + one-shot arm)");
}
