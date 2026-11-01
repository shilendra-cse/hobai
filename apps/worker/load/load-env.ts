import { z } from "zod";

// Settings the driver passes its child processes, besides the worker's own configuration.
const schema = z.object({
  LOAD_PROFILE: z.enum(["typical", "long", "mixed"]).default("mixed"),
  LOAD_TIME_SCALE: z.coerce.number().min(0).default(1),
  LOAD_TOKENS_PER_SECOND: z.coerce.number().min(0).default(70),
});

export type LoadEnv = z.infer<typeof schema>;

export const parseLoadEnv = (env: Record<string, string | undefined>) =>
  schema.parse(env);

export const toLoadEnv = (settings: LoadEnv): Record<string, string> => ({
  LOAD_PROFILE: settings.LOAD_PROFILE,
  LOAD_TIME_SCALE: String(settings.LOAD_TIME_SCALE),
  LOAD_TOKENS_PER_SECOND: String(settings.LOAD_TOKENS_PER_SECOND),
});
