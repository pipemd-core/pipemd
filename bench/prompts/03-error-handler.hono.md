The error handling across Hono's built-in middleware is inconsistent — some middleware throws `HTTPException`, some throw generic `Error`, and the default error handler just returns "Internal Server Error". Add a centralized error handler to the Hono class.

Requirements:
- In `src/hono-base.ts`, the `HonoBase` class already has a default `errorHandler`. Modify it so that:
  1. If the error is an `HTTPException`, it still calls `getResponse()` as before
  2. If the error is a generic `Error`, the handler now returns a JSON response: `{ "error": true, "message": "<error message>", "status": 500 }` with `Content-Type: application/json`
  3. If the error is not an Error instance, return the same JSON shape with message "Unknown error"
- Also add a new method `errorResponse(status: number, message: string): Response` on the `HonoBase` class that creates a JSON error response. This should be a utility method that could be reused.
- The existing tests in `src/hono.test.ts` and `src/http-exception.test.ts` should still pass after your changes — do not break the existing `HTTPException` behavior.
- Do NOT change the `HTTPException` class itself.
