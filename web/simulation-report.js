/* Shared browser/Node report rendering. All external labels are escaped. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ESSReport = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const fmt = (n, d = 2) => Number.isFinite(n) ? n.toLocaleString('ko-KR', { maximumFractionDigits: d, minimumFractionDigits: d }) : '산정 불가';
  const total = values => values.reduce((a, b) => a + b, 0);
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
      <div id="${explanationId}" class="sim-note"><p>${explanations[station]}</p><p>계단은 구간별 평균을 뜻하며, 각 구간은 ${result.options.repeats}회 실행의 평균입니다. 선이 겹치면 정책 결과가 비슷한 것입니다. 표는 반복별 피크의 평균이므로 곡선 최고점과 다를 수 있습니다.</p><p>신규 차량은 시작 후 ${result.options.minutes}분까지만 생성합니다. 이후 대기·충전을 마치며 부하가 0으로 내려갑니다. 표시 종료 시각은 전체 완료 구간을 포함하며 실제 시계 시각이나 이후 수요가 0이라는 예측이 아닙니다.</p></div></figure>`;
  }
  function render(result) {
    if (!valid(result)) return `<h3>충전 부하 집중 변화 리포트</h3><p>${esc(result.results.find(r=>!r.load?.available)?.load?.reason || '부하 집계를 사용할 수 없습니다.')}</p>`;
    const { results, options: o, context: c = {} } = result;
    const overRated = results.some(r=>r.load.overRatedSessions > 0);
    const evidence = result.evidence || [];
    return `<h3>충전 부하 집중 변화 리포트</h3>
      <p class="sim-note">가정 기반 시뮬레이션 · 15분 평균 등가 충전 부하 · 실제 배전망 측정 결과 아님</p>
      <p>${esc(c.source)} · ${esc(c.region)}<br>실행 시각: ${esc(c.executedAt || '기록 없음')}<br>요금 근거: ${esc(c.pricingBasis)} ${esc(c.forecastInfo)}<br>A: ${esc(result.stations[0].name)} (${esc(result.stations[0].id)}) / B: ${esc(result.stations[1].name)} (${esc(result.stations[1].id)})<br>신규 ${o.drivers}명 · 도착 ${o.minutes}분 · 차량당 ${o.energy}kWh · ${o.repeats}회 · 시드 ${o.seed}</p>
      ${overRated ? '<p class="sim-status" data-error="true">충전량과 가정 충전시간으로 계산한 등가 전력이 대표 출력을 넘는 차량이 있습니다. 현재 결과는 에너지 보존 시나리오이며 물리적으로 가능한 부하로 해석할 수 없습니다. 신규 차량 충전시간을 ‘충전량 ÷ 대표 출력’으로 바꾸어 다시 실행하세요.</p>' : '<p class="sim-note">신규 차량은 충전량÷소요시간의 일정 전력, 초기 차량은 대표 출력×가정 잔여시간으로 계산합니다. 실제 충전곡선·효율·출력 공유·비충전 부하는 제외합니다.</p>'}
      <div class="sim-table-wrap"><table class="sim-table"><caption>각 반복에서 지표를 계산한 뒤 평균 · 피크 저감률은 양수=감소, 음수=증가</caption><thead><tr><th>지표</th>${results.map(r=>`<th>${esc(r.label)}</th>`).join('')}</tr></thead><tbody>${metrics.map(([label,get])=>`<tr><th scope="row">${label}</th>${results.map(r=>`<td>${fmt(get(r))}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
      <div class="sim-report-findings">${results.slice(1).map(r=>`<p><strong>${esc(r.label)}</strong>: 고정요금 대비 A 피크 저감률 ${fmt(r.load.stationPeakReductionPct[0])}%, B ${fmt(r.load.stationPeakReductionPct[1])}%, 합산 ${fmt(r.load.combinedPeakReductionPct)}%. 합산 피크 차이는 ${fmt(r.load.combinedPeakDeltaKw)}kW이고, 평균 대기 차이는 ${fmt(r.wait-results[0].wait)}분입니다.</p>`).join('')}</div>
      <p class="sim-note">A의 피크가 줄어도 B 또는 합산 피크는 증가할 수 있습니다. 합산 피크는 같은 시각의 A+B 곡선에서 계산하며 A 피크+B 피크를 더하지 않습니다. SE는 반복 난수에 따른 표준오차이며 모델·행동 가정·미래 예측의 불확실성을 포함하지 않습니다.</p>
      ${[0,1,2].map(i=>chart(result,i)).join('')}
      <p class="sim-note">곡선은 반복 평균입니다. 표는 반복별 최대값의 평균이므로 곡선의 최대값과 다를 수 있습니다. 모든 정책의 신규 충전 필요량과 초기 상태는 같습니다. 도착 종료 후에도 모든 차량이 완료될 때까지 계산하며, 부하율 차이는 동일한 도착 생성 기간에서 충전소별 처리 가능 대표 용량으로 나눈 평균 부하율의 절댓값 차이입니다. 이것만으로 변압기·배전선로 피크 저감을 입증하지 않습니다.</p>
      <details><summary>입력값과 근거</summary><div class="sim-table-wrap"><table class="sim-table sim-evidence-table"><thead><tr><th>항목</th><th>값</th><th>구분</th><th>근거와 한계</th></tr></thead><tbody>${evidence.map(r=>`<tr><th>${esc(r.item)}</th><td>${esc(r.value)}</td><td>${esc(r.kind)}</td><td>${esc(r.basis)}</td></tr>`).join('')}</tbody></table></div></details>`;
  }
  const styles = `body{font:15px/1.7 system-ui,sans-serif;color:#213b31;max-width:1100px;padding:28px;margin:auto}h1{font-size:25px}h3{font-size:20px}p{overflow-wrap:anywhere}.sim-table-wrap{overflow-x:auto}.sim-table{border-collapse:collapse;width:100%;font-size:13px;white-space:nowrap}.sim-table th,.sim-table td{padding:10px;border:1px solid #d7e2db;text-align:right}.sim-table th:first-child{text-align:left}.sim-table caption{text-align:left;padding:12px 0}.sim-table thead{background:#eef5ef}.sim-evidence-table{white-space:normal}.sim-evidence-table td{text-align:left}.sim-note{font-size:12px;color:#53695d}.sim-status{padding:12px;background:#fff0e9}.sim-load-chart{margin:22px 0}.sim-load-chart svg{display:block;width:100%;max-height:300px}.sim-load-legend{display:flex;gap:20px;flex-wrap:wrap}.sim-load-legend span:nth-child(1){color:#536474}.sim-load-legend span:nth-child(2){color:#245d4b}.sim-load-legend span:nth-child(3){color:#a66a17}@media print{body{padding:0;font-size:11px}.sim-load-chart, tr{break-inside:avoid}details{display:block}details>div{display:block!important}.sim-table{font-size:9px;white-space:normal}}`;
  const legendStyles = '.sim-load-legend{margin:10px 0;font-size:12px}.sim-load-legend span{display:inline-flex;align-items:center;gap:6px}.sim-load-key{display:inline-block;flex:0 0 22px;width:22px;border-top:3px solid currentColor}.sim-load-chart figcaption{font-weight:600}';
  function html(result) {
    return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ESSential 충전 부하 분석 리포트</title><style>${styles}${legendStyles}</style></head><body><h1>ESSential 요금 정책 분석</h1>${render(result)}</body></html>`;
  }
  function rows(result) {
    if (!valid(result)) return [];
    const n = Math.max(...result.results.map(r=>r.load.series.length));
    const output = [['분석 구분','가정 기반 15분 평균 등가 충전 부하. 실제 배전망 측정 아님'],
      ...Object.entries(result.context || {}), ...Object.entries(result.options),
      ...result.stations.flatMap((s,i)=>Object.entries(s).map(([k,v])=>[`${i?'B':'A'}_${k}`,v])), [],
      ['입력 근거','값','구분','근거와 한계'],...(result.evidence || []).map(r=>[r.item,r.value,r.kind,r.basis]),[],
      ['지표',...result.results.map(r=>r.label)],...metrics.map(([label,get])=>[label,...result.results.map(get)]),[],
      ['정책','구간시작_분','구간종료_분','A평균부하_kW','B평균부하_kW','합산평균부하_kW']];
    for (const r of result.results) for (let b=0;b<n;b++) {
      const kw = r.load.series[b] || [0,0]; output.push([r.label,b*15,(b+1)*15,...kw,total(kw)]);
    }
    return output;
  }
  return { render, html, rows };
});
