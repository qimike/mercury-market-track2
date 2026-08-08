/**
 * Session/resume/fork API surface (spec section 22-23). The implementation
 * is src/agent/session.ts's SessionManager — kept there because it's built
 * directly on src/agent's CaseContext/MCP-connection machinery and moving it
 * would just be an import-path change with no behavioral difference. This
 * module is the stable public entry point other layers (CLI, tests) import
 * from instead of reaching into src/agent directly.
 */

export {
  SessionManager,
  investigatePolicyFork,
  mergePolicyFindingIntoParent,
  type SessionRecord,
  type PolicyInvestigationFinding,
} from "../agent/session.js";
export { copyScratchpadForFork, recordScratchpadEntry, getScratchpad, updateScratchpadStatus, type ScratchpadEntry } from "./scratchpad.js";
