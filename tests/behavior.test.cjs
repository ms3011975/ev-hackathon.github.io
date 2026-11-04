const {test}=require('node:test');
const assert=require('node:assert/strict');
const sim=require('../web/simulation.js');
const report=require('../web/simulation-report.js');

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
  await assert.rejects(sim.compareBehavior(stations.map(s=>({...s,speed:'slow'}))),/급속/);
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
