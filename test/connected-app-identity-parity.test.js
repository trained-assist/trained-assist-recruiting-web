import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRecruitingReadSessionResolver } from '../src/r01-r04-trusted-session.js';

const read = async name => readFile(new URL(`../contracts/${name}`, import.meta.url));
test('pinned control-plane identity contract matches the Recruiting consumer', async () => {
  const [source, contractRaw, schemaRaw, agentContractRaw, agentSchemaRaw, agentSourceRaw] = await Promise.all([
    read('connected-app-identity-v1.source.json'), read('connected-app-identity-v1.contract.json'),
    read('connected-app-identity-v1.response.schema.json'),
    read('agent-profile-context-v1/contract.json'), read('agent-profile-context-v1/profile-context.schema.json'),
    read('agent-profile-context-v1/source.json')]);
  const pin = JSON.parse(source);
  const contract = JSON.parse(contractRaw);
  const schema = JSON.parse(schemaRaw);
  const agentPin = pin.agentProfileContext;
  const agentContract = JSON.parse(agentContractRaw);
  const agentSchema = JSON.parse(agentSchemaRaw);
  const producerAgentPin = JSON.parse(agentSourceRaw);
  const sha = bytes => createHash('sha256').update(bytes).digest('hex');
  assert.equal(pin.repository, 'trained-assist/trained-assist-control-plane');
  assert.equal(pin.revision, '85988bbfe30410cd8dde5d8df57b21dd421aedaa');
  assert.equal(sha(contractRaw), pin.contractSha256);
  assert.equal(sha(schemaRaw), pin.responseSchemaSha256);
  assert.equal(agentPin.repository, 'trained-assist/trained-assist-agent');
  assert.equal(agentPin.revision, '4a60c2e4c45eca9de1b84bba55e38bb83e1478c8');
  assert.equal(producerAgentPin.revision, agentPin.revision);
  assert.equal(sha(agentContractRaw), agentPin.contractSha256);
  assert.equal(sha(agentSchemaRaw), agentPin.schemaSha256);
  assert.equal(sha(agentContractRaw), producerAgentPin.artifacts['contract.json']);
  assert.equal(sha(agentSchemaRaw), producerAgentPin.artifacts['profile-context.schema.json']);
  assert.equal(contract.urn, 'urn:trained-assist:connected-app-identity:v1');
  assert.equal(contract.version, 1);
  assert.equal(contract.status, 'offline_contract_only');
  assert.equal(contract.token.legacyAgentCookieAllowed, false);
  assert.equal(contract.rules.oldWebJwtOrRunTokenAccepted, false);
  assert.equal(contract.introspection.invalidation.includes('profile_switched'), true);
  assert.equal(contract.introspection.invalidation.includes('scope_removed'), true);
  assert.deepEqual(schema.oneOf[1].required, contract.introspection.activeResponseFields);
  const scopes = contract.audiences['recruiting-web'];
  assert.deepEqual(scopes, ['recruiting.responses.read', 'recruiting.responses.conversation.open',
    'recruiting.reports.read', 'recruiting.reports.create', 'recruiting.reports.review',
    'recruiting.assignment.review', 'recruiting.candidateSearch']);
  assert.equal(scopes.includes('recruiting.reports.publish'), false);
  assert.equal(scopes.includes('recruiting.reports.revoke'), false);
  assert.equal(contract.audiences['crm-web'].includes('crm.deals.create'), true);
  assert.equal(scopes.some(scope => contract.audiences['crm-web'].includes(scope)), false);
  assert.equal(contract.agentProfileAuthority.urn, agentContract.urn);
  assert.equal(contract.agentProfileAuthority.version, agentContract.version);
  assert.equal(contract.agentProfileAuthority.owner, agentContract.owner);
  assert.equal(contract.agentProfileAuthority.sourceRevision, agentPin.revision);
  assert.deepEqual(contract.agentProfileAuthority.contextFields, agentSchema.required);
  assert.equal(contract.agentProfileAuthority.runtimeStatus, 'not_wired');
  assert.equal(agentContract.status, 'contract_only');
  assert.equal(agentContract.authority.legacyPerProfileJwtAllowed, false);
  assert.equal(agentContract.authority.browserReadableSelectionCookieAllowed, false);
  const resolver = createRecruitingReadSessionResolver({ verifyToken: async () => null,
    isProfileBound: async () => false, issuer: 'https://agent.example.invalid',
    audience: 'recruiting-web' });
  assert.equal(await resolver({ headers: { cookie: '__Host-r03-proactive=fake' } }), null);
});
