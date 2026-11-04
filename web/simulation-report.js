/* Shared browser/Node report rendering. All external labels are escaped. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ESSReport = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const fmt = (n, d = 2) => Number.isFinite(n) ? n.toLocaleString('ko-KR', { maximumFractionDigits: d, minimumFractionDigits: d }) : '산정 불가';
  const total = values => values.reduce((a, b) => a + b, 0);
  const pct = value => Number.isFinite(value) ? fmt(value)+'%' : '산정 불가';
  const kst = value => Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('ko-KR',{timeZone:'Asia/Seoul',hourCycle:'h23'})+' (한국 시각)' : String(value ?? '');
  const metrics = [
    ['A 피크 (kW)', r => r.load.stationPeakKw[0]],
    ['B 피크 (kW)', r => r.load.stationPeakKw[1]],
    ['A+B 합산 피크 (kW)', r => r.load.combinedPeakKw],
    ['합산 피크 SE (kW)', r => r.load.peakSE],
    ['고정 대비 합산 피크 차이 (kW)', r => r.load.combinedPeakDeltaKw],
    ['합산 피크 차이 SE (kW)', r => r.load.peakDeltaSE],
    ['A 피크 저감률 (%)', r => r.load.stationPeakReductionPct[0]],
    ['B 피크 저감률 (%)', r => r.load.stationPeakReductionPct[1]],
    ['합산 피크 저감률 (%)', r => r.load.combinedPeakReductionPct],
    ['도착 기간 내 A/B 평균 부하율 차이 (%p)', r => r.load.utilizationGapPp],
    ['신규 차량 총 충전량 (kWh)', r => r.load.newEnergyKwh],
    ['초기 차량 잔여 충전량 추정 (kWh)', r => r.load.initialEnergyKwh],
    ['완료까지 총 충전량 (kWh)', r => total(r.load.stationEnergyKwh)],
    ['도착 기간 이후 공급되는 충전량 (kWh)', r => r.load.tailEnergyKwh],
    ['도착 기간 종료 시 미완료 신규 차량 (명)', r => r.load.unfinishedAtHorizon],
    ['초기·신규 차량 최종 완료 (시작 후 분)', r => r.load.lastCompletionMinutes],
    ['대표 출력 초과 등가 전력의 신규 차량 (명)', r => r.load.overRatedSessions],
    ['충전량·출력 상한에 맞춰 시간을 연장한 신규 차량 (명)', r => r.load.extendedSessions || 0],
    ['평균 실제 대기 (분)', r => r.wait],
    ['평균 추가 거리 (km/명)', r => r.distance],
    ['평균 충전비 (원/명)', r => r.fee],
    ['총 할인 혜택 (원)', r => r.discount],
    ['고정 대비 단순 매출 차이 (원)', r => r.revenueChange]
  ];
  const valid = result => result.results.every(r => r.load?.available);
  function chart(result, station) {
    const n = Math.max(...result.results.map(r => r.load.series.length)), stride = Math.max(1, Math.ceil(n / 240));
    const count = Math.ceil(n / stride), x = i => 48 + i / count * 570;
    const curves = result.results.map(r => Array.from({ length: count }, (_, b) => {
      let value = 0;
      for (let j = b * stride; j < Math.min(n, (b + 1) * stride); j++) {
        const kw = r.load.series[j] || [0, 0]; value += station === 2 ? total(kw) : kw[station];
      }
      return value / Math.min(stride, n - b * stride);
    }));
    const max = Math.max(1, ...curves.flat()), y = v => 178 - v / max * 140;
    const colors = ['#536474', '#245d4b', '#a66a17'];
    const title = station === 2 ? 'A+B 합산 부하' : `${station ? 'B' : 'A'} 충전소 부하`;
    const explanations = [
      'A에서 세 정책의 부하를 비교합니다. 정책 선이 회색보다 낮으면 그 시간대 A의 부하가 작은 것입니다. 후반부만 낮아졌다면 최대 부하인 피크는 그대로일 수 있습니다. B와 합산 부하도 함께 확인하세요.',
      'B에서 세 정책의 부하를 비교합니다. A에서 차량이 이동해 오면 B의 부하는 증가할 수 있습니다. B의 증가를 무조건 실패로 해석하지 말고 A의 감소와 합산 피크, 대기시간을 함께 확인하세요.',
      '같은 시각의 A와 B 부하를 더한 곡선입니다. A 피크와 B 피크를 따로 더한 값이 아닙니다. A가 줄어도 합산 피크는 같거나 증가할 수 있으며, 실제 배전망의 다른 부하는 포함하지 않습니다.'
    ];
    const explanationId = `sim-load-explanation-${station}`;
    return `<figure class="sim-load-chart"><figcaption>${title} · 반복 평균 곡선</figcaption>
      <div class="sim-load-legend" role="list" aria-label="${title} 정책 색상 범례">${['회색 실선 · 고정요금','녹색 실선 · 할인·할증','주황 점선 · 할인 전용'].map((label,p)=>`<span role="listitem"><i class="sim-load-key" aria-hidden="true"${p === 2 ? ' style="border-top-style:dashed"' : ''}></i>${label}</span>`).join('')}</div>
      <svg viewBox="0 0 640 220" role="img" aria-label="${title}, 세 정책의 시간별 평균 부하 비교" aria-describedby="${explanationId}">
        ${[0, .5, 1].map(t => `<line x1="48" x2="618" y1="${y(max*t)}" y2="${y(max*t)}" stroke="#d7e2db"/><text x="42" y="${y(max*t)+4}" text-anchor="end" font-size="11" fill="#40554a">${fmt(max*t,0)}</text>`).join('')}
        <text x="48" y="22" font-size="12" fill="#40554a">kW</text>
        ${curves.map((values, p) => `<path d="${values.map((v,b) => `${b ? 'L' : 'M'}${x(b).toFixed(2)},${y(v).toFixed(2)} L${x(b+1).toFixed(2)},${y(v).toFixed(2)}`).join(' ')}" fill="none" stroke="${colors[p]}" stroke-width="2" ${p === 2 ? 'stroke-dasharray="5 3"' : ''}/>`).join('')}
        <text x="48" y="201" font-size="11" fill="#40554a">0분</text><text x="618" y="201" text-anchor="end" font-size="11" fill="#40554a">${n*15}분</text>
      </svg><p class="sim-note">가로축: 시작 후 경과시간(분) · 세로축: ${stride === 1 ? '15분 평균 부하(kW)' : `${stride*15}분 묶음 평균 부하(kW), 원본 15분 값은 CSV`} · 세로 눈금은 자동 범위이며 정격 용량이 아닙니다.</p>
      <div id="${explanationId}" class="sim-note"><p>${explanations[station]}</p><p>계단은 구간별 평균을 뜻하며, 각 구간은 ${result.options.repeats}회 실행의 평균입니다. 선이 겹치면 정책 결과가 비슷한 것입니다. 표는 반복별 피크의 평균이므로 곡선 최고점과 다를 수 있습니다.</p><p>신규 차량은 시작 후 ${fmt(result.options.minutes)}분까지만 생성합니다. 이후 대기·충전을 마치며 부하가 0으로 내려갑니다. 표시 종료 시각은 전체 완료 구간을 포함하며 실제 시계 시각이나 이후 수요가 0이라는 예측이 아닙니다.</p></div></figure>`;
  }
  function forecastTable(result) {
    const p=result.options.forecastPlan;
    if (!p) return '';
    const time=t=>new Date(t).toLocaleTimeString('ko-KR',{timeZone:'Asia/Seoul',hour:'2-digit',minute:'2-digit'});
    return `<h4>v2 기준 수요와 구간별 요금</h4><p class="sim-note">실험 시작 ${esc(kst(p.startAt))} · 초기 상태 수집 ${esc(kst(p.observedAt))} · 충전 시작 건수 추정. 현재 적용할 구간만 사용하며 처음 일부 구간은 남은 시간 비례입니다. 원래 A/B 선택지와 포아송 생성 차량을 모든 정책이 공유하고 재선택합니다. 충전량·행동계수는 별도 추정값 또는 사용자 가정입니다.</p>
      <div class="sim-table-wrap"><table class="sim-table"><thead><tr><th>한국 시각</th><th>A 기대 건수</th><th>B 기대 건수</th><th>A / B 이용률 (%)</th>${result.results.map(r=>`<th>${esc(r.label)} A / B 단가</th>`).join('')}</tr></thead><tbody>${p.intervals.map((b,i)=>`<tr><td>${time(b.startAt)}~${time(b.endAt)}${b.partial?' 일부':''}</td><td>${fmt(b.expected[0],3)}</td><td>${fmt(b.expected[1],3)}</td><td>${fmt(b.utilization[0]*100)} / ${fmt(b.utilization[1]*100)}</td>${result.results.map(r=>`<td>${r.priceSchedule[i].prices.map(v=>fmt(v,1)).join(' / ')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
      <p class="sim-note">요금은 구간 이용률의 정책 판정으로 정하고 차량은 도착 시 선택 단가를 충전 종료까지 적용합니다. 평균 단가는 시간가중 평균입니다. v2 제공 평균은 참고용입니다. 완료 기록 모드에서는 별도 원기록의 경험분포를 적용하며 kWh는 별도 추정값을 유지합니다.</p>`;
  }
  function render(result) {
    if (!valid(result)) return `<h3>충전 부하 집중 변화 리포트</h3><p>${esc(result.results.find(r=>!r.load?.available)?.load?.reason || '부하 집계를 사용할 수 없습니다.')}</p>`;
    const { results, options: o, context: c = {} } = result;
    const overRated = results.some(r=>r.load.overRatedSessions > 0);
    const evidence = result.evidence || [];
    return `<h3>충전 부하 집중 변화 리포트</h3>
      <p class="sim-note">가정 기반 시뮬레이션 · 15분 평균 등가 충전 부하 · 실제 배전망 측정 결과 아님</p>
      <p>${esc(c.source)} · ${esc(c.region)}<br>실행 시각: ${esc(kst(c.executedAt || '기록 없음'))}<br>요금 근거: ${esc(c.pricingBasis)} ${esc(c.forecastInfo)}<br>A: ${esc(result.stations[0].name)} (${esc(result.stations[0].id)}) / B: ${esc(result.stations[1].name)} (${esc(result.stations[1].id)})<br>신규 ${fmt(o.drivers,3)}명${o.forecastPlan?' (기대값)':''} · 도착 ${fmt(o.minutes)}분 · 차량당 ${o.energy}kWh · ${o.repeats}회 · 시드 ${o.seed}</p>
      ${o.forecastPlan ? `<p class="sim-status">생성 평균 ${fmt(result.population.mean,3)}명 · 범위 ${result.population.min}~${result.population.max}명 · 신규 0명 반복 ${result.population.emptyRuns}/${o.repeats}회. 대기시간·비용·거리는 전체 생성 차량을 기준으로 집계합니다. 모든 반복이 0명이라면 선택·대기·비용의 0은 효과 측정값을 의미하지 않습니다.</p>` : ''}
      ${roadNotice(o,c)}${forecastTable(result)}
      ${o.durationMode==='sessions'?'<p class="sim-status">완료 세션 기록 기반 시간 추정. 초기 잔여시간은 진행 중 시작시각 없이 정상상태 모형으로 추정합니다. 원기록 시간이 최소 필요시간보다 짧으면, 대표 출력을 넘지 않도록 최소시간(충전량÷대표 출력)까지 연장하며 아래에 연장 차량 수를 표시합니다. 기록에는 비충전 점유가 포함될 수 있습니다. 표본·출처·보정 평균은 ‘입력값과 근거’에서 확인하세요.</p>':''}
      ${overRated ? '<p class="sim-status" data-error="true">충전량과 가정 충전시간으로 계산한 등가 전력이 대표 출력을 넘는 차량이 있습니다. 현재 결과는 에너지 보존 시나리오이며 물리적으로 가능한 부하로 해석할 수 없습니다. 신규 차량 충전시간을 ‘충전량 ÷ 대표 출력’으로 바꾸어 다시 실행하세요.</p>' : '<p class="sim-note">신규 차량은 충전량÷소요시간의 일정 전력, 초기 차량은 완료 기록 모드에서 (충전량÷보정 총시간)×추정 잔여시간, 그 외에는 대표 출력×가정 잔여시간으로 계산합니다. 실제 충전곡선·효율·출력 공유·비충전 부하는 제외합니다.</p>'}
      <div class="sim-table-wrap"><table class="sim-table"><caption>각 반복에서 지표를 계산한 뒤 평균 · 피크 저감률은 양수=감소, 음수=증가</caption><thead><tr><th>지표</th>${results.map(r=>`<th>${esc(r.label)}</th>`).join('')}</tr></thead><tbody>${metrics.map(([label,get])=>`<tr><th scope="row">${label}</th>${results.map(r=>`<td>${fmt(get(r))}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
      <div class="sim-report-findings">${results.slice(1).map(r=>`<p><strong>${esc(r.label)}</strong>: 고정요금 대비 A 피크 저감률 ${pct(r.load.stationPeakReductionPct[0])}, B ${pct(r.load.stationPeakReductionPct[1])}, 합산 ${pct(r.load.combinedPeakReductionPct)}. 합산 피크 차이는 ${fmt(r.load.combinedPeakDeltaKw)}kW이고, 평균 대기 차이는 ${fmt(r.wait-results[0].wait)}분입니다.</p>`).join('')}</div>
      <p class="sim-note">A의 피크가 줄어도 B 또는 합산 피크는 증가할 수 있습니다. 합산 피크는 같은 시각의 A+B 곡선에서 계산하며 A 피크+B 피크를 더하지 않습니다. SE는 반복 난수에 따른 표준오차이며 모델·행동 가정·미래 예측의 불확실성을 포함하지 않습니다.</p>
      ${[0,1,2].map(i=>chart(result,i)).join('')}
      <p class="sim-note">곡선은 반복 평균입니다. 표는 반복별 최대값의 평균이므로 곡선의 최대값과 다를 수 있습니다. 모든 정책의 신규 충전 필요량과 초기 상태는 같습니다. 도착 종료 후에도 모든 차량이 완료될 때까지 계산하며, 부하율 차이는 동일한 도착 생성 기간에서 충전소별 처리 가능 대표 용량으로 나눈 평균 부하율의 절댓값 차이입니다. 이것만으로 변압기·배전선로 피크 저감을 입증하지 않습니다.</p>
      <details><summary>입력값과 근거</summary><div class="sim-table-wrap"><table class="sim-table sim-evidence-table"><thead><tr><th>항목</th><th>값</th><th>구분</th><th>근거와 한계</th></tr></thead><tbody>${evidence.map(r=>`<tr><th>${esc(r.item)}</th><td>${esc(r.value)}</td><td>${esc(r.kind)}</td><td>${esc(r.basis)}</td></tr>`).join('')}</tbody></table></div></details>`;
  }
  const styles = `body{font:15px/1.7 system-ui,sans-serif;color:#213b31;max-width:1100px;padding:28px;margin:auto}h1{font-size:25px}h3{font-size:20px}p{overflow-wrap:anywhere}.sim-table-wrap{overflow-x:auto}.sim-table{border-collapse:collapse;width:100%;font-size:13px;white-space:nowrap}.sim-table th,.sim-table td{padding:10px;border:1px solid #d7e2db;text-align:right}.sim-table th:first-child{text-align:left}.sim-table caption{text-align:left;padding:12px 0}.sim-table thead{background:#eef5ef}.sim-evidence-table{white-space:normal}.sim-evidence-table td{text-align:left}.sim-note{font-size:12px;color:#53695d}.sim-status{padding:12px;background:#fff0e9}.sim-load-chart{margin:22px 0}.sim-load-chart svg{display:block;width:100%;max-height:300px}.sim-load-legend{display:flex;gap:20px;flex-wrap:wrap}.sim-load-legend span:nth-child(1){color:#536474}.sim-load-legend span:nth-child(2){color:#245d4b}.sim-load-legend span:nth-child(3){color:#a66a17}@media print{body{padding:0;font-size:11px}.sim-load-chart, tr{break-inside:avoid}details{display:block}details>div{display:block!important}.sim-table{font-size:9px;white-space:normal}}`;
  const legendStyles = '.sim-load-legend{margin:10px 0;font-size:12px}.sim-load-legend span{display:inline-flex;align-items:center;gap:6px}.sim-load-key{display:inline-block;flex:0 0 22px;width:22px;border-top:3px solid currentColor}.sim-load-chart figcaption{font-weight:600}';
  function roadNotice(o,c) {
    if (c.distanceMode!=='road' || !o.roadDistances) return '';
    return `<p class="sim-note">자동차 도로 거리 A→B ${fmt(o.roadDistances[0],3)}km / B→A ${fmt(o.roadDistances[1],3)}km · 조회 ${esc(kst(c.roadRoute?.fetchedAt || '기록 없음'))}. © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a> · <a href="https://routing.openstreetmap.de/about.html">FOSSGIS OSRM car</a> · <a href="https://www.openstreetmap.org/">지도 오류 수정</a>. 도로 연결점 기준 경로 추정이며 실제 출입구·교통·전체 우회거리와 다를 수 있습니다. 이동시간은 도착 시각에 더하지 않습니다.</p>`;
  }
  function behaviorRows(output) {
    const reference = output.profiles[0];
    return output.profiles.flatMap(profile => profile.results.map((r, i) => [
      profile.label, r.label, r.share[1] * 100, r.wait,
      r.load.available ? r.load.combinedPeakKw : null,
      r.load.available ? r.load.combinedPeakReductionPct : null, r.fee,
      (r.share[1] - reference.results[i].share[1]) * 100,
      r.load.available && reference.results[i].load.available ? r.load.combinedPeakKw - reference.results[i].load.combinedPeakKw : null
    ]));
  }
  const behaviorHeaders = ['행동계수 설정','요금 정책','B 선택 (%)','대기 (분)','합산 피크 (kW)','동일 설정의 고정요금 대비 피크 저감 (%)','충전비 (원/명)','기존 계수의 동일 정책 대비 B 변화 (%p)','기존 계수의 동일 정책 대비 피크 차이 (kW)'];
  function behaviorRender(output) {
    const c = output.context || {}, p = output.profiles[0].population;
    return `<p class="sim-note">${esc(c.source || '')} · ${esc(c.region || '')} · 실행 ${esc(kst(c.executedAt || '기록 없음'))}<br>${esc(c.pricingBasis || '')} · ${esc(c.forecastInfo || '')}</p>
      <p>기존 예시값(s=1, α=600, β=300, τ=2000)과 팀 채택 문헌 기준(s=1, α=950, β=360, τ=7200)를 함께 바꿔 비교했습니다. A/B·예측 구간·차량·도착 시각·초기 잔여시간·선택 난수·요금 정책은 공유합니다. 현재 입력한 사용자 행동계수와의 비교는 아닙니다.</p>
      <p class="sim-note">반복 ${output.base.repeats}회 · 기대 신규 ${fmt(p.expected,3)}명 · 생성 평균 ${fmt(p.mean,3)}명 (${p.min}~${p.max}) · 0명 반복 ${p.emptyRuns}회. 신규 차량이 적으면 선택 비율과 정책 효과 해석에 주의하세요.</p>${roadNotice(output.base,c)}
      <div class="sim-table-wrap"><table class="sim-table"><caption>2개 행동계수 설정 × 3개 요금 정책 · 피크는 15분 평균 부하의 반복별 최대값 평균</caption><thead><tr>${behaviorHeaders.map(h=>`<th scope="col">${esc(h)}</th>`).join('')}</tr></thead><tbody>${behaviorRows(output).map(row=>`<tr>${row.map((v,i)=>i<2?`<th scope="row">${esc(v)}</th>`:`<td>${fmt(v)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
      <p class="sim-note">피크 저감률은 각 행동계수 설정 안에서 고정요금과 비교합니다. 오른쪽 두 변화 열은 같은 요금 정책에서 행동계수만 바꾼 차이입니다. 피크 차이가 음수이면 팀 채택 기준에서 더 낮습니다. 가정 민감도 비교이며 팀 채택 기준의 정확도나 최적 정책을 입증하지 않습니다.</p>`;
  }
  function behaviorHtml(output) {
    return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ESSential 행동계수 비교 리포트</title><style>${styles}${legendStyles}</style></head><body><h1>기존 예시값 · 팀 채택 문헌 기준 비교</h1>${behaviorRender(output)}${output.profiles.map(p=>`<section><h2>${esc(p.label)}</h2>${render(p)}</section>`).join('')}</body></html>`;
  }
  function behaviorCSV(output) {
    return [['비교 구분','기존 예시값과 고정 팀 채택 문헌 기준. 동일 차량·예측 공유. 실측 보정 결과 아님'],
      ...Object.entries(output.context || {}), behaviorHeaders, ...behaviorRows(output),
      ...output.profiles.flatMap(p=>[[],['행동계수 상세',p.label],...rows(p)])];
  }
  function html(result) {
    return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ESSential 충전 부하 분석 리포트</title><style>${styles}${legendStyles}</style></head><body><h1>ESSential 요금 정책 분석</h1>${render(result)}</body></html>`;
  }
  function rows(result) {
    if (!valid(result)) return [];
    const n = Math.max(...result.results.map(r=>r.load.series.length));
    const output = [['분석 구분','가정 기반 15분 평균 등가 충전 부하. 실제 배전망 측정 아님'],
      ...Object.entries(result.context || {}), ...Object.entries(result.options).map(([k,v])=>[k,v!==null && typeof v==='object'?JSON.stringify(v):v]),
      ...Object.entries(result.population || {}).map(([k,v])=>['생성인원_'+k,v]),
      ...result.stations.flatMap((s,i)=>Object.entries(s).map(([k,v])=>[`${i?'B':'A'}_${k}`,v])), [],
      ['입력 근거','값','구분','근거와 한계'],...(result.evidence || []).map(r=>[r.item,r.value,r.kind,r.basis]),[],
      ['지표',...result.results.map(r=>r.label)],...metrics.map(([label,get])=>[label,...result.results.map(get)])];
    if (result.options.forecastPlan) {
      output.push([],['v2 구간 수요·요금. 원래 충전소별 시작 건수 추정'],['시작_ISO','종료_ISO','A기대건수','B기대건수','A이용률','B이용률','정책','A단가','B단가']);
      for (const [i,bin] of result.options.forecastPlan.intervals.entries()) for (const r of result.results)
        output.push([bin.startAt,bin.endAt,...bin.expected,...bin.utilization,r.label,...r.priceSchedule[i].prices]);
    }
    output.push([],['정책','구간시작_분','구간종료_분','A평균부하_kW','B평균부하_kW','합산평균부하_kW']);
    for (const r of result.results) for (let b=0;b<n;b++) {
      const kw = r.load.series[b] || [0,0]; output.push([r.label,b*15,(b+1)*15,...kw,total(kw)]);
    }
    return output;
  }
  return { render, html, rows, behaviorRender, behaviorHtml, behaviorCSV };
});
