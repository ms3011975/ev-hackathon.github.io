"""Reproduce per-session energy defaults from the original Jeju CSV (15109706).

Usage: python -m scripts.summarize_jeju_energy <downloaded.csv>
The large public source stays outside Git; its SHA-256 is recorded in the summary.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
from collections import Counter
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from pathlib import Path

FAST = {'DC콤보', 'AC급속3상', 'DC차데모', 'DC차데모+AC3상', 'DC차데모+AC3상+DC콤보'}
SOURCE = 'https://www.data.go.kr/data/15109706/fileData.do'
UNIT_SOURCE = 'https://www.epeople.go.kr/api/thk/conversational/selectConversationalDetail.npaid?ideaRegNo=1AE-2007-0001036'


def summarize(path: Path):
    groups = {k: {'sessions': 0, 'total': Decimal(0), 'start': '9999', 'end': ''} for k in ['fast', 'slow']}
    excluded, types, seen = Counter(), Counter(), set()
    total_rows = unit_checked = unit_matches = 0
    with path.open(encoding='cp949', newline='') as f:
        reader = csv.DictReader(f)
        required = {'운영기관', '충전기 타입', '충전 시작 일자', '충전량', '충전 금액'}
        if not required.issubset(reader.fieldnames or []):
            raise ValueError('Expected the session-level CSV, not a daily aggregate.')
        for row in reader:
            total_rows += 1
            signature = hashlib.sha256(json.dumps(row, ensure_ascii=False, sort_keys=True).encode()).digest()
            if signature in seen:
                excluded['exact_duplicate'] += 1
                continue
            seen.add(signature)
            kind = row['충전기 타입'].strip()
            if '버스' in kind:
                excluded['bus_charger'] += 1
                continue
            speed = 'slow' if kind == '완속' else 'fast' if kind in FAST else None
            if speed is None:
                excluded['unknown_type'] += 1
                continue
            try:
                energy = Decimal(row['충전량'])
            except (InvalidOperation, TypeError):
                excluded['missing_or_invalid_energy'] += 1
                continue
            if not energy.is_finite() or energy <= 0:
                excluded['non_positive_energy'] += 1
                continue
            date = row['충전 시작 일자']
            g = groups[speed]
            g['sessions'] += 1
            g['total'] += energy
            g['start'], g['end'] = min(g['start'], date), max(g['end'], date)
            types[kind] += 1
            # Unit is not explicitly labeled in the CSV. Check the historical
            # Jeju 250 won/kWh tariff against positive billed records, Jan-Jun 2021.
            if row['운영기관'] == '제주특별자치도' and '2021-01-01' <= date <= '2021-06-30':
                fee = Decimal(row['충전 금액'] or '0')
                if fee > 0:
                    unit_checked += 1
                    if abs(fee - energy * 250) <= 1:
                        unit_matches += 1
    by_speed = {}
    for speed, g in groups.items():
        if not g['sessions']:
            raise ValueError(f'No usable {speed} sessions')
        mean = g['total'] / g['sessions']
        by_speed[speed] = {'defaultKwh': float(mean.quantize(Decimal('.01'), rounding=ROUND_HALF_UP)),
                           'meanKwh': float(mean), 'totalKwh': float(g['total']),
                           'sessions': g['sessions'], 'start': g['start'], 'end': g['end']}
    with path.open('rb') as f:
        checksum = hashlib.file_digest(f, 'sha256').hexdigest()
    return {'schemaVersion': 1, 'sourceTitle': '제주특별자치도_전체 전기차자동차 충전 이력 데이터(파일)_20221130',
            'sourceUrl': SOURCE, 'sourceFileSha256': checksum, 'sourceEncoding': 'CP949',
            'method': '중복 제거 후 양수 충전량의 합계 ÷ 해당 충전 건수. 버스 전용·타입 미상·0 이하/결측 제외. 소수 둘째 자리 반올림.',
            'unitNote': 'CSV 단위 미기재. 제주 공시 250원/kWh와 원본 충전금액·충전량을 대조해 kWh로 해석한 추정값.',
            'unitReferenceUrl': UNIT_SOURCE,
            'unitCrossCheck': {'billedSessionsJanJun2021': unit_checked, 'withinOneWonOf250PerKwh': unit_matches},
            'limitation': '2021~2022년 제주 자료를 충북에 이전 적용한 추정값. 현재 충북 실측값·차종별 대표값 아님. 양수 충전 건의 조건부 평균이며 0kWh 시도·취소를 제외. 개별 분포·시간대 차이 미반영.',
            'rawRows': total_rows, 'excluded': dict(excluded), 'includedTypes': dict(sorted(types.items())),
            'bySpeed': by_speed}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('csv', type=Path)
    parser.add_argument('--output', type=Path, default=Path('data/jeju_energy_summary.json'))
    args = parser.parse_args()
    result = summarize(args.csv)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(result, ensure_ascii=False, indent=2))
