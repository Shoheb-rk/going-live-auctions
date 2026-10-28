import http from 'node:http';
import {readFileSync,mkdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join,dirname} from 'node:path';
import {Store} from './store.js';
import {MongoStore} from './mongo-store.js';
const root=dirname(fileURLToPath(import.meta.url));mkdirSync(join(root,'data'),{recursive:true});
const store=process.env.MONGODB_URI
  ? await MongoStore.connect(process.env.MONGODB_URI,process.env.MONGODB_DATABASE||'going')
  : new Store(process.env.DB_PATH||join(root,'data','auction.db'));
const clients=new Set(),limits=new Map();
async function broadcast(snapshot){const data=JSON.stringify(snapshot||await store.snapshot());for(const res of clients) { if(res.writableLength>1000000){res.destroy();clients.delete(res);}else res.write(`data: ${data}\n\n`); }}
let timerBusy=false;
const timer=setInterval(async()=>{if(timerBusy)return;timerBusy=true;try{if(await store.closeExpired())await broadcast();for(const c of clients)c.write(': heartbeat\n\n');}catch(e){console.error('Auction close check failed:',e.message);}finally{timerBusy=false;}},1000);timer.unref();
const server=http.createServer(async(req,res)=>{
  res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('X-Frame-Options','DENY');res.setHeader('Referrer-Policy','same-origin');
  res.setHeader('Content-Security-Policy',"default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  const url=new URL(req.url,'http://localhost');
  const json=(code,data)=>{res.writeHead(code,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
  try {
    if(req.method==='GET'&&url.pathname==='/api/events'){const snapshot=await store.snapshot();res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive','X-Accel-Buffering':'no'});res.write(`data: ${JSON.stringify(snapshot)}\n\n`);clients.add(res);req.on('close',()=>clients.delete(res));return;}
    const token=req.headers.cookie?.match(/(?:^|; )session=([a-f0-9]+)/)?.[1],user=await store.user(token);
    if(req.method==='GET'&&url.pathname==='/api/state')return json(200,{...await store.snapshot(),user:user||null});
    if(req.method==='POST') {
      if(req.headers.origin&&req.headers.origin!==`${process.env.PUBLIC_ORIGIN||`http://${req.headers.host}`}`)return json(403,{error:'Origin rejected.'});
      if(!req.headers['content-type']?.startsWith('application/json'))return json(415,{error:'JSON required.'});
      const key=req.socket.remoteAddress,now=Date.now(),rate=limits.get(key);if(!rate||now-rate.at>60000)limits.set(key,{at:now,count:1});else if(++rate.count>120)return json(429,{error:'Too many requests. Try again in a minute.'});
      if(limits.size>10000)for(const [k,v]of limits)if(now-v.at>60000)limits.delete(k);
      let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>16000)return json(413,{error:'Request too large.'});}const body=JSON.parse(raw||'{}');
      if(url.pathname==='/api/register'){await store.register(body.name,body.email,body.password);return json(201,{ok:true});}
      if(url.pathname==='/api/login'){const session=await store.login(body.email,body.password);res.setHeader('Set-Cookie',`session=${session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400${process.env.COOKIE_SECURE==='1'?'; Secure':''}`);return json(200,{ok:true});}
      if(!user)return json(401,{error:'Sign in to continue.'});
      if(url.pathname==='/api/logout'){await store.logout(token);res.setHeader('Set-Cookie','session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');return json(200,{ok:true});}
      if(url.pathname==='/api/auctions'){const id=await store.create(user,body);await broadcast();return json(201,{id});}
      const match=url.pathname.match(/^\/api\/auctions\/([^/]+)\/bids$/);if(match){const bid=await store.bid(user,match[1],body.amount,body.request);await broadcast();return json(201,bid);}
      return json(404,{error:'Route not found.'});
    }
    const files={'/':['index.html','text/html'],'/app.js':['app.js','text/javascript'],'/style.css':['style.css','text/css']};
    if(req.method==='GET'&&files[url.pathname]){const [file,type]=files[url.pathname];res.writeHead(200,{'Content-Type':type});return res.end(readFileSync(join(root,'public',file)));}
    json(404,{error:'Not found.'});
  } catch(e){json(400,{error:e.message||'Request failed.'});}
});
server.listen(Number(process.env.PORT||3100),process.env.HOST||'127.0.0.1',()=>console.log(`Going live at http://localhost:${process.env.PORT||3100} using ${process.env.MONGODB_URI?'MongoDB':'SQLite'}`));
let stopping=false;
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{if(stopping)return;stopping=true;clearInterval(timer);for(const c of clients)c.end();server.close(async()=>{await store.disconnect();process.exit(0);});});
