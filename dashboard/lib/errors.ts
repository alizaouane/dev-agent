/**
 * Thrown when the authenticated user lacks `write` (or higher) permission on
 * the target repository. Server Actions throw this BEFORE any mutation; the
 * UI catches it and renders a "you don't have access" message.
 *
 * Distinct from `UnauthorizedError` (in `./gh`): unauthorized = no
 * session at all; forbidden = signed in, but not allowed to act on this repo.
 *
 * Lives in its own module (not `lib/actions.ts`) because Next.js's
 * `'use server'` files are restricted to async-function exports only.
 */
export class ForbiddenError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'ForbiddenError';
  }
}
