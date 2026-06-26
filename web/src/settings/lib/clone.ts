/**
 * Deep-clone a plain value via JSON round-trip.
 * Returns {} for falsy input (matching legacy clonePlain behavior).
 */
export function clonePlain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value || {}));
}
