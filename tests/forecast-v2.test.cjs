const {test}=require('node:test');
const assert=require('node:assert/strict');
const sim=require('../web/simulation.js');
const report=require('../web/simulation-report.js');
const start=Date.parse('2026-11-04T11:00:00+09:00'), now=start+300000;
function fixture() {
  return {schema_version:2,model_name:'v2 integration fixture',generated_at:new Date(start).toISOString(),simulation_start_at:new Date(start).toISOString(),
    interval_minutes:15,baseline:'existing_prices_without_new_policy',demand_measure:'charging_starts',
    method:{expected_new_sessions:'fixture estimates'},validation:{fast:{n_station_hours:10}},
    duration_minutes:{fast:{n:20,mean:40}},stations:[{station_id:'DEMO-A',speed:'fast',mean_duration_minutes:40,duration_level:'region'}],
    predictions:[0,1].flatMap(b=>['DEMO-A','DEMO-B'].map((id,i)=>({station_id:id,speed:'fast',
      interval_start:new Date(start+b*900000).toISOString(),interval_end:new Date(start+(b+1)*900000).toISOString(),
      utilization_mean:b ? [1,.2][i] : [.2,1][i],expected_new_sessions:b ? [1.2,.1][i] : [.4,.8][i]})))};
}
const parse=payload=>sim.forecastV2(payload,sim.demo(),{now,observedAt:now-60000});
function options(prediction, extra={}) {return {...sim.defaults,drivers:prediction.plan.expectedDrivers,minutes:prediction.plan.minutes,forecastPlan:prediction.plan,repeats:10,...extra};}

test('expired v2 identifies upstream generation age and never relabels old demand as current',()=>{
  assert.throws(()=>sim.forecastV2(fixture(),sim.demo(),{now:start+91*60000,observedAt:start+91*60000}),e=>
    /AI 예측 유효기간 초과/.test(e.message)&&/91분/.test(e.message)&&/허용 90분/.test(e.message)&&/원본 모델/.test(e.message));
  assert.throws(()=>sim.forecastV2(fixture(),sim.demo(),{now,observedAt:now-46*60000}),/상태 수집.*원본 수집/);
  const e=sim.evidence(sim.demo(),{...sim.defaults,drivers:0,minutes:0},{demandRequested:true});
  for(const label of ['신규 운전자','도착 생성 기간']){
    const row=e.find(r=>r.item===label);assert.equal(row.kind,'연결 필요');assert.equal(row.value,'AI 예측 연결 필요');
  }
});

test('behavior presets share fractional v2 demand, quotes and initial energy including zero demand',async()=>{
  for(const zero of [false,true]){
    const raw=fixture(); if(zero) raw.predictions.forEach(r=>r.expected_new_sessions=0);
    const p=parse(raw), o=options(p), before=JSON.stringify(o);
    const out=await sim.compareBehavior(sim.demo(),o,()=>{},p.utilizationById);
    const [a,b]=out.profiles;
    assert.deepEqual(a.population,b.population);
    for(let i=0;i<3;i++){
      assert.deepEqual(a.results[i].priceSchedule,b.results[i].priceSchedule);
      assert.equal(a.results[i].load.newEnergyKwh,b.results[i].load.newEnergyKwh);
      assert.equal(a.results[i].load.initialEnergyKwh,b.results[i].load.initialEnergyKwh);
    }
    if(zero) assert.equal(b.population.emptyRuns,10);
    assert.equal(JSON.stringify(o),before);
  }
});

test('v2 clips elapsed demand, prorates a partial bin and retains model provenance',()=>{
  const raw=fixture(), before=JSON.stringify(raw), p=parse(raw);
  assert.equal(p.plan.minutes,25);
  assert.ok(Math.abs(p.plan.expectedDrivers-2.1)<1e-9);
  assert.equal(p.plan.intervals[0].start,0); assert.equal(p.plan.intervals[0].end,10);
  assert.equal(p.plan.intervals[1].start,10); assert.equal(p.plan.intervals[1].end,25);
  assert.ok(p.plan.intervals[0].partial);
  assert.equal(p.plan.startAt,new Date(now).toISOString());
  assert.equal(p.plan.stationStats[0].duration_level,'region');
  assert.equal(p.plan.durationStats.mean,40);
  assert.equal(JSON.stringify(raw),before);
});

test('v2 rejects stale observations, expired times, gaps, duplicates and invalid demand',()=>{
  for (const change of [
    p=>{p.schema_version=1;},p=>{p.example_only=true;},p=>{p.model_name=5;},
    p=>{p.demand_measure='arrivals';},p=>{p.baseline='new_policy';},p=>{p.interval_minutes=30;},
    p=>{p.generated_at='2026-11-04T11:00:00';},p=>{p.generated_at=new Date(now+360000).toISOString();},
    p=>{p.predictions.pop();},p=>{p.predictions.push(p.predictions[0]);},
    p=>{p.predictions[0].expected_new_sessions=-1;},p=>{p.predictions[0].utilization_mean=1.1;},
    p=>{p.predictions[0].interval_end=new Date(start+1800000).toISOString();},
    p=>{p.predictions.forEach(r=>r.speed='slow');}
  ]) {const p=fixture();change(p);assert.throws(()=>parse(p));}
  assert.throws(()=>sim.forecastV2(fixture(),sim.demo(),{now,observedAt:now-46*60000}),/45분/);
  assert.throws(()=>sim.forecastV2(fixture(),sim.demo(),{now,observedAt:now+360000}),/45분/);
  assert.throws(()=>sim.forecastV2(fixture(),sim.demo(),{now:start+1800000,observedAt:start+1800000}),/남은/);
});

test('v2 demand controls cannot silently disagree with the validated plan',()=>{
  const p=parse(fixture()), o=options(p);
  assert.doesNotThrow(()=>sim.validate(sim.demo(),o));
  for(const changed of [{drivers:24},{minutes:60},{forecastPlan:{...p.plan,stationKeys:['other:fast','DEMO-B:fast']}}]) assert.throws(()=>sim.validate(sim.demo(),{...o,...changed}));
  assert.throws(()=>parse({...fixture(),predictions:fixture().predictions.map(r=>({...r,expected_new_sessions:1000}))}),/500건/);
});

test('v2 uses arrival-bin quotes and origin-specific diversion distance',()=>{
  const stations=sim.demo().map(s=>({...s,charging:0,avail:4})), p=parse(fixture());
  const people={initial:[[],[]],drivers:[{id:0,origin:0,arrival:0,duration:20,choice:0},{id:1,origin:0,arrival:20,duration:20,choice:0}]};
  const r=sim.runPolicy(stations,options(p,{sensitivity:0,alpha:0,beta:0}),people,1,p.utilizationById);
  assert.deepEqual(r.records.map(x=>x.price),[277.8,399.3]);
  assert.equal(r.discountedCount,1);assert.equal(r.surchargedCount,1);
  assert.ok(Math.abs(r.revenue-(277.8+399.3)*sim.defaults.energy)<1e-8);
  const own=sim.runPolicy(stations,options(p,{sensitivity:0,alpha:100000,beta:0,tau:1}),
    {initial:[[],[]],drivers:[{id:0,origin:1,arrival:0,duration:20,choice:.5}]},0,p.utilizationById);
  assert.equal(own.records[0].station,1); assert.equal(own.distance,0);
});

test('fractional Poisson demand is reproducible and shared across policies and sweeps',async()=>{
  const p=parse(fixture()), o=options(p,{repeats:100,discount:0,surcharge:0});
  const a=await sim.compare(sim.demo(),o,()=>{},p.utilizationById);
  assert.deepEqual(a,await sim.compare(sim.demo(),o,()=>{},p.utilizationById));
  assert.ok(a.population.emptyRuns>0); assert.ok(a.population.max>a.population.min);
  for(const r of a.results) {
    assert.deepEqual(r.records,a.results[0].records);
    assert.deepEqual(r.load,a.results[0].load);
    assert.ok(Math.abs(r.count[0]+r.count[1]-a.population.mean)<1e-8);
    assert.ok(Math.abs(r.revenue-r.fee*a.population.mean)<1e-7);
    assert.ok(Math.abs(r.load.newEnergyKwh-a.population.mean*o.energy)<1e-8);
  }
  const sweep=await sim.sweep(sim.demo(),{...o,repeats:3},'alpha',[300,900],()=>{},p.utilizationById);
  for(const s of sweep.scenarios) assert.deepEqual(s.population,sweep.scenarios[0].population);
  for(const key of ['drivers','minutes']) await assert.rejects(sim.sweep(sim.demo(),o,key,[1]),/예측에서/);
});

test('zero v2 demand preserves initial load and produces finite results with explicit no-arrivals report',async()=>{
  const raw=fixture();raw.predictions.forEach(r=>r.expected_new_sessions=0);
  const p=parse(raw), r=await sim.compare(sim.demo(),options(p),()=>{},p.utilizationById);
  assert.equal(r.population.mean,0); assert.equal(r.population.emptyRuns,10);
  for(const out of r.results) {
    assert.equal(out.wait,0);assert.equal(out.fee,0);assert.equal(out.load.newEnergyKwh,0);
    assert.ok(out.load.initialEnergyKwh>0);assert.equal(out.waitSE,null);
  }
  const html=report.html(r);
  assert.ok(html.includes('모든 반복이 0명'));
  assert.ok(html.includes('v2 기준 수요와 구간별 요금'));
});

test('v2 evidence keeps kWh and behavior assumed while exporting forecast timing and quotes',async()=>{
  const p=parse(fixture()), output=await sim.compare(sim.demo(),options(p),()=>{},p.utilizationById);
  const evidence=sim.evidence(sim.demo(),output.options,{mode:'real',forecastInfo:p.model,forecastUtilizationA:.2,forecastUtilizationB:1});
  assert.equal(evidence.find(r=>r.item==='신규 운전자').kind,'추정값');
  assert.equal(evidence.find(r=>r.item==='차량당 충전량').kind,'가정값');
  assert.equal(evidence.find(r=>r.item==='이동 비용 α').kind,'가정값');
  assert.ok(evidence.find(r=>r.item==='A v2 충전시간 통계 참고').basis.includes('kWh는 시간으로 역산하지 않음'));
  output.evidence=evidence;
  const rows=report.rows(output);
  assert.ok(rows.some(r=>r[0]==='시작_ISO'));
  assert.ok(rows.some(r=>r[0]==='forecastPlan' && typeof r[1]==='string' && JSON.parse(r[1]).demandMeasure==='charging_starts'));
  assert.ok(report.html(output).includes('구간별 요금'));
});
