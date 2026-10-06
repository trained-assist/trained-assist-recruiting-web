import { createDecipheriv, createCipheriv, randomBytes } from 'node:crypto';
import { closeSync, constants, fsyncSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync,
  renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const safeId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const fail = code => { throw new Error(code); };
const validKey = value => typeof value === 'string' && /^[a-fA-F0-9]{64}$/.test(value);
const envelope = raw => {
  const value = raw.trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length < 44) return null;
  const bytes = Buffer.from(value, 'base64');
  return bytes.length >= 33 && bytes[0] === 2 ? bytes : null;
};

function privateDirectory(directory) {
  try { if (!lstatSync(directory).isDirectory() || lstatSync(directory).mode & 0o077) fail('credential_scope_unavailable'); }
  catch { fail('credential_scope_unavailable'); }
}

function readCredentialFile(directory, encryptionKey) {
  privateDirectory(directory);
  let fd;
  let raw;
  try {
    fd = openSync(join(directory, 'hh'), constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > 64_000) fail('hh_credential_unavailable');
    const bytes = readFileSync(fd);
    if (bytes.length !== info.size) fail('hh_credential_unavailable');
    raw = bytes.toString('utf8');
  } catch { fail('hh_credential_unavailable'); }
  finally { if (fd !== undefined) closeSync(fd); }
  const sealed = envelope(raw);
  if (sealed) {
    if (!validKey(encryptionKey)) fail('hh_credential_key_unavailable');
    try {
      const decipher = createDecipheriv('aes-256-gcm', Buffer.from(encryptionKey, 'hex'), sealed.subarray(1, 17));
      decipher.setAuthTag(sealed.subarray(17, 33));
      raw = Buffer.concat([decipher.update(sealed.subarray(33)), decipher.final()]).toString('utf8');
    } catch { fail('hh_credential_decryption_failed'); }
  }
  try {
    const value = raw.trim().startsWith('{') ? JSON.parse(raw) : { access_token: raw.trim() };
    if (!value || typeof value.access_token !== 'string' || !value.access_token.trim() ||
        value.refresh_token !== undefined && typeof value.refresh_token !== 'string') fail('hh_credential_unavailable');
    return value;
  } catch { fail('hh_credential_unavailable'); }
}

function sealCredential(value, encryptionKey) {
  if (!validKey(encryptionKey)) fail('hh_credential_key_unavailable');
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(encryptionKey, 'hex'), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return Buffer.concat([Buffer.from([2]), iv, cipher.getAuthTag(), ciphertext]).toString('base64');
}

function replaceCredential(directory, value, encryptionKey) {
  const temp = join(directory, `hh.tmp-${process.pid}-${randomBytes(8).toString('hex')}`);
  let fd;
  try {
    fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    writeFileSync(fd, sealCredential(value, encryptionKey));
    fsyncSync(fd);
    closeSync(fd); fd = undefined;
    renameSync(temp, join(directory, 'hh'));
    const dirFd = openSync(directory, constants.O_RDONLY);
    try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temp); } catch {}
  }
}

// The binding and OAuth application secrets are server-side ports. No token or
// source profile path is ever accepted from an HTTP/MCP request.
export function createPrivateHhCredentialBroker({ resolveProfileBinding, encryptionKey,
  clientId, clientSecret, fetchImpl, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  if (typeof resolveProfileBinding !== 'function' || typeof fetchImpl !== 'function' || typeof sleep !== 'function')
    throw new TypeError('private HH credential ports required');
  async function directoryFor(profileId) {
    if (!safeId(profileId)) fail('hh_credential_scope_denied');
    let binding;
    try { binding = await resolveProfileBinding(profileId); } catch { fail('hh_credential_scope_denied'); }
    if (binding?.profileId !== profileId || typeof binding.tokenDirectory !== 'string' || !binding.tokenDirectory)
      fail('hh_credential_scope_denied');
    privateDirectory(binding.tokenDirectory);
    return binding.tokenDirectory;
  }
  async function loadCredential(profileId) {
    const directory = await directoryFor(profileId);
    const value = readCredentialFile(directory, encryptionKey);
    return { profileId, accessToken: value.access_token };
  }
  async function refreshCredential(profileId, expectedAccessToken) {
    if (typeof expectedAccessToken !== 'string' || !expectedAccessToken ||
        typeof clientId !== 'string' || !clientId || typeof clientSecret !== 'string' || !clientSecret ||
        !validKey(encryptionKey)) fail('hh_refresh_unavailable');
    const directory = await directoryFor(profileId);
    const lock = join(directory, 'hh.refresh.lock');
    let held = false;
    for (let attempt = 0; attempt < 6 && !held; attempt++) {
      try { mkdirSync(lock, { mode: 0o700 }); held = true; }
      catch (error) {
        if (error?.code !== 'EEXIST') fail('hh_refresh_unavailable');
        await sleep(200);
        const current = readCredentialFile(directory, encryptionKey);
        if (current.access_token !== expectedAccessToken)
          return { profileId, accessToken: current.access_token };
      }
    }
    if (!held) fail('hh_refresh_locked');
    try {
      const current = readCredentialFile(directory, encryptionKey);
      if (current.access_token !== expectedAccessToken) return { profileId, accessToken: current.access_token };
      if (typeof current.refresh_token !== 'string' || !current.refresh_token) fail('hh_refresh_unavailable');
      let response;
      try { response = await fetchImpl('https://hh.ru/oauth/token', { method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', client_id: clientId,
          client_secret: clientSecret, refresh_token: current.refresh_token }).toString(),
        signal: AbortSignal.timeout(10_000) }); }
      catch { fail('hh_refresh_unavailable'); }
      if (!response?.ok || typeof response.json !== 'function') fail('hh_refresh_unavailable');
      let updated;
      try { updated = await response.json(); } catch { fail('hh_refresh_unavailable'); }
      if (typeof updated?.access_token !== 'string' || !updated.access_token ||
          updated.refresh_token !== undefined && (typeof updated.refresh_token !== 'string' || !updated.refresh_token))
        fail('hh_refresh_unavailable');
      const next = { ...current, access_token: updated.access_token,
        refresh_token: updated.refresh_token || current.refresh_token, saved_at: new Date().toISOString() };
      replaceCredential(directory, next, encryptionKey);
      return { profileId, accessToken: next.access_token };
    } finally { try { rmdirSync(lock); } catch { fail('hh_refresh_lock_cleanup_failed'); } }
  }
  return { loadCredential, refreshCredential };
}
