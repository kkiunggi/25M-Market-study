const express = require("express");
const path = require("path");
const app = express();
app.use(express.json({limit:"1mb"}));
app.use(express.static(path.join(__dirname,"public")));
const PORT = process.env.PORT || 3000;

function csvParse(text){
  const lines=text.trim().split(/\r?\n/);
  if(lines.length<2) return [];
  const h=lines[0].split(",");
  return lines.slice(1).map(line=>{
    const p=line.split(",");
    return Object.fromEntries(h.map((k,i)=>[k,p[i]]));
  });
}

async function fredCsv(id,days=380){
  const u=`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${encodeURIComponent(id)}`;
  const r=await fetch(u,{headers:{"User-Agent":"25M-Markets/1.0"}});
  if(!r.ok) throw new Error(`FRED ${id} ${r.status}`);
  const rows=csvParse(await r.text()).map(x=>({d:x.observation_date,v:Number(x[id])})).filter(x=>Number.isFinite(x.v));
  const cutoff=Date.now()-days*86400000;
  const filtered=rows.filter(x=>Date.parse(x.d)>=cutoff);
  const s=(filtered.length?filtered:rows).slice(-365);
  if(s.length<2) throw new Error(`FRED ${id} no data`);
  const last=s.at(-1), prev=s.at(-2);
  return {value:last.v,abs:last.v-prev.v,pct:(last.v-prev.v)/prev.v*100,series:s,date:last.d};
}

async function frankfurter(){
  const r=await fetch("https://api.frankfurter.dev/v2/rate/USD/KRW");
  if(!r.ok) throw new Error("Frankfurter");
  const j=await r.json();
  const end=new Date(j.date+"T00:00:00Z"),start=new Date(end.getTime()-370*86400000),f=d=>d.toISOString().slice(0,10);
  const rr=await fetch(`https://api.frankfurter.dev/v2/rates?base=USD&quotes=KRW&from=${f(start)}&to=${f(end)}`);
  if(!rr.ok) throw new Error("Frankfurter history");
  const hist=await rr.json(); let series=[];
  if(Array.isArray(hist)) series=hist.map(x=>({d:x.date,v:Number(x.rate)})).filter(x=>Number.isFinite(x.v));
  else if(hist.rates) series=Object.entries(hist.rates).map(([d,v])=>({d,v:Number(v.KRW??v)})).filter(x=>Number.isFinite(x.v));
  series.sort((a,b)=>a.d.localeCompare(b.d));
  const value=Number(j.rate),prev=series.length>1?series.at(-2).v:value;
  return {value,abs:value-prev,pct:prev?((value-prev)/prev*100):0,series:series.slice(-365),date:j.date};
}

async function ecos(item){
  const now=new Date(),start=new Date(now.getTime()-370*86400000),f=d=>d.toISOString().slice(0,10).replaceAll("-","");
  const url=`https://ecos.bok.or.kr/api/StatisticSearch/sample/json/kr/1/1000/817Y002/D/${f(start)}/${f(now)}/${item}`;
  const r=await fetch(url); if(!r.ok) throw new Error(`ECOS ${r.status}`);
  const j=await r.json();
  const rows=(j.StatisticSearch?.row||[]).map(x=>({d:x.TIME,v:Number(x.DATA_VALUE)})).filter(x=>Number.isFinite(x.v)).sort((a,b)=>a.d.localeCompare(b.d));
  if(rows.length<2) throw new Error("ECOS sample returned no data");
  const s=rows.slice(-365),last=s.at(-1),prev=s.at(-2);
  return {value:last.v,abs:last.v-prev.v,pct:(last.v-prev.v)/prev.v*100,series:s,date:last.d};
}

const defs=[
  {id:"us2y",label:"US 2Y",note:"Fed 정책 기대",unit:"%",axis:"Yield (%)",loader:()=>fredCsv("DGS2"),source:"FRED"},
  {id:"us10y",label:"US 10Y",note:"성장·인플레·term premium",unit:"%",axis:"Yield (%)",loader:()=>fredCsv("DGS10"),source:"FRED"},
  {id:"kr3y",label:"국고채 3Y",note:"BOK 기대",unit:"%",axis:"Yield (%)",loader:()=>ecos("010200000"),source:"BOK ECOS"},
  {id:"kr10y",label:"국고채 10Y",note:"한국 장기금리",unit:"%",axis:"Yield (%)",loader:()=>ecos("010210000"),source:"BOK ECOS"},
  {id:"usdkrw",label:"USD/KRW",note:"원화",unit:"",axis:"KRW per USD",loader:frankfurter,source:"Frankfurter"},
  {id:"usd",label:"USD Broad",note:"DXY 대체: broad dollar index",unit:"",axis:"Index",loader:()=>fredCsv("DTWEXBGS"),source:"FRED"},
  {id:"sp500",label:"S&P 500",note:"Risk sentiment",unit:"",axis:"Index",loader:()=>fredCsv("SP500"),source:"FRED"},
  {id:"nasdaq",label:"Nasdaq",note:"Growth / risk",unit:"",axis:"Index",loader:()=>fredCsv("NASDAQCOM"),source:"FRED"},
  {id:"brent",label:"Brent",note:"인플레·지정학",unit:"$",axis:"USD / barrel",loader:()=>fredCsv("DCOILBRENTEU"),source:"FRED"},
  {id:"vix",label:"VIX",note:"위험회피",unit:"",axis:"VIX index",loader:()=>fredCsv("VIXCLS"),source:"FRED"}
];

let cache={t:0,data:null};
app.get("/api/markets",async(req,res)=>{
  if(cache.data&&Date.now()-cache.t<300000)return res.json(cache.data);
  const results=await Promise.all(defs.map(async d=>{
    try{return {...d,...await d.loader(),source:d.source,ok:true}}
    catch(e){return {...d,ok:false,error:e.message,series:[]}}
  }));
  const payload={updatedAt:new Date().toISOString(),items:results};
  cache={t:Date.now(),data:payload};
  res.json(payload);
});

function decodeXml(s=""){
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,"$1")
    .replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">")
    .replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&#x27;/g,"'");
}
function tag(block,name){
  const m=block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`,`i`));
  return m?decodeXml(m[1].trim()):"";
}
function parseGoogleNewsRss(xml){
  const items=[...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)].map(m=>m[1]);
  return items.map(block=>{
    const title=tag(block,"title");
    const source=tag(block,"source") || (title.includes(" - ")?title.split(" - ").at(-1):"News");
    const rawTitle=title.endsWith(` - ${source}`)?title.slice(0,-(` - ${source}`).length):title;
    return {title:rawTitle,source,date:tag(block,"pubDate"),url:tag(block,"link")};
  }).filter(x=>x.title&&x.url);
}

const PREFERRED_SOURCES='(site:reuters.com OR site:cnbc.com OR site:investing.com OR site:ft.com OR site:bloomberg.com OR site:marketwatch.com)';
const DEFAULT_NEWS='("Federal Reserve" OR Treasury OR inflation OR "Bank of Korea" OR "Korean won" OR "S&P 500" OR Nasdaq OR "Brent crude")';

app.get("/api/news",async(req,res)=>{
  const asset=String(req.query.asset||"").trim().slice(0,240);
  const topic=asset||DEFAULT_NEWS;
  const q=`${topic} ${PREFERRED_SOURCES} when:2d`;
  const url=`https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`;
  try{
    const r=await fetch(url,{headers:{"User-Agent":"Mozilla/5.0 25M-Markets/1.0","Accept":"application/rss+xml, application/xml, text/xml"}});
    if(!r.ok) throw new Error(`Google News RSS ${r.status}`);
    const articles=parseGoogleNewsRss(await r.text()).slice(0,24);
    res.json({ok:true,provider:"Google News RSS",articles});
  }catch(e){
    res.status(502).json({ok:false,error:e.message,provider:"Google News RSS",articles:[]});
  }
});

app.post("/api/feedback",async(req,res)=>{
  const key=process.env.OPENAI_API_KEY;
  if(!key)return res.status(503).json({ok:false,error:"OPENAI_API_KEY is not configured on the server."});
  const {event,expectation,reaction,reasoning,view,watch,snapshot}=req.body||{};
  const prompt=`너는 글로벌 IB S&T의 Rates/FX 멘토다. 사용자가 매일 시장을 공부하면서 작성한 추론을 평가한다. 목표는 Event → market pricing/expectations → asset reaction → causal explanation의 연결을 훈련하는 것이다. 과도하게 칭찬하지 말고, 논리가 틀리거나 불완전하면 명확하게 지적해라.\n\n[시장 스냅샷]\n${snapshot||""}\n\n[사용자 답변]\nEvent: ${event||""}\nExpectation: ${expectation||""}\nReaction: ${reaction||""}\nReasoning: ${reasoning||""}\nMy view: ${view||""}\nWhat changes my mind: ${watch||""}\n\n한국어로 다음 형식:\n1. 잘 짚은 부분\n2. 틀리거나 약한 부분\n3. 빠진 변수 / 대안적 설명\n4. 시장이 이미 무엇을 가격에 반영했는지 점검\n5. S&T 면접식 개선 답변 (4~7문장)\n6. 다음에 스스로 답해볼 질문 1개`;
  try{
    const r=await fetch("https://api.openai.com/v1/responses",{
      method:"POST",
      headers:{"Content-Type":"application/json","Authorization":`Bearer ${key}`},
      body:JSON.stringify({model:process.env.OPENAI_MODEL||"gpt-5.4",input:prompt})
    });
    const j=await r.json();
    if(!r.ok)throw new Error(j.error?.message||`OpenAI ${r.status}`);
    let text=j.output_text;
    if(!text&&Array.isArray(j.output))text=j.output.flatMap(o=>o.content||[]).map(c=>c.text||"").join("\n");
    res.json({ok:true,text:text||"응답을 읽지 못했습니다."});
  }catch(e){res.status(502).json({ok:false,error:e.message})}
});

app.get("*",(req,res)=>res.sendFile(path.join(__dirname,"public","index.html")));
app.listen(PORT,()=>console.log(`25M Markets running on :${PORT}`));
