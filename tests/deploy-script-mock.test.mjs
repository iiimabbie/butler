import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const sourceScript = resolve('scripts/butler-deploy.mjs');
function setup(mode = 'success') {
  const root = mkdtempSync(join(tmpdir(), 'butler-script-mock-'));
  for (const dir of ['scripts','src','dist','node_modules/typescript/bin','.data/service','.data/deploy']) mkdirSync(join(root,dir),{recursive:true});
  writeFileSync(join(root,'scripts/butler-deploy.mjs'), readFileSync(sourceScript));
  writeFileSync(join(root,'src','sample.ts'),'export const value = 1;');
  mkdirSync(join(root,'mock-dist'),{recursive:true});
  copyFileSync(resolve('dist/log.js'),join(root,'mock-dist','log.js'));
  writeFileSync(join(root,'mock-dist','config.js'),`export function readConfig(){ return { discord: { errorWebhookUrl: 'https://discord.com/api/webhooks/123/secret-test-only' } }; }`);
  writeFileSync(join(root,'fake-preload.mjs'),`globalThis.fetch = async (_url, init) => { if(process.env.ALERT_FAIL==='1') throw new Error('mock network failure'); await import('node:fs/promises').then(({appendFile})=>appendFile(process.env.ROOT+'/.data/deploy/alert.jsonl', init.body)); return new Response('',{status:200}); };`);
  writeFileSync(join(root,'dist','main.js'),'old build');
  writeFileSync(join(root,'dist','build-manifest.json'),JSON.stringify({buildId:'old-build',buildDigest:'old-digest'}));
  copyFileSync(join(root,'mock-dist','log.js'),join(root,'dist','log.js'));
  copyFileSync(join(root,'mock-dist','config.js'),join(root,'dist','config.js'));
  writeFileSync(join(root,'package.json'),'{"type":"module"}'); writeFileSync(join(root,'package-lock.json'),'{}'); writeFileSync(join(root,'tsconfig.json'),'{}');
  writeFileSync(join(root,'.data/service/app.pid'),String(process.pid));
  writeFileSync(join(root,'scripts/butler-service.sh'),`#!/bin/sh\nset -eu\ncase "$1" in\n deploy-stop) ${mode==='stop-fail'?'exit 21':'exit 0'};;\n deploy-start)\n  if [ -f "$ROOT/.data/deploy/start-count" ]; then n=$(cat "$ROOT/.data/deploy/start-count"); else n=0; fi; n=$((n+1)); echo $n > "$ROOT/.data/deploy/start-count"\n  ${mode==='start-fail'?'if [ "$n" -eq 1 ]; then exit 22; fi':mode.startsWith('rollback-fail')?'exit 22':''}\n  ${mode==='ready-timeout'?'exit 0':`pid=$(cat "$ROOT/.data/service/app.pid"); printf '{"ready":true,"buildId":"%s","buildDigest":"%s","pid":%s,"startupId":"mock-start"}' "${'${BUTLER_EXPECTED_BUILD_ID:-${BUTLER_BUILD_ID:-old-build}}'}" "${mode==='build-mismatch'?'wrong-digest':'${BUTLER_EXPECTED_BUILD_DIGEST:-${BUTLER_BUILD_DIGEST:-old-digest}}'}" "$pid" > "$ROOT/.data/service/butler.ready"; echo ready > "$ROOT/.data/service/butler.liveness"`}\n  exit 0;;\nesac\n`);
  // service mock gets a stable root without exposing any real service endpoint.
  const service=readFileSync(join(root,'scripts/butler-service.sh'),'utf8').replace('set -eu','set -eu\nROOT="'+root+'"'); writeFileSync(join(root,'scripts/butler-service.sh'),service); chmodSync(join(root,'scripts/butler-service.sh'),0o700);
  const fakeNode=join(root,'fake-node');
  writeFileSync(fakeNode,`#!/bin/sh\nif [ "$1" = "$ROOT/node_modules/typescript/bin/tsc" ]; then\n ${mode==='compile-fail'?'exit 17':'out=""; while [ $# -gt 0 ]; do [ "$1" = "--outDir" ] && { shift; out=$1; }; shift; done; mkdir -p "$out"; echo "export const built=true" > "$out/main.js"; cp "$ROOT/mock-dist/log.js" "$ROOT/mock-dist/config.js" "$out/"; exit 0'}\nfi\nexec node "$@"\n`); chmodSync(fakeNode,0o700);
  return {root,fakeNode};
}
async function run(mode) {
  const {root,fakeNode}=setup(mode), id=`test-${mode}`;
  const child=spawn(process.execPath,[join(root,'scripts/butler-deploy.mjs'),id],{cwd:root,env:{...process.env,ROOT:root,NODE_OPTIONS:mode.startsWith('rollback-fail')?`--import=${join(root,'fake-preload.mjs')}`:process.env.NODE_OPTIONS,ALERT_FAIL:mode==='rollback-fail-alert-fail'?'1':'0',BUTLER_NODE:fakeNode,BUTLER_DEPLOY_QUIESCE_POLLS:mode==='quiesce-timeout'?'1':'100',BUTLER_DEPLOY_QUIESCE_DELAY_MS:'5'},stdio:'ignore'});
  const exitPromise=new Promise(resolve=>child.once('exit',resolve));
  for(let i=0;i<200;i++){
    const request=join(root,'.data/service/deploy-request.json');
    if(existsSync(request)) { try { const v=JSON.parse(readFileSync(request,'utf8')); writeFileSync(join(root,'.data/service/deploy-quiesced.json'),JSON.stringify({id:v.id,nonce:v.nonce,pid:v.pid})); } catch {} }
    if(child.exitCode!==null) break;
    await delay(10);
  }
  const status=child.exitCode ?? await exitPromise;
  let result;
  const path=join(root,'.data/deploy',`${id}-result.json`);
  if(existsSync(path)) result=JSON.parse(readFileSync(path,'utf8'));
  return {root,status,result,cleanup:()=>rmSync(root,{recursive:true,force:true})};
}

test('mock deploy script success writes request-specific result and compatibility result', async()=>{
 const r=await run('success'); try { assert.equal(r.status,0); assert.equal(r.result.status,'completed'); assert.ok(r.result.buildDigest); assert.equal(JSON.parse(readFileSync(join(r.root,'.data/deploy/last-result.json'))).id,'test-success'); const file=join(r.root,'.data/deploy/test-success-result.json'), before=readFileSync(file,'utf8'); const replay=spawnSync(process.execPath,[join(r.root,'scripts/butler-deploy.mjs'),'test-success'],{cwd:r.root,env:{...process.env,BUTLER_NODE:join(r.root,'fake-node')},encoding:'utf8'}); assert.notEqual(replay.status,0); assert.equal(readFileSync(file,'utf8'),before); } finally {r.cleanup();}
});
for (const mode of ['compile-fail','stop-fail','start-fail','ready-timeout','build-mismatch','quiesce-timeout','rollback-fail','rollback-fail-alert-fail']) test(`mock deploy script records ${mode}`,async()=>{
 const r=await run(mode); try {
   assert.equal(r.status,1); assert.equal(r.result.status,'failed'); assert.ok(r.result.phase);
   if(mode==='start-fail') assert.equal(r.result.rollback,'restored_and_verified');
   if(mode==='rollback-fail') {
     assert.equal(r.result.rollback,'restored_start_failed'); assert.equal(JSON.parse(readFileSync(join(r.root,'.data/deploy','test-rollback-fail-alert.json'))).status,'delivered');
     const alert=JSON.parse(readFileSync(join(r.root,'.data/deploy/alert.jsonl'),'utf8'));
     assert.ok(alert.embeds[0].description.includes('deployment_id="test-rollback-fail"'));
     assert.doesNotMatch(JSON.stringify(alert),/secret-test-only|package.json|source|error:/i);
   }
   if(mode==='rollback-fail-alert-fail') {
     assert.equal(JSON.parse(readFileSync(join(r.root,'.data/deploy','test-rollback-fail-alert-fail-alert.json'))).status,'failed');
     assert.equal(JSON.parse(readFileSync(join(r.root,'.data/deploy','test-rollback-fail-alert-fail-result.json'))).status,'failed');
   }
 } finally {r.cleanup();}
});

test('restart wrapper keeps JSON build evidence separate from liveness marker',async()=>{
 const root=mkdtempSync(join(tmpdir(),'butler-ready-contract-'));
 mkdirSync(join(root,'scripts'),{recursive:true}); mkdirSync(join(root,'dist'),{recursive:true}); mkdirSync(join(root,'.data/service'),{recursive:true}); mkdirSync(join(root,'.data/deploy'),{recursive:true});
 copyFileSync(resolve('scripts/discord-restart.sh'),join(root,'scripts/discord-restart.sh'));
 const fake=join(root,'fake-node');
 writeFileSync(fake,`#!/bin/sh\ncase "$*" in\n *dist/main.js*) printf 'ready\\n' > "$BUTLER_RESTART_READY_FILE"; printf '{"ready":true,"buildId":"fixture","buildDigest":"abc","pid":1,"startupId":"test"}' > "$BUTLER_SERVICE_READY_FILE"; exec sleep 30;;\n *--record-baseline*) exit 0;;\nesac\nexit 0\n`); chmodSync(fake,0o700);
 const child=spawn('sh',[join(root,'scripts/discord-restart.sh')],{cwd:root,env:{...process.env,BUTLER_NODE:fake,BUTLER_SERVICE_READY_FILE:join(root,'.data/service/butler.ready'),BUTLER_SERVICE_LIVENESS_FILE:join(root,'.data/service/butler.liveness'),BUTLER_READY_TIMEOUT_SECONDS:'5'},stdio:'ignore'});
 try {
  for(let i=0;i<100&&!existsSync(join(root,'.data/service/butler.liveness'));i++) await delay(20);
  assert.equal(readFileSync(join(root,'.data/service/butler.liveness'),'utf8').trim(),'ready');
  assert.deepEqual(JSON.parse(readFileSync(join(root,'.data/service/butler.ready'),'utf8')),{ready:true,buildId:'fixture',buildDigest:'abc',pid:1,startupId:'test'});
 } finally { child.kill('SIGTERM'); await new Promise(resolve=>child.once('exit',resolve)); rmSync(root,{recursive:true,force:true}); }
});
