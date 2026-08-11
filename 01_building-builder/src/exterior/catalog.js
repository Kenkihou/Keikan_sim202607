/* ============================================================
   外構カタログ：大分類 → 地物 の一覧
   各地物モジュールの default export を並べるだけ
   （tree/planner.html の js/catalog.js をそのまま移植。並びだけ
     「地面 → 囲い → 外構 → 樹木」に変えてある）
   ============================================================ */
import ground from './items/ground.js';
import fence from './items/fence.js';
import exterior from './items/exterior.js';
import tree from './items/tree.js';

export const GROUPS = [ground, fence, exterior, tree];

/* 置き方の説明 */
export const PLACE_HINT = {
  point: '地盤面の格子点をクリックして配置',
  line:  '始点→終点の順に格子点をクリック（線に沿って作図）',
  rect:  '対角の2点をクリック（範囲を作図）',
  poly:  '角を順にクリック／ダブルクリック（または Enter）で確定',
};

const byId = new Map();
for (const g of GROUPS) for (const it of g.items){
  it.group = g.group;
  byId.set(it.id, it);
}
export const itemById = id => byId.get(id);
export const itemsOfGroup = name => (GROUPS.find(g => g.group === name) || { items: [] }).items;
