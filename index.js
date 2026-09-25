// member-model 1.2.0 — teammate route capability for the team-lead skill.
//
// No personal model is shipped. The lead arms a one-shot route (provider,
// model, reasoningEffort) or follow:true with arm_spawn_route. Only the lead's
// next fresh teammate call (spawn_teammate by default) takes it: a
// tools/execute wrapper hands the entry to that one call through
// AsyncLocalStorage, and only the fresh spawn started inside that call for
// that lead applies it. Workflow children, background subagents and any other
// start never consume it, and a request that names its own provider/model is
// never rewritten by the plugin default.
//
// requireArm (default true) rejects a top-level lead's fresh teammate call
// when nothing is armed and no plugin default applies, so a forgotten arm
// cannot silently inherit the lead's model. Fork is never blocked or consumed.
// A successful call gets one "member-model: ..." line naming the route the
// live teammate actually has, and get_spawn_route lists the routes the lead's
// last 16 teammates got (applied, in memory only). A failed call restores its
// entry unless clear_spawn_route or a newer arm superseded it first.
// A configured provider/model is applied only when inherit is false.
// The three route tools are hidden from child agents (delegation depth > 0).
//
// Kernel coupling: subagents.start/startContinuable wrappers, the
// tools/execute and tools/post-execute waterfalls, agent/created and
// agent/disposed, and agent.ctx.tools.restrict. scripts/kernel-check.mjs
// re-checks these against a new DSH version.
//
// Layout (each module names the kernel-check items it depends on):
//   lib/routes.js      route helpers, depth, preflight            K05, K14
//   lib/book.js        pending arms, generations, applied, notes
//   lib/override.js    start/startContinuable wrappers, claim     K03, K04, K06
//   lib/tools.js       get/arm/clear_spawn_route
//   lib/teammate.js    spawn_teammate hooks and result line       K07-K10, K20
//   lib/visibility.js  hide route tools from children, cleanup    K11-K13

import { AsyncLocalStorage } from "node:async_hooks";
import z from "@deepseek-ai/schemastery";
import { DEFAULT_TEAMMATE_TOOL, settings } from "./lib/routes.js";
import { createBook } from "./lib/book.js";
import { installRouteOverride, readInstallation } from "./lib/override.js";
import { installTools } from "./lib/tools.js";
import { installTeammateHooks } from "./lib/teammate.js";
import { installLifecycle, installVisibility } from "./lib/visibility.js";

export const name = "member-model";
export const inject = ["subagents", "tools"];

export const Config = z.object({
  inherit: z.boolean().default(true).volatile().description("true = without an armed route a fresh spawn follows its parent; false = use the provider/model below as the plugin default"),
  provider: z.string().default("").volatile().description("optional plugin default provider, used only when inherit is false"),
  model: z.string().default("").volatile().description("optional plugin default model, used only when inherit is false"),
  reasoningEffort: z.string().default("").volatile().description("optional plugin default reasoning effort; empty = leave unset (may inherit; not necessarily the provider default)"),
  requireArm: z.boolean().default(true).volatile().description("true = a top-level lead's fresh teammate needs arm_spawn_route first (a route or follow:true) unless a plugin default applies"),
  teammateTool: z.string().default(DEFAULT_TEAMMATE_TOOL).volatile().description("name of the tool that creates teammates"),
});

export function apply(ctx, config) {
  const state = () => settings(config);
  if (readInstallation(ctx.subagents) !== undefined) {
    ctx.logger.warn("member-model: spawn route override already installed on this subagent runtime; skipping duplicate apply");
    return;
  }
  if (typeof ctx.on !== "function") throw new TypeError("member-model: the host event bus (ctx.on) is required");

  const life = { active: true };
  const book = createBook();
  const teammateCall = new AsyncLocalStorage();
  const cleanups = [];
  const cleanup = () => {
    // Deactivate first: an in-flight preflight or teammate call that settles
    // after this must not apply the old route or touch state, and any later
    // wrapper chaining through ours only sees a pure pass-through.
    life.active = false;
    while (cleanups.length > 0) {
      const dispose = cleanups.pop();
      if (typeof dispose === "function") dispose();
    }
  };

  // Every registration is tracked the moment it succeeds, so a failure part
  // way through rolls back exactly what was installed.
  const track = (dispose) => { cleanups.push(dispose); };
  try {
    const disposeOverride = installRouteOverride(ctx, state, life, teammateCall);
    if (disposeOverride !== undefined) track(disposeOverride);
    track(installTools(ctx, state, book));
    installTeammateHooks(ctx, state, book, life, teammateCall, track);
    installVisibility(ctx, life, track);
    installLifecycle(ctx, book, track);
  } catch (error) {
    cleanup();
    throw error;
  }

  let disposed = false;
  ctx.effect(() => () => {
    // Idempotent: a stale effect must never clean up a newer installation.
    if (disposed) return;
    disposed = true;
    cleanup();
  }, "member-model: teammate routes");
  ctx.logger.info("member-model: host ready (teammate routes: arm/follow/clear, requireArm, route report)");
}
