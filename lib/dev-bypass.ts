/**
 * TEMPORARY LOCAL-DEVELOPMENT BYPASS — remove when done with UI work.
 *
 * When `DEV_BYPASS_DB=1` (and NODE_ENV is not "production"), the app runs the
 * whole UI with no Postgres and no login session:
 *
 *   - `lib/db/queries.ts` delegates every query to an in-memory store
 *     (`lib/db/mock.ts`) instead of the `postgres` client.
 *   - `app/(auth)/auth.ts` hands back a fixed local session, so every
 *     `await auth()` guard in the API routes resolves.
 *   - `proxy.ts` skips the "redirect to /api/auth/guest" step, which would
 *     otherwise need a database row just to render the page.
 *
 * Nothing in the production path changes: with the flag unset, every one of
 * those modules behaves exactly as before. Model selection, streaming, UI and
 * components are untouched.
 *
 * Rollback: delete the `DEV_BYPASS_DB` line from `.env.local`, or set it to 0.
 */

const requested = process.env.DEV_BYPASS_DB === "1";

/** True only in a non-production runtime with the flag explicitly enabled. */
export const isDevBypassEnabled =
  requested && process.env.NODE_ENV !== "production";

/** True when the flag was set in a production build, i.e. ignored. */
export const isDevBypassIgnored =
  requested && process.env.NODE_ENV === "production";

/**
 * Deterministic local stand-in for the signed-in user. `guest-0` matches
 * `guestRegex` in `lib/constants.ts`, so the app treats it as a guest account.
 */
export const DEV_BYPASS_USER_ID = "00000000-0000-4000-8000-000000000001";

// Fixed, well-in-the-future expiry: reading the clock during render is a
// prerender error under Next.js `cacheComponents`.
const DEV_BYPASS_SESSION_EXPIRES = new Date(Date.UTC(2100, 0, 1)).toISOString();

export function createDevBypassSession() {
  return {
    expires: DEV_BYPASS_SESSION_EXPIRES,
    user: {
      email: "guest-0",
      id: DEV_BYPASS_USER_ID,
      type: "guest" as const,
    },
  };
}

export function logDevBypassOnce() {
  if (isDevBypassIgnored) {
    console.warn(
      "[dev-bypass] DEV_BYPASS_DB=1 was ignored because NODE_ENV is production."
    );
    return;
  }

  if (isDevBypassEnabled) {
    console.warn(
      "[dev-bypass] Database and auth are BYPASSED via DEV_BYPASS_DB=1.\n" +
        "[dev-bypass] Data lives in memory only and is lost on restart.\n" +
        "[dev-bypass] Remove DEV_BYPASS_DB from .env.local to restore Postgres + auth."
    );
  }
}
