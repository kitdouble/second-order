// Public base URL. Behind Firebase Hosting the original host arrives in
// forwarding headers; PUBLIC_URL overrides everything if set.
export function baseUrlFrom(headersLike) {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/$/, "");
  const get = (k) => (typeof headersLike.get === "function" ? headersLike.get(k) : headersLike[k]);
  const host = get("x-fh-requested-host") || get("x-forwarded-host") || get("host") || "localhost:3000";
  const proto = get("x-forwarded-proto")?.split(",")[0] || (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host.split(",")[0].trim()}`;
}
