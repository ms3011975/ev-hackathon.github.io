(function () {
  'use strict';
  const sim = window.ESSimulation, config = JSON.parse(document.getElementById('sim-config').textContent);
  const routing = window.ESSRouting, roadClient = routing.createClient((url, opts)=>fetch(url, opts));
  let roadState = null, roadTimer;
  const timingClient=window.ESSessionTiming.createClient((url,opts)=>fetch(url,opts));
  let sessionState=null;
  let forecastLoading=false,forecastFailure='';
  const $ = id => document.getElementById(id), escape = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const fmt = (n, d = 1) => Number.isFinite(n) ? n.toLocaleString('ko-KR', { minimumFractionDigits: d, maximumFractionDigits: d }) : '—';
  const kst = value => Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('ko-KR',{timeZone:'Asia/Seoul',hourCycle:'h23'})+' (한국 시각)' : String(value ?? '');
  const fields = [
    ['drivers', '신규 운전자 (명)', 24, 1, 500, 1], ['minutes', '도착 생성 기간 (분)', 60, 1, 1440, 1],
    ['discount', '여유 할인율 (%)', config.discount * 100, 0, 100, 1], ['surcharge', '혼잡 할증율 (%)', config.surcharge * 100, 0, 100, 1],
    ['energy', '차량당 충전량 (kWh)', sim.energyDefault('fast'), .1, 200, .01], ['sensitivity', '가격 민감도 (배)', sim.defaults.sensitivity, 0, 10, .1],
    ['alpha', '이동 비용 α (원/km)', sim.defaults.alpha, 0, 100000, 10], ['beta', '대기 비용 β (원/분)', sim.defaults.beta, 0, 100000, 10],
    ['tau', '선택 다양성 τ (원)', sim.defaults.tau, 1, 100000, 1], ['threshold', '여유 판정 대기율 (%)', config.threshold * 100, 10, 90, 1],
    ['distance', 'A→B 차량 이동거리 (km)', 2, 0, 200, .001], ['repeats', '반복 실험 (회)', 100, 1, 500, 1], ['seed', '난수 시드', 42, 0, 4294967295, 1]
  ];
  const policiesFields = new Set(['discount', 'surcharge', 'threshold']);
  const experimentFields = new Set(['repeats', 'seed']);
  const badge = kind => `<span class="sim-kind" data-kind="${escape(kind)}">${escape(kind)}</span>`;
  const fieldKind = key => policiesFields.has(key) ? '정책 설정' : experimentFields.has(key) ? '실험 설정' : '가정값';
  const sweepFields = fields.filter(([key]) => !experimentFields.has(key));
  const forecastURLs = {forecast:'https://ev-hackathon.github.io/data/forecast.json', 'forecast-v2':'https://ev-hackathon.github.io/data/forecast_v2.json'};
  let pool = [], last = null, lastSweep = null, lastBehavior = null, busy = false, cancelSweep = false, cancelBehavior = false, source = '예시 데이터', sourceWhen = '', dataVersion = 0, forecastRequest = 0, manualDemand = null, forecastOrigin = '';
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
        <label class="sim-wide">충전량 입력 근거<select id="sim-energySource"><option value="jeju">팀 채택 제주 추정값 · 급속/완속 자동 적용</option><option value="manual">사용자 가정값 · 직접 입력</option></select></label>
        <p class="sim-wide sim-note" id="sim-energy-note"></p>
        <label class="sim-wide">운전자 행동계수 설정<select id="sim-behaviorPreset"><option value="legacy">기존 예시값 · 1 / 600 / 300 / 2000</option><option value="literature" selected>팀 채택 문헌 기준 · 1 / 950 / 360 / 7200 (급속)</option><option value="slowLiterature">팀 채택 문헌 참고 · 1 / 510 / 220 / 10000 (완속·잠정)</option><option value="custom">사용자 가정값 · 직접 입력</option></select></label>
        <p class="sim-wide sim-note" id="sim-behavior-note"></p>
        ${fields.map(([id, label, value, min, max, step]) => `<label>${label}<span id="sim-kind-${id}">${badge(id === 'distance' ? '추정값' : fieldKind(id))}</span><input id="sim-${id}" type="number" value="${value}" min="${min}" max="${max}" step="${step}" required></label>`).join('')}
        <label class="sim-wide">추가 거리 산정<select id="sim-distanceMode"><option value="road">자동차 도로 이동거리 · 방향별 자동 조회</option><option value="manual">사용자 입력 거리 · 양방향 동일 가정</option></select></label>
        <p id="sim-road-status" class="sim-note sim-wide" role="status"></p>
        <button type="button" class="sim-wide" id="sim-road-reload">도로 거리 다시 조회</button>
        <label class="sim-wide">신규·초기 차량 충전시간 <span id="sim-kind-duration">${badge('추정값')}</span><select id="sim-durationMode"><option value="sessions" selected>충전 시작·종료 기록 기반 추정 (실제 데이터 기본)</option><option value="power">충전량 ÷ 대표 출력 × 60분</option><option value="assumed">20~40분 균등분포 (간소화 가정)</option></select></label>
        <p class="sim-wide sim-note" id="sim-timing-status" role="status">실행 시 최근 완료 세션을 자동으로 불러옵니다.</p>
        <button type="button" class="sim-wide" id="sim-timing-load">충전시간 기록 불러오기</button>
        <label class="sim-wide">요금·수요 기준<select id="sim-pricingBasis"><option value="observed">현재 수집 상태 + 수동 수요</option><option value="forecast">AI 1시간 후 이용률 + 수동 수요 (v1)</option><option value="forecast-v2">AI 15분 구간 이용률·신규 건수 (v2)</option></select></label>
      </div>
      <div id="sim-forecast-panel" hidden>
        <p class="sim-note">v1은 1시간 후 이용률로 요금만 정합니다. v2는 남은 15분 구간별 요금과 신규 차량 생성을 연결합니다. 초기 점유는 수집 상태를 사용하며 충전량·행동계수는 별도의 추정값 또는 사용자 가정을 적용합니다.</p>
        <label class="sim-note">예측 JSON 파일<input type="file" id="sim-forecast-file" accept=".json,application/json"></label>
        <label class="sim-note" style="display:block;margin-top:10px">예측 JSON URL<input id="sim-forecast-url" type="text" value="${forecastURLs.forecast}" style="width:100%;box-sizing:border-box"></label>
        <button type="button" id="sim-forecast-fetch">URL에서 예측 불러오기</button>
        <label class="sim-note" style="display:block;margin-top:10px"><input type="checkbox" id="sim-forecast-latest" checked> 실행 시 URL의 최신 예측 다시 읽기 (제공 예정 주기 30분 · 지연 가능)</label>
        <label class="sim-note" style="display:block;margin-top:10px">예측 JSON<textarea id="sim-forecast-json" rows="9" style="width:100%;box-sizing:border-box" placeholder="AI 모델의 실제 출력 JSON을 입력하세요"></textarea></label>
        <p class="sim-note" id="sim-forecast-status" role="status">예측 데이터가 입력되지 않았습니다. 임의 예측값은 생성하지 않습니다.</p>
        <div id="sim-forecast-summary"></div>
      </div></fieldset>
      <div class="sim-actions"><button class="sim-primary" id="sim-run" type="submit">시뮬레이션 실행</button><button id="sim-connect" type="button">AI 수요 모델 연결</button><button id="sim-reload" type="button">데이터 새로 읽기</button></div>
      <p id="sim-connection-status" class="sim-status" role="status" aria-live="polite" hidden></p>
      <p class="sim-note">가격 민감도 1배에서 C = E×P + α×D + β×W. 민감도는 E×P 항에 곱합니다. 행동계수는 기존·사용자 가정 또는 종류별 팀 채택 기준입니다. 완속은 여러 연구를 조합한 잠정 대리값입니다. 충북 실측 보정·정확도 우위 검증 전이며 시간대 배수는 적용하지 않습니다.</p>
    </form><div>
      <div class="sim-card"><h3>02 · 비교할 두 충전소</h3><span class="sim-badge" id="sim-source"></span><div id="sim-message" class="sim-status" role="status" aria-live="polite"></div><div id="sim-stations" class="sim-stations"></div></div>
      <details class="sim-card" id="sim-evidence-box"><summary>입력값의 근거 · 실측값 / 추정값 / 가정값</summary><p class="sim-note">실측·수집값은 수집 시각의 기록입니다. 추정값은 계산·대체 단가·대표 출력·외부 예측을 뜻하며 통계 보정을 완료했다는 뜻은 아닙니다. 가정값은 검증 전 시나리오입니다. 공시요금·정책·반복 설정도 별도로 구분합니다.</p><div id="sim-evidence"></div></details>
      <details class="sim-card"><summary>AI 모델 출력 예시와 연결 범위</summary>
        <p>v1은 충전소 ID·급속/완속·예측 이용률(0~1), 모델명, 생성 시각, 예측 대상 시각을 받아 요금 판정에만 적용합니다. ‘AI 수요 모델 연결’은 구간별 이용률·신규 건수를 받는 v2에 연결합니다.</p>
        <p>예: A 이용률 0.8, B 0.2. 이 수치는 형식 설명용이며 실제 예측이 아닙니다. 예시 파일은 example_only=true로 표시하여 실제 모델 출력으로 실행하지 못하게 합니다.</p>
        <button type="button" id="sim-example-output">현재 A/B의 출력 형식 예시 JSON 다운로드</button>
        <p>v2는 제공 모델의 15분 구간 이용률과 예상 충전 시작 건수를 받아 신규 차량을 생성합니다. 실제 도착·대기·포기 차량은 관측하지 않습니다. 충전량과 가격·거리·대기 선호도는 자동 추정하지 않습니다.</p>
        <p><a href="https://github.com/ms3011975/ev-hackathon.github.io/blob/main/docs/simulation-report.md" target="_blank" rel="noopener">팀 공유용 출력 JSON 예시와 분석 리포트 설명</a></p>
      </details>
      <progress id="sim-progress" max="1" value="0" hidden aria-label="시뮬레이션 진행률"></progress>
      <div id="sim-results" aria-live="polite"><div class="sim-card"><h3>03 · 정책 비교</h3><p class="sim-note">기본 예시 조건으로 바로 실행할 수 있습니다. 결과는 실제 수요 분산 실적 또는 배전망 피크 저감 성과가 아닙니다.</p></div></div>
      <section id="sim-load-report" class="sim-card" aria-label="충전 부하 분석 리포트" hidden>
        <p id="sim-load-state" class="sim-note" role="status"></p><div id="sim-load-content"></div>
        <div class="sim-actions"><button type="button" id="sim-report-export">분석 리포트 HTML 다운로드</button><button type="button" id="sim-load-export">부하 시계열 CSV 다운로드</button></div>
      </section>
      <details class="sim-card" id="sim-behavior-panel">
        <summary>04 · 기존 예시값과 팀 채택 기준 비교 (선택)</summary>
        <p>일반 실행은 위에서 선택한 행동계수만 사용합니다. 이 비교를 실행하면 같은 A/B·수요·난수에서 기존 예시값과 팀 기준을 각각 세 요금 정책에 적용해, 계수 묶음에 따라 결과가 달라지는지 확인할 수 있습니다.</p>
        <details id="sim-behavior-reference"><summary>논문 출처와 환산 가정</summary><div id="sim-behavior-reference-content"></div></details>
        <div class="sim-actions"><button type="button" id="sim-behavior-run" class="sim-primary">기존값 · 팀 채택 기준 함께 비교</button><button type="button" id="sim-behavior-cancel" hidden>비교 중단</button></div>
        <p class="sim-status" role="status" id="sim-behavior-status">같은 종류의 충전소 A/B를 선택해 비교하세요.</p>
        <div id="sim-behavior-results"></div>
        <div class="sim-actions"><button type="button" id="sim-behavior-export" disabled>계수 비교 CSV 다운로드</button><button type="button" id="sim-behavior-html" disabled>계수 비교 HTML 리포트</button></div>
      </details>
      <section class="sim-card" id="sim-sweep-panel" aria-label="민감도 분석">
        <h3>05 · 요금 정책과 가정값 민감도 분석</h3>
        <p class="sim-note">할인율 10/20/30%처럼 여러 수준을 비교할 때 사용합니다. 한 분석 안에서 A/B·예측 수요·난수를 공유하고 선택한 항목만 바꿉니다. 현재 기준값은 자동 포함합니다. 일반 실행과는 별도의 선택 기능입니다.</p>
        <fieldset id="sim-sweep-controls" class="sim-fields" style="border:0;padding:0;margin:0;min-width:0">
          <label>비교할 항목<select id="sim-sweep-key">${sweepFields.map(([key,label]) => `<option value="${key}">${label}</option>`).join('')}<option value="durationMode">충전시간 계산 방식</option></select></label>
          <label>비교할 값 (쉼표로 구분)<input type="text" id="sim-sweep-values" value="12,24,36"></label>
          <button id="sim-sweep-preset" type="button">추천 비교값 넣기</button>
          <button id="sim-sweep-run" type="button" class="sim-primary">민감도 분석 실행</button>
        </fieldset>
        <button id="sim-sweep-cancel" type="button" hidden>분석 중단</button>
        <p class="sim-note">팀 정책 비교 수준: 할인 10/20/30%, 할증 0/15/30%, 여유 판정 빈 비율 30/50/70%. 추천 버튼은 정책 항목에 이 값을 넣고 다른 숫자는 현재값의 0.5/1/1.5배를 제안합니다. 비교값은 최대 8개이며 최적값·신뢰구간이 아닙니다. 거리 변경은 양방향 동일 사용자 가정, 시간 방식은 sessions(완료 기록), power(출력 기반), assumed(20~40분)입니다.</p>
        <p class="sim-note">A/B의 접근성·충전기 수·수요 규모·자료 시각을 확인하세요. A·B·동시 A+B 피크와 대기·충전요금·단순 매출을 함께 비교합니다. 할인 적용 건수는 모의 신규 세션 기준이며 전체 지역 할인 대상 충전소 수를 뜻하지 않습니다. 반복 100회·시드 42에서 시작하고 다른 시드에서도 결론을 확인하세요.</p>
        <p id="sim-sweep-status" class="sim-status" role="status" aria-live="polite">항목과 비교값을 확인한 뒤 실행하세요.</p>
        <div id="sim-sweep-results"></div>
      </section>
      <details class="sim-card"><summary>모델 가정과 결과 읽는 방법</summary>
        <p>수동 수요는 기간 내 균등 도착이며 A를 원래 목적지로 둡니다. v2는 충전소·구간별 기대 충전 시작 건수를 평균으로 하는 독립 포아송 건수와 구간 내 균등 도착을 가정합니다. 원래 선택지는 A/B별로 보존하고 다른 충전소로 바꿀 때만 추가 거리를 적용합니다. 이동 소요시간은 따로 더하지 않습니다.</p>
        <p>실제 데이터의 기본 시간은 최근 30일 완료 세션 기록에서 추출합니다. 같은 충전소·종류 5건 이상, 부족하면 같은 지역·종류 5건 이상을 사용하며 모두 부족하면 출력 기반으로 대체합니다. 현재 진행 중 세션의 시작시각은 공개되지 않아 초기 잔여시간은 총시간 길이 비례 표본과 균등 잔여 비율로 추정합니다(정상상태 가정). 수집 초기에는 실제 표본 기간이 짧습니다. 기록에는 비충전 점유가 포함될 수 있습니다. 팀이 2026-11-05 채택한 시간 방식이며, 초기 잔여는 Durrett(2012)의 정상상태 잔여수명 이론에 근거합니다. 임의 시점의 정상상태 적용 가정과 EV 자료의 지역 검증은 구분합니다.</p>
        <p>kWh는 기록에 없어 별도 제주 추정값/사용자 가정을 유지합니다. 기록 시간이 충전량÷대표 출력×60분보다 짧으면 그 최소시간까지 연장하고 표본 수와 결과의 연장 차량 수를 표시합니다. 신규·초기 차량의 등가 전력은 충전량÷보정 총시간으로 계산합니다. 출력 기반 모드의 초기 잔여는 0~총시간, 20~40분 모드의 초기 잔여는 0~30분 균등분포입니다. 충전곡선·효율·출력 공유는 제외합니다.</p>
        <p>판정 분모는 빈 충전기+충전 중이며 고장·미확인 충전기는 처리 능력에서 제외합니다. 수동/v1 요금은 고정하고 v2는 각 도착 구간의 예측 이용률로 요금을 정합니다. 요금표는 시간가중 평균 단가이며 차량은 선택 시 단가를 충전 종료까지 적용합니다. 초기 점유는 수집 상태이며 미래 대기열을 복원하지 않습니다.</p>
        <p>선택 당시 예상 대기는 이미 도착한 차량을 포함한 가장 빠른 충전기 사용 가능 시각으로 계산합니다. 실제 대기는 도착순 FIFO 예약 후 계산합니다. 같은 정보와 변경 없는 대기열을 사용하는 이 모델에서는 두 값이 일치합니다. 기간 내 도착한 모든 신규 차량을 충전 완료까지 집계하며 초기 차량의 요금은 제외합니다.</p>
        <p>결과는 반복 1회당 평균입니다. 평균 대기의 표준오차(SE)는 반복 실험 간 변동이며 실세계 예측 오차가 아닙니다. 총 할인 혜택은 기본 단가 대비 할인액의 합으로 사업자 순손실과 다릅니다. 수입 차이는 정책별 선택 충전소와 단가로 계산한 단순 매출 차이이며 비용을 반영하지 않습니다.</p>
      </details>
    </div></div>`;
  function message(text, error = false) { $('sim-message').textContent = text; $('sim-message').dataset.error = error; }
  function updateEnergy() {
    const speed = $('sim-speed').value, g = sim.energyProfile.bySpeed[speed], automatic = $('sim-energySource').value === 'jeju';
    if (automatic) $('sim-energy').value = g.defaultKwh;
    $('sim-kind-energy').innerHTML = badge(automatic ? '추정값' : '가정값');
    $('sim-energy-note').innerHTML = `${automatic ? `제주 자료 기반 추정값: ${speed === 'fast' ? '급속' : '완속'} ${g.defaultKwh}kWh/건.` : '직접 입력한 충전량을 사용자 가정값으로 적용합니다.'} 2026-11-05 팀이 채택한 제주 기준의 0.5/1/1.5배(${fmt(g.defaultKwh*.5,2)} / ${fmt(g.defaultKwh,2)} / ${fmt(g.defaultKwh*1.5,2)}kWh)는 민감도 시나리오이며 신뢰구간이 아닙니다. ${g.start}~${g.end} 양수 충전 ${g.sessions.toLocaleString('ko-KR')}건 기준. 버스 전용·0kWh·중복 제외. 현재 충북 실측값이 아닙니다. 원본 단위 미기재로 충전요금과 대조해 kWh로 해석했습니다. <a href="${escape(sim.energyProfile.sourceUrl)}" target="_blank" rel="noopener">제주 원본</a> · <a href="https://github.com/ms3011975/ev-hackathon.github.io/blob/main/docs/jeju-energy.md" target="_blank" rel="noopener">계산·단위·제외 기준</a>`;
  }
  function updateBehavior(apply = false) {
    const speed = $('sim-speed').value, select = $('sim-behaviorPreset');
    for (const p of Object.values(sim.behaviorProfiles)) if(p.scope) select.querySelector(`option[value="${p.id}"]`).disabled = p.scope !== speed;
    if(sim.behaviorProfiles[select.value]?.scope && sim.behaviorProfiles[select.value].scope !== speed) {
      select.value=sim.behaviorDefault(speed).id;apply=true;
    }
    const preset = sim.behaviorProfiles[select.value];
    if (apply && preset) for (const key of sim.behaviorKeys) $('sim-'+key).value = preset.values[key];
    const matched=sim.behaviorMatch(options(), { behaviorPreset: select.value, speed }), adoption=sim.behaviorAdoptions[matched], literature=Boolean(adoption);
    for (const key of sim.behaviorKeys) $('sim-kind-'+key).innerHTML = badge(literature ? key === 'sensitivity' ? '실험 설정' : '추정값' : '가정값');
    $('sim-behavior-note').textContent = literature
      ? `${preset.label}: s=${preset.values.sensitivity} 정규화 · α=${preset.values.alpha} · β=${preset.values.beta} · τ=${preset.values.tau}. ${adoption.rationale}. 충북 실측 보정·정확도 우위 검증 전입니다. 충전량·도로 거리 변경 시에도 계수는 고정됩니다. 아래 04에서 출처·환산 가정을 확인하세요.`
      : select.value === 'legacy' ? '비교용 초기 예시값 1/600/300/2000입니다. 현재 종류의 팀 채택 기준과 구분합니다.' : '직접 수정한 네 계수는 사용자 가정값입니다. 문헌 기준 숫자와 같아도 사용자 선택으로 구분합니다.';
    $('sim-behavior-run').disabled = busy || pool.length < 2;
    if (!lastBehavior) $('sim-behavior-status').textContent = `${speed==='slow'?'완속':'급속'} A/B에서 기존 예시값과 ${sim.behaviorDefault(speed).label}을 비교합니다.`;
    $('sim-behavior-reference-content').innerHTML = behaviorReferenceHTML();
  }
  function behaviorReferenceHTML() {
    if($('sim-speed').value==='slow') {
      const b=sim.behaviorReferenceSlow,x=sim.behaviorConversion('slow'),a=sim.behaviorAdoptions.slowLiterature;
      return `<p>완속 잠정 기준: s=1, α=510원/km, β=220원/분, τ=10,000원. s=1은 정규화이며 측정된 가격 민감도가 아닙니다.</p>
        ${['alpha','beta','tau'].map(k=>`<p><a href="${escape(b[k].url)}" target="_blank" rel="noopener">${escape(b[k].title)}</a><br>${escape(b[k].pages)}<br>${escape(b[k].basis)}</p>`).join('')}
        <p>α=15,205÷30=${fmt(x.alpha,2)}원/km<br>β=9.44×1,400÷60=${fmt(x.beta,2)}원/분 (평균 WTP 환산 ${fmt(x.betaMean,2)}원/분과 구분)<br>τ=1,700÷0.169=${fmt(x.tau,2)}원. 1회 요금 계수이므로 충전량을 다시 곱하지 않습니다.</p>
        <p>속도·환율은 고정 환산 가정이며 현재 실측값이 아닙니다. 완속은 서로 다른 연구를 조합한 대리값으로 공동 추정된 계수가 아닙니다. 현재 입력의 kWh당 단가×충전량을 1회 비용으로 계산한 A/B 모형에 근사 이전합니다. 충전량 변경 시 계수는 고정됩니다.</p>
        <p>${a.limitations.map(escape).join('<br>')}</p><p><a href="https://github.com/ms3011975/ev-hackathon.github.io/blob/main/docs/behavior-presets.md" target="_blank" rel="noopener">팀 공유용 채택 근거와 비교 방법</a></p>`;
    }
    const b = sim.behaviorReference, x = sim.behaviorConversion();
    return `<p><a href="${escape(b.url)}" target="_blank" rel="noopener">${escape(b.title)}</a><br>${escape(b.pages)}<br>${escape(b.population)}</p>
      <p>원문 계수: 비용 −0.132 (USD/100마일 충전분), 우회시간 −0.066/분, 대기시간 −0.050/분, 충전거리 탄력성 0.35168.</p>
      <p>환산 가정: 참조 충전량 14.82kWh, 전비 6km/kWh, 1USD=1,400원, 우회속도 30km/h. ${escape(b.income)}. 가격 민감도 1은 원화 비용을 기준으로 한 정규화입니다.</p>
      <p>r=14.82×6÷160.9344=${fmt(x.r,6)}<br>τ=1400×r^(1−0.35168)÷0.132=${fmt(x.tau,2)}원<br>α=0.066×τ×60÷30=${fmt(x.alpha,2)}원/km<br>β=0.050×τ=${fmt(x.beta,2)}원/분</p>
      <p>2026-11-05 팀 채택값은 s=1, α=950, β=360, τ=7200으로 반올림했습니다. 참조 환산을 고정하며 화면 충전량·도로 거리에서 재환산하지 않습니다. ${escape(b.limitation)}</p>
      <p>${sim.behaviorAdoption.limitations.map(escape).join('<br>')}</p><p><a href="https://github.com/ms3011975/ev-hackathon.github.io/blob/main/docs/behavior-presets.md" target="_blank" rel="noopener">팀 공유용 비교 방법과 근거</a></p>`;
  }
  $('sim-behavior-reference-content').innerHTML = behaviorReferenceHTML();
  function selected() { return [$('sim-a').value, $('sim-b').value].map(id => pool.find(s => s.id === id)); }
  function timingKey() { return [$('sim-mode').value,$('sim-region').value,sourceWhen,...selected().map(s=>s?.id+':'+s?.speed)].join('|'); }
  function showTiming() {
    const active=$('sim-durationMode').value==='sessions',ready=sessionState?.key===timingKey();
    const hasFallback=ready && sessionState.plan.stations.some(s=>sessionState.plan.pools[s.pool].level==='power');
    $('sim-kind-duration').innerHTML=badge(active?(hasFallback?'추정·가정 혼합':'추정값'):'가정값');
    $('sim-timing-load').disabled=busy || $('sim-mode').value!=='real';
    if(!active) { $('sim-timing-status').textContent='선택한 가정 시간 모드를 사용합니다. 완료 기록 모드로 바꾸면 신규·초기 차량에 함께 적용합니다.';return; }
    if(!ready) { $('sim-timing-status').textContent='실행 시 완료 기록 자동 조회 · 최근 30일, 충전소 5건 → 같은 지역·종류 5건 → 출력 기반 대체. 초기 잔여시간은 정상상태 추정이며 실측값이 아닙니다.';return; }
    const p=sessionState.plan;
    $('sim-timing-status').innerHTML=p.stations.map((s,i)=>{
      const pool=p.pools[s.pool],a=window.ESSessionTiming.adjusted(pool,+$('sim-energy').value,selected()[i].kw);
      return `<strong>${i?'B':'A'}</strong> · ${pool.level==='station'?'해당 충전소':pool.level==='region'?'지역·같은 종류로 대체':'표본 부족 → 출력 기반 가정'} ${pool.values.length}건<br>기록 평균 ${fmt(pool.mean)}분 → 적용 신규 평균 ${fmt(a.mean)}분 / 초기 잔여 기대 ${fmt(a.meanRemaining)}분<br>충전소 ${s.stationN}건 · 지역 ${s.regionN}건 · 최소 ${fmt(a.minMinutes)}분으로 연장하는 원표본 ${a.clipped}건`;
    }).join('<br><br>')+`<br><br>초기 잔여는 정상상태 추정이며 실측값이 아닙니다. 긴 세션이 점유 중 관측되기 쉬워 잔여 기대가 신규 평균보다 길 수도 있습니다. 기준 ${escape(kst(p.asOf))}. <a href="${escape(p.source.repository)}" target="_blank" rel="noopener">원기록·고정 버전</a>. Durrett(2012) 정상상태 잔여수명 근거·분위수·정제·출처는 ‘입력값의 근거’에서 확인하세요.`;
  }
  async function ensureTiming(required=$('sim-durationMode').value==='sessions') {
    if(!required) return;
    if($('sim-mode').value!=='real') throw new Error('완료 기록 모드는 실제 공공데이터에서 사용하세요.');
    const key=timingKey(),stations=selected().map(s=>({...s}));
    const text=String(sourceWhen).replace(' ','T'),asOf=Date.parse(/(Z|[+-]\d\d:\d\d)$/.test(text)?text:text+'+09:00');
    if(!Number.isFinite(asOf)) throw new Error('완료 기록의 기준으로 사용할 초기 상태 수집 시각이 없습니다. 실제 데이터를 다시 읽으세요.');
    $('sim-timing-status').textContent='최근 완료 세션을 읽고 중복·비정상 기록을 정제하는 중입니다…';
    try {
      const plan=await timingClient.load(stations,$('sim-region').value,asOf);
      if(key!==timingKey()) throw new Error('조회 중 조건이 변경됐습니다. 다시 불러오세요.');
      sessionState={key,plan};showTiming();renderEvidence();
    } catch(e) {
      sessionState=null;
      $('sim-timing-status').textContent=`충전시간 기록 조회 실패: ${e.message} 다시 시도하거나 출력 기반 모드를 직접 선택하세요.`;
      throw e;
    }
  }
  function invalidate() {
    showTiming();
    if (last) $('sim-export').disabled = true;
    for (const id of ['sim-report-export','sim-load-export']) $(id).disabled = true;
    if (last) $('sim-load-state').textContent = '조건이 변경되었습니다. 이전 실행 리포트입니다. 다시 실행하세요.';
    $('sim-results').dataset.stale = 'true';
    if (last) $('sim-result-state').textContent = '조건이 변경되었습니다. 아래는 이전 실행 결과입니다. 다시 실행해 주세요.';
    if (lastSweep) { $('sim-sweep-export').disabled = true; $('sim-sweep-state').textContent = '조건이 변경되었습니다. 아래는 이전 분석 결과입니다. 다시 분석해 주세요.'; }
    if (lastBehavior) {
      $('sim-behavior-export').disabled = true; $('sim-behavior-html').disabled = true;
      $('sim-behavior-status').textContent = '조건이 변경되었습니다. 아래는 이전 행동계수 비교 결과입니다. 다시 비교하세요.';
    }
    renderEvidence();
  }
  function distance() {
    const auto = $('sim-distanceMode').value === 'road'; $('sim-distance').readOnly = auto;
    $('sim-road-reload').disabled = !auto || busy;
    clearTimeout(roadTimer);
    if (!auto) {
      $('sim-kind-distance').innerHTML = badge('가정값');
      $('sim-road-status').textContent = '입력한 거리를 양방향에 동일하게 적용합니다. 지도에서 확인한 도로 거리를 직접 입력할 수 있습니다. 이동시간은 도착 시각에 더하지 않습니다.';
      return;
    }
    let k; try { k=routing.key(selected()); } catch {
      $('sim-distance').value=''; $('sim-kind-distance').innerHTML=badge('미입력');
      $('sim-road-status').textContent='좌표가 있는 서로 다른 충전소 A/B를 선택하면 도로 거리를 조회합니다.'; return;
    }
    if (roadState?.key===k && roadState.status==='ready') return showRoad(roadState.result);
    $('sim-distance').value=''; $('sim-kind-distance').innerHTML=badge('미입력');
    if (roadState?.key===k && roadState.status==='error') { $('sim-road-status').textContent=roadState.error; return; }
    roadState={key:k,status:'pending'};
    $('sim-road-status').textContent='A→B / B→A 자동차 도로 거리를 조회하는 중입니다…';
    roadTimer=setTimeout(()=>lookupRoad().catch(()=>{}),300);
  }
  function showRoad(result) {
    $('sim-distance').value=result.roadDistances[0].toFixed(3);
    $('sim-kind-distance').innerHTML=badge('추정값');
    $('sim-road-status').innerHTML=`도로 거리 A→B <strong>${fmt(result.roadDistances[0],3)}km</strong> / B→A <strong>${fmt(result.roadDistances[1],3)}km</strong>. 경로 이동시간 참고 ${fmt(result.seconds[0]/60,1)} / ${fmt(result.seconds[1]/60,1)}분. 조회 ${escape(kst(result.fetchedAt))}.<br>© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap contributors</a> · <a href="https://routing.openstreetmap.de/about.html" target="_blank" rel="noopener">FOSSGIS OSRM car</a> · <a href="https://www.openstreetmap.org/" target="_blank" rel="noopener">지도 오류 수정</a>.<br>충전소 인근 도로 연결점 기준의 최단시간 경로 거리이며 실시간 교통·GPS 실측값이 아닙니다. 연결점 오차 A ${fmt(result.snapMeters[0])}m / B ${fmt(result.snapMeters[1])}m. 출발지·최종 목적지가 없어 실제 우회거리는 별도 가정이며, 이동시간은 도착 시각에 더하지 않습니다.`;
  }
  async function lookupRoad(force=false) {
    clearTimeout(roadTimer);
    const stations=selected().map(s=>s && ({...s})), k=routing.key(stations);
    const current=()=>{
      try {return $('sim-distanceMode').value==='road' && routing.key(selected())===k;} catch {return false;}
    };
    roadState={key:k,status:'pending'};
    $('sim-road-status').textContent='자동차 도로 경로 조회 중…';
    try {
      const result=await roadClient.get(stations,force);
      if (!current()) throw new Error('거리 조회 중 충전소 선택이 변경됐습니다. 다시 실행하세요.');
      roadState={key:k,status:'ready',result}; showRoad(result); invalidate(); return result;
    } catch(error) {
      if (current()) {
        const msg=`도로 거리 조회 실패: ${error.message} 직선거리로 대체하지 않았습니다. ‘도로 거리 다시 조회’ 또는 ‘사용자 입력 거리’를 선택하세요.`;
        roadState={key:k,status:'error',error:msg}; $('sim-distance').value='';
        $('sim-kind-distance').innerHTML=badge('미입력'); $('sim-road-status').textContent=msg; invalidate();
      }
      throw error;
    }
  }
  async function ensureRoad() {
    if ($('sim-distanceMode').value!=='road') return;
    const k=routing.key(selected());
    if (roadState?.key===k && roadState.status==='ready') return;
    if (roadState?.key===k && roadState.status==='error') throw new Error(roadState.error);
    await lookupRoad();
  }
  function cards() {
    updateBehavior();
    showTiming();
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
  async function load({preserveSelection = false} = {}) {
    const previous = selected().map(s=>s?.id);
    sourceWhen = '';
    const version = ++dataVersion; invalidate();
    $('sim-run').disabled = true; $('sim-reload').disabled = true;
    try {
      const demo = $('sim-mode').value === 'demo', speed = $('sim-speed').value;
      $('sim-durationMode').querySelector('option[value="sessions"]').disabled=demo;
      if(demo && $('sim-durationMode').value==='sessions') $('sim-durationMode').value='power';
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
        sourceWhen = data.when || '';
        const pair = choosePool(data.list.map(s => ({ id: s.id, name: s.name, lat: s.lat, lng: s.lng, speed,
          ...s[speed], unknown: s[speed].total - s[speed].avail - s[speed].charging - s[speed].fault, source: s[speed].src || '기존 운영사 요금표' })));
        message(pool.length < 2 ? '동일 종류의 처리 가능한 충전소가 2곳 미만입니다. 예시 데이터 모드로 전환해 주세요.' : pair ? '같은 종류의 혼잡 A와 좌표상 가까운 여유 B를 선택했습니다. 다른 충전소도 직접 선택할 수 있습니다. 도로 경로 거리는 별도로 조회합니다.' : '혼잡 A·여유 B 조건에 맞는 쌍이 없습니다. 비교 가능한 두 거점을 표시했습니다. 예시 데이터 모드도 사용할 수 있습니다.');
      }
      if (preserveSelection) {
        for (const [i,id] of previous.entries()) if (pool.some(s=>s.id===id)) $('sim-'+(i?'b':'a')).value=id;
        cards();
      }
    } catch (error) {
      if (version === dataVersion) { source = '실제 데이터 없음'; choosePool([]); message(error.message + ' 예시 데이터 모드를 선택하면 데모를 실행할 수 있습니다.', true); }
    } finally { if (version === dataVersion) $('sim-reload').disabled = false; }
  }
  function options(prediction) {
    const o = Object.fromEntries(fields.map(([key]) => [key, +$('sim-' + key).value]));
    for (const k of ['discount', 'surcharge', 'threshold']) o[k] /= 100;
    o.durationMode = $('sim-durationMode').value;
    if(sessionState?.key===timingKey()) o.sessionPlan=sessionState.plan;
    if ($('sim-distanceMode').value==='road') {
      try {if (roadState?.status==='ready' && roadState.key===routing.key(selected())) o.roadDistances=[...roadState.result.roadDistances];} catch { /* incomplete pair shown as missing */ }
    }
    if (prediction?.plan) Object.assign(o,{drivers:prediction.plan.expectedDrivers,minutes:prediction.plan.minutes,forecastPlan:prediction.plan});
    return o;
  }
  function context(prediction) {
    return { source, executedAt: new Date().toISOString(), region: $('sim-mode').value === 'demo' ? '예시 · 지역 무관' : $('sim-region').selectedOptions[0].text,
      mode: $('sim-mode').value, speed: $('sim-speed').value, distanceMode: $('sim-distanceMode').value, energySource: $('sim-energySource').value, behaviorPreset: $('sim-behaviorPreset').value,
      roadRoute: $('sim-distanceMode').value==='road' && roadState?.status==='ready' ? roadState.result : null,
      forecastRequested: $('sim-pricingBasis').value !== 'observed',demandRequested:$('sim-pricingBasis').value==='forecast-v2',
      pricingBasis: $('sim-pricingBasis').value === 'forecast-v2' ? 'v2 구간별 예측 요금·충전 시작 건수 기반 수요' : $('sim-pricingBasis').value === 'forecast' ? 'v1 1시간 후 이용률 (요금에만 적용)' : '현재 수집 상태',
      forecastInfo: prediction ? `${prediction.model} · 생성 ${kst(prediction.generatedAt)} · 대상 ${kst(prediction.targetTime)}` : '',
      forecastInput:forecastOrigin,
      forecastUtilizationA: prediction?.utilizationById[selected()[0]?.id] ?? '', forecastUtilizationB: prediction?.utilizationById[selected()[1]?.id] ?? '' };
  }
  function evidenceTable(rows) {
    return `<p class="sim-note">좁은 화면에서는 표를 좌우로 스크롤해 구분과 근거를 확인하세요.</p><div class="sim-table-wrap"><table class="sim-table sim-evidence-table"><thead><tr><th>항목</th><th>값</th><th>구분</th><th>근거와 한계</th></tr></thead><tbody>${rows.map(r => `<tr><th scope="row">${escape(r.item)}</th><td>${escape(r.value)}</td><td>${badge(r.kind)}</td><td>${escape(r.basis)}</td></tr>`).join('')}</tbody></table></div>`;
  }
  function renderEvidence() {
    if (!$('sim-evidence')) return;
    let p,problem=''; try { if ($('sim-pricingBasis').value !== 'observed') p = readForecast(); } catch(e) { problem=forecastFailure || e.message; }
    syncDemand(p,problem);
    $('sim-evidence').innerHTML = evidenceTable(sim.evidence(selected().filter(Boolean), options(p), context(p)));
  }
  function lock(active) {
    busy = active; $('sim-controls').disabled = active; $('sim-sweep-controls').disabled = active;
    $('sim-run').disabled = active || pool.length < 2; $('sim-reload').disabled = active;
    $('sim-connect').disabled = active;
    $('sim-road-reload').disabled = active || $('sim-distanceMode').value!=='road';
    $('sim-timing-load').disabled = active || $('sim-mode').value!=='real';
    $('sim-behavior-run').disabled = active || pool.length < 2;
    if (!active) $('sim-region').disabled = $('sim-mode').value === 'demo';
  }
  function render(result) {
    const { results, options: o } = result, maxWait = Math.max(1, ...results.map(r => r.wait));
    const maxDiscount = Math.max(1, ...results.map(r => r.discount));
    const bar = (r, value, max, unit) => `<div class="sim-bar-row"><div class="sim-bar-label"><span>${r.label}</span><b>${fmt(value)}${unit}</b></div><div class="sim-track"><div class="sim-fill sim-wait" style="width:${value / max * 100}%"></div></div></div>`;
    $('sim-results').innerHTML = `<div class="sim-card"><h3>03 · 세 정책, 같은 운전자</h3>
      <p class="sim-note" id="sim-result-state">${escape(result.context.source)} · ${escape(result.context.region)} · 가상 시뮬레이션 결과<br>요금 기준: ${escape(result.context.pricingBasis)}<br>행동계수: ${escape(sim.behaviorProfiles[sim.behaviorMatch(o,result.context)]?.label || "사용자 가정값")}<br>${escape(result.context.forecastInfo || '')}<br>반복 ${o.repeats}회 · 신규 ${o.forecastPlan ? `기대 ${fmt(o.drivers,3)}명 / 생성 평균 ${fmt(result.population.mean,3)}명 (${result.population.min}~${result.population.max})` : o.drivers+'명'} · 도착 ${fmt(o.minutes,2)}분 · ${o.energy}kWh · 시드 ${o.seed} · ${o.roadDistances ? `도로 A→B ${fmt(o.roadDistances[0],3)} / B→A ${fmt(o.roadDistances[1],3)}km` : `사용자 거리 ${fmt(o.distance,3)}km`}</p>
      ${o.forecastPlan ? `<p class="sim-note">신규 0명 반복 ${result.population.emptyRuns}/${o.repeats}회. 선택 비율·대기·요금·거리는 전체 생성 차량을 기준으로 집계합니다. 표의 단가는 시간가중 평균이며 각 차량은 도착 구간 단가를 적용합니다. 구간별 단가와 수요는 아래 분석 리포트에 기록합니다.</p>` : ''}
      <div class="sim-table-wrap"><table class="sim-table"><caption>정책별 비교 (반복 1회당 평균)</caption><thead><tr><th>지표</th>${results.map(r => `<th scope="col">${r.label}</th>`).join('')}</tr></thead><tbody>
      ${[
        ['A 적용 단가 (원/kWh)', r => fmt(r.prices[0])], ['B 적용 단가 (원/kWh)', r => fmt(r.prices[1])],
        ['A 선택 (명 / %)', r => `${fmt(r.count[0])} / ${fmt(r.share[0] * 100)}%`], ['B 선택 (명 / %)', r => `${fmt(r.count[1])} / ${fmt(r.share[1] * 100)}%`],
        ['전체 평균 실제 대기 (분)', r => fmt(r.wait, 2)], ['선택 당시 예상 대기 (분)', r => fmt(r.expectedWait, 2)], ['평균 대기 표준오차 (분)', r => fmt(r.waitSE, 2)],
        ['고정 대비 대기 변화 (%)', r => r.waitChange === null ? '산정 불가 (기준 0분)' : fmt(r.waitChange)], ['평균 충전요금 (원/명)', r => fmt(r.fee)],
        ['평균 추가 거리 (km/명)', r => fmt(r.distance, 3)], ['총 할인 혜택 (원)', r => fmt(r.discount)], ['요금 수입 (원)', r => fmt(r.revenue)],
        ['고정 대비 수입 차이 (원)', r => fmt(r.revenueChange)], ['할인 적용 신규 세션 (건/회)', r => fmt(r.discountedCount)], ['할증 적용 신규 세션 (건/회)', r => fmt(r.surchargedCount)], ['마지막 충전 완료 (시작 후 분)', r => fmt(r.completion)]
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
      ['정책', 'A단가_원kWh', 'B단가_원kWh', 'A선택_명', 'B선택_명', 'A비율', 'B비율', '실제대기_분', '예상대기_분', '대기표준오차_분', '고정대비대기변화_pct', '평균요금_원', '평균추가거리_km', '총할인혜택_원', '수입_원', '고정대비수입차이_원', '마지막완료_분','할인적용_건','할증적용_건'],
      ...results.map(r => [r.label, ...r.prices, ...r.count, ...r.share, r.wait, r.expectedWait, r.waitSE, r.waitChange, r.fee, r.distance, r.discount, r.revenue, r.revenueChange, r.completion,r.discountedCount,r.surchargedCount])];
    downloadRows(`essential-simulation-${o.seed}.csv`, rows);
  }
  function downloadRows(filename, rows) {
    const cell = value => { const text = value!==null && typeof value==='object' ? JSON.stringify(value) : String(value ?? ''); return '"' + (/^[=+@-]/.test(text) && !Number.isFinite(Number(text)) ? "'" : '') + text.replace(/"/g, '""') + '"'; };
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
  const levelLabel = (key, value) => key === 'durationMode' ? value === 'sessions' ? '완료 기록 기반' : value === 'power' ? '출력 기반' : '20~40분 가정' : fmt(policiesFields.has(key) ? value * 100 : value, 3).replace(/\.?0+$/, '');
  function presetSweep() {
    invalidateSweep();
    const key = $('sim-sweep-key').value;
    if(sim.policyComparisons[key]) { $('sim-sweep-values').value=sim.policyComparisons[key].map(v=>Number((v*100).toFixed(3))).join(',');return; }
    if (key === 'durationMode') { $('sim-sweep-values').value = $('sim-mode').value==='real' ? 'sessions,power' : 'assumed,power'; return; }
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
      <div class="sim-table-wrap"><table class="sim-table"><caption>한 항목씩 변경 · 반복 1회당 평균</caption><thead><tr><th>${escape(label)}</th><th>정책</th><th>A / B 선택 (명)</th><th>B 비율 (%)</th><th>대기 (분)</th><th>현재값 대비 대기 차이 (분)</th><th>현재값 대비 B 비율 차이 (%p)</th><th>고정요금 대비 대기 (%)</th><th>요금 (원/명)</th><th>추가 거리 (km/명)</th><th>총 할인 (원)</th><th>수입 차이 (원)</th><th>할인 / 할증 적용 (건/회)</th><th>수입 (원)</th></tr></thead><tbody>
      ${output.scenarios.map(s => s.results.map(r => `<tr><th scope="row">${escape(levelLabel(output.key,s.value))}${s.value === output.baseline ? ' · 현재값' : ''}</th><td>${r.label}</td><td>${fmt(r.count[0])} / ${fmt(r.count[1])}</td><td>${fmt(r.share[1]*100)}</td><td>${fmt(r.wait,2)}</td><td>${fmt(r.waitDelta,2)}</td><td>${fmt(r.shareBDelta,2)}</td><td>${r.waitChange === null ? '기준 0분' : fmt(r.waitChange)}</td><td>${fmt(r.fee)}</td><td>${fmt(r.distance,3)}</td><td>${fmt(r.discount)}</td><td>${fmt(r.revenueChange)}</td><td>${fmt(r.discountedCount)} / ${fmt(r.surchargedCount)}</td><td>${fmt(r.revenue)}</td></tr>`).join('')).join('')}</tbody></table></div>
      <div class="sim-table-wrap"><table class="sim-table"><caption>부하 민감도 · 15분 평균 부하의 반복별 피크 평균</caption><thead><tr><th>${escape(label)}</th><th>정책</th><th>A 피크 (kW)</th><th>B 피크 (kW)</th><th>합산 피크 (kW)</th><th>고정 대비 합산 저감률 (%)</th><th>기간 이후 충전량 (kWh)</th></tr></thead><tbody>${output.scenarios.map(s=>s.results.map(r=>`<tr><th>${escape(levelLabel(output.key,s.value))}</th><td>${r.label}</td><td>${fmt(r.load.stationPeakKw?.[0])}</td><td>${fmt(r.load.stationPeakKw?.[1])}</td><td>${fmt(r.load.combinedPeakKw)}</td><td>${fmt(r.load.combinedPeakReductionPct)}</td><td>${fmt(r.load.tailEnergyKwh)}</td></tr>`).join('')).join('')}</tbody></table></div>
      <p class="sim-note">저감률은 해당 수준의 고정요금 대비이며 양수는 감소, 음수는 증가입니다. 20~40분 가정의 등가 전력은 대표 출력을 넘을 수 있습니다. 부하 해석에는 출력 기반 모드를 권장합니다. 위 정책 순위 안내는 피크가 아닌 대기시간 기준입니다.</p>
      <div class="sim-charts">${sim.policies.map((label,p) => `<div><h4>${label} · 평균 대기</h4>${output.scenarios.map(s => `<div class="sim-bar-row"><div class="sim-bar-label"><span>${escape(levelLabel(output.key,s.value))}${s.value === output.baseline ? ' (현재값)' : ''}</span><b>${fmt(s.results[p].wait,2)}분</b></div><div class="sim-track"><div class="sim-fill sim-wait" style="width:${s.results[p].wait/maxWait*100}%"></div></div></div>`).join('')}</div>`).join('')}</div>
      <p class="sim-note">각 수준의 ‘고정요금 대비’는 그 수준의 고정요금 정책과 비교합니다. ‘현재값 대비’는 현재 기준값에서의 같은 정책과 비교합니다. 초기 점유와 난수를 공유하되 충전시간 방식·충전량을 바꾸면 잔여시간도 해당 규칙으로 재계산합니다. 인원 변경 시 기존 운전자를 보존하고 추가 인원만 별도 난수로 생성합니다. 상호작용·실세계 예측오차는 분석하지 않습니다.</p>
      <details><summary>이 분석의 기준 입력 근거</summary>${evidenceTable(output.evidence)}</details>
      <div class="sim-actions"><button type="button" id="sim-sweep-export">민감도 분석 CSV 다운로드</button></div>`;
    $('sim-sweep-export').addEventListener('click', exportSweep);
  }
  function exportSweep() {
    if (!lastSweep || $('sim-sweep-export').disabled) return;
    const s = lastSweep;
    const rows = [['분석','한 항목씩 변경하는 시나리오 민감도 분석'],['비교 항목',sweepLabel(s.key)],['현재 기준값',s.baseline],
      ...Object.entries(s.context), ...Object.entries(s.base), [], ['기준 입력 근거','값','구분','근거와 한계'], ...s.evidence.map(r=>[r.item,r.value,r.kind,r.basis]), [],
      ['수준_내부단위','수준_화면단위','현재값여부','정책','A선택_명','B선택_명','B비율_pct','평균대기_분','대기SE_분','현재값대비대기차이_분','현재값대비B비율차이_pp','고정대비대기변화_pct','평균요금_원','평균거리_km','총할인_원','수입_원','고정대비수입차이_원','A단가','B단가','할인적용_건','할증적용_건'],
      ...s.scenarios.flatMap(level=>level.results.map(r=>[level.value,levelLabel(s.key,level.value),level.value===s.baseline,r.label,...r.count,r.share[1]*100,r.wait,r.waitSE,r.waitDelta,r.shareBDelta,r.waitChange,r.fee,r.distance,r.discount,r.revenue,r.revenueChange,...r.prices,r.discountedCount,r.surchargedCount]))];
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
      const prediction = await preparePrediction(); await ensureRoad(); await ensureTiming($('sim-durationMode').value==='sessions' || (key==='durationMode' && values.includes('sessions')));
      const capturedContext = context(prediction), capturedOptions = options(prediction);
      const currentStations = selected().map(s=>({...s}));
      if (lastSweep) $('sim-sweep-export').disabled = true;
      const output = await sim.sweep(currentStations, capturedOptions, key, values, p => { $('sim-sweep-status').textContent = `민감도 분석 중… ${Math.round(p*100)}%`; }, prediction?.utilizationById, () => cancelSweep);
      output.context = capturedContext; output.evidence = sim.evidence(currentStations,capturedOptions,capturedContext);
      for (const level of output.scenarios) level.evidence = sim.evidence(currentStations,level.options,{...capturedContext,distanceMode:key === 'distance' && level.value !== output.baseline ? 'manual' : capturedContext.distanceMode,energySource:key === 'energy' && level.value !== output.baseline ? 'manual' : capturedContext.energySource});
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
      const prediction = await preparePrediction(); await ensureRoad(); await ensureTiming();
      const result = await sim.compare(selected(), options(prediction), p => { $('sim-progress').value = p; }, prediction?.utilizationById);
      result.context = context(prediction);
      result.evidence = sim.evidence(result.stations, result.options, result.context);
      last = result; render(result); message('계산 완료. 아래 결과는 가상 운전자 모의실험이며 실제 관측 성과가 아닙니다.');
    } catch (error) { message(error.message, true); }
    finally { lock(false); $('sim-progress').hidden = true; }
  });
  $('sim-form').addEventListener('input', invalidate);
  $('sim-behaviorPreset').addEventListener('change', ()=>{updateBehavior(true);invalidate();});
  for (const key of sim.behaviorKeys) $('sim-'+key).addEventListener('input', ()=>{$('sim-behaviorPreset').value='custom';updateBehavior();invalidate();});
  $('sim-behavior-run').addEventListener('click', async () => {
    if (busy || !$('sim-form').reportValidity()) return;
    cancelBehavior = false; lock(true); $('sim-behavior-cancel').hidden = false;
    $('sim-behavior-export').disabled = true; $('sim-behavior-html').disabled = true;
    try {
      $('sim-behavior-status').textContent = '예측과 충전소 상태를 한 번 읽어 두 설정에 공유합니다…';
      const prediction = await preparePrediction(); await ensureRoad(); await ensureTiming(); const capturedContext = context(prediction);
      const output = await sim.compareBehavior(selected(), options(prediction), p => {$('sim-behavior-status').textContent=`행동계수 비교 중… ${Math.round(p*100)}%`;}, prediction?.utilizationById, ()=>cancelBehavior);
      output.context = {...capturedContext,behaviorPreset:'legacy vs '+sim.behaviorDefault(capturedContext.speed).id};
      for (const p of output.profiles) {
        p.context = {...capturedContext,behaviorPreset:p.id};
        p.evidence = sim.evidence(p.stations,p.options,p.context);
      }
      lastBehavior = output;
      $('sim-behavior-results').innerHTML = window.ESSReport.behaviorRender(output);
      $('sim-behavior-export').disabled = false; $('sim-behavior-html').disabled = false;
      $('sim-behavior-status').textContent = '완료 · 동일 예측·차량으로 2개 행동계수 설정 × 3개 요금 정책을 비교했습니다.';
    } catch(error) { $('sim-behavior-status').textContent = error.message; }
    finally { lock(false); $('sim-behavior-cancel').hidden = true; }
  });
  $('sim-behavior-cancel').addEventListener('click', ()=>{cancelBehavior=true;$('sim-behavior-status').textContent='비교 중단 요청을 처리하고 있습니다…';});
  $('sim-behavior-export').addEventListener('click', ()=>{if(lastBehavior && !$('sim-behavior-export').disabled) downloadRows(`essential-behavior-${lastBehavior.base.seed}.csv`,window.ESSReport.behaviorCSV(lastBehavior));});
  $('sim-behavior-html').addEventListener('click', ()=>{if(lastBehavior && !$('sim-behavior-html').disabled) downloadFile(`essential-behavior-${lastBehavior.base.seed}.html`,window.ESSReport.behaviorHtml(lastBehavior),'text/html;charset=utf-8');});
  function readForecast() {
    const stations = selected();
    if (stations.some(s => !s)) throw new Error('먼저 충전소 A/B를 선택하세요.');
    if(!$('sim-forecast-json').value.trim()) throw new Error('AI 예측 연결 필요: ‘AI 수요 모델 연결’ 또는 ‘URL에서 예측 불러오기’를 누르세요.');
    let payload;
    try { payload = JSON.parse($('sim-forecast-json').value); } catch { throw new Error('예측 JSON 형식을 확인하세요.'); }
    if ($('sim-pricingBasis').value === 'forecast-v2') {
      if ($('sim-mode').value !== 'real') throw new Error('v2는 실제 공공데이터 모드의 충전소를 선택하세요.');
      const kst = String(sourceWhen).replace(' ','T');
      const observedAt = Date.parse(/(Z|[+-]\d\d:\d\d)$/.test(kst) ? kst : kst+'+09:00');
      return sim.forecastV2(payload,stations,{observedAt});
    }
    return sim.forecast(payload, stations);
  }
  function syncDemand(prediction,problem='') {
    const derived = $('sim-pricingBasis').value === 'forecast-v2';
    if (derived && !manualDemand) manualDemand = {drivers:$('sim-drivers').value,minutes:$('sim-minutes').value};
    for (const key of ['drivers','minutes']) {
      const input=$('sim-'+key); input.readOnly=derived;
      input.min=derived?'0':'1'; input.step=derived?'any':'1';
      input.required=!derived;
      input.placeholder=derived?'AI 예측 연결 필요':'';
      input.setAttribute('aria-invalid',String(derived && !prediction?.plan && !forecastLoading));
      $('sim-kind-'+key).innerHTML=badge(derived ? prediction?.plan ? '추정값' : forecastLoading ? '불러오는 중' : 'AI 예측 확인 필요' : '가정값');
      if (derived && prediction?.plan) input.value=(key==='drivers'?prediction.plan.expectedDrivers:prediction.plan.minutes).toFixed(3);
      else if(derived) input.value='';
      else if (!derived && manualDemand) input.value=manualDemand[key];
    }
    if (!derived) manualDemand=null;
    const panel=$('sim-connection-status'), requested=$('sim-pricingBasis').value!=='observed';
    panel.hidden=!requested;panel.dataset.error=String(requested && !prediction && !forecastLoading);
    if(requested){
      let generated='';try{const p=JSON.parse($('sim-forecast-json').value);if(p.generated_at)generated=` 수신한 예측 생성 시각: ${kst(p.generated_at)}.`;}catch{/* no payload yet */}
      const text=forecastLoading?'AI 예측과 상태를 확인하는 중입니다…':prediction?`AI 예측 검증 완료.${generated}${derived?' 신규 인원·기간은 자동 추정값입니다.':' v1은 요금에만 적용하며 인원·기간은 수동입니다.'}`:
        `${problem || 'AI 예측 연결 필요.'}${generated} ${derived?'신규 인원·기간은 비워 두었습니다. 이전 숫자로 실행하지 않습니다. ':''}최신 자료 갱신 후 재연결하거나 ‘현재 수집 상태 + 수동 수요’로 바꾸어 가정 실험을 하세요.`;
      panel.textContent=text;
      if(!prediction){$('sim-forecast-status').textContent=text;$('sim-forecast-summary').innerHTML='';}
    }
    $('sim-distance').parentElement.firstChild.textContent='A→B 차량 이동거리 (km)';
    $('sim-distanceMode').options[0].textContent='자동차 도로 이동거리 · 방향별 자동 조회';
    $('sim-distanceMode').options[1].textContent='사용자 입력 거리 · 양방향 동일 가정';
    for (const option of $('sim-sweep-key').options) if (['drivers','minutes'].includes(option.value)) option.disabled=derived;
    if (derived && ['drivers','minutes'].includes($('sim-sweep-key').value)) { $('sim-sweep-key').value='discount'; presetSweep(); }
  }
  function showForecast(prediction) {
    syncDemand(prediction);
    const plan=prediction.plan;
    $('sim-forecast-status').textContent=`검증 완료 · ${prediction.model} · 생성 ${kst(prediction.generatedAt)} · 대상 ${kst(prediction.targetTime)}`;
    if (!plan) { $('sim-forecast-summary').innerHTML='<p class="sim-note">v1 이용률은 요금에만 반영합니다. 신규 인원·기간은 수동 설정입니다.</p>'; return; }
    const time=value=>new Date(value).toLocaleTimeString('ko-KR',{timeZone:'Asia/Seoul',hour:'2-digit',minute:'2-digit'});
    $('sim-forecast-summary').innerHTML=`<p class="sim-note">실행 시각부터 남은 ${fmt(plan.minutes,2)}분 · 기대 신규 ${fmt(plan.expectedDrivers,3)}건. 실제 도착 인원 실측이 아닌 충전 시작 건수 추정으로, 반복마다 포아송 차량을 생성합니다. 지난 구간은 제외하고 일부 구간은 남은 시간 비율로 조정합니다. 요금은 각 구간의 이용률에 적용합니다.</p>
      <div class="sim-table-wrap"><table class="sim-table"><thead><tr><th>한국 시각</th><th>A 기대 건수</th><th>B 기대 건수</th><th>A / B 이용률</th></tr></thead><tbody>${plan.intervals.map(b=>`<tr><td>${time(b.startAt)}~${time(b.endAt)}${b.partial?' 일부':''}</td><td>${fmt(b.expected[0],3)}</td><td>${fmt(b.expected[1],3)}</td><td>${fmt(b.utilization[0]*100)} / ${fmt(b.utilization[1]*100)}%</td></tr>`).join('')}</tbody></table></div>
      <p class="sim-note">초기 상태 수집: ${escape(kst(plan.observedAt))}. kWh·행동계수는 AI 모델에 없어 화면에서 선택한 별도 추정값 또는 사용자 가정을 유지합니다. 완료 기록 모드를 선택하면 별도로 조회한 원기록 분포를 충전시간에 적용하며, 아래에서 표본과 대체 여부를 확인할 수 있습니다.</p>`;
  }
  function checkForecast() {
    forecastFailure='';
    invalidate();
    try {
      const p = readForecast();
      showForecast(p);
    } catch (error) { syncDemand(undefined,error.message); }
  }
  function changeBasis() {
    forecastFailure='';
    forecastRequest++; $('sim-forecast-json').value=''; forecastOrigin='';
    $('sim-forecast-url').value=forecastURLs[$('sim-pricingBasis').value] || forecastURLs.forecast;
    $('sim-forecast-latest').checked=true;
    invalidate(); $('sim-forecast-panel').hidden = $('sim-pricingBasis').value === 'observed';
    if (!$('sim-forecast-panel').hidden) checkForecast();
  }
  $('sim-pricingBasis').addEventListener('change', changeBasis);
  $('sim-forecast-json').addEventListener('input', ()=>{forecastRequest++;forecastOrigin='붙여넣기 JSON';$('sim-forecast-latest').checked=false;checkForecast();});
  $('sim-forecast-url').addEventListener('input', ()=>{forecastRequest++;$('sim-forecast-json').value='';checkForecast();});
  $('sim-forecast-file').addEventListener('change', async event => {
    const file = event.target.files[0]; if (!file) return;
    if (file.size > 10485760) { $('sim-forecast-status').textContent = '10MB 이하 JSON 파일을 선택하세요.'; return; }
    forecastRequest++; forecastOrigin='업로드 JSON'; $('sim-forecast-latest').checked=false;
    $('sim-forecast-json').value = await file.text(); checkForecast();
  });
  async function fetchForecast() {
    const request=++forecastRequest, basis=$('sim-pricingBasis').value;
    const button = $('sim-forecast-fetch'); button.disabled = true;forecastLoading=true;forecastFailure='';
    // Clear previous input so a failed fetch cannot silently reuse another forecast.
    $('sim-forecast-json').value = ''; forecastOrigin=''; invalidate();
    $('sim-forecast-status').textContent = '예측 JSON을 읽는 중입니다…';
    try {
      const url = new URL($('sim-forecast-url').value, location.href);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('인증정보·쿼리·해시 없는 HTTP(S) JSON URL을 사용하세요.');
      const response = await fetch(url, { cache: 'no-store', credentials: 'omit', signal: AbortSignal.timeout(20000) });
      if (!response.ok) throw new Error(`예측 파일 응답 ${response.status}`);
      const body = await response.text();
      if (body.length > 10485760) throw new Error('10MB 이하 JSON만 사용할 수 있습니다.');
      if (request!==forecastRequest || basis!==$('sim-pricingBasis').value) throw new Error('불러오는 동안 설정이 변경됐습니다. 다시 읽으세요.');
      $('sim-forecast-json').value = body;
      forecastOrigin='URL '+url.href;
      const prediction=readForecast(); showForecast(prediction); renderEvidence(); return prediction;
    } catch (error) { forecastFailure=error.message; $('sim-forecast-status').textContent = error.message; throw error; }
    finally { forecastLoading=false;button.disabled = false;renderEvidence(); }
  }
  $('sim-forecast-fetch').addEventListener('click', async () => {try {await fetchForecast();} catch { /* status already shown */ }});
  async function preparePrediction() {
    const basis=$('sim-pricingBasis').value;
    if (basis==='observed') return null;
    if ($('sim-forecast-latest').checked) {
      if (basis==='forecast-v2') {
        const ids=selected().map(s=>s?.id).join('|');
        await load({preserveSelection:true}); lock(true);
        if (ids!==selected().map(s=>s?.id).join('|')) throw new Error('수집 상태가 바뀌어 선택 충전소가 달라졌습니다. A/B를 확인하고 다시 실행하세요.');
      }
      await fetchForecast();
    }
    const prediction=readForecast(); showForecast(prediction); return prediction;
  }
  $('sim-connect').addEventListener('click', async () => {
    if (busy) return;
    const preserve=$('sim-mode').value==='real';
    lock(true);forecastLoading=true;forecastFailure='';
    try {
      $('sim-mode').value='real'; $('sim-pricingBasis').value='forecast-v2'; changeBasis();
      await load({preserveSelection:preserve}); lock(true);
      await fetchForecast(); message('AI 수요 모델 연결 완료. 구간별 기대 건수와 가정값을 확인한 뒤 시뮬레이션을 실행하세요.');
    } catch(error) {forecastFailure=error.message;message(error.message,true);} finally {forecastLoading=false;renderEvidence();lock(false);}
  });
  $('sim-form').addEventListener('change', invalidate);
  $('sim-energySource').addEventListener('change', ()=>{updateEnergy();invalidate();});
  $('sim-energy').addEventListener('input', ()=>{$('sim-energySource').value='manual';updateEnergy();invalidate();});
  $('sim-durationMode').addEventListener('change',()=>{showTiming();invalidate();});
  $('sim-timing-load').addEventListener('click',async()=>{if(busy)return;lock(true);invalidate();try{await ensureTiming(true);}catch(e){message(e.message,true);}finally{lock(false);}});
  $('sim-mode').addEventListener('change',()=>{if($('sim-mode').value==='real')$('sim-durationMode').value='sessions';});
  for (const id of ['mode', 'region', 'speed']) $('sim-' + id).addEventListener('change', ()=>{updateEnergy();load();});
  for (const id of ['a', 'b', 'distanceMode', 'threshold']) $('sim-' + id).addEventListener('change', ()=>{cards();if ($('sim-pricingBasis').value!=='observed') checkForecast();});
  $('sim-reload').addEventListener('click', load);
  $('sim-road-reload').addEventListener('click', async()=>{if(busy) return; invalidate(); try {await lookupRoad(true);} catch { /* route status has the error */ }});
  for (const [id, active] of [['tab-monitor', false], ['tab-simulation', true]]) $(id).addEventListener('click', () => {
    $('monitor-view').hidden = active; $('simulation-view').hidden = !active;
    $('tab-monitor').setAttribute('aria-pressed', String(!active)); $('tab-simulation').setAttribute('aria-pressed', String(active));
    $('regions').hidden = active;
    if (!active) window.ESSMonitor?.resize();
  });
  if (location.hash === '#simulation') $('tab-simulation').click();
  updateEnergy(); updateBehavior(true); load();
})();
