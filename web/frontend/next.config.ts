import type { NextConfig } from "next";

const backend = process.env.BACKEND_URL ?? "http://127.0.0.1:4000";

const config: NextConfig = {
  transpilePackages: ["@prlens/shared"],
  // The browser talks only to Next; /api/* is forwarded to the backend on this machine.
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${backend}/api/:path*` }];
  },
};

export default config;
