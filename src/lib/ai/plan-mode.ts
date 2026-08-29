import { ASK_USER_QUESTION_CONTRACT } from "./ask-user-question-contract";

export const PLAN_APPROVED_PREFIX = "Plan approved";
export const PLAN_REJECTED_PREFIX = "Plan rejected";

export const PLAN_OUTPUT_CONTRACT = `The plan must be decision-complete: another engineer should be able to implement it without making unresolved product or architecture decisions. Scale the amount of detail to the task, but always cover:
- the goal, user-visible outcome, and observable success criteria;
- the current implementation and evidence from the inspected project; for bugs, state the root cause;
- implementation changes grouped by subsystem, including affected files or symbols when known;
- public interfaces, types, state, and data flow changes, or an explicit statement that none change;
- relevant edge cases, failure handling, compatibility or migration needs, risks, and non-goals;
- concrete test scenarios, acceptance criteria, and the boundary between planned and already-run verification;
- assumptions and defaults already chosen.

Write in the user's language. Ground the plan in files and dependencies you actually inspected. Do not invent implementation facts or claim unrun verification. Resolve high-impact ambiguity with ask_user_question before submitting the plan; do not ask filler questions when the project and request already determine the answer.`;

export const PLAN_MODE_SYSTEM_SUFFIX = `

## PLAN MODE ACTIVE
Plan Mode overrides any ordinary workflow advice to skip planning for small changes. Research and plan only. Every write tool (init_project, manage_dependencies, write_file, patch_file, delete_file, rename_file, move_file, manage_env, install_component, screenshot_to_code, apply_design_style, apply_design_system, execute_skill_script) is withheld until the user approves your plan.
1. Read the project with list_files / read_files / search_in_files until the plan is grounded in the current implementation.
2. Follow this shared ask_user_question contract. In Plan Mode, a completed interview leads to a decision-complete plan rather than implementation:

<ask_user_question_contract>
${ASK_USER_QUESTION_CONTRACT}
</ask_user_question_contract>

3. Prepare the implementation plan under this contract:

<plan_output_contract>
${PLAN_OUTPUT_CONTRACT}
</plan_output_contract>

4. Deliver the complete plan by calling exit_plan_mode as your final step. Do not write it as a normal reply. exit_plan_mode must be the only tool call in that response.
Approval unlocks the write tools; start implementing only in the next provider iteration.`;
