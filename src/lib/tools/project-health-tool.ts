import { tool } from "ai";
import { z } from "zod";

export const PROJECT_HEALTH_CHECK_TOOL = {
  project_health_check: tool({
    description:
      "Run a structured project health check over the current files and preview console logs. " +
      "Use after code changes to detect missing entry files, invalid package.json, env gaps, HTML basics, runtime console errors, and Design-system state, Token wiring, and changed-scope drift when Design context is active.",
    inputSchema: z.object({
      include_console: z
        .boolean()
        .optional()
        .describe("Include current Sandpack console logs. Default: true."),
    }),
  }),
};
