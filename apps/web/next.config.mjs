import path from "node:path";

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Self-contained server for the Cloud Run container. The tracing root is the
  // repo root so the shared @so/core workspace package is included.
  output: "standalone",
  outputFileTracingRoot: path.join(import.meta.dirname, "..", ".."),
  transpilePackages: ["@so/core"],
  serverExternalPackages: ["pg"],
  poweredByHeader: false,
  // OAuth discovery documents live under /.well-known (dot-folders aren't routes).
  async rewrites() {
    return [{ source: "/.well-known/:path*", destination: "/api/well-known/:path*" }];
  },
};

export default nextConfig;
