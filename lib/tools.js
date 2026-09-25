// The three route tools (get_spawn_route, arm_spawn_route, clear_spawn_route)
// and their schemas. Registered as one set: a failed registration rolls back.

import { routeFrom, defaultRoute, routeLabel, entryLabel, agentKey, preflight } from "./routes.js";

function jsonTool(toolName, description, parameters, schema, execute) {
  return {
    name: toolName,
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

// A live route may lack provider/model when it runs on the profile default.
const OBSERVED_ROUTE_SCHEMA = {
  type: "object",
  properties: {
    provider: { type: "string" },
    model: { type: "string" },
    reasoningEffort: { type: "string" },
  },
  additionalProperties: false,
};

// Either { follow: true } or a route.
const PENDING_SCHEMA = {
  type: "object",
  properties: {
    follow: { type: "boolean" },
    provider: { type: "string" },
    model: { type: "string" },
    reasoningEffort: { type: "string" },
  },
  additionalProperties: false,
};

const SOURCES = ["armed", "follow", "default", "explicit", "inherit", "not-applied"];

const APPLIED_ENTRY_SCHEMA = {
  type: "object",
  properties: {
    teammate: { type: "string" },
    source: { type: "string", enum: SOURCES },
    route: OBSERVED_ROUTE_SCHEMA,
    verified: { type: "boolean" },
  },
  required: ["teammate", "source", "verified"],
  additionalProperties: false,
};

const VIEW_SCHEMA = {
  type: "object",
  properties: {
    inherit: { type: "boolean" },
    requireArm: { type: "boolean" },
    configured: ROUTE_SCHEMA,
    activeDefault: ROUTE_SCHEMA,
    pending: PENDING_SCHEMA,
    applied: { type: "array", items: APPLIED_ENTRY_SCHEMA },
  },
  required: ["inherit", "requireArm", "configured"],
  additionalProperties: false,
};

function pendingView(entry) {
  return entry.follow ? { follow: true } : { ...entry.route };
}

function view(state, entry, applied = []) {
  const configured = routeFrom(state.provider, state.model, state.reasoningEffort) ?? {
    provider: state.provider,
    model: state.model,
    ...(state.reasoningEffort ? { reasoningEffort: state.reasoningEffort } : {}),
  };
  const activeDefault = defaultRoute(state);
  return {
    inherit: state.inherit,
    requireArm: state.requireArm,
    configured,
    ...(activeDefault === undefined ? {} : { activeDefault }),
    ...(entry === undefined ? {} : { pending: pendingView(entry) }),
    ...(applied.length === 0 ? {} : { applied: structuredClone(applied) }),
  };
}

export function installTools(ctx, state, book) {
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
    "Show what this lead's next fresh teammate will use (the armed route or follow, the plugin default) and applied: the routes its last 16 teammates actually got, oldest first, kept in memory until restart. Use applied for the final report.",
    { type: "object", properties: {}, additionalProperties: false },
    VIEW_SCHEMA,
    async (_args, exec) => {
      const { key } = caller(exec, "get_spawn_route");
      return view(state(), book.pending.get(key), book.applied.get(key));
    },
  ));

  register(jsonTool(
    "arm_spawn_route",
    "Arm the route for this lead's next fresh spawn_teammate: provider + model + reasoningEffort, or follow:true to follow the lead. Call it right before each fresh spawn_teammate; arm→spawn pairs may share one step, but never arm twice before a spawn (the second replaces the first). Fork needs no arm. armed:false means a concurrent clear or arm won; check get_spawn_route.",
    {
      type: "object",
      properties: {
        provider: { type: "string", description: "Provider id." },
        model: { type: "string", description: "Model id." },
        reasoningEffort: { type: "string", description: "Reasoning effort. Pass the approved value; if omitted, the host keeps the lead's effort only when provider and model match the lead's, otherwise leaves it unset." },
        follow: { type: "boolean", description: "true = the next fresh teammate follows the lead's route. Do not combine with provider/model." },
      },
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        armed: { type: "boolean" },
        follow: { type: "boolean" },
        route: ROUTE_SCHEMA,
      },
      required: ["armed"],
      additionalProperties: false,
    },
    async (args, exec) => {
      const { key } = caller(exec, "arm_spawn_route");
      const provider = String(args?.provider ?? "").trim();
      const model = String(args?.model ?? "").trim();
      const reasoningEffort = String(args?.reasoningEffort ?? "").trim();
      if (args?.follow === true) {
        if (provider || model || reasoningEffort) throw new Error("arm_spawn_route: follow:true cannot be combined with provider, model or reasoningEffort");
        const epoch = book.bump(key);
        book.pending.set(key, { follow: true, epoch });
        ctx.logger.info("member-model: armed next fresh teammate → follow the lead");
        return { armed: true, follow: true };
      }
      const route = routeFrom(provider, model, reasoningEffort);
      if (route === undefined) throw new Error("arm_spawn_route requires a non-empty provider and model, or follow:true");
      const before = book.epochOf(key);
      await preflight(ctx, route, exec?.signal);
      if (book.epochOf(key) !== before) {
        ctx.logger.warn("member-model: arm superseded by a concurrent clear or arm; nothing armed");
        return { armed: false, route };
      }
      const epoch = book.bump(key);
      book.pending.set(key, { route, epoch });
      ctx.logger.info(`member-model: armed next fresh teammate → ${routeLabel(route)}`);
      return { armed: true, route };
    },
  ));

  register(jsonTool(
    "clear_spawn_route",
    "Drop this lead's unused armed route or follow. Never cancels a creation in progress and never changes the plugin default.",
    { type: "object", properties: {}, additionalProperties: false },
    {
      type: "object",
      properties: {
        cleared: { type: "boolean" },
        follow: { type: "boolean" },
        route: ROUTE_SCHEMA,
      },
      required: ["cleared"],
      additionalProperties: false,
    },
    async (_args, exec) => {
      const { key } = caller(exec, "clear_spawn_route");
      const entry = book.pending.get(key);
      book.pending.delete(key);
      book.bump(key);
      if (entry === undefined) return { cleared: false };
      ctx.logger.info(`member-model: cleared armed teammate route → ${entryLabel(entry)}`);
      return entry.follow ? { cleared: true, follow: true } : { cleared: true, route: entry.route };
    },
  ));

  return () => {
    while (disposers.length > 0) disposers.pop()();
  };
}
