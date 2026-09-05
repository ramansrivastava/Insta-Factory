import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The health route reads process.env at request time, so it must never be
  // captured at build time.
  reactStrictMode: true,
};

export default nextConfig;
