# -*- coding: utf-8 -*-
"""roads-<city>.json と rivers-<city>.json（通り名つき道路中心線・河川）を
OpenStreetMap から作り直す。

  出力先: roads-kyoto.json / roads-osaka.json
          rivers-kyoto.json / rivers-osaka.json
  使い道: 断面図の通り名ラベルと道路断面・河川断面（profile.js）、
          ストリートビューの路面ラベル（streetnames.js）。

  ★ ライブでは取得しない。Overpass の公開APIはフェアユース前提でレート制限が
    あるため、ここで一度取ってコミットする方式にしている（mountain.geojson や
    boundary-*.json と同じ）。データを更新したいときだけ手で走らせる:

        python fetch_roads.py kyoto     ← 道路と河川の両方を書き出す
        python fetch_roads.py osaka

  ★ 拾う道路の種類（HIGHWAY_KINDS）
    幹線（motorway〜tertiary）だけだと、京都の南北の細い通り（御幸町通・
    麩屋町通・富小路通など）や、寺町通の商店街区間が丸ごと抜ける。これらは
    OSM では residential / living_street / pedestrian として引かれているため、
    そこまで含める。名前の無い道は入れない（ラベルに使えないので）。
"""
import json
import math
import sys
import urllib.parse
import urllib.request

# 混んでいると 504 を返すので、代替の公開ミラーへ順に投げ直す。
OVERPASS = (
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://overpass.osm.jp/api/interpreter',
)
# 名前つきなら拾う道路の種類。footway/path（歩道・小径）は数が多すぎるので入れない。
HIGHWAY_KINDS = ('motorway|trunk|primary|secondary|tertiary'
                 '|unclassified|residential|living_street|pedestrian')
# Douglas-Peucker の間引き幅[m]。
#   ⚠️ ここは【路面ラベルの置き位置の誤差そのもの】になる。15m にしていたら、
#     押小路通のような長い直線路が「1.5km を2点」まで潰され、実際の道から最大15m
#     ずれた線になっていた（幅6mの通りでは致命的。ラベルが隣の街区に乗る）。
#     断面図の通り名は多少ずれても平気だが、ストリートビューでは効かない。
SIMPLIFY_TOL_M = 2
COORD_DIGITS = 5         # 小数5桁 ≒ 1.1m（間引き幅より十分細かい）

# 河川。断面図に「水色の帯＋川底」を描くのに使う。
#   ★ 幅は OSM の width タグを優先し、無ければ種別ごとの既定値を使う。
#     （川幅は道路と違って個体差が大きいので、タグがあるならそれがいちばん確か）
WATERWAY_KINDS = 'river|stream|canal'
# 幅タグが無いときの既定[m]。
#   ⚠️ river を 30m にすると、北山の「◯◯谷川」まで大河扱いになる。実測では
#     京都市域の river 2,082本のうち幅タグがあるのは 11本だけで、大半は谷川。
#     控えめな既定にして、タグがある川（鴨川など）だけ実寸で出す。
RIVER_WIDTH_DEFAULT_M = {'river': 18, 'canal': 8, 'stream': 3}
# 河川の間引き幅[m]。道路（2m）より粗くてよい。
#   ★ 断面に描くのは幅十数mの帯なので、位置が数m動いても見え方は変わらない。
#     2m のままだと谷川の点が多すぎて 1MB を超える（実測 1,049KB → 8m で大幅減）。
RIVER_SIMPLIFY_TOL_M = 8

# 取得範囲は【市域そのものではなく、config.js の CITY_BBOX を少し広げた矩形】。
#   東西断面は 30km あって市域からはみ出すので、市域で切ると断面の端で通り名が
#   消える（宇治・亀岡・向日町などの名前が 100 件ほど落ちた）。
BBOX_PAD = 0.02   # 度（≒2km）
CITIES = {
    'kyoto': {'label': '京都市', 'out': 'roads-kyoto.json',
              'bbox': (34.8749, 135.5590, 35.3212, 135.8784)},   # (south, west, north, east)
    'osaka': {'label': '大阪市', 'out': 'roads-osaka.json',
              'bbox': (34.5868, 135.3435, 34.7688, 135.5993)},
}


def fetch(bbox):
    s, w, n, e = bbox
    query = (
        '[out:json][timeout:600];'
        'way["highway"~"^(%s)$"]["name"](%f,%f,%f,%f);'
        'out geom;'
    ) % (HIGHWAY_KINDS, s - BBOX_PAD, w - BBOX_PAD, n + BBOX_PAD, e + BBOX_PAD)
    body = ('data=' + urllib.parse.quote(query)).encode('utf-8')
    last = None
    for url in OVERPASS:
        req = urllib.request.Request(url, data=body, headers={
            'User-Agent': 'my-arch-workspace/1.0 (road name labels, one-off fetch)'})
        try:
            with urllib.request.urlopen(req, timeout=600) as res:
                return json.loads(res.read().decode('utf-8'))
        except Exception as e:      # 504（混雑）など。次のミラーへ
            print('  失敗:', url, type(e).__name__, e)
            last = e
    raise last


def parse_width(v):
    """OSM の width タグ（'20', '20 m', '15.5' など）を m の数値にする。"""
    if not v:
        return None
    t = str(v).strip().replace('m', '').replace('ｍ', '').strip()
    try:
        w = float(t)
    except ValueError:
        return None
    return w if 0.5 <= w <= 500 else None


def simplify(pts, tol_m, lat0):
    """Douglas-Peucker。経緯度のまま、緯度に応じた縮尺でメートルに直して測る。"""
    if len(pts) < 3:
        return pts
    mx = 111320.0 * math.cos(math.radians(lat0))   # 経度1度あたりのm
    my = 110540.0                                  # 緯度1度あたりのm
    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        i0, i1 = stack.pop()
        if i1 <= i0 + 1:
            continue
        ax, ay = pts[i0][0] * mx, pts[i0][1] * my
        bx, by = pts[i1][0] * mx, pts[i1][1] * my
        dx, dy = bx - ax, by - ay
        den = math.hypot(dx, dy)
        worst, worst_i = -1.0, -1
        for i in range(i0 + 1, i1):
            px, py = pts[i][0] * mx, pts[i][1] * my
            if den < 1e-9:
                d = math.hypot(px - ax, py - ay)
            else:
                d = abs(dx * (ay - py) - (ax - px) * dy) / den
            if d > worst:
                worst, worst_i = d, i
        if worst > tol_m:
            keep[worst_i] = True
            stack.append((i0, worst_i))
            stack.append((worst_i, i1))
    return [p for p, k in zip(pts, keep) if k]


def fetch_rivers(bbox):
    s, w, n, e = bbox
    query = (
        '[out:json][timeout:600];'
        'way["waterway"~"^(%s)$"]["name"](%f,%f,%f,%f);'
        'out geom;'
    ) % (WATERWAY_KINDS, s - BBOX_PAD, w - BBOX_PAD, n + BBOX_PAD, e + BBOX_PAD)
    body = ('data=' + urllib.parse.quote(query)).encode('utf-8')
    last = None
    for url in OVERPASS:
        req = urllib.request.Request(url, data=body, headers={
            'User-Agent': 'my-arch-workspace/1.0 (river sections, one-off fetch)'})
        try:
            with urllib.request.urlopen(req, timeout=600) as res:
                return json.loads(res.read().decode('utf-8'))
        except Exception as ex:
            print('  失敗:', url, type(ex).__name__, ex)
            last = ex
    raise last


def build_rivers(city):
    print('取得中（河川）:', city['label'], WATERWAY_KINDS)
    raw = fetch_rivers(city['bbox'])
    feats = []
    for el in raw.get('elements', []):
        if el.get('type') != 'way':
            continue
        tags = el.get('tags') or {}
        name = tags.get('name')
        geom = el.get('geometry') or []
        if not name or len(geom) < 2:
            continue
        pts = [[g['lon'], g['lat']] for g in geom]
        pts = simplify(pts, RIVER_SIMPLIFY_TOL_M, pts[0][1])
        pts = [[round(x, COORD_DIGITS), round(y, COORD_DIGITS)] for x, y in pts]
        if len(pts) < 2 or all(q == pts[0] for q in pts):
            continue
        kind = tags.get('waterway')
        w = parse_width(tags.get('width'))
        feats.append({
            'name': name, 'waterway': kind,
            'width': w if w else RIVER_WIDTH_DEFAULT_M.get(kind, 6),
            'widthFromTag': bool(w),
            'pts': pts,
        })
    out = {
        'source': 'OpenStreetMap (Overpass API) — waterway=%s with name, %s周辺'
                  % (WATERWAY_KINDS.replace('|', '/'), city['label']),
        'license': 'ODbL 1.0 (c) OpenStreetMap contributors',
        'crs': 'WGS84 [lon, lat]',
        'simplifyTolM': RIVER_SIMPLIFY_TOL_M,
        'features': feats,
    }
    path = city['out'].replace('roads-', 'rivers-')
    with open(path, 'w', encoding='utf-8', newline='\n') as f:
        json.dump(out, f, ensure_ascii=False, separators=(',', ':'))
    import os
    names = {f['name'] for f in feats}
    tagged = sum(1 for f in feats if f['widthFromTag'])
    print('%s: %d本 / 川の名前 %d種 / 幅タグあり %d本 / %.0f KB'
          % (path, len(feats), len(names), tagged, os.path.getsize(path) / 1024))


def main(city_id):
    city = CITIES[city_id]
    print('取得中:', city['label'], HIGHWAY_KINDS)
    raw = fetch(city['bbox'])
    feats = []
    for el in raw.get('elements', []):
        if el.get('type') != 'way':
            continue
        name = (el.get('tags') or {}).get('name')
        geom = el.get('geometry') or []
        if not name or len(geom) < 2:
            continue
        pts = [[g['lon'], g['lat']] for g in geom]
        lat0 = pts[0][1]
        pts = simplify(pts, SIMPLIFY_TOL_M, lat0)
        pts = [[round(x, COORD_DIGITS), round(y, COORD_DIGITS)] for x, y in pts]
        # 間引きで潰れて同じ点だけになったものは捨てる
        if len(pts) < 2 or all(p == pts[0] for p in pts):
            continue
        feats.append({'name': name, 'highway': el['tags'].get('highway'), 'pts': pts})

    out = {
        'source': 'OpenStreetMap (Overpass API) — highway=%s with name, %s周辺'
                  % (HIGHWAY_KINDS.replace('|', '/'), city['label']),
        'license': 'ODbL 1.0 (c) OpenStreetMap contributors',
        'crs': 'WGS84 [lon, lat]',
        'simplifyTolM': SIMPLIFY_TOL_M,
        'features': feats,
    }
    with open(city['out'], 'w', encoding='utf-8', newline='\n') as f:
        json.dump(out, f, ensure_ascii=False, separators=(',', ':'))
    names = {f['name'] for f in feats}
    import os
    print('%s: %d本 / 通り名 %d種 / %.0f KB'
          % (city['out'], len(feats), len(names), os.path.getsize(city['out']) / 1024))
    build_rivers(city)


if __name__ == '__main__':
    if len(sys.argv) > 2:
        SIMPLIFY_TOL_M = float(sys.argv[2])   # 間引き幅を試すとき用
    main(sys.argv[1] if len(sys.argv) > 1 else 'kyoto')
