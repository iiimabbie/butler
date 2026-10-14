import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../dist/store.js';
import { processDeploymentResultEvent } from '../dist/deployment-notifications.js';
import { DiscordHandler } from '../dist/discord.js';
import { ask, executeCall } from '../dist/agent.js';

function fixture() {
 const dir=mkdtempSync(join(tmpdir(),'butler-notify-mock-')), store=new Store(join(dir,'store.sqlite'));
 store.createDeploymentRequest({id:'dep-x',parentSession:'origin-session',channelId:'channel',messageId:'source-msg',requesterId:'user'});
 store.claimDeploymentRequest('dep-x'); store.completeDeployment('dep-x','completed',{id:'dep-x',status:'completed',buildDigest:'digest'});
 const event=store.pendingDeploymentEvents()[0];
 return {dir,store,event,close(){store.close();rmSync(dir,{recursive:true,force:true});}};
}

test('ask exposes only scoped status tool for deployment events and keeps general tools',async()=>{
 const f=fixture();
 try {
  const session=f.store.channelState('channel','mock').sessionId;
  f.store.db.prepare('update deployment_requests set parent_session_id=? where id=?').run(session,'dep-x');
  const input=f.store.deploymentEventInput(String(f.event.id),session,'internal result',{sourceKind:'deployment_result',channelId:'channel'});
  const inspect=async(config)=>{
   let posted;
   const fetcher=async(url,options)=>{
    if (String(url).endsWith('/messages/count_tokens')) return new Response(JSON.stringify({input_tokens:1}),{status:200});
    posted=JSON.parse(options.body);
    return new Response(JSON.stringify({output:[],output_text:'確認完成'}),{status:200});
   };
   await ask(f.store,session,'internal result',{baseUrl:'https://mock.invalid',model:'mock',fetcher,storedInput:input,workspaceDirectory:f.dir,...config});
   return posted.tools;
  };
  const scoped=await inspect({deploymentResultEvent:true,deploymentResultStatus:()=>f.store.deploymentResultEvidence('dep-x')});
  assert.deepEqual(scoped.map(tool=>tool.name),['deployment_result_status']);
  const none=await inspect({deploymentResultEvent:true}); assert.deepEqual(none,[]);
  const general=await inspect({}); assert.ok(general.some(tool=>tool.name==='current_time'));
 } finally { f.close(); }
});

test('model uses bound status tool then sends its natural reply and records delivery',async()=>{
 const f=fixture(), order=[]; let sends=0, asks=0;
 try {
  const result=await processDeploymentResultEvent(f.store,f.event,{ask:async(input,content,{notificationOnly,deploymentId,readDeploymentStatus,onResponseReady})=>{
   asks++; order.push('ask'); assert.equal(input.sessionId,'origin-session'); assert.equal(input.source.sourceKind,'deployment_result'); assert.equal(notificationOnly,true); assert.equal(deploymentId,'dep-x');
   assert.match(content,/natural, concise Traditional Chinese notification/i); assert.match(content,/not claim that completion proves current service health/i);
   assert.equal(readDeploymentStatus().id,'dep-x');
   assert.equal(f.store.db.prepare('select status from deployment_result_events').get().status,'processing');
   await onResponseReady('部署已完成，部署識別碼 dep-x。');
  },send:async(_ch,text,onAttempt)=>{await onAttempt?.(); sends++; order.push('send'); assert.equal(text,'部署已完成，部署識別碼 dep-x。'); return {messageId:'delivery-1'};},recordOutgoing:()=>order.push('record'),logSupplementError:()=>{throw Error('unexpected') }});
  assert.equal(result,true); assert.deepEqual(order,['ask','send','record']); assert.equal(sends,1); assert.equal(asks,1);
  const event=f.store.db.prepare('select status,delivery_message_id from deployment_result_events').get();
  assert.equal(event.status,'delivered'); assert.equal(event.delivery_message_id,'delivery-1');
  assert.equal(f.store.pendingDeploymentEvents().length,0);
 } finally { f.close(); }
});

test('[no_reply] never sends or marks delivered and remains retryable',async()=>{
 const f=fixture(); let sends=0;
 try {
  await assert.rejects(processDeploymentResultEvent(f.store,f.event,{ask:async(_i,_c,{onResponseReady})=>onResponseReady('[no_reply]'),send:async()=>{sends++;return {messageId:'unused'};},now:()=>0}),/no user notification/);
  assert.equal(sends,0); assert.equal(f.store.db.prepare('select status from deployment_result_events').get().status,'failed_unknown');
 } finally { f.close(); }
});

test('missing or malformed result evidence retries without send/ask or stuck processing',async()=>{
 for (const mode of ['missing','invalid']) {
  const f=fixture(); let sends=0,asks=0;
  try {
   if (mode==='missing') f.store.deploymentResultEvidence=()=>undefined;
   else f.store.db.prepare('update deployment_requests set result_json=? where id=?').run('{invalid-json','dep-x');
   await assert.rejects(processDeploymentResultEvent(f.store,f.event,{ask:async()=>{asks++;},send:async()=>{sends++;return {messageId:'unused'};},now:()=>0}));
   assert.equal(sends,0); assert.equal(asks,0);
   const row=f.store.db.prepare('select status,next_attempt_at from deployment_result_events').get();
   assert.equal(row.status,'failed_unknown'); assert.ok(row.next_attempt_at);
   assert.equal(f.store.pendingDeploymentEvents().length,1);
  } finally { f.close(); }
 }
});

test('model failure before send is bounded retryable; outgoing failure after delivery cannot undo it',async()=>{
 const f=fixture(); let sends=0, errors=0;
 try {
  await assert.rejects(processDeploymentResultEvent(f.store,f.event,{ask:async()=>{throw Error('model unavailable');},send:async()=>{sends++;return {messageId:'unused'};},now:()=>0}),/model unavailable/);
  assert.equal(sends,0);
  assert.equal(f.store.db.prepare('select status from deployment_result_events').get().status,'failed_unknown');
  const waiting=f.store.pendingDeploymentEvents()[0];
  await processDeploymentResultEvent(f.store,waiting,{ask:async(_input,_content,{onResponseReady})=>onResponseReady('Model-generated result'),send:async(_ch,_text,onAttempt)=>{await onAttempt?.();sends++;return {messageId:'delivered-id'};},recordOutgoing:()=>{throw Error('outgoing record unavailable');},logSupplementError:()=>errors++});
  assert.equal(sends,1); assert.equal(errors,1);
  const row=f.store.db.prepare('select status,delivery_message_id from deployment_result_events').get();
  assert.equal(row.status,'delivered'); assert.equal(row.delivery_message_id,'delivered-id');
  assert.equal(f.store.pendingDeploymentEvents().length,0);
 } finally { f.close(); }
});

test('unavailable channel retries; ambiguous send requires reconciliation without resend',async()=>{
 const f=fixture(); let sendAttempts=0;
 try {
  await assert.rejects(processDeploymentResultEvent(f.store,f.event,{ask:async(_i,_c,{onResponseReady})=>onResponseReady('Model reply'),send:async()=>{throw Error('channel unavailable');},now:()=>0}),/channel unavailable/);
  const waiting=f.store.pendingDeploymentEvents(); assert.equal(waiting.length,1); assert.ok(waiting[0].next_attempt_at);
  await assert.rejects(processDeploymentResultEvent(f.store,waiting[0],{ask:async(_i,_c,{onResponseReady})=>onResponseReady('Model reply'),send:async(_ch,_text,onAttempt)=>{await onAttempt?.();sendAttempts++;throw Error('socket closed after send');}}));
  assert.equal(sendAttempts,1); assert.equal(f.store.pendingDeploymentEvents().length,0);
  assert.equal(f.store.db.prepare('select status from deployment_result_events').get().status,'needs_reconciliation');
 } finally { f.close(); }
});

test('retry reads latest persisted result; tool callback bound to deployment and other tools rejected',async()=>{
 const f=fixture(); let seen='';
 try {
  f.store.completeDeployment('dep-x','needs_reconciliation',{status:'needs_reconciliation',reason:'intermediate'});
  f.store.completeDeployment('dep-x','failed',{id:'dep-x',status:'failed',phase:'healthcheck'});
  const event=f.store.pendingDeploymentEvents()[0];
  await processDeploymentResultEvent(f.store,event,{ask:async(_input,content,{deploymentId,readDeploymentStatus,onResponseReady})=>{seen=content;assert.equal(deploymentId,'dep-x');const status=await executeCall(f.store,'origin-session',{call_id:'bound-status',name:'deployment_result_status',arguments:'{"label":"verify deployment result"}'},{deploymentResultEvent:true,deploymentResultStatus:readDeploymentStatus});assert.equal(status.id,'dep-x');await onResponseReady('Model reports failed healthcheck.');},send:async(_ch,text,onAttempt)=>{await onAttempt?.();assert.equal(text,'Model reports failed healthcheck.');return {messageId:'latest-id'};}});
  assert.match(seen,/healthcheck/);
  const callback=()=>f.store.deploymentResultEvidence('dep-x');
  assert.equal(callback().id,'dep-x');
  await assert.rejects(executeCall(f.store,'origin-session',{call_id:'bad',name:'local_read',arguments:'{}'},{deploymentResultEvent:true,deploymentResultStatus:callback}),/not authorized/);
  await assert.rejects(executeCall(f.store,'origin-session',{call_id:'extra',name:'deployment_result_status',arguments:'{"label":"check","deploymentId":"dep-other","path":"/tmp/x"}'},{deploymentResultEvent:true,deploymentResultStatus:callback}),/not authorized/);
  await assert.rejects(executeCall(f.store,'origin-session',{call_id:'nocallback',name:'deployment_result_status',arguments:'{"label":"check"}'},{deploymentResultEvent:true}),/not authorized/);
  const result=await executeCall(f.store,'origin-session',{call_id:'good',name:'deployment_result_status',arguments:'{"label":"check"}'},{deploymentResultEvent:true,deploymentResultStatus:callback});
  assert.equal(result.status,'failed');
 } finally { f.close(); }
});

test('result changed before first notification is sent as final version only',async()=>{
 const f=fixture();let seen='',sends=0;
 try {
  f.store.completeDeployment('dep-x','needs_reconciliation',{status:'needs_reconciliation',reason:'intermediate'});
  f.store.completeDeployment('dep-x','failed',{id:'dep-x',status:'failed',reason:'final'});
  const event=f.store.pendingDeploymentEvents()[0];
  await processDeploymentResultEvent(f.store,event,{ask:async(_i,content,{onResponseReady,readDeploymentStatus})=>{seen=content;assert.equal(readDeploymentStatus().status,'failed');await onResponseReady('最終結果失敗');},send:async(_ch,text,onAttempt)=>{await onAttempt?.();sends++;assert.equal(text,'最終結果失敗');return {messageId:'final-1'};}});
  assert.match(seen,/final/);assert.equal(sends,1);assert.equal(f.store.db.prepare('select status from deployment_result_events').get().status,'delivered');
 } finally {f.close();}
});

test('result changing during generation discards stale text and refreshes input',async()=>{
 const f=fixture();let asks=0,sends=0,inputs=[];
 try {
  f.store.completeDeployment('dep-x','needs_reconciliation',{status:'needs_reconciliation',reason:'restart'});
  const event=f.store.pendingDeploymentEvents()[0];
  await processDeploymentResultEvent(f.store,event,{ask:async(input,_content,{onResponseReady})=>{inputs.push(input.id);asks++;if(asks===1){f.store.completeDeployment('dep-x','completed',{id:'dep-x',status:'completed',final:true});await onResponseReady('過期暫態');}else await onResponseReady('最終完成');},send:async(_ch,text,onAttempt)=>{await onAttempt?.();sends++;assert.equal(text,'最終完成');return {messageId:'final-2'};}});
  assert.equal(asks,2);assert.equal(sends,1);assert.notEqual(inputs[0],inputs[1]);
 } finally {f.close();}
});

test('completed after delivered transient result queues exactly one final correction',async()=>{
 const f=fixture(),sendLog=[];
 try {
  f.store.completeDeployment('dep-x','needs_reconciliation',{status:'needs_reconciliation'});
  await processDeploymentResultEvent(f.store,f.store.pendingDeploymentEvents()[0],{ask:async(_i,_c,{onResponseReady})=>onResponseReady('待核對'),send:async(_ch,text,onAttempt)=>{await onAttempt?.();sendLog.push(text);return {messageId:'transient-id'};}});
  f.store.completeDeployment('dep-x','completed',{id:'dep-x',status:'completed'});
  f.store.completeDeployment('dep-x','completed',{id:'dep-x',status:'completed'});
  assert.equal(f.store.pendingDeploymentEvents().length,1);
  await processDeploymentResultEvent(f.store,f.store.pendingDeploymentEvents()[0],{ask:async(_i,_c,{onResponseReady,readDeploymentStatus})=>{assert.equal(readDeploymentStatus().status,'completed');await onResponseReady('最終完成');},send:async(_ch,text,onAttempt)=>{await onAttempt?.();sendLog.push(text);return {messageId:'final-id'};}});
  assert.deepEqual(sendLog,['待核對','最終完成']);assert.equal(f.store.pendingDeploymentEvents().length,0);
 } finally {f.close();}
});

test('result changes while send is in flight persist sent version and queue final version',async()=>{
 const f=fixture(),sendLog=[];
 try {
  f.store.completeDeployment('dep-x','needs_reconciliation',{status:'needs_reconciliation'});
  await processDeploymentResultEvent(f.store,f.store.pendingDeploymentEvents()[0],{ask:async(_i,_c,{onResponseReady})=>onResponseReady('暫態'),send:async(_ch,text,onAttempt)=>{await onAttempt?.();sendLog.push(text);f.store.completeDeployment('dep-x','completed',{status:'completed'});return {messageId:'transient-id'};}});
  const row=f.store.db.prepare('select status,delivered_version,target_version,delivery_message_id from deployment_result_events').get();
  assert.equal(row.status,'pending');assert.notEqual(row.delivered_version,row.target_version);assert.equal(row.delivery_message_id,'transient-id');
  await processDeploymentResultEvent(f.store,f.store.pendingDeploymentEvents()[0],{ask:async(_i,_c,{onResponseReady})=>onResponseReady('最終'),send:async(_ch,text,onAttempt)=>{await onAttempt?.();sendLog.push(text);return {messageId:'final-id'};}});
  assert.deepEqual(sendLog,['暫態','最終']);assert.equal(f.store.pendingDeploymentEvents().length,0);
 } finally {f.close();}
});

test('startup restores only durable pre-send claims; intent-bearing legacy and current claims reconcile',async()=>{
 const f=fixture();
 try {
  const eventId=String(f.event.id), claim=f.store.claimDeploymentEvent(eventId);
  assert.ok(claim?.attemptId);
  assert.equal(f.store.db.prepare('select send_phase from deployment_result_events').get().send_phase,'pre_send');
  f.store.close();
  const reopened=new Store(join(f.dir,'store.sqlite'));
  try {
   let row=reopened.db.prepare('select status,send_phase,claimed_version from deployment_result_events').get();
   assert.equal(row.status,'pending'); assert.equal(row.send_phase,null); assert.equal(row.claimed_version,null);
   const retry=reopened.claimDeploymentEvent(eventId); assert.ok(retry);
   assert.equal(reopened.persistDeploymentSendIntent(eventId,retry.version,retry.attemptId),true);
   reopened.close();
   const afterIntent=new Store(join(f.dir,'store.sqlite'));
   try {
    row=afterIntent.db.prepare('select status,send_phase from deployment_result_events').get(); assert.equal(row.status,'needs_reconciliation'); assert.equal(row.send_phase,'send_intent'); assert.equal(afterIntent.pendingDeploymentEvents().length,0);
    afterIntent.db.prepare("update deployment_result_events set status='processing',send_phase=NULL where id=?").run(eventId);
   } finally { afterIntent.close(); }
   const oldLegacyProcessing=new Store(join(f.dir,'store.sqlite'));
   try { row=oldLegacyProcessing.db.prepare('select status,send_phase from deployment_result_events').get(); assert.equal(row.status,'needs_reconciliation'); assert.equal(row.send_phase,null); assert.equal(oldLegacyProcessing.pendingDeploymentEvents().length,0); }
   finally {oldLegacyProcessing.close();}
  } finally { try { reopened.close(); } catch {} }
 } finally { try {f.close();} catch {} }
});

test('shutdown before REST call releases durable pre-send claim without sending',async()=>{
 const f=fixture(); let sent=0;
 try {
  const event=f.store.pendingDeploymentEvents()[0];
  const result=await processDeploymentResultEvent(f.store,event,{canSend:()=>false,ask:async(_i,_c,{onResponseReady})=>onResponseReady('準備完成通知'),send:async(_ch,_text,before)=>{if(await before()) sent++; return {messageId:'unused'};}});
  assert.equal(result,false); assert.equal(sent,0);
  const row=f.store.db.prepare('select status,send_phase,claimed_version from deployment_result_events').get();
  assert.equal(row.status,'pending'); assert.equal(row.send_phase,null); assert.equal(row.claimed_version,null);
 } finally {f.close();}
});

test('notification processing error remains primary when state persistence also fails',async()=>{
 const f=fixture(), original=new Error('model primary failure'); let logged;
 try {
  await assert.rejects(processDeploymentResultEvent(f.store,f.event,{ask:async()=>{f.store.close();throw original;},send:async()=>({messageId:'unused'}),logSupplementError:error=>{logged=error;}}),error=>error===original);
  assert.match(String(logged),/database is not open/);
 } finally {try {f.close();}catch{}}
});

test('DiscordHandler shutdown drains a claimed notification and prevents its not-yet-started REST send',async()=>{
 const f=fixture(); let enteredResolve,continueResolve; const entered=new Promise(resolve=>enteredResolve=resolve), continueAsk=new Promise(resolve=>continueResolve=resolve); let sent=0;
 try {
  const session=f.store.newSession();
  f.store.db.prepare('update deployment_requests set parent_session_id=? where id=?').run(session,'dep-x');
  const runtime={discord:{defaultModel:'mock',ownerId:'owner',baseUrl:'https://mock.invalid',apiKey:'mock',maxContextTokens:1000,modelContextTokens:1000},settings:{schedule:{timezone:'UTC'}}};
  const handler=new DiscordHandler(f.store,()=>runtime,async(_store,_session,_content,options)=>{enteredResolve();await continueAsk;await options.onResponseReady('自然語言通知');},undefined,undefined,undefined,undefined,{outputChannel:async()=>({send:async()=>{sent++;return {id:'not-sent'};}})});
  const poll=handler.processDeploymentResults(); handler.deploymentPollPromise=poll;
  await entered;
  const closing=handler.close();
  continueResolve();
  await closing;
  assert.equal(sent,0);
  const row=f.store.db.prepare('select status,send_phase from deployment_result_events').get();
  assert.equal(row.status,'pending'); assert.equal(row.send_phase,null);
 } finally {f.close();}
});
