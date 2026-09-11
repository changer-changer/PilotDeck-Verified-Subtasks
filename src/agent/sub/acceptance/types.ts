import type { CanonicalUsage } from "../../../model/index.js";

/** Versioned, opt-in subtask acceptance contract. No executable commands in model input. */
export type SubtaskAcceptanceContract = {
  schema: Record<string, unknown>;
  validators?: string[];
  maxRepairs?: number;
  /** Total model turns shared by initial execution and all repairs. */
  maxTurns?: number;
};

export type AcceptanceIssue = { path: string; code: string; message: string };
export type SubtaskValidator = (context: {
  value: unknown;
  cwd: string;
  subagentId: string;
  signal?: AbortSignal;
}) => Promise<AcceptanceIssue[]>;
/** Trusted host registrations, never code or shell supplied by a model. */
export type SubtaskValidators = Readonly<Record<string, SubtaskValidator>>;
export type AcceptanceAttempt = {
  attempt: number;
  accepted: boolean;
  /** First-layer result before independent model review. */
  checksPassed?: boolean;
  issues: AcceptanceIssue[];
  /**
   * Second-layer model review report when a reviewer ran for this attempt
   * (deterministic checks passed first). Kept for every review decision.
   */
  review?: SubtaskReviewResult;
};
/**
 * Outcome of the independent second-layer model reviewer. `error` is
 * terminal — an unavailable / malformed reviewer never counts as accepted.
 */
export type SubtaskReviewResult = {
  status: "accepted" | "rejected" | "error";
  model: { provider: string; model: string };
  summary: string;
  issues: AcceptanceIssue[];
  /** Artifact paths the reviewer itself actually read successfully. */
  evidence: string[];
  turns: number;
  usage: CanonicalUsage;
  durationMs: number;
  /** Bounded actual model output for inspection, including invalid verdicts. */
  rawVerdict?: string;
};
export type SubtaskAcceptanceResult = {
  status: "accepted" | "rejected";
  stopReason: "accepted" | "repair_limit" | "turn_limit" | "validator_error" | "reviewer_error";
  attempts: AcceptanceAttempt[];
  repairs: number;
  value?: unknown;
};
export type PreparedAcceptance = {
  schema: Record<string, unknown>;
  validators: string[];
  maxRepairs: number;
  maxTurns: number;
};
