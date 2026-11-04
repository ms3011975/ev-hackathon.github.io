const {test}=require('node:test');
const assert=require('node:assert/strict');
const timing=require('../web/session-timing.js');
const sim=require('../web/simulation.js');
const report=require('../web/simulation-report.js');
const asOf=Date.parse('2026-11-04T10:00:00+09:00');
const row=(id='DEMO-A',i=0,speed='급속',minutes=30)=>({statId:id,chgerId:String(i),speed,start:'2026-11-04 08:00:00',end:`2026-11-04 ${minutes===60?'09:00':'08:'+String(minutes).padStart(2,'0')}:00`,minutes:String(minutes)});
const rows=[...Array.from({length:5},(_,i)=>row('DEMO-A',i)),...Array.from({length:6},(_,i)=>row('REGION',i,'완속',60))];
const makePlan=(records=rows,stations=sim.demo())=>timing.plan(records,stations,'43110',asOf,{repository:'https://example.com/records',commit:'a'.repeat(40),files:['fixture.csv']});
test('KST CSV and cleanup reject invalid/future/old/conflicting records and deduplicate',()=>{
  assert.equal(timing.timestamp('2026-11-04 10:00:00'),asOf);
  assert.ok(Number.isNaN(timing.timestamp('2026-02-30 10:00:00')));
  const parsed=timing.csv('\ufeffstatId,chgerId,speed,start,end,minutes\r\n"a,b",01,급속,2026-11-04 08:00:00,2026-11-04 08:30:00,30\r\n');
  assert.equal(parsed[0].statId,'a,b');
  const source=[row(),row(),{...row('conflict'),end:'2026-11-04 08:20:00',minutes:'20'},row('conflict'),
    {...row('old'),start:'2026-01-01 08:00:00',end:'2026-01-01 08:30:00'},
    {...row('future'),start:'2026-11-04 11:00:00',end:'2026-11-04 11:30:00'}, {...row('bad'),minutes:'-30'}];
  const c=timing.clean(source,asOf);
  assert.equal(c.rows.length,1);
  assert.deepEqual(c.excluded,{invalid:1,outsideWindow:2,duplicate:1,conflicting:2});
  assert.throws(()=>timing.csv('wrong,header\n1,2'),/필수/);
});
test('station then same-region/speed fallback has minimum five; sparse speed uses explicit power fallback',()=>{
  const p=makePlan();
  assert.equal(p.pools[p.stations[0].pool].level,'station');
  assert.equal(p.pools[p.stations[1].pool].level,'region');
  const slow=sim.demo().map(s=>({...s,speed:'slow',kw:7}));
  assert.equal(makePlan(rows,slow).pools[makePlan(rows,slow).stations[0].pool].mean,60);
  const empty=makePlan(rows.slice(0,4));
  assert.equal(empty.pools[empty.stations[0].pool].level,'power');
});
test('stationary residual length-weights sessions and respects energy and rating',()=>{
  const p=timing.adjusted({values:[10,30]},1,60);
  assert.equal(p.meanRemaining,12.5); // E[T²] / (2 E[T]), not E[T]/2=10
  assert.equal(timing.residual(p,.2,.5,1).total,10);
  assert.equal(timing.residual(p,.3,.5,1).total,30);
  const adjusted=timing.adjusted({values:[1,30]},15,60);
  assert.deepEqual(adjusted.values,[15,30]);assert.equal(adjusted.clipped,1);
  const r=timing.residual(adjusted,.1,.5,15);
  assert.equal(r.kw,60);assert.equal(r.remaining,7.5);
  assert.equal(timing.residual(timing.adjusted({values:[]},15,60),.9,.2,15).remaining,3);
});
test('empirical simulation preserves paired populations, conserves all energy and limits equivalent output',async()=>{
  const stations=sim.demo(),records=Array.from({length:5},(_,i)=>row('DEMO-A',i,'급속',i%2?30:1)),p=makePlan(records);
  const o={durationMode:'sessions',sessionPlan:p,energy:15,drivers:10,repeats:5,seed:42};
  const result=await sim.compare(stations,o);
  assert.throws(()=>sim.validate(stations,{...sim.defaults,...o,sessionPlan:null}),/완료 세션/);
  for(const r of result.results){
    const l=r.load;
    assert.equal(l.overRatedSessions,0);assert.ok(l.extendedSessions>0);
    assert.ok(Math.abs(l.stationEnergyKwh.reduce((a,b)=>a+b)-l.newEnergyKwh-l.initialEnergyKwh)<1e-7);
    assert.ok(Math.abs(l.series.reduce((n,kw)=>n+(kw[0]+kw[1])*.25,0)-l.newEnergyKwh-l.initialEnergyKwh)<1e-7);
    assert.equal(l.initialEnergyKwh,result.results[0].load.initialEnergyKwh);
    assert.deepEqual(r.records.map(d=>d.arrival),result.results[0].records.map(d=>d.arrival));
    for(const d of r.records) assert.ok(d.end-d.start>=15-1e-8);
  }
  const sweep=await sim.sweep(stations,o,'durationMode',['power','sessions']);
  assert.deepEqual(sweep.scenarios.find(s=>s.value==='sessions').results.map(({waitDelta,shareBDelta,...r})=>r),result.results);
  const reverse=await sim.sweep(stations,{...o,durationMode:'power'},'durationMode',['sessions']);
  assert.ok(reverse.scenarios.every(s=>s.results.every(r=>Number.isFinite(r.wait))));
  const behavior=await sim.compareBehavior(stations,o);
  assert.deepEqual(behavior.profiles.find(p=>p.id==='literature').results,result.results);
  result.evidence=sim.evidence(stations,result.options,{mode:'real'});
  assert.ok(result.evidence.find(e=>e.item==='완료 세션 출처').basis.includes('a'.repeat(40)));
  assert.match(report.html(result),/초기 잔여시간은 진행 중 시작시각 없이/);
  assert.ok(report.rows(result).some(r=>r[0]==='sessionPlan'&&JSON.parse(r[1]).source.commit==='a'.repeat(40)));
});
test('no sessions is an explicit physical fallback equal to power mode using the same random numbers',async()=>{
  const stations=sim.demo(),p=makePlan([]),o={drivers:3,repeats:3,energy:15,sessionPlan:p};
  const a=await sim.compare(stations,{...o,durationMode:'sessions'}), b=await sim.compare(stations,{...o,durationMode:'power'});
  assert.deepEqual(a.results,b.results);
});
test('v2 Poisson arrivals use empirical times with matching policy populations and energy even with zero new sessions',async()=>{
  const stations=sim.demo(),sessionPlan=makePlan(),startAt='2026-11-04T01:00:00.000Z';
  for(const expected of [[1,2],[0,0]]) {
    const forecastPlan={stationKeys:stations.map(s=>s.id+':'+s.speed),startAt,minutes:15,expectedDrivers:expected[0]+expected[1],
      intervals:[{start:0,end:15,startAt,endAt:'2026-11-04T01:15:00.000Z',expected,utilization:[1,.25]}]};
    const result=await sim.compare(stations,{durationMode:'sessions',sessionPlan,forecastPlan,drivers:forecastPlan.expectedDrivers,minutes:15,repeats:4});
    assert.ok(result.results.every(r=>r.load.overRatedSessions===0));
    for(const r of result.results){
      assert.deepEqual(r.records.map(d=>[d.origin,d.arrival]),result.results[0].records.map(d=>[d.origin,d.arrival]));
      assert.ok(Math.abs(r.load.newEnergyKwh-result.population.mean*result.options.energy)<1e-7);
      assert.equal(r.load.initialEnergyKwh,result.results[0].load.initialEnergyKwh);
    }
    if(!forecastPlan.expectedDrivers)assert.equal(result.population.emptyRuns,4);
  }
});
test('client pins commit, selects recent regional files, caches and retries failures',async()=>{
  const calls=[],sha='b'.repeat(40),csv='statId,chgerId,speed,start,end,minutes\nDEMO-A,01,급속,2026-11-04 08:00:00,2026-11-04 08:30:00,30\n';
  let fail=true;
  const fetcher=async url=>{
    calls.push(url);
    if(url.includes('/commits/'))return {ok:true,json:async()=>({sha})};
    if(url.includes('/git/trees/'))return {ok:true,json:async()=>({tree:['history/sessions/2026-11-04/43110.csv','history/sessions/2020-01-01/43110.csv','history/sessions/2026-11-04/43130.csv'].map(path=>({type:'blob',path}))})};
    if(fail)return {ok:false,status:503};return {ok:true,text:async()=>csv};
  };
  const client=timing.createClient(fetcher,{now:()=>asOf});
  await assert.rejects(client.load(sim.demo(),'43110',asOf),/503/);fail=false;
  const p=await client.load(sim.demo(),'43110',asOf);
  await client.load(sim.demo(),'43110',asOf);
  assert.equal(p.source.commit,sha);assert.equal(p.validRows,1);
  assert.equal(calls.filter(u=>u.includes('raw.githubusercontent')).length,2);
  assert.equal(p.source.files.length,1);assert.ok(calls.some(u=>u.includes('/'+sha+'/history/sessions/')));
});
