/* ============================================================
   外構の着色（マンセル値シミュレーター＝02 との色のやり取り）

   02 は「マテリアル名」をキーに色を返してくる。建物側は
   `${ブロックID}__${部位}` という名前を自前で付けているが、外構の
   マテリアルは各 items/*.js がモジュール直下で作る共有インスタンスで、
   名前を持っていない。そこで書き出しの直前にここで名前を付ける。

   【名前の付け方と、なぜこうしたか】
     `ext__<地物ID>__<連番>` とする。連番は「その地物の中で最初に出てきた順」。

     ⚠️ 以前は `ext_<uuidの先頭8桁>` を付けていたが、uuid はページを開き直すたびに
       変わるので、02 で塗った色を保存しても次に開いたときには対応先が分からなくなる。
       地物IDと出現順なら、同じ地物を同じ設定で組み立てるかぎり毎回同じ名前になる。

     ⚠️ 連番は【地物IDごと】に数える。全体の通し番号にすると、別の地物を1つ足した
       だけで既存の地物の番号までずれて、保存した色が別の場所へ付いてしまう。

   【共有マテリアルであることの帰結】
     items/*.js のマテリアルはモジュール直下の共有インスタンス（芝生1枚ごとに
     作り直すと重いのでそうなっている）。つまり同じ種類の地物は同じマテリアルを
     見ているので、02 で1つ塗ると同じ種類がまとめて変わる。
     これは 02 側でも同じ（GLB へ書き出す時点で1つのマテリアルに束ねられるので、
     02 の画面上でもまとめて選択される）ので、両者で食い違いは起きない。
   ============================================================ */
import { items } from './store.js';

export const EXT_MAT_PREFIX = 'ext__';

/* 外構のマテリアルへ、読み込み直しても同じになる名前を付ける。
   戻り値は Map<マテリアル, 名前>（色を当て直すときにそのまま使う）。 */
export function nameExteriorMaterials(){
  const named = new Map();     // マテリアル → 名前
  const counter = new Map();   // 地物ID → 次の連番
  // 置いた順ではなく地物IDの順で回す（同じ場面なら毎回同じ名前になるように）
  const sorted = [...items].sort((a, b) =>
    a.def.id < b.def.id ? -1 : a.def.id > b.def.id ? 1 : 0);

  for (const rec of sorted){
    const defId = rec.def.id;
    rec.obj.traverse(o => {
      if (!o.isMesh || !o.material) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats){
        if (!m || named.has(m)) continue;
        const n = counter.get(defId) || 0;
        counter.set(defId, n + 1);
        const name = `${EXT_MAT_PREFIX}${defId}__${n}`;
        m.name = name;
        named.set(m, name);
        /* ★塗る前の色を1回だけ覚えておく。
           これが無いと「色を保存していない別のファイル」を読み込んだときに、
           前のファイルで塗った色が残ってしまう（マテリアルはモジュール直下の
           共有インスタンスなので、ファイルを読み替えても作り直されない）。 */
        if (m.color && m.userData.extBaseColor === undefined){
          m.userData.extBaseColor = '#' + m.color.getHexString();
        }
      }
    });
  }
  return named;
}

/* 02 から返ってきた色を外構へ当てる。
   ⚠️ 地物を作り直すと（build）マテリアルの参照は共有のままだが、
     新しい種類の地物が増えると名前が付いていないものが出るので、
     当てる前に必ず名前を付け直す。 */
/* 外構に塗られている色（マテリアル名 → '#rrggbb'）。
   ★ここが持ち主。建物の色は buildingData の各ブロックが持つが、外構のマテリアルは
     地物の種類ごとの共有インスタンスなので、マテリアルを持っているこのモジュールが
     まとめて覚えておくのが素直（保存時は getExteriorColors、読み込み時は
     setExteriorColors を通す）。 */
const stored = {};

export function getExteriorColors(){ return { ...stored }; }

/* 保存ファイルから戻すとき用。持っている色をそっくり入れ替えて塗り直す。 */
export function setExteriorColors(map){
  for (const k of Object.keys(stored)) delete stored[k];
  Object.assign(stored, map || {});
  applyExteriorColors(stored);
}

/* 02 から返ってきた色のうち、外構ぶん（ext__ で始まるもの）だけ取り込んで塗る。
   戻り値は「取り込むものがあったか」。 */
export function mergeReturnedColors(colorMap){
  let changed = false;
  for (const name in (colorMap || {})){
    if (!name.startsWith(EXT_MAT_PREFIX)) continue;
    stored[name] = colorMap[name];
    changed = true;
  }
  if (changed) applyExteriorColors(stored);
  return changed;
}

export function applyExteriorColors(colorMap){
  const map = colorMap || {};
  const named = nameExteriorMaterials();
  for (const [m, name] of named){
    if (!m.color) continue;
    // 指定があればその色、無ければ塗る前の色へ戻す
    // （戻す処理が要る理由は nameExteriorMaterials の extBaseColor のコメント参照）
    const hex = map[name] || m.userData.extBaseColor;
    if (!hex) continue;
    m.color.set(hex);
    m.needsUpdate = true;
  }
}
