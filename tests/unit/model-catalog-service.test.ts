import path from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ModelCatalogService } from '../../packages/server-core/src/application/model-catalog-service';
import { matchModelCapability, type ModelCatalog } from '../../packages/runtime-core/src/model-catalog';
import { makeTempDir, cleanupDir } from '../../packages/test-kit/src/temp';

const bundled: ModelCatalog = {schemaVersion:1,source:'https://models.dev/api.json',generatedAt:'2026-08-20',providers:[{id:'deepseek',apiHosts:['api.deepseek.com'],models:[{id:'old',context:32768,output:4096}]}]};
const remote = {deepseek:{api:'https://api.deepseek.com',models:{'deepseek-flash':{limit:{context:1000000,output:384000}}}}};
let root: string;
beforeEach(()=>{root=makeTempDir();});
afterEach(()=>{cleanupDir(root);});
function service(fetch: typeof globalThis.fetch, options: {timeoutMs?:number; now?:()=>number}={}) {
  return new ModelCatalogService({bundled,cachePath:path.join(root,'catalog.json'),fetch,...options});
}
const response = () => new Response(JSON.stringify(remote),{headers:{'last-modified':'Fri, 11 Sep 2026 00:00:00 GMT'}});

describe('Runtime 模型能力目录',()=>{
  it('刷新后识别新模型、原子缓存并在重启时离线恢复',async()=>{
    const fetch=vi.fn<typeof globalThis.fetch>().mockResolvedValue(response());
    const catalog=service(fetch);
    expect(matchModelCapability(catalog.catalog,{modelId:'deepseek-flash'}).model).toBeNull();
    await catalog.refresh();
    expect(matchModelCapability(catalog.catalog,{modelId:'deepseek-flash',apiEndpoint:'https://api.deepseek.com'}).model).toMatchObject({context:1000000,output:384000});
    expect(catalog.status).toMatchObject({source:'remote',stale:false,error:null});
    const offline=service(vi.fn().mockRejectedValue(new Error('offline')));
    expect(offline.catalog).toEqual(catalog.catalog);
    expect(offline.status.source).toBe('cache');
    await offline.refresh();
    expect(offline.status.error).toBeNull();
  });
  it('并发合并且新鲜目录不重复下载，强制刷新可重试',async()=>{
    const fetch=vi.fn<typeof globalThis.fetch>().mockImplementation(async()=>response());
    const catalog=service(fetch);
    await Promise.all([catalog.refresh(),catalog.refresh(),catalog.refresh()]);
    expect(fetch).toHaveBeenCalledTimes(1);
    await catalog.refresh();
    expect(fetch).toHaveBeenCalledTimes(1);
    await catalog.refresh(true);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it.each(['network','invalid','http'])('更新失败 %s 保留上次有效目录并显示回退状态',async(reason)=>{
    const fetch=vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(response()).mockImplementation(async()=>{
      if(reason==='network') throw new Error('offline');
      return new Response(reason==='invalid' ? '{}' : 'error',{status:reason==='http'?500:200});
    });
    const catalog=service(fetch); await catalog.refresh();
    const before=readFileSync(path.join(root,'catalog.json'),'utf8');
    await catalog.refresh(true);
    expect(readFileSync(path.join(root,'catalog.json'),'utf8')).toBe(before);
    expect(catalog.status.error).toContain('继续使用');
    expect(matchModelCapability(catalog.catalog,{modelId:'deepseek-flash'}).model?.context).toBe(1000000);
  });
  it('损坏缓存不阻止启动，网络失败后退回随包目录并退避',async()=>{
    writeFileSync(path.join(root,'catalog.json'),'broken');
    const fetch=vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error('offline'));
    const catalog=service(fetch);
    await catalog.refresh(); await catalog.refresh();
    expect(catalog.catalog).toEqual(bundled);
    expect(catalog.status).toMatchObject({source:'bundled',stale:true});
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('超时中断更新，不阻塞使用随包能力',async()=>{
    const fetch=vi.fn<typeof globalThis.fetch>().mockImplementation((_url,init)=>new Promise((_resolve,reject)=>{
      init?.signal?.addEventListener('abort',()=>reject(new Error('aborted')));
    }));
    const catalog=service(fetch,{timeoutMs:10});
    await catalog.refresh();
    expect(catalog.status.error).not.toBeNull();
    expect(catalog.catalog).toEqual(bundled);
  });
  it('缓存过期才刷新，关闭服务取消在途下载',async()=>{
    let now=Date.parse('2026-09-11');
    const fetch=vi.fn<typeof globalThis.fetch>().mockImplementation(async()=>response());
    const catalog=service(fetch,{now:()=>now});
    await catalog.refresh(); now+=86_400_001;
    expect(catalog.status.stale).toBe(true);
    await catalog.refresh();
    expect(fetch).toHaveBeenCalledTimes(2);
    catalog.close(); await catalog.refresh(true);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
