/**
 * Fail-closed lookup helpers.
 *
 * `tsconfig` sets `noUncheckedIndexedAccess`, so every map lookup is typed
 * `T | undefined`. That is deliberate: tenant resolution must refuse rather
 * than default when an agent id is absent or unknown, and the type system
 * should make the refusal path impossible to forget rather than merely
 * conventional.
 *
 * These helpers exist so "I could not resolve this" is always an explicit,
 * typed outcome instead of `undefined` leaking onward as a usable value.
 */

/** A lookup that either resolved to a value or did not, with a reason. */
export type Resolution<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: string };

export function resolved<T>(value: T): Resolution<T> {
  return { ok: true, value };
}

export function unresolved<T>(reason: string): Resolution<T> {
  return { ok: false, reason };
}

/**
 * Look a key up in a record, returning an explicit unresolved result rather
 * than `undefined`. `what` names the thing being resolved so the failure
 * reason is useful in an escalation payload.
 */
export function lookup<T>(
  map: Readonly<Record<string, T>>,
  key: string | undefined,
  what: string,
): Resolution<T> {
  if (key === undefined || key === "") {
    return unresolved(`${what}: no key provided`);
  }
  // Own-property check: a prototype key like "constructor" must not resolve.
  if (!Object.prototype.hasOwnProperty.call(map, key)) {
    return unresolved(`${what}: no entry for ${JSON.stringify(key)}`);
  }
  const value = map[key];
  if (value === undefined) {
    return unresolved(`${what}: entry for ${JSON.stringify(key)} is undefined`);
  }
  return resolved(value);
}
