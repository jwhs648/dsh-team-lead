// Hides the route tools from child agents through agent.ctx.tools.restrict
// (kernel-check K11-K13) and forgets a lead's state on agent/disposed (K12).

import { ROUTE_TOOLS, agentKey, depthOf, messageOf } from "./routes.js";

// Child agents (delegation depth > 0) never manage teammate routes: hide the
// three tools from them so they neither see nor call them.
export function installVisibility(ctx, life, track) {
  const lifts = new Map();
  const hide = (agent) => {
    if (!life.active || agent === null || typeof agent !== "object" || lifts.has(agent)) return;
    if (depthOf(agent) === 0) return;
    const tools = agent.ctx?.tools;
    if (typeof tools?.restrict !== "function") return;
    try {
      const lift = tools.restrict({ deny: [...ROUTE_TOOLS] });
      lifts.set(agent, typeof lift === "function" ? lift : () => {});
    } catch (error) {
      ctx.logger.warn(`member-model: could not hide route tools from child agent ${agentKey(agent) ?? "(unknown)"}: ${messageOf(error)}`);
    }
  };
  track(() => {
    for (const lift of lifts.values()) {
      try { lift(); } catch { /* the agent scope may already be gone */ }
    }
    lifts.clear();
  });
  track(ctx.on("agent/created", (payload) => {
    // agent/created is serial and a throw would fail the creation.
    try { hide(payload?.agent); } catch { /* never block agent creation */ }
  }));
  track(ctx.on("agent/disposed", (payload) => {
    // The agent scope already unwound its registrations.
    lifts.delete(payload?.agent);
  }));
  try {
    for (const agent of ctx.get("agents")?.list?.() ?? []) hide(agent);
  } catch (error) {
    ctx.logger.warn(`member-model: could not scan existing agents: ${messageOf(error)}`);
  }
}

export function installLifecycle(ctx, book, track) {
  track(ctx.on("agent/disposed", (payload) => {
    const key = agentKey(payload?.agent);
    if (key !== undefined) book.forget(key);
  }));
}
