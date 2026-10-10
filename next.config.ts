import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // pg and the SDKs are server-only; keep them out of the client bundle.
  serverExternalPackages: ["pg", "@anthropic-ai/sdk", "@anthropic-ai/foundry-sdk", "openai"],
  // STORE=file reads data/index/index.json at runtime; make sure it is shipped with the serverless function.
  outputFileTracingIncludes: { "/api/chat": ["./data/index/**"] },
};

export default nextConfig;
