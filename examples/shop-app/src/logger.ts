// Tiny logger so the demo has no dependencies.
export const logger = {
  info: (...args: unknown[]) => console.log("[shop]", ...args),
  error: (...args: unknown[]) => console.error("[shop]", ...args),
};
