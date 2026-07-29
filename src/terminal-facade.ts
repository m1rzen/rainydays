// Compatibility module for existing imports. The raw Terminal manager and its
// constructor remain private inside terminal.ts; only the owner-checking facade
// and public data types cross the module boundary.
export { terminalFacade } from "./terminal.js";
export type {
  TerminalEvent,
  TerminalInfo,
  TerminalOwner,
  TerminalShell,
  TerminalStartOptions,
} from "./terminal.js";
