/* Public-station road routing; shared by browser and Node verification. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ESSRouting = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const endpoint = 'https://routing.openstreetmap.de/routed-car/table/v1/driving/';
  const provider = 'FOSSGIS OSRM car · OpenStreetMap';
  function key(stations) {
    if (stations.length !== 2 || stations.some(s => !s || !Number.isFinite(s.lat) || !Number.isFinite(s.lng) || Math.abs(s.lat)>90 || Math.abs(s.lng)>180) || stations[0].id===stations[1].id)
      throw new Error('좌표가 있는 서로 다른 충전소 A/B를 선택하세요.');
    return stations.map(s=>`${s.id}:${s.lng.toFixed(6)},${s.lat.toFixed(6)}`).join('|');
  }
  function url(stations) {
    key(stations);
    return endpoint + stations.map(s=>`${s.lng.toFixed(6)},${s.lat.toFixed(6)}`).join(';') + '?annotations=distance,duration&radiuses=200;200';
  }
  function decode(data, stations, fetchedAt = new Date().toISOString()) {
    const pairKey = key(stations);
    if (data?.code !== 'Ok') throw new Error('자동차 도로 경로를 찾지 못했습니다. 다른 충전소 또는 수동 거리를 사용하세요.');
    const positions = [[0,1],[1,0]];
    const meters = positions.map(([i,j])=>data.distances?.[i]?.[j]);
    const seconds = positions.map(([i,j])=>data.durations?.[i]?.[j]);
    if (meters.some(v=>!Number.isFinite(v)||v<0||v>200000) || seconds.some(v=>!Number.isFinite(v)||v<0))
      throw new Error('양방향 경로가 없거나 지원 거리(각 200km)를 벗어났습니다. 다른 충전소 또는 수동 거리를 사용하세요.');
    const snaps = data.sources?.map(s=>s.distance);
    if (!snaps || snaps.length!==2 || snaps.some(v=>!Number.isFinite(v)||v<0||v>200))
      throw new Error('충전소 200m 이내 도로 연결점을 확인하지 못했습니다. 지도에서 진입로를 확인하고 수동 거리를 입력하세요.');
    return { key: pairKey, stationIds: stations.map(s=>s.id), provider, url:url(stations), fetchedAt,
      roadDistances: meters.map(v=>Math.round(v)/1000), meters, seconds, snapMeters:snaps,
      dataVersion: data.data_version || '서비스 미제공', method:'OSRM car 최단시간 도로 경로의 거리. 양방향 개별 계산. 실시간 교통·GPS 실측·실제 출입구 경로 아님' };
  }
  function createClient(fetcher, { now = Date.now, sleep = ms=>new Promise(resolve=>setTimeout(resolve,ms)), timeoutMs=15000 } = {}) {
    const cache = new Map(), pending = new Map();
    let chain = Promise.resolve(), lastRequest = -Infinity;
    function get(stations, force = false) {
      const snapshot = stations.map(s=>s && ({id:s.id,lat:s.lat,lng:s.lng})), k=key(snapshot), stored=cache.get(k);
      if (!force && stored && now()-stored.at<1800000) return Promise.resolve(stored.result);
      if (pending.has(k)) return pending.get(k);
      const work = chain.catch(()=>{}).then(async()=>{
        const delay=Math.max(0,1000-(now()-lastRequest)); if(delay) await sleep(delay);
        lastRequest=now();
        const response=await fetcher(url(snapshot),{credentials:'omit',signal:AbortSignal.timeout(timeoutMs)});
        if (!response.ok) throw new Error(`도로 경로 서비스 응답 ${response.status}. 다시 조회하거나 수동 거리를 사용하세요.`);
        const result=decode(await response.json(),snapshot,new Date(now()).toISOString());
        cache.set(k,{at:now(),result}); return result;
      });
      const tracked=work.finally(()=>pending.delete(k));
      pending.set(k,tracked); chain=tracked.catch(()=>{}); return tracked;
    }
    return {get};
  }
  return {key,url,decode,createClient,provider};
});
