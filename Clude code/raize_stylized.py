# -*- coding: utf-8 -*-
"""
raize_stylized.py  (v2)
トヨタ ライズ(コンパクトSUV)を実寸プロポーションでデフォルメ再現する Blender スクリプト。

実行方法:
  A) Blender の [Scripting] タブ → テキストエディタに貼り付け → 実行(Alt+P)
  B) コマンドライン:  blender -P raize_stylized.py
  C) 背景レンダリング: blender -b -P raize_stylized.py -o //raize_ -F PNG -f 1

v2 変更点:
  - ホイールアーチをブーリアンで実際にえぐり、SUVらしい脚まわりに
  - ボディとキャビンを同色ブルーで一体化(ルーフも青・ツートン廃止)
  - ライト/ミラー/グリルを車体に埋め込み配置(浮きパーツ解消)
  - リアスポイラー・樹脂フェンダー・スキッドガーニッシュ等のSUVディテール追加
  - 外装のみ(内装なし)
"""

import bpy
import bmesh
import math

# ------------------------------------------------------------------
# 主要寸法(m) 実車: 全長3995 全高1620 全幅1695 WB2525 トレッド1475
# ------------------------------------------------------------------
BODY_W  = 1.62            # ボディ幅(ミラー除く)
GH_W    = 1.44            # グリーンハウス(キャビン)幅
WHEELB  = 2.525
TREAD   = 1.475
TIRE_R  = 0.34            # タイヤ外径半径(デフォルメで少し大径に)
AXLE_F  =  WHEELB / 2     # +X が車両前方
AXLE_R  = -WHEELB / 2
WHEEL_Y = 0.71            # 車輪中心Y(フェンダー内に収まるよう実トレッドより内側)

# ------------------------------------------------------------------
# ユーティリティ
# ------------------------------------------------------------------
def clean_scene():
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete(use_global=False)
    for block in (bpy.data.meshes, bpy.data.materials):
        for b in list(block):
            if b.users == 0:
                block.remove(b)


def make_mat(name, color, metallic=0.0, rough=0.5, emission=None, e_strength=2.5,
             specular=None):
    """Principled BSDF マテリアル(ノードを種別で取得し 3.x/4.x 両対応)。"""
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    bsdf = next((n for n in nodes if n.type == 'BSDF_PRINCIPLED'), None)
    if bsdf is None:
        bsdf = nodes.new("ShaderNodeBsdfPrincipled")
        out = next((n for n in nodes if n.type == 'OUTPUT_MATERIAL'), None)
        if out is None:
            out = nodes.new("ShaderNodeOutputMaterial")
        mat.node_tree.links.new(bsdf.outputs[0], out.inputs[0])
    bsdf.inputs["Base Color"].default_value = (*color, 1.0)
    bsdf.inputs["Metallic"].default_value = metallic
    bsdf.inputs["Roughness"].default_value = rough
    if specular is not None:
        for key in ("Specular IOR Level", "Specular"):   # 4.x / 3.x 名称差
            if key in bsdf.inputs:
                bsdf.inputs[key].default_value = specular
                break
    if emission is not None:
        for key in ("Emission Color", "Emission"):
            if key in bsdf.inputs:
                bsdf.inputs[key].default_value = (*emission, 1.0)
                break
        if "Emission Strength" in bsdf.inputs:
            bsdf.inputs["Emission Strength"].default_value = e_strength
    return mat


def assign(obj, mat):
    obj.data.materials.clear()
    obj.data.materials.append(mat)


def add_bevel(obj, width=0.045, segs=3, angle=35):
    m = obj.modifiers.new("Bevel", "BEVEL")
    m.width = width
    m.segments = segs
    m.limit_method = 'ANGLE'
    m.angle_limit = math.radians(angle)


def shade_smooth(obj):
    for p in obj.data.polygons:
        p.use_smooth = True


def make_prism(name, profile_xz, width, y_center=0.0):
    """XZ平面のシルエットを Y方向に幅 width で押し出したソリッド。"""
    bm = bmesh.new()
    y0 = y_center - width / 2.0
    verts = [bm.verts.new((x, y0, z)) for (x, z) in profile_xz]
    face = bm.faces.new(verts)
    res = bmesh.ops.extrude_face_region(bm, geom=[face])
    ext = [e for e in res['geom'] if isinstance(e, bmesh.types.BMVert)]
    bmesh.ops.translate(bm, vec=(0.0, width, 0.0), verts=ext)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    mesh = bpy.data.meshes.new(name)
    bm.to_mesh(mesh)
    bm.free()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    return obj


def make_box(name, sx, sy, sz, loc, ry=0.0):
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=loc)
    obj = bpy.context.active_object
    obj.name = name
    obj.scale = (sx, sy, sz)
    if ry:
        obj.rotation_euler[1] = ry
    bpy.ops.object.transform_apply(scale=True)
    return obj


# ------------------------------------------------------------------
# シーン初期化(マテリアル生成より前に実行)
# ------------------------------------------------------------------
clean_scene()

# ------------------------------------------------------------------
# マテリアル
# ------------------------------------------------------------------
mat_body  = make_mat("Body_Turquoise", (0.04, 0.52, 0.70), metallic=0.8, rough=0.28)
mat_glass = make_mat("Glass_Smoke",    (0.008, 0.012, 0.022), metallic=0.0, rough=0.15,
                     specular=0.2)   # 白カブリ(空の映り込み)を抑える
mat_clad  = make_mat("Cladding_Black", (0.025, 0.025, 0.03), metallic=0.0, rough=0.65)
mat_tire  = make_mat("Tire",           (0.02, 0.02, 0.022), rough=0.92)
mat_rim   = make_mat("Rim_Silver",     (0.72, 0.73, 0.76), metallic=0.95, rough=0.22)
mat_dark  = make_mat("DarkMetal",      (0.08, 0.08, 0.09), metallic=0.6, rough=0.4)
mat_silver= make_mat("Silver_Trim",    (0.78, 0.79, 0.80), metallic=0.9, rough=0.3)
mat_head  = make_mat("Headlight",      (0.85, 0.9, 1.0), metallic=0.3, rough=0.1,
                     emission=(0.9, 0.95, 1.0), e_strength=1.5)
mat_tail  = make_mat("Taillight",      (0.5, 0.02, 0.02), rough=0.15,
                     emission=(0.9, 0.03, 0.03), e_strength=2.0)
mat_white = make_mat("White_Plate",    (0.9, 0.9, 0.9), rough=0.4)

# ------------------------------------------------------------------
# 1. ロワーボディ(側面シルエット → 押し出し → アーチをブーリアンで切削)
# ------------------------------------------------------------------
body_profile = [
    ( 1.95, 0.33),   # フロントバンパー下端
    ( 2.00, 0.52),   # バンパー面
    ( 1.99, 0.88),   # バンパー上端(グリル上)
    ( 1.88, 0.97),   # ボンネット先端
    ( 1.05, 1.09),   # カウル
    (-0.30, 1.13),   # ベルトライン中央(緩く上昇)
    (-1.60, 1.17),   # ベルトライン後端キック
    (-1.93, 1.11),   # リアショルダー
    (-2.00, 0.92),   # テールゲート上部
    (-2.00, 0.44),   # リアバンパー
    (-1.87, 0.32),   # サイドシル後
    ( 1.82, 0.32),   # サイドシル前
]
body = make_prism("Body", body_profile, BODY_W)
assign(body, mat_body)

# ホイールアーチ切削用シリンダー(前後 2本、左右貫通)
cutters = []
for tag, ax in (("F", AXLE_F), ("R", AXLE_R)):
    bpy.ops.mesh.primitive_cylinder_add(vertices=36, radius=0.41, depth=2.2,
                                        location=(ax, 0.0, TIRE_R))
    cut = bpy.context.active_object
    cut.name = f"ArchCut_{tag}"
    cut.rotation_euler[0] = math.radians(90)
    cut.display_type = 'WIRE'
    cut.hide_render = True
    cutters.append(cut)
    bmod = body.modifiers.new(f"Bool_{tag}", "BOOLEAN")
    bmod.object = cut
    bmod.operation = 'DIFFERENCE'

add_bevel(body, width=0.055, segs=3)   # ブーリアン後にベベル(アーチ縁も丸まる)
shade_smooth(body)

# ------------------------------------------------------------------
# 2. グリーンハウス(キャビン)= ボディ同色ブルー ※ルーフも青
# ------------------------------------------------------------------
gh_profile = [
    ( 0.98, 1.06),   # Aピラー基部(ボディに沈み込み)
    ( 0.40, 1.56),   # ルーフ前端
    (-1.45, 1.60),   # ルーフ後端(緩く後上がり)
    (-1.85, 1.08),   # リアゲート基部
]
gh = make_prism("Greenhouse", gh_profile, GH_W)
assign(gh, mat_body)
add_bevel(gh, width=0.05, segs=3)
shade_smooth(gh)

# 2b. サイドウィンドウ帯(左右貫通の1枚プリズム、両面に1.5cmずつ露出)
side_glass = make_prism("SideGlass", [
    ( 0.80, 1.11),
    ( 0.34, 1.50),
    (-1.36, 1.53),
    (-1.70, 1.11),
], GH_W + 0.03)
assign(side_glass, mat_glass)
add_bevel(side_glass, width=0.02, segs=2)
shade_smooth(side_glass)

# 2c. フロントガラス(Aピラー傾斜に沿わせた薄板)
ws = make_box("Windshield", 0.05, 1.32, 0.80,
              loc=(0.703, 0.0, 1.325), ry=math.radians(-49.2))
assign(ws, mat_glass)
shade_smooth(ws)

# 2d. リアガラス
rg = make_box("RearGlass", 0.05, 1.20, 0.60,
              loc=(-1.666, 0.0, 1.352), ry=math.radians(37.6))
assign(rg, mat_glass)
shade_smooth(rg)

# 2e. Bピラー(黒・左右)
for sy in (-1, 1):
    bp = make_box("BPillar", 0.06, 0.03, 0.40,
                  loc=(-0.28, sy * (GH_W + 0.03) / 2, 1.31))
    assign(bp, mat_clad)

# 2f. ルーフレール(黒・左右、ルーフ勾配に合わせ微傾斜)
for sy in (-1, 1):
    rail = make_box("RoofRail", 1.60, 0.05, 0.05,
                    loc=(-0.50, sy * 0.60, 1.595), ry=math.radians(1.3))
    assign(rail, mat_clad)

# 2g. リアスポイラー(ボディ同色・ルーフ後端に密着)
sp = make_box("Spoiler", 0.34, 1.26, 0.05,
              loc=(-1.58, 0.0, 1.60), ry=math.radians(-8))
assign(sp, mat_body)
add_bevel(sp, 0.02, 2)
shade_smooth(sp)

# ------------------------------------------------------------------
# 3. 車輪(タイヤ=トーラス+リム)と樹脂フェンダーアーチ
# ------------------------------------------------------------------
def make_wheel(tag, x, y):
    # タイヤ(トーラス: 外径 = TIRE_R)
    bpy.ops.mesh.primitive_torus_add(major_radius=0.26, minor_radius=0.08,
                                     location=(x, y, TIRE_R),
                                     rotation=(math.radians(90), 0, 0))
    tire = bpy.context.active_object
    tire.name = f"Tire_{tag}"
    tire.scale = (1.0, 1.0, 0.65)   # サイドウォールを薄く(X90°回転後はローカルZが車幅方向)
    bpy.ops.object.transform_apply(scale=True)
    assign(tire, mat_tire)
    shade_smooth(tire)
    # リム(シルバー)
    bpy.ops.mesh.primitive_cylinder_add(vertices=24, radius=0.20, depth=0.15,
                                        location=(x, y, TIRE_R),
                                        rotation=(math.radians(90), 0, 0))
    rim = bpy.context.active_object
    rim.name = f"Rim_{tag}"
    assign(rim, mat_rim)
    shade_smooth(rim)
    # ダーク内周(奥行き表現)
    bpy.ops.mesh.primitive_cylinder_add(vertices=24, radius=0.145, depth=0.16,
                                        location=(x, y, TIRE_R),
                                        rotation=(math.radians(90), 0, 0))
    inner = bpy.context.active_object
    inner.name = f"RimInner_{tag}"
    assign(inner, mat_dark)
    # ハブ(シルバー)
    bpy.ops.mesh.primitive_cylinder_add(vertices=16, radius=0.05, depth=0.17,
                                        location=(x, y, TIRE_R),
                                        rotation=(math.radians(90), 0, 0))
    hub = bpy.context.active_object
    hub.name = f"Hub_{tag}"
    assign(hub, mat_rim)


for tag, ax in (("F", AXLE_F), ("R", AXLE_R)):
    for sy in (-1, 1):
        side = 'L' if sy < 0 else 'R'
        make_wheel(f"{tag}{side}", ax, sy * WHEEL_Y)

# ------------------------------------------------------------------
# 4. 黒樹脂・シルバーの外装ディテール
# ------------------------------------------------------------------
# フロントバンパー下部(黒)
fb = make_box("FrontBumperLow", 0.24, BODY_W - 0.04, 0.18, loc=(1.90, 0, 0.38))
assign(fb, mat_clad); add_bevel(fb, 0.03, 2)
# フロントグリル(黒・台形風の大型)
gr = make_box("Grille", 0.08, 0.90, 0.34, loc=(1.97, 0, 0.66))
assign(gr, mat_clad); add_bevel(gr, 0.02, 2)
# バンパーコーナーベゼル(黒)+ DRL(白)
for sy in (-1, 1):
    bz = make_box("CornerBezel", 0.14, 0.24, 0.34, loc=(1.94, sy * 0.60, 0.58))
    assign(bz, mat_clad); add_bevel(bz, 0.02, 2)
    drl = make_box("DRL", 0.02, 0.16, 0.04, loc=(2.005, sy * 0.60, 0.70))
    assign(drl, mat_head)
# スキッドガーニッシュ(シルバー・前後)
sk_f = make_box("SkidF", 0.10, 0.60, 0.10, loc=(1.99, 0, 0.34))
assign(sk_f, mat_silver)
sk_r = make_box("SkidR", 0.08, 0.60, 0.10, loc=(-2.00, 0, 0.38))
assign(sk_r, mat_silver)
# リアバンパー下部(黒)
rb = make_box("RearBumperLow", 0.18, BODY_W - 0.04, 0.26, loc=(-1.94, 0, 0.44))
assign(rb, mat_clad); add_bevel(rb, 0.03, 2)
# サイドシル(黒・左右)
for sy in (-1, 1):
    sill = make_box("Sill", 1.55, 0.06, 0.10, loc=(0, sy * 0.80, 0.35))
    assign(sill, mat_clad)
# ドアハンドル(シルバー・前後×左右)
for hx, hz in ((0.30, 1.02), (-0.75, 1.04)):
    for sy in (-1, 1):
        h = make_box("Handle", 0.18, 0.04, 0.05, loc=(hx, sy * 0.80, hz))
        assign(h, mat_silver)

# ------------------------------------------------------------------
# 5. ライト・エンブレム・ナンバープレート
# ------------------------------------------------------------------
for sy in (-1, 1):
    # 薄型ヘッドライト(ダーク基調の筐体をボンネット先端コーナーに埋め込み)
    hl = make_box("Head", 0.22, 0.36, 0.08, loc=(1.87, sy * 0.62, 0.92))
    assign(hl, mat_dark); add_bevel(hl, 0.02, 2)
    # ライトレンズ(白発光の細ストリップを筐体前面に)
    lens = make_box("HeadLens", 0.02, 0.30, 0.045, loc=(1.975, sy * 0.60, 0.92))
    assign(lens, mat_head)
    # 縦型テールライト(リアコーナー埋め込み)
    tl = make_box("Tail", 0.06, 0.20, 0.24, loc=(-2.00, sy * 0.66, 1.02))
    assign(tl, mat_tail); add_bevel(tl, 0.02, 2)

# エンブレム(シルバー楕円)
bpy.ops.mesh.primitive_cylinder_add(vertices=24, radius=0.055, depth=0.04,
                                    location=(2.0, 0, 0.80),
                                    rotation=(0, math.radians(90), 0))
emb = bpy.context.active_object
emb.name = "Emblem"
emb.scale = (1.0, 1.0, 0.7)
bpy.ops.object.transform_apply(scale=True)
assign(emb, mat_silver)
shade_smooth(emb)

# フロントナンバープレート
pl = make_box("Plate", 0.02, 0.33, 0.17, loc=(2.03, 0, 0.40))
assign(pl, mat_white)

# ドアミラー(黒・ステー付きでボディに接続)
for sy in (-1, 1):
    stalk = make_box("MirrorStalk", 0.06, 0.13, 0.05, loc=(0.70, sy * 0.855, 1.17))
    assign(stalk, mat_clad)
    head = make_box("MirrorHead", 0.09, 0.14, 0.13, loc=(0.70, sy * 0.90, 1.21))
    assign(head, mat_clad); add_bevel(head, 0.025, 2)

# ------------------------------------------------------------------
# 6. 地面・ライティング・カメラ(写真と同じ左前方 3/4 ビュー)
# ------------------------------------------------------------------
bpy.ops.mesh.primitive_plane_add(size=40, location=(0, 0, 0))
ground = bpy.context.active_object
ground.name = "Ground"
assign(ground, make_mat("Ground", (0.82, 0.82, 0.83), rough=0.95))

bpy.ops.object.light_add(type='SUN', location=(6, 5, 9))
sun = bpy.context.active_object
sun.data.energy = 3.0
sun.data.angle = math.radians(12)      # ソフトシャドウ
sun.rotation_euler = (math.radians(50), 0, math.radians(160))

# カメラ: 左フロント 3/4(参考写真と同アングル)、注視点をトラック
tgt = bpy.data.objects.new("CamTarget", None)
bpy.context.collection.objects.link(tgt)
tgt.location = (0, 0, 0.72)

bpy.ops.object.camera_add(location=(5.2, 4.0, 2.1))
cam = bpy.context.active_object
cam.data.lens = 40
tc = cam.constraints.new('TRACK_TO')
tc.target = tgt
tc.track_axis = 'TRACK_NEGATIVE_Z'
tc.up_axis = 'UP_Y'
bpy.context.scene.camera = cam

# ワールド(明るいショールーム風)
world = bpy.context.scene.world or bpy.data.worlds.new("World")
bpy.context.scene.world = world
world.use_nodes = True
bg = next((n for n in world.node_tree.nodes if n.type == 'BACKGROUND'), None)
if bg:
    bg.inputs[0].default_value = (0.75, 0.76, 0.78, 1.0)
    bg.inputs[1].default_value = 0.9

print("完了: スタイライズ版 ライズ (v2) を生成しました。")
