import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { z } from "zod";
import type { AppEnv } from "./env.js";

/**
 * Every error the API emits is `{ error: string }` with a meaningful status.
 * Agents read these strings, so they must be self-explanatory on their own.
 */
export type ErrorBody = { error: string };

export class ApiError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 413 | 415 | 416 | 422 | 500 | 501 | 502,
    message: string
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export const badRequest = (m: string) => new ApiError(400, m);
export const unauthorized = (m: string) => new ApiError(401, m);
export const forbidden = (m: string) => new ApiError(403, m);
export const notFound = (m: string) => new ApiError(404, m);
export const tooLarge = (m: string) => new ApiError(413, m);

/**
 * Flatten a ZodError into one readable line. Agents get the field path and the
 * reason together, e.g.
 *   `invalid request body: listId: Required; title: String must contain at
 *    least 1 character(s)`
 */
export function formatZodIssues(err: z.ZodError): string {
  return err.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      return `${path}: ${issue.message}`;
    })
    .join("; ");
}

/** Parse against a schema or throw a 422 carrying every Zod issue. */
export function parseOrThrow<S extends z.ZodTypeAny>(
  schema: S,
  value: unknown,
  what = "request body"
): z.infer<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ApiError(422, `invalid ${what}: ${formatZodIssues(result.error)}`);
  }
  return result.data as z.infer<S>;
}

/** Read a JSON body, mapping malformed JSON to a 400 rather than a 500. */
export async function readJson(c: Context<AppEnv>): Promise<unknown> {
  const raw = await c.req.text();
  if (raw.trim() === "") return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw badRequest("request body is not valid JSON");
  }
}

/** Terminal error handler: normalises everything to `{ error }`. */
export function onError(err: Error, c: Context<AppEnv>): Response {
  if (err instanceof ApiError) {
    return c.json<ErrorBody>({ error: err.message }, err.status);
  }
  if (err instanceof HTTPException) {
    return c.json<ErrorBody>({ error: err.message || "request failed" }, err.status);
  }
  // Unexpected: log with structure so it is findable in Workers Logs, but never
  // leak internals to the caller.
  console.error(
    JSON.stringify({
      level: "error",
      msg: "unhandled error",
      path: new URL(c.req.url).pathname,
      method: c.req.method,
      error: err.message,
      stack: err.stack,
    })
  );
  return c.json<ErrorBody>({ error: "internal error" }, 500);
}

export function notFoundHandler(c: Context<AppEnv>): Response {
  return c.json<ErrorBody>(
    { error: `no route for ${c.req.method} ${new URL(c.req.url).pathname}` },
    404
  );
}
