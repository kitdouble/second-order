/** @type {import('next').NextConfig} */
const nextConfig = {
  // Produces a self-contained server in .next/standalone for the Cloud Run container.
  output: "standalone",
};

export default nextConfig;
