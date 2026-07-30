import Anthropic from "@anthropic-ai/sdk";

export function createAnthropicClient() {
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });
}

export const OCR_MODEL = "claude-sonnet-4-6";

export { retryWithBackoff } from "@/lib/http-retry";
