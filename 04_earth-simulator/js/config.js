// =========================================================================
// 設定
// =========================================================================
// =========================================================================
// 都市データ（PLATEAU配信サービスの都市を選んで描画できるようにする）
//   ・?city=<id> で選ぶ。省略時は京都市。HUD の「都市」欄からも選べる（ui.js が
//     選択時に location を書き換えてページを開き直す＝この config.js を含む全モジュールが
//     選んだ都市の設定で再初期化される）。
//   ・区ごとに tileset があるので配列(wards)で持つ。3d-tiles-renderer は視錐台外の
//     タイルを読み込まないので、区ごとに TilesRenderer を作れば「カメラが向いた区・
//     タイルだけ順次ロード」が自動で実現する。起動時に読むのは各区の root tileset.json
//     （小さいJSON）だけで、建物本体(b3dm)は視界に入って初めて DL される。
//   ・区ごとに LOD3 > LOD2 > LOD1 の順で一番詳しいものを使う（WARD_TILESETS）。
//     LOD3 は一部の区にしか無い（京都市は先斗町=中京区・祇園新橋=東山区ほか、大阪市は
//     北区・中央区）。
//   ・URL一覧の取得: curl -s "https://api.plateauview.mlit.go.jp/datacatalog/3dtiles/
//       <市区町村コード5桁>-bldg-lod2-latest/tileset.json"（LOD1/LOD3 は -lod2- を差し替え）。
//     このAPIは区ごとの tileset.json URL（CMS上のランダムハッシュ付きパス）の一覧を返す。
// 【2層構成】広域が現実的な時間で埋まるようにするための最重要設計。
//   実測: LOD2の葉タイルは1枚5〜7MB と極端に重く、広域ビューでは必要タイル数が
//   errorTarget をいくら上げても減らない（階層最上位まで粗くなりきっているため）。
//   → 削減できるのは「枚数」ではなく「1枚あたりのバイト数」。LOD1 は同一タイルで
//     2.4〜3.6倍軽い（例: 6.88MB→2.88MB, 324KB→98KB）。
//   そこで LOD1 を全域の常時ベースにし、LOD2 は注視点の近傍だけに限定する。
const A = 'https://assets.cms.plateau.reearth.io/assets/';

// ---- 京都市（26100・全11区）--------------------------------------------------
const KYOTO_P = '/26100_kyoto-shi_city_2025_citygml_1_op_bldg_3dtiles_';
const KYOTO_WARDS = [
  { name: '北区',   lod1: A + 'e7/2aaaf0-1ab3-40e8-af5b-db3310fb4f15' + KYOTO_P + '26101_kita-ku_lod1/tileset.json',
                     lod2: A + '7a/918715-89fb-4f45-a48a-a77ee6288577' + KYOTO_P + '26101_kita-ku_lod2/tileset.json' },
  { name: '上京区', lod1: A + '7f/4d517a-10cc-4489-b1b2-5c754caa0561' + KYOTO_P + '26102_kamigyo-ku_lod1/tileset.json',
                     lod2: A + '71/0af6ab-875e-4c69-bb5e-9e06096e6fcb' + KYOTO_P + '26102_kamigyo-ku_lod2/tileset.json' },
  { name: '左京区', lod1: A + '95/ec9c15-9c08-4c97-b073-029636f84818' + KYOTO_P + '26103_sakyo-ku_lod1/tileset.json',
                     lod2: A + '96/d17b9d-5527-4610-90c8-9e9c44d500c3' + KYOTO_P + '26103_sakyo-ku_lod2/tileset.json' },
  { name: '中京区', lod1: A + '65/c601e9-7ba9-42f2-8400-bd1ec5282421' + KYOTO_P + '26104_nakagyo-ku_lod1/tileset.json',
                     lod2: A + '04/eaac56-936e-49e2-a91b-0db31a6ed192' + KYOTO_P + '26104_nakagyo-ku_lod2/tileset.json',
                     lod3: A + '3b/cc2d98-1c15-46ee-b026-f7dc851d884a' + KYOTO_P + '26104_nakagyo-ku_lod3/tileset.json' }, // 先斗町
  { name: '東山区', lod1: A + 'ce/6e26ee-9c98-4df7-bc06-4ea5049162c3' + KYOTO_P + '26105_higashiyama-ku_lod1/tileset.json',
                     lod2: A + '25/dd4c50-5342-4a0b-ac51-05ffb138b8b5' + KYOTO_P + '26105_higashiyama-ku_lod2/tileset.json',
                     lod3: A + 'dd/3e0851-94fb-4fed-8e44-289d0e3fb41f' + KYOTO_P + '26105_higashiyama-ku_lod3/tileset.json' }, // 祇園新橋
  { name: '下京区(京都駅)', lod1: A + '64/f8be59-d43b-47fe-a7f0-ce936ae5bc8e' + KYOTO_P + '26106_shimogyo-ku_lod1/tileset.json',
                     lod2: A + 'f0/2ed501-5480-4ccb-8293-9469a3856f9a' + KYOTO_P + '26106_shimogyo-ku_lod2/tileset.json',
                     lod3: A + 'd3/4c620c-1c8b-44fa-9168-b50ed86f27f1' + KYOTO_P + '26106_shimogyo-ku_lod3/tileset.json' },
  { name: '南区',   lod1: A + 'af/70c122-184c-46e7-8200-056f326851a9' + KYOTO_P + '26107_minami-ku_lod1/tileset.json',
                     lod2: A + '1c/596e87-af58-4394-a4e7-ef429ba5732c' + KYOTO_P + '26107_minami-ku_lod2/tileset.json' },
  { name: '右京区', lod1: A + '1c/369350-e66e-4526-bdb0-ff014a15460e' + KYOTO_P + '26108_ukyo-ku_lod1/tileset.json',
                     lod2: A + '64/cf6354-e5ff-4ee4-84d6-1751734da17c' + KYOTO_P + '26108_ukyo-ku_lod2/tileset.json' },
  { name: '伏見区', lod1: A + 'd2/d06236-cb09-4229-a086-469dac391966' + KYOTO_P + '26109_fushimi-ku_lod1/tileset.json',
                     lod2: A + '6c/10f912-836b-483d-a6b2-881e298d7006' + KYOTO_P + '26109_fushimi-ku_lod2/tileset.json' },
  { name: '山科区', lod1: A + 'ac/8c8272-b229-42b9-8091-fcace8039948' + KYOTO_P + '26110_yamashina-ku_lod1/tileset.json',
                     lod2: null }, // LOD2 未配信
  { name: '西京区', lod1: A + 'e4/bab58f-04c7-4673-a6c0-e36f58f5237f' + KYOTO_P + '26111_nishikyo-ku_lod1/tileset.json',
                     lod2: null }, // LOD2 未配信
];

// ---- 大阪市（27100・全24区）--------------------------------------------------
const OSAKA_P = '/27100_osaka-shi_city_2025_citygml_1_op_bldg_3dtiles_';
const OSAKA_WARDS = [
  { name: '都島区',     lod1: A + 'ea/520f01-415e-424f-a973-6a35856e6430' + OSAKA_P + '27102_miyakojima-ku_lod1/tileset.json',
                         lod2: A + 'f6/438555-e27f-4fb7-bce3-7a11906ce06a' + OSAKA_P + '27102_miyakojima-ku_lod2/tileset.json' },
  { name: '福島区',     lod1: A + 'db/dadcf8-1214-4161-bf22-a60d9142cfc7' + OSAKA_P + '27103_fukushima-ku_lod1/tileset.json',
                         lod2: A + '72/90e183-bf4b-463e-b8d9-11936f32d256' + OSAKA_P + '27103_fukushima-ku_lod2/tileset.json' },
  { name: '此花区',     lod1: A + '4c/7f47b0-6ff9-41ce-92b4-b2dbeb3be119' + OSAKA_P + '27104_konohana-ku_lod1/tileset.json',
                         lod2: A + '1b/2acef6-47d7-46b1-a391-050836fe0a96' + OSAKA_P + '27104_konohana-ku_lod2/tileset.json' },
  { name: '西区',       lod1: A + '37/00bcbf-5b8c-49be-9c89-76a68507aa61' + OSAKA_P + '27106_nishi-ku_lod1/tileset.json',
                         lod2: A + '32/6117a6-a930-4fe1-bce2-7cbdddc6c52f' + OSAKA_P + '27106_nishi-ku_lod2/tileset.json' },
  { name: '港区',       lod1: A + '58/e2ff4e-4afe-40d9-97ff-f12371127bb9' + OSAKA_P + '27107_minato-ku_lod1/tileset.json',    lod2: null },
  { name: '大正区',     lod1: A + '06/2458e8-5ace-4b51-9f99-c4a048852a11' + OSAKA_P + '27108_taisho-ku_lod1/tileset.json',    lod2: null },
  { name: '天王寺区',   lod1: A + '84/435ce6-00dd-47fe-87db-19958af5a6ac' + OSAKA_P + '27109_tennoji-ku_lod1/tileset.json',   lod2: null },
  { name: '浪速区',     lod1: A + '01/9e98f9-121f-4a18-80c8-32b2c3fc071c' + OSAKA_P + '27111_naniwa-ku_lod1/tileset.json',
                         lod2: A + '32/d6ef51-5aac-4519-a690-aea78e8bd039' + OSAKA_P + '27111_naniwa-ku_lod2/tileset.json' },
  { name: '西淀川区',   lod1: A + '87/d206f3-29c6-4b1e-8135-08f9a9a870a3' + OSAKA_P + '27113_nishiyodogawa-ku_lod1/tileset.json', lod2: null },
  { name: '東淀川区',   lod1: A + 'ba/a16b05-652a-491b-9e0e-b3550398e65f' + OSAKA_P + '27114_higashiyodogawa-ku_lod1/tileset.json',
                         lod2: A + 'e2/4e8207-5f8d-4d8e-8891-334c4b090eb2' + OSAKA_P + '27114_higashiyodogawa-ku_lod2/tileset.json' },
  { name: '東成区',     lod1: A + '0e/c24fa1-af58-48c9-bf24-63bc58daaaf1' + OSAKA_P + '27115_higashinari-ku_lod1/tileset.json',
                         lod2: A + '62/c35aea-229b-4345-9535-7d9f9146d433' + OSAKA_P + '27115_higashinari-ku_lod2/tileset.json' },
  { name: '生野区',     lod1: A + '4a/9f6675-d430-4170-8a40-df8308ee9984' + OSAKA_P + '27116_ikuno-ku_lod1/tileset.json',     lod2: null },
  { name: '旭区',       lod1: A + '25/e6ec51-85da-4133-b595-91a1dca16fea' + OSAKA_P + '27117_asahi-ku_lod1/tileset.json',     lod2: null },
  { name: '城東区',     lod1: A + 'bb/0993c8-e192-458b-8c87-bd507f7d811a' + OSAKA_P + '27118_joto-ku_lod1/tileset.json',
                         lod2: A + '02/821890-fea9-4a5b-b480-6e14102b6eb0' + OSAKA_P + '27118_joto-ku_lod2/tileset.json' },
  { name: '阿倍野区',   lod1: A + '43/2982ec-f91c-4d81-a70f-d13c997f520a' + OSAKA_P + '27119_abeno-ku_lod1/tileset.json',     lod2: null },
  { name: '住吉区',     lod1: A + '48/116eb6-d434-4920-9de1-5951e53b099e' + OSAKA_P + '27120_sumiyoshi-ku_lod1/tileset.json', lod2: null },
  { name: '東住吉区',   lod1: A + 'e6/22e19a-e2d1-4334-8b5c-85eb5401c0ce' + OSAKA_P + '27121_higashisumiyoshi-ku_lod1/tileset.json', lod2: null },
  { name: '西成区',     lod1: A + '33/62510b-6c6f-4937-94d4-777874906ac8' + OSAKA_P + '27122_nishinari-ku_lod1/tileset.json', lod2: null },
  { name: '淀川区',     lod1: A + 'da/6340ff-d3c4-4e15-8577-975d0ba44446' + OSAKA_P + '27123_yodogawa-ku_lod1/tileset.json',
                         lod2: A + '54/260d5c-b57b-4882-92c6-b2cb20f65198' + OSAKA_P + '27123_yodogawa-ku_lod2/tileset.json' },
  { name: '鶴見区',     lod1: A + '2c/2d107b-375a-49c9-8877-106ed53db820' + OSAKA_P + '27124_tsurumi-ku_lod1/tileset.json',   lod2: null },
  { name: '住之江区',   lod1: A + '74/4f2272-b0ef-4742-bb22-f9f97ef662cf' + OSAKA_P + '27125_suminoe-ku_lod1/tileset.json',   lod2: null },
  { name: '平野区',     lod1: A + 'de/f68892-cd4e-476e-899e-7a9818f41fee' + OSAKA_P + '27126_hirano-ku_lod1/tileset.json',    lod2: null },
  { name: '北区(大阪駅)', lod1: A + '73/bc9017-e521-43f2-8777-2837eefd9795' + OSAKA_P + '27127_kita-ku_lod1/tileset.json',
                         lod2: A + '92/1459fa-4102-4cfe-a56f-6fe5c7764178' + OSAKA_P + '27127_kita-ku_lod2/tileset.json',
                         lod3: A + 'cf/c419c0-bee1-4810-b9ae-529bafd07124' + OSAKA_P + '27127_kita-ku_lod3/tileset.json' },
  { name: '中央区',     lod1: A + '6e/cc10bb-07ec-4f6c-949d-aaace115b581' + OSAKA_P + '27128_chuo-ku_lod1/tileset.json',
                         lod2: A + '6b/bea10b-2d85-46e6-8786-4ef504aeeb28' + OSAKA_P + '27128_chuo-ku_lod2/tileset.json',
                         lod3: A + '8b/99ba46-8479-4392-aecb-bf5e98e23987' + OSAKA_P + '27128_chuo-ku_lod3/tileset.json' },
];

// ---- 都市レジストリ ------------------------------------------------------------
//   origin は各都市の主要駅（局所ENU座標系の原点）。height は楕円体高[m]、elevation は
//   標高[m]（国土地理院の標高API + ジオイド高計算サービスから算出。下記 ORIGIN_HEIGHT の
//   解説を参照）。hasRegulationLayers は「景観・眺望規制」（京都市固有の都市計画データ）を
//   読み込むかどうか。他都市は別データが必要になるため、無ければ false にして丸ごと無効化する。
//   bbox は【その都市の建物データが存在する範囲】[度]。sessionStorage に残っている
//   「前回の注目地点」が別の都市のものだったときに弾くために使う（usermodel.js）。
//   ⚠️ これが無いと、京都で開いた後に大阪へ切り替えたとき前回の京都の地点が復元され、
//     大阪の tileset が覆わない場所を注視して【建物が1枚も出ない】（実際に発生した）。
//   求め方: 上記カタログAPI の tileset.json を再帰し boundingVolume.region[0..3] の
//     min/max を取る（ラジアン→度）。LOD1・LOD2 の両方を合わせた範囲。
const CITY_REGISTRY = {
  kyoto: {
    label: '京都市', wardLabel: '京都市 全11区', wards: KYOTO_WARDS,
    origin: { lat: 34.985849, lon: 135.758766, height: 64, elevation: 28.3 }, // 京都駅
    // 東西断面（30km）の初期の緯度。★ 3D側の原点（=京都駅）とは別の値にできる。
    // 京都駅付近は駅ビル・線路で断面が単調になりやすいので、初期表示は市街地らしい
    // 京都市役所付近（中京区）に変えている。省略時は origin.lat を使う。
    profileInitialLat: 35.011564,
    bbox: { west: 135.5590, south: 34.8749, east: 135.8784, north: 35.3212 },
    boundaryUrl: 'boundary-kyoto.json',
    roadsUrl: 'roads-kyoto.json',
    riversUrl: 'rivers-kyoto.json',
    // 道路データ（PLATEAU tran）の MVT（2Dベクタータイル）。詳しくは下の ROAD_MVT を参照。
    roadMvt: {
      areaCode: '26100',
      fallbackYear: 2025,
      fallbackUrl: 'https://assets.cms.plateau.reearth.io/assets/89/762da6-8d40-490a-b9a9-20decdab2486/'
                 + '26100_kyoto-shi_city_2025_citygml_1_op_tran_mvt_lod1/{z}/{x}/{y}.mvt',
      fallbackLevels: 16, // 実測: z16まで配信・z17は404
    },
    wardBoundaryUrl: 'wards-kyoto.json',
    templesUrl: 'temples-kyoto.json',
    hasRegulationLayers: true,
  },
  osaka: {
    label: '大阪市', wardLabel: '大阪市 全24区', wards: OSAKA_WARDS,
    origin: { lat: 34.7025087, lon: 135.4961773, height: 37.9, elevation: 0.3 }, // 大阪駅
    bbox: { west: 135.3435, south: 34.5868, east: 135.5993, north: 34.7688 },
    boundaryUrl: 'boundary-osaka.json',
    roadsUrl: 'roads-osaka.json',
    riversUrl: 'rivers-osaka.json',
    roadMvt: {
      areaCode: '27100',
      fallbackYear: 2025,
      fallbackUrl: 'https://assets.cms.plateau.reearth.io/assets/fe/3d70cc-81df-4e38-becf-cf937a117095/'
                 + '27100_osaka-shi_city_2025_citygml_1_op_tran_mvt_lod1/{z}/{x}/{y}.mvt',
      fallbackLevels: 16,
    },
    wardBoundaryUrl: 'wards-osaka.json',
    templesUrl: 'temples-osaka.json',
    hasRegulationLayers: false,
  },
};
export const CITIES = Object.entries(CITY_REGISTRY).map(([id, c]) => ({ id, label: c.label }));

// URL の ?city=<id> で選ぶ（省略・不正値は京都市）。HUD の都市セレクタが変更時に
// location を書き換えて開き直すので、以降の全モジュールはこの都市の設定で初期化される。
export const CITY_ID = (() => {
  const id = new URLSearchParams(location.search).get('city');
  return Object.prototype.hasOwnProperty.call(CITY_REGISTRY, id) ? id : 'kyoto';
})();
const CITY = CITY_REGISTRY[CITY_ID];
export const CITY_LABEL = CITY.label;
export const CITY_WARD_LABEL = CITY.wardLabel;
export const CITY_BBOX = CITY.bbox;
// 市域の境界（右下の地図で市域だけを見せる「くりぬき」に使う）。
//   OpenStreetMap の行政界（boundary=administrative）を Nominatim から取り出し、
//   Douglas-Peucker で 5m 間引きしたもの。京都市 2,728点/61KB・大阪市 745点/17KB。
//   ※ 出典表示が要る（ODbL）。地図の出典行に併記している。
export const CITY_BOUNDARY_URL = CITY.boundaryUrl || null;
// くりぬきの外側にかける覆いの濃さ（0=覆わない〜1=真っ黒）と、市域の輪郭線。
export const BOUNDARY_DIM = 0.72;
export const BOUNDARY_LINE_COLOR = 'rgba(255,255,255,0.55)';

// 通り名（東西断面に重ねるラベル用と、ストリートビューの路面ラベル用）。
//   OpenStreetMap の Overpass API から【名前のある道路】を取得し、Douglas-Peucker で
//   15m 間引きしたもの（京都市 874KB・7,858本／大阪市 1.2MB・11,751本）。作り直しは
//   fetch_roads.py（このフォルダ）を手で走らせる。
//   ★ 拾う種類は motorway/trunk/primary/secondary/tertiary に加えて
//     unclassified/residential/living_street/pedestrian まで。幹線だけだと
//     御幸町通・麩屋町通のような京都の南北の細い通りや、寺町通の商店街区間が
//     丸ごと抜ける（OSM ではそれらは residential 等で引かれているため）。
//   ライブでの取得はしない（Overpass公開APIはフェアユース前提でレート制限があり、
//   断面線を動かすたびに数百KB〜1MBを毎回叩くのは適さない。既存の mountain.geojson /
//   boundary-*.json と同じく「開発時に一度取得してコミットする」方式にした）。
export const CITY_ROADS_URL = CITY.roadsUrl || null;
// 河川（断面図に「水色の帯＋川底」を描く）。作り直しは fetch_roads.py（道路と一緒に出る）。
//   幅は OSM の width タグがあればその値、無ければ種別ごとの既定（river 18m など）。
export const CITY_RIVERS_URL = CITY.riversUrl || null;

// ---- 道路データ（PLATEAU tran）の MVT（2Dベクタータイル）--------------------
//   ⚠️ 上の CITY_ROADS_URL とは別物。あちらは断面図に通り名を出すための OSM の線データ。
//     こちらは PLATEAU 配信サービスが出している【道路の面データ】。
//
//   PLATEAU の道路（tran）を 3D Tiles で配信しているのは LOD3 だけで、対象は建物LOD3と
//   同じくごく一部の地区（京都市では先斗町・木屋町の約380m×310mのみ）。
//   一方 LOD1 は市域全体をカバーしているが、配信形式が MVT（2Dベクタータイル）しかない。
//   → 「市内全域でどこが道路か分かる」ことを優先し、地形（Quantized Mesh、既に高低差を
//     持つ）の上に MVT の道路ポリゴンを投影（ドレープ）する方式にした。3d-tiles-renderer に
//     この用途そのものの MVTOverlay プラグインがあり、航空写真／地図と全く同じ
//     ImageOverlayPlugin の仕組みで動く（tiles.js の createTerrainTiles 参照）。
//
//   最新版の解決:
//     起動時に PLATEAU のデータカタログ（GraphQL）へ問い合わせて、その時点で最新の
//     .mvt URL テンプレートを引き直す（roads.js の resolveRoadMvt）。
//     年度が更新されて CMS のハッシュ付きURLが変わっても追随できる。
//     通信に失敗したときは下の fallbackUrl（2025年版）をそのまま使う。
export const ROAD_MVT = CITY.roadMvt || null;
// データカタログの GraphQL 入口（CORS は `access-control-allow-origin: *` で開いている）。
export const PLATEAU_CATALOG_GRAPHQL = 'https://api.plateauview.mlit.go.jp/datacatalog/graphql';
// カタログ問い合わせの打ち切り時間。これを過ぎたら fallbackUrl で進む。
export const ROAD_CATALOG_TIMEOUT_MS = 6000;
// 道路の見せ方は場面で2通り。切り替えは roads.js の setRoadHighlightStrength。
//   ⚠️ 塗りの色に透明度を混ぜてよいのは、その画素の不透明度で道路かどうかを判定している
//     roads.js の isRoadAt のしきい値（8/255）より十分濃いときだけ。
//     下の 0.5 なら 128 なので余裕がある。真に薄く見せたいときはマテリアル側の
//     opacity を下げること（判定と見た目を別物として保つ）。

// ★ どちらの場面でも【縁の線は引かない】。塗りだけで道路面を示す。
//   縁を線で強調すると、隣り合う道路面の継ぎ目や1本の道路が複数ポリゴンに
//   分かれている箇所にも線が乗り、道路の形とは違う格子模様が浮いて見える。

// ---- 着地点をさがしている間 … 全面を濃い黄色で塗り、道路の位置をはっきり見せる
export const ROAD_HIGHLIGHT_FILL = '#ffd23c';
export const ROAD_HIGHLIGHT_OPACITY_PICKING = 0.85;

// ---- 歩いている間 … 薄くして航空写真を透かす
export const ROAD_WALK_FILL = 'rgba(255,226,150,0.3)';
export const ROAD_HIGHLIGHT_OPACITY = 0.95;
// 道路を読み込む範囲［m］。注目地点を中心とした正方形の全幅。
//   ⚠️ これが無いと市内全域を読み込む。道路オーバーレイは【地形タイル】に貼るので、
//     何も絞らないと「地形が読まれた範囲すべて」でMVTを取りに行く。地形は建物と違って
//     距離制限なしで広く読むため、遠方の粗い地形タイルのために低ズーム（z9・z10）の
//     MVTが要求される。低ズームのタイルは市域全体が1枚に入っていて非常に重く、
//     実測で初期表示だけで 32枚・2.42MB、うち z9/z10 の2種で 0.92MB を占めていた。
//   建物（LOCAL_WIDTH_EW/NS = 500m）より少しだけ広い 800m。
//   ⚠️ 広げるほど素直に重くなる。PLATEAU の道路MVTはズームを上げても間引きされないため、
//     「面積あたりのバイト数」がほぼ一定で、ズーム選択では減らせない（実測：z15は1枚約1MB、
//     z16は1枚269KBだが同じ面積に4枚要るので結局同じ）。効くのは読む面積を絞ることだけ。
export const ROAD_LOAD_WIDTH = 800;
// 道路を貼る地形タイルの粗さの上限［m］。これより広い範囲を1枚で受け持つ地形タイルには貼らない。
//   ⚠️ 上の矩形判定だけでは足りない。地形タイルは階層構造で、注目地点を含む【祖先タイル】が
//     各レベルに存在する（実測で 幅16,000km〜501m の16段）。親は子を内包するので、
//     矩形交差では全段が通ってしまい、粗い段のために低ズームの重いMVT（市域全体が1枚に
//     入ったもの。z9=0.46MB・z10=0.34MB）を取りに行っていた。
//   幅32kmのタイルに道路を描いてもテクスチャ上では潰れて見えないので、意味が出る細かさ
//   （実測で幅1,002m・501mの段）だけに貼る。ここを緩めると広い段が通り、その1枚が
//   受け持つ面積ぶんのMVTを取るので一気に重くなる。
export const ROAD_MAX_TILE_SPAN = 1200;
// 道路をラスタライズするテクスチャの一辺［px］。
//   これが大きいほどライブラリは「より高いズームのMVT」を選ぶ（実測: 256→z14 / 512→z15 /
//   1024→z16）。通信量を減らせないか一通り試したが、
//     z15: 4枚 4.13MB ／ z16: 16枚 4.30MB
//   とほぼ横並びで、【ズーム選択では減らない】ことが実測で確認できた。PLATEAU の道路MVTは
//   ズームを上げても間引きされないため、面積あたりのバイト数が一定なのが理由。
//   減らせるのは「読む面積」だけ（ROAD_LOAD_WIDTH / ROAD_MAX_TILE_SPAN）。
//   そのため解像度はキャンバスのメモリが小さい既定値のままにしておく（1枚 256²×4byte）。
export const ROAD_RASTER_RESOLUTION = 256;

// 行政区の境界（断面の距離軸に「どの区を通っているか」の色帯を出すのに使う）。
//   OpenStreetMap の行政界(admin_level=8)を Overpass から取得し、relation の way断片
//   （role=outer）を端点で繋いで閉じたリングに組み立てた上で 5m 間引きしたもの。
//   ⚠️ bbox で単純に取得すると隣接市の同名区が混入する（実測: 大阪の bbox に
//     堺市の「堺区」「北区」「西区」が入ってきた）。config.js の wards 配列にある
//     正式な区名と突き合わせて除外済み（京都11区・大阪24区、要求どおりの件数を確認）。
export const CITY_WARD_BOUNDARY_URL = CITY.wardBoundaryUrl || null;
// 帯の配色（区名のハッシュで固定の色を割り当てる＝断面線を動かしても同じ区は同じ色になる）。
export const PROFILE_WARD_PALETTE = [
  '#3b6ea5', '#4a8f6b', '#a56b3b', '#7a5ba5', '#a53b6e', '#3ba59e', '#8a9e3b',
];
export const PROFILE_WARD_BAND_OPACITY = 0.55;
// 市域の外の区間に出すラベルと色。断面は 30km あって市域の東西幅を超えるので、
// 「区の帯が無い＝データ欠損？」と紛らわしくならないよう明示する。
// 色は区の配色から浮かないよう、彩度を落とした灰青にする。
export const PROFILE_WARD_OUTSIDE_LABEL = `${CITY.label}外`;
export const PROFILE_WARD_OUTSIDE_COLOR = '#54606e';

// 主要な寺院・神社（断面線付近にあれば山名と同じ要領でマーカー表示する）。
//   OpenStreetMap の amenity=place_of_worship のうち Wikidata タグ付き（＝一定の知名度が
//   ある証拠）だけに絞ったもの。素の place_of_worship は京都市内だけで950件あり近所の祠まで
//   含んでしまうため、絞り込み無しでは使えない（実測。Wikidataタグ付きは京都197件・大阪72件）。
export const CITY_TEMPLES_URL = CITY.templesUrl || null;
export const PROFILE_TEMPLE_BAND_M = 1200;   // 山名と同じ許容半幅[m]
export const PROFILE_TEMPLE_COLOR = '#e0b64a';

// --- 断面パネルに重ねる山名・通り名のラベル -----------------------------------
//   どちらも「断面線との交点」にティック＋回転文字で示す（配置ロジックは profile.js）。
// 山名: 断面線からこの半幅[m]以内にある山頂だけを対象にする（線からズレていても近ければ拾う）。
//   実測（京都駅の緯度・±1km で試した範囲）: 8件がヒットし密集しすぎない量だった。
export const PROFILE_MOUNTAIN_BAND_M = 1200;
export const PROFILE_MOUNTAIN_COLOR = '#8fd99a';
// 通り名: 同じ名前の交点が近接する（交差点や蛇行）場合は1つにまとめる、その許容距離[m]。
export const PROFILE_ROAD_MERGE_M = 80;
// ラベルどうしが重ならないよう、画面上でこの間隔[px]未満なら間引く（密集地区向け）。
export const PROFILE_LABEL_MIN_GAP_PX = 26;
export const PROFILE_ROAD_COLOR = '#cbd5e1';

// --- 断面の「土」の塗り分け ---------------------------------------------------
//   一律の茶色だと、市街地の平地も背後の山も同じに見えて地形が読めない。
//   ★ 山かどうかは【まわりからの盛り上がり】で決める（絶対標高では決めない）。
//     絶対標高で切ると、盆地の外の高い平坦地（亀岡側など）まで山になってしまう。
// ★ 平地の土（暖かい茶）と対比が付くよう、山は【暗い緑灰】にする。
//   ⚠️ 最初は #7a6a55（灰茶）にしていたが、平地の #9c6b3e と近すぎて塗り分けが
//     ほとんど見えなかった（実測の描画色 #8e7251 と #7d6b54）。色相ごと変える。
export const PROFILE_MOUNTAIN_SOIL_COLOR = '#4a5347';  // 山の土（暗い緑灰＝岩盤の感じ）
export const PROFILE_MOUNTAIN_RISE_M = 30;   // まわりの最低点からこれ以上高ければ山[m]
export const PROFILE_MOUNTAIN_WINDOW_M = 1500; // 「まわり」を見る半幅[m]
export const PROFILE_MOUNTAIN_MIN_RUN_M = 250; // これより短い山・谷は均す[m]
// 道路の断面（地表に敷く舗装の帯）。幅は OSM の道路種別から決める[m]。
export const PROFILE_ROAD_SURFACE_COLOR = '#1b1f26';   // 舗装（ほぼ黒＝土と最大の対比）
export const PROFILE_ROAD_EDGE_COLOR = '#e6edf6';     // 路面の線（明るく）
export const PROFILE_ROAD_DEPTH_M = 3.5;     // 舗装として描く厚み[m]
export const PROFILE_ROAD_MIN_PX = 4;        // 縮尺が粗くても最低これだけの太さで描く[px]
export const ROAD_WIDTH_M = {
  motorway: 22, trunk: 18, primary: 16, secondary: 12, tertiary: 9,
  unclassified: 6, residential: 5, living_street: 4, pedestrian: 4,
};
export const ROAD_WIDTH_DEFAULT_M = 6;

// --- 河川の断面（水色の帯＋川底）---------------------------------------------
export const PROFILE_RIVER_COLOR = '#3aa7e0';        // 水面
export const PROFILE_RIVER_BED_COLOR = '#17516e';    // 川底・岸の線
export const PROFILE_RIVER_LABEL_COLOR = '#7fd4ff';  // 川名ラベル
// 川底の深さ[m]は川幅から見積もる（幅の12%、0.8〜4m）。
//   ★ 深さの実データは無い。幅なりに掘り込むほうが、一律の深さより地形として自然。
export const PROFILE_RIVER_DEPTH_RATIO = 0.12;
export const PROFILE_RIVER_DEPTH_MIN_M = 0.8;
export const PROFILE_RIVER_DEPTH_MAX_M = 4;
export const PROFILE_RIVER_BED_RATIO = 0.6;   // 川底の幅（水面幅に対する割合）＝法面の傾き
export const PROFILE_RIVER_MIN_PX = 3;        // 縮尺が粗くても最低これだけの幅で描く[px]
export const PROFILE_RIVER_MERGE_M = 60;      // 同名の近接した交点はまとめる[m]
// 京都市固有の「景観・眺望規制」レイヤー・山名ラベルを有効にするか（他都市は対象データが無い）。
export const HAS_REGULATION_LAYERS = CITY.hasRegulationLayers;

// ベース層: LOD1（全区・距離制限なし）。軽いので広域でも徐々に埋まる。
export const TILESET_URLS_LOD1 = CITY.wards.map((w) => w.lod1);
// LOD2 が配信されている区だけ（残りは LOD1 で補完）。
export const TILESET_URLS_LOD2 = CITY.wards.filter((w) => w.lod2).map((w) => w.lod2);
// LOD3 が配信されている区だけ。
export const TILESET_URLS_LOD3 = CITY.wards.filter((w) => w.lod3).map((w) => w.lod3);
// 全区ぶんの TilesRenderer に渡す実際の tileset。区ごとに【LOD3 > LOD2 > LOD1】の順で
// 一番詳しいものを1つだけ選ぶ。
//   ★ 重ねてはいけない。LOD3 の tileset は「その区の建物すべて」を含み、LOD3 がある建物
//     だけが詳細ジオメトリに差し替わったもの（＝LOD2 の上位互換）なので、両方を読むと
//     同じ建物が二重に描かれて Z ファイトになる。1区につき1つ選ぶのが正しい。
//   実測（中京区）: LOD2 は 70タイル / LOD3 は 2,852タイルと細かく刻まれており、
//     先斗町のタイルは 1.0MB、二条城付近でも 104〜142KB の実データがある
//     （＝LOD3 データセットは先斗町だけでなく区全体を覆う完全な置き換え）。
//   ※ 大阪市の LOD3 は実測では LOD2 とタイル数・各タイルのバイト列まで一致していた
//     （＝現時点では中身が同じ）。将来 PLATEAU 側が差し替えたときに自動で効くので
//     指定はそのまま残してある。
export const WARD_TILESETS = CITY.wards.map((w) => w.lod3 || w.lod2 || w.lod1);

// HUD の出典表記に出す「実際に使っている LOD の内訳」（例: LOD3・LOD2・一部LOD1）。
//   区ごとの採用状況から組み立てるので、上の表に LOD3 を足せば表記も自動で追従する。
export const CITY_LOD_LABEL = (() => {
  const used = { lod3: 0, lod2: 0, lod1: 0 };
  for (const w of CITY.wards) used[w.lod3 ? 'lod3' : w.lod2 ? 'lod2' : 'lod1']++;
  const parts = [];
  if (used.lod3) parts.push('一部LOD3');
  if (used.lod2) parts.push('LOD2');
  if (used.lod1) parts.push('一部LOD1');
  return parts.join('・');
})();

// この緯度経度を原点(0,0,0)・上方向を +Y に据える。
// → 自作の Three.js モデルは、この地点を基準に「メートル単位」で配置できる。
export const DEG2RAD = Math.PI / 180;
export const ORIGIN_LAT = CITY.origin.lat * DEG2RAD;
export const ORIGIN_LON = CITY.origin.lon * DEG2RAD;
// 東西断面の初期の緯度[度]。都市ごとに専用の値が無ければ、3D側の原点と同じ緯度にする。
export const PROFILE_INITIAL_LAT_DEG = CITY.profileInitialLat ?? CITY.origin.lat;
// 原点(Y=0)に据える「楕円体高[m]」。この地点の地盤の楕円体高を入れると、地表が Y=0 になり
// 自作モデルを Y=0 基準で地面に置けるようになる（各都市の駅周辺の実測値。下部の解説参照）。
export const ORIGIN_HEIGHT = CITY.origin.height;

// 原点の「標高[m]」（＝国土地理院の言う標高。楕円体高とは別物なので注意）。
//   ORIGIN_HEIGHT は楕円体高（GRS80楕円体基準）、標高はジオイド（ほぼ平均海水面）基準。
//   日本付近はジオイド高が+36〜39m程度あるため、楕円体高64mでも標高は20m台になる
//   （実測: 国土地理院の標高API で 28.3m。京都駅は実際に標高20m台）。
//   土の断面を「標高0m（海水準）まで」描くための基準として使う。
//   求め方: curl "https://cyberjapandata2.gsi.go.jp/general/dem/scripts/getelevation.php?lon=経度&lat=緯度&outtype=JSON"
//     （楕円体高はこれにジオイド高を足す。ジオイド高は
//     curl "https://vldb.gsi.go.jp/sokuchi/surveycalc/geoid/calcgh/cgi/geoidcalc.pl?outputType=json&latitude=緯度&longitude=経度"）
export const ORIGIN_ELEVATION = CITY.origin.elevation;
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
//   ★ 12,000m は「西山〜京都盆地〜東山」を1画面に収めるための値。
//     盆地の幅は実測で約11km あり、4,000m では収まりきらなかった。
export const MAX_CAMERA_DISTANCE = 12000;

// 霧のかかり始め／かかりきる距離[m]。
//   ⚠️ カメラの引ける上限を変えたら霧も必ず見直すこと。固定値(3000〜9000m)のまま
//     上限を 2000→4000m にしたら、引いた先が霧に沈んで真っ暗になった過去がある。
//   ★ ただし「上限に比例」させるだけでも駄目。近景では上限の値が効きすぎて
//     霧が遠すぎ（＝奥行き感が消える）、逆に上限を下げると近くから霧がかかる。
//     → 【今のカメラ距離の 1.5倍／4.5倍】と【下限（従来の見え方）】の大きい方を使う。
//     こうすると近景の見た目は今までどおりのまま、引いた先だけ霧が押し広がる。
export const FOG_NEAR_RATIO = 1.5;
export const FOG_FAR_RATIO = 4.5;
export const FOG_MIN_NEAR = 6000;    // 上限4000m時代の 4000×1.5（近景の見え方を据え置く）
export const FOG_MIN_FAR = 18000;    // 同じく 4000×4.5

// --- 東西の地形断面（縦断図パネル）-------------------------------------------
// 箱庭の断面（一辺 最大500m）とは別に、市域スケールで地形を東西に切った縦断図を描く。
//
// ★ 高さの取得元は【国土地理院の標高タイル(DEM)】。読み込み済みの PLATEAU 地形タイルは
//   使わない。理由は2つ:
//     1) 遠方の地形タイルはカメラの向き・寄り具合で LOD がまるで変わるので、
//        断面の形が【カメラを動かすたびに変わる】。section.js が SOIL_MIN_SAMPLES_ACROSS
//        で「粗すぎる地形では描かない」と拒否しているのと同じ問題が、この距離では常態になる。
//     2) DEM タイルは注目地点にもカメラにも依存せず、いつでも同じ正確な断面が得られる。
//   実測（京都駅を通る東西20km・旧設定時）: z14 で 7.83m 間隔・2,816サンプル・欠測ゼロ、
//   標高 19.8〜476.0m（西山〜京都盆地〜東山）。必要タイルは11枚・約400KB と軽い。
//   ※ CORS は Access-Control-Allow-Origin: * が返るので canvas から画素を読める。
//
// ★ 全長 30km にしているのは、京都市の境界(boundary-kyoto.json)を実測した結果
//   東西の最大幅が 29.13km あったため（京都駅の緯度だけなら19.21kmで足りるが、
//   断面線は南北にドラッグして動かせるので、どの緯度でも市域を切り抜けるよう
//   最大幅に余裕を持たせた）。
//
// ※ 建物の断面は今回は描かない。断面線に沿った 30m 幅の回廊でも、PLATEAU の建物タイルは
//   1枚が約500m×330mの塊なので【20kmで62枚・157MB】必要だった（LOD1に落としても148MB）。
//   全長を伸ばすほど比例して増えるので、地形だけなら数百KBで済むのとはますます桁が違う。
//   将来やるなら「タイルを1枚ずつ読んで断面だけ抜き出したら即捨てる」方式になる。
export const PROFILE_LENGTH = 30000;            // 断面の全長[m]（東西）
export const PROFILE_DEM_ZOOM = 14;             // 標高タイルのズーム（z14 ≒ 7.8m/px・1枚2km）
export const PROFILE_DEM_URL = 'https://cyberjapandata.gsi.go.jp/xyz/dem_png/{z}/{x}/{y}.png';
// 標本数。7.83m/px の DEM 分解能に合わせて、全長を伸ばしても間隔がおおむね同じ(≒12.5m)に
//   なるよう PROFILE_LENGTH に比例させてある（20km:1600 → 30km:2400）。
export const PROFILE_SAMPLES = 2400;            // 断面に沿って取る標本数
// 鉛直方向の強調倍率。★ 全長30kmに対して起伏はたかだか数百m ＝ 実スケールでは50倍前後にも
//   なるほど極端に平たいので、1倍のままだと盆地の起伏が読めない。
//   かといって常に誇張すると実際の地形の印象を誤る。
//   → HUD で切り替えられるようにして、既定は起伏が読める5倍にする。
// 鉛直強調の選択肢。10倍まで用意していたが、断面パネルが画面を占めすぎるので 5倍 止まり。
export const PROFILE_EXAGGERATIONS = [1, 2, 5];
export const PROFILE_DEFAULT_EXAGGERATION = 5;
export const PROFILE_SOIL_COLOR = '#9c6b3e';    // 土（箱庭の断面と同じ色）
export const PROFILE_LINE_COLOR = '#1a3cd8';    // 地盤ライン（箱庭の断面と同じ色）
export const PROFILE_SEA_COLOR = '#3aa0c8';     // 標高0m（海水準）の線

// 眺望空間保全地域（京都市の眺望景観保全地域。五山送り火などの眺めを守る区域）。
//   元データは 眺望shapeデータ/眺望空間保全地域.shp（EPSG:2448＝平面直角座標系第VI系）。
//   scratchpad の shp2json.py で WGS84 経緯度の JSON に変換したものを読む
//   （ブラウザに shp パーサと投影変換を持ち込まずに済む）。
// ★ 京都市固有のデータなので、他都市では読み込まない（null にすると viewareas.js 側が
//   fetch も HUD の「景観・眺望規制」項目自体もスキップする）。
export const VIEW_AREA_URL = HAS_REGULATION_LAYERS ? '眺望空間保全地域.json' : null;
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
export const VIEW_LIMIT_URL = HAS_REGULATION_LAYERS ? '眺望規制面.json' : null;
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
// ★ 京都市固有のデータなので、他都市では空配列にする（zoneLayers の生成・HUD項目・
//   fetch がすべて自動的に何もしなくなる。viewareas.js / ui.js の変更は不要）。
export const ZONE_LAYERS = !HAS_REGULATION_LAYERS ? [] : [
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
// tint:true は「画像を貼らず、標高で色分けする」という印（tiles.js が拾う）。
export const IMAGERY = {
  photo: { label: '航空写真',   url: 'https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg', levels: 18 },
  std:   { label: '地理院地図', url: 'https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png',            levels: 18 },
  pale:  { label: '淡色地図',   url: 'https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png',           levels: 18 },
  elev:  { label: '標高段彩',   url: null, tint: true },
  none:  { label: 'なし',       url: null },
};
export const DEFAULT_IMAGERY = 'photo';

// --- 標高段彩（地形を標高で色分けする）----------------------------------------
// 地形の画を「標高段彩」にしたときの見た目。地形メッシュのフラグメントシェーダーで
// ワールド座標のYから標高を出し、段彩色＋等高線に置き換える（tiles.js の applyTerrainTint）。
//   ★ ジオメトリも頂点属性も増やさない＝描画コストは実質ゼロ。
//   ★ 段は【ピクセル単位】で切る。頂点カラーだと頂点間で色が混ざって段がぼやける。
// 色は低地=緑 → 黄 → 橙 → 茶 → 高所=白 の一般的な段彩図の並び。
// 中間はグラデーションで補間されるので、刻みの数だけ段ができる。
//
//   ★ 標高の刻みを【等間隔にしない】のが要点。実際の段彩図と同じ考え方。
//     京都盆地の底は実測で 14〜60m（駅から半径4kmの標高は 25%点25.1m／中央値37.0m／
//     75%点54.4m、駅の西2〜5kmは 26.3/26.5/26.9/27.0m とほぼ真っ平ら）。
//     0〜1000m を等間隔に配ると、市街地はすべて【下から2〜6%】に収まって同じ濃い緑になり、
//     平地の起伏が色では全く読めなかった。
//     → 低地側（0/20/40/60m）に色を厚く配り、山地側は粗く（200/400/700/1000m）。
//     こうすると盆地の底だけで色が3段階変わり、山地の段彩もそのまま残る。
//   ※ 色見本テクスチャは【標高で補間】して作るので（tiles.js の makeTintRamp）、
//     ここの間隔を変えるだけで反映される。シェーダー側は触らなくてよい。
export const ELEVATION_TINT_STOPS = [
  { ele: 0,    color: 0x1e6b4a },
  { ele: 20,   color: 0x2f8355 },
  { ele: 40,   color: 0x479a5c },
  { ele: 60,   color: 0x66b062 },
  { ele: 100,  color: 0x93c266 },
  { ele: 200,  color: 0xc9d275 },
  { ele: 400,  color: 0xe8dc8a },
  { ele: 700,  color: 0xcf9d69 },
  { ele: 1000, color: 0xe8e4e0 },
];
// 段彩の色を割り当てる標高の範囲[m]。この外側は端の色で頭打ちにする。
//   京都市内の最高峰は武奈ヶ岳 1,214m だが、市街地から見える範囲はおおむね 1,000m 以下。
export const ELEVATION_TINT_RANGE = [0, 1000];
// HUD で選べる標高の刻み[m]。近景では細かく、市域全体を見るときは粗く。
export const ELEVATION_TINT_STEPS = [5, 10, 20, 50];
export const ELEVATION_TINT_DEFAULT_STEP = 10;
// 段の境目に引く等高線の濃さ（0=引かない〜1=真っ黒）。
export const ELEVATION_TINT_LINE_STRENGTH = 0.55;

// --- 山名ラベル ---------------------------------------------------------------
// 京都市内の山頂（OpenStreetMap の natural=peak）。緯度経度・山名・標高(ele)を持つ。
//   実測: 228地点／うち名前あり185／名前と標高の両方あり166。標高は 78〜1214m
//   （武奈ヶ岳1214m・蓬莱山1174m・大文字山465m など）。
// 高さは【データの ele をそのまま使う】のが基本。PLATEAU の地形は山頂を丸めるので、
// 実際の山頂標高を持っているこのデータの方が「頂上」に合う。
// ele が無い19地点だけは、読み込み済みの地形から高さを拾って補う（拾えるまで保留）。
export const MOUNTAIN_URL = HAS_REGULATION_LAYERS ? 'mountain.geojson' : null; // 京都市内の山頂のみ
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

// --- 屋根テキスト（街の屋根を1枚のスクリーンに見立てて文字を流す）---------------
//   仕組みと「屋根の見分け方」の根拠は js/rooftext.js の冒頭を参照。
export const ROOF_TEXT_SIZE = 500;        // 1枚のキャンバスに見立てる範囲[m]（注目地点中心の正方形）
export const ROOF_TEXT_ROWS = 2;          // 何行に組むか（2行建て）
// 文字の大きさ。1行ぶんの帯（＝ SIZE / ROWS = 250m）の何割を文字の高さにするか。
//   ★ 文の長さでサイズを変えない（＝長い文でも文字は小さくならず、そのぶん長く流れる）。
//     屋根は建物ごとにバラバラで間に道路の「穴」が入るため、小さいと細切れで読めない。
export const ROOF_TEXT_HEIGHT_RATIO = 0.62;
// 流れる速さ[画面幅/秒]。1周は「帯の長さ（最低4画面）÷ この値」秒かかる。
//   短い文でも1周4画面ぶん動く（＝2画面ぶん見えて、2画面ぶん休む）ので、
//   遅すぎると何も出ていない時間が長く感じる。
export const ROOF_TEXT_SPEED = 0.22;
// 「上を向いている面＝屋根」とみなす法線Yのしきい値。
//   実測の法線Yヒストグラムが -1.0/0.0/+0.7〜1.0 に三峰分離しており、
//   0.7 なら勾配屋根を拾いつつ壁（0.0付近）を確実に外せる。
export const ROOF_TEXT_NORMAL_MIN = 0.7;
export const ROOF_TEXT_DEFAULT = '京都';

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
