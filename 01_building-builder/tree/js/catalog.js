/* ============================================================
   地物カタログ：大分類 → 地物 の一覧
   各地物モジュールの default export を並べるだけ
   ============================================================ */
import tree from './items/tree.js';
import fence from './items/fence.js';
import ground from './items/ground.js';
import exterior from './items/exterior.js';

export const GROUPS = [ground, fence, tree, exterior];

/* 置き方の説明 */
export const PLACE_HINT = {
  point: '地面の格子点をクリックして配置',
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
