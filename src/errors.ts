/**
 * A single error vocabulary shared by every layer. Clients switch on
 * `error.code`, which is stable; `error.message` is for humans and may change.
 */
export const ERROR_CODES = {
  VALIDATION_ERROR: 400,
  UNSUPPORTED_CONTENT_TYPE: 415,
  BLOCKED_URL: 403,
  TOO_MANY_REDIRECTS: 502,
  UPSTREAM_UNREACHABLE: 502,
  UPSTREAM_TIMEOUT: 504,
  RESPONSE_TOO_LARGE: 502,
  RATE_LIMITED: 429,
  SERVICE_OVERLOADED: 503,
  NOT_FOUND: 404,
  INTERNAL_ERROR: 500,
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

export interface ErrorDetail {
  field?: string;
  message: string;
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;
  readonly details: ErrorDetail[] | undefined;
  /** Extra response headers, e.g. `Retry-After` on a 429. */
  readonly headers: Record<string, string> | undefined;
  /** True when the caller could reasonably retry the exact same request. */
  readonly retryable: boolean;

  constructor(
    code: ErrorCode,
    message: string,
    options: {
      details?: ErrorDetail[];
      headers?: Record<string, string>;
      retryable?: boolean;
      cause?: unknown;
    } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "AppError";
    this.code = code;
    this.statusCode = ERROR_CODES[code];
    this.details = options.details;
    this.headers = options.headers;
    this.retryable = options.retryable ?? false;
  }
}

export interface ErrorResponseBody {
  error: {
    code: ErrorCode;
    message: string;
    details?: ErrorDetail[];
    retryable: boolean;
    requestId: string;
  };
}

export function toErrorResponse(error: AppError, requestId: string): ErrorResponseBody {
  return {
    error: {
      code: error.code,
      message: error.message,
      ...(error.details && error.details.length > 0 ? { details: error.details } : {}),
      retryable: error.retryable,
      requestId,
    },
  };
}

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}
