const express = require("express");
const path = require("path");
const app = express();
app.use(express.json({limit:"1mb"}));
app.use(express.static(path.join(__dirname,"public")));
const PORT = process.env.PORT || 3000;

const UA={"User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36"};
function csvParse(text){const lines=text.trim().split(/\r?\n/);if(lines.length<2)return[];const h=lines[0].split(",");return lines.slice(1).map(line=>{const p=line.split(",");return Object.fromEntries(h.map((k,i)=>[k,p[i]]))})}
async function fetchTimeout(url,opts={},ms=8000){const c=new AbortController(),t=setTimeout(()=>c.abort(),ms);try{return await fetch(url,{...opts,signal:c.signal})}finally{clearTimeout(t)}}

async function fredCsv(id,days=400){
 const r=await fetchTimeout(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${encodeURIComponent(id)}`,{headers:{...UA,"Accept":"text/csv,*/*"}});
 if(!r.ok)throw new Error(`FRED ${id} ${r.status}`);
 const rows=csvParse(await r.text()).map(x=>({d:x.observation_date,v:Number(x[id])})).filter(x=>Number.isFinite(x.v));
 const cutoff=Date.now()-days*86400000,s=rows.filter(x=>Date.parse(x.d)>=cutoff).slice(-365);if(s.length<2)throw new Error(`FRED ${id} no data`);
 const last=s.at(-1),prev=s.at(-2);return {value:last.v,abs:last.v-prev.v,pct:(last.v-prev.v)/prev.v*100,series:s,date:last.d};
}
async function frankfurter(){
 const r=await fetchTimeout("https://api.frankfurter.dev/v2/rate/USD/KRW",{headers:UA});if(!r.ok)throw new Error(`Frankfurter ${r.status}`);const j=await r.json();
 const end=new Date(j.date+"T00:00:00Z"),start=new Date(end.getTime()-370*86400000),f=d=>d.toISOString().slice(0,10);
 const rr=await fetchTimeout(`https://api.frankfurter.dev/v2/rates?base=USD&quotes=KRW&from=${f(start)}&to=${f(end)}`,{headers:UA});if(!rr.ok)throw new Error("Frankfurter history");const hist=await rr.json();
 let series=Array.isArray(hist)?hist.map(x=>({d:x.date,v:Number(x.rate)})):Object.entries(hist.rates||{}).map(([d,v])=>({d,v:Number(v.KRW??v)}));series=series.filter(x=>Number.isFinite(x.v)).sort((a,b)=>a.d.localeCompare(b.d));
 const value=Number(j.rate),prev=series.length>1?series.at(-2).v:value;return {value,abs:value-prev,pct:prev?(value-prev)/prev*100:0,series:series.slice(-365),date:j.date};
}

function stripTags(s=""){return s.replace(/<script[\s\S]*?<\/script>/gi,"").replace(/<style[\s\S]*?<\/style>/gi,"").replace(/<[^>]+>/g," ").replace(/&nbsp;/g," ").replace(/&amp;/g,"&").replace(/\s+/g," ").trim()}
function parseNaverRows(html){
 const rows=[...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map(m=>m[1]),out=[];
 for(const row of rows){const cells=[...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(m=>stripTags(m[1]));if(cells.length<2)continue;const date=cells.find(x=>/^\d{4}\.\d{2}\.\d{2}$/.test(x));const nums=cells.filter(x=>/^-?\d+(?:\.\d+)?$/.test(x));if(date&&nums.length){out.push({d:date.replaceAll(".","-"),v:Number(nums[0])})}}
 return out.filter(x=>Number.isFinite(x.v));
}
async function naverBond(code){
 let all=[];
 for(let page=1;page<=12;page++){
  const url=`https://finance.naver.com/marketindex/interestDailyQuote.naver?marketindexCd=${encodeURIComponent(code)}&page=${page}`;
  const r=await fetchTimeout(url,{headers:{...UA,"Referer":"https://finance.naver.com/marketindex/"}},7000);if(!r.ok)break;const rows=parseNaverRows(await r.text());if(!rows.length)break;all.push(...rows);
 }
 const map=new Map(all.map(x=>[x.d,x]));const s=[...map.values()].sort((a,b)=>a.d.localeCompare(b.d)).slice(-365);if(s.length<2)throw new Error(`${code} no Naver rows`);const last=s.at(-1),prev=s.at(-2);return {value:last.v,abs:last.v-prev.v,pct:(last.v-prev.v)/prev.v*100,series:s,date:last.d};
}
async function ecosBond(item){
 const key=process.env.BOK_ECOS_API_KEY;if(!key)throw new Error("BOK_ECOS_API_KEY missing");const now=new Date(),start=new Date(now.getTime()-400*86400000),f=d=>d.toISOString().slice(0,10).replaceAll("-","");
 const u=`https://ecos.bok.or.kr/api/StatisticSearch/${encodeURIComponent(key)}/json/kr/1/1000/817Y002/D/${f(start)}/${f(now)}/${item}`;const r=await fetchTimeout(u,{headers:UA});if(!r.ok)throw new Error(`ECOS ${r.status}`);const j=await r.json();
 const s=(j.StatisticSearch?.row||[]).map(x=>({d:x.TIME,v:Number(x.DATA_VALUE)})).filter(x=>Number.isFinite(x.v)).sort((a,b)=>a.d.localeCompare(b.d));if(s.length<2)throw new Error("ECOS no rows");const last=s.at(-1),prev=s.at(-2);return {value:last.v,abs:last.v-prev.v,pct:(last.v-prev.v)/prev.v*100,series:s.slice(-365),date:last.d};
}
async function koreanBond(item,naverCode){try{return {...await naverBond(naverCode),source:"Naver Finance · KOFIA"}}catch(e1){try{return {...await ecosBond(item),source:"BOK ECOS"}}catch(e2){throw new Error(`${e1.message}; ${e2.message}`)}}}

const defs=[
 {id:"us2y",label:"US 2Y",note:"Fed policy path",unit:"%",axis:"Yield (%)",loader:()=>fredCsv("DGS2"),source:"FRED"},
 {id:"us10y",label:"US 10Y",note:"Growth · inflation · term premium",unit:"%",axis:"Yield (%)",loader:()=>fredCsv("DGS10"),source:"FRED"},
 {id:"kr3y",label:"KTB 3Y",note:"BOK policy expectations",unit:"%",axis:"Yield (%)",loader:()=>koreanBond("010200000","IRR_GOVT03Y"),source:"KOFIA"},
 {id:"kr10y",label:"KTB 10Y",note:"Korea long-end",unit:"%",axis:"Yield (%)",loader:()=>koreanBond("010210000","IRR_GOVT10Y"),source:"KOFIA"},
 {id:"usdkrw",label:"USD/KRW",note:"KRW vs USD",unit:"",axis:"KRW per USD",loader:frankfurter,source:"Frankfurter"},
 {id:"usd",label:"USD Broad",note:"Broad dollar index",unit:"",axis:"Index",loader:()=>fredCsv("DTWEXBGS"),source:"FRED"},
 {id:"sp500",label:"S&P 500",note:"US risk sentiment",unit:"",axis:"Index",loader:()=>fredCsv("SP500"),source:"FRED"},
 {id:"nasdaq",label:"Nasdaq",note:"Growth / duration equity",unit:"",axis:"Index",loader:()=>fredCsv("NASDAQCOM"),source:"FRED"},
 {id:"brent",label:"Brent",note:"Inflation · geopolitics",unit:"$",axis:"USD / barrel",loader:()=>fredCsv("DCOILBRENTEU"),source:"FRED"},
 {id:"vix",label:"VIX",note:"Risk aversion",unit:"",axis:"VIX index",loader:()=>fredCsv("VIXCLS"),source:"FRED"}
];
let marketCache={t:0,data:null};
async function marketData(){if(marketCache.data&&Date.now()-marketCache.t<180000)return marketCache.data;const items=await Promise.all(defs.map(async d=>{try{const z=await d.loader();return {...d,...z,source:z.source||d.source,ok:true}}catch(e){return {...d,ok:false,error:e.message,series:[]}}}));const data={updatedAt:new Date().toISOString(),items};marketCache={t:Date.now(),data};return data}
app.get("/api/markets",async(req,res)=>res.json(await marketData()));

function decodeXml(s=""){return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,"$1").replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&quot;/g,'"').replace(/&#39;|&#x27;/g,"'")}
function tag(block,name){const m=block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`,`i`));return m?decodeXml(m[1].trim()):""}
function parseRss(xml,sourceName){return [...xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi)].map(m=>m[1]).map(block=>({title:stripTags(tag(block,"title")),source:sourceName,date:tag(block,"pubDate")||tag(block,"dc:date"),url:tag(block,"link"),description:stripTags(tag(block,"description"))})).filter(x=>x.title&&x.url)}
const NEWS_FEEDS=[
 {name:"CNBC",url:"https://www.cnbc.com/id/100003114/device/rss/rss.html"},
 {name:"CNBC Economy",url:"https://www.cnbc.com/id/20910258/device/rss/rss.html"},
 {name:"FT Markets",url:"https://www.ft.com/markets?format=rss"},
 {name:"MarketWatch",url:"https://feeds.marketwatch.com/marketwatch/topstories/"},
 {name:"Yahoo Finance",url:"https://finance.yahoo.com/rss/topstories"},
 {name:"Reuters Markets",url:"https://feeds.reuters.com/reuters/globalmarketsNews"},
 {name:"Reuters Bonds",url:"https://feeds.reuters.com/reuters/bondsNews"}
];
async function fetchFeed(feed){try{const r=await fetchTimeout(feed.url,{headers:{...UA,"Accept":"application/rss+xml,application/xml,text/xml,*/*"}},7000);if(!r.ok)throw new Error(`${r.status}`);return {name:feed.name,ok:true,articles:parseRss(await r.text(),feed.name)}}catch(e){return {name:feed.name,ok:false,error:String(e.message||e),articles:[]}}}
let newsCache={t:0,data:null};
async function allNews(){if(newsCache.data&&Date.now()-newsCache.t<180000)return newsCache.data;const feeds=await Promise.all(NEWS_FEEDS.map(fetchFeed));let articles=feeds.flatMap(x=>x.articles);const seen=new Set();articles=articles.filter(a=>{const k=a.title.toLowerCase().replace(/\W/g,"").slice(0,80);if(seen.has(k))return false;seen.add(k);return true}).sort((a,b)=>(Date.parse(b.date)||0)-(Date.parse(a.date)||0));const data={feeds,articles};newsCache={t:Date.now(),data};return data}
function tokens(q=""){return q.toLowerCase().replace(/[^a-z0-9가-힣\s]/g," ").split(/\s+/).filter(x=>x.length>2&&!['market','markets','yield','rate','rates','index'].includes(x))}
app.get("/api/news",async(req,res)=>{const q=String(req.query.asset||"").slice(0,180),data=await allNews();let a=data.articles;if(q){const t=tokens(q);a=a.map(x=>({...x,_s:t.reduce((n,k)=>n+((x.title+" "+x.description).toLowerCase().includes(k)?1:0),0)})).filter(x=>x._s>0).sort((x,y)=>y._s-x._s||((Date.parse(y.date)||0)-(Date.parse(x.date)||0))).map(({_s,...x})=>x)}const sources=data.feeds.map(x=>({name:x.name,ok:x.ok,count:x.articles.length,error:x.error||null}));res.json({ok:true,provider:"Direct finance RSS",articles:a.slice(0,30),sources})});

function pctText(x){return `${x.pct>=0?"+":""}${x.pct.toFixed(2)}%`}
function buildRuleBrief(markets,news){
 const valid=markets.items.filter(x=>x.ok);const movers=[...valid].sort((a,b)=>Math.abs(b.pct)-Math.abs(a.pct)).slice(0,3);const y2=valid.find(x=>x.id==="us2y"),y10=valid.find(x=>x.id==="us10y"),kr3=valid.find(x=>x.id==="kr3y"),kr10=valid.find(x=>x.id==="kr10y");
 const headlines=news.articles.slice(0,5);let title=movers[0]?`${movers[0].label} ${movers[0].pct>=0?"강세/상승":"약세/하락"}가 오늘 크로스애셋 체크포인트`:"오늘의 Macro Brief";
 const bullets=[];if(movers.length)bullets.push(`가장 큰 일간 변화: ${movers.map(x=>`${x.label} ${pctText(x)}`).join(" · ")}`);if(y2&&y10)bullets.push(`US 2s10s: ${((y10.value-y2.value)*100).toFixed(1)}bp — front-end와 long-end의 상대 움직임을 확인.`);if(kr3&&kr10)bullets.push(`KTB 3Y ${kr3.value.toFixed(2)}% / 10Y ${kr10.value.toFixed(2)}% — BOK 기대와 장기 term premium을 분리해서 보자.`);if(headlines.length)bullets.push(`뉴스 레이더: ${headlines.slice(0,3).map(x=>x.title).join(" / ")}`);
 return {title,summary:"가격 변화가 큰 자산을 먼저 보고, 뉴스가 그 움직임을 설명하는지 확인한 뒤 Event → Pricing → Reaction 순서로 가설을 세워보세요.",bullets,question:movers[0]?`${movers[0].label} 움직임은 새로운 정보 때문인가, 기존 포지셔닝의 되돌림인가?`:"오늘 시장이 새롭게 가격에 반영한 것은 무엇인가?",articles:headlines.slice(0,5),mode:"rule"};
}
app.get("/api/brief",async(req,res)=>{
 const markets=await marketData(),news=await allNews(),fallback=buildRuleBrief(markets,news),key=process.env.OPENAI_API_KEY;
 if(!key)return res.json({ok:true,...fallback});
 try{const snapshot=markets.items.filter(x=>x.ok).map(x=>`${x.label} ${x.value} ${pctText(x)}`).join("\n"),heads=news.articles.slice(0,12).map((x,i)=>`${i+1}. [${x.source}] ${x.title}`).join("\n");const prompt=`You are a sell-side S&T morning strategist. Using ONLY the supplied market snapshot and headlines, create today's most important market issue for a Korean undergraduate training for S&T. Do not invent facts. Korean language. Return JSON only with keys title, summary, bullets(array 3 strings), question.\nMARKETS:\n${snapshot}\nHEADLINES:\n${heads}`;const r=await fetchTimeout("https://api.openai.com/v1/responses",{method:"POST",headers:{"Content-Type":"application/json","Authorization":`Bearer ${key}`},body:JSON.stringify({model:process.env.OPENAI_MODEL||"gpt-5.4",input:prompt})},12000);const j=await r.json();if(!r.ok)throw new Error(j.error?.message||"OpenAI");let text=j.output_text||j.output?.flatMap(o=>o.content||[]).map(c=>c.text||"").join("")||"";text=text.replace(/^```json\s*|```$/g,"").trim();const ai=JSON.parse(text);res.json({ok:true,...ai,articles:fallback.articles,mode:"ai"})}catch(e){res.json({ok:true,...fallback,warning:e.message})}
});

app.post("/api/feedback",async(req,res)=>{const key=process.env.OPENAI_API_KEY;if(!key)return res.status(503).json({ok:false,error:"OPENAI_API_KEY is not configured on the server."});const {event,expectation,reaction,reasoning,view,watch,snapshot}=req.body||{};const prompt=`너는 글로벌 IB S&T의 Rates/FX 멘토다. 다음 시장 추론을 엄밀하게 평가해라.\n시장:\n${snapshot||""}\nEvent:${event||""}\nExpectation:${expectation||""}\nReaction:${reaction||""}\nReasoning:${reasoning||""}\nView:${view||""}\nInvalidation:${watch||""}\n형식: 1 정확한 부분 2 약하거나 틀린 부분 3 빠진 변수/대안 설명 4 시장에 이미 반영된 것 5 면접식 개선답변 4~7문장 6 다음 질문 1개.`;try{const r=await fetchTimeout("https://api.openai.com/v1/responses",{method:"POST",headers:{"Content-Type":"application/json","Authorization":`Bearer ${key}`},body:JSON.stringify({model:process.env.OPENAI_MODEL||"gpt-5.4",input:prompt})},15000);const j=await r.json();if(!r.ok)throw new Error(j.error?.message||"OpenAI");let text=j.output_text||j.output?.flatMap(o=>o.content||[]).map(c=>c.text||"").join("\n");res.json({ok:true,text})}catch(e){res.status(502).json({ok:false,error:e.message})}});

app.get("*",(req,res)=>res.sendFile(path.join(__dirname,"public","index.html")));
app.listen(PORT,()=>console.log(`25M Markets running on :${PORT}`));