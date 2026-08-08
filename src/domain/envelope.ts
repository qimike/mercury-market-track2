/**
 * Adapts the internal ToolResult<T> shape (`{success:true,...data}` /
 * `{success:false,error}`) to the spec's wire envelope (section 12):
 * `{ok:true,data,meta}` / `{ok:false,error:{errorCategory,...}}`. Kept as a
 * boundary-only adapter — internal code (mock-backends, agent, advisor)
 * keeps using ToolResult<T> as-is; only what actually crosses the MCP
 * transport (src/mcp/server.ts) is wrapped in this envelope, so this file is
 * the single place the two shapes are reconciled.
 */

import type { ToolResult } from "./errors.js";

export interface EnvelopeMeta {
  correlationId: string;
  source: string;
  retrievedAt: string;
}

export type SuccessEnvelope<T> = { ok: true; data: T; meta: EnvelopeMeta };
export type ErrorEnvelope = {
  ok: false;
  error: {
    errorCategory: string;
    code: string;
    message: string;
    isRetryable: boolean;
    retryAfterMs: number | null;
    details: Record<string, unknown>;
    correlationId: string;
  };
};
export type Envelope<T> = SuccessEnvelope<T> | ErrorEnvelope;

export function toEnvelope<T extends object>(
  result: ToolResult<T>,
  meta: { correlationId: string; source: string }
): Envelope<Omit<T, "success">> {
  const retrievedAt = new Date().toISOString();
  if (result.success) {
    const { success: _drop, ...data } = result as T & { success: true };
    return { ok: true, data: data as Omit<T, "success">, meta: { ...meta, retrievedAt } };
  }
  return {
    ok: false,
    error: {
      errorCategory: result.error.errorCategory,
      code: result.error.errorCode,
      message: result.error.message,
      isRetryable: result.error.isRetryable,
      retryAfterMs: null,
      details: result.error.details ?? {},
      correlationId: meta.correlationId,
    },
  };
}
