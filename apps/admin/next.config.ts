import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@farmacia/db"],
};

export default nextConfig;
