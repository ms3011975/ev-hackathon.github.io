const { test } = require('node:test');
const assert = require('node:assert/strict');
const sim = require('../web/simulation.js');
const fs = require('node:fs');
const vm = require('node:vm');
const report = require('../web/simulation-report.js');

test('Jeju defaults follow speed and manual/sweep overrides retain honest provenance', async () => {
  assert.equal(sim.defaults.energy,14.82);
  const stations=sim.demo().map(s=>({...s,speed:'slow',kw:7}));
  const output=await sim.compare(stations,{drivers:2,repeats:1});
  assert.equal(output.options.energy,16.24);
  assert.ok(Math.abs(output.results[0].load.newEnergyKwh-32.48)<1e-8);
  const context={speed:'slow',energySource:'jeju'};
  const row=o=>sim.evidence(stations,o,context).find(r=>r.item==='차량당 충전량');
  assert.equal(row(output.options).kind,'추정값');
  assert.match(row(output.options).basis,/131656건/);
  assert.match(row(output.options).basis,/단위 미기재/);
  assert.match(row(output.options).basis,/15109706/);
  assert.equal(row({...output.options,energy:30}).kind,'가정값');
  assert.equal(sim.evidence(stations,output.options,{...context,energySource:'manual'}).find(r=>r.item==='차량당 충전량').kind,'가정값');
  output.context=context;output.evidence=sim.evidence(stations,output.options,context);
  assert.match(report.html(output),/제주 자료 기반 추정값/);
  assert.ok(report.rows(output).some(r=>String(r).includes('131656건')));
});

test('15-minute load conserves energy with partial bins and uses coincident aggregate peaks', () => {
  const stations = sim.demo(), o = {...sim.defaults,minutes:45,energy:15};
  const profile = sim.loadProfile(stations,o,[[],[]],[
    {station:0,start:0,end:15},{station:1,start:15,end:30}
  ]);
  assert.deepEqual(profile.stationPeakKw,[60,60]);
  assert.equal(profile.combinedPeakKw,60);
  assert.equal(profile.newEnergyKwh,30);
  assert.equal(profile.series.reduce((s,v)=>s+(v[0]+v[1])*.25,0),30);
  const partial = sim.loadProfile(stations,{...o,energy:30},[[],[]],[{station:0,start:7,end:37}]);
  assert.deepEqual(partial.series,[[32,0],[60,0],[28,0]]);
  assert.equal(partial.series.reduce((s,v)=>s+v[0]*.25,0),30);
});

test('load includes initial residual energy and all deferred charging past the arrival horizon', () => {
  const stations = sim.demo();
  const profile = sim.loadProfile(stations,{...sim.defaults,energy:30,minutes:30},[[20],[]],[{station:0,start:20,end:50}]);
  assert.equal(profile.initialEnergyKwh,20);
  assert.equal(profile.newEnergyKwh,30);
  assert.equal(profile.tailEnergyKwh,20);
  assert.equal(profile.unfinishedAtHorizon,1);
  assert.equal(profile.series.reduce((s,v)=>s+v[0]*.25,0),50);
  assert.equal(profile.stationEnergyKwh[0],50);
});

test('inconsistent assumed durations flag implied power above rating without losing energy', () => {
  const profile = sim.loadProfile(sim.demo(),{...sim.defaults,energy:30},[[],[]],[{station:0,start:0,end:20}]);
  assert.equal(profile.overRatedSessions,1);
  assert.equal(profile.stationPeakKw[0],90);
  assert.equal(profile.series.reduce((s,v)=>s+v[0]*.25,0),30);
  const empty = sim.loadProfile(sim.demo(),sim.defaults,[[],[]],[]);
  assert.equal(empty.combinedPeakKw,0);
  assert.equal(empty.tailEnergyKwh,0);
  assert.equal(empty.utilizationGapPp,0);
  assert.equal(sim.loadProfile(sim.demo(),sim.defaults,[[],[]],[{station:0,start:0,end:400000}]).available,false);
});

test('reported peak is mean of repetition peaks, not maximum of mean curve', async () => {
  const stations = sim.demo().map(s=>({...s,avail:1,charging:0}));
  const populations = [0,15].map(arrival=>({initial:[[],[]],drivers:[{id:0,arrival,duration:30,choice:0}]}));
  const {results} = await sim.compare(stations,{drivers:1,energy:15,minutes:30,repeats:2,durationMode:'power'},()=>{},undefined,{populations});
  for (const r of results) {
    assert.equal(r.load.combinedPeakKw,60);
    assert.equal(Math.max(...r.load.series.map(v=>v[0]+v[1])),30);
    assert.equal(r.load.peakSE,0);
    assert.equal(r.load.peakDeltaSE,0);
    assert.equal(r.load.combinedPeakReductionPct,0);
  }
});

test('repeated policy loads preserve demand, rating and zero-policy equivalence', async () => {
  const {results,options:o} = await sim.compare(sim.demo(),{repeats:7,durationMode:'power',discount:0,surcharge:0});
  for (const r of results) {
    assert.deepEqual(r.load,results[0].load);
    assert.ok(Math.abs(r.load.newEnergyKwh-o.drivers*o.energy)<1e-9);
    assert.ok(Math.abs(r.load.series.reduce((s,v)=>s+(v[0]+v[1])*.25,0)-r.load.newEnergyKwh-r.load.initialEnergyKwh)<1e-8);
    assert.equal(r.load.overRatedSessions,0);
    for (let i=0;i<2;i++) assert.ok(r.load.stationPeakKw[i]<=r.load.capacityKw[i]+1e-8);
  }
});

test('shareable report escapes source labels and exports full aligned profiles', async () => {
  const output = await sim.compare(sim.demo(),{repeats:2,durationMode:'power'});
  output.context={source:'<script>alert(1)</script>',region:'example',executedAt:'2026-11-03'};
  output.evidence=[{item:'<img onerror=bad>',value:'x',kind:'가정값',basis:'fixture'}];
  const html=report.html(output), rows=report.rows(output);
  assert.ok(html.startsWith('<!doctype html>'));
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('합산 피크 저감률'));
  assert.ok(html.includes('실제 배전망 측정 결과 아님'));
  const header=rows.findIndex(r=>r[1]==='구간시작_분');
  assert.equal(rows.length-header-1,Math.max(...output.results.map(r=>r.load.series.length))*3);
  assert.equal(rows[header+1][1],0);
});

test('format-only examples cannot be executed as actual AI model outputs', () => {
  assert.throws(()=>sim.forecast({example_only:true},sim.demo()),/형식 설명용/);
});

test('sensitivity baseline matches ordinary comparison and does not mutate inputs', async () => {
  const stations = sim.demo(), options = {...sim.defaults,repeats:4}, copy = JSON.stringify({stations,options});
  const normal = await sim.compare(stations,options), sweep = await sim.sweep(stations,options,'drivers',[12,36]);
  assert.deepEqual(sweep.scenarios.map(s=>s.value),[12,24,36]);
  const reference = sweep.scenarios.find(s=>s.value===24);
  for (let p=0;p<3;p++) {
    assert.deepEqual(reference.results[p].records, normal.results[p].records);
    assert.equal(reference.results[p].wait,normal.results[p].wait);
    assert.equal(reference.results[p].waitDelta,0);
  }
  const fewer = sweep.scenarios[0].results[0].records;
  const more = sweep.scenarios[2].results[0].records;
  for (const d of fewer) assert.equal(d.arrival,more.find(x=>x.driver===d.driver).arrival);
  assert.equal(JSON.stringify({stations,options}),copy);
});
test('sensitivity reuses randomness, is reproducible and handles percentages, modes and forecast', async () => {
  const options = {...sim.defaults,repeats:3};
  const a = await sim.sweep(sim.demo(),options,'discount',[0,.2,.4]);
  assert.deepEqual(a,await sim.sweep(sim.demo(),options,'discount',[0,.2,.4]));
  for (const s of a.scenarios) assert.deepEqual(s.results[0].records,a.scenarios[0].results[0].records);
  for (const s of a.scenarios) for (const r of s.results) assert.ok(Math.abs(r.waitDelta-(r.wait-a.scenarios.find(x=>x.value===a.baseline).results[r.policy].wait))<1e-9);
  const f = await sim.sweep(sim.demo(),options,'discount',[.3],()=>{}, {'DEMO-A':.2,'DEMO-B':1});
  assert.equal(f.scenarios.find(x=>x.value===.3).results[1].prices[0],243);
  const modes = await sim.sweep(sim.demo(),options,'durationMode',['assumed','power']);
  assert.equal(modes.scenarios.length,2);
});
test('sensitivity rejects invalid input, excessive work and supports cancellation', async () => {
  const options = {...sim.defaults,repeats:2};
  for (const [key,values] of [['seed',[1]],['drivers',[1.2]],['alpha',[NaN]],['threshold',[1]],['energy',[]],['drivers',Array(9).fill(24)]]) await assert.rejects(sim.sweep(sim.demo(),options,key,values));
  await assert.rejects(sim.sweep(sim.demo(),{...options,repeats:500,drivers:500},'alpha',[1,2,3]),/분석량/);
  let cancel=false;
  await assert.rejects(sim.sweep(sim.demo(),options,'alpha',[300,900],()=>{cancel=true;},undefined,()=>cancel),/중단/);
});
test('evidence distinguishes observed status, tariff fallback, assumptions and computed distance', () => {
  const stations=sim.demo(); stations[0].source='운영사'; stations[1].source='공공 기준(미등재)';
  const rows=sim.evidence(stations,sim.defaults,{mode:'real',distanceMode:'coords',source:'test timestamp'});
  assert.equal(rows.find(r=>r.item==='A 초기 충전기 상태').kind,'실측·수집값');
  assert.equal(rows.find(r=>r.item==='A 기본 단가').kind,'공시값');
  assert.equal(rows.find(r=>r.item==='B 기본 단가').kind,'추정값');
  assert.equal(rows.find(r=>r.item==='B 추가 거리').kind,'추정값');
  assert.equal(rows.find(r=>r.item==='신규 운전자').kind,'가정값');
  const demo=sim.evidence(stations,sim.defaults,{mode:'demo',distanceMode:'manual'});
  assert.ok(!demo.some(r=>r.kind==='실측·수집값'));
  assert.equal(demo.find(r=>r.item==='B 추가 거리').kind,'가정값');
  const forecast=sim.evidence(stations,sim.defaults,{mode:'real',forecastRequested:true});
  assert.equal(forecast.find(r=>r.item==='요금 판정 근거').kind,'미입력');
});

test('personal Pages uses public snapshots only when local data is absent', async () => {
  const template = fs.readFileSync(require.resolve('../web/index.template.html'), 'utf8');
  const detector = template.match(/async function detectServer\([^]*?\n}/)[0];
  async function check(hostname, local) {
    const calls = [], region = {code:'43110'};
    const status = {ok:true,regions:{'43110':{}}};
    const context = {state:{region,staticBase:''},REGIONS:[region],location:{hostname},
      getJSON:async url=>{calls.push(url); return url==='data/status.json'?local:url.startsWith('https:')?status:null;},
      renderRegions(){},refresh(){},loadLive(){},setInterval(){}};
    vm.createContext(context); vm.runInContext(detector,context); await context.detectServer();
    return {calls,state:context.state};
  }
  const personal = await check('ms3011975.github.io',null);
  assert.equal(personal.state.staticBase,'https://ev-hackathon.github.io/');
  assert.equal(personal.state.server,'static');
  const local = await check('ms3011975.github.io',{ok:true,regions:{'43110':{}}});
  assert.deepEqual(local.calls,['data/status.json']);
  const original = await check('ev-hackathon.github.io',null);
  assert.deepEqual(original.calls,['data/status.json','api/health']);
});

test('all generated inline JavaScript parses and status matches existing monitor classifier', () => {
  const html = fs.readFileSync(require.resolve('../docs/index.html'), 'utf8');
  for (const match of html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)) {
    if (!match[1].includes('application/json')) new vm.Script(match[2]);
  }
  const template = fs.readFileSync(require.resolve('../web/index.template.html'), 'utf8');
  const classifier = template.match(/function classifyStatus\([^]*?\n}/)[0];
  const context = {}; vm.runInNewContext(classifier + '; this.classify = classifyStatus;', context);
  for (let avail = 0; avail < 6; avail++) for (let charging = 0; charging < 6; charging++) for (const fault of [0, 3]) for (const threshold of [.1, .5, .9]) {
    assert.equal(sim.status({ avail, charging, fault }, threshold), context.classify(avail, charging, fault, threshold));
  }
});

test('zero discount and surcharge give identical policies with common random numbers', async () => {
  const { results } = await sim.compare(sim.demo(), { discount: 0, surcharge: 0, repeats: 20 });
  for (const r of results.slice(1)) for (const key of ['count', 'wait', 'fee', 'discount', 'revenue', 'records']) assert.deepEqual(r[key], results[0][key]);
});
test('same seed reproduces all output; another seed changes arrivals', async () => {
  const a = await sim.compare(sim.demo(), { repeats: 5 });
  assert.deepEqual(a, await sim.compare(sim.demo(), { repeats: 5 }));
  assert.notDeepEqual(a.results[0].records, (await sim.compare(sim.demo(), { repeats: 5, seed: 43 })).results[0].records);
});
test('unusable chargers excluded, including zero waiting cost', async () => {
  const stations = sim.demo(); Object.assign(stations[0], { avail: 0, charging: 0, fault: 4, base: 1 });
  const { results } = await sim.compare(stations, { repeats: 3, beta: 0 });
  for (const r of results) assert.deepEqual(r.count, [0, 24]);
  stations[1].avail = stations[1].charging = 0;
  await assert.rejects(sim.compare(stations), /처리 가능한/);
});
test('fully occupied initial station waits until initial release and includes completions after horizon', () => {
  const stations = sim.demo(), o = { ...sim.defaults, drivers: 2, minutes: 1, durationMode: 'assumed' };
  Object.assign(stations[1], { avail: 0, charging: 0, fault: 4 });
  const r = sim.runPolicy(stations, o, { initial: [[.5, .5, .5, .5], []], drivers: [
    { id: 0, arrival: 0, duration: 40, choice: .1 }, { id: 1, arrival: .5, duration: 40, choice: .2 }
  ] }, 0);
  assert.equal(r.records[0].start, 15); assert.equal(r.records[0].actualWait, 15);
  assert.equal(r.records[1].start, 15); assert.equal(r.completion, 55); assert.deepEqual(r.count, [2, 0]);
});
test('single charger serves arrivals FIFO without overlap, all waiting times nonnegative', () => {
  const stations = sim.demo(); Object.assign(stations[0], { avail: 0, charging: 1 }); Object.assign(stations[1], { avail: 0, charging: 0, fault: 4 });
  const o = { ...sim.defaults, drivers: 30, minutes: 5 }, people = sim.population(stations, o, sim.rng(42));
  const r = sim.runPolicy(stations, o, people, 1);
  for (let i = 0; i < r.records.length; i++) {
    const d = r.records[i]; assert.ok(d.actualWait >= 0); assert.ok(d.start >= d.arrival);
    assert.equal(d.expectedWait, d.actualWait);
    if (i) assert.ok(d.start >= r.records[i - 1].end);
  }
});
test('discount only never surcharges busy station; distinct base prices and rounding preserved', () => {
  const [a, b] = sim.demo(), o = { ...sim.defaults };
  b.base = 400;
  assert.equal(sim.price(a, 0, o), 347.2); assert.equal(sim.price(b, 0, o), 400);
  assert.equal(sim.price(a, 1, o), 399.3); assert.equal(sim.price(a, 2, o), 347.2);
  assert.equal(sim.price(b, 1, o), 320); assert.equal(sim.price(b, 2, o), 320);
  assert.equal(sim.status({ avail: 1, charging: 1, fault: 8 }), '여유');
  assert.equal(sim.status({ avail: 1, charging: 3, fault: 0 }), '보통');
});
test('softmax is stable at extreme costs, excludes infinite costs', () => {
  assert.deepEqual(sim.probability([1e12, 1e12], 1), [.5, .5]);
  assert.deepEqual(sim.probability([Infinity, 1e12], 1), [0, 1]);
  assert.deepEqual(sim.probability([0, 1e12], 1), [1, 0]);
});
test('validation rejects mixed speeds, identical stations, invalid counts and inputs', async () => {
  for (const options of [{ tau: 0 }, { seed: -1 }, { repeats: 1.5 }, { discount: NaN }, { energy: 0 }]) await assert.rejects(sim.compare(sim.demo(), options));
  const stations = sim.demo(); stations[1].speed = 'slow'; await assert.rejects(sim.compare(stations));
  await assert.rejects(sim.compare([stations[0], stations[0]]));
});
test('default duration uses per-station output and initial remaining time without exceeding rating', () => {
  const stations = sim.demo(), o = { ...sim.defaults, energy:30 };
  stations[0].kw = 30; Object.assign(stations[1], { avail: 0, charging: 0 });
  const r = sim.runPolicy(stations, o, { initial: [[.5, .5, .5, .5], []], drivers: [{ id: 0, arrival: 0, duration: 20, choice: .1 }] }, 0);
  assert.equal(r.records[0].start, 30); assert.equal(r.records[0].end, 90);
  assert.equal(r.load.overRatedSessions, 0);
});
test('discount benefit and revenue differences are accounting identities', async () => {
  const { results, stations, options: o } = await sim.compare(sim.demo(), { repeats: 7 });
  for (const r of results) {
    assert.ok(Math.abs(r.count[0] + r.count[1] - o.drivers) < 1e-9);
    assert.ok(Math.abs(r.revenue - r.fee * o.drivers) < 1e-7);
    assert.ok(Math.abs(r.discount - r.count.reduce((sum, n, i) => sum + n * o.energy * Math.max(0, stations[i].base - r.prices[i]), 0)) < 1e-7);
    assert.equal(r.revenueChange, r.revenue - results[0].revenue);
  }
});
test('future utilization adapter only uses explicit input, absent values use initial state', () => {
  const [a] = sim.demo();
  assert.equal(sim.price(a, 1, sim.defaults), 399.3);
  assert.equal(sim.price(a, 1, sim.defaults, { 'DEMO-A': .2 }), 277.8);
  assert.throws(() => sim.price(a, 1, sim.defaults, { 'DEMO-A': 2 }));
});

test('forecast JSON validates IDs, speed, timestamps, duplicates, bounds and coverage', () => {
  const now = Date.parse('2026-11-02T12:00:00+09:00');
  const payload = { schema_version: 1, model_name: 'test fixture', generated_at: '2026-11-02T11:55:00+09:00', target_time: '2026-11-02T13:00:00+09:00',
    predictions: [{ station_id: 'DEMO-A', speed: 'fast', utilization: .2 }, { station_id: 'DEMO-B', speed: 'fast', utilization: 1 }] };
  const p = sim.forecast(payload, sim.demo(), now);
  assert.equal(p.utilizationById['DEMO-A'], .2);
  for (const change of [{ target_time: '2026-11-02T11:00:00+09:00' }, { generated_at: '2026-11-02T12:30:00+09:00' }, { model_name: '' },
    { predictions: payload.predictions.slice(0, 1) }, { predictions: [...payload.predictions, payload.predictions[0]] },
    { predictions: payload.predictions.map(r => ({ ...r, speed: 'slow' })) },
    { predictions: payload.predictions.map(r => ({ ...r, utilization: 1.1 })) }]) assert.throws(() => sim.forecast({ ...payload, ...change }, sim.demo(), now));
});

test('forecast changes policy prices and choices while preserving observed initial occupancy', async () => {
  const stations = sim.demo(), options = { repeats: 3, seed: 42 };
  const current = await sim.compare(stations, options);
  const predicted = await sim.compare(stations, options, () => {}, { 'DEMO-A': .2, 'DEMO-B': 1 });
  assert.deepEqual(current.results[0].records, predicted.results[0].records);
  assert.deepEqual(predicted.results[1].prices, [277.8, 399.3]);
  assert.deepEqual(predicted.results[2].prices, [277.8, 347.2]);
  assert.deepEqual(predicted.stations, stations);
  assert.notDeepEqual(current.results[1].records, predicted.results[1].records);
});
