const safeId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);

// The agent/platform owns authentication and profile selection. verifyToken must
// validate the token with that issuer (signature or introspection) and return
// verified claims; no request header or R-03 page cookie is itself a principal.
export function createRecruitingReadSessionResolver({ verifyToken, isProfileBound,
  issuer, audience, clock = () => Date.now() } = {}) {
  if (typeof verifyToken !== 'function' || typeof isProfileBound !== 'function' ||
      typeof issuer !== 'string' || !issuer || typeof audience !== 'string' || !audience ||
      typeof clock !== 'function') throw new TypeError('trusted_session_ports_required');

  return async req => {
    const match = /^Bearer ([A-Za-z0-9._~-]{32,4096})$/.exec(String(req?.headers?.authorization ?? ''));
    if (!match) return null;
    let claims;
    try { claims = await verifyToken(match[1]); } catch { return null; }
    const now = Math.floor(clock() / 1000);
    if (!claims || claims.iss !== issuer || claims.aud !== audience ||
        !safeId(claims.sub) || !safeId(claims.profileId) || !safeId(claims.sessionId) ||
        !Number.isSafeInteger(claims.exp) || claims.exp <= now ||
        !Number.isSafeInteger(claims.nbf) || claims.nbf > now ||
        claims.exp - claims.nbf > 3600 ||
        !Array.isArray(claims.scopes) || claims.scopes.length < 1 || claims.scopes.length > 16 ||
        claims.scopes.some(scope => typeof scope !== 'string' || !/^[a-zA-Z][a-zA-Z0-9.]{1,99}$/.test(scope))) return null;
    let bound;
    try { bound = await isProfileBound(claims.sub, claims.profileId, claims.sessionId); }
    catch { return null; }
    if (bound !== true) return null;
    // Deliberately ignore all other claims. The server checks the exact
    // recruiting.responses.read or recruiting.reports.read scope per route.
    return Object.freeze({ profileId: claims.profileId, scopes: Object.freeze([...new Set(claims.scopes)]) });
  };
}
