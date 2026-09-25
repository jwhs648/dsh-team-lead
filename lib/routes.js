// Route helpers shared across the plugin: config reading, route labels and
// comparison, delegation depth (mirrors dsh-subagent delegationDepthOf,
// kernel-check K05), explicit-route detection and route preflight through
// llm.resolveCallConfig (K14).

export const SPAWN = "spawn";
export const DEFAULT_TEAMMATE_TOOL = "spawn_teammate";
export const ROUTE_TOOLS = Object.freeze(["get_spawn_route", "arm_spawn_route", "clear_spawn_route"]);

export function read(field, fallback) {
  const value = field != null && typeof field.get === "function" ? field.get() : field;
  return value === undefined || value === null ? fallback : value;
}

export function settings(config) {
  const source = config ?? {};
  return {
    inherit: read(source.inherit, true) !== false,
    provider: String(read(source.provider, "")).trim(),
    model: String(read(source.model, "")).trim(),
    reasoningEffort: String(read(source.reasoningEffort, "")).trim(),
    requireArm: read(source.requireArm, true) !== false,
    teammateTool: String(read(source.teammateTool, DEFAULT_TEAMMATE_TOOL)).trim() || DEFAULT_TEAMMATE_TOOL,
  };
}

export function routeFrom(provider, model, reasoningEffort) {
  if (!provider || !model) return undefined;
  return {
    provider,
    model,
    ...(reasoningEffort ? { reasoningEffort } : {}),
  };
}

export function defaultRoute(state) {
  if (state.inherit) return undefined;
  return routeFrom(state.provider, state.model, state.reasoningEffort);
}

export function routeLabel(route) {
  return `${route.provider}/${route.model}${route.reasoningEffort ? ` · ${route.reasoningEffort}` : ""}`;
}

export function entryLabel(entry) {
  return entry.follow ? "follow (the lead's route)" : routeLabel(entry.route);
}

export function text(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

// What a live agent will actually run with, read the same way the Agent Teams
// member view reads it (agent.options).
export function observedRoute(options) {
  const provider = text(options?.provider);
  const model = text(options?.model);
  const reasoningEffort = text(options?.reasoningEffort);
  return {
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
  };
}

export function observedLabel(route) {
  const base = route.provider && route.model ? `${route.provider}/${route.model}` : route.model ?? route.provider ?? "the profile default route";
  return `${base} · ${route.reasoningEffort ?? "effort unset"}`;
}

export function sameRoute(expected, observed) {
  return expected.provider === observed.provider
    && expected.model === observed.model
    && expected.reasoningEffort === observed.reasoningEffort;
}

// Only the fields a route pins must match: an armed route without
// reasoningEffort pins provider and model, a request may pin even less.
export function pinnedMatch(expected, observed) {
  return ["provider", "model", "reasoningEffort"].every((field) => expected[field] === undefined || expected[field] === observed[field]);
}

export function plannedLabel(route) {
  return route.provider && route.model ? routeLabel(route) : observedLabel(route);
}

export function agentKey(agent) {
  const id = agent?.id ?? agent?.session?.header?.id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

// Same rule as dsh-subagent delegationDepthOf: the persisted header is
// authoritative and runtime options may only deepen it. Zero = top level.
export function depthOf(agent) {
  const header = agent?.session?.header?.delegationDepth;
  const runtime = agent?.options?.subagentDepth;
  const fromHeader = Number.isSafeInteger(header) && header > 0 ? header : 0;
  const fromRuntime = Number.isSafeInteger(runtime) && runtime > 0 ? runtime : 0;
  return Math.max(fromHeader, fromRuntime);
}

export function explicitRoute(request) {
  const options = request?.agentOptions;
  return text(options?.provider) !== undefined || text(options?.model) !== undefined;
}

export function withRoute(request, route) {
  const { provider: _provider, model: _model, reasoningEffort: _effort, ...rest } = request?.agentOptions ?? {};
  return { ...request, agentOptions: { ...rest, ...route } };
}

export function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

export async function preflight(ctx, route, signal) {
  const llm = ctx.get("llm");
  if (llm === undefined || typeof llm.resolveCallConfig !== "function") return;
  try {
    await llm.resolveCallConfig({ ...route }, signal);
  } catch (error) {
    throw new Error(`member-model: spawn route ${routeLabel(route)} is unavailable: ${messageOf(error)}`);
  }
}
