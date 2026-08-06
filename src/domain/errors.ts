/**
 * Structured tool error model shared by every mock backend, MCP tool, subagent,
 * and the coordinator. Every tool call resolves to a ToolResult<T> — never throws
 * across a tool boundary — so the agent loop can always inspect `success` and
 * branch deterministically instead of relying on prompted judgement.
 */

export const ERROR_CATEGORIES = [
  "VALIDATION",
  "ACCESS",
  "NOT_FOUND",
  "CONFLICT",
  "RATE_LIMIT",
  "DEPENDENCY",
  "TRANSIENT",
  "POLICY_AMBIGUITY",
  "INTERNAL",
] as const;

export type ErrorCategory = (typeof ERROR_CATEGORIES)[number];

/** Categories that MAY be retried by the agent loop's bounded retry policy. */
const RETRYABLE_CATEGORIES = new Set<ErrorCategory>(["RATE_LIMIT", "DEPENDENCY", "TRANSIENT"]);

export interface ToolError {
  errorCode: string;
  errorCategory: ErrorCategory;
  message: string;
  isRetryable: boolean;
  /** Present when this error wraps/propagates a lower-level failure (tool -> subagent -> coordinator). */
  cause?: ToolError;
  /** Free-form structured context safe to log/replay (never secrets). */
  details?: Record<string, unknown>;
}

export type ToolResult<T> =
  | ({ success: true } & T)
  | { success: false; error: ToolError };

export function err(
  category: ErrorCategory,
  errorCode: string,
  message: string,
  isRetryable: boolean = RETRYABLE_CATEGORIES.has(category),
  details?: Record<string, unknown>
): ToolError {
  return { errorCode, errorCategory: category, message, isRetryable, details };
}

export function fail<T>(
  category: ErrorCategory,
  errorCode: string,
  message: string,
  isRetryable?: boolean,
  details?: Record<string, unknown>
): ToolResult<T> {
  return { success: false, error: err(category, errorCode, message, isRetryable, details) };
}

export function ok<T extends object>(data: T): ToolResult<T> {
  return { success: true, ...data };
}

/** Wraps a lower-level error while preserving its trace as `cause`, per the propagation requirement. */
export function propagate(
  category: ErrorCategory,
  errorCode: string,
  message: string,
  cause: ToolError,
  isRetryable?: boolean
): ToolError {
  return {
    errorCode,
    errorCategory: category,
    message,
    isRetryable: isRetryable ?? cause.isRetryable,
    cause,
  };
}

export function isRetryable(error: ToolError): boolean {
  return error.isRetryable === true;
}

export class DomainError extends Error {
  readonly toolError: ToolError;
  constructor(toolError: ToolError) {
    super(toolError.message);
    this.name = "DomainError";
    this.toolError = toolError;
  }
}
