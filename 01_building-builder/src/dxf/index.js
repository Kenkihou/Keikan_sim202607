// =============================================================================
// dxf/index — 「DXF 平面」ボタンの中身
//
//   ファイルを選ぶ → 使う平面図を囲む → 【階】として建物データに積む。
//
//   ★ できたものは、長方形を描いたときと同じ【階】として buildingData に入る。
//     以後の積み重ね・選択・保存はまったく同じ道を通る。違うのは
//     「平面の形は図面が決める（側面は押し引きしない）」の一点だけ。
//   ⚠️ 図面の原点は【通り芯の X1/Y1】に取る。外接矩形の中心に取ると、
//     1階と2階で外形が違うだけで階どうしが横にずれる。
// =============================================================================
import { AppState } from '../appState.js';
import { askDxfPlan } from './planPick.js';
import { buildWallModel, gridOrigin } from './wallModel.js';

// ★ 読み込んだ直後は【板】。高さはつまみで与えてもらう。
//   ⚠️ いきなり階高で立ち上げてはいけない。図面から起こした形が正しいかを
//     見るより先に、壁で埋まって中が見えなくなる。
const DEFAULT_H = 100;
const FLOOR_H = 500;          // 1階の床高さ[mm]。地盤面から床までの立ち上がり
const SLAB_T = 100;           // 上階の床板の厚み[mm]。天井裏の懐はいまは見ない

/* この外形の真下にある階の天端。無ければ地盤面。
   ⚠️ 接しているだけの隣は「下」ではない。重なりを 50mm 要求する。 */
function baseYUnder(x, z, w, d) {
  const r = { x0: x - w / 2, x1: x + w / 2, z0: z - d / 2, z1: z + d / 2 };
  let y = 0;
  for (const b of AppState.buildingData) {
    const q = { x0: b.x - b.w / 2, x1: b.x + b.w / 2,
      z0: b.z - b.d / 2, z1: b.z + b.d / 2 };
    if (Math.min(r.x1, q.x1) - Math.max(r.x0, q.x0) <= 50) continue;
    if (Math.min(r.z1, q.z1) - Math.max(r.z0, q.z0) <= 50) continue;
    y = Math.max(y, (b.y || 0) + b.h);
  }
  return y;
}

/* この床板のすぐ下にある階の【階段の外接矩形】。床に開ける穴になる。
   板の中心を原点にした座標で返す。無ければ null。
   ⚠️ 「すぐ下」だけを見ること。もっと下の階の階段まで拾うと、関係のない
     ところに穴が開く。 */
function stairHoleUnder(cx, cz, w, d, y) {
  if (y <= 0) return null;
  const r = { x0: cx - w / 2, x1: cx + w / 2, z0: cz - d / 2, z1: cz + d / 2 };
  for (const b of AppState.buildingData) {
    if (b.kind !== 'dxf' || !b.plan || !b.plan.stair) continue;
    if (Math.abs((b.y || 0) + b.h - y) > 1) continue;
    const s = b.plan.stair;
    const q = { x0: b.x + s.x0, x1: b.x + s.x1, z0: b.z + s.z0, z1: b.z + s.z1 };
    if (Math.min(q.x1, r.x1) - Math.max(q.x0, r.x0) <= 1) continue;
    if (Math.min(q.z1, r.z1) - Math.max(q.z0, r.z0) <= 1) continue;
    return { x0: q.x0 - cx, x1: q.x1 - cx, z0: q.z0 - cz, z1: q.z1 - cz };
  }
  return null;
}

/* 模型を、外形の中心が原点に来るようにずらす。
   ★ 01 の階は「中心 (x,z) と 幅 w・奥行 d」で置く。模型もその流儀に合わせて
     おくと、あとで建物ごと動かしても図面を作り直さずに済む。 */
function toLocal(m, cx, cz) {
  const sx = (r) => ({ ...r, x0: r.x0 - cx, x1: r.x1 - cx, z0: r.z0 - cz, z1: r.z1 - cz });
  const out = {
    walls: m.walls.map(sx),
    opens: m.opens.map(sx),
    foot: sx(m.foot),
    stair: null,
  };
  if (m.stair) out.stair = { ...sx(m.stair), parts: m.stair.parts.map(sx) };
  return out;
}

/* ボタンから呼ぶ。読み込めたら onDone(block) を返す。 */
export function askDxfFloor(onDone) {
  askDxfPlan((sheet) => {
    const org = gridOrigin(sheet);
    if (!org) {
      alert('通り芯のレイヤ（GRID など）が見つかりませんでした。\n'
        + '階どうしを重ねる基準になるので、囲みの中に通り芯を含めてください。');
      return;
    }
    const m = buildWallModel(sheet.polys, org);
    if (!m) {
      alert('壁芯のレイヤ（W-EXT-200 など）が見つかりませんでした。\n'
        + 'レイヤ名が W-EXT-厚み / W-INT-厚み になっているか確かめてください。');
      return;
    }
    const f = m.foot;
    const cx = (f.x0 + f.x1) / 2, cz = (f.z0 + f.z1) / 2;
    const w = f.x1 - f.x0, d = f.z1 - f.z0;
    const y = baseYUnder(cx, cz, w, d);
    const id = Date.now().toString();
    // ★ 壁の下には【床の板】を1枚置く。1階は「1階の床高さ」、上に載る階は
    //   床板の厚み。板が無いと、壁が地盤面から直接生えて基礎が消える。
    //   ⚠️ 板と壁で1つのまとまり（rootBuildingId をそろえる）。人にとっては
    //     「1階」というひとかたまりで、消すのも動かすのもこの単位。
    const slabH = (y > 0) ? SLAB_T : FLOOR_H;
    const slab = {
      id: id + '_s', rootBuildingId: id,
      kind: 'slab',             // ふつうの直方体。図面の形は持たない
      x: cx, y, z: cz, w, d, h: slabH,
    };
    // ★ 下の階から階段が上がってくるところは、床を張らない（05 と同じ）。
    //   ⚠️ 張ると階段が床に突き刺さり、上り口が塞がれる。
    const hole = stairHoleUnder(cx, cz, w, d, y);
    if (hole) slab.hole = hole;
    const block = {
      id, rootBuildingId: id,
      kind: 'dxf',              // ★ 平面の形は図面が決める。側面は押し引きしない
      x: cx, y: y + slabH, z: cz, w, d, h: DEFAULT_H,
      plan: toLocal(m, cx, cz),
    };
    AppState.buildingData.push(slab, block);
    // ★ 置いた直後は【上面を選んだ状態】にする。つまみが出ていないと、
    //   次に何をすればいいのかが分からない。
    AppState.selectedId = block.id;
    AppState.selectedFaceDir = 'top';
    if (onDone) onDone(block);
  });
}
