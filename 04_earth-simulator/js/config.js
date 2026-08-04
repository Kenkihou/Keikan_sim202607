// =========================================================================
// 設定
// =========================================================================
// PLATEAU の対象 tileset（京都市 全11区の建築物モデル）。区ごとに tileset があるので配列で持つ。
// 3d-tiles-renderer は視錐台（フラストラム）外のタイルを読み込まないので、区ごとに
// TilesRenderer を作れば「カメラが向いた区・タイルだけ順次ロード」が自動で実現する。
// 起動時に読むのは各区の root tileset.json（小さい JSON）だけで、建物本体(b3dm)は
// 視界に入って初めて DL される。
//   ・LOD2 が配信されている9区は LOD2、未配信の2区(山科26110・西京26111)は LOD1 で補完。
//   ・URL一覧の取得:
//     LOD2: curl -s "https://api.plateauview.mlit.go.jp/datacatalog/3dtiles/26100-bldg-lod2-latest/tileset.json"
//     LOD1: 上記の -lod2- を -lod1- に。（他都市は 26100 を対象都市の5桁コードに）
// 【2層構成】広域が現実的な時間で埋まるようにするための最重要設計。
//   実測: LOD2の葉タイルは1枚5〜7MB と極端に重く、広域ビューでは必要タイル数が
//   errorTarget をいくら上げても減らない（階層最上位まで粗くなりきっているため）。
//   → 削減できるのは「枚数」ではなく「1枚あたりのバイト数」。LOD1 は同一タイルで
//     2.4〜3.6倍軽い（例: 6.88MB→2.88MB, 324KB→98KB）。
//   そこで LOD1 を全域の常時ベースにし、LOD2 は注視点の近傍だけに限定する。
const A = 'https://assets.cms.plateau.reearth.io/assets/';
const P = '/26100_kyoto-shi_city_2025_citygml_1_op_bldg_3dtiles_';

// ベース層: LOD1（全11区・距離制限なし）。軽いので広域でも徐々に埋まる。
export const TILESET_URLS_LOD1 = [
  A + 'e7/2aaaf0-1ab3-40e8-af5b-db3310fb4f15' + P + '26101_kita-ku_lod1/tileset.json',        // 北区
  A + '7f/4d517a-10cc-4489-b1b2-5c754caa0561' + P + '26102_kamigyo-ku_lod1/tileset.json',     // 上京区
  A + '95/ec9c15-9c08-4c97-b073-029636f84818' + P + '26103_sakyo-ku_lod1/tileset.json',       // 左京区
  A + '65/c601e9-7ba9-42f2-8400-bd1ec5282421' + P + '26104_nakagyo-ku_lod1/tileset.json',     // 中京区
  A + 'ce/6e26ee-9c98-4df7-bc06-4ea5049162c3' + P + '26105_higashiyama-ku_lod1/tileset.json', // 東山区
  A + '64/f8be59-d43b-47fe-a7f0-ce936ae5bc8e' + P + '26106_shimogyo-ku_lod1/tileset.json',    // 下京区(京都駅)
  A + 'af/70c122-184c-46e7-8200-056f326851a9' + P + '26107_minami-ku_lod1/tileset.json',      // 南区
  A + '1c/369350-e66e-4526-bdb0-ff014a15460e' + P + '26108_ukyo-ku_lod1/tileset.json',        // 右京区
  A + 'd2/d06236-cb09-4229-a086-469dac391966' + P + '26109_fushimi-ku_lod1/tileset.json',     // 伏見区
  A + 'ac/8c8272-b229-42b9-8091-fcace8039948' + P + '26110_yamashina-ku_lod1/tileset.json',   // 山科区
  A + 'e4/bab58f-04c7-4673-a6c0-e36f58f5237f' + P + '26111_nishikyo-ku_lod1/tileset.json',    // 西京区
];

// LOD2 が配信されている9区（山科・西京は LOD2 が無い）。
export const TILESET_URLS_LOD2 = [
  A + '7a/918715-89fb-4f45-a48a-a77ee6288577' + P + '26101_kita-ku_lod2/tileset.json',        // 北区
  A + '71/0af6ab-875e-4c69-bb5e-9e06096e6fcb' + P + '26102_kamigyo-ku_lod2/tileset.json',     // 上京区
  A + '96/d17b9d-5527-4610-90c8-9e9c44d500c3' + P + '26103_sakyo-ku_lod2/tileset.json',       // 左京区
  A + '04/eaac56-936e-49e2-a91b-0db31a6ed192' + P + '26104_nakagyo-ku_lod2/tileset.json',     // 中京区
  A + '25/dd4c50-5342-4a0b-ac51-05ffb138b8b5' + P + '26105_higashiyama-ku_lod2/tileset.json', // 東山区
  A + 'f0/2ed501-5480-4ccb-8293-9469a3856f9a' + P + '26106_shimogyo-ku_lod2/tileset.json',    // 下京区(京都駅)
  A + '1c/596e87-af58-4394-a4e7-ef429ba5732c' + P + '26107_minami-ku_lod2/tileset.json',      // 南区
  A + '64/cf6354-e5ff-4ee4-84d6-1751734da17c' + P + '26108_ukyo-ku_lod2/tileset.json',        // 右京区
  A + '6c/10f912-836b-483d-a6b2-881e298d7006' + P + '26109_fushimi-ku_lod2/tileset.json',     // 伏見区
];

// この緯度経度を原点(0,0,0)・上方向を +Y に据える。
// → 自作の Three.js モデルは、この地点を基準に「メートル単位」で配置できる。
export const DEG2RAD = Math.PI / 180;
export const ORIGIN_LAT = 34.985849 * DEG2RAD;   // 京都駅
export const ORIGIN_LON = 135.758766 * DEG2RAD;
// 原点(Y=0)に据える「楕円体高[m]」。この地点の地盤の楕円体高を入れると、地表が Y=0 になり
// 自作モデルを Y=0 基準で地面に置けるようになる（京都駅周辺の実測値。下部の解説参照）。
export const ORIGIN_HEIGHT = 64;

// 原点の「標高[m]」（＝国土地理院の言う標高。楕円体高とは別物なので注意）。
//   ORIGIN_HEIGHT は楕円体高（GRS80楕円体基準）、標高はジオイド（ほぼ平均海水面）基準。
//   日本付近はジオイド高が+36〜39m程度あるため、楕円体高64mでも標高は20m台になる
//   （実測: 国土地理院の標高API で 28.3m。京都駅は実際に標高20m台）。
//   土の断面を「標高0m（海水準）まで」描くための基準として使う。
//   求め方: curl "https://cyberjapandata2.gsi.go.jp/general/dem/scripts/getelevation.php?lon=経度&lat=緯度&outtype=JSON"
export const ORIGIN_ELEVATION = 28.3;
// 標高0m（海水準）に相当するローカルY座標（原点の地表=Y0 からこの分だけ下）。
export const SEA_LEVEL_Y = -ORIGIN_ELEVATION;

// --- 地形（PLATEAU Terrain / Quantized Mesh）---------------------------------
// 認証不要・CORS 開放。建物と「同じ緯度経度の ReorientationPlugin」で整列させるので、
// 建物は自動的に地形の標高（地盤高さ）の上に載る。
export const SHOW_TERRAIN = true;
export const TERRAIN_URL = 'https://tile.plateauview.mlit.go.jp/terrain/layer.json';
// 建物と地形の鉛直方向の微調整[m]（ジオイド差などで両者がずれて見える場合のみ触る。通常0）。
export const TERRAIN_VERTICAL_OFFSET = 0;

// --- 局所描画（9タイル相当・矩形）--------------------------------------------
// 「注目地点の周り＝約3×3タイルぶんの建物だけ」を描画して、広域は捨てて高速化する方針。
// PLATEAU LOD2 の葉タイルは実測で約 500m(東西) × 330m(南北)。円形(Sphere)マスクだと
// タイル境界が不規則なため選ばれる範囲がいびつな塊になるので、東西・南北を別々に
// 指定できる「矩形（OBB）マスク」にしている。地形は制限しない。
//   ・注目地点は既定で原点（自作モデルの位置）。小窓の地図で任意地点へ移せる。
//   ・値は「全幅」。3×3タイル分の目安 = 東西 1500m・南北 1000m 程度。
// 読み込む範囲は「指定地点を中心とした 500m 四方」。切り抜き箱の最大が 500m 四方なので
// これで過不足なく、1km 四方だったときに比べて面積が 1/4＝読むタイル数も大幅に減る。
// 交差判定なので境界に跨る場合もその全タイルが読まれ、取りこぼしは起きない。
export const LOCAL_WIDTH_EW = 500;   // 東西の全幅[m]
export const LOCAL_WIDTH_NS = 500;   // 南北の全幅[m]
export const LOCAL_HEIGHT = 4000;    // 鉛直方向は建物・地形の高低差を十分covers（実質無制限）

// ★2段階ロード（第1段: 指定地点を含む1枚だけ → 第2段: 500m四方）
//   第1段では矩形をほぼ点まで縮める。マスクは「タイルの境界体積と交差するか」で判定するので、
//   点にすると【その点を含むタイルだけ】が選ばれる＝各階層で1枚ずつ、実質「指定地点の
//   タイル1枚とその祖先」だけを読む。葉タイルは約500×330mあるので、これ1枚でも
//   指定地点まわりはかなり埋まる。届いたら第2段に進んで足りない周辺タイルを足す。
//   ⚠️ 鉛直は縮めてはいけない。タイルの境界体積は実標高の位置にあるので、
//      高さを潰すと標高のずれで交差しなくなり1枚も選ばれなくなる。
export const SEED_WIDTH = 2;          // 第1段の東西・南北の全幅[m]（実質ゼロ。0だと退化して不安定）
export const SEED_IDLE_MS = 700;      // キューが空のままこれだけ続いたら第1段完了とみなす
export const SEED_TIMEOUT_MS = 12000; // 第1段が終わらなくても、これだけ経ったら第2段へ進む

// カメラを引ける上限[m]（注視点からの距離）。
//   建物は注目地点まわりの局所しか読まないが、地形・眺望空間保全地域・眺望規制の標高面は
//   1辺が数km あるので、広域を確認するために引けるようにしている。
export const MAX_CAMERA_DISTANCE = 4000;

// 眺望空間保全地域（京都市の眺望景観保全地域。五山送り火などの眺めを守る区域）。
//   元データは 眺望shapeデータ/眺望空間保全地域.shp（EPSG:2448＝平面直角座標系第VI系）。
//   scratchpad の shp2json.py で WGS84 経緯度の JSON に変換したものを読む
//   （ブラウザに shp パーサと投影変換を持ち込まずに済む）。
export const VIEW_AREA_URL = '眺望空間保全地域.json';
export const VIEW_AREA_FILL_COLOR = 0x18c8a8;
export const VIEW_AREA_FILL_OPACITY = 0.3;
export const VIEW_AREA_LINE_COLOR = 0x0affd8;
export const VIEW_AREA_LINE_WIDTH = 3;
// ★ 眺望空間保全地域は【建物タイルの読み込み範囲に関係なく全域を描く】。
//   以前は注目地点から半径1500mだけに絞っていたが、全12地域は 12.8km×7.7km に散らばって
//   いるので、広域を確認したいときにほとんど描かれなかった。
//   地形の高さグリッドは「格子サイズではなく地形三角形の走査」でコストが決まるので、
//   範囲を広げても安い（実測: 半径10km・15mセル で 72ms / 6.8MB）。
//   VIEW_AREA_MAX_RADIUS は暴走止め。全ポリゴンを覆うのに必要な半径がこれを超えたら打ち切る。
export const VIEW_AREA_MAX_RADIUS = 12000;
// 高さグリッドの一辺の最大ノード数。範囲が広いときはセルを粗くして総ノード数を抑える。
//   ⚠️ 粗くしても精度はほとんど落ちない（実測の「格子と実際の地形の差」の最大値:
//     5m=0.42m / 10m=0.75m / 15m=1.28m / 20m=1.42m / 30m=1.73m）。
export const VIEW_AREA_GRID_MAX_SIDE = 1400;
// ポリゴンを地形に沿わせる精度。★「高さの取得」と「三角形の分割」を分けるのが要点。
//   以前は両方 20m で共通にしていたが、起伏のある土地では粗すぎて
//   【三角形の内部が最大22m も地形から浮く】＝建物より高い位置にポリゴンが乗ってしまった。
//   ・GRID_CELL … 地形の高さを焼き込むグリッドの目。細かいほど正確だがメモリと生成時間が増える。
//   ・MAX_EDGE  … 三角形の最大辺。平坦地はこの大きさのままでよい。
//   ・HEIGHT_TOL… 辺の中点で「地形からのずれ」がこれを超えたら更に分割する。
//     一律に細かくするのではなく【急な場所だけ細かくする】ので、枚数を抑えたまま密着する。
export const VIEW_AREA_GRID_CELL = 5;    // 高さグリッドのセル[m]
export const VIEW_AREA_MAX_EDGE = 24;    // 三角形の最大辺[m]
// 実測（岩倉付近・半径1500m・起伏のある土地）:
//   分割条件            三角形数   生成ms  重心での浮き最大
//   辺20m一律（旧）      123,200      ?      22.1m  ← 建物より高く浮いていた
//   tol 0.6 / 最小辺 4   300,904     150      2.11m
//   tol 0.4 / 最小辺 3   342,550     190      1.74m  ← 採用（枚数13%増で誤差が改善）
export const VIEW_AREA_HEIGHT_TOL = 0.4; // 許容する高さのずれ[m]
export const VIEW_AREA_MIN_EDGE = 3;     // これ以下には分割しない[m]（際限なく細かくならないように）
export const VIEW_AREA_MAX_TRIS = 400000; // 三角形数の暴走止め（張り付くなら TOL を緩めるか半径を縮める）
// 地形からわずかに浮かせる[m]。
//   ★ Z ファイト対策は「浮かせ量」と「polygonOffset」で役割を分ける。
//     ・浮かせ量はワールド単位なので、深度で見た余裕は距離の2乗で痩せる＝【遠距離に弱い】。
//       一方で近くでは実際に浮いて見えるし、大きくすると建物がポリゴンの下に埋まる。
//     ・polygonOffset の単位は「深度バッファの最小分解能(1LSB)」なので、
//       遠方ほど自動的に大きくなる＝【遠距離に強く、しかもワールド上は浮かない】。
//     → 近〜中距離を浮かせ量、遠方を polygonOffset に担当させるのが正解。
//   実測（3姿勢・地形に勝つ最悪値 / 見えている建物が埋まる割合）:
//     浮かせ0・offset無効 : 69.0% / 1.07%（＝埋まりの下限。地盤より低いPLATEAU建物ぶん）
//     浮かせ0.2m          : 99.4% / 2.79%
//     浮かせ0.3m          : 99.8% / 3.09%   ← 採用
//     浮かせ0.4m          : 99.9% / 3.41%
//     浮かせ1.0m          : 99.8% / 5.10%（明らかに浮き過ぎ）
export const VIEW_AREA_LIFT = 0.3;

// --- 眺望規制の「標高面」-------------------------------------------------------
// 眺望空間保全地域は、実務上は【建物の標高規制】のためのエリア。
// 例（賀茂川右岸からの「大文字」）:
//   視点場 = 賀茂川右岸の河川敷（点A 標高67.683m 〜 点B 標高49.487m の線）
//   視対象 = 「大」の字の底辺 a-b（両端とも標高290.986m）
//   標高面 = 「視点場上の任意の点＋1.5m」と a・b の3点で張る三角形の面（Pが動くので平面族）
//   規制   = 建築物の各部分がこの標高面を超えてはならない
// つまり「見通し線の天井面」で、川べり51mから山側291mへ立ち上がる斜面になる。
//
// 面は 規制値等高線.shp（公式）から contour2surface.py で経緯度の規則格子に変換してある:
//   python contour2surface.py 眺望shapeデータ 眺望規制面.json
// 検算: 書き出した格子を元の等高線と照合して 中央0.18m / p90 1.08m / 89%が1m以内。
export const VIEW_LIMIT_URL = '眺望規制面.json';
export const VIEW_LIMIT_COLOR = 0xff9a3c;
export const VIEW_LIMIT_OPACITY = 0.28;
// ★ 距離による絞り込みはしない（12地域すべてを常に描く）。標高面は【格子JSONだけ】から
//   作れて地形にも建物タイルにも依存しないので、JSON が届いた時点で完成形を1回作れば
//   以後どこへ移動しても作り直す必要がない（＝ページ読込直後から全域が揃う）。
//   全域でも 12地域 / 約3万面 / 約60ms と安く、地形沿わせのポリゴンとは桁が違う。
// 面の分割。★ 格子セル単位で面を作ると【縁が格子に量子化されてガタガタになる】ので、
//   規制範囲の輪郭を三角形分割し、高さだけを格子から引く（＝縁は輪郭そのまま）。
//   分割は眺望ポリゴンの地形沿わせと同じ「最長辺の二分割＋高さ誤差で打ち切り」。
//   標高面は滑らかなので、地形沿わせよりずっと粗い分割で足りる。
export const VIEW_LIMIT_MAX_EDGE = 200;    // 三角形の最大辺[m]
export const VIEW_LIMIT_MIN_EDGE = 15;     // これ以下には分割しない[m]
export const VIEW_LIMIT_HEIGHT_TOL = 0.3;  // 許容する高さのずれ[m]

// --- 地形に貼る「ゾーンレイヤー」（風致地区・自然風景保全地区）-------------------
// 眺望空間保全地域と同じ「地形に沿わせて貼る」方式だが、規模が桁違いに大きい:
//   眺望空間保全地域   …  12面 /  3,996頂点 /   8.7 km²
//   風致地区          … 271面 / 66,652頂点 / 179.5 km²（うち第1種だけで 149.5 km²）
//   自然風景保全地区   …  21面 / 34,617頂点 / 259.9 km²（面は少ないが1枚が巨大）
// 元データは EPSG:2448 の .shp。zone2json.py で WGS84 の JSON に変換する:
//   python zone2json.py 眺望shapeデータ/風致地区.shp 風致地区.json 1.0
//   python zone2json.py 眺望shapeデータ/自然風景保全地区.shp 自然風景保全地区.json 1.0
//   （Douglas-Peucker で 1m 間引き。穴と種別も出力する）
//
// ★ 三角形数を決めているのは「許容ずれ」ではなく【最大辺】だった（実測）。
//   最大辺37m のまま許容ずれを 0.4m→5m と緩めても 229万→145万 にしか減らないのに、
//   最大辺を 37m→80m にすると 45万まで落ちる。面積で効く量なので当然だが、
//   「山地だから許容ずれを緩めれば軽くなる」という直感は外れる。
// 実測（全域 20.8×25.9km・5種別すべて。浮きは三角形の重心で測った値）:
//   セル / 最大辺 / 許容ずれ  三角形     生成    浮き中央 / p90 / 最大
//   18.6 /  37 / 1.5m       1,584,732   471ms   0.00 / 0.57 /  7.9m
//   28.9 /  58 / 2.3m         773,529   234ms   0.03 / 1.10 /  7.0m  ← 採用
//   40.0 /  80 / 3.2m         453,624   182ms   0.12 / 1.67 / 10.0m
//   52.0 / 104 / 4.2m         302,295    92ms   0.23 / 2.27 / 17.8m
// 描画コストは 77万三角形で +0.8ms/フレーム（116fps→106fps）と安い。
// 高さグリッドの一辺の最大セル数。眺望ポリゴン(1400)より粗いのは面積が20倍あるため。
export const ZONE_GRID_MAX_SIDE = 900;
export const ZONE_GRID_CELL = 5;        // 切り抜きONのときはここまで細かくなる
export const ZONE_MAX_EDGE = 24;        // 三角形の最大辺の下限[m]（実際は max(これ, セル×2)）
export const ZONE_MIN_EDGE = 3;
export const ZONE_HEIGHT_TOL = 0.4;     // 許容する高さのずれの下限[m]（実際は max(これ, セル×0.08)）
// 暴走止め（1レイヤーあたり）。⚠️ これは異常時の保険であって品質目標ではないので、
//   通常運用で張り付かない値にすること。自然風景保全地区(259.9km²)は全域で約130万枚
//   必要なので、1,200,000 にしていたら常に張り付いて【残りが粗いまま出て】いた。
export const ZONE_MAX_TRIS = 2500000;
export const ZONE_MAX_RADIUS = 18000;   // 全域でも 13〜15km ほどなので余裕を持たせる
export const ZONE_LIFT = 0.3;           // 眺望ポリゴンと同じ（Zファイト対策の根拠はそちら参照）
export const ZONE_FILL_OPACITY = 0.34;
export const ZONE_LINE_WIDTH = 1.5;
// 外周線を面より上に置く量[m]。
//   ⚠️⚠️ ここを「面の浮かせ量 × 1.5」のような【倍率】にしてはいけない。
//     浮かせ量は飛び出し格子のぶん場所によって数十mまで増えるので、倍率だと
//     その 0.5 倍がそのまま線と面の隙間になり、【線だけ宙に浮いて見える】
//     （実測: 線−面の高さ差が p90 3.8m・最大 47.5m。破線にすると特に目立った）。
//   線が面に埋もれないようにするのは polygonOffsetUnits（深度バッファ側）の役目なので、
//   幾何的な差はZファイトを避けるだけの最小値でよい。
export const ZONE_LINE_LIFT = 0.02;
// レイヤーが重なる所で「どちらが手前か」を安定させるための段差[m]。
//   ★ 風致地区と自然風景保全地区は山地で大きく重なる。同じ高さに置くと
//     Z ファイトでまだら模様になるので、ZONE_LAYERS の後ろのレイヤーほど手前に置く。
//     深度バッファ側でも polygonOffsetUnits を段違いにして、遠方でも順序が崩れないようにする。
//   ※ 幾何的な段差が要るのは近距離だけ（遠距離は polygonOffset が担当）なので小さくてよい。
//     レイヤーが増えるほど最後のレイヤーが浮くので、増やしたら建物の埋まり具合を見直すこと
//     （浮かせ量と埋まる割合の実測は「Z ファイト対策」の表を参照）。
//     （5レイヤーなら最後は 0.3 + 0.06×4 = 0.54m 浮く）
export const ZONE_STACK_GAP = 0.06;

// レイヤーの定義。追加したいときはここに1行足すだけでよい
// （HUD のチェック・凡例・描画・統計はすべてこの配列から組み立てる）。
//   id      … DOM の id と userData のキーに使う識別子
//   kinds   … 種別ごとの色。line は fill を暗くしたもの（外周線が面に埋もれないように）
//   opacity … 面の不透明度（省略時 ZONE_FILL_OPACITY）
//   group   … 同じ文字列を持つ【連続した】レイヤーを HUD で1つにまとめる。
//     マスターのチェックは1つになり、凡例には
//       ・種別を持つレイヤー … 種別ごとの行
//       ・種別を持たないレイヤー … そのレイヤー自身の行（rowLabel があればそれを使う）
//     が【config の並び順どおり】に並ぶ。まとめても描画・生成は今までどおり独立。
//   rowLabel … グループの凡例に出す短い名前（省略時は label）
//   dash / lineWidth … 外周線を破線にする（{dashSize, gapSize} はワールド単位[m]）／線の太さ
//   hatch   … 指定すると【塗りつぶしではなく斜線ハッチ】で描く。
//     ★ 重ね指定を表現するための仕掛け。半透明の面塗り同士を重ねると混色になり、
//       「2つの指定が重なっている」のか「別の1色の区域」なのか区別できない。
//       片方を線の隙間が空いたハッチにすれば、下のレイヤーの色が隙間から見えて
//       【重なりがそのまま読める】。地図表現としての定石でもある。
//     periodPx … 縞の間隔[画面px] / widthPx … 線の太さ[画面px]
//     angle … 角度[度]。`angles: [0, 90]` のように配列で渡すと【クロスハッチ】になる
//       （各方向の縞の和集合。0=縦線・90=横線・45=右上がりの斜線）
//     ※ 画面ピクセル基準なので、ズームしても縞の見え方が変わらない（＝遠景でも潰れない）。
//       地形に貼り付いた模様にしたいならワールド座標基準にもできるが、
//       広域では縞が細かくなりすぎてモアレになるので採らない。
//   ※ 配列の【後ろのレイヤーほど手前】に描く（ZONE_STACK_GAP ぶん持ち上がる）。
export const ZONE_LAYERS = [
  {
    id: 'fuchi', uiOrder: 3, label: '風致地区', url: '風致地区.json',
    group: '風致地区',
    // 京都市の風致地区の凡例に合わせた配色（緑・水色・黄色・紫・ピンク）
    kinds: [
      { kind: 1, label: '第1種', fill: 0x9ae5a0, line: 0x3f9152 },
      { kind: 2, label: '第2種', fill: 0x8fdcf2, line: 0x2f86a8 },
      { kind: 3, label: '第3種', fill: 0xfbf59b, line: 0xa89a34 },
      { kind: 4, label: '第4種', fill: 0xe6b3f0, line: 0x9350a5 },
      { kind: 5, label: '第5種', fill: 0xffb3cd, line: 0xb54f76 },
    ],
  },
  {
    // ★ 風致地区の一部なので、HUD では風致地区と同じまとまりに入れて第5種の直下に並べる。
    //   描画・生成は独立したレイヤーのまま（group は見せ方だけの指定）。
    id: 'fuchiShukei', uiOrder: 3, label: '風致地区特別修景地域', rowLabel: '特別修景地域',
    url: '風致地区特別修景地域.json', group: '風致地区',
    // 風致地区の中で更に厳しい地域。風致地区（塗りつぶし）の上に濃い赤の斜線を重ねる。
    // ※ 面ごとに名前が違う（「銀閣寺周辺特別修景地域」など106面）が種別は1つ。
    hatch: { periodPx: 9, widthPx: 3, angle: 45 },
    opacity: 0.72,
    kinds: [
      { kind: null, label: '風致地区特別修景地域', fill: 0xc42b2b, line: 0x8e1d1d },
    ],
  },
  {
    id: 'bikan', uiOrder: 1, label: '美観地区', url: '美観地区.json',
    // ★ 種別は名称からではなく属性 `LEGEND_COD`（凡例コード）から取る。
    //   変換: python zone2json.py 眺望shapeデータ/美観地区.shp 美観地区.json 1.0 LEGEND_COD
    //   このコードが京都市の凡例そのものの粒度なので、細かい地区名
    //   （「祇園町南歴史的景観保全修景地区」「上京小川…」など）が自動的にまとまる:
    //     220 ← 歴史的景観保全修景地区 3種類 / 250 ← 界わい景観整備地区 8種類
    //   名称の文字列から機械的に導くより確実。
    kinds: [
      { kind: 110, label: '山ろく型', fill: 0x9fbcd6, line: 0x5b7fa0 },
      { kind: 120, label: '山並み背景型', fill: 0xe2d9ee, line: 0x9d8fb5 },
      { kind: 130, label: '岸辺型', fill: 0xc2f2ee, line: 0x63b3ad },
      { kind: 140, label: '旧市街地型', fill: 0xf5cbe8, line: 0xbe73a4 },
      { kind: 210, label: '歴史遺産型 一般地区', fill: 0xdde87f, line: 0x9aa73c },
      { kind: 220, label: '歴史遺産型 歴史的景観保全修景地区', fill: 0xcbc46a, line: 0x8d872f },
      { kind: 250, label: '歴史遺産型 界わい景観整備地区', fill: 0x2eb54e, line: 0x1b7733 },
      // 以下3区分は「美観地区」ではなく「美観形成地区」系（沿道型美観地区を含む）。
      // ⚠️ 下2つはどちらも「ほぼ白のクリーム色」で塗りだけでは見分けが付きにくいので、
      //   外周線の色ではっきり差を付けている。
      { kind: 401, label: '沿道型美観地区', fill: 0xfbc832, line: 0xb0870f },
      { kind: 410, label: '市街地型美観形成地区', fill: 0xfdf8e3, line: 0xb5a86e },
      { kind: 421, label: '沿道型美観形成地区', fill: 0xf8f0cd, line: 0x9c8c45 },
    ],
  },
  {
    id: 'kenzou', uiOrder: 2, label: '建造物修景地区', url: '建造物修景地区.json',
    // 種別は `MEISHOU`（ちょうど4区分＝凡例そのもの）。数値でない属性でも kind に使える。
    //   変換: python zone2json.py 眺望shapeデータ/建造物修景地区.shp 建造物修景地区.json 1.0 MEISHOU
    kinds: [
      { kind: '山ろく型建造物修景地区', label: '山ろく型', fill: 0xf8d3ab, line: 0xb98442 },
      { kind: '山並み背景型建造物修景地区', label: '山並み背景型', fill: 0xc4f04e, line: 0x77a316 },
      { kind: '岸辺型建造物修景地区', label: '岸辺型', fill: 0xa8adea, line: 0x5a60b8 },
      { kind: '町並み型建造物修景地区', label: '町並み型', fill: 0xd99cf0, line: 0x9147ac },
    ],
  },
  {
    id: 'denken', uiOrder: 6, label: '伝統的建造物群保存地区', url: '伝統的建造物群保存地区.json',
    // 種別は `CHIKUMEI`（地区名）。4地区とも凡例は同じなので色も全部同じにする。
    //   変換: python zone2json.py "眺望shapeデータ/伝統的建造物群保存地区（景観保全）.shp" \
    //          伝統的建造物群保存地区.json 1.0 CHIKUMEI
    // 京都市の凡例が【ピンクの破線の枠】なので、外周線を破線にして少し太くする。
    //   dashSize / gapSize はワールド単位[m]。1地区あたり100〜300m程度の小さな区域なので短めに。
    dash: { dashSize: 6, gapSize: 4 },
    lineWidth: 2.5,
    opacity: 0.34,
    kinds: [
      { kind: '上賀茂地区', label: '上賀茂地区', fill: 0xf9c6e4, line: 0xe0509f },
      { kind: '嵯峨鳥居本地区', label: '嵯峨鳥居本地区', fill: 0xf9c6e4, line: 0xe0509f },
      { kind: '祇園新橋地区', label: '祇園新橋地区', fill: 0xf9c6e4, line: 0xe0509f },
      { kind: '産寧坂地区', label: '産寧坂地区', fill: 0xf9c6e4, line: 0xe0509f },
    ],
  },
  {
    id: 'shizen', uiOrder: 4, label: '自然風景保全地区', url: '自然風景保全地区.json',
    // 青系。第1種を濃く、第2種はそれより薄いが【風致地区の第2種(0x8fdcf2)よりは濃い】。
    // 風致地区と山地で大きく重なるので【ハッチ】にして下の色を透かす。
    // 線の部分は面積が3割ほどしかないので、不透明度は塗りつぶしより上げないと薄く見える。
    hatch: { periodPx: 10, widthPx: 3, angle: 45 },
    opacity: 0.72,
    kinds: [
      { kind: 1, label: '第1種', fill: 0x2a63b0, line: 0x17417a },
      { kind: 2, label: '第2種', fill: 0x5f9ede, line: 0x2f6aa8 },
    ],
  },
  {
    id: 'rekishi', uiOrder: 5, label: '歴史的風土特別保存地区', url: '歴史的風土特別保存地区.json',
    group: '古都保存法',
    // ★ このレイヤーは【種別を持たない】（25面すべて同じ区分）。
    //   zone2json.py は「第○種」が無ければ kind: null を出すので、そのまま1区分として扱う。
    //   種別が1つだけのレイヤーは、HUD でも種別チェックを出さずマスターのチェックだけにする。
    // 濃い紫のタテヨコのクロスハッチ（風致地区の第4種 0xe6b3f0 と紛れないよう濃くする）。
    hatch: { periodPx: 12, widthPx: 2, angles: [0, 90] },
    opacity: 0.75,
    kinds: [
      { kind: null, label: '歴史的風土特別保存地区', fill: 0x6a2f9e, line: 0x46206b },
    ],
  },
  {
    id: 'rekishiHozon', uiOrder: 5, label: '歴史的風土保存区域', url: '歴史的風土保存区域.json',
    group: '古都保存法',
    // ★ 歴史的風土【特別保存地区】は、この【保存区域】の中にある更に厳しい区域。
    //   重なった所は特別保存地区の模様だけを見せたいので、面を差し引く（subtract）。
    //   ⚠️ 差し引く相手（消す側）は【先に描かれる必要がある】ので ZONE_LAYERS で前に置く。
    subtract: ['rekishi'],
    // 同じ濃い紫の点々（特別保存地区の格子より弱い表現＝規制の強弱と対応する）
    hatch: { pattern: 'dots', periodPx: 8, radiusPx: 1.6 },
    opacity: 0.8,
    kinds: [
      { kind: null, label: '歴史的風土保存区域', fill: 0x6a2f9e, line: 0x7a4fb0 },
    ],
  },
];

// --- 建物の高さ色分け（京都市の高度地区の凡例に合わせた区分）-------------------
// HUD のトグルで「航空写真テクスチャ」と「高さ色分け」を切り替える。
//   高さは PLATEAU の属性 bldg:measuredHeight を使い、それが無いタイルは
//   _batchid（建物ごとのID）ごとの頂点Y範囲から算出する。
//   ⚠️ measuredHeight は全タイルにあるわけではない（実測で 3,219件／9,066件）。
//      算出で代替できるので実用上は問題ない。
//   ※ 31m超は京都の高度地区の凡例には無いが、実際には存在する（京都駅ビル、
//      京都タワー=130.5m など。実測の最大値も 130.5m）ので、区別できるよう色を分けている。
//      不要なら 31m の帯に含めてよい。
export const HEIGHT_BANDS = [
  { max: 10,       color: 0x7fd88f, label: '10m以下' },
  { max: 15,       color: 0x7ecbe8, label: '15m以下' },
  { max: 20,       color: 0xf2e07a, label: '20m以下' },
  { max: 31,       color: 0xe8a6cd, label: '31m以下' },
  { max: Infinity, color: 0xe0553c, label: '31m超' },
];

// 地形に貼る航空写真／地図（国土地理院タイル。XYZ・Webメルカトル・出典明記が利用条件）。
// HUD のボタンで切り替えられる。url=null は「なし（単色）」。
export const IMAGERY = {
  photo: { label: '航空写真',   url: 'https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg', levels: 18 },
  std:   { label: '地理院地図', url: 'https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png',            levels: 18 },
  pale:  { label: '淡色地図',   url: 'https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png',           levels: 18 },
  none:  { label: 'なし',       url: null },
};
export const DEFAULT_IMAGERY = 'photo';

// --- 山名ラベル ---------------------------------------------------------------
// 京都市内の山頂（OpenStreetMap の natural=peak）。緯度経度・山名・標高(ele)を持つ。
//   実測: 228地点／うち名前あり185／名前と標高の両方あり166。標高は 78〜1214m
//   （武奈ヶ岳1214m・蓬莱山1174m・大文字山465m など）。
// 高さは【データの ele をそのまま使う】のが基本。PLATEAU の地形は山頂を丸めるので、
// 実際の山頂標高を持っているこのデータの方が「頂上」に合う。
// ele が無い19地点だけは、読み込み済みの地形から高さを拾って補う（拾えるまで保留）。
export const MOUNTAIN_URL = 'mountain.geojson';
export const MOUNTAIN_LABEL_LIFT = 30;      // 山頂から浮かせる高さ[m]（地形にめり込ませない）
export const MOUNTAIN_LABEL_SCREEN = 0.05;  // ラベルの高さ（画面の高さに対する割合）
export const MOUNTAIN_MAX_DIST = 30000;     // ラベルを用意しておく範囲（注目地点から）[m]
// ★ 実際に描くのは【カメラがこの距離まで近づいた山】だけ。遠くの山名まで出すと
//   地平線あたりに文字が積み重なって読めなくなるため。文字の大きさは距離によらず一定
//   （sizeAttenuation: false）なので、近づいた山だけが出る＝見たい範囲だけが読める。
export const MOUNTAIN_VISIBLE_DIST = 8000;  // カメラからこの距離以内の山名を描く[m]
export const MOUNTAIN_SHOW_ELEVATION = true; // 山名の下に標高も書く
// ★ ラベルは【描かれている地形の面の少し上】に置きたいので、高さは地形からも拾う。
//   注目地点まわりに高さグリッドを1枚だけ作って全山を引く（山ごとに作ると重い）。
export const MOUNTAIN_GRID_CELL = 30;       // 高さグリッドの目[m]
export const MOUNTAIN_GRID_MARGIN = 4000;   // 表示距離＋この余裕までをグリッドに含める[m]
// ★ 粗い地形から拾った高さは当てにならない（盆地と山をまたぐ三角形が混ざる）。
//   標高データがある山では、拾った値がこの範囲を超えて食い違ったら データの標高を採る。
export const MOUNTAIN_TERRAIN_TOL = 150;    // 許容するズレ[m]

// --- 自作モデル（01_building-builder から受け取る建物）-------------------------
// 親アプリが GLB の blob URL を sessionStorage に入れて渡す（同一オリジン配信が前提）。
// キー名は 02/03 の 'munsell_custom_glb' / 'night_custom_glb' と同じ流儀に揃えてある。
export const USER_MODEL_GLB_KEY = 'earth_custom_glb';
export const USER_MODEL_HEADING_KEY = 'earth_model_heading';   // 向き[rad]（北から時計回り）
export const USER_MODEL_OFFSET_KEY = 'earth_model_offset';     // 注目地点からの微調整[m] {e,n}
export const USER_MODEL_FOCUS_KEY = 'earth_focus_latlon';      // 最後に選んだ地点 {lat,lng}[度]
// モデリング画面のカメラ（mm・モデル原点基準）。同じ見え方で始めるために引き継ぐ。
export const USER_MODEL_CAMERA_KEY = 'earth_camera_state';
// 親アプリは mm 単位。こちらは m 単位なので 1/1000 にする。
export const USER_MODEL_SCALE = 0.001;
// 軸合わせ。親アプリは +X=東 / +Z=南（4面図の視点定義 viewManager.js の viewDefs で
// (-X,-Z) の角を「北西から」としているのが根拠）、こちらは +X=西 / +Z=北 なので、
// Y軸まわりに180°回すと東西南北が一致する。向き（heading）はこれに加算する。
export const USER_MODEL_YAW_BASE = Math.PI;
// 接地に使う高さグリッド。モデルの足元だけ分かればよいので範囲は狭くてよい。
//   ※ 眺望ポリゴンと同じ buildTerrainHeightGrid を使う（読込済みの地形から作る／
//     最精細LODだけを使う／異常な値を捨てる、という作法をそのまま引き継げる）。
export const USER_MODEL_SNAP_RADIUS = 60;   // モデル中心からの半径[m]
export const USER_MODEL_SNAP_CELL = 4;      // グリッドのセル[m]
// ギズモ（ドラッグ操作）の刻み。位置と向きの操作はこれに一本化している。
export const USER_MODEL_GIZMO_MOVE_SNAP = 0.5;    // 平面移動[m]
export const USER_MODEL_GIZMO_ROTATE_SNAP = 1;    // 回転[度]
