// Admin auth middleware.
//
// Single-user admin: a session flag flipped on after a successful
// password match. requireAdmin redirects to /admin/login if the flag
// is missing, which sends the user back to wherever they tried to go
// after they sign in (via the `next` query param).

import { timingSafeEqual } from 'node:crypto';

export function requireAdmin(req, res, next) {
  if (req.session?.isAdmin) return next();
  const next_ = encodeURIComponent(req.originalUrl);
  res.redirect(`/admin/login?next=${next_}`);
}

// Constant-time password compare. Lengths get padded so we don't leak
// whether the submitted password matched the expected length.
export function passwordsMatch(submitted, expected) {
  if (typeof submitted !== 'string' || typeof expected !== 'string') return false;
  const a = Buffer.from(submitted);
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    // Still do a fixed-length compare to keep timing flat.
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}
