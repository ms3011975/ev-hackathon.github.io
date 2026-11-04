const {test}=require('node:test');
const assert=require('node:assert/strict');
const routing=require('../web/routing.js');
const sim=require('../web/simulation.js');
const report=require('../web/simulation-report.js');
const stations=()=>sim.demo();
const payload=()=>({code:'Ok',distances:[[0,1234],[2345,0]],durations:[[0,120],[180,0]],sources:[{distance:10},{distance:20}]});

test('car routing decodes directional meters and rejects missing routes, distant snapping and invalid coordinates',()=>{
  const s=stations(), r=routing.decode(payload(),s,'2026-11-04T00:00:00Z');
  assert.deepEqual(r.roadDistances,[1.234,2.345]);
  assert.deepEqual(r.seconds,[120,180]);
  assert.match(r.url,/127.489000,36.642400;127.489000,36.660400/);
  assert.match(r.url,/routed-car\/table\/v1\/driving/);
  for(const change of [p=>p.code='NoTable',p=>p.distances[0][1]=null,p=>p.distances[1][0]=-1,p=>p.durations[1][0]=null,p=>p.sources[0].distance=201]){
    const p=payload();change(p);assert.throws(()=>routing.decode(p,s));
  }
  assert.throws(()=>routing.key([{id:'A',lat:NaN,lng:127},s[1]]));
  assert.throws(()=>routing.key([s[0],s[0]]));
});

test('routing client coalesces requests, caches by coordinates, throttles and retries errors without fake distance',async()=>{
  let at=0, calls=0, fail=false;
  const sleeps=[], fetcher=async()=>{calls++;if(fail) return {ok:false,status:503};return {ok:true,json:async()=>payload()};};
  const client=routing.createClient(fetcher,{now:()=>at,sleep:async ms=>{sleeps.push(ms);at+=ms;}});
  const s=stations();
  const [a,b]=await Promise.all([client.get(s),client.get(s)]);
  assert.equal(calls,1);assert.deepEqual(a,b);
  await client.get(s);assert.equal(calls,1);
  await client.get(s,true);assert.equal(calls,2);assert.deepEqual(sleeps,[1000]);
  s[1].lat+=.001;fail=true;
  await assert.rejects(client.get(s),/503/);fail=false;
  await client.get(s);assert.equal(calls,4);
});

test('simulation uses origin-specific road distance in choices and reporting; distance sweep clears road matrix for changed levels',async()=>{
  const s=stations().map(x=>({...x,avail:4,charging:0})), o={...sim.defaults,drivers:2,repeats:2,roadDistances:[1,3],distance:1,alpha:100,sensitivity:0,beta:0,tau:100};
  const people={initial:[[],[]],drivers:[{id:0,origin:0,arrival:0,duration:20,choice:.9},{id:1,origin:1,arrival:20,duration:20,choice:.01}]};
  const r=sim.runPolicy(s,o,people,0);
  assert.deepEqual(r.records.map(x=>x.extraDistance),[1,3]);assert.equal(r.distance,2);
  const own=sim.runPolicy(s,o,{initial:[[],[]],drivers:[{id:0,origin:1,arrival:0,duration:20,choice:.5}]},0);
  assert.equal(own.records[0].station,1);assert.equal(own.distance,0);
  const sweep=await sim.sweep(s,o,'distance',[2]);
  assert.deepEqual(sweep.scenarios.find(p=>p.value===1).options.roadDistances,[1,3]);
  assert.equal(sweep.scenarios.find(p=>p.value===2).options.roadDistances,undefined);
  const ctx={distanceMode:'road',roadRoute:{provider:'OSRM fixture',fetchedAt:'2026-11-04',url:'https://example.org',snapMeters:[1,2]}};
  assert.equal(sim.evidence(s,o,ctx).find(x=>x.item==='대체 충전소 도로 거리').kind,'추정값');
  assert.equal(sim.evidence(s,{...o,roadDistances:undefined},ctx).find(x=>x.item==='대체 충전소 도로 거리').kind,'미입력');
  const output=await sim.compare(s,o);output.context=ctx;output.evidence=sim.evidence(s,o,ctx);
  assert.match(report.html(output),/openstreetmap.org\/copyright/);
  assert.match(report.html(output),/A→B 1.000km \/ B→A 3.000km/);
  assert.ok(report.rows(output).some(r=>r[0]==='roadDistances' && r[1]==='[1,3]'));
  await assert.rejects(sim.compare(s,{...o,roadDistances:[null,2]}),/도로 거리/);
});
