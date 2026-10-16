import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWorkerApplication, type WorkerApplication } from '../../packages/server-core/src/application/application';
import { MemoryLogger } from '../../packages/execution/src/logging/logger';
import { LlmAdapterRegistry } from '../../packages/runtime-core/src/model';
import { FakeLlmAdapter, textResponse } from '../../packages/test-kit/src/runtime';
import { makeTempDir, cleanupDir } from '../../packages/test-kit/src/temp';

let root: string;
let app: WorkerApplication;
let adapter: FakeLlmAdapter;
const remote = {fixture:{api:'https://fixture.example',models:{'new-fixture-model':{limit:{context:1000000,output:384000}}}}};
beforeEach(()=>{
  root=makeTempDir(); adapter=new FakeLlmAdapter(()=>textResponse('完成'));
  const adapters=new LlmAdapterRegistry(); adapters.register(adapter);
  app=createWorkerApplication({appDataDir:root,generation:1,logger:new MemoryLogger(),llmAdapters:adapters,
    catalogFetch:vi.fn().mockImplementation(async()=>new Response(JSON.stringify(remote))),});
  app.repos.models.createService({id:'svc',userId:'user-a',name:'Fixture',providerType:'fake',endpoint:'https://fixture.example',credentialRef:null,config:{},now:new Date().toISOString()});
  app.repos.models.createModel({id:'model',userId:'user-a',serviceId:'svc',remoteModelId:'new-fixture-model',displayName:'New',contextWindow:100000,maxOutputTokens:4096,metadataSource:'fallback',capabilityMatchKind:'unresolved',requestMaxOutputTokens:null,capabilities:{tools:true},defaultParams:{},source:'manual',now:new Date().toISOString()});
  app.repos.models.setDefaultModel('user-a','model',new Date().toISOString());
});
afterEach(()=>{app.close();cleanupDir(root);vi.unstubAllGlobals();});

describe('能力刷新贯穿设置和实际请求',()=>{
  it('已有 fallback 模型无须重建，刷新后 UI 和请求同时从 100K 升到 1M',async()=>{
    expect((await app.modelManagement('user-a')).models[0]?.contextWindow).toBe(100000);
    const snapshot=await app.modelManagement('user-a',true);
    expect(snapshot.models[0]).toMatchObject({contextWindow:1000000,metadataSource:'catalog',maxOutputTokens:200000});
    expect(snapshot.catalog?.source).toBe('remote');
    app.runtime.createSession('user-a',{sessionId:'s',title:'test'});
    app.runtime.submitInput('user-a',{sessionId:'s',content:'测试',idempotencyKey:'one',startNewEvent:true});
    await app.runtime.waitForIdle();
    expect(adapter.requests[0]?.model).toMatchObject({contextWindow:1000000,maxOutputTokens:200000,catalogVersion:snapshot.catalog?.version});
    expect((await app.modelManagement('user-b')).models).toEqual([]);
  });
  it('目录刷新不覆盖手工上下文和请求输出预算',async()=>{
    app.repos.models.updateModel('user-a','model',{...app.repos.models.getModel('user-a','model')!,contextWindowOverride:65536,requestMaxOutputTokens:2048},new Date().toISOString());
    const snapshot=await app.modelManagement('user-a',true);
    expect(snapshot.models[0]).toMatchObject({contextWindow:65536,automaticContextWindow:1000000,metadataSource:'manual',requestMaxOutputTokens:2048,maxOutputTokens:2048});
    app.runtime.createSession('user-a',{sessionId:'s',title:'manual'});
    app.runtime.submitInput('user-a',{sessionId:'s',content:'测试',idempotencyKey:'one',startNewEvent:true});
    await app.runtime.waitForIdle();
    expect(adapter.requests[0]?.model).toMatchObject({contextWindow:65536,maxOutputTokens:2048});
  });
  it('发现模型同时刷新目录，端点明确声明的容量优先于目录',async()=>{
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify({data:[{id:'new-fixture-model',context_window:131072,max_output_tokens:8192}]}))));
    const result=await app.discoverModels('user-a','svc');
    expect(result.catalog?.source).toBe('remote');
    expect(result.models[0]).toMatchObject({contextWindow:131072,maxOutputCapability:8192,metadataSource:'endpoint'});
    app.repos.models.updateModel('user-a','model',{...app.repos.models.getModel('user-a','model')!,contextWindow:131072,maxOutputCapability:8192,metadataSource:'endpoint'},new Date().toISOString());
    expect((await app.modelManagement('user-a',true)).models[0]).toMatchObject({contextWindow:131072,maxOutputCapability:8192,metadataSource:'endpoint'});
  });
});
