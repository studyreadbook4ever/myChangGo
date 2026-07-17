export type ValidationIssueCode =
  | "invalid_type"
  | "invalid_value"
  | "invalid_format"
  | "out_of_range"
  | "missing_key"
  | "unknown_key"
  | "too_large"
  | "invariant";

export interface ValidationIssue {
  readonly path: string;
  readonly code: ValidationIssueCode;
  readonly message: string;
  readonly received: unknown;
}

export type ValidationResult<T> =
  | { readonly success: true; readonly data: T }
  | { readonly success: false; readonly issues: readonly ValidationIssue[] };

export function validationSuccess<T>(data: T): ValidationResult<T> {
  return { success: true, data };
}

export function validationFailure<T = never>(
  issues: readonly ValidationIssue[],
): ValidationResult<T> {
  return { success: false, issues };
}

export function issue(
  path: string,
  code: ValidationIssueCode,
  message: string,
  received: unknown,
): ValidationIssue {
  return { path, code, message, received };
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

export function hasOwn(
  value: Record<string, unknown>,
  key: string,
): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

export function findUnknownKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): string[] {
  return Object.keys(value).filter((key) => !allowed.has(key));
}

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export interface JsonValidationOptions {
  readonly maxDepth?: number;
  readonly maxNodes?: number;
}

export function validateJsonValue(
  value: unknown,
  path = "$",
  options: JsonValidationOptions = {},
): ValidationIssue[] {
  const maxDepth = options.maxDepth ?? 16;
  const maxNodes = options.maxNodes ?? 10_000;
  const issues: ValidationIssue[] = [];
  const ancestors = new Set<object>();
  let nodes = 0;

  const visit = (candidate: unknown, candidatePath: string, depth: number): void => {
    nodes += 1;
    if (nodes > maxNodes) {
      if (!issues.some((entry) => entry.code === "too_large")) {
        issues.push(
          issue(candidatePath, "too_large", `JSON value exceeds ${maxNodes} nodes`, candidate),
        );
      }
      return;
    }

    if (depth > maxDepth) {
      issues.push(
        issue(candidatePath, "too_large", `JSON value exceeds depth ${maxDepth}`, candidate),
      );
      return;
    }

    if (
      candidate === null ||
      typeof candidate === "string" ||
      typeof candidate === "boolean"
    ) {
      return;
    }

    if (typeof candidate === "number") {
      if (!Number.isFinite(candidate)) {
        issues.push(issue(candidatePath, "invalid_value", "number must be finite", candidate));
      }
      return;
    }

    if (typeof candidate !== "object") {
      issues.push(
        issue(
          candidatePath,
          "invalid_type",
          "value must contain only JSON-compatible data",
          candidate,
        ),
      );
      return;
    }

    if (ancestors.has(candidate)) {
      issues.push(issue(candidatePath, "invalid_value", "JSON value must not be cyclic", candidate));
      return;
    }

    ancestors.add(candidate);
    if (Array.isArray(candidate)) {
      candidate.forEach((item, index) => {
        visit(item, `${candidatePath}[${index}]`, depth + 1);
      });
    } else if (isPlainObject(candidate)) {
      for (const [key, item] of Object.entries(candidate)) {
        if (key === "__proto__" || key === "constructor" || key === "prototype") {
          issues.push(issue(`${candidatePath}.${key}`, "invalid_format", "unsafe object key", key));
        } else {
          visit(item, `${candidatePath}.${key}`, depth + 1);
        }
      }
    } else {
      issues.push(
        issue(candidatePath, "invalid_type", "object must have a plain prototype", candidate),
      );
    }
    ancestors.delete(candidate);
  };

  visit(value, path, 0);
  return issues;
}

export function jsonByteLength(value: JsonValue): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}
