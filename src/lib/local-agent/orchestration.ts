import type { GeneratorRunState } from "../ai/generator-types";
import type { LocalCliRunState } from "./types";

/** Map an enumerated local CLI run state onto the shared generator run state. */
export function runStateForLocalCliStatus(
  state: LocalCliRunState,
): GeneratorRunState {
  switch (state) {
    case "preparing":
    case "handshaking":
      return "preparing";
    case "streaming":
      return "streaming";
  }
}
