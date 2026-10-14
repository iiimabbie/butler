import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../dist/store.js';

test('deployment request is durable, duplicate-safe, and result event targets original session', () => {
  const dir = mkdtempSync(join(tmpdir(), 'butler-deploy-events-'));
  const path = join(dir, 'store.sqlite');
  try {
    let store = new Store(path);
    assert.equal(store.createDeploymentRequest({ id: 'deploy-a', parentSession: 'session-origin', channelId: 'channel-a', messageId: 'message-a', requesterId: 'user-a' }), true);
    assert.equal(store.createDeploymentRequest({ id: 'deploy-a', parentSession: 'session-origin', channelId: 'channel-a' }), false);
    assert.equal(store.createDeploymentRequest({ id: 'deploy-b', parentSession: 'session-other', channelId: 'channel-b' }), false);
    assert.equal(store.claimDeploymentRequest('deploy-a'), true);
    const secondStore = new Store(path);
    assert.equal(secondStore.claimDeploymentRequest('deploy-a'), false);
    secondStore.close();
    store.completeDeployment('deploy-a', 'completed', { id: 'deploy-a', status: 'completed', buildDigest: 'digest-a' });
    store.close();
    store = new Store(path);
    const event = store.pendingDeploymentEvents()[0];
    assert.equal(event.parent_session_id, 'session-origin');
    assert.equal(event.channel_id, 'channel-a');
    assert.equal(event.message_id, 'message-a');
    assert.equal(event.deployment_id, 'deploy-a');
    const eventInput = store.deploymentEventInput(String(event.id), 'session-origin', 'internal report', { sourceKind: 'deployment_result', channelId: 'channel-a' });
    assert.equal(eventInput.source.sourceKind, 'deployment_result');
    assert.equal(store.deploymentEventInput(String(event.id), 'session-origin', 'internal report', { sourceKind: 'deployment_result', channelId: 'channel-a' }).id, eventInput.id);
    const claim = store.claimDeploymentEvent(String(event.id));
    assert.ok(claim?.attemptId);
    assert.equal(store.claimDeploymentEvent(String(event.id)), undefined);
    store.setDeploymentEvent(String(event.id), 'delivered', undefined, 'discord-msg-a');
    assert.equal(store.pendingDeploymentEvents().length, 0);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('conflicting terminal deployment evidence is durable reconciliation and duplicate handoff is idempotent',()=>{
 const dir=mkdtempSync(join(tmpdir(),'butler-deploy-conflict-')), path=join(dir,'store.sqlite');
 try {
  const store=new Store(path);
  try {
   store.createDeploymentRequest({id:'deploy-conflict',parentSession:'session',channelId:'channel'});
   store.completeDeployment('deploy-conflict','completed',{status:'completed',buildId:'build-a'});
   store.completeDeployment('deploy-conflict','failed',{status:'failed',phase:'candidate_start'});
   let row=store.deploymentRequest('deploy-conflict');
   assert.equal(row.status,'needs_reconciliation');
   const evidence=JSON.parse(String(row.result_json));
   assert.equal(evidence.reason,'Conflicting terminal deployment evidence');
   store.completeDeployment('deploy-conflict','failed',{status:'failed',phase:'candidate_start'});
   row=store.deploymentRequest('deploy-conflict');
   assert.equal(row.status,'needs_reconciliation');
   assert.equal(JSON.parse(String(row.result_json)).incomingStatus,'failed');
  } finally {store.close();}
 } finally {rmSync(dir,{recursive:true,force:true});}
});
