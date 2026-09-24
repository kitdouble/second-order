// Content hash of a spec. The hash *is* the version: approvals, bundles and
// data all point at a hash, so an edited spec can never inherit an approval.

/** JSON with sorted keys, so the same spec always hashes the same. */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .filter((k) => value[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export async function hashSpec(spec) {
  const data = new TextEncoder().encode(canonicalJson(spec));
  const buf = await globalThis.crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Short form used in URLs and the UI. */
export const shortHash = (h) => h.slice(0, 12);
