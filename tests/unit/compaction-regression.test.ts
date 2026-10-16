import { describe, expect, it } from 'vitest';
import { projectRuntime, type RuntimeProjection, type ProjectedSurfaceReplacement } from '../../packages/protocol/src/client/projection';
import { ContextProjector } from '../../packages/runtime-core/src/context-projector';
import { materializeSurface, selectCheckpointMessages } from '../../packages/runtime-core/src/surface-compactor';

function replacement(p: RuntimeProjection, seqs: number[], text: string, kind: 'checkpoint' | 'tool-prune' = 'checkpoint') {
  const value: ProjectedSurfaceReplacement = {
    compactionId: `c${p.surfaceReplacements.length}`, eventId: 'e', turnId: 'current', kind,
    shadowedSeqs: seqs, checkpointText: text, replacementRole: kind === 'tool-prune' ? 'tool' : 'system',
    surfaceGeneration: p.surfaceReplacements.length + 1, tokensBefore: 1000, tokensAfter: 10, createdAt: 'now',
    ...(kind === 'tool-prune' ? { toolCallId: 'tc' } : {}),
  };
  p.surfaceReplacements.push(value);
}
function request(p: RuntimeProjection) {
  return new ContextProjector().project({ projection: p, turnId: 'current', eventId: 'e',
    contextWindow: 100000, reservedOutputTokens: 1000, safetyTokens: 0, tools: [], skills: [] });
}
function step(p: RuntimeProjection, id: string, index: number, status: 'completed' | 'running' = 'completed') {
  p.steps.set(id, { id, turnId: 'current', eventId: 'e', stepIndex: index, status,
    startedAt: 'now', endedAt: status === 'completed' ? 'now' : null, requestContext: null });
}

describe('压缩后模型上下文完整性', () => {
  it('历史被当前 Turn 的检查点替换后，摘要进入当前请求且原始事件不变', () => {
    const p = projectRuntime([]);
    p.messages.push({seq:1,role:'user',content:'历史目标',eventId:'e',turnId:'old'},
      {seq:2,role:'assistant',content:'历史结果',eventId:'e',turnId:'old'},
      {seq:3,role:'user',content:'继续',eventId:'e',turnId:'current'});
    const originals = structuredClone(p.messages);
    replacement(p, [1,2], '检查点：已验证结果');
    const messages = request(p).messages;
    expect(messages[0]?.content).toContain('检查点：已验证结果');
    expect(messages).toHaveLength(2);
    expect(messages.at(-1)?.content).toBe('继续');
    expect(p.messages).toEqual(originals);
  });

  it('工具结果预裁剪后仍与调用一起进入检查点，再投影没有孤立结果', () => {
    const p = projectRuntime([]);
    step(p, 's1', 1); step(p, 's2', 2);
    p.messages.push({seq:1,role:'user',content:'任务',eventId:'e',turnId:'current'},
      {seq:2,role:'assistant',content:'读文件',eventId:'e',turnId:'current',stepId:'s1',toolCalls:[{id:'tc',name:'read',arguments:{path:'a'}}]},
      {seq:3,role:'tool',content:'原始全文',eventId:'e',turnId:'current',stepId:'s1',toolCallId:'tc'},
      {seq:4,role:'assistant',content:'最近结果',eventId:'e',turnId:'current',stepId:'s2'});
    replacement(p, [3], '裁剪后的文件', 'tool-prune');
    const selected = selectCheckpointMessages(p, 'current', 10000);
    expect(selected.map((m) => m.seq)).toEqual([2,3]);
    expect(selected[1]?.content).toBe('裁剪后的文件');
    replacement(p, selected.flatMap((m) => m.sourceSeqs), '已读取文件');
    const out = request(p).messages;
    expect(out.filter((m) => m.role === 'tool')).toEqual([]);
    expect(out.flatMap((m) => m.toolCalls ?? [])).toEqual([]);
    expect(out[0]?.content).toContain('已读取文件');
    expect(JSON.stringify(out)).not.toContain('裁剪后的文件');
    expect(out.at(-1)?.content).toBe('最近结果');
  });

  it('检查点可以再次压缩，只保留最新替代摘要', () => {
    const p = projectRuntime([]);
    p.messages.push({seq:1,role:'user',content:'旧目标',eventId:'e',turnId:'old'},
      {seq:2,role:'assistant',content:'旧内容',eventId:'e',turnId:'old'},
      {seq:3,role:'user',content:'新任务',eventId:'e',turnId:'current'});
    replacement(p,[1,2],'第一份检查点');
    const selected = selectCheckpointMessages(p,'current',1000);
    expect(selected.map((m) => m.content)).toEqual(['第一份检查点']);
    replacement(p,selected.flatMap((m) => m.sourceSeqs),'第二份检查点');
    expect(materializeSurface(p).map((m) => m.content)).toEqual(['第二份检查点','新任务']);
    expect(request(p).messages[0]?.content).toContain('第二份检查点');
    expect(JSON.stringify(request(p))).not.toContain('第一份检查点');
  });

  it('保护最新已闭合工具 Step、reasoning replay 和开放 Step', () => {
    const p=projectRuntime([]);
    step(p,'s1',1); step(p,'s2',2,'running');
    p.messages.push({seq:1,role:'user',content:'任务',eventId:'e',turnId:'current'},
      {seq:2,role:'assistant',content:'读',eventId:'e',turnId:'current',stepId:'s1',toolCalls:[{id:'tc',name:'read',arguments:{}}]},
      {seq:3,role:'tool',content:'结果',eventId:'e',turnId:'current',stepId:'s1',toolCallId:'tc'},
      {seq:4,role:'assistant',content:'未完成',eventId:'e',turnId:'current',stepId:'s2'});
    expect(selectCheckpointMessages(p,'current',10000)).toEqual([]);
    expect(request(p).messages.filter((m) => m.role==='tool')).toHaveLength(1);
  });

  it('不把缺少结果的工具调用纳入压缩', () => {
    const p=projectRuntime([]);
    p.messages.push({seq:1,role:'assistant',content:'读',eventId:'e',turnId:'old',toolCalls:[{id:'tc',name:'read',arguments:{}}]});
    expect(selectCheckpointMessages(p,'current',1000)).toEqual([]);
  });

  it('保留近期尾部预算，不因一个大分组越过保留边界', () => {
    const p=projectRuntime([]);
    p.messages.push({seq:1,role:'assistant',content:'旧'.repeat(1000),eventId:'e',turnId:'old'},
      {seq:2,role:'user',content:'新',eventId:'e',turnId:'current'});
    expect(selectCheckpointMessages(p,'current',10000,500)).toEqual([]);
  });

  it('业务摘要替代已覆盖问答，只追加摘要之后的新问答', () => {
    const p=projectRuntime([]);
    p.events.set('e',{id:'e',title:'事项',status:'open',summary:'事项摘要',summaryVersion:1,summaryThroughSeq:2,createdAt:'now',updatedAt:'now'});
    p.sessionMemorySummary={summary:'整体摘要',summaryVersion:1,coveredThroughSeq:2,summaryTokens:4,inputTokens:10,outputTokens:4,updatedAt:'now'};
    p.messages.push({seq:1,role:'user',content:'已覆盖问题',eventId:'e',turnId:'old'},
      {seq:2,role:'assistant',content:'已覆盖回答',eventId:'e',turnId:'old'},
      {seq:3,role:'user',content:'新增问题',eventId:'e',turnId:'tail'},
      {seq:4,role:'assistant',content:'新增回答',eventId:'e',turnId:'tail'},
      {seq:5,role:'user',content:'当前问题',eventId:'e',turnId:'current'});
    const messages=request(p).messages;
    expect(messages.slice(1).map((m)=>m.content)).toEqual(['新增问题','新增回答','当前问题']);
    expect(messages[0]?.content).toContain('事项摘要');
    expect(messages[0]?.content).toContain('整体摘要');
  });
  it('运行检查点可临时替换双层摘要，业务摘要版本和下一 Turn 仍保持原值', () => {
    const p=projectRuntime([]);
    p.events.set('e',{id:'e',title:'事项',status:'open',summary:'业务事项原摘要',summaryVersion:2,summaryThroughSeq:2,createdAt:'now',updatedAt:'now'});
    p.sessionMemorySummary={summary:'全局原摘要',summaryVersion:3,coveredThroughSeq:2,summaryTokens:4,inputTokens:10,outputTokens:4,updatedAt:'now'};
    p.messages.push({seq:3,role:'user',content:'当前问题',eventId:'e',turnId:'current'});
    replacement(p,[],'运行摘要');
    Object.assign(p.surfaceReplacements[0]!,{anchorSeq:4,memorySessionVersion:3,memoryEventVersion:2});
    const out=request(p);
    expect(out.messages[0]?.content).toContain('运行摘要');
    expect(JSON.stringify(out)).not.toContain('业务事项原摘要');
    expect(JSON.stringify(out)).not.toContain('全局原摘要');
    expect(p.events.get('e')?.summaryVersion).toBe(2);
    expect(p.sessionMemorySummary.summary).toBe('全局原摘要');
    const next=new ContextProjector().project({projection:p,turnId:'next',eventId:'e',contextWindow:100000,reservedOutputTokens:1000,safetyTokens:0,tools:[],skills:[]});
    expect(next.messages[0]?.content).toContain('业务事项原摘要');
    expect(next.messages[0]?.content).toContain('全局原摘要');
  });

});
