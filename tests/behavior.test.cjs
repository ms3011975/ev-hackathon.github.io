const {test}=require('node:test');
const assert=require('node:assert/strict');
const sim=require('../web/simulation.js');
const report=require('../web/simulation-report.js');

test('team-adopted speed-specific defaults apply to normal runs and sweeps',async()=>{
  assert.deepEqual(sim.behaviorKeys.map(k=>sim.defaults[k]),[1,950,360,7200]);
  assert.equal(sim.behaviorDefault('fast').id,'literature');
  assert.equal(sim.behaviorDefault('slow').id,'slowLiterature');
  assert.equal(sim.behaviorAdoption.date,'2026-11-05');
  assert.equal(sim.behaviorAdoption.limitations.length,4);
  const fast=await sim.compare(sim.demo(),{repeats:2});
  const explicit=await sim.compare(sim.demo(),{repeats:2,...sim.behaviorProfiles.literature.values});
  assert.deepEqual(fast.results,explicit.results);
  const slowStations=sim.demo().map(s=>({...s,speed:'slow',kw:7}));
  const slow=await sim.compare(slowStations,{repeats:2});
  assert.deepEqual(sim.behaviorKeys.map(k=>slow.options[k]),[1,510,220,10000]);
  const sweep=await sim.sweep(slowStations,{repeats:1},'discount',[.1]);
  assert.equal(sweep.base.alpha,510);
  const custom=await sim.compare(sim.demo(),{repeats:1,alpha:700});assert.equal(custom.options.alpha,700);
  const ctx={speed:'fast',behaviorPreset:'literature'};
  const evidence=sim.evidence(fast.stations,fast.options,ctx);
  assert.ok(evidence.some(r=>r.item==='행동계수 팀 채택'&&r.value.includes(sim.behaviorAdoption.version)));
  assert.ok(evidence.some(r=>r.item==='행동계수 적용 한계'&&r.value.includes('대기 발생 가능성')));
  fast.evidence=evidence;assert.match(report.html(fast),/team-2026-11-05-v1/);
  const e=sim.evidence(fast.stations,{...fast.options,durationMode:'sessions'},ctx);
  assert.ok(e.some(r=>r.item==='초기 잔여시간 이론 근거'&&r.basis.includes('EOSP2E.pdf')));
});

test('literature reference conversion preserves units and fixed rounded preset',()=>{
  const x=sim.behaviorConversion();
  assert.ok(Math.abs(x.tau-7219.628077330819)<1e-8);
  assert.ok(Math.abs(x.alpha-952.9909062076681)<1e-8);
  assert.ok(Math.abs(x.beta-360.981403866541)<1e-8);
  assert.deepEqual(sim.behaviorProfiles.literature.values,{sensitivity:1,alpha:950,beta:360,tau:7200});
  assert.equal(sim.behaviorMatch({...sim.defaults,...sim.behaviorProfiles.literature.values},{behaviorPreset:'literature',speed:'fast'}),'literature');
  assert.equal(sim.behaviorMatch({...sim.defaults,...sim.behaviorProfiles.literature.values},{behaviorPreset:'literature',speed:'slow'}),'custom');
});

test('behavior comparison exactly matches separate runs sharing the same seeded population and preserves inputs',async()=>{
  const stations=sim.demo(), options={repeats:4,alpha:9999,energy:14.82}, before=JSON.stringify({stations,options});
  const out=await sim.compareBehavior(stations,options);
  assert.equal(out.profiles.length,2);
  for(const p of out.profiles){
    const solo=await sim.compare(stations,{...options,...sim.behaviorProfiles[p.id].values});
    assert.deepEqual(p.results,solo.results);
    assert.deepEqual(p.population,out.profiles[0].population);
    for(const r of p.results){
      assert.ok(Math.abs(r.load.newEnergyKwh-24*14.82)<1e-8);
      assert.deepEqual(r.records.map(d=>[d.driver,d.origin,d.arrival]),out.profiles[0].results[0].records.map(d=>[d.driver,d.origin,d.arrival]));
    }
  }
  assert.equal(JSON.stringify({stations,options}),before);
  let cancelled=false;
  await assert.rejects(sim.compareBehavior(stations,{repeats:3},()=>{cancelled=true;},undefined,()=>cancelled),/중단/);
  await assert.rejects(sim.compareBehavior([stations[0],{...stations[1],speed:'slow'}]),/같은 종류/);
});

test('slow conversions and comparison preserve provenance, population and export the actual coefficient bundle',async()=>{
  const x=sim.behaviorConversion('slow');
  assert.ok(Math.abs(x.alpha-506.8333333333333)<1e-9);
  assert.ok(Math.abs(x.beta-220.26666666666665)<1e-9);
  assert.ok(Math.abs(x.betaMean-68.36666666666666)<1e-9);
  assert.ok(Math.abs(x.tau-10059.171597633136)<1e-9);
  const stations=sim.demo().map(s=>({...s,speed:'slow',kw:7}));
  const output=await sim.compareBehavior(stations,{repeats:3});
  assert.deepEqual(output.profiles.map(p=>p.id),['legacy','slowLiterature']);
  for(const p of output.profiles) {
    assert.deepEqual(p.results,(await sim.compare(stations,{repeats:3,...sim.behaviorProfiles[p.id].values})).results);
    assert.deepEqual(p.population,output.profiles[0].population);
    p.context={speed:'slow',behaviorPreset:p.id};p.evidence=sim.evidence(p.stations,p.options,p.context);
  }
  output.context={speed:'slow'};
  const adopted=output.profiles[1];
  assert.equal(sim.behaviorMatch(adopted.options,{speed:'fast',behaviorPreset:adopted.id}),'custom');
  assert.equal(sim.behaviorMatch({...adopted.options,alpha:520},adopted.context),'custom');
  assert.ok(adopted.evidence.some(r=>r.basis.includes('9.44USD')&&r.basis.includes('2.93USD')));
  assert.ok(adopted.evidence.some(r=>r.basis.includes('공동 추정값이 아님')));
  assert.equal(adopted.evidence.find(r=>r.item==='대기 비용 β').kind,'추정값');
  const html=report.behaviorHtml(output),csv=report.behaviorCSV(output);
  assert.match(html,/α=510, β=220, τ=10000/);assert.doesNotMatch(html,/α=950, β=360, τ=7200/);
  assert.match(html,/1700÷0.169/);assert.match(html,/1288284317766/);
  assert.ok(csv.some(r=>String(r).includes('team-2026-11-05-slow-v1')));
  assert.ok(csv.some(r=>String(r).includes('할인 적용 신규 세션')));
});

test('team policy levels include no surcharge and applied counts follow per-driver prices',async()=>{
  assert.deepEqual(sim.policyComparisons,{discount:[.1,.2,.3],surcharge:[0,.15,.3],threshold:[.3,.5,.7]});
  const stations=sim.demo();
  const out=await sim.compare(stations,{repeats:3});
  assert.equal(out.results[0].discountedCount,0);assert.equal(out.results[0].surchargedCount,0);
  assert.equal(out.results[1].discountedCount,out.results[1].count[1]);
  assert.equal(out.results[1].surchargedCount,out.results[1].count[0]);
  const zero=await sim.compare(stations,{repeats:1,discount:0,surcharge:0});
  for(const r of zero.results){assert.equal(r.discountedCount,0);assert.equal(r.surchargedCount,0);}
  const sweep=await sim.sweep(stations,{repeats:1,surcharge:.12},'surcharge',sim.policyComparisons.surcharge);
  assert.deepEqual(sweep.scenarios.map(s=>s.value),[0,.12,.15,.3]);
});

test('manual edits and other speeds cannot retain literature provenance; exports include assumptions',async()=>{
  const out=await sim.compareBehavior(sim.demo(),{repeats:2});
  out.context={source:'<script>source</script>',region:'fixture',executedAt:'2026-11-04T01:00:00Z'};
  for(const p of out.profiles){
    p.context={...out.context,speed:'fast',behaviorPreset:p.id};
    p.evidence=sim.evidence(p.stations,p.options,p.context);
  }
  const p=out.profiles[1], row=(o,c=p.context)=>sim.evidence(p.stations,o,c).find(r=>r.item==='대기 비용 β');
  assert.equal(row(p.options).kind,'추정값');
  assert.equal(row({...p.options,alpha:1000}).kind,'가정값');
  assert.equal(row(p.options,{...p.context,behaviorPreset:'custom'}).kind,'가정값');
  const html=report.behaviorHtml(out), csv=report.behaviorCSV(out);
  assert.match(html,/1,400원\/USD/); assert.match(html,/표 5/); assert.match(html,/79042/);
  assert.match(html,/&lt;script&gt;source/); assert.doesNotMatch(html,/<script>source/);
  assert.match(html,/동일 설정의 고정요금 대비/);
  assert.ok(csv.some(r=>r[0]==='부하' || String(r).includes('합산평균부하_kW')));
  assert.ok(csv.some(r=>r[0]==='행동계수 환산 가정'));
  assert.ok(csv.some(r=>String(r).includes('forecast') || String(r).includes('기존 계수의 동일 정책')));
});
