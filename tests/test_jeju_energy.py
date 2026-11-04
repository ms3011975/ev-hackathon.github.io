import csv
import json
from pathlib import Path

import pytest

from scripts.summarize_jeju_energy import summarize


def test_session_mean_excludes_bus_unknown_zero_and_exact_duplicate(tmp_path):
    fields = ['운영기관', '충전기 타입', '충전 시작 일자', '충전량', '충전 금액']
    rows = [
        ['제주특별자치도', 'DC콤보', '2021-01-01', '10', '2500'],
        ['제주특별자치도', 'DC차데모', '2021-01-02', '30', '7500'],
        ['제주특별자치도', 'DC차데모', '2021-01-03', '20', '5000'],
        ['제주특별자치도', '완속', '2021-01-04', '12', '3000'],
        ['제주특별자치도', '완속', '2021-01-04', '12', '3000'],
        ['제주특별자치도', 'DC콤보2(버스충전기용)', '2021-01-04', '100', '25000'],
        ['제주특별자치도', '', '2021-01-04', '25', '6250'],
        ['제주특별자치도', '완속', '2021-01-04', '0', '0'],
        ['제주특별자치도', '완속', '2021-01-05', '', '0'],
    ]
    path = tmp_path / 'sessions.csv'
    with path.open('w', encoding='cp949', newline='') as f:
        writer = csv.writer(f)
        writer.writerow(fields)
        writer.writerows(rows)
    result = summarize(path)
    assert result['bySpeed']['fast']['meanKwh'] == 20  # session weighted, not mean of connector averages
    assert result['bySpeed']['slow']['defaultKwh'] == 12
    assert result['bySpeed']['slow']['sessions'] == 1
    assert sum(result['excluded'].values()) == 5
    assert result['unitCrossCheck']['withinOneWonOf250PerKwh'] == 4
    assert len(result['sourceFileSha256']) == 64


def test_published_energy_summary_reconciles():
    s = json.loads((Path(__file__).resolve().parents[1] / 'data/jeju_energy_summary.json').read_text(encoding='utf8'))
    included = sum(g['sessions'] for g in s['bySpeed'].values())
    assert included + sum(s['excluded'].values()) == s['rawRows']
    assert sum(s['includedTypes'].values()) == included
    for g in s['bySpeed'].values():
        assert g['totalKwh'] / g['sessions'] == pytest.approx(g['meanKwh'])
        assert round(g['meanKwh'], 2) == g['defaultKwh']
