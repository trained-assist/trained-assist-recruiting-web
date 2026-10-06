import { createHmac, timingSafeEqual } from 'node:crypto';

const safeId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const cookieName = '__Host-r03-proactive';
const scope = 'recruiting.candidateSearch';
const equal = (a, b) => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

// Legacy signed links use the old agent's exact 16-hex HMAC. The short-lived
// cookie is domain-separated and cannot be used as a legacy page token.
export function createPrivateWebAuth({ legacySecret, isKnownProfile, publicOrigin = 'https://recruiter-assistant.ru',
  clock = () => Date.now(), sessionSeconds = 12 * 60 * 60 } = {}) {
  if (typeof legacySecret !== 'string' || legacySecret.length < 32 || typeof isKnownProfile !== 'function' ||
      typeof clock !== 'function' || !Number.isSafeInteger(sessionSeconds) || sessionSeconds < 60 ||
      sessionSeconds > 24 * 60 * 60 || new URL(publicOrigin).origin !== publicOrigin ||
      !publicOrigin.startsWith('https://')) throw new TypeError('private_web_auth_unavailable');
  const hmac = input => createHmac('sha256', legacySecret).update(input).digest('hex');
  const context = profileId => ({ profileId, scopes: [scope] });
  const cookieValue = profileId => {
    const expiry = Math.floor(clock() / 1000) + sessionSeconds;
    const payload = `${profileId}.${expiry}`;
    return `${payload}.${hmac(`r03-web-session:${payload}`)}`;
  };
  return async (req, url, res) => {
    if (req.method === 'POST' && req.headers.origin !== publicOrigin) return null;
    const signedPage = req.method === 'GET' && url.pathname === '/hh/proactive';
    if (signedPage && (url.searchParams.has('username') || url.searchParams.has('token'))) {
      const usernames = url.searchParams.getAll('username');
      const tokens = url.searchParams.getAll('token');
      if (usernames.length !== 1 || tokens.length !== 1 || !safeId(usernames[0]) ||
          !/^[a-f0-9]{16}$/.test(tokens[0]) || !isKnownProfile(usernames[0]) ||
          !equal(tokens[0], hmac(usernames[0]).slice(0, 16))) return null;
      res.setHeader('Set-Cookie', `${cookieName}=${cookieValue(usernames[0])}; Path=/; Max-Age=${sessionSeconds}; HttpOnly; Secure; SameSite=Strict`);
      return context(usernames[0]);
    }
    const matching = String(req.headers.cookie ?? '').split(';').map(part => part.trim())
      .filter(part => part.startsWith(`${cookieName}=`));
    if (matching.length !== 1) return null;
    const match = new RegExp(`^${cookieName}=([A-Za-z0-9_-]{1,128})\\.([0-9]{1,12})\\.([a-f0-9]{64})$`).exec(matching[0]);
    if (!match || !isKnownProfile(match[1])) return null;
    const expiry = Number(match[2]);
    const now = Math.floor(clock() / 1000);
    if (!Number.isSafeInteger(expiry) || expiry <= now || expiry > now + sessionSeconds ||
        !equal(match[3], hmac(`r03-web-session:${match[1]}.${match[2]}`))) return null;
    return context(match[1]);
  };
}
