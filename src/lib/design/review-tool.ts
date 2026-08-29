import { tool } from "ai";
import { designReviewReportSchema } from "./review";

export const SUBMIT_DESIGN_REVIEW_TOOL = {
  submit_design_review: tool({
    description:
      "Submit the final structured Design review. This is the only completion tool for a design_review run. " +
      "Return at most 8 concrete findings across the fixed review dimensions. Do not propose or perform file writes.",
    inputSchema: designReviewReportSchema,
  }),
};
