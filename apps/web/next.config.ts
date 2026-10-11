import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // @kept/shared is consumed as TypeScript source via workspace:* — transpile it.
  transpilePackages: ["@kept/shared"],
  // The short Impressum URL for profile bios (E06a, PRD §6). `permanent` → 308.
  async redirects() {
    return [
      {
        source: "/impressum",
        destination: "/legal/impressum",
        permanent: true,
      },
    ];
  },
};

export default nextConfig;
