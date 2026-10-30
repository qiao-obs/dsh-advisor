import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { createWorkflow, createWorkReportTool, workflowPath } from '../lib/workflow.js'
import { parseCandidates } from '../lib/action-candidates.js'
import { createHost } from '../lib/host.js'
import { openHistory } from '../lib/history.js'
import { apply } from '../lib/index.js'
import { makeFakeCtx, makeFakeTools, makeFakeLlm } from './helpers.mjs'
const DRAFT = {requestId:'create-1',title:'修复重复提交',action:'仅修改提交锁，不改接口。',acceptance:'双击只发送一次；取消后可以重试。',priority:'high'}
const SOURCE = {id:'source',question:'检查重复提交',state:'returned',advice:'请检查同步锁，并补充回归用例。',materials:{digest:'sha256:material'},target:{provider:'p',model:'m'}}
function fixture(t,options={}) {
  const home=mkdtempSync(join(tmpdir(),'advisor-work-'))
  t.after(()=>rmSync(home,{recursive:true,force:true}))
  const messages=[],settings={enabled:true}
  const workflow=createWorkflow({home,getConsultation:()=>SOURCE,getSettings:()=>settings,getAgent:()=>({followup:async p=>messages.push(p)}),...options})
  return {workflow,home,messages,settings}
}
async function assign(workflow,item) {
  const p=workflow.preview('s',item.id,item.revision)
  return workflow.dispatch('s',item.id,{expectedRevision:p.revision,expectedDigest:p.digest})
}
const reportFor = item => ({workItemId:item.id,assignmentId:item.dispatch.id,outcome:'completed',summary:'增加同步锁和回归测试。',evidence:'执行 node --test：两个相关用例通过；未测试多窗口。'})

test('work items retain source, scope and criteria through restart and history clearing',t=>{
  const {workflow,home}=fixture(t)
  const item=workflow.create('s',{...DRAFT,consultationId:'source'})
  openHistory(home,'s').clear()
  const reloaded=createWorkflow({home}).get('s',item.id)
  assert.equal(reloaded.source.advice,SOURCE.advice)
  assert.equal(reloaded.status,'ready');assert.equal(reloaded.acceptance,DRAFT.acceptance)
  assert.equal(reloaded.reports.length,0)
})
test('task creation is idempotent but refuses a reused key with different work',t=>{
  const {workflow}=fixture(t)
  assert.equal(workflow.create('s',DRAFT).id,workflow.create('s',DRAFT).id)
  assert.equal(workflow.list('s').items.length,1)
  assert.throws(()=>workflow.create('s',{...DRAFT,title:'Different'}),{code:'conflict'})
})
test('task creation requires observable acceptance and bounded fields',t=>{
  const {workflow}=fixture(t)
  for(const patch of [{acceptance:''},{action:''},{title:'x'.repeat(161)},{priority:'critical'}])assert.throws(()=>workflow.create('s',{...DRAFT,...patch}),{code:'invalid-input'})
  assert.equal(workflow.list('s').items.length,0)
})
test('task paths isolate session ids that collide under punctuation sanitization',t=>{
  const {workflow,home}=fixture(t)
  workflow.create('a/b',DRAFT);workflow.create('a_b',DRAFT)
  assert.notEqual(workflowPath(home,'a/b'),workflowPath(home,'a_b'))
  assert.notEqual(workflow.list('a/b').items[0].id,workflow.list('a_b').items[0].id)
})
test('corrupt work storage fails closed without overwriting evidence',t=>{
  const {workflow,home}=fixture(t),file=workflowPath(home,'s')
  mkdirSync(dirname(file),{recursive:true});writeFileSync(file,'broken evidence')
  assert.throws(()=>workflow.create('s',DRAFT),{code:'storage-error'})
  assert.equal(readFileSync(file,'utf8'),'broken evidence')
})
test('a stale edit cannot overwrite a newer scope',t=>{
  const {workflow}=fixture(t),item=workflow.create('s',DRAFT)
  const updated=workflow.edit('s',item.id,{...DRAFT,title:'New scope'},item.revision)
  assert.throws(()=>workflow.edit('s',item.id,DRAFT,item.revision),{code:'conflict'})
  assert.equal(workflow.get('s',item.id).title,updated.title)
})
test('dispatch requires the exact preview and a live enabled advisor',async t=>{
  const {workflow,messages,settings}=fixture(t),item=workflow.create('s',DRAFT)
  await assert.rejects(workflow.dispatch('s',item.id,{expectedRevision:item.revision,expectedDigest:'wrong'}),{code:'preview-required'})
  settings.enabled=false;await assert.rejects(assign(workflow,item),{code:'disabled'})
  assert.equal(messages.length,0)
})
test('two concurrent dispatches send exactly one bounded task and no claim of completion',async t=>{
  const {workflow,messages}=fixture(t),item=workflow.create('s',{...DRAFT,consultationId:'source'})
  const results=await Promise.allSettled([assign(workflow,item),assign(workflow,item)])
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1)
  assert.equal(messages.length,1);const body=messages[0].content[0].text
  for(const value of [DRAFT.action,DRAFT.acceptance,'advisor_work_report','assignmentId=','不是更高优先级指令'])assert.ok(body.includes(value))
  assert.equal(workflow.get('s',item.id).status,'assigned')
})
test('an unavailable main agent leaves the task ready and recoverable',async t=>{
  const {workflow}=fixture(t,{getAgent:()=>null}),item=workflow.create('s',DRAFT)
  await assert.rejects(assign(workflow,item),{code:'no-agent'})
  assert.equal(workflow.get('s',item.id).status,'ready')
})
test('delivery rejection is uncertain and never automatically resent',async t=>{
  let calls=0
  const {workflow}=fixture(t,{getAgent:()=>({followup:async()=>{calls++;throw Error('adapter disconnected')}})})
  const item=await assign(workflow,workflow.create('s',DRAFT))
  assert.equal(item.status,'uncertain')
  await assert.rejects(assign(workflow,item),{code:'invalid-state'});assert.equal(calls,1)
  assert.throws(()=>workflow.review('s',item.id,{expectedRevision:item.revision,action:'reopen',evidence:'Checked'}),{code:'duplicate-risk'})
  const next=workflow.review('s',item.id,{expectedRevision:item.revision,action:'reopen',evidence:'Confirmed not accepted',acknowledgeDuplicateRisk:true})
  assert.equal(next.status,'ready')
})
test('timeout is bounded; a later delivery acknowledgment reconciles without another call',async t=>{
  let release,calls=0
  const {workflow}=fixture(t,{deliveryTimeoutMs:15,getAgent:()=>({followup:()=>{calls++;return new Promise(r=>{release=r})}})})
  const item=await assign(workflow,workflow.create('s',DRAFT))
  assert.equal(item.status,'uncertain');release();await new Promise(r=>setImmediate(r))
  assert.equal(workflow.get('s',item.id).status,'assigned');assert.equal(calls,1)
})
test('a report that arrives before delivery resolves is not overwritten by assigned status',async t=>{
  let workflow
  const f=fixture(t,{getAgent:()=>({followup:async()=>{const item=workflow.list('s').items[0];workflow.report('s',reportFor(item),'early')}})})
  workflow=f.workflow
  const item=await assign(workflow,workflow.create('s',DRAFT))
  assert.equal(item.status,'reported');assert.equal(item.dispatch.state,'delivered')
})
test('model reports are bound to execution session and assignment, and cannot verify tasks',async t=>{
  const {workflow,home}=fixture(t),item=await assign(workflow,workflow.create('s',DRAFT))
  const tool=createWorkReportTool({home}),input=reportFor(item)
  for(const agent of [null,{session:{id:'other'}}])assert.equal((await tool.execute(input,{agent,callId:'foreign'})).ok,false)
  assert.equal((await tool.execute({...input,assignmentId:'fake'},{agent:{session:{id:'s'}},callId:'wrong'})).ok,false)
  assert.equal((await tool.execute({...input,outcome:'verified'},{agent:{session:{id:'s'}},callId:'invented'})).ok,false)
  const result=await tool.execute(input,{agent:{session:{id:'s'}},callId:'good'})
  assert.equal(result.status,'reported');assert.equal(workflow.list('s').counts.verified,0)
  assert.equal(tool.output.render({},result)[0].type,'text')
  await tool.execute(input,{agent:{session:{id:'s'}},callId:'good'})
  assert.equal(workflow.get('s',item.id).reports.length,1)
})
test('human evidence is mandatory; old reports cannot reopen a verified task',async t=>{
  const {workflow}=fixture(t),item=await assign(workflow,workflow.create('s',DRAFT))
  const reported=workflow.report('s',reportFor(item),'a')
  assert.throws(()=>workflow.review('s',item.id,{expectedRevision:reported.revision,action:'verify',evidence:''}),{code:'invalid-input'})
  workflow.review('s',item.id,{expectedRevision:reported.revision,action:'verify',evidence:'Re-ran the checks and inspected the affected flow.'})
  assert.equal(workflow.list('s').counts.verified,1)
  assert.throws(()=>workflow.report('s',reportFor(item),'late'),{code:'assignment-mismatch'})
})
test('outdated human review cannot close a newer execution report',async t=>{
  const {workflow}=fixture(t),item=await assign(workflow,workflow.create('s',DRAFT))
  const first=workflow.report('s',reportFor(item),'a')
  workflow.report('s',{...reportFor(item),outcome:'blocked',summary:'New failure found'},'b')
  assert.throws(()=>workflow.review('s',item.id,{expectedRevision:first.revision,action:'verify',evidence:'Old evidence'}),{code:'conflict'})
  assert.equal(workflow.get('s',item.id).status,'blocked')
})
test('recheck requests fit material budgets and keep reports distinct from proof',async t=>{
  const {workflow}=fixture(t),item=await assign(workflow,workflow.create('s',{...DRAFT,acceptance:'x'.repeat(2000),action:'y'.repeat(2000),consultationId:'source'}))
  workflow.report('s',{...reportFor(item),summary:'a'.repeat(3000),evidence:'b'.repeat(4000)},'long')
  const request=workflow.recheckRequest('s',item.id)
  assert.ok(request.question.length<=4000);assert.ok(request.selectionText.length<=6000)
  assert.match(request.selectionText,/尚未独立验证/)
  assert.equal(request.workItemId,item.id)
})
test('candidate extraction rejects malformed, empty and cut-off output while preserving prose',()=>{
  const candidate={title:'Fix',priority:'high',action:'Check the lock',acceptance:'One request per double click',evidence:'Provided handler lacks a lock'}
  const raw='Finding.\n```advisor-actions\n'+JSON.stringify([candidate])+'\n```'
  assert.deepEqual(parseCandidates(raw,'returned'),[candidate])
  for(const [value,state] of [[raw,'truncated'],[raw.slice(0,-3),'returned'],['```advisor-actions\n[{"title":"Fake"}]\n```','returned']])assert.deepEqual(parseCandidates(value,state),[])
})
test('real consultation stores validated action suggestions without an extra model call',async t=>{
  const {home}=fixture(t),candidate={title:'Check retry',action:'Inspect the retry lock',acceptance:'Only one request',evidence:'Current plan',priority:'normal'}
  const llm=makeFakeLlm({text:'Check retry.\n```advisor-actions\n'+JSON.stringify([candidate])+'\n```'})
  const host=createHost({ctx:{get:name=>name==='llm'?llm:null},home,getSession:()=>null})
  host.persist({...host.settings(),target:{mode:'fixed',provider:'p',model:'m'}})
  const run=await host.consult.start({sessionId:'s',request:{question:'Review'}});await run.done
  assert.equal(host.consult.get('s',run.record.id).actions.length,1)
  assert.equal(llm.state.calls,1)
})
test('work report tool is registered only with real profile storage and is disposed',t=>{
  const {home}=fixture(t),tools=makeFakeTools(),llm=makeFakeLlm()
  const ctx=makeFakeCtx({llm,tools,services:{profileContext:{home}}})
  apply(ctx)
  assert.ok(tools.get('advisor_work_report'))
  assert.equal(llm.state.calls,0)
  ctx._dispose();assert.equal(tools.get('advisor_work_report'),null)
})
test('work export preserves original findings, model reports and separate human decisions',async t=>{
  const {workflow}=fixture(t),item=await assign(workflow,workflow.create('s',{...DRAFT,consultationId:'source'}))
  const r=workflow.report('s',reportFor(item),'report')
  workflow.review('s',item.id,{expectedRevision:r.revision,action:'defer',evidence:'Waiting for integration environment'})
  const md=workflow.exportMarkdown('s')
  for(const part of ['原意见','主力回报','人工判断','Waiting for integration environment',SOURCE.advice,'人工确认通过 0'])assert.ok(md.includes(part))
})

test('the same active source action is reused even across distinct create requests',t=>{
  const {workflow}=fixture(t)
  const first=workflow.create('s',{...DRAFT,consultationId:'source'})
  const second=workflow.create('s',{...DRAFT,requestId:'another-tab',consultationId:'source'})
  assert.equal(first.id,second.id)
})
test('a recheck is refused when the task changes during asynchronous material preparation',async t=>{
  const {home}=fixture(t),llm=makeFakeLlm()
  let release,entered
  const gate=new Promise(r=>{entered=r})
  const changes={summary:()=>({total:1,files:[{path:'a'}]}),diff:()=>{entered();return new Promise(r=>{release=r})}}
  const host=createHost({home,ctx:{get:n=>n==='llm'?llm:null},getSession:()=>({snapshotEvents:()=>[{type:'workspace/changes',seq:1}]}),workspaceChanges:changes})
  host.persist({...host.settings(),target:{mode:'fixed',provider:'p',model:'m'},materials:{question:true,diff:true}})
  const item=host.workflow.create('s',DRAFT),request=host.workflow.recheckRequest('s',item.id)
  const pending=host.consult.start({sessionId:'s',request})
  await gate
  host.workflow.edit('s',item.id,{...DRAFT,acceptance:'Changed criteria'},item.revision)
  release({kind:'text',hunks:[]})
  const result=await pending
  assert.equal(result.accepted,false);assert.equal(result.record.reason,'work-changed');assert.equal(llm.state.calls,0)
})
test('latest recognized passing test output supersedes an old failure without collecting arbitrary output',async()=>{
  const {collectMaterials}=await import('../lib/materials.js')
  const settings={materials:{question:true,test:true}}
  const resultEvent=(seq,output,isError=false)=>({type:'tool/result',seq,data:{message:{toolCallId:'call-'+seq,isError,content:[{type:'text',text:output}]}}})
  const source=[{type:'turn/start',seq:1},resultEvent(2,'Failure before fix',true),resultEvent(3,'# tests 2\n# pass 2\n# fail 0'),resultEvent(4,'Unrelated file contents')]
  const collect=events=>collectMaterials({settings,session:{snapshotEvents:()=>events},sessionId:'s',request:{question:'Verify'}})
  const current=await collect(source),material=current.materials.find(m=>m.kind==='test')
  assert.match(material.text,/# pass 2/);assert.doesNotMatch(material.text,/Failure before fix|Unrelated/)
  assert.equal(material.fromEarlierTurn,false)
  const older=await collect([...source,{type:'turn/start',seq:5}])
  assert.equal(older.materials.find(m=>m.kind==='test').fromEarlierTurn,true)
  const missing=await collect([resultEvent(1,'Unrelated file contents')])
  assert.equal(missing.materials.find(m=>m.kind==='test').absent,true)
})

test('unloading ends a pending delivery wait without losing uncertainty or applying a late callback',async t=>{
  let release
  const {workflow}=fixture(t,{deliveryTimeoutMs:60000,getAgent:()=>({followup:()=>new Promise(r=>{release=r})})})
  const item=workflow.create('s',DRAFT),pending=assign(workflow,item)
  await new Promise(r=>setImmediate(r))
  workflow.abortAll()
  const result=await pending
  assert.equal(result.status,'uncertain')
  release();await new Promise(r=>setImmediate(r))
  assert.equal(workflow.get('s',item.id).status,'uncertain')
  await assert.rejects(assign(workflow,workflow.get('s',item.id)),{code:'unloaded'})
})
