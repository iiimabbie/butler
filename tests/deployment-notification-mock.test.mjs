import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../dist/store.js';
import { processDeploymentResultEvent } from '../dist/deployment-notifications.js';

function fixture() {
 const dir=mkdtempSync(join(tmpdir(),'butler-notify-mock-')), store=new Store(join(dir,'store.sqlite'));
 store.createDeploymentRequest({id:'dep-x',parentSession:'origin-session',channelId:'channel',messageId:'source-msg',requesterId:'user'});
 store.claimDeploymentRequest('dep-x'); store.completeDeployment('dep-x','completed',{id:'dep-x',status:'completed',buildDigest:'digest'});
 const event=store.pendingDeploymentEvents()[0];
 return {dir,store,event,close(){store.close();rmSync(dir,{recursive:true,force:true});}};
}

test('deployment result event persists original-session input, isolates side effects, and stores real delivery ID once',async()=>{
 const f=fixture(); let asks=0,sends=0,deployCalls=0;
 try {
  const result=await processDeploymentResultEvent(f.store,f.event,{ask:async(input,content,{notificationOnly,onResponseReady})=>{asks++;assert.equal(input.sessionId,'origin-session');assert.equal(input.source.sourceKind,'deployment_result');assert.equal(notificationOnly,true);assert.match(content,/not authorization/);await onResponseReady('Verified status: completed.');},send:async(_ch,text)=>{sends++;assert.equal(text,'Verified status: completed.');return {messageId:'discord-delivery-42'};},now:()=>1000});
  assert.equal(result,true); assert.equal(asks,1); assert.equal(sends,1); assert.equal(deployCalls,0);
  assert.equal(f.store.pendingDeploymentEvents().length,0);
  f.store.close();
  const reopened=new Store(join(f.dir,'store.sqlite'));
  assert.equal(reopened.pendingDeploymentEvents().length,0);
  reopened.close();
 } finally { try{f.close();}catch{} }
});

test('model 408 uses bounded delayed notification-only retry; Discord ambiguous send requires reconciliation, no resend',async()=>{
 const f=fixture(); let attempts=0,sendAttempts=0,deployAttempts=0;
 try {
  await assert.rejects(processDeploymentResultEvent(f.store,f.event,{ask:async()=>{attempts++;throw Object.assign(new Error('408 timeout'),{status:408});},send:async()=>({messageId:''}),now:()=>0}),/408/);
  assert.equal(attempts,1); assert.equal(deployAttempts,0);
  const waiting=f.store.pendingDeploymentEvents(); assert.equal(waiting.length,1); assert.ok(waiting[0].next_attempt_at);
  await processDeploymentResultEvent(f.store,waiting[0],{ask:async(_input,_content,{onResponseReady})=>{attempts++;await onResponseReady('Verified after retry');},send:async()=>{sendAttempts++;return {messageId:'message-after-retry'};},now:()=>Date.now()});
  assert.equal(attempts,2); assert.equal(sendAttempts,1); assert.equal(deployAttempts,0);
  assert.equal(f.store.pendingDeploymentEvents().length,0);
 } finally { f.close(); }
 sendAttempts=0;
 const g=fixture();
 try {
  await assert.rejects(processDeploymentResultEvent(g.store,g.event,{ask:async(_input,_content,{onResponseReady})=>onResponseReady('status'),send:async()=>{sendAttempts++;throw new Error('socket closed after send');}}));
  assert.equal(g.store.pendingDeploymentEvents().length,0);
  g.store.close(); const reopened=new Store(join(g.dir,'store.sqlite'));
  assert.equal(reopened.pendingDeploymentEvents().length,0); assert.equal(sendAttempts,1); assert.equal(deployAttempts,0);
  reopened.close();
 } finally { try{g.close();}catch{} }
});
