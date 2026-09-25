// tools/execute and tools/post-execute hooks around the lead's spawn_teammate
// call (kernel-check K07-K10, K20): the requireArm refusal, the one-shot claim
// store, restore on failure, and the "member-model: ..." result line checked
// against the live teammate.

import { randomUUID } from "node:crypto";
import { defaultRoute, routeLabel, entryLabel, text, observedRoute, observedLabel, sameRoute, pinnedMatch, plannedLabel, agentKey, depthOf, messageOf } from "./routes.js";

const ARM_REQUIRED = "member-model: arm a route before creating a fresh teammate. Call arm_spawn_route with the provider, model and reasoningEffort of the team-lead skill's default route (reload the team-lead skill if you no longer see it) or of a route the user approved, or arm_spawn_route({\"follow\":true}) to follow the lead; then call the teammate tool again. context \"fork\" needs no arm.";

function refusal(message) {
  return {
    isError: true,
    error: { message, info: { name: "MemberModelError", code: "MEMBER_MODEL_ARM_REQUIRED" } },
    content: [{ type: "text", text: `Error: ${message}` }],
  };
}

function tokenOf(exec) {
  return exec?.token ?? exec?.callId;
}

function teammateName(args) {
  return text(args?.name) ?? "teammate";
}

function contextMessage(note) {
  const summary = note.length <= 120 ? note : `${note.slice(0, 119)}…`;
  return Object.freeze({
    id: randomUUID(),
    role: "user",
    content: Object.freeze([Object.freeze({ type: "text", text: note })]),
    source: Object.freeze({ kind: "member-model", form: "notice", summary }),
  });
}

// Describe what the new teammate actually got, checked against its live options.
function successReport(ctx, exec, store, state) {
  const teammate = teammateName(exec?.arguments);
  const quoted = JSON.stringify(teammate);
  const child = store.childId === undefined ? undefined : ctx.get("agents")?.get?.(store.childId);
  const observed = child === undefined ? undefined : observedRoute(child.options);
  const applied = store.applied;
  const entry = store.entry;
  let source;
  let expected;
  if (entry !== undefined && applied === undefined) source = "not-applied";
  else if (entry?.follow) source = "follow";
  else if (entry?.route) {
    source = "armed";
    expected = entry.route;
  } else if (applied?.source === "default" || applied?.source === "explicit") {
    source = applied.source;
    expected = applied.route;
  } else source = "inherit";

  const lead = observedRoute(exec?.agent?.options);
  let verified = false;
  if (observed !== undefined && source !== "not-applied") {
    verified = expected === undefined ? sameRoute(lead, observed) : pinnedMatch(expected, observed);
  }
  const route = observed ?? expected;
  const last = {
    teammate,
    source,
    ...(route === undefined ? {} : { route: { ...route } }),
    verified,
  };

  const why = describeSource(source, state);
  const planned = expected === undefined ? `the lead's route ${observedLabel(lead)}` : plannedLabel(expected);
  let note;
  if (source === "not-applied") {
    note = `member-model: WARNING ${quoted} was created without the armed ${entryLabel(entry)}: no fresh spawn for this lead was seen inside the call${observed === undefined ? "" : `; the live teammate reports ${observedLabel(observed)}`}. Stop and tell the user.`;
  } else if (observed === undefined) {
    note = `member-model: ${quoted} → ${planned} (${why}; live teammate not found, unverified).`;
  } else if (!verified) {
    note = `member-model: WARNING ${quoted} should run ${planned} (${why}) but the live teammate reports ${observedLabel(observed)}. Stop and tell the user.`;
  } else {
    note = `member-model: ${quoted} → ${observedLabel(observed)} (${why}; verified on the live teammate).`;
  }
  return { note, last };
}

// The teammate exists; the plugin only failed to describe it. Keep the call a
// success and say the route is unchecked.
function unreportable(exec, store, error) {
  const teammate = teammateName(exec?.arguments);
  const entry = store.entry;
  const source = entry?.follow ? "follow" : entry?.route ? "armed" : "inherit";
  return {
    note: `member-model: WARNING ${JSON.stringify(teammate)} was created, but its route could not be checked: ${messageOf(error)}. Stop and tell the user.`,
    last: { teammate, source, ...(entry?.route ? { route: { ...entry.route } } : {}), verified: false },
  };
}

function describeSource(source, state) {
  switch (source) {
    case "armed": return "armed route";
    case "follow": return "armed follow, same as the lead";
    case "default": return "plugin default route";
    case "explicit": return "the request's own route";
    default: return state.requireArm ? "nothing armed, follows the lead" : "nothing armed, follows the lead; requireArm is off";
  }
}

function failureNote(entry, restored) {
  if (entry === undefined) return undefined;
  const label = entry.follow ? "armed follow" : `armed route ${routeLabel(entry.route)}`;
  return restored
    ? `member-model: creation failed; the ${label} stays armed for a retry. If you give up, change plans or switch to fork, call clear_spawn_route.`
    : `member-model: creation failed; the ${label} was cleared or replaced meanwhile and was not restored.`;
}

export function installTeammateHooks(ctx, state, book, life, teammateCall, track) {
  const onExecute = async (exec, next) => {
    const current = state();
    if (!life.active || exec?.name !== current.teammateTool) return next();
    const key = agentKey(exec.agent);
    if (key === undefined) return next();
    const context = exec.arguments?.context;
    if (context !== undefined && context !== "fresh") {
      // fork (or anything that is not a fresh spawn): never blocked, never consumed.
      const still = book.pending.get(key);
      const result = await next();
      if (life.active && still !== undefined && book.pending.get(key) === still && !result?.isError) {
        book.note(tokenOf(exec), `member-model: fork follows the lead; the ${entryLabel(still)} stays armed for the next fresh teammate (clear_spawn_route drops it).`);
      }
      return result;
    }
    const entry = book.take(key);
    if (entry === undefined && current.requireArm && depthOf(exec.agent) === 0 && defaultRoute(current) === undefined) {
      return refusal(ARM_REQUIRED);
    }
    const store = { key, entry, claimed: false, childId: undefined, applied: undefined };
    let result;
    try {
      result = await teammateCall.run(store, next);
    } catch (error) {
      if (life.active) book.restore(key, entry);
      throw error;
    }
    if (!life.active) return result;
    if (result?.isError) {
      const note = failureNote(entry, book.restore(key, entry));
      if (note !== undefined) book.note(tokenOf(exec), note);
      return result;
    }
    let report;
    try {
      report = successReport(ctx, exec, store, current);
    } catch (error) {
      // Never turn a teammate that was created into a failed call.
      report = unreportable(exec, store, error);
    }
    book.recordApplied(key, report.last);
    book.note(tokenOf(exec), report.note);
    if (report.last.source === "not-applied" || !report.last.verified) ctx.logger.warn(report.note);
    else ctx.logger.info(report.note);
    return result;
  };

  const onPostExecute = async (exec, result, next) => {
    const token = tokenOf(exec);
    const note = token === undefined ? undefined : book.notes.get(token);
    if (note !== undefined) book.notes.delete(token);
    // Errors from downstream listeners propagate unchanged; only this plugin's
    // own note handling is contained, so it can never turn a result into an error.
    const decision = await next();
    if (note === undefined || !life.active) return decision;
    try {
      const block = { type: "text", text: note };
      if (decision?.kind === "accept" && !Object.hasOwn(decision, "value")) {
        const content = decision.content ?? result?.content ?? [];
        return { ...decision, content: [...content, block] };
      }
      // Replaced value or blocked result: the note rides as a plugin context.
      return { ...decision, additionalContexts: [...(decision?.additionalContexts ?? []), contextMessage(note)] };
    } catch (error) {
      ctx.logger.warn(`member-model: could not attach the route note: ${messageOf(error)}`);
      return decision;
    }
  };

  track(ctx.on("tools/execute", onExecute));
  track(ctx.on("tools/post-execute", onPostExecute));
}
