(function () {
  'use strict';
  const sim = window.ESSimulation, config = JSON.parse(document.getElementById('sim-config').textContent);
  const $ = id => document.getElementById(id), escape = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const fmt = (n, d = 1) => Number.isFinite(n) ? n.toLocaleString('ko-KR', { minimumFractionDigits: d, maximumFractionDigits: d }) : '—';
  const fields = [
    ['drivers', '신규 운전자 (명)', 24, 1, 500, 1], ['minutes', '도착 생성 기간 (분)', 60, 1, 1440, 1],
    ['discount', '여유 할인율 (%)', config.discount * 100, 0, 100, 1], ['surcharge', '혼잡 할증율 (%)', config.surcharge * 100, 0, 100, 1],
    ['energy', '차량당 충전량 (kWh)', 30, .1, 200, .1], ['sensitivity', '가격 민감도 (배)', 1, 0, 10, .1],
    ['alpha', '이동 비용 α (원/km)', 600, 0, 100000, 10], ['beta', '대기 비용 β (원/분)', 300, 0, 100000, 10],
    ['tau', '선택 다양성 τ (원)', 2000, 1, 100000, 1], ['threshold', '여유 판정 대기율 (%)', config.threshold * 100, 10, 90, 1],
    ['distance', 'B 추가 거리 (km)', 2, 0, 200, .001], ['repeats', '반복 실험 (회)', 100, 1, 500, 1], ['seed', '난수 시드', 42, 0, 4294967295, 1]
  ];
  const policiesFields = new Set(['discount', 'surcharge', 'threshold']);
  const experimentFields = new Set(['repeats', 'seed']);
  const badge = kind => `<span class="sim-kind" data-kind="${escape(kind)}">${escape(kind)}</span>`;
  const fieldKind = key => policiesFields.has(key) ? '정책 설정' : experimentFields.has(key) ? '실험 설정' : '가정값';
  const sweepFields = fields.filter(([key]) => !experimentFields.has(key));
  let pool = [], last = null, lastSweep = null, busy = false, cancelSweep = false, source = '예시 데이터', dataVersion = 0;
  $('simulation-view').innerHTML = `
    <span class="sim-kicker">ESSENTIAL · DEMAND LAB</span>
    <h2>요금이 바뀌면, 충전 수요는 어디로 갈까요?</h2>
    <p class="sim-lead">동일한 가상 운전자와 도착 조건에서 세 요금 정책을 비교합니다. 충전비, 이동거리, 대기시간을 함께 고려한 모의실험입니다.</p>
    <div class="sim-layout"><form id="sim-form" class="sim-card">
      <h3>01 · 실험 조건</h3><fieldset id="sim-controls" style="border:0;padding:0;margin:0;min-width:0"><div class="sim-fields">
        <label class="sim-wide">데이터 모드<select id="sim-mode"><option value="real">실제 공공데이터 · 마지막 수집 상태</option><option value="demo">예시 데이터 · 오프라인 데모</option></select></label>
        <label>분석 지역<select id="sim-region">${config.regions.map(r => `<option value="${escape(r.code)}">${escape(r.name)}</option>`).join('')}</select></label>
        <label>충전기 종류<select id="sim-speed"><option value="fast">급속</option><option value="slow">완속</option></select></label>
        <label class="sim-wide">충전소 A<select id="sim-a" required></select></label>
        <label class="sim-wide">충전소 B<select id="sim-b" required></select></label>
        ${fields.map(([id, label, value, min, max, step]) => `<label>${label}<span id="sim-kind-${id}">${badge(id === 'distance' ? '추정값' : fieldKind(id))}</span><input id="sim-${id}" type="number" value="${value}" min="${min}" max="${max}" step="${step}" required></label>`).join('')}
        <label class="sim-wide">추가 거리 산정<select id="sim-distanceMode"><option value="coords">A↔B 좌표 직선거리 (A: 0km)</option><option value="manual">사용자 가정값 (A: 0km, B: 입력값)</option></select></label>
        <label class="sim-wide">신규 차량 충전시간 ${badge('가정값')}<select id="sim-durationMode"><option value="power"${sim.defaults.durationMode === 'power' ? ' selected' : ''}>충전량 ÷ 대표 출력 × 60분 (기본)</option><option value="assumed"${sim.defaults.durationMode === 'assumed' ? ' selected' : ''}>20~40분 균등분포 (간소화 가정)</option></select></label>
        <label class="sim-wide">요금 판정 기준<select id="sim-pricingBasis"><option value="observed">현재 수집 상태</option><option value="forecast">외부 AI 모델 예측 이용률</option></select></label>
      </div>
      <div id="sim-forecast-panel" hidden>
        <p class="sim-note">모델이 만든 JSON을 파일·URL·붙여넣기로 입력하세요. A/B의 동일한 종류 예측이 모두 필요합니다. 예측 이용률은 요금에만 적용하며 초기 대기열은 실제 수집 상태를 유지합니다.</p>
        <label class="sim-note">예측 JSON 파일<input type="file" id="sim-forecast-file" accept=".json,application/json"></label>
        <label class="sim-note" style="display:block;margin-top:10px">예측 JSON URL<input id="sim-forecast-url" type="text" value="data/forecast.json" style="width:100%;box-sizing:border-box"></label>
        <button type="button" id="sim-forecast-fetch">URL에서 예측 불러오기</button>
        <label class="sim-note" style="display:block;margin-top:10px">예측 JSON<textarea id="sim-forecast-json" rows="9" style="width:100%;box-sizing:border-box" placeholder="AI 모델의 실제 출력 JSON을 입력하세요"></textarea></label>
        <p class="sim-note" id="sim-forecast-status" role="status">예측 데이터가 입력되지 않았습니다. 임의 예측값은 생성하지 않습니다.</p>
      </div></fieldset>
      <div class="sim-actions"><button class="sim-primary" id="sim-run" type="submit">시뮬레이션 실행</button><button id="sim-reload" type="button">데이터 새로 읽기</button></div>
      <p class="sim-note">가격 민감도 1배에서 C = E×P + α×D + β×W. 민감도는 E×P 항에 곱합니다. 모든 행동계수는 실측값이 아닌 가정입니다. 시간대 배수는 적용하지 않습니다.</p>
    </form><div>
      <div class="sim-card"><h3>02 · 비교할 두 충전소</h3><span class="sim-badge" id="sim-source"></span><div id="sim-message" class="sim-status" role="status" aria-live="polite"></div><div id="sim-stations" class="sim-stations"></div></div>
      <details class="sim-card" id="sim-evidence-box"><summary>입력값의 근거 · 실측값 / 추정값 / 가정값</summary><p class="sim-note">실측·수집값은 수집 시각의 기록입니다. 추정값은 계산·대체 단가·대표 출력·외부 예측을 뜻하며 통계 보정을 완료했다는 뜻은 아닙니다. 가정값은 검증 전 시나리오입니다. 공시요금·정책·반복 설정도 별도로 구분합니다.</p><div id="sim-evidence"></div></details>
      <details class="sim-card"><summary>AI 모델 출력 예시와 연결 범위</summary>
        <p>현재 연결은 충전소 ID·급속/완속·예측 이용률(0~1), 모델명, 생성 시각, 예측 대상 시각을 받는 버전 1입니다. 이용률은 요금 판정에만 적용합니다.</p>
        <p>예: A 이용률 0.8, B 0.2. 이 수치는 형식 설명용이며 실제 예측이 아닙니다. 예시 파일은 example_only=true로 표시하여 실제 모델 출력으로 실행하지 못하게 합니다.</p>
        <button type="button" id="sim-example-output">현재 A/B의 출력 형식 예시 JSON 다운로드</button>
        <p>후속 버전 2 계약안은 15분 구간 시작·종료, 기준 이용률, 예상 신규 도착 건수를 추가합니다. 건별 이력이 있으면 건당 충전량·소요시간도 보완할 수 있습니다. 버전 2 자동 적용은 아직 지원하지 않습니다.</p>
        <p><a href="https://github.com/ms3011975/ev-hackathon.github.io/blob/main/docs/simulation-report.md" target="_blank" rel="noopener">팀 공유용 출력 JSON 예시와 분석 리포트 설명</a></p>
      </details>
      <progress id="sim-progress" max="1" value="0" hidden aria-label="시뮬레이션 진행률"></progress>
      <div id="sim-results" aria-live="polite"><div class="sim-card"><h3>03 · 정책 비교</h3><p class="sim-note">기본 예시 조건으로 바로 실행할 수 있습니다. 결과는 실제 수요 분산 실적 또는 배전망 피크 저감 성과가 아닙니다.</p></div></div>
      <section id="sim-load-report" class="sim-card" aria-label="충전 부하 분석 리포트" hidden>
        <p id="sim-load-state" class="sim-note" role="status"></p><div id="sim-load-content"></div>
        <div class="sim-actions"><button type="button" id="sim-report-export">분석 리포트 HTML 다운로드</button><button type="button" id="sim-load-export">부하 시계열 CSV 다운로드</button></div>
      </section>
      <section class="sim-card" id="sim-sweep-panel" aria-label="민감도 분석">
        <h3>04 · 가정값을 바꿔 보는 민감도 분석</h3>
        <p class="sim-note">현재 A/B와 조건을 고정하고 한 항목만 바꿉니다. 실측 보정이나 최적 정책 인증이 아닌 시나리오 비교입니다. 현재 기준값은 자동 포함합니다.</p>
        <fieldset id="sim-sweep-controls" class="sim-fields" style="border:0;padding:0;margin:0;min-width:0">
          <label>비교할 항목<select id="sim-sweep-key">${sweepFields.map(([key,label]) => `<option value="${key}">${label}</option>`).join('')}<option value="durationMode">충전시간 계산 방식</option></select></label>
          <label>비교할 값 (쉼표로 구분)<input type="text" id="sim-sweep-values" value="12,24,36"></label>
          <button id="sim-sweep-preset" type="button">현재값의 0.5 / 1 / 1.5배 넣기</button>
          <button id="sim-sweep-run" type="button" class="sim-primary">민감도 분석 실행</button>
        </fieldset>
        <button id="sim-sweep-cancel" type="button" hidden>분석 중단</button>
        <p class="sim-note">비교값은 최대 8개입니다. 정책 비율은 화면과 동일한 % 단위입니다. 거리 변경은 사용자 가정 시나리오로 취급합니다. 충전시간 방식은 assumed(20~40분), power(출력 기반)를 사용합니다. 제안값은 검증된 현실 범위가 아닙니다.</p>
        <p id="sim-sweep-status" class="sim-status" role="status" aria-live="polite">항목과 비교값을 확인한 뒤 실행하세요.</p>
        <div id="sim-sweep-results"></div>
      </section>
      <details class="sim-card"><summary>모델 가정과 결과 읽는 방법</summary>
        <p>운전자의 도착 시각은 입력한 기간 내 균등분포로 생성합니다. A를 원래 목적지로 가정해 추가 거리 0km, B는 입력값 또는 충전소 간 직선거리를 사용합니다. 이동 소요시간은 따로 더하지 않으며 선택과 충전소 도착은 같은 시각에 처리합니다.</p>
        <p>기본 충전시간은 충전량÷대표 출력×60분이며 초기 차량 잔여시간은 0~해당 시간의 균등분포입니다. 선택 가능한 20~40분 가정 모드에서는 초기 잔여시간을 0~30분으로 둡니다. 충전효율·배터리 충전곡선·출력 공유는 반영하지 않습니다. 혼합 출력 충전소는 기존 관제의 대표 출력·단가를 동일하게 적용합니다.</p>
        <p>판정 분모는 빈 충전기+충전 중이며 고장·미확인 충전기는 처리 능력에서 제외합니다. 요금 기준은 현재 상태 또는 외부 예측 이용률로 선택합니다. 예측 모드에서도 초기 점유는 실제 수집 상태이며 요금만 예측값으로 고정합니다. 예측 대상 미래 시점의 대기열을 복원하는 기능은 없습니다. AI 예측값을 임의 생성하지 않습니다.</p>
        <p>선택 당시 예상 대기는 이미 도착한 차량을 포함한 가장 빠른 충전기 사용 가능 시각으로 계산합니다. 실제 대기는 도착순 FIFO 예약 후 계산합니다. 같은 정보와 변경 없는 대기열을 사용하는 이 모델에서는 두 값이 일치합니다. 기간 내 도착한 모든 신규 차량을 충전 완료까지 집계하며 초기 차량의 요금은 제외합니다.</p>
        <p>결과는 반복 1회당 평균입니다. 평균 대기의 표준오차(SE)는 반복 실험 간 변동이며 실세계 예측 오차가 아닙니다. 총 할인 혜택은 기본 단가 대비 할인액의 합으로 사업자 순손실과 다릅니다. 수입 차이는 정책별 선택 충전소와 단가로 계산한 단순 매출 차이이며 비용을 반영하지 않습니다.</p>
      </details>
    </div></div>`;
  function message(text, error = false) { $('sim-message').textContent = text; $('sim-message').dataset.error = error; }
  function selected() { return [$('sim-a').value, $('sim-b').value].map(id => pool.find(s => s.id === id)); }
  function invalidate() {
    if (last) $('sim-export').disabled = true;
    for (const id of ['sim-report-export','sim-load-export']) $(id).disabled = true;
    if (last) $('sim-load-state').textContent = '조건이 변경되었습니다. 이전 실행 리포트입니다. 다시 실행하세요.';
    $('sim-results').dataset.stale = 'true';
    if (last) $('sim-result-state').textContent = '조건이 변경되었습니다. 아래는 이전 실행 결과입니다. 다시 실행해 주세요.';
    if (lastSweep) { $('sim-sweep-export').disabled = true; $('sim-sweep-state').textContent = '조건이 변경되었습니다. 아래는 이전 분석 결과입니다. 다시 분석해 주세요.'; }
    renderEvidence();
  }
  function distance() {
    const [a, b] = selected();
    const coords = $('sim-distanceMode').value === 'coords'; $('sim-distance').readOnly = coords;
    $('sim-kind-distance').innerHTML = badge(coords ? '추정값' : '가정값');
    if (coords && a && b) {
      const rad = Math.PI / 180, h = Math.sin((b.lat - a.lat) * rad / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin((b.lng - a.lng) * rad / 2) ** 2;
      $('sim-distance').value = (6371 * 2 * Math.asin(Math.sqrt(Math.min(1, h)))).toFixed(3);
    }
  }
  function cards() {
    distance(); $('sim-source').textContent = source;
    $('sim-stations').innerHTML = selected().map((s, i) => !s ? '<p>선택할 충전소가 없습니다.</p>' : `<div class="sim-station"><strong>${i ? 'B' : 'A'} · ${escape(s.name)}</strong>${badge($('sim-mode').value === 'real' ? '실측·수집값' : '가정값')}
      <div class="sim-note">ID ${escape(s.id)} · ${s.speed === 'fast' ? '급속' : '완속'}<br>${fmt(s.lat, 5)}, ${fmt(s.lng, 5)}<br>
      빈 충전기 ${s.avail}대 · 충전 중 ${s.charging}대<br>사용 불가 ${s.fault}대 · 미확인 ${s.unknown || 0}대<br>처리 가능 ${s.avail + s.charging}대 · 현재 ${sim.status(s, +$('sim-threshold').value / 100)}<br>
      기본 ${fmt(s.base)}원/kWh · ${fmt(s.kw)}kW<br>${escape(s.source)}</div></div>`).join('');
    renderEvidence();
  }
  function choosePool(items) {
    pool = items.filter(s => s.avail + s.charging > 0 && Number.isFinite(s.base) && s.base > 0 && s.kw > 0 && Number.isFinite(s.lat) && Number.isFinite(s.lng));
    const options = pool.map(s => `<option value="${escape(s.id)}">${escape(s.name)} · ${sim.status(s, +$('sim-threshold').value / 100)} · ${escape(s.id)}</option>`).join('');
    $('sim-a').innerHTML = options; $('sim-b').innerHTML = options;
    const threshold = +$('sim-threshold').value / 100;
    const a = pool.find(s => sim.status(s, threshold) === '혼잡') || pool[0];
    const candidates = pool.filter(s => s !== a && sim.status(s, threshold) === '여유');
    candidates.sort((x, y) => (x.lat - a.lat) ** 2 + (x.lng - a.lng) ** 2 - (y.lat - a.lat) ** 2 - (y.lng - a.lng) ** 2);
    const b = candidates[0] || pool.find(s => s !== a);
    if (a) $('sim-a').value = a.id; if (b) $('sim-b').value = b.id;
    cards(); $('sim-run').disabled = pool.length < 2;
    return a && sim.status(a, threshold) === '혼잡' && candidates.length > 0;
  }
  async function load() {
    const version = ++dataVersion; invalidate();
    $('sim-run').disabled = true; $('sim-reload').disabled = true;
    try {
      const demo = $('sim-mode').value === 'demo', speed = $('sim-speed').value;
      $('sim-region').disabled = demo;
      if (demo) {
        source = '예시 데이터 · 실제 충전소가 아닙니다';
        choosePool(sim.demo().map(s => ({ ...s, speed, kw: speed === 'fast' ? 60 : 7 })));
        message('A: 4대 모두 충전 중 / B: 4대 중 1대 충전 중. 지역 선택은 실제 데이터 모드에서 적용합니다. 예시 기본 단가는 양쪽 347.2원/kWh입니다.');
      } else {
        message('실제 충전소 데이터를 읽는 중입니다…');
        source = '실제 데이터 조회 중'; pool = []; cards();
        if (!window.ESSMonitor) throw new Error('관제 데이터 연결을 초기화하지 못했습니다. 지도 라이브러리 연결을 확인하거나 예시 모드를 사용하세요.');
        await window.ESSMonitor.ready;
        if (version !== dataVersion) return;
        const data = await window.ESSMonitor.stations($('sim-region').value);
        if (version !== dataVersion) return;
        source = `실제 수집 데이터 · ${data.when || '수집 시각 미제공'} · ${data.dataSource ? 'ev-hackathon 공개 저장본' : data.kind === 'snapshot' ? '저장본' : '마지막 수집 상태'}`;
        const pair = choosePool(data.list.map(s => ({ id: s.id, name: s.name, lat: s.lat, lng: s.lng, speed,
          ...s[speed], unknown: s[speed].total - s[speed].avail - s[speed].charging - s[speed].fault, source: s[speed].src || '기존 운영사 요금표' })));
        message(pool.length < 2 ? '동일 종류의 처리 가능한 충전소가 2곳 미만입니다. 예시 데이터 모드로 전환해 주세요.' : pair ? '같은 종류의 혼잡 A와 가장 가까운 여유 B를 선택했습니다. 다른 충전소도 직접 선택할 수 있습니다. 거리는 별도 설정을 확인하세요.' : '혼잡 A·여유 B 조건에 맞는 쌍이 없습니다. 비교 가능한 두 거점을 표시했습니다. 예시 데이터 모드도 사용할 수 있습니다.');
      }
    } catch (error) {
      if (version === dataVersion) { source = '실제 데이터 없음'; choosePool([]); message(error.message + ' 예시 데이터 모드를 선택하면 데모를 실행할 수 있습니다.', true); }
    } finally { if (version === dataVersion) $('sim-reload').disabled = false; }
  }
  function options() {
    const o = Object.fromEntries(fields.map(([key]) => [key, +$('sim-' + key).value]));
    for (const k of ['discount', 'surcharge', 'threshold']) o[k] /= 100;
    o.durationMode = $('sim-durationMode').value;
    return o;
  }
  function context(prediction) {
    return { source, executedAt: new Date().toISOString(), region: $('sim-mode').value === 'demo' ? '예시 · 지역 무관' : $('sim-region').selectedOptions[0].text,
      mode: $('sim-mode').value, speed: $('sim-speed').value, distanceMode: $('sim-distanceMode').value,
      forecastRequested: $('sim-pricingBasis').value === 'forecast',
      pricingBasis: $('sim-pricingBasis').value === 'forecast' ? '외부 모델의 예측 이용률 (요금에만 적용)' : '현재 수집 상태',
      forecastInfo: prediction ? `${prediction.model} · 생성 ${prediction.generatedAt} · 대상 ${prediction.targetTime}` : '',
      forecastUtilizationA: prediction?.utilizationById[selected()[0]?.id] ?? '', forecastUtilizationB: prediction?.utilizationById[selected()[1]?.id] ?? '' };
  }
  function evidenceTable(rows) {
    return `<p class="sim-note">좁은 화면에서는 표를 좌우로 스크롤해 구분과 근거를 확인하세요.</p><div class="sim-table-wrap"><table class="sim-table sim-evidence-table"><thead><tr><th>항목</th><th>값</th><th>구분</th><th>근거와 한계</th></tr></thead><tbody>${rows.map(r => `<tr><th scope="row">${escape(r.item)}</th><td>${escape(r.value)}</td><td>${badge(r.kind)}</td><td>${escape(r.basis)}</td></tr>`).join('')}</tbody></table></div>`;
  }
  function renderEvidence() {
    if (!$('sim-evidence')) return;
    let p; try { if ($('sim-pricingBasis').value === 'forecast') p = readForecast(); } catch { /* missing forecast is shown explicitly */ }
    $('sim-evidence').innerHTML = evidenceTable(sim.evidence(selected().filter(Boolean), options(), context(p)));
  }
  function lock(active) {
    busy = active; $('sim-controls').disabled = active; $('sim-sweep-controls').disabled = active;
    $('sim-run').disabled = active || pool.length < 2; $('sim-reload').disabled = active;
    if (!active) $('sim-region').disabled = $('sim-mode').value === 'demo';
  }
  function render(result) {
    const { results, options: o } = result, maxWait = Math.max(1, ...results.map(r => r.wait));
    const maxDiscount = Math.max(1, ...results.map(r => r.discount));
    const bar = (r, value, max, unit) => `<div class="sim-bar-row"><div class="sim-bar-label"><span>${r.label}</span><b>${fmt(value)}${unit}</b></div><div class="sim-track"><div class="sim-fill sim-wait" style="width:${value / max * 100}%"></div></div></div>`;
    $('sim-results').innerHTML = `<div class="sim-card"><h3>03 · 세 정책, 같은 운전자</h3>
      <p class="sim-note" id="sim-result-state">${escape(result.context.source)} · ${escape(result.context.region)} · 가상 시뮬레이션 결과<br>요금 기준: ${escape(result.context.pricingBasis)}<br>${escape(result.context.forecastInfo || '')}<br>반복 ${o.repeats}회 평균 · 신규 ${o.drivers}명 · 도착 ${o.minutes}분 · ${o.energy}kWh · 시드 ${o.seed} · B 추가 ${fmt(o.distance, 3)}km</p>
      <div class="sim-table-wrap"><table class="sim-table"><caption>정책별 비교 (반복 1회당 평균)</caption><thead><tr><th>지표</th>${results.map(r => `<th scope="col">${r.label}</th>`).join('')}</tr></thead><tbody>
      ${[
        ['A 적용 단가 (원/kWh)', r => fmt(r.prices[0])], ['B 적용 단가 (원/kWh)', r => fmt(r.prices[1])],
        ['A 선택 (명 / %)', r => `${fmt(r.count[0])} / ${fmt(r.share[0] * 100)}%`], ['B 선택 (명 / %)', r => `${fmt(r.count[1])} / ${fmt(r.share[1] * 100)}%`],
        ['전체 평균 실제 대기 (분)', r => fmt(r.wait, 2)], ['선택 당시 예상 대기 (분)', r => fmt(r.expectedWait, 2)], ['평균 대기 표준오차 (분)', r => fmt(r.waitSE, 2)],
        ['고정 대비 대기 변화 (%)', r => r.waitChange === null ? '산정 불가 (기준 0분)' : fmt(r.waitChange)], ['평균 충전요금 (원/명)', r => fmt(r.fee)],
        ['평균 추가 거리 (km/명)', r => fmt(r.distance, 3)], ['총 할인 혜택 (원)', r => fmt(r.discount)], ['요금 수입 (원)', r => fmt(r.revenue)],
        ['고정 대비 수입 차이 (원)', r => fmt(r.revenueChange)], ['마지막 충전 완료 (시작 후 분)', r => fmt(r.completion)]
      ].map(([label, get]) => `<tr><th scope="row">${label}</th>${results.map(r => `<td>${get(r)}</td>`).join('')}</tr>`).join('')}
      </tbody></table></div><div class="sim-actions"><button id="sim-export" type="button">결과 CSV 다운로드</button></div><details style="margin-top:15px"><summary>이 실행에 사용한 값의 근거</summary>${evidenceTable(result.evidence)}</details></div>
      <div class="sim-charts"><div class="sim-card"><h3>충전소 선택 인원</h3><p class="sim-legend"><span></span>A &nbsp; <span></span>B · 명/회</p>${results.map(r => `<div class="sim-bar-row"><div class="sim-bar-label"><span>${r.label}</span><b>A ${fmt(r.count[0])} / B ${fmt(r.count[1])}명</b></div><div class="sim-track" role="img" aria-label="${r.label}: A ${fmt(r.count[0])}명, B ${fmt(r.count[1])}명"><div class="sim-fill" style="width:${r.share[0] * 100}%"></div><div class="sim-fill-b" style="width:${r.share[1] * 100}%"></div></div></div>`).join('')}</div>
      <div class="sim-card"><h3>평균 실제 대기시간</h3>${results.map(r => bar(r, r.wait, maxWait, '분')).join('')}</div></div>
      <div class="sim-card"><h3>이용자 총 할인 혜택</h3>${results.map(r => bar(r, r.discount, maxDiscount, '원')).join('')}<p class="sim-note">기본 단가 대비 할인 혜택의 합입니다. 사업자의 순손실을 의미하지 않습니다. 할증에 따른 추가 부담은 할인액에서 차감하지 않습니다.</p></div>`;
    $('sim-export').addEventListener('click', exportCSV);
    $('sim-load-report').hidden = false;
    $('sim-load-state').textContent = '이번 실행의 설정과 반복 결과로 생성했습니다.';
    $('sim-load-content').innerHTML = window.ESSReport.render(result);
    const available = results.every(r=>r.load.available);
    $('sim-report-export').disabled = !available; $('sim-load-export').disabled = !available;
  }
  function exportCSV() {
    if (!last || $('sim-export').disabled) return;
    const { options: o, stations, results, context } = last;
    const rows = [['항목', '값'], ['데이터 출처', context.source], ['지역', context.region], ['결과 구분', '가상 시뮬레이션 · 회당 평균'],
      ...Object.entries(o), ...Object.entries(context), ...stations.flatMap((s, i) => Object.entries(s).map(([k, v]) => [`${i ? 'B' : 'A'}_${k}`, v])), [],
      ['입력 근거 항목', '값', '구분', '근거와 한계'], ...last.evidence.map(r => [r.item, r.value, r.kind, r.basis]), [],
      ['정책', 'A단가_원kWh', 'B단가_원kWh', 'A선택_명', 'B선택_명', 'A비율', 'B비율', '실제대기_분', '예상대기_분', '대기표준오차_분', '고정대비대기변화_pct', '평균요금_원', '평균추가거리_km', '총할인혜택_원', '수입_원', '고정대비수입차이_원', '마지막완료_분'],
      ...results.map(r => [r.label, ...r.prices, ...r.count, ...r.share, r.wait, r.expectedWait, r.waitSE, r.waitChange, r.fee, r.distance, r.discount, r.revenue, r.revenueChange, r.completion])];
    downloadRows(`essential-simulation-${o.seed}.csv`, rows);
  }
  function downloadRows(filename, rows) {
    const cell = value => { const text = String(value ?? ''); return '"' + (/^[=+@-]/.test(text) && !Number.isFinite(Number(text)) ? "'" : '') + text.replace(/"/g, '""') + '"'; };
    downloadFile(filename, '\ufeff' + rows.map(row => row.map(cell).join(',')).join('\r\n'), 'text/csv;charset=utf-8');
  }
  function downloadFile(filename, text, type) {
    const blob = new Blob([text], { type });
    const url = URL.createObjectURL(blob), a = document.createElement('a'); a.href = url; a.download = filename; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  $('sim-report-export').addEventListener('click', () => {
    if (last && !$('sim-report-export').disabled) downloadFile(`essential-report-${last.options.seed}.html`, window.ESSReport.html(last), 'text/html;charset=utf-8');
  });
  $('sim-load-export').addEventListener('click', () => {
    if (last && !$('sim-load-export').disabled) downloadRows(`essential-load-${last.options.seed}.csv`, window.ESSReport.rows(last));
  });
  $('sim-example-output').addEventListener('click', () => {
    const now = Date.now(), stations = selected().filter(Boolean);
    const payload = { schema_version: 1, example_only: true, model_name: 'FORMAT_EXAMPLE_NOT_A_MODEL',
      generated_at: new Date(now).toISOString(), target_time: new Date(now+3600000).toISOString(),
      predictions: (stations.length === 2 ? stations : sim.demo()).map((s,i)=>({station_id:s.id,speed:s.speed,utilization:i ? .2 : .8})) };
    downloadFile('essential-forecast-format-example.json', JSON.stringify(payload,null,2), 'application/json;charset=utf-8');
  });
  const sweepLabel = key => key === 'durationMode' ? '충전시간 계산 방식' : fields.find(f => f[0] === key)[1];
  const levelLabel = (key, value) => key === 'durationMode' ? value === 'power' ? '출력 기반' : '20~40분 가정' : fmt(policiesFields.has(key) ? value * 100 : value, 3).replace(/\.?0+$/, '');
  function presetSweep() {
    invalidateSweep();
    const key = $('sim-sweep-key').value;
    if (key === 'durationMode') { $('sim-sweep-values').value = 'assumed,power'; return; }
    const field = fields.find(f => f[0] === key), current = +$('sim-' + key).value;
    const vals = current === 0 ? [0, Math.max(field[3], policiesFields.has(key) ? 10 : 1), Math.max(field[3], policiesFields.has(key) ? 20 : 2)] : [.5, 1, 1.5].map(m => current * m);
    $('sim-sweep-values').value = [...new Set(vals.map(v => key === 'drivers' ? Math.round(v) : Number(v.toFixed(3))).map(v => Math.min(field[4], Math.max(field[3], v))))].join(',');
  }
  function renderSweep(output) {
    const label = sweepLabel(output.key), maxWait = Math.max(1, ...output.scenarios.flatMap(s => s.results.map(r => r.wait)));
    const winners = output.scenarios.map(s => {
      const min = Math.min(...s.results.map(r => r.wait));
      return s.results.filter(r => r.wait - min < .01).map(r => r.label).join(' / ');
    });
    const stable = new Set(winners).size === 1;
    $('sim-sweep-results').innerHTML = `<p class="sim-note" id="sim-sweep-state">${escape(output.context.source)} · ${escape(output.context.region)}<br>비교 항목: ${escape(label)} · 현재 기준값 ${escape(levelLabel(output.key, output.baseline))}<br>요금 기준: ${escape(output.context.pricingBasis)} · ${escape(output.context.forecastInfo)}<br>반복 ${output.base.repeats}회 · 시드 ${output.base.seed} · 다른 입력과 초기 상태 고정</p>
      <p class="sim-status">${stable ? '이 비교 범위에서는 평균 대기 최소 정책 집합이 유지됐습니다.' : '수준에 따라 평균 대기 최소 정책 집합이 달라졌습니다. 가정에 따라 정책 순위가 바뀔 수 있습니다.'} 0.01분 미만 차이는 공동 최소로 표시합니다. 통계적 유의성 판정이나 전역 최적 정책은 아닙니다.</p>
      <div class="sim-table-wrap"><table class="sim-table"><caption>한 항목씩 변경 · 반복 1회당 평균</caption><thead><tr><th>${escape(label)}</th><th>정책</th><th>A / B 선택 (명)</th><th>B 비율 (%)</th><th>대기 (분)</th><th>현재값 대비 대기 차이 (분)</th><th>현재값 대비 B 비율 차이 (%p)</th><th>고정요금 대비 대기 (%)</th><th>요금 (원/명)</th><th>추가 거리 (km/명)</th><th>총 할인 (원)</th><th>수입 차이 (원)</th></tr></thead><tbody>
      ${output.scenarios.map(s => s.results.map(r => `<tr><th scope="row">${escape(levelLabel(output.key,s.value))}${s.value === output.baseline ? ' · 현재값' : ''}</th><td>${r.label}</td><td>${fmt(r.count[0])} / ${fmt(r.count[1])}</td><td>${fmt(r.share[1]*100)}</td><td>${fmt(r.wait,2)}</td><td>${fmt(r.waitDelta,2)}</td><td>${fmt(r.shareBDelta,2)}</td><td>${r.waitChange === null ? '기준 0분' : fmt(r.waitChange)}</td><td>${fmt(r.fee)}</td><td>${fmt(r.distance,3)}</td><td>${fmt(r.discount)}</td><td>${fmt(r.revenueChange)}</td></tr>`).join('')).join('')}</tbody></table></div>
      <div class="sim-table-wrap"><table class="sim-table"><caption>부하 민감도 · 15분 평균 부하의 반복별 피크 평균</caption><thead><tr><th>${escape(label)}</th><th>정책</th><th>A 피크 (kW)</th><th>B 피크 (kW)</th><th>합산 피크 (kW)</th><th>고정 대비 합산 저감률 (%)</th><th>기간 이후 충전량 (kWh)</th></tr></thead><tbody>${output.scenarios.map(s=>s.results.map(r=>`<tr><th>${escape(levelLabel(output.key,s.value))}</th><td>${r.label}</td><td>${fmt(r.load.stationPeakKw?.[0])}</td><td>${fmt(r.load.stationPeakKw?.[1])}</td><td>${fmt(r.load.combinedPeakKw)}</td><td>${fmt(r.load.combinedPeakReductionPct)}</td><td>${fmt(r.load.tailEnergyKwh)}</td></tr>`).join('')).join('')}</tbody></table></div>
      <p class="sim-note">저감률은 해당 수준의 고정요금 대비이며 양수는 감소, 음수는 증가입니다. 20~40분 가정의 등가 전력은 대표 출력을 넘을 수 있습니다. 부하 해석에는 출력 기반 모드를 권장합니다. 위 정책 순위 안내는 피크가 아닌 대기시간 기준입니다.</p>
      <div class="sim-charts">${sim.policies.map((label,p) => `<div><h4>${label} · 평균 대기</h4>${output.scenarios.map(s => `<div class="sim-bar-row"><div class="sim-bar-label"><span>${escape(levelLabel(output.key,s.value))}${s.value === output.baseline ? ' (현재값)' : ''}</span><b>${fmt(s.results[p].wait,2)}분</b></div><div class="sim-track"><div class="sim-fill sim-wait" style="width:${s.results[p].wait/maxWait*100}%"></div></div></div>`).join('')}</div>`).join('')}</div>
      <p class="sim-note">각 수준의 ‘고정요금 대비’는 그 수준의 고정요금 정책과 비교합니다. ‘현재값 대비’는 현재 기준값에서의 같은 정책과 비교합니다. 동일 난수·초기 잔여시간을 공유하며 인원 변경 시 기존 운전자를 보존하고 추가 인원만 별도 난수로 생성합니다. 상호작용·실세계 예측오차는 분석하지 않습니다.</p>
      <details><summary>이 분석의 기준 입력 근거</summary>${evidenceTable(output.evidence)}</details>
      <div class="sim-actions"><button type="button" id="sim-sweep-export">민감도 분석 CSV 다운로드</button></div>`;
    $('sim-sweep-export').addEventListener('click', exportSweep);
  }
  function exportSweep() {
    if (!lastSweep || $('sim-sweep-export').disabled) return;
    const s = lastSweep;
    const rows = [['분석','한 항목씩 변경하는 시나리오 민감도 분석'],['비교 항목',sweepLabel(s.key)],['현재 기준값',s.baseline],
      ...Object.entries(s.context), ...Object.entries(s.base), [], ['기준 입력 근거','값','구분','근거와 한계'], ...s.evidence.map(r=>[r.item,r.value,r.kind,r.basis]), [],
      ['수준_내부단위','수준_화면단위','현재값여부','정책','A선택_명','B선택_명','B비율_pct','평균대기_분','대기SE_분','현재값대비대기차이_분','현재값대비B비율차이_pp','고정대비대기변화_pct','평균요금_원','평균거리_km','총할인_원','수입_원','고정대비수입차이_원','A단가','B단가'],
      ...s.scenarios.flatMap(level=>level.results.map(r=>[level.value,levelLabel(s.key,level.value),level.value===s.baseline,r.label,...r.count,r.share[1]*100,r.wait,r.waitSE,r.waitDelta,r.shareBDelta,r.waitChange,r.fee,r.distance,r.discount,r.revenue,r.revenueChange,...r.prices]))];
    for (const level of s.scenarios) rows.push([],['수준별 입력 근거',level.value],['항목','값','구분','근거와 한계'],...level.evidence.map(r=>[r.item,r.value,r.kind,r.basis]));
    rows.push([],['부하 민감도: 15분 등가 부하. 실제 배전망 실측 아님'],['수준','정책','A피크_kW','B피크_kW','합산피크_kW','고정대비합산저감_pct','기간이후충전량_kWh','대표출력초과신규차량_명']);
    for (const level of s.scenarios) for (const r of level.results) rows.push([level.value,r.label,...(r.load.stationPeakKw || ['', '']),r.load.combinedPeakKw,r.load.combinedPeakReductionPct,r.load.tailEnergyKwh,r.load.overRatedSessions]);
    downloadRows(`essential-sensitivity-${s.key}-${s.base.seed}.csv`,rows);
  }
  $('sim-sweep-key').addEventListener('change', presetSweep);
  $('sim-sweep-preset').addEventListener('click', presetSweep);
  function invalidateSweep() {
    if (lastSweep) { $('sim-sweep-export').disabled = true; $('sim-sweep-state').textContent = '분석 항목이 변경되었습니다. 아래는 이전 결과입니다.'; }
  }
  for (const id of ['sim-sweep-key','sim-sweep-values']) $(id).addEventListener('input', invalidateSweep);
  $('sim-sweep-cancel').addEventListener('click', () => { cancelSweep = true; $('sim-sweep-status').textContent = '중단 요청을 처리하고 있습니다…'; });
  $('sim-sweep-run').addEventListener('click', async () => {
    if (busy || !$('sim-form').reportValidity()) return;
    const stations = selected().map(s => s && ({ ...s }));
    if (stations.some(s=>!s)) { $('sim-sweep-status').textContent = '충전소 A/B를 먼저 선택하세요.'; return; }
    cancelSweep = false; lock(true); $('sim-sweep-cancel').hidden = false;
    try {
      const key = $('sim-sweep-key').value, parts = $('sim-sweep-values').value.split(',').map(s=>s.trim());
      if (parts.some(s=>!s)) throw new Error('쉼표로 구분한 비교값을 입력하세요. 빈 값은 사용할 수 없습니다.');
      const values = key === 'durationMode' ? parts : parts.map(v => Number(v) / (policiesFields.has(key) ? 100 : 1));
      const prediction = $('sim-pricingBasis').value === 'forecast' ? readForecast() : null;
      const capturedContext = context(prediction), capturedOptions = options();
      if (lastSweep) $('sim-sweep-export').disabled = true;
      const output = await sim.sweep(stations, capturedOptions, key, values, p => { $('sim-sweep-status').textContent = `민감도 분석 중… ${Math.round(p*100)}%`; }, prediction?.utilizationById, () => cancelSweep);
      output.context = capturedContext; output.evidence = sim.evidence(stations,capturedOptions,capturedContext);
      for (const level of output.scenarios) level.evidence = sim.evidence(stations,level.options,{...capturedContext,distanceMode:key === 'distance' && level.value !== output.baseline ? 'manual' : capturedContext.distanceMode});
      lastSweep = output; renderSweep(output);
      $('sim-sweep-status').textContent = `완료 · ${output.scenarios.length}개 수준 × 3개 정책. 결과는 가상 시나리오 비교입니다.`;
    } catch (error) { $('sim-sweep-status').textContent = error.message; }
    finally { lock(false); $('sim-sweep-cancel').hidden = true; }
  });
  $('sim-form').addEventListener('submit', async event => {
    event.preventDefault(); if (busy || !$('sim-form').reportValidity()) return;
    const stations = selected();
    if (stations.some(s => !s)) return message('같은 종류의 충전소 2곳을 선택하세요.', true);
    lock(true); $('sim-progress').hidden = false;
    message('세 정책에 동일한 운전자를 적용해 계산하고 있습니다…');
    try {
      let prediction = null;
      if ($('sim-pricingBasis').value === 'forecast') {
        prediction = readForecast();
        $('sim-forecast-status').textContent = `${prediction.model} · 대상 ${prediction.targetTime} · A ${(prediction.utilizationById[stations[0].id] * 100).toFixed(1)}%, B ${(prediction.utilizationById[stations[1].id] * 100).toFixed(1)}%`;
      }
      const result = await sim.compare(stations, options(), p => { $('sim-progress').value = p; }, prediction?.utilizationById);
      result.context = context(prediction);
      result.evidence = sim.evidence(result.stations, result.options, result.context);
      last = result; render(result); message('계산 완료. 아래 결과는 가상 운전자 모의실험이며 실제 관측 성과가 아닙니다.');
    } catch (error) { message(error.message, true); }
    finally { lock(false); $('sim-progress').hidden = true; }
  });
  $('sim-form').addEventListener('input', invalidate);
  function readForecast() {
    const stations = selected();
    if (stations.some(s => !s)) throw new Error('먼저 충전소 A/B를 선택하세요.');
    let payload;
    try { payload = JSON.parse($('sim-forecast-json').value); } catch { throw new Error('예측 JSON 형식을 확인하세요.'); }
    return sim.forecast(payload, stations);
  }
  function checkForecast() {
    invalidate();
    try {
      const p = readForecast();
      $('sim-forecast-status').textContent = `검증 완료 · ${p.model} · 생성 ${p.generatedAt} · 대상 ${p.targetTime}. 실행 버튼을 눌러 적용하세요.`;
    } catch (error) { $('sim-forecast-status').textContent = error.message; }
  }
  $('sim-pricingBasis').addEventListener('change', () => {
    invalidate(); $('sim-forecast-panel').hidden = $('sim-pricingBasis').value !== 'forecast';
    if (!$('sim-forecast-panel').hidden) checkForecast();
  });
  $('sim-forecast-json').addEventListener('input', checkForecast);
  $('sim-forecast-file').addEventListener('change', async event => {
    const file = event.target.files[0]; if (!file) return;
    if (file.size > 2000000) { $('sim-forecast-status').textContent = '2MB 이하 JSON 파일을 선택하세요.'; return; }
    $('sim-forecast-json').value = await file.text(); checkForecast();
  });
  $('sim-forecast-fetch').addEventListener('click', async () => {
    const button = $('sim-forecast-fetch'); button.disabled = true;
    // Clear previous input so a failed fetch cannot silently reuse another forecast.
    $('sim-forecast-json').value = ''; invalidate();
    $('sim-forecast-status').textContent = '예측 JSON을 읽는 중입니다…';
    try {
      const url = new URL($('sim-forecast-url').value, location.href);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('인증정보·쿼리·해시 없는 HTTP(S) JSON URL을 사용하세요.');
      const response = await fetch(url, { cache: 'no-store', credentials: 'omit', signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error(`예측 파일 응답 ${response.status}`);
      const body = await response.text();
      if (body.length > 2000000) throw new Error('2MB 이하 JSON만 사용할 수 있습니다.');
      $('sim-forecast-json').value = body; checkForecast();
    } catch (error) { $('sim-forecast-status').textContent = `${error.message} · 외부 URL은 CORS 허용이 필요합니다.`; }
    finally { button.disabled = false; }
  });
  $('sim-form').addEventListener('change', invalidate);
  for (const id of ['mode', 'region', 'speed']) $('sim-' + id).addEventListener('change', load);
  for (const id of ['a', 'b', 'distanceMode', 'threshold']) $('sim-' + id).addEventListener('change', cards);
  $('sim-reload').addEventListener('click', load);
  for (const [id, active] of [['tab-monitor', false], ['tab-simulation', true]]) $(id).addEventListener('click', () => {
    $('monitor-view').hidden = active; $('simulation-view').hidden = !active;
    $('tab-monitor').setAttribute('aria-pressed', String(!active)); $('tab-simulation').setAttribute('aria-pressed', String(active));
    $('regions').hidden = active;
    if (!active) window.ESSMonitor?.resize();
  });
  if (location.hash === '#simulation') $('tab-simulation').click();
  load();
})();
