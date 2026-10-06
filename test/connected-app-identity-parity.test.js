import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRecruitingReadSessionResolver } from '../src/r01-r04-trusted-session.js';

const read = async name => readFile(new URL(`../contracts/${name}`, import.meta.url));
test('pinned control-plane identity contract matches the Recruiting consumer', async () => {
  const [source, contractRaw, schemaRaw] = await Promise.all([
    read('connected-app-identity-v1.source.json'), read('connected-app-identity-v1.contract.json'),
    read('connected-app-identity-v1.response.schema.json')]);
  const pin = JSON.parse(source);
  const contract = JSON.parse(contractRaw);
  const schema = JSON.parse(schemaRaw);
  const sha = bytes => createHash('sha256').update(bytes).digest('hex');
  assert.equal(sha(contractRaw), pin.contractSha256);
  assert.equal(sha(schemaRaw), pin.responseSchemaSha256);
  assert.equal(contract.urn, 'urn:trained-assist:connected-app-identity:v1');
  assert.equal(contract.version, 1);
  assert.equal(contract.status, 'offline_contract_only');
  assert.equal(contract.token.legacyAgentCookieAllowed, false);
  assert.equal(contract.rules.oldWebJwtOrRunTokenAccepted, false);
  assert.equal(contract.introspection.invalidation.includes('profile_switched'), true);
  assert.equal(contract.introspection.invalidation.includes('scope_removed'), true);
  assert.deepEqual(schema.oneOf[1].required, contract.introspection.activeResponseFields);
  const scopes = contract.audiences['recruiting-web'];
  assert.deepEqual(scopes, ['recruiting.responses.read', 'recruiting.reports.read',
    'recruiting.reports.create', 'recruiting.reports.review', 'recruiting.assignment.review',
    'recruiting.candidateSearch']);
  assert.equal(scopes.includes('recruiting.reports.publish'), false);
  assert.equal(scopes.includes('recruiting.reports.revoke'), false);
  assert.equal(scopes.some(scope => contract.audiences['crm-web'].includes(scope)), false);
  const resolver = createRecruitingReadSessionResolver({ verifyToken: async () => null,
    isProfileBound: async () => false, issuer: 'https://agent.example.invalid',
    audience: 'recruiting-web' });
  assert.equal(await resolver({ headers: { cookie: '__Host-r03-proactive=fake' } }), null);
});
