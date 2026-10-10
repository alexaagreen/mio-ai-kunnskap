import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // pg and the SDKs are server-only; keep them out of the client bundle.
  serverExternalPackages: ["pg", "@anthropic-ai/sdk", "@anthropic-ai/foundry-sdk", "openai"],
};

export default nextConfig;
