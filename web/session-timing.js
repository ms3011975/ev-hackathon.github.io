/* Completed public charging records -> empirical service-time pools. No kWh is inferred. */
(function(root,factory){if(typeof module==='object'&&module.exports) module.exports=factory();else root.ESSessionTiming=factory();})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const repo='ev-hackathon/ev-hackathon.github.io', minimum=5, days=30;
  function timestamp(value){
    const s=String(value||'').trim(), m=/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(s);
    if(!m) return NaN;
    const t=Date.UTC(+m[1],+m[2]-1,+m[3],+m[4]-9,+m[5],+m[6]);
    return new Date(t+32400000).toISOString().slice(0,19).replace('T',' ')===s.replace('T',' ')?t:NaN;
  }
  function csv(text){
    const rows=[];let row=[],cell='',quoted=false;
    for(let i=0;i<text.length;i++){
      const c=text[i];
      if(c==='"'){if(quoted&&text[i+1]==='"'){cell+='"';i++;}else quoted=!quoted;}
      else if(!quoted&&(c===','||c==='\n')){row.push(cell.replace(/\r$/,''));cell='';if(c==='\n'){rows.push(row);row=[];}}
      else cell+=c;
    }
    if(quoted) throw new Error('세션 CSV의 따옴표 형식이 잘못됐습니다.');
    if(cell||row.length){row.push(cell.replace(/\r$/,''));rows.push(row);}
    const header=(rows.shift()||[]).map(s=>s.replace(/^\ufeff/,''));
    if(!['statId','chgerId','speed','start','end','minutes'].every(k=>header.includes(k))) throw new Error('세션 CSV 필수 열이 없습니다.');
    return rows.filter(r=>r.some(Boolean)).map(r=>Object.fromEntries(header.map((k,i)=>[k,r[i]||''])));
  }
  function clean(rows,asOf){
    const excluded={invalid:0,outsideWindow:0,duplicate:0,conflicting:0}, seen=new Map(), conflicts=new Set();
    for(const r of rows){
      const start=timestamp(r.start),end=timestamp(r.end),minutes=(end-start)/60000, reported=Number(r.minutes);
      const speed=({'급속':'fast','완속':'slow',fast:'fast',slow:'slow'})[r.speed];
      if(!r.statId||!r.chgerId||!speed||!Number.isFinite(minutes)||minutes<1||minutes>1440||!Number.isFinite(reported)||Math.abs(minutes-reported)>.2){excluded.invalid++;continue;}
      if(end>asOf||end<asOf-days*86400000){excluded.outsideWindow++;continue;}
      const k=`${r.statId}|${r.chgerId}|${start}`;
      if(conflicts.has(k)){excluded.conflicting++;continue;}
      if(seen.has(k)){
        if(seen.get(k).end!==end){seen.delete(k);conflicts.add(k);excluded.conflicting+=2;}
        else excluded.duplicate++;
        continue;
      }
      seen.set(k,{id:r.statId,speed,start,end,minutes});
    }
    return {rows:[...seen.values()],excluded};
  }
  function summary(values){
    const a=[...values].sort((x,y)=>x-y), n=a.length;
    const q=p=>n?a[Math.min(n-1,Math.floor((n-1)*p))]:null;
    return {n,mean:n?a.reduce((s,v)=>s+v,0)/n:null,p10:q(.1),p50:q(.5),p90:q(.9)};
  }
  function plan(rows,stations,region,asOf,source={}){
    const c=clean(rows,asOf), pools={}, selected=[];
    for(const s of stations){
      const local=c.rows.filter(r=>r.id===s.id&&r.speed===s.speed), regional=c.rows.filter(r=>r.speed===s.speed);
      const level=local.length>=minimum?'station':regional.length>=minimum?'region':'power';
      const key=level==='station'?`${s.id}:${s.speed}`:`${region}:${s.speed}:${level}`;
      if(!pools[key]){const use=level==='station'?local:level==='region'?regional:[];const values=use.map(r=>r.minutes).sort((a,b)=>a-b);
        pools[key]={level,values,...summary(values),firstEnd:use.length?new Date(use.reduce((a,r)=>Math.min(a,r.end),Infinity)).toISOString():null,lastEnd:use.length?new Date(use.reduce((a,r)=>Math.max(a,r.end),-Infinity)).toISOString():null};}
      selected.push({id:s.id,speed:s.speed,pool:key,stationN:local.length,regionN:regional.length});
    }
    return {version:'completed-sessions-v1',region,asOf:new Date(asOf).toISOString(),minimum,windowDays:days,
      windowStart:new Date(asOf-days*86400000).toISOString(),source,excluded:c.excluded,rawRows:rows.length,validRows:c.rows.length,pools,stations:selected,
      residualMethod:'현재 시작시각 미공개: 긴 세션일수록 관측되기 쉬움을 반영해 총시간에 비례하여 표본을 선택하고 잔여 비율을 균등 추출. 정상상태 가정이며 실측 잔여시간 아님'};
  }
  function adjusted(pool,energy,kw){
    const floor=energy/kw*60, values=pool?.values?.length?pool.values.map(t=>Math.max(t,floor)):[floor];
    const total=values.reduce((s,t)=>s+t,0);let acc=0;
    const cumulative=values.map(t=>{acc+=t;return acc;});
    return {values,total,cumulative,minMinutes:floor,clipped:pool?.values?.filter(t=>t<floor).length||0,
      mean:total/values.length,meanRemaining:values.reduce((s,t)=>s+t*t,0)/(2*total),fallback:!pool?.values?.length};
  }
  function sample(pool,u){return pool.values[Math.min(pool.values.length-1,Math.floor(Math.max(0,Math.min(.999999999,u))*pool.values.length))];}
  function residual(pool,u,v,energy){
    if(pool.fallback) return {remaining:v*pool.minMinutes,kw:energy*60/pool.minMinutes,total:pool.minMinutes};
    const target=Math.max(0,Math.min(.999999999,u))*pool.total;let lo=0,hi=pool.cumulative.length-1;
    while(lo<hi){const mid=(lo+hi)>>1;if(pool.cumulative[mid]>target)hi=mid;else lo=mid+1;}
    const total=pool.values[lo];return {remaining:v*total,total,kw:energy*60/total};
  }
  function createClient(fetcher,{now=Date.now}={}){
    let indexPromise=null,indexAt=0;const regions=new Map();
    async function json(url){const r=await fetcher(url,{credentials:'omit',cache:'no-store',signal:AbortSignal.timeout(20000)});if(!r.ok)throw new Error(`세션 자료 응답 ${r.status}`);return r.json();}
    async function index(){
      if(!indexPromise||now()-indexAt>1800000){indexAt=now();indexPromise=(async()=>{
        const commit=await json(`https://api.github.com/repos/${repo}/commits/history`);
        if(!/^[a-f0-9]{40}$/.test(commit.sha))throw new Error('세션 이력 버전을 확인하지 못했습니다.');
        const tree=await json(`https://api.github.com/repos/${repo}/git/trees/${commit.sha}?recursive=1`);
        if(tree.truncated||!Array.isArray(tree.tree))throw new Error('세션 파일 목록이 불완전합니다.');return {sha:commit.sha,files:tree.tree};
      })().catch(e=>{indexPromise=null;throw e;});}
      return indexPromise;
    }
    async function load(stations,region,asOf=now()){
      if(!/^\d{5}$/.test(region))throw new Error('세션 분석 지역을 확인하세요.');
      const idx=await index(), key=idx.sha+':'+region+':'+new Date(asOf+32400000).toISOString().slice(0,10);
      if(!regions.has(key)) regions.set(key,(async()=>{
        const first=new Date(asOf-days*86400000+32400000).toISOString().slice(0,10),last=new Date(asOf+32400000).toISOString().slice(0,10);
        const files=idx.files.filter(f=>f.type==='blob'&&new RegExp(`^history/sessions/\\d{4}-\\d{2}-\\d{2}/${region}\\.csv$`).test(f.path)&&f.path.split('/')[2]>=first&&f.path.split('/')[2]<=last);
        const rows=[];for(let i=0;i<files.length;i+=4){
          const batch=await Promise.all(files.slice(i,i+4).map(async f=>{const r=await fetcher(`https://raw.githubusercontent.com/${repo}/${idx.sha}/${f.path}`,{credentials:'omit',signal:AbortSignal.timeout(20000)});if(!r.ok)throw new Error(`세션 파일 응답 ${r.status}`);return csv(await r.text());}));batch.forEach(a=>rows.push(...a));
        }
        return {rows,files:files.map(f=>f.path)};
      })().catch(e=>{regions.delete(key);throw e;}));
      const data=await regions.get(key);
      return plan(data.rows,stations,region,asOf,{repository:`https://github.com/${repo}/tree/${idx.sha}/history/sessions`,commit:idx.sha,files:data.files,fetchedAt:new Date(now()).toISOString()});
    }
    return {load};
  }
  return {timestamp,csv,clean,summary,plan,adjusted,sample,residual,createClient};
});
