// Wraps subagents.start / startContinuable (kernel-check K03, K04) and hands a
// lead's armed entry to the fresh spawn its spawn_teammate call starts (K06).
// Also the installation registry that keeps a second apply from stacking a
// second layer, and the property-descriptor handling for wrapper compatibility.

import { SPAWN, defaultRoute, routeLabel, observedRoute, agentKey, explicitRoute, withRoute, preflight } from "./routes.js";

/**
 * @typedef {object} TeammateCallStore   AsyncLocalStorage store for one spawn_teammate call.
 * @property {string} key         the lead's agent id
 * @property {import("./book.js").Entry|undefined} entry   the entry taken for this call
 * @property {boolean} claimed    whether a fresh spawn inside the call took it
 * @property {string} [childId]   the child that took it
 * @property {{ source: string, route?: object }} [applied]   what that spawn applied
 */

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

export function readInstallation(runtime) {
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

export function installRouteOverride(ctx, state, life, teammateCall) {
  const runtime = ctx.subagents;
  const captured = WRAPPED_KEYS.map((key) => ({ key, ...effectiveMethod(runtime, key) }));
  if (captured.some((entry) => typeof entry.value !== "function")) {
    ctx.logger.warn("member-model: no start/startContinuable to wrap; route override disabled");
    return undefined;
  }
  const rawStart = captured[0].value;
  const rawStartContinuable = captured[1].value;

  // The fresh spawn a teammate call makes for its own lead takes that call's
  // entry, once. Everything else sees no entry.
  const claim = (spec) => {
    const store = teammateCall.getStore();
    if (store === undefined || store.claimed) return undefined;
    if (agentKey(spec?.request?.parent) !== store.key) return undefined;
    store.claimed = true;
    store.childId = typeof spec?.childId === "string" ? spec.childId : undefined;
    return store;
  };

  // One-shot start never consumes an armed entry: only the plugin default, and
  // only for a request that does not name its own provider/model.
  const start = async function memberModelStart(providerName, request, ...rest) {
    if (!life.active || providerName !== SPAWN) return rawStart.call(this, providerName, request, ...rest);
    const route = explicitRoute(request) ? undefined : defaultRoute(state());
    if (route === undefined) return rawStart.call(this, providerName, request, ...rest);
    await preflight(ctx, route, request?.signal);
    // A dispose during preflight ends route handling here: pass the original
    // call through and apply nothing.
    if (!life.active) return rawStart.call(this, providerName, request, ...rest);
    ctx.logger.info(`member-model: spawn child (one-shot) → ${routeLabel(route)} (plugin default)`);
    return rawStart.call(this, providerName, withRoute(request, route), ...rest);
  };

  const startContinuable = async function memberModelStartContinuable(spec, ...rest) {
    if (!life.active || spec?.provider !== SPAWN) return rawStartContinuable.call(this, spec, ...rest);
    const store = claim(spec);
    let route;
    let source;
    if (store?.entry?.follow) source = "follow";
    else if (store?.entry?.route) {
      route = store.entry.route;
      source = "armed";
    } else if (explicitRoute(spec.request)) source = "explicit";
    else {
      route = defaultRoute(state());
      source = route === undefined ? "inherit" : "default";
    }
    if (store !== undefined) {
      const planned = source === "explicit" ? observedRoute(spec.request?.agentOptions) : route;
      store.applied = { source, ...(planned === undefined ? {} : { route: planned }) };
    }
    if (route === undefined) return rawStartContinuable.call(this, spec, ...rest);
    await preflight(ctx, route, spec?.signal);
    // A dispose during preflight ends route handling here: pass the original
    // call through and apply nothing.
    if (!life.active) return rawStartContinuable.call(this, spec, ...rest);
    ctx.logger.info(`member-model: spawn child (continuable) → ${routeLabel(route)} (${source})`);
    return rawStartContinuable.call(this, { ...spec, request: withRoute(spec.request, route) }, ...rest);
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
    clearInstallation(runtime, record);
    for (const { key, wrapper, saved } of wrappers) {
      const own = Object.getOwnPropertyDescriptor(runtime, key);
      if (own === undefined || own.value !== wrapper) continue;
      restoreOwn(runtime, key, saved);
    }
  };
  return disposeOverride;
}
