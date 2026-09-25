// Per-installation bookkeeping: pending arms, generations, the applied history
// per lead and the result notes waiting for tools/post-execute.

/**
 * @typedef {object} Route
 * @property {string} provider
 * @property {string} model
 * @property {string} [reasoningEffort]
 *
 * @typedef {object} Entry   One lead's armed route or follow, stamped with its generation.
 * @property {Route} [route]
 * @property {true} [follow]
 * @property {number} epoch
 *
 * @typedef {object} AppliedEntry   What one teammate actually got.
 * @property {string} teammate
 * @property {"armed"|"follow"|"default"|"explicit"|"inherit"|"not-applied"} source
 * @property {Partial<Route>} [route]
 * @property {boolean} verified
 */

const NOTE_LIMIT = 64;
// Per lead, the routes its most recent teammates actually got (oldest first).
const APPLIED_LIMIT = 16;

// Per-installation bookkeeping. Every arm commit and every clear advances the
// agent's generation, even when the slot is empty; generations come from one
// counter, so a stale entry never matches again even after the agent's
// generation was dropped on agent/disposed.
export function createBook() {
  let generation = 0;
  const book = {
    pending: new Map(),
    epochs: new Map(),
    applied: new Map(),
    notes: new Map(),
    epochOf(key) {
      const value = book.epochs.get(key);
      return typeof value === "number" ? value : 0;
    },
    bump(key) {
      generation += 1;
      book.epochs.set(key, generation);
      return generation;
    },
    take(key) {
      const entry = key === undefined ? undefined : book.pending.get(key);
      if (entry !== undefined) book.pending.delete(key);
      return entry;
    },
    restore(key, entry) {
      if (key === undefined || entry === undefined) return false;
      if (book.epochOf(key) !== entry.epoch) return false;
      if (book.pending.has(key)) return false;
      book.pending.set(key, entry);
      return true;
    },
    note(token, value) {
      if (token === undefined) return;
      book.notes.delete(token);
      book.notes.set(token, value);
      while (book.notes.size > NOTE_LIMIT) book.notes.delete(book.notes.keys().next().value);
    },
    recordApplied(key, last) {
      const list = book.applied.get(key) ?? [];
      list.push(last);
      while (list.length > APPLIED_LIMIT) list.shift();
      book.applied.set(key, list);
    },
    forget(key) {
      book.pending.delete(key);
      book.epochs.delete(key);
      book.applied.delete(key);
    },
  };
  return book;
}
