/* Browser + Node pure simulation engine. No network, credentials, or UI dependencies. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ESSimulation = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const policies = ['고정요금', '할인·할증', '할인 전용'];
  const defaults = { drivers: 24, minutes: 60, energy: 30, discount: .2, surcharge: .15,
    alpha: 600, beta: 300, tau: 2000, sensitivity: 1, repeats: 100, seed: 42,
    distance: 2, threshold: .5, durationMode: 'power' };
  const demo = () => [
    { id: 'DEMO-A', name: '예시 A · 혼잡 거점', lat: 36.6424, lng: 127.489, avail: 0, charging: 4, fault: 0, base: 347.2, kw: 60, speed: 'fast', source: '예시 단가' },
    { id: 'DEMO-B', name: '예시 B · 여유 거점', lat: 36.6604, lng: 127.489, avail: 3, charging: 1, fault: 0, base: 347.2, kw: 60, speed: 'fast', source: '예시 단가' }
  ];
  function rng(seed) {
    let a = seed >>> 0;
    return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ t >>> 15, t | 1);
      t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  }
  function status(s, threshold = .5) {
    const usable = s.avail + s.charging;
    return !usable ? (s.fault ? '불가' : '미확인') : s.avail / usable >= threshold ? '여유' : s.avail > 0 ? '보통' : '혼잡';
  }
  function forecast(payload, stations, now = Date.now()) {
    if (payload?.example_only) throw new Error('형식 설명용 예시는 실제 모델 예측으로 실행할 수 없습니다. 실제 출력으로 교체하세요.');
    if (!payload || payload.schema_version !== 1 || typeof payload.model_name !== 'string' || !payload.model_name.trim() || !Array.isArray(payload.predictions))
      throw new Error('예측 JSON의 schema_version(1), model_name, predictions를 확인하세요.');
    const timestamp = value => typeof value === 'string' && /(Z|[+-]\d\d:\d\d)$/.test(value) ? Date.parse(value) : NaN;
    const generated = timestamp(payload.generated_at), target = timestamp(payload.target_time);
    if (!Number.isFinite(generated) || !Number.isFinite(target) || generated > now + 300000 || target <= generated || target <= now)
      throw new Error('예측 생성·대상 시각을 확인하세요. 시간대가 필요하며, 지난 대상 시각은 사용할 수 없습니다.');
    const entries = new Map();
    for (const row of payload.predictions) {
      if (!row || typeof row.station_id !== 'string' || !['fast', 'slow'].includes(row.speed) || !Number.isFinite(row.utilization) || row.utilization < 0 || row.utilization > 1)
        throw new Error('예측에는 station_id, speed(fast/slow), utilization(0~1)이 필요합니다.');
      const key = row.station_id + ':' + row.speed;
      if (entries.has(key)) throw new Error('중복된 충전소·종류 예측이 있습니다.');
      entries.set(key, row.utilization);
    }
    const utilizationById = Object.create(null);
    for (const s of stations) {
      const key = s.id + ':' + s.speed;
      if (!entries.has(key)) throw new Error(`${s.id} (${s.speed})의 예측값이 없습니다. A/B 모두 필요합니다.`);
      utilizationById[s.id] = entries.get(key);
    }
    return { utilizationById, model: payload.model_name, generatedAt: payload.generated_at, targetTime: payload.target_time };
  }
  // Optional utilizationById contains externally supplied future utilization [0,1]. Never generated here.
  function price(s, policy, o, utilizationById) {
    let state = status(s, o.threshold);
    if (utilizationById && Object.hasOwn(utilizationById, s.id)) {
      const u = utilizationById[s.id];
      if (!Number.isFinite(u) || u < 0 || u > 1) throw new Error('예측 이용률은 0~1이어야 합니다.');
      state = 1 - u >= o.threshold ? '여유' : u < 1 ? '보통' : '혼잡';
    }
    const mult = !policy ? 1 : state === '여유' ? 1 - o.discount : state === '혼잡' && policy === 1 ? 1 + o.surcharge : 1;
    return Math.round(s.base * mult * 10) / 10;
  }
  function probability(costs, tau) {
    const finite = costs.filter(Number.isFinite);
    if (!finite.length) throw new Error('처리 가능한 충전기가 없습니다.');
    const min = Math.min(...finite), weights = costs.map(c => Number.isFinite(c) ? Math.exp(-(c - min) / tau) : 0);
    const sum = weights.reduce((a, b) => a + b, 0);
    return weights.map(w => w / sum);
  }
  function validate(stations, o) {
    const ranges = { drivers: [1, 500, true], minutes: [1, 1440], energy: [.1, 200], discount: [0, 1], surcharge: [0, 1],
      alpha: [0, 100000], beta: [0, 100000], tau: [1, 100000], sensitivity: [0, 10], repeats: [1, 500, true],
      seed: [0, 4294967295, true], distance: [0, 200], threshold: [.1, .9] };
    for (const [key, [lo, hi, integer]] of Object.entries(ranges)) {
      if (!Number.isFinite(o[key]) || o[key] < lo || o[key] > hi || (integer && !Number.isInteger(o[key])))
        throw new Error(`${key}: ${lo}~${hi}${integer ? ' 정수' : ''} 값을 입력하세요.`);
    }
    if (!['assumed', 'power'].includes(o.durationMode)) throw new Error('충전시간 계산 방식을 확인하세요.');
    if (stations.length !== 2 || stations[0].id === stations[1].id || stations[0].speed !== stations[1].speed)
      throw new Error('서로 다른 같은 종류의 충전소 A/B를 선택하세요.');
    for (const s of stations) {
      if (!['fast', 'slow'].includes(s.speed)) throw new Error('급속 또는 완속만 비교할 수 있습니다.');
      for (const k of ['avail', 'charging', 'fault']) if (!Number.isInteger(s[k]) || s[k] < 0 || s[k] > 1000) throw new Error('충전기 대수를 확인하세요.');
      if (!(s.base > 0) || !Number.isFinite(s.base) || !(s.kw > 0) || !Number.isFinite(s.kw)) throw new Error('기본 단가와 출력을 확인하세요.');
    }
    if (!stations.some(s => s.avail + s.charging > 0)) throw new Error('두 충전소 모두 처리 가능한 충전기가 없습니다.');
  }
  function population(stations, o, random) {
    // Fixed random consumption, independent of policy and choices.
    const initial = stations.map(s => Array.from({ length: s.charging }, () => random()));
    const drivers = Array.from({ length: o.drivers }, (_, id) => ({ id, arrival: random() * o.minutes, duration: 20 + random() * 20, choice: random() }))
      .sort((a, b) => a.arrival - b.arrival || a.id - b.id);
    return { initial, drivers };
  }
  const duration = (s, o, assumed) => o.durationMode === 'power' ? o.energy / s.kw * 60 : assumed;
  // Energy-conserving constant equivalent power, not measured grid demand.
  // Initial sessions use representative output because their remaining energy is unknown.
  function loadProfile(stations, o, initial, records) {
    const intervalMinutes = 15, events = [];
    initial.forEach((remaining, station) => remaining.forEach(end => {
      if (end > 0) events.push({ station, start: 0, end, kw: stations[station].kw, initial: true });
    }));
    let overRatedSessions = 0;
    for (const r of records) {
      const kw = o.energy * 60 / (r.end - r.start);
      if (kw > stations[r.station].kw * (1 + 1e-9)) overRatedSessions++;
      events.push({ station: r.station, start: r.start, end: r.end, kw, initial: false });
    }
    const lastCompletionMinutes = Math.max(0, ...events.map(e => e.end));
    const completion = Math.max(o.minutes, lastCompletionMinutes);
    const bins = Math.max(1, Math.ceil(completion / intervalMinutes));
    if (bins > 20000) return { available: false, reason: '완료까지의 기간이 길어 부하 집계 한도를 초과했습니다. 충전 출력과 수요 규모를 확인하세요.' };
    const energy = [new Float64Array(bins), new Float64Array(bins)];
    const changes = [new Float64Array(bins + 1), new Float64Array(bins + 1)];
    const capacityKw = stations.map(s => (s.avail + s.charging) * s.kw);
    const windowEnergy = [0, 0], stationEnergyKwh = [0, 0];
    let initialEnergyKwh = 0, tailEnergyKwh = 0;
    for (const e of events) {
      const total = (e.end - e.start) * e.kw / 60;
      stationEnergyKwh[e.station] += total;
      if (e.initial) initialEnergyKwh += total;
      const within = Math.max(0, Math.min(e.end, o.minutes) - e.start) * e.kw / 60;
      windowEnergy[e.station] += within;
      tailEnergyKwh += total - within;
      const first = Math.floor(e.start / intervalMinutes), last = Math.floor(e.end / intervalMinutes);
      if (first === last) energy[e.station][first] += total;
      else {
        energy[e.station][first] += ((first + 1) * intervalMinutes - e.start) * e.kw / 60;
        if (last < bins) energy[e.station][last] += (e.end - last * intervalMinutes) * e.kw / 60;
        changes[e.station][first + 1] += e.kw;
        changes[e.station][last] -= e.kw;
      }
    }
    const series = [], stationPeakKw = [0, 0], active = [0, 0];
    let combinedPeakKw = 0;
    for (let b = 0; b < bins; b++) {
      const kw = energy.map((a, i) => {
        active[i] += changes[i][b];
        return Math.max(0, a[b] * 60 / intervalMinutes + active[i]);
      });
      for (let i = 0; i < 2; i++) stationPeakKw[i] = Math.max(stationPeakKw[i], kw[i]);
      combinedPeakKw = Math.max(combinedPeakKw, kw[0] + kw[1]);
      series.push([kw[0], kw[1]]);
    }
    const windowUtilization = windowEnergy.map((e, i) => capacityKw[i] > 0 ? e / (capacityKw[i] * o.minutes / 60) : null);
    return { available: true, intervalMinutes, series, capacityKw, stationPeakKw, combinedPeakKw,
      stationEnergyKwh, initialEnergyKwh, newEnergyKwh: records.length * o.energy,
      tailEnergyKwh, unfinishedAtHorizon: records.filter(r => r.end > o.minutes).length,
      windowUtilization, utilizationGapPp: windowUtilization.every(v => v !== null) ? Math.abs(windowUtilization[0] - windowUtilization[1]) * 100 : null,
      overRatedSessions, lastCompletionMinutes };
  }
  function runPolicy(stations, o, people, policy, utilizationById) {
    const prices = stations.map(s => price(s, policy, o, utilizationById));
    const queues = stations.map((s, i) => [
      ...Array(s.avail).fill(0), ...people.initial[i].map(u => u * duration(s, o, 30))
    ]);
    const initial = queues.map(q => q.filter(t => t > 0));
    const records = [], count = [0, 0];
    let wait = 0, estimated = 0, charge = 0, distance = 0, discount = 0, completion = 0;
    for (const d of people.drivers) {
      const next = queues.map(q => q.length ? Math.min(...q) : Infinity);
      const expected = next.map(t => Math.max(0, t - d.arrival));
      const costs = stations.map((s, i) => o.sensitivity * o.energy * prices[i] + o.alpha * (i ? o.distance : 0) + o.beta * expected[i]);
      // An unusable station must stay excluded even if beta=0 (0 * Infinity = NaN).
      const probs = probability(costs.map((c, i) => queues[i].length ? c : Infinity), o.tau);
      const i = d.choice < probs[0] ? 0 : 1, q = queues[i], slot = q.indexOf(next[i]);
      const start = Math.max(d.arrival, next[i]), actual = start - d.arrival;
      const end = start + duration(stations[i], o, d.duration);
      q[slot] = end; count[i]++; wait += actual; estimated += expected[i];
      charge += o.energy * prices[i]; distance += i ? o.distance : 0;
      discount += o.energy * Math.max(0, stations[i].base - prices[i]); completion = Math.max(completion, end);
      records.push({ driver: d.id, station: i, arrival: d.arrival, expectedWait: expected[i], actualWait: actual, start, end });
    }
    return { policy, prices, count, share: count.map(n => n / o.drivers), wait: wait / o.drivers,
      expectedWait: estimated / o.drivers, fee: charge / o.drivers, distance: distance / o.drivers,
      discount, revenue: charge, completion, records, load: loadProfile(stations, o, initial, records) };
  }
  async function compare(stations, options = {}, onProgress = () => {}, utilizationById, control = {}) {
    const o = { ...defaults, ...options }; validate(stations, o);
    const random = rng(o.seed), results = policies.map((label, policy) => ({ label, policy, count: [0, 0], share: [0, 0], wait: 0, expectedWait: 0, fee: 0, distance: 0, discount: 0, revenue: 0, completion: 0, samples: [] }));
    const peakSamples = policies.map(() => []), peakDeltaSamples = policies.map(() => []);
    for (let r = 0; r < o.repeats; r++) {
      if (control.cancelled?.()) throw new Error('분석을 중단했습니다.');
      const people = control.populations ? control.populations[r] : population(stations, o, random);
      let referencePeak = null;
      for (let p = 0; p < 3; p++) {
        const run = runPolicy(stations, o, people, p, utilizationById), out = results[p];
        for (const key of ['wait', 'expectedWait', 'fee', 'distance', 'discount', 'revenue', 'completion']) out[key] += run[key] / o.repeats;
        for (let i = 0; i < 2; i++) { out.count[i] += run.count[i] / o.repeats; out.share[i] += run.share[i] / o.repeats; }
        out.samples.push(run.wait); out.prices = run.prices;
        const l = run.load;
        if (!l.available) out.load = l;
        else if (out.load?.available !== false) {
          if (!out.load) out.load = { available: true, intervalMinutes: l.intervalMinutes, capacityKw: l.capacityKw,
            stationPeakKw: [0, 0], stationEnergyKwh: [0, 0], windowUtilization: l.windowUtilization.map(v => v === null ? null : 0),
            combinedPeakKw: 0, initialEnergyKwh: 0, newEnergyKwh: 0, tailEnergyKwh: 0, unfinishedAtHorizon: 0,
            overRatedSessions: 0, lastCompletionMinutes: 0, utilizationGapPp: l.utilizationGapPp === null ? null : 0, series: [] };
          for (const key of ['combinedPeakKw','initialEnergyKwh','newEnergyKwh','tailEnergyKwh','unfinishedAtHorizon','overRatedSessions','lastCompletionMinutes']) out.load[key] += l[key] / o.repeats;
          if (l.utilizationGapPp !== null) out.load.utilizationGapPp += l.utilizationGapPp / o.repeats;
          for (let i = 0; i < 2; i++) {
            out.load.stationPeakKw[i] += l.stationPeakKw[i] / o.repeats;
            out.load.stationEnergyKwh[i] += l.stationEnergyKwh[i] / o.repeats;
            if (l.windowUtilization[i] !== null) out.load.windowUtilization[i] += l.windowUtilization[i] / o.repeats;
          }
          l.series.forEach((kw, b) => {
            if (!out.load.series[b]) out.load.series[b] = [0, 0];
            for (let i = 0; i < 2; i++) out.load.series[b][i] += kw[i] / o.repeats;
          });
          peakSamples[p].push(l.combinedPeakKw);
          if (p === 0) referencePeak = l.combinedPeakKw;
          if (referencePeak !== null) peakDeltaSamples[p].push(l.combinedPeakKw - referencePeak);
        }
        if (!r) out.records = run.records;
      }
      if (r % 10 === 0) { onProgress((r + 1) / o.repeats); await new Promise(resolve => setTimeout(resolve, 0)); }
    }
    for (const out of results) {
      out.waitChange = results[0].wait > 1e-9 ? (out.wait / results[0].wait - 1) * 100 : null;
      out.revenueChange = out.revenue - results[0].revenue;
      const variance = o.repeats > 1 ? out.samples.reduce((s, x) => s + (x - out.wait) ** 2, 0) / (o.repeats - 1) : 0;
      out.waitSE = o.repeats > 1 ? Math.sqrt(variance / o.repeats) : null;
      delete out.samples;
    }
    const se = values => {
      if (values.length < 2) return null;
      const mean = values.reduce((a, b) => a + b, 0) / values.length;
      return Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / (values.length - 1) / values.length);
    };
    for (const out of results) if (out.load.available && results[0].load.available) {
      const baseline = results[0].load;
      out.load.combinedPeakDeltaKw = out.load.combinedPeakKw - baseline.combinedPeakKw;
      out.load.combinedPeakReductionPct = baseline.combinedPeakKw > 1e-9 ? (baseline.combinedPeakKw - out.load.combinedPeakKw) / baseline.combinedPeakKw * 100 : null;
      out.load.stationPeakReductionPct = out.load.stationPeakKw.map((p, i) => baseline.stationPeakKw[i] > 1e-9 ? (baseline.stationPeakKw[i] - p) / baseline.stationPeakKw[i] * 100 : null);
      out.load.peakSE = se(peakSamples[out.policy]); out.load.peakDeltaSE = se(peakDeltaSamples[out.policy]);
    }
    onProgress(1); return { options: o, stations: stations.map(s => ({ ...s })), results };
  }
  const sweepKeys = ['drivers', 'minutes', 'energy', 'sensitivity', 'alpha', 'beta', 'tau', 'distance', 'discount', 'surcharge', 'threshold', 'durationMode'];
  async function sweep(stations, options, key, values, onProgress = () => {}, utilizationById, cancelled = () => false) {
    const base = { ...defaults, ...options }; validate(stations, base);
    if (!sweepKeys.includes(key) || !Array.isArray(values) || !values.length || values.length > 8) throw new Error('비교 항목과 1~8개 수준을 확인하세요.');
    const levels = [...new Set([base[key], ...values])].sort((a, b) => typeof a === 'number' ? a - b : String(a).localeCompare(String(b)));
    for (const value of levels) validate(stations, { ...base, [key]: value });
    const maxDrivers = key === 'drivers' ? Math.max(...levels) : base.drivers;
    if (levels.length * base.repeats * maxDrivers * 3 > 2000000) throw new Error('분석량이 큽니다. 비교 수준·운전자 수·반복 횟수를 줄여 주세요 (최대 200만 차량·정책 계산).');
    // Reuse the exact baseline populations, including initial residuals. Extra drivers
    // have a separate stream so increasing N never changes the baseline random draws.
    const random = rng(base.seed), bank = [];
    for (let r = 0; r < base.repeats; r++) {
      const people = population(stations, base, random), extraRandom = rng((base.seed ^ Math.imul(r + 1, 0x9e3779b1)) >>> 0);
      const drivers = people.drivers.map(d => ({ ...d }));
      for (let id = base.drivers; id < maxDrivers; id++) drivers.push({ id, arrival: extraRandom() * base.minutes, duration: 20 + extraRandom() * 20, choice: extraRandom() });
      bank.push({ initial: people.initial, drivers });
    }
    const scenarios = [];
    for (let i = 0; i < levels.length; i++) {
      if (cancelled()) throw new Error('분석을 중단했습니다.');
      const value = levels[i], o = { ...base, [key]: value };
      const populations = bank.map(p => ({ initial: p.initial, drivers: p.drivers.filter(d => d.id < o.drivers)
        .map(d => ({ ...d, arrival: o.minutes === base.minutes ? d.arrival : d.arrival / base.minutes * o.minutes })).sort((a, b) => a.arrival - b.arrival || a.id - b.id) }));
      const output = await compare(stations, o, p => onProgress((i + p) / levels.length), utilizationById, { populations, cancelled });
      scenarios.push({ value, ...output });
    }
    const reference = scenarios.find(s => s.value === base[key]);
    for (const s of scenarios) for (const r of s.results) {
      const ref = reference.results[r.policy];
      r.waitDelta = r.wait - ref.wait;
      r.shareBDelta = (r.share[1] - ref.share[1]) * 100;
    }
    return { key, base, baseline: base[key], scenarios };
  }
  function evidence(stations, o, context = {}) {
    const rows = [], add = (item, value, kind, basis) => rows.push({ item, value, kind, basis });
    const real = context.mode === 'real';
    for (const [i, s] of stations.entries()) {
      const prefix = i ? 'B' : 'A';
      add(`${prefix} 충전소 ID·위치`, `${s.id} · ${s.lat}, ${s.lng}`, real ? '실측·수집값' : '가정값', real ? context.source : '실제 충전소가 아닌 예시 데이터');
      add(`${prefix} 초기 충전기 상태`, `빈 ${s.avail} / 충전 중 ${s.charging} / 불가 ${s.fault} / 미확인 ${s.unknown || 0}대`, real ? '실측·수집값' : '가정값', real ? '수집 시각의 API 상태 집계. 현재 시각의 실시간 상태를 보장하지 않음' : '시연용 초기 상태');
      add(`${prefix} 기본 단가`, `${s.base}원/kWh`, !real ? '가정값' : s.source === '운영사' ? '공시값' : '추정값', `${s.source || '운영사 요금표'} · ${s.upd || '요금표 시각 미제공'} · 실제 청구액 아님`);
      add(`${prefix} 대표 출력`, `${s.kw}kW`, real ? '추정값' : '가정값', '기존 관제 대표 출력 사용. 원자료 출력 또는 기본 대체값이며 개별 충전기의 실효 출력과 다를 수 있음');
    }
    for (const [key, label, unit] of [['drivers','신규 운전자','명'],['minutes','도착 생성 기간','분'],['energy','차량당 충전량','kWh'],['sensitivity','가격 민감도','배'],['alpha','이동 비용 α','원/km'],['beta','대기 비용 β','원/분'],['tau','선택 다양성 τ','원']])
      add(label, `${o[key]}${unit}`, '가정값', '요구사항 예시를 초기값으로 사용. 변경값은 사용자 시나리오이며 실측·통계 보정 전');
    for (const [key, label] of [['discount','여유 할인율'],['surcharge','혼잡 할증율'],['threshold','여유 판정 대기율']])
      add(label, `${o[key] * 100}%`, '정책 설정', '기존 프로젝트 기본 정책에서 시작. 정책 효과를 검증한 최적값이 아님');
    add('B 추가 거리', `${o.distance}km`, context.distanceMode === 'coords' ? '추정값' : '가정값', context.distanceMode === 'coords' ? 'A/B 좌표의 직선거리. 도로 거리·이동시간 아님' : '사용자 지정 추가 거리. A는 0km 가정');
    add('신규 충전시간', o.durationMode === 'power' ? '충전량 ÷ 대표 출력 × 60분' : '20~40분 균등분포', '가정값', '간소화 모델. 충전효율·충전곡선·출력 공유 제외');
    add('초기 잔여 충전시간', o.durationMode === 'power' ? '0~(충전량 ÷ 대표 출력 × 60)분 균등분포' : '0~30분 균등분포', '가정값', '초기 차량의 실제 잔여시간은 관측하지 않음');
    add('도착·선택 모형', '기간 내 균등 도착 · 로짓 선택', '가정값', '취소·포기·추가 이동시간 제외. 행동모델 실측 보정 전');
    add('반복·난수', `${o.repeats}회 · 시드 ${o.seed}`, '실험 설정', '재현성과 반복 변동 확인용. 반복 횟수는 실세계 정확도를 보장하지 않음');
    add('요금 판정 근거', context.pricingBasis || '현재 수집 상태', context.forecastInfo ? '추정값' : context.forecastRequested ? '미입력' : real ? '실측·수집값' : '가정값', context.forecastInfo ? `${context.forecastInfo} · 외부 예측. 정확도·학습자료는 이 사이트에서 검증하지 않음` : context.forecastRequested ? '예측 JSON이 없거나 아직 검증되지 않았습니다. 실행 시 검증합니다.' : '시작 시 상태에 정책을 적용하고 단가 고정');
    if (context.forecastInfo) for (const [key, label] of [['forecastUtilizationA','A 예측 이용률'], ['forecastUtilizationB','B 예측 이용률']])
      add(label, `${context[key] * 100}%`, '추정값', context.forecastInfo);
    return rows;
  }
  return { defaults, policies, demo, rng, status, price, probability, validate, population, runPolicy, loadProfile, compare, forecast, sweep, sweepKeys, evidence };
});
