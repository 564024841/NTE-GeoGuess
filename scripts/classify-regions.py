# 按坐标把题归类到区域 —— **存档版（Python）**。
#
# 来历：2026-09-22 线上那次归类就是用这支脚本跑的（产出线上 `map-data.json` 的 v5：
# 米格尔区 124 / 绘空町 121 / 新赫兰德区 120 / 桥间地 66 / 向阳岛 25 / 未闻浦 15 / 薄暮区 5）。
# 后来正式入口换成了 `npm run classify:regions`（scripts/classify-regions.mjs）：
#   · 它 import `packages/shared/src/regionInference.js` —— 后台出题时的自动归类用的是同一份规则，
#     规则只此一处，不会出现「Python 一套、JS 一套」慢慢漂掉；
#   · 它按仓库惯例默认演练、`--apply` 才写盘（先备份到 data/backups/）并同步数据库；
#   · 它读的是仓库里的 `packages/shared/data/region-reference.json`（400 个参照点，已入库）。
#
# 保留这支 Python 版只为留痕与对照：同样的输入下，它和 mjs 版的结果**逐字节一致**
# （可自行验证：`python3 scripts/classify-regions.py --apply --out=/tmp/x.json` 后再比 md5）。
# 唯一差别：`--report` 出的 pixel 字段偶尔会差 1 像素 —— 这份 py 自己解仿射，和 JS 的 solveAffine
# 在浮点末位上不同；归属（from/to/reason）两者完全一致。
# 要改规则/调参，请改 `packages/shared/src/regionInference.js`，别只改这里。
#
# 用法：
#   python3 scripts/classify-regions.py                 # 演练：只打印会改什么
#   python3 scripts/classify-regions.py --apply         # 写回 packages/shared/data/map-data.json
#   python3 scripts/classify-regions.py --out=/tmp/new-map-data.json   # 写到别处（配合 --apply）
#   python3 scripts/classify-regions.py --report=/tmp/rows.json        # 逐题明细落盘
#
# 方法：游戏坐标 → 标定像素（3 点解 2×3 仿射），取最近 K 个参照点做反距离加权投票；
#       离最近参照点超过 MAX_DIST 标定像素的，说明落在参照点覆盖之外（地图西北那块飞地），归「薄暮区」。
import json, math, sys
from collections import Counter, defaultdict

ROOT = __file__.rsplit('/scripts/', 1)[0]
SEED = f'{ROOT}/packages/shared/data/map-data.json'
CAL = f'{ROOT}/packages/shared/data/navi-coordinate-calibration.json'
REFERENCE = f'{ROOT}/packages/shared/data/region-reference.json'

def option(name, fallback):
    prefix = f'--{name}='
    for arg in sys.argv:
        if arg.startswith(prefix):
            return arg[len(prefix):]
    return fallback

APPLY = '--apply' in sys.argv
OUT = option('out', SEED)
REPORT = option('report', '')
K = int(option('k', 7))
MAX_DIST = float(option('max-dist', 1000))   # 标定像素（整图宽 13056）
TWILIGHT = '薄暮区'
PLACEHOLDER = '全地图'
UNLABELED = '未标注'

REGION_LABEL = {'region-hyuga': '向阳岛', 'region-new-holland': '新赫兰德区', 'region-miminoura': '未闻浦',
                'region-hashima': '桥间地', 'region-miguel': '米格尔区', 'region-ekuumachi': '绘空町',
                'region-twilight': TWILIGHT, 'unlabeled': UNLABELED}

with open(CAL) as handle:
    calibration = json.load(handle)
with open(SEED) as handle:
    data = json.load(handle)
with open(REFERENCE) as handle:
    reference = json.load(handle)

# 分类 id ↔ 区域名：照 seed 的分类表来，不另抄一份映射
REGION_LABEL = {category['id']: category['label'] for category in data['categories']}
REGION_LABEL.setdefault('unlabeled', UNLABELED)
LABEL_TO_ID = {label: cid for cid, label in REGION_LABEL.items()}

# 2×3 仿射：游戏坐标 → MapLocator 像素（13056）
P = calibration['points']
A = [[p['raw'][0], p['raw'][1], 1.0] for p in P]
B = [[p['map'][0], p['map'][1]] for p in P]
M = [row[:] + [B[i][0], B[i][1]] for i, row in enumerate(A)]
for c in range(3):
    piv = max(range(c, 3), key=lambda r: abs(M[r][c]))
    M[c], M[piv] = M[piv], M[c]
    pv = M[c][c]
    M[c] = [v / pv for v in M[c]]
    for r in range(3):
        if r != c and M[r][c]:
            f = M[r][c]
            M[r] = [a - f * b for a, b in zip(M[r], M[c])]
AFF = (M[0][3], M[1][3], M[2][3], M[0][4], M[1][4], M[2][4])

def loc(x, y):
    return (AFF[0] * x + AFF[1] * y + AFF[2], AFF[3] * x + AFF[4] * y + AFF[5])

known = {label for label in REGION_LABEL.values() if label not in (UNLABELED, TWILIGHT)}
ref = [(loc(p['x'], p['y'])[0], loc(p['x'], p['y'])[1], p['district'])
       for p in reference['points'] if p.get('district') in known]
assert len(ref) == len(reference['points']), f'参照点缺失：{len(ref)} != {len(reference["points"])}'

def knn(px, py, k=K):
    nearest = sorted(((math.dist((px, py), (r[0], r[1])), r[2]) for r in ref), key=lambda t: t[0])[:k]
    weights = defaultdict(float)
    for d, region in nearest:
        weights[region] += 1.0 / max(d, 1.0)
    total = sum(weights.values())
    region, weight = max(weights.items(), key=lambda kv: kv[1])
    return region, weight / total, nearest[0][0]

out, rows = [], []
for location in data['locations']:
    px, py = loc(location['x'], location['y'])
    district = (location.get('district') or '').strip()
    if district and district != PLACEHOLDER and district in known:
        region, conf, d0, reason = district, 1.0, 0.0, 'district'
    else:
        region, conf, d0 = knn(px, py)
        reason = 'knn'
        if d0 > MAX_DIST:
            region = TWILIGHT
            reason = 'outside-coverage'
    old_id = (location.get('types') or ['?'])[0]
    item = dict(location)
    item['types'] = [LABEL_TO_ID[region]]
    item['region'] = region
    item['tags'] = [tag for tag in (location.get('tags') or [])
                    if tag not in ('unlabeled', UNLABELED, *known, TWILIGHT)] + [region]
    out.append(item)
    rows.append({'id': location['id'], 'name': location.get('name', ''),
                 'oldLabel': REGION_LABEL.get(old_id, old_id), 'new': region,
                 'conf': conf, 'd0': d0, 'px': px, 'py': py,
                 'x': location['x'], 'y': location['y'], 'reason': reason})

print(f"题数 {len(rows)}  参照点 {len(ref)}  k={K}  覆盖半径 {MAX_DIST:.0f}")
print('新分布:', dict(Counter(r['new'] for r in rows).most_common()))
low = [r for r in rows if r['new'] != TWILIGHT and r['conf'] < 0.6]
print(f"边界附近（置信度<0.6，建议人工复核）{len(low)} 个：")
for r in sorted(low, key=lambda r: r['conf']):
    print(f"   {r['id']:26s} → {r['new']:5s} conf={r['conf']:.2f} 最近参照点={r['d0']:.0f}px")
far = [r for r in rows if r['new'] == TWILIGHT]
print(f"参照点覆盖之外 → {TWILIGHT} {len(far)} 个：")
for r in sorted(far, key=lambda r: r['d0']):
    print(f"   {r['id']:26s} 最近参照点={r['d0']:.0f}px")
print(f"归属发生变化 {len([r for r in rows if r['oldLabel'] != r['new']])} 个")

if REPORT:
    report = {
        'generatedAt': __import__('datetime').datetime.now().astimezone().isoformat(timespec='seconds'),
        'seedFile': SEED,
        'params': {'k': K, 'maxDistance': MAX_DIST, 'outsideLabel': TWILIGHT},
        'referenceCount': len(ref),
        'summary': {
            'total': len(rows),
            'changed': len([r for r in rows if r['oldLabel'] != r['new']]),
            'byRegion': dict(Counter(r['new'] for r in rows).most_common()),
            'borderline': [r['id'] for r in sorted(low, key=lambda r: r['conf'])],
            'outsideCoverage': [r['id'] for r in sorted(far, key=lambda r: r['d0'])],
            'fromDistrict': [r['id'] for r in rows if r['reason'] == 'district'],
        },
        'rows': [{
            'id': r['id'], 'name': r.get('name', ''), 'from': r['oldLabel'], 'to': r['new'],
            'reason': r['reason'],
            'confidence': round(r['conf'], 4),
            'nearestReferenceDistance': round(r['d0']),
            'pixel': [round(r['px']), round(r['py'])],
            'game': [r['x'], r['y']],
        } for r in rows],
    }
    with open(REPORT, 'w') as handle:
        json.dump(report, handle, ensure_ascii=False, indent=2)
        handle.write('\n')
    print(f'\n[报告] {REPORT}（{len(rows)} 行逐题明细）')

if not APPLY:
    print('\n（演练模式，未写入。加 --apply 执行）')
    sys.exit(0)

data = dict(data)
data['locations'] = out
data['version'] = int(data.get('version') or 1) + 1
with open(OUT, 'w') as handle:
    json.dump(data, handle, ensure_ascii=False, indent=2)
    handle.write('\n')
print(f'\n[写盘] {OUT}（version → {data["version"]}）')
print('提示：正式入口是 `npm run classify:regions --apply`，它会备份并同步数据库。')
