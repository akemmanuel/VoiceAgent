/** Actual MV3/native-JS smoke test, with no model or credentials required.
 * bun run build && bun scripts/agent-extension-smoke.ts
 * Load the printed directory in a separate Chromium profile and open smoke.html.
 * Optional PI_AUTH_FILE or CODEX_AUTH_FILE enables a real Luna four-tool check.
 */
import { cp, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const root = resolve(import.meta.dir, "..");
const directory = await mkdtemp(join(tmpdir(), "voiceagent-native-smoke-"));
await cp(join(root, "dist"), directory, { recursive: true });
const nonce = crypto.randomUUID();
let credentials: any;
if (process.env.PI_AUTH_FILE || process.env.CODEX_AUTH_FILE) {
  const auth = await Bun.file((process.env.PI_AUTH_FILE ?? process.env.CODEX_AUTH_FILE)!).json();
  const entry = process.env.PI_AUTH_FILE ? auth["openai-codex"] : auth.tokens;
  credentials = { accessToken: entry.access ?? entry.access_token, accountId: entry.accountId ?? entry.account_id ?? null };
}
const live = !!credentials;
const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: async request => {
  const path = new URL(request.url).pathname;
  if (path === `/credentials/${nonce}`) {
    if (!credentials) return new Response("Unavailable", { status: 403 });
    const result = Response.json(credentials, { headers: { "Cache-Control": "no-store" } }); credentials = undefined; return result;
  }
  if (path === "/results" && request.method === "POST") { console.log(await request.text()); return new Response("ok"); }
  if (path === "/module.js") return new Response("export const double = n => n * 2", { headers: { "Content-Type": "text/javascript", "Access-Control-Allow-Origin": "*" } });
  return new Response('<!doctype html><title>Native REPL fixture</title><input id="name" value="old"><button id="send" onclick="document.querySelector(\'#result\').textContent=\'clicked\'">Send</button><p id="result">ready</p>', { headers: { "Content-Type": "text/html", "Content-Security-Policy": "script-src \'unsafe-inline\'" } });
} });
const worker = join(directory, "smoke-worker.ts");
await Bun.write(worker, `
import { AgentTools, AGENT_TOOLS } from ${JSON.stringify(join(root, "src/background/agent-tools.ts"))};
import { runDelegation } from ${JSON.stringify(join(root, "src/live/agent/delegation.ts"))};
import { createLunaStream } from ${JSON.stringify(join(root, "src/live/chatgpt/responses.ts"))};
const assert = (ok, message) => { if (!ok) throw new Error(message); };
chrome.runtime.onInstalled.addListener(()=>chrome.tabs.create({url:chrome.runtime.getURL('smoke.html')}));
chrome.runtime.onMessage.addListener((message,sender,respond)=>{
 if(message.type!=='native-smoke')return;
 (async()=>{
  const checks=[], signal=new AbortController().signal;
  let tools=new AgentTools();
  let fixture, internal;
  const shell=(code,timeoutMs=15000)=>tools.execute('shell',JSON.stringify({code,timeoutMs}),signal);
  try {
   if(!await chrome.offscreen.hasDocument()) await chrome.offscreen.createDocument({url:'offscreen/index.html',reasons:['IFRAME_SCRIPTING'],justification:'Test the native workspace'});
   assert(AGENT_TOOLS.map(t=>t.name).join(',')==='read,write,edit,shell','Wrong tool set');
   assert(await shell('const n = await Promise.resolve(20); n + 1')==='21','native execution failed');
   assert(await shell('n += 2; n')==='22','bindings lost');
   assert(await shell('let {x,y} = {x:2,y:3}; x+y')==='5','destructuring failed');
   assert(await shell('function answer(){return n}; class Box {value=42}; answer()+new Box().value')==='64','function/class failed');
   checks.push('native JS, await, persistent let/const/function/class');
   await tools.execute('write',JSON.stringify({path:'/smoke/input.txt',content:'alpha beta'}),signal);
   await tools.execute('edit',JSON.stringify({path:'/smoke/input.txt',edits:[{oldText:'alpha',newText:'one'}]}),signal);
   assert(await shell('await fs.read("/smoke/input.txt")')==='one beta','shared files failed');
   await shell('await fs.write("/smoke/script.js", "const scripted = 41; scripted+1"); await run("/smoke/script.js")');
   assert(await shell('scripted')==='41','saved script bindings lost');
   const imported=await shell('const lib = await import('+JSON.stringify(${JSON.stringify(server.url.href + "module.js")})+'); lib.double(21)');
   assert(imported==='42','downloaded module failed: '+imported);
   assert((await shell('await browser.fetch('+JSON.stringify(${JSON.stringify(server.url.href)})+')')).includes('Native REPL fixture'),'network bridge failed');
   checks.push('read/write/edit, shared filesystem, saved scripts, downloaded module, network');
   fixture=JSON.parse(await shell('const tab = await browser.tabs.open('+JSON.stringify(${JSON.stringify(server.url.href)})+'); tab.id'));
   await new Promise(r=>setTimeout(r,500));
   assert((await shell('await browser.tabs.list()')).includes('Native REPL fixture'),'tabs missing');
   await shell('await browser.page.type(tab.id,"#name","new value"); await browser.page.click(tab.id,"#send")');
   assert(await shell('await browser.page.evaluate(tab.id,()=>document.querySelector("#name").value)')==='new value','page type failed');
   assert((await shell('await browser.page.read(tab.id)')).includes('clicked'),'label-based click blocker still present');
   assert(await shell('await browser.page.evaluate(tab.id, async (a,b)=>{document.body.dataset.answer=String(await Promise.resolve(a*b)); return document.body.dataset.answer},6,7)')==='42','arbitrary page execution failed');
   const image=await shell('await display(await browser.page.screenshot(tab.id))');
   assert(Array.isArray(image)&&image[1].image_url.startsWith('data:image/png;base64,'),'screenshot missing');
   checks.push('open/list tabs, arbitrary page JS under strict CSP, typing, Send click, screenshots');
   internal=JSON.parse(await shell('const internalTab = await browser.tabs.open("chrome://settings/"); internalTab.id'));
   const protectedResult=await shell('await browser.page.evaluate(internalTab.id,"document.title")');
   assert(/Error/.test(protectedResult),'protected page unexpectedly scriptable');
   await shell('await browser.tabs.close(internalTab.id)'); internal=undefined;
   checks.push('internal tab open/close; protected content rejected');
   try { await shell('await browser.page.evaluate('+fixture+', "while(true){}")',500); throw new Error('page timeout ignored'); } catch(e) { assert(String(e).includes('timed out'),'wrong page timeout error: '+e); }
   assert(await shell('await browser.page.evaluate('+fixture+', "6*7")')==='42','page remained stuck after cancellation');
   checks.push('runaway page JavaScript terminated and debugger detached');
   try { await shell('while(true){}',300); throw new Error('timeout ignored'); } catch(e) { assert(String(e).includes('timed out'),'wrong timeout error: '+e); }
   assert(await shell('typeof n')==='undefined','timeout did not reset bindings');
   assert(await shell('await fs.read("/smoke/input.txt")')==='one beta','timeout deleted files');
   const controller=new AbortController();
   const pending=tools.execute('shell',JSON.stringify({code:'await new Promise(r=>setTimeout(r,1000)); await fs.write("/smoke/late.txt","bad")'}),controller.signal);
   setTimeout(()=>controller.abort(),100);
   try { await pending; throw new Error('abort ignored'); } catch(e) { assert(controller.signal.aborted,'wrong abort error'); }
   await new Promise(r=>setTimeout(r,1100));
   assert((await shell('await fs.read("/smoke/late.txt")')).includes('No file'),'cancelled code kept running');
   checks.push('infinite-loop timeout, reset, persistent files, cancelled future writes');
   tools.close(); await chrome.offscreen.closeDocument();
   await chrome.offscreen.createDocument({url:'offscreen/index.html',reasons:['IFRAME_SCRIPTING'],justification:'Check workspace durability'});
   tools=new AgentTools();
   assert(JSON.parse(await tools.execute('read',JSON.stringify({path:'/smoke/input.txt'}),signal)).text==='one beta','offscreen restart lost files');
   checks.push('files survive session and offscreen teardown');
   if (${live}) {
    const auth=await (await fetch(${JSON.stringify(server.url.href + "credentials/" + nonce)})).json();
    const used=[];
    const result=await runDelegation({sessionId:crypto.randomUUID(),prompt:'Use shell to compute 137*29 and write /smoke/luna.txt with fs.write. Read it using read. Use edit to append a newline using exact replacement. Use write to create /smoke/copy.txt with the number. State the result and that these are persistent virtual files. Actually use all four tools.',history:[],signal:AbortSignal.timeout(120000),update(){},deps:{tools:AGENT_TOOLS,stream:createLunaStream(async()=>auth),execute:(name,args,signal)=>{used.push(name);return tools.execute(name,args,signal)},publish:async()=>{},dispose(){}}});
    assert(['read','write','edit','shell'].every(n=>used.includes(n)),'Luna did not use all four tools');
    assert(/3,?973/.test(result.answer),'Luna answer incorrect'); checks.push({liveLuna:true,used,answer:result.answer});
   }
   await shell('await browser.tabs.close('+fixture+')'); fixture=undefined;
   return {ok:true,checks};
  } finally {tools.close();if(await chrome.offscreen.hasDocument())await chrome.offscreen.closeDocument();for(const id of [fixture,internal])if(id)await chrome.tabs.remove(id).catch(()=>{});}
 })().then(respond,error=>respond({ok:false,error:String(error),stack:error.stack}));return true;
});
`);
const built = await Bun.build({ entrypoints: [worker], outdir: join(directory, "background"), naming: "index.js", target: "browser", format: "esm", minify: true, tsconfig: join(root, "tsconfig.json") });
if (!built.success) throw new AggregateError(built.logs);
await Bun.write(join(directory, "smoke.html"), '<!doctype html><title>Native workspace smoke</title><pre id="result">Running...</pre><script src="smoke.js"></script>');
await Bun.write(join(directory, "smoke.js"), `chrome.runtime.sendMessage({type:'native-smoke'}).then(async result=>{document.querySelector('#result').textContent=JSON.stringify(result,null,2);await fetch(${JSON.stringify(server.url.href + "results")},{method:'POST',body:JSON.stringify(result)});});`);
console.log(JSON.stringify({ directory, fixture: server.url.href, live }));
