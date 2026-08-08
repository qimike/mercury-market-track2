/**
 * Deterministic JSON stringification for content hashing (suggestion/action
 * hashes, CI finding fingerprints). Plain `JSON.stringify` is sensitive to key
 * insertion order, which would make two logically-identical objects hash
 * differently — this sorts object keys recursively so the hash is stable.
 */

export function canonicalStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const sorted: Record<string, unknown> = {};
    for (const [key, val] of entries) sorted[key] = sortKeys(val);
    return sorted;
  }
  return value;
}
