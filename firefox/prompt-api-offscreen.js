/** Firefox has no Chrome Prompt API offscreen host. */
export const PROMPT_API_OFFSCREEN_PATH = "";

export async function ensurePromptApiOffscreen() {
  throw new Error("On-device AI is unavailable in Firefox.");
}

export async function sendPromptApiOffscreenMessage() {
  throw new Error("On-device AI is unavailable in Firefox.");
}
