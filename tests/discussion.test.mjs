import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,rmSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {createHost} from '../lib/host.js'
import {createDiscussionTool,parseReview} from '../lib/discussion.js'
import {makeFakeLlm} from './helpers.mjs'
const score={verdict:'revise',summary:'增加取消后重试验证，范围保持不变。',nextPrompt:'先复现取消后重试，再修复锁复位并回报真实结果。',scores:[{dimension:'correctness',score:null,reason:'未提供实现，不能判断。'},{dimension:'coverage',score:2,reason:'取消路径缺少覆盖。'},{dimension:'evidence',score:1,reason:'仅有叙述，需测试输出。'}]}
const reply='请先验证取消后的状态复位。\n```advisor-review\n'+JSON.stringify(score)+'\n```'
function fixture(t){
 const home=mkdtempSync(join(tmpdir(),'dsha-dialogue-'));t.after(()=>rmSync(home,{recursive:true,force:true}))
 const llm=makeFakeLlm({text:reply}),deliveries=[]
 const host=createHost({home,ctx:{get:n=>n==='llm'?llm:n==='agents'?{get:()=>({followup:async p=>deliveries.push(p)})}:null},getSession:()=>null})
 host.persist({...host.settings(),target:{mode:'fixed',provider:'p',model:'m'}});t.after(()=>host.abortAll())
 const item=host.workflow.create('s',{requestId:'draft',title:'处理取消路径',action:'只修复取消后的锁。',acceptance:'取消后可以重试，双击只发一次。',priority:'high'})
 return {host,item,llm,deliveries,home,tool:createDiscussionTool({getService:()=>host.discussion})}
}
function enable(host,id,rounds=3){const p=host.discussion.policyPreview('s',id,rounds);return host.discussion.enable('s',id,{maxRounds:rounds,expectedRevision:p.revision,expectedDigest:p.digest})}
async function assign(host,id){const i=host.workflow.get('s',id),p=host.workflow.preview('s',id,i.revision);return host.workflow.dispatch('s',id,{expectedRevision:p.revision,expectedDigest:p.digest})}
const input=(id,requestId='round1')=>({requestId,phase:'plan',message:'请整理最小执行顺序。',evidence:'取消路径没有回归记录。'})
test('task collaboration requires exact scope/target preview and explicit grant',async t=>{
 const {host,item,llm}=fixture(t)
 assert.throws(()=>host.discussion.ask('s',item.id,input(item.id),'user'),{code:'no-consent'})
 const p=host.discussion.policyPreview('s',item.id,2)
 host.persist({...host.settings(),target:{mode:'fixed',provider:'p',model:'new'}})
 assert.throws(()=>host.discussion.enable('s',item.id,{maxRounds:2,expectedRevision:p.revision,expectedDigest:p.digest}),{code:'preview-required'})
 assert.equal(llm.state.calls,0)
})
test('user plan returns scorecard, preserves actual material and joins the next executor package',async t=>{
 const {host,item,llm,deliveries}=fixture(t);enable(host,item.id)
 const result=await host.discussion.ask('s',item.id,input(item.id),'user')
 assert.equal(result.ok,true);assert.deepEqual(result.round.review,score)
 assert.match(result.round.materialText,/验收条件/)
 assert.equal(llm.state.calls,1);assert.equal(deliveries.length,0)
 const assigned=await assign(host,item.id)
 assert.equal(assigned.status,'assigned');assert.match(deliveries[0].content[0].text,/advisor_work_discuss/)
 assert.ok(deliveries[0].content[0].text.includes(score.nextPrompt))
 assert.equal(host.workflow.list('s').counts.verified,0)
})
test('executor-to-advisor replies return directly, use actual session and enforce assignment',async t=>{
 const {host,item,llm,tool}=fixture(t);enable(host,item.id);const assigned=await assign(host,item.id)
 const args={workItemId:item.id,assignmentId:assigned.dispatch.id,phase:'clarify',message:'为何需要验证取消？'}
 assert.equal((await tool.execute(args,{agent:{session:{id:'other'}},callId:'x'})).ok,false)
 assert.equal((await tool.execute({...args,assignmentId:'wrong'},{agent:{session:{id:'s'}},callId:'y'})).ok,false)
 const result=await tool.execute(args,{agent:{session:{id:'s'}},callId:'good'})
 assert.equal(result.ok,true);assert.equal(result.round.actor,'model');assert.ok(tool.output.render({},result)[0].text.includes(score.nextPrompt))
 assert.equal(llm.state.calls,1)
})
test('replayed tool calls and parallel requests cannot spend extra rounds',async t=>{
 const {host,item,llm}=fixture(t);enable(host,item.id,1)
 const a=host.discussion.ask('s',item.id,input(item.id),'user'),b=host.discussion.ask('s',item.id,input(item.id),'user')
 assert.equal((await a).round.id,(await b).round.id)
 await host.discussion.ask('s',item.id,input(item.id),'user')
 assert.equal(llm.state.calls,1)
 assert.throws(()=>host.discussion.ask('s',item.id,input(item.id,'new'),'user'),{code:'round-limit'})
})
test('scope, selected model, material setting and paused grant cannot be silently bypassed',async t=>{
 const {host,item,llm}=fixture(t);enable(host,item.id)
 host.discussion.pause('s',item.id)
 assert.throws(()=>host.discussion.ask('s',item.id,input(item.id),'user'),{code:'no-consent'})
 enable(host,item.id);const current=host.workflow.get('s',item.id)
 host.workflow.edit('s',item.id,{...current,action:'扩大到其他文件'},current.revision)
 assert.throws(()=>host.discussion.ask('s',item.id,input(item.id),'user'),{code:'scope-changed'})
 enable(host,item.id);host.persist({...host.settings(),materials:{...host.settings().materials,selection:false}})
 assert.throws(()=>host.discussion.ask('s',item.id,input(item.id),'user'),{code:'disabled'});assert.equal(llm.state.calls,0)
})
test('pause during preparation cancels authority before any paid call',async t=>{
 const {host,item,llm}=fixture(t);enable(host,item.id)
 const promise=host.discussion.ask('s',item.id,input(item.id),'user')
 host.discussion.pause('s',item.id)
 const result=await promise
 assert.equal(result.ok,false);assert.equal(result.round.state,'stale');assert.equal(result.round.advice,'');assert.equal(llm.state.calls,0)
})
test('new report while advisor thinks makes the answer stale instead of overwriting execution',async t=>{
 const {host,item,llm}=fixture(t);enable(host,item.id);const assigned=await assign(host,item.id)
 let release,started;const ready=new Promise(r=>{started=r})
 llm.stream=()=> (async function*(){started();await new Promise(r=>{release=r});yield {type:'text-delta',text:reply};yield {type:'finish',reason:{kind:'stop'}}})()
 const promise=host.discussion.ask('s',item.id,{...input(item.id),assignmentId:assigned.dispatch.id},'model');await ready
 host.workflow.report('s',{workItemId:item.id,assignmentId:assigned.dispatch.id,outcome:'completed',summary:'新的修改',evidence:'新的检查'},'new-report')
 release();const result=await promise
 assert.equal(result.ok,false);assert.equal(result.round.state,'stale');assert.equal(result.round.review,null)
 assert.equal(host.workflow.get('s',item.id).status,'reported')
})
test('score parsing rejects malformed, out-of-range, duplicate dimensions and truncation',()=>{
 assert.deepEqual(parseReview(reply,'returned'),score)
 for(const value of [{...score,scores:[...score.scores.slice(0,2),score.scores[0]]},{...score,scores:score.scores.map(s=>({...s,score:6}))},{...score,nextPrompt:''}])assert.equal(parseReview('```advisor-review\n'+JSON.stringify(value)+'\n```','returned'),null)
 assert.equal(parseReview(reply,'truncated'),null);assert.equal(parseReview('A normal opinion','returned'),null)
})

test('task grants cannot bypass the shared session consultation allowance',async t=>{
 const {host,item,llm}=fixture(t)
 host.persist({...host.settings(),advanced:{...host.settings().advanced,maxConsultationsPerSession:1}})
 // Use the actual persisted setting name used by the consultation service.
 const settings=host.settings();assert.equal(settings.advanced.maxConsultationsPerSession,1)
 enable(host,item.id,3)
 await host.discussion.ask('s',item.id,input(item.id),'user')
 const second=await host.discussion.ask('s',item.id,input(item.id,'second'),'user')
 assert.equal(second.ok,false);assert.equal(llm.state.calls,1)
})
test('cached answers are withheld after pause rather than reviving old authority',async t=>{
 const {host,item,llm}=fixture(t);enable(host,item.id)
 await host.discussion.ask('s',item.id,input(item.id),'user')
 host.discussion.pause('s',item.id)
 const cached=await host.discussion.ask('s',item.id,input(item.id),'user')
 assert.equal(cached.ok,false);assert.equal(cached.round.advice,'');assert.equal(llm.state.calls,1)
})

test('review materials keep full task criteria and all check states within the allowed excerpt budget',async t=>{
 const {host,item}=fixture(t)
 let current=host.workflow.get('s',item.id)
 host.workflow.edit('s',item.id,{...current,action:'a'.repeat(2000),acceptance:'z'.repeat(2000)},current.revision)
 enable(host,item.id);current=await assign(host,item.id)
 host.workflow.report('s',{workItemId:item.id,assignmentId:current.dispatch.id,outcome:'completed',summary:'s'.repeat(3000),evidence:'e'.repeat(4000),checks:Array.from({length:12},(_,n)=>({label:'check'+n+'x'.repeat(180),status:n===11?'failed':'not_run',evidence:'e'.repeat(800)}))},'report')
 const result=await host.discussion.ask('s',item.id,{requestId:'review-big',assignmentId:current.dispatch.id,phase:'review',message:'Review',evidence:'b'.repeat(2500)},'model')
 assert.equal(result.ok,true);assert.ok(result.round.materialText.includes('z'.repeat(2000)))
 for(let n=0;n<12;n++)assert.ok(result.round.materialText.includes('check'+n))
 assert.match(result.round.materialText,/failed: check11/)
 const consultation=host.consult.get('s',result.round.consultationId)
 assert.equal(consultation.materials.truncated.includes('selection'),false)
})

test('material revocation during preparation prevents the advisor request',async t=>{
 const {host,item,llm}=fixture(t);enable(host,item.id)
 const pending=host.discussion.ask('s',item.id,input(item.id),'user')
 host.persist({...host.settings(),materials:{...host.settings().materials,selection:false}})
 const result=await pending
 assert.equal(result.ok,false);assert.equal(llm.state.calls,0)
})
test('past review ratings become historical when a newer report arrives',async t=>{
 const {host,item}=fixture(t);enable(host,item.id);const assigned=await assign(host,item.id)
 await host.discussion.ask('s',item.id,{...input(item.id),phase:'review',assignmentId:assigned.dispatch.id},'model')
 host.workflow.report('s',{workItemId:item.id,assignmentId:assigned.dispatch.id,outcome:'completed',summary:'最新改动',evidence:'新的测试结果'},'newer')
 assert.equal(host.workflow.list('s').items[0].discussion.rounds[0].outdated,true)
 assert.equal(host.workflow.context('s',item.id).task.discussion.rounds[0].outdated,true)
})
