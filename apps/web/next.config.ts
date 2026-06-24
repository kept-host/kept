import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // @kept/shared is consumed as TypeScript source via workspace:* — transpile it.
  transpilePackages: ["@kept/shared"],
};

export default nextConfig;
