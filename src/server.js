export async function handle(request,env={}){
 const url=new URL(request.url),json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store'}});
 if(url.pathname==='/api/health')return json({ok:true,cloudflareConfigured:!!env.CLOUDFLARE_API_TOKEN,protocol:'systemone',models:['clef','clef-flash']});
 if(url.pathname!=='/api/infer')return json({error:'Not found'},404);
 if(request.method!=='POST')return json({error:'Method not allowed'},405);
 if(request.headers.get('origin')&&request.headers.get('origin')!==url.origin)return json({error:'跨域调用不允许'},403);
 try{const body=await request.text();if(body.length>180000)return json({error:'请求超过 180 KB'},413);const {config,task}=JSON.parse(body);validateTask(task);if(!config||!['cloudflare','jev'].includes(config.type))throw Error('只支持 CLEF / System One 决策接口');let endpoint,token=config.token,model=config.model;
 if(config.type==='cloudflare'){if(!['clef','clef-flash'].includes(model))throw Error('请选择 clef 或 clef-flash，不接受聊天模型');let account=config.account;if(!token){token=env.CLOUDFLARE_API_TOKEN;account=env.CLOUDFLARE_ACCOUNT_ID;}if(!/^[a-fA-F0-9]{32}$/.test(account||''))throw Error('Cloudflare Account ID 无效');endpoint='https://api.cloudflare.com/client/v4/accounts/'+account+'/ai/run/@cf/cloudflare/'+model;}
 else{if(typeof model!=='string'||!model.trim()||model.length>100)throw Error('请填写 System One 模型名');const u=new URL(config.endpoint);if(u.protocol!=='https:'||u.username||u.password||u.port||!u.hostname.includes('.')||/^[\d.]+$/.test(u.hostname)||u.hostname.includes(':')||/(^|\.)(localhost|local|internal|test|invalid)$/.test(u.hostname))throw Error('请输入公网 HTTPS System One 接口');endpoint=u.href;}
 if(typeof token!=='string'||!token.trim())throw Error('缺少该提供商的 Token；Cloudflare 服务端密钥不会发送给其他提供商');
 const input=modelInput(task,model),start=Date.now();const upstream=await fetch(endpoint,{method:'POST',headers:{'content-type':'application/json','authorization':'Bearer '+token},body:JSON.stringify(input),signal:AbortSignal.timeout(60000),redirect:'error'});
 if(!upstream.ok)return json({error:'决策接口 HTTP '+upstream.status+'；请检查模型权限、配额和接口地址。'},502);
 const data=await upstream.json();if(data.success===false)throw Error('Cloudflare 拒绝请求，请检查模型可用性和权限');const result=config.type==='cloudflare'?data.result:data;
 if(!result?.answers)throw Error('未返回 System One answers；不能使用 chat/completions 接口');
 return json({raw:JSON.stringify(result,null,2),response:result,latency:Date.now()-start,usage:result.usage||null,model:result.model||model});
 }catch(e){return json({error:e.name==='TimeoutError'?'决策接口超时（60 秒）':String(e.message).slice(0,250)},400);}
}
