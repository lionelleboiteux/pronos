/**
 * The one error envelope every operation returns (openapi.yaml §Error
 * envelope). Callers branch on `error.code`, never on the status alone.
 */

import { randomUUID } from 'node:crypto';

export type ErrorCode =
  | 'VALIDATION_FAILED'
  | 'MATCH_LOCKED'
  | 'NOT_FOUND'
  | 'UNAUTHORIZED'
  | 'CONFLICT'
  | 'INTERNAL_ERROR';

export type ApiResponse = { status: number; body: Record<string, unknown> };

export function errorResponse(
  status: number,
  code: ErrorCode,
  message: string,
  details: Record<string, unknown> | null = null,
): ApiResponse {
  return {
    status,
    body: { error: { code, message, details, request_id: randomUUID() } },
  };
}
