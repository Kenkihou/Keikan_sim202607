// uiController.js
import { GUI } from 'lil-gui';
import { AppState } from './appState.js';
import { ModelingEngine } from './modelingEngine.js';
import { freeRoofInfo, freeRoofOwner, roofGroup, freeNotch, notchSpot, NOTCH_MIN }
    from './roof/roofMesh.js';
import { geyaInfo } from './roof/geya.js';
import { paraInfo } from './roof/para.js';

/* 大屋根を持っている階。L字は直方体を並べて作るので、どちらを選んでも
   同じ1枚の屋根を触らせる。
   ⚠️ 読み替えないと、相方を選んだときに【2枚目の屋根】が作れてしまう。 */
const roofBlock = (b) => freeRoofOwner(b) || b;

let currentGUI = null;
// 動かしたパネルの位置。閉じるまで覚えておく。
let menuPos = null;
let lastMenuX = 0;
let lastMenuY = 0;

// index.html側から関数を受け取るための変数
let rebuildMeshes = () => {};
let setTool = () => {};

// ★ 屋根のアイコン。いま置ける屋根を【全部】並べる。
//   自由屋根の4つは、どれも同じ屋根の1点でしかない（置いたあと辺ごとの
//   つまみで連続的に変えられる）。従来の屋根は形が固定で、それぞれ専用の
//   寸法設定を持つ。
//   ⚠️ アイコンを増やすときは、まず自由屋根の【点】で足りないか考えること。
//     形の種類を増やすのは、連続変形では出せない形のときだけ。
/* 寄棟にしたとき、棟が走る向き。長いほうに沿って走る。
   ★ 「切妻1」は【寄棟と同じ向きの棟】、「切妻2」はそれと直交する棟。
     ⚠️ 向きを固定の値で持ってはいけない。間口と奥行のどちらが長いかで
       寄棟の棟の向きは入れ替わるので、同じボタンでも中身が変わる。 */
const hipRidgeAlongX = (b) => (b.w >= b.d);
/* 棟が東西（x）に走る切妻＝妻壁は西と東。南北に走るなら妻壁は南と北。 */
const gableFor = (alongX) => (alongX
    ? { gw: 1, ge: 1, gs: 0, gn: 0 }
    : { gw: 0, ge: 0, gs: 1, gn: 1 });

const ROOF_ICONS = [
    { key: 'yosemune', name: '寄棟', kind: 'free',
        g: () => ({ gw: 0, ge: 0, gs: 0, gn: 0 }) },
    { key: 'kirizuma1', name: '切妻1', kind: 'free',
        g: (b) => gableFor(hipRidgeAlongX(b)) },
    { key: 'kirizuma2', name: '切妻2', kind: 'free',
        g: (b) => gableFor(!hipRidgeAlongX(b)) },
    { key: 'parapet', name: 'パラ修', kind: 'legacy', type: 'パラペット修景' },
];
/* いまの屋根がこのボタンのものか。 */
const isRoofPreset = (b0, it) => {
    const b = roofBlock(b0);
    if (!b.roof) return false;
    if (it.kind === 'free') {
        if (b.roof.type !== '自由屋根') return false;
        const p = b.roof.params['自由屋根'];
        if (!p) return false;
        const g = it.g(b);
        return ['gw', 'ge', 'gs', 'gn']
            .every((k) => Math.abs((p[k] ?? 0) - g[k]) < 0.01);
    }
    return b.roof.type === it.type;
};

// ★ 下屋で選べる形。ここで選ぶのは【棟の向き】まで。寸法はモデルの上で決める。
//   ⚠️ 「切妻90°」は、下屋が角を回り込んでいるとき（または片側だけのとき）に
//     だけ意味がある。回り込んでいなければ「切妻」と同じ形になる。
const GEYA_ICONS = [
    { type: '平入り/寄棟', name: '寄棟',
        hint: '壁なりに四周へ流れる下屋。' },
    { type: '妻入り/切妻1', name: '切妻',
        hint: '棟を1本とおした切妻の下屋。' },
];

const defaultRoofParams = {
    '切妻': { eaves_l: 600, eaves_r: 600, keraba_l: 300, keraba_r: 300, slope: 4, rotate90: false, ridgeOffset: 0 },
    '寄棟': { eaves: 600, keraba: 600, slope: 4 },
    'パラペット修景': { pHeight: 300, slope: 3, out_px: 600, in_px: 400, flatEaves: false },
    '陸屋根': { pHeight: 300 },
    // ★追加：辺ごとの切妻の度合い（0＝寄棟／1＝切妻）で連続的に変形する屋根。
    //   4辺とも 0 なら寄棟、向かい合う2辺が 1 なら切妻、途中なら入母屋。
    '自由屋根': { slope: 4, eaves: 600, gw: 0, ge: 0, gs: 0, gn: 0, st: 0, step: false,
        ow: -1, oe: -1, os: -1, on: -1, flatT: 1, parapet: false, join: true }
};

// ★追加：修景要素の【情報パネル】。数字は見せるだけで、操作は置かない。
//   ★ 大きさも位置も、モデルの上でつまんで決める。スライダーを並べると、
//     どれがどの寸法のことなのかを毎回読まないと分からない。
//   ⚠️ 掴んで動かしているあいだは何度も呼ばれる。作り直さずに数字だけ書き換える
//     こと。作り直すと、動かすたびにパネルがちらつく。
let infoEl = null, infoKey = null;
const DIR_NAME = { pz: '手前', nz: '奥', px: '右', nx: '左' };
const SIDE_NAME = { left: '左', right: '右' };
const PART_NAME = { window: '引違い窓', door: '玄関ドア', sode: 'そで壁',
    tare: '垂れ壁', balc: 'バルコニー', dxfwin: '窓',
    visor: '軒庇', flat: '水平庇' };
const PART_BODY = { window: '窓', door: '玄関', sode: 'そで壁',
    tare: '垂れ壁', balc: 'バルコニー', dxfwin: '窓',
    visor: '軒庇', flat: '水平庇' };
const BALC_TYPE = { glass: 'ガラス', lattice: '手すり子' };

/* ★追加：その要素で選べる【種類】。[値, 表示名] の並び。無ければ null。 */
function partTypes(sel) {
    if (sel.kind === 'window' || sel.kind === 'dxfwin') {
        return Object.entries(ModelingEngine.WIN_TYPES).map(([k, v]) => [k, v.name]);
    }
    if (sel.kind === 'balc') return [['glass', 'ガラス'], ['lattice', '手すり子']];
    // ★ 庇は【軒庇】と【水平庇】の2種類。バルコニーのガラス／手すり子と同じ扱い。
    if (sel.kind === 'visor' || sel.kind === 'flat') {
        return [['visor', '軒庇'], ['flat', '水平庇']];
    }
    return null;
}
/* いま選ばれている種類。 */
function partTypeOf(b, sel) {
    if (sel.kind === 'window') {
        const p = ModelingEngine.openList(b, sel.dir, 'window')[sel.i || 0];
        return (p && p.type) || 'sliding';
    }
    if (sel.kind === 'dxfwin') {
        const o = b.plan && b.plan.opens && b.plan.opens[sel.i || 0];
        return (o && o.type) || 'sliding';
    }
    if (sel.kind === 'balc') return (b.balconies && b.balconies[sel.dir]) || null;
    if (sel.kind === 'visor' || sel.kind === 'flat') return sel.kind;
    return null;
}
/* 種類を変える。
   ⚠️ 大きさは変えない。置いた窓の寸法は決めたとおりに残す。 */
function applyPartType(b, sel, t) {
    if (sel.kind === 'balc') {
        if (!b.balconies || !b.balconies[sel.dir]) return;
        b.balconies[sel.dir] = t;
    } else if (sel.kind === 'window') {
        const p = ModelingEngine.openList(b, sel.dir, 'window')[sel.i || 0];
        if (!p || !ModelingEngine.WIN_TYPES[t]) return;
        p.type = t;
    } else if (sel.kind === 'dxfwin') {
        const o = b.plan && b.plan.opens && b.plan.opens[sel.i || 0];
        if (!o || !ModelingEngine.WIN_TYPES[t]) return;
        o.type = t;
    } else if (sel.kind === 'visor' || sel.kind === 'flat') {
        // ★ 軒庇 ⇄ 水平庇 の取り替え。
        //   ★ 【出】は引き継ぐ。せっかく決めた出寸法が、種類を変えただけで
        //     既定値に戻るのは驚く（バルコニーの種類替えで大きさを変えないのと同じ）。
        if (t === sel.kind) return;
        const dir = sel.dir;
        const drop = (box, par) => {
            if (Array.isArray(b[box])) {
                const ix = b[box].indexOf(dir);
                if (ix > -1) b[box].splice(ix, 1);
                if (!b[box].length) delete b[box];
            }
            let keep = null;
            if (b[par]) {
                keep = b[par][dir] || null;
                delete b[par][dir];
                if (!Object.keys(b[par]).length) delete b[par];
            }
            return keep;
        };
        if (t === 'flat') {
            const old = drop('visors', 'visorParams') || {};
            if (!b.flatVisors) b.flatVisors = [];
            if (!b.flatVisorParams) b.flatVisorParams = {};
            if (!b.flatVisors.includes(dir)) b.flatVisors.push(dir);
            b.flatVisorParams[dir] = { depth: old.eaves || 300, offsetY: 0, margin: 0 };
        } else {
            const old = drop('flatVisors', 'flatVisorParams') || {};
            if (!b.visors) b.visors = [];
            if (!b.visorParams) b.visorParams = {};
            if (!b.visors.includes(dir)) b.visors.push(dir);
            b.visorParams[dir] = { eaves: old.depth || 600, keraba: 300, slope: 4 };
        }
        // ⚠️ 選んでいるものの種類も付け替える。付け替えないと、つまみが
        //   前の種類のままになって掴めない。
        sel.kind = t;
        AppState.selectedPart = { kind: t, dir };
    } else return;
    rebuildMeshes();
    AppState.saveState();
    fillInfo(b, sel, true);
    UIController.showPartMenu(lastMenuX, lastMenuY, b, sel);
}
const OPEN_DEFAULT = {
    window: { w: 1970, h: 2000, head: 2100 },
    door: { w: 900, h: 2000, sill: 100 },
};

/* パネルに出す中身。[見出し, 行の配列, 使い方] を返す。 */
function partInfo(b, sel) {
    const baseY = b.y || 0;
    const dName = DIR_NAME[sel.dir] || sel.dir;
    const rows = [];
    let head = `${PART_NAME[sel.kind]}（${dName}面）`;
    if (sel.kind === 'window' || sel.kind === 'door') {
        const d = OPEN_DEFAULT[sel.kind];
        const list = ModelingEngine.openList(b, sel.dir, sel.kind);
        const p = list[sel.i || 0] || {};
        if (sel.kind === 'window') {
            const wt = ModelingEngine.WIN_TYPES[p.type || 'sliding'];
            head = `${wt ? wt.name : '引違い'}窓（${dName}面）`;
        }
        const w = p.width || d.w, h = p.height || d.h;
        const top = (sel.kind === 'window') ? (d.head + (p.offsetY || 0)) : (d.sill + h);
        if (list.length > 1) head += ` <span style="opacity:.5;font-weight:400">${(sel.i || 0) + 1}/${list.length}</span>`;
        rows.push(['幅', `${w} mm`], ['高さ', `${h} mm`],
            ['横位置', `${(p.offsetX || 0) > 0 ? '+' : ''}${Math.round(p.offsetX || 0)} mm`],
            ['下端（床から）', `${top - h} mm`], ['上端（床から）', `${top} mm`]);
    } else if (sel.kind === 'sode') {
        const q = ModelingEngine.sodeRect(b, baseY, sel.dir, sel.side);
        head = `そで壁（${dName}面・${SIDE_NAME[sel.side] || ''}）`;
        if (q) {
            rows.push(['奥行', `${Math.round(q.depth)} mm`],
                ['高さ', `${Math.round(q.h)} mm`],
                ['縁からの位置', `${Math.round(q.inset)} mm`]);
        }
    } else if (sel.kind === 'dxfwin') {
        // ★ 図面から起こした窓。壁に沿った幅と、床からの高さで見せる。
        const q = ModelingEngine.dxfWindowAt(b, sel.i || 0);
        const wt = ModelingEngine.WIN_TYPES[(q && q.type) || 'sliding'];
        head = `${wt ? wt.name : '引違い'}窓（${dName}面・図面）`;
        if (q) {
            rows.push(['幅', `${Math.round(q.b - q.a)} mm`],
                ['高さ', `${Math.round(q.hi - q.lo)} mm`],
                ['下端（床から）', `${Math.round(q.lo)} mm`],
                ['上端（床から）', `${Math.round(q.hi)} mm`]);
        }
    } else if (sel.kind === 'visor') {
        const q = ModelingEngine.visorRect(b, baseY, sel.dir);
        if (q) {
            rows.push(['軒の出', `${Math.round(q.eaves)} mm`],
                ['ケラバ', `${Math.round(q.keraba)} mm`],
                ['勾配', `${q.slope} 寸`],
                ['先端の高さ（床から）', `${Math.round(q.yOut - baseY)} mm`]);
        }
    } else if (sel.kind === 'flat') {
        const q = ModelingEngine.flatRect(b, baseY, sel.dir);
        if (q) {
            rows.push(['出', `${Math.round(q.depth)} mm`],
                ['取付高さ（床から）', `${Math.round(q.y - baseY)} mm`],
                ['両端の空き', `${Math.round(q.margin)} mm`]);
        }
    } else if (sel.kind === 'balc') {
        const q = ModelingEngine.balcRect(b, baseY, sel.dir);
        if (q) {
            head = `バルコニー（${dName}面・${BALC_TYPE[q.type] || q.type}）`;
            rows.push(['奥行', `${Math.round(q.depth)} mm`],
                ['手すり高', `${Math.round(q.hRail)} mm`],
                ['側面壁高', `${Math.round(q.hSide)} mm`]);
        }
    } else if (sel.kind === 'tare') {
        const q = ModelingEngine.tareRect(b, baseY, sel.dir);
        if (q) {
            rows.push(['下がり幅', `${Math.round(q.h)} mm`],
                ['長さ', `${Math.round(q.w)} mm`],
                ['左の縁から', `${Math.round(q.gapL)} mm`],
                ['右の縁から', `${Math.round(q.gapR)} mm`]);
        }
    }
    return { head, rows };
}

function fillInfo(b, sel, picked) {
    if (!infoEl) return;
    const v = partInfo(b, sel);
    const body = PART_BODY[sel.kind] || 'これ';
    const row = (k, t) => `<div style="display:flex;justify-content:space-between;gap:12px">`
        + `<span style="opacity:.6">${k}</span><b>${t}</b></div>`;
    // ★ 右上は【数字を見せるだけ】。種類の選択はモデルのそばのパネルに置く
    //   （選ぶものは、選ぶ相手の近くにあったほうが手が迷わない）。
    infoEl.innerHTML =
        `<div style="font-weight:700;margin-bottom:6px">${v.head}</div>`
        + v.rows.map(([k, t]) => row(k, t)).join('')
        + `<div style="margin-top:6px;opacity:.55;line-height:1.5">`
        // ⚠️ Delete が何を消すのかは【いま何を選んでいるか】で変わる。
        //   面を選んでいるだけのときに「これを削除」と書くと、建物ごと消えて驚く。
        + (picked
            // ★ 庇とバルコニーは面いっぱいに付くので【掴んで移動】は無い。
            //   ⚠️ 無い操作を書かないこと。試して動かないと、壊れていると思われる。
            ? ((sel.kind === 'balc' || sel.kind === 'visor' || sel.kind === 'flat'
                ? '' : `${body}を掴んで移動<br>`)
                + `つまみで寸法<br>Delete でこの${body}を削除`)
            : `${body}をクリックすると選べます`)
        + `</div>`;
}

/* 見出し・行・使い方の3つで1枚。修景要素も建物もこれで描く。 */
function infoBox(key, head, rows, hint) {
    // ⚠️ 中身は【毎回書き直す】。同じ相手だからと飛ばすと、押し引きで高さを
    //   変えたのに数字が前のまま残る。作り直すのは入れ物だけ。
    if (!infoEl) {
        infoEl = document.createElement('div');
        infoEl.id = 'open-info';
        infoEl.style.cssText = 'position:absolute;top:10px;right:10px;z-index:900;'
            + 'background:rgba(255,255,255,.95);border:1px solid #d8dde3;border-radius:10px;'
            + 'padding:10px 12px;min-width:172px;font:12px/1.7 system-ui,sans-serif;'
            + 'color:#222;box-shadow:0 4px 14px rgba(0,0,0,.12);pointer-events:none;';
        document.body.appendChild(infoEl);
    }
    infoKey = key;
    const row = (k, t) => `<div style="display:flex;justify-content:space-between;gap:12px">`
        + `<span style="opacity:.6">${k}</span><b>${t}</b></div>`;
    infoEl.innerHTML = `<div style="font-weight:700;margin-bottom:6px">${head}</div>`
        + rows.map(([k, t]) => row(k, t)).join('')
        + `<div style="margin-top:6px;opacity:.55;line-height:1.5">${hint}</div>`;
    currentGUI = { domElement: infoEl,
        destroy() { if (infoEl) infoEl.remove(); infoEl = null; infoKey = null; } };
}

function showInfoPanel(b, sel, picked) {
    if (!infoEl) {
        infoEl = document.createElement('div');
        infoEl.id = 'open-info';
        infoEl.style.cssText = 'position:absolute;top:10px;right:10px;z-index:900;'
            + 'background:rgba(255,255,255,.95);border:1px solid #d8dde3;border-radius:10px;'
            + 'padding:10px 12px;min-width:172px;font:12px/1.7 system-ui,sans-serif;'
            + 'color:#222;box-shadow:0 4px 14px rgba(0,0,0,.12);pointer-events:none;';
        document.body.appendChild(infoEl);
    }
    infoKey = partKeyOf(b, sel, picked);
    fillInfo(b, sel, picked);
    return { domElement: infoEl,
        destroy() { if (infoEl) infoEl.remove(); infoEl = null; infoKey = null; } };
}

const partKeyOf = (b, sel, picked) =>
    `${b.id}:${sel.kind}:${sel.dir}:${sel.i || 0}:${sel.side || ''}:${picked ? 1 : 0}`;

export const UIController = {
    /**
     * 初期化：index.htmlから必要な関数を受け取る
     */
    init(rebuildFn, setToolFn) {
        rebuildMeshes = rebuildFn;
        setTool = setToolFn;
        this.setupGlobalToggles();
    },

    updateActionButtons() {
        const undoBtn = document.getElementById('btn-undo');
        const redoBtn = document.getElementById('btn-redo');
        if (!undoBtn || !redoBtn) return; 

        if (AppState.historyIndex > 0) undoBtn.classList.remove('disabled');
        else undoBtn.classList.add('disabled');

        if (AppState.historyIndex < AppState.history.length - 1) redoBtn.classList.remove('disabled');
        else redoBtn.classList.add('disabled');
    },

    clearGUI() {
        if (currentGUI) {
            currentGUI.destroy();
            currentGUI = null;
        }
    },

    /* ★追加：選んでいる建物のあらまし。階数・幅・奥行・高さを見せるだけ。
       ★ 手で数字を打つ道はいったん置かない（寸法はモデルの上のつまみで決める）。
       ⚠️ 屋根などのパネルが出ているときは譲る。同じ場所に2枚は出せない。 */
    showBlockInfo(b) {
        // ⚠️ 屋根などのパネルには譲る。ただし【自分が出したパネル】なら書き直す。
        const mine = !!(infoEl && infoKey && infoKey.slice(0, 4) === 'blk:');
        if (!b || (currentGUI && !mine)) return;
        // ★追加：取り込んだモデルは階ではない。数えずに、そのものの大きさを出す。
        if (b.kind === 'model') {
            infoBox(`blk:${b.id}`, '取り込んだモデル', [
                ['ファイル', String(b.name || '-').replace(/[<>&]/g, '')],
                ['幅（東西）', `${Math.round(b.w)} mm`],
                ['奥行（南北）', `${Math.round(b.d)} mm`],
                ['高さ', `${Math.round(b.h)} mm`]],
            '地面の矢印で移動<br>大きさが変なときは札の ÷10 / ×10 などで直す');
            return;
        }
        const root = b.rootBuildingId || b.id;
        const grp = AppState.buildingData.filter((d) => (d.rootBuildingId || d.id) === root);
        if (!grp.length) return;
        let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity, top = 0;
        const levels = new Set();
        for (const q of grp) {
            x0 = Math.min(x0, q.x - q.w / 2); x1 = Math.max(x1, q.x + q.w / 2);
            z0 = Math.min(z0, q.z - q.d / 2); z1 = Math.max(z1, q.z + q.d / 2);
            top = Math.max(top, (q.y || 0) + q.h);
            // 床の板は階として数えない。同じ高さから始まる壁はまとめて1階。
            if (q.kind !== 'slab') levels.add(Math.round((q.y || 0) / 10));
        }
        const rows = [['階数', `${levels.size || 1} 階`],
            ['幅（東西）', `${Math.round(x1 - x0)} mm`],
            ['奥行（南北）', `${Math.round(z1 - z0)} mm`],
            ['高さ', `${Math.round(top)} mm`]];
        // ⚠️ まだ平面（板）のうちは地面の矢印を出していない。無いものを案内しない。
        infoBox(`blk:${root}`, '建物', rows, (top <= 100)
            ? '赤いつまみを引くと立ち上がります'
            : '面のつまみで大きさ<br>地面の矢印で建物ごと移動');
    },

    /* ★追加：修景要素の情報パネル。選んでいる要素の数字だけを見せる。
       ⚠️ 作り直さないこと。掴んで動かしているあいだ何度も呼ばれる。 */
    showPartInfo(b, sel, picked = true) {
        if (!b || !sel) return;
        if (infoEl && infoKey === partKeyOf(b, sel, picked)) {
            fillInfo(b, sel, picked);
            return;
        }
        this.clearGUI();
        currentGUI = showInfoPanel(b, sel, picked);
    },

    updateGUI(b, targetType = 'roof', faceDir = null, openIndex = 0, picked = false) {
        // 窓・玄関は要素そのものを選ぶ道（showPartInfo）へ寄せる。
        if (b && (targetType === 'window' || targetType === 'door')) {
            this.showPartInfo(b, { kind: targetType, dir: faceDir, i: openIndex }, picked);
            return;
        }
        this.clearGUI();
        if (!b) return; 

        const onChange = () => rebuildMeshes();
        const onFinishChange = () => { AppState.saveState(); this.updateActionButtons(); };

        if (targetType === 'roof') {
            if (!b.roof) return;
            currentGUI = new GUI({ title: '大屋根の寸法設定' });
            currentGUI.domElement.style.position = 'absolute';
            currentGUI.domElement.style.top = '10px';
            currentGUI.domElement.style.right = '10px';

            const type = b.roof.type;
            const params = b.roof.params[type];

            const resetObj = {
                reset: () => {
                    const currentRot = (type === '切妻') ? b.roof.params['切妻'].rotate90 : false;
                    b.roof.params[type] = JSON.parse(JSON.stringify(defaultRoofParams[type]));
                    if (type === '切妻') b.roof.params['切妻'].rotate90 = currentRot;
                    onFinishChange();
                    rebuildMeshes();
                    this.updateGUI(b, 'roof'); 
                }
            };

            if (type === '自由屋根') {
                // ★ 寸法のスライダーは置かない。
                //   軒の出・切妻の度合い・棟のずれ・平場は、どれも【モデルの上の
                //   つまみ】で決める。数字だけ別の場所で動かせると、どこを触れば
                //   何が変わるのかが二重になって読めなくなる。
                //   ここに残すのは、形の指定ではない【勾配】と、いまどうなって
                //   いるかを読む【屋根情報】だけ。
                for (const k of ['slope', 'eaves', 'gw', 'ge', 'gs', 'gn', 'st', 'step',
                    'ow', 'oe', 'os', 'on', 'flatT', 'parapet', 'join']) {
                    if (params[k] === undefined) params[k] = defaultRoofParams['自由屋根'][k];
                }
                // ⚠️ 勾配のスライダーも置かない。モデルの上の勾配定規で決める。
                //   数字はこの下の屋根情報で読む。
                currentGUI.title('大屋根');
                const box = document.createElement('div');
                box.style.cssText = 'padding:6px 10px 8px;font-size:11px;line-height:1.7;'
                    + 'color:#ddd;border-top:1px solid #444;';
                for (const [k, v] of (freeRoofInfo(b) || [])) {
                    const row = document.createElement('div');
                    row.style.cssText = 'display:flex;gap:6px;';
                    const kk = document.createElement('span');
                    kk.style.cssText = 'min-width:64px;text-align:right;color:#999;flex:none;';
                    kk.textContent = k;
                    const sep = document.createElement('span');
                    sep.style.cssText = 'color:#666;flex:none;';
                    sep.textContent = '：';
                    const vv = document.createElement('span');
                    vv.style.cssText = 'color:#fff;';
                    vv.textContent = v;
                    row.append(kk, sep, vv);
                    box.appendChild(row);
                }
                // ⚠️ つまみが1つも無いので、lil-gui の中身の枠は畳んでおく。
                //   空のままだと "Empty" と出て、壊れているように見える。
                //   ⚠️ この lil-gui は class に lil- が付く版。両方を見ておく。
                const kids = currentGUI.domElement.querySelector('.lil-children, .children');
                if (kids) kids.style.display = 'none';
                currentGUI.domElement.appendChild(box);
            } else if (type === '切妻') {
                // 古い形式のセーブデータが読み込まれた場合のデフォルト補完（安全対策）
                if (params.eaves_l === undefined) params.eaves_l = params.eaves !== undefined ? params.eaves : 600;
                if (params.eaves_r === undefined) params.eaves_r = params.eaves !== undefined ? params.eaves : 600;
                if (params.keraba_l === undefined) params.keraba_l = params.keraba !== undefined ? params.keraba : 300;
                if (params.keraba_r === undefined) params.keraba_r = params.keraba !== undefined ? params.keraba : 300;

                const isRot = params.rotate90;
                // 回転状態に応じてスライダーのラベル名を分かりやすく動的に切り替える
                const labelEavesL = isRot ? '軒の出 (手前) (mm)' : '軒の出 (左) (mm)';
                const labelEavesR = isRot ? '軒の出 (奥) (mm)'  : '軒の出 (右) (mm)';
                const labelKerabaL = isRot ? 'ケラバ (左) (mm)'   : 'ケラバ (手前) (mm)';
                const labelKerabaR = isRot ? 'ケラバ (右) (mm)'   : 'ケラバ (奥) (mm)';

                currentGUI.add(params, 'eaves_l', 0, 2000, 100).name(labelEavesL).onChange(onChange).onFinishChange(onFinishChange);
                currentGUI.add(params, 'eaves_r', 0, 2000, 100).name(labelEavesR).onChange(onChange).onFinishChange(onFinishChange);
                currentGUI.add(params, 'keraba_l', 0, 2000, 100).name(labelKerabaL).onChange(onChange).onFinishChange(onFinishChange);
                currentGUI.add(params, 'keraba_r', 0, 2000, 100).name(labelKerabaR).onChange(onChange).onFinishChange(onFinishChange);
                
                currentGUI.add(params, 'slope', 0, 10, 0.5).name('屋根勾配 (寸)').onChange(onChange).onFinishChange(onFinishChange);
                // ★修正：大屋根も%ではなく建物の限界値(mm)に合わせたスライダーに変更
                const maxOffset = isRot ? (b.d / 2) : (b.w / 2);
                currentGUI.add(params, 'ridgeOffset', -maxOffset, maxOffset, 50).name('棟の位置 (mm)').onChange(onChange).onFinishChange(onFinishChange);
            } else if (type === '寄棟') {
                currentGUI.add(params, 'eaves', 0, 2000, 100).name('軒の出 (mm)').onChange(onChange).onFinishChange(onFinishChange);
                currentGUI.add(params, 'slope', 0, 10, 0.5).name('屋根勾配 (寸)').onChange(onChange).onFinishChange(onFinishChange);
            } 

            // ★追加：切り欠きのGUI設定（切妻・寄棟 共通）
            if (type === '切妻' || type === '寄棟') {
                if (!params.cutout) params.cutout = { active: false, x: 0, z: 0, w: 1000, d: 1000 };
                const cutoutFolder = currentGUI.addFolder('屋根の切り欠き (中庭/室外機置場)');
                cutoutFolder.add(params.cutout, 'active').name('切り欠きを有効化').onChange(() => {
                    onChange(); this.updateGUI(b, 'roof'); // GUIを再描画して項目を表示
                }).onFinishChange(onFinishChange);
                
                if (params.cutout.active) {
                    // ★追加：建物を縮小した場合など、現在の値が枠外にはみ出ている場合は安全な値に押し戻す（初期クランプ）
                    if (params.cutout.x > b.w - 100) params.cutout.x = Math.max(0, b.w - 100);
                    if (params.cutout.z > b.d - 100) params.cutout.z = Math.max(0, b.d - 100);
                    if (params.cutout.w > b.w - params.cutout.x) params.cutout.w = Math.max(100, b.w - params.cutout.x);
                    if (params.cutout.d > b.d - params.cutout.z) params.cutout.d = Math.max(100, b.d - params.cutout.z);

                    // ★修正：スライダー生成時に、互いの値を考慮した「最大値」を設定する
                    const wCtrl = cutoutFolder.add(params.cutout, 'w', 100, Math.max(100, b.w - params.cutout.x), 100).name('幅 W (mm)');
                    const dCtrl = cutoutFolder.add(params.cutout, 'd', 100, Math.max(100, b.d - params.cutout.z), 100).name('奥行 D (mm)');
                    const xCtrl = cutoutFolder.add(params.cutout, 'x', 0, Math.max(0, b.w - params.cutout.w), 100).name('位置 X (mm)');
                    const zCtrl = cutoutFolder.add(params.cutout, 'z', 0, Math.max(0, b.d - params.cutout.d), 100).name('位置 Z (mm)');

                    // ★追加：スライダーを動かすたびに、他のスライダーの「最大限界値」をリアルタイムに更新する
                    const updateCutoutLimits = () => {
                        wCtrl.max(Math.max(100, b.w - params.cutout.x));
                        dCtrl.max(Math.max(100, b.d - params.cutout.z));
                        xCtrl.max(Math.max(0, b.w - params.cutout.w));
                        zCtrl.max(Math.max(0, b.d - params.cutout.d));
                        onChange();
                    };

                    wCtrl.onChange(updateCutoutLimits).onFinishChange(onFinishChange);
                    dCtrl.onChange(updateCutoutLimits).onFinishChange(onFinishChange);
                    xCtrl.onChange(updateCutoutLimits).onFinishChange(onFinishChange);
                    zCtrl.onChange(updateCutoutLimits).onFinishChange(onFinishChange);
                }
            }

            if (type === 'パラペット修景') {
                // ★ 大屋根・下屋と同じ流儀。寸法のスライダーは置かず、
                //   パラペット高さ・笠木勾配・外への出・内への寸法・棟の位置は
                //   【モデルの上のつまみ】で決めて、ここでは数字を読むだけ。
                //   ⚠️ 数字だけ別の場所でも動かせると、どこを触れば何が変わるのかが
                //     二重になって読めなくなる。
                if (params.ridge_dist === undefined) params.ridge_dist = params.in_px / 2;
                if (params.flatEaves === undefined) params.flatEaves = false;
                currentGUI.title('パラペット修景');
                // 軒裏の見せ方だけは寸法ではないので、ここに残す。
                currentGUI.add(params, 'flatEaves').name('水平軒裏にする')
                    .onChange(onChange).onFinishChange(onFinishChange);
                const box = document.createElement('div');
                box.style.cssText = 'padding:6px 10px 8px;font-size:11px;line-height:1.7;'
                    + 'color:#ddd;border-top:1px solid #444;';
                for (const [k, v] of (paraInfo(b) || [])) {
                    const row = document.createElement('div');
                    row.style.cssText = 'display:flex;gap:6px;';
                    const kk = document.createElement('span');
                    kk.style.cssText = 'min-width:80px;text-align:right;color:#999;flex:none;';
                    kk.textContent = k;
                    const sep = document.createElement('span');
                    sep.style.cssText = 'color:#666;flex:none;';
                    sep.textContent = '：';
                    const vv = document.createElement('span');
                    vv.style.cssText = 'color:#fff;';
                    vv.textContent = v;
                    row.append(kk, sep, vv);
                    box.appendChild(row);
                }
                currentGUI.domElement.appendChild(box);
            } else if (type === '陸屋根') {
                currentGUI.add(params, 'pHeight', 150, 1000, 50).name('パラペット高さ (mm)').onChange(onChange).onFinishChange(onFinishChange);
            }
            // ⚠️ 自由屋根には出さない。屋根アイコンを押し直せば同じ形の初期値に
            //   戻るので、ここに戻すボタンを重ねると入口が二つになる。
            if (type !== '自由屋根') currentGUI.add(resetObj, 'reset').name('↺ デフォルトに戻す');
        }
        else if (targetType === 'lowerRoof') {
            if (!b.lowerRoof) return;
            // ★ 大屋根と同じ流儀にする。寸法のスライダーは置かず、軒の出・ケラバ・
            //   勾配は【モデルの上のつまみ】で決めて、ここでは数字を読むだけ。
            //   ⚠️ 数字だけ別の場所でも動かせると、どこを触れば何が変わるのかが
            //     二重になって読めなくなる。
            const lr = b.lowerRoof;
            if (lr.eaves_l === undefined) lr.eaves_l = lr.eaves !== undefined ? lr.eaves : 600;
            if (lr.eaves_r === undefined) lr.eaves_r = lr.eaves !== undefined ? lr.eaves : 600;
            if (lr.keraba_l === undefined) lr.keraba_l = lr.keraba !== undefined ? lr.keraba : 300;
            if (lr.keraba_r === undefined) lr.keraba_r = lr.keraba !== undefined ? lr.keraba : 300;
            if (lr.ridgeOffset === undefined) lr.ridgeOffset = 0;

            currentGUI = new GUI({ title: '下屋' });
            currentGUI.domElement.style.position = 'absolute';
            currentGUI.domElement.style.top = '10px';
            currentGUI.domElement.style.right = '10px';

            const box = document.createElement('div');
            box.style.cssText = 'padding:6px 10px 8px;font-size:11px;line-height:1.7;'
                + 'color:#ddd;border-top:1px solid #444;';
            for (const [k, v] of (geyaInfo(b) || [])) {
                const row = document.createElement('div');
                row.style.cssText = 'display:flex;gap:6px;';
                const kk = document.createElement('span');
                kk.style.cssText = 'min-width:86px;text-align:right;color:#999;flex:none;';
                kk.textContent = k;
                const sep = document.createElement('span');
                sep.style.cssText = 'color:#666;flex:none;';
                sep.textContent = '：';
                const vv = document.createElement('span');
                vv.style.cssText = 'color:#fff;';
                vv.textContent = v;
                row.append(kk, sep, vv);
                box.appendChild(row);
            }
            // ⚠️ つまみが1つも無いので、lil-gui の中身の枠は畳んでおく。
            //   空のままだと "Empty" と出て、壊れているように見える。
            const kids = currentGUI.domElement.querySelector('.lil-children, .children');
            if (kids) kids.style.display = 'none';
            currentGUI.domElement.appendChild(box);
        }
        else if (targetType === 'side') {
            if (!faceDir) return;
            const isVisor = (b.visors || []).includes(faceDir);
            const isFlatVisor = (b.flatVisors || []).includes(faceDir);
            const dName = { 'pz': '手前', 'nz': '奥', 'px': '右', 'nx': '左' }[faceDir] || faceDir;

            if (isVisor) {
                currentGUI = new GUI({ title: `軒庇の設定 (${dName})` });
                currentGUI.domElement.style.position = 'absolute';
                currentGUI.domElement.style.top = '10px'; currentGUI.domElement.style.right = '10px';
                const p = b.visorParams[faceDir];
                const resetObj = { reset: () => { b.visorParams[faceDir] = { eaves: 600, keraba: 300, slope: 4 }; onFinishChange(); rebuildMeshes(); this.updateGUI(b, 'side', faceDir); }};
                currentGUI.add(p, 'eaves', 100, 1000, 100).name('軒の出 (mm)').onChange(onChange).onFinishChange(onFinishChange);
                currentGUI.add(p, 'keraba', 0, 600, 100).name('ケラバ (mm)').onChange(onChange).onFinishChange(onFinishChange);
                currentGUI.add(p, 'slope', 3, 4.5, 0.5).name('屋根勾配 (寸)').onChange(onChange).onFinishChange(onFinishChange);
                currentGUI.add(resetObj, 'reset').name('↺ デフォルトに戻す');
            } 
            else if (isFlatVisor) {
                currentGUI = new GUI({ title: `水平庇の設定 (${dName})` });
                currentGUI.domElement.style.position = 'absolute';
                currentGUI.domElement.style.top = '10px'; currentGUI.domElement.style.right = '10px';
                const p = b.flatVisorParams[faceDir];
                const resetObj = { reset: () => { b.flatVisorParams[faceDir] = { depth: 300, offsetY: 0, margin: 0 }; onFinishChange(); rebuildMeshes(); this.updateGUI(b, 'side', faceDir); }};
                currentGUI.add(p, 'depth', 100, 1000, 100).name('出寸法 (mm)').onChange(onChange).onFinishChange(onFinishChange);
                currentGUI.add(p, 'offsetY', -300, 0, 100).name('設置位置 (mm)').onChange(onChange).onFinishChange(onFinishChange);
                currentGUI.add(p, 'margin', 0, 300, 100).name('両端空き (mm)').onChange(onChange).onFinishChange(onFinishChange);
                currentGUI.add(resetObj, 'reset').name('↺ デフォルトに戻す');
            }
        }
        else if (targetType === 'balcony') {
            // ★ ここもスライダーは置かない。奥行・手すり高・側面壁高は、
            //   モデルの上のつまみで決める（窓・そで壁と同じ作法）。
            if (!faceDir || !b.balconies || !b.balconies[faceDir]) return;
            this.showPartInfo(b, { kind: 'balc', dir: faceDir }, false);
        }

        else if (targetType === 'pilaster') {
            if (!faceDir || !b.pilasters || !b.pilasters[faceDir]) return;
            const dName = { 'pz': '手前', 'nz': '奥', 'px': '右', 'nx': '左' }[faceDir] || faceDir;

            currentGUI = new GUI({ title: `つけ柱・梁 設定 (${dName})` });
            currentGUI.domElement.style.position = 'absolute';
            currentGUI.domElement.style.top = '10px'; currentGUI.domElement.style.right = '10px';

            const p = b.pilasterParams[faceDir];
            currentGUI.add(p, 'pitch', 900, 2000, 100).name('柱の間隔 (mm)').onChange(onChange).onFinishChange(() => { onFinishChange(); this.updateGUI(b, 'pilaster', faceDir); });
            currentGUI.add(p, 'beamY', 100, b.h - 100, 10).name('梁の高さ (mm)').onChange(onChange).onFinishChange(onFinishChange);

            const pillarFolder = currentGUI.addFolder('柱の個別表示');
            const L = (faceDir === 'pz' || faceDir === 'nz') ? b.w : b.d;
            const N = Math.max(1, Math.round((L - 100) / p.pitch));
            if (!p.visiblePillars) p.visiblePillars = [];
            for(let i=0; i<=N; i++) {
                if (p.visiblePillars[i] === undefined) p.visiblePillars[i] = true;
                const obj = { v: p.visiblePillars[i] };
                pillarFolder.add(obj, 'v').name(`柱 ${i+1} (${i===0?'左端':i===N?'右端':'中間'})`).onChange((val) => { p.visiblePillars[i] = val; onChange(); }).onFinishChange(onFinishChange);
            }
            const resetObj = { reset: () => { b.pilasterParams[faceDir] = { pitch: 1000, beamY: b.h - 100, visiblePillars: [] }; onFinishChange(); rebuildMeshes(); this.updateGUI(b, 'pilaster', faceDir); }};
            currentGUI.add(resetObj, 'reset').name('↺ デフォルトに戻す');
        }
        // uiController.js の updateGUI 内、一番下の else if (targetType === 'door') の後に追加
        else if (targetType === 'sodeWall' || targetType === 'tareWall') {
            // ★ ここもスライダーは置かない。奥行・高さ・縁からの位置は、
            //   モデルの上のつまみで決める（窓と同じ作法）。
            const kind = (targetType === 'sodeWall') ? 'sode' : 'tare';
            const side = (kind === 'sode')
                ? ((b.sodeWalls && b.sodeWalls[faceDir] === 'right') ? 'right' : 'left') : null;
            this.showPartInfo(b, { kind, dir: faceDir, side }, false);
        }

        // ★ 寸法の手入力（targetType 'size'）はいったんやめた。
        //   ★ 大きさはモデルの上のつまみで決め、数字は右上のパネルで確かめる。
        //   ⚠️ 戻すときは、右上のパネルに数値欄を足す形にすること。別の場所に
        //     もう1枚パネルを出すと、同じ寸法の置き場が2つになる。

    },

    showFloatingMenu(x, y, block, faceType, faceDir) {
        lastMenuX = x;
        lastMenuY = y;

        const menu = document.getElementById('floating-menu');
        menu.innerHTML = ''; 
        menu.style.display = 'flex';
        menu.style.left = (x + 80) + 'px'; 
        menu.style.top = (y + 40) + 'px';

        // ★ 一度動かしたら、その位置を覚えておく。
        //   ⚠️ 覚えないと、屋根アイコンを押すたびにパネルが元の場所へ跳ね戻る
        //     （押すと中身を作り直しているため）。避けたはずの場所へ戻ってくる。
        if (menuPos) { menu.style.left = menuPos.left; menu.style.top = menuPos.top; }

        // ★ 見出しは【パネルを動かすつまみ】。押し引きのボタンは置かない。
        //   ★ 押し引きは面の赤いつまみで足りる（掴んだ瞬間に入る。Shift＋引くと
        //     上階が増える）。同じことへの入口を2つ置くと、どちらを使うのかで迷う。
        //   ⚠️ バーそのものは消さないこと。パネルが建物に重なったとき、これを
        //     掴んで避けられる。掴めることが【見た目で分かる】よう点々を打つ。
        const grip = document.createElement('div');
        grip.style.cssText = 'display:flex;align-items:center;justify-content:center;'
            + 'gap:7px;padding:3px 8px 5px;cursor:grab;user-select:none;'
            + 'color:#98a1ad;font-size:11px;font-weight:600;letter-spacing:.04em;';
        const dots = document.createElement('div');
        dots.style.cssText = 'width:24px;height:7px;flex:none;'
            + 'background-image:radial-gradient(currentColor 1.1px, transparent 1.2px);'
            + 'background-size:6px 4px;';
        grip.appendChild(dots);
        const label = (faceType === 'model') ? '取り込んだモデル'
            : (faceType === 'top') ? '上面'
            : ({ pz: '手前面', nz: '奥面', px: '右面', nx: '左面' }[faceDir] || '面');
        grip.appendChild(document.createTextNode(label));
        let mdrag = null;
        grip.addEventListener('pointerdown', (ev) => {
            mdrag = { x: ev.clientX, y: ev.clientY,
                l: menu.offsetLeft, t: menu.offsetTop };
            grip.style.cursor = 'grabbing';
            grip.setPointerCapture(ev.pointerId);
            ev.stopPropagation();
        });
        grip.addEventListener('pointermove', (ev) => {
            if (!mdrag) return;
            const dx = ev.clientX - mdrag.x, dy = ev.clientY - mdrag.y;
            if (Math.hypot(dx, dy) < 4) return;              // 手ぶれは動かさない
            menu.style.left = (mdrag.l + dx) + 'px';
            menu.style.top = (mdrag.t + dy) + 'px';
            menuPos = { left: menu.style.left, top: menu.style.top };
        });
        grip.addEventListener('pointerup', (ev) => {
            mdrag = null;
            grip.style.cursor = 'grab';
            try { grip.releasePointerCapture(ev.pointerId); } catch (err) { /* 解放済み */ }
            ev.stopPropagation();
        });
        menu.appendChild(grip);

        // ★追加：取り込んだモデルの札。形は変えられないので、置けるのは
        //   【大きさの読み替え】と【削除】だけ。動かすのは地面の矢印。
        //   ⚠️ 単位の読み替えは必ず残すこと。glTF は m、CAD 由来は mm と
        //     まちまちで、取り違えると 1000 倍ずれて消えたように見える。
        if (faceType === 'model') {
            const note = document.createElement('div');
            note.style.cssText = 'font-size:11px;color:#6b7280;padding:0 2px 4px;'
                + 'max-width:210px;line-height:1.5;';
            note.innerHTML = '地面の矢印で動かせます。<br>形は変えられません。';
            menu.appendChild(note);

            const cap = document.createElement('div');
            cap.style.cssText = 'font-size:11px;font-weight:700;color:#98a1ad;padding:2px 2px 0;';
            cap.textContent = '大きさの読み替え';
            menu.appendChild(cap);
            const bar = document.createElement('div');
            bar.style.cssText = 'display:flex;gap:4px;';
            // ★ 単位は m・cm・mm がまちまち。÷／× を並べて、右上の寸法を見ながら
            //   合わせてもらう。何倍が正しいかは、こちらでは分からない。
            for (const [name, k, tip] of [
                ['÷1000', 0.001, '1000 分の1にする（mm のつもりが m だったとき）。'],
                ['÷10', 0.1, '10 分の1にする。'],
                ['×10', 10, '10 倍にする（cm で作られていたとき）。'],
                ['×1000', 1000, '1000 倍にする（m で作られていたとき）。']]) {
                const btn = document.createElement('div');
                btn.className = 'float-btn';
                btn.style.cssText = 'flex:1;text-align:center;padding:8px 2px;font-size:12px;';
                btn.innerText = name;
                btn.title = tip;
                btn.onclick = () => {
                    window.rescaleModel(block.id, k);
                    this.showFloatingMenu(lastMenuX, lastMenuY, block, 'model', null);
                };
                bar.appendChild(btn);
            }
            menu.appendChild(bar);

            const del = document.createElement('div');
            del.className = 'float-btn danger';
            del.innerText = 'このモデルを削除';
            del.onclick = () => window.deleteModel(block.id);
            menu.appendChild(del);
            return;
        }

        // ★ 板（作図したて）ですることは【引き上げる】だけ。パネルは出さない。
        //   ⚠️ 見出しだけのパネルが出ると、何かできそうに見えて手が止まる。
        if (block.h <= 100) { this.hideFloatingMenu(); return; }

        if (faceType === 'top') {
            // ★追加：上階を足す。SHIFT＋ドラッグは知っている人しか使えない。
            //   ⚠️ DXF から起こした階の上階は【もう1枚の図面】。同じ位置に同じ
            //     役割のボタンを置き、中身だけ変える。
            //   ⚠️ すでに上に階が載っている面には出さない。そこに足せる場所は
            //     無いので、押しても何も起きないボタンになる。この面で選べるのは
            //     【下屋】のほう。
            if (AppState.isTopClear(block)) {
                const btnUp = document.createElement('div');
                btnUp.className = 'float-btn';
                btnUp.innerText = block.kind === 'dxf' ? '上階を足す（DXF）' : '上階を足す';
                // ⚠️ 屋根の上に階は載せられない。押せてしまうと、屋根を突き抜けた
                //   階ができて、どちらを消せばよいのか分からなくなる。
                if (roofBlock(block).roof) {
                    btnUp.style.cssText = 'opacity:.4;cursor:not-allowed;';
                    btnUp.title = '屋根があるうちは上階を足せません。先に屋根を外してください。';
                } else {
                    btnUp.onclick = () => window.addUpperFloor();
                }
                menu.appendChild(btnUp);
            }

            if (AppState.isTopClear(block)) {
                // ★追加：屋根は【アイコンから選ぶ】。押すたびに次の型へ回る
                //   ボタンは、何回押せば目当ての形になるかが分からなかった。
                //   ⚠️ アイコンはどれも【同じ自由屋根の1点】を初期値として置く
                //     だけ。押したあとは辺ごとのつまみで連続的に変えられる。
                //   ★ もう一度押すと外れる（トグル）。戻し方が分かっていれば、
                //     人は安心して押せる。
                // ★ 直方体を並べた形（L字など）では、屋根の【形は選ばせない】。
                //   ⚠️ 切妻・入母屋・棟のずれは「棟が1本」を前提にした指定で、
                //     棟が何本もある形では、どの棟をどうするのか言えない。
                //     並べた形に掛けられるのは寄棟だけなので、押すだけにする。
                const many = roofGroup(block).length > 1;
                if (many) {
                    const on = !!roofBlock(block).roof;
                    const btnBig = document.createElement('div');
                    btnBig.className = 'float-btn';
                    if (on) btnBig.classList.add('warning');
                    btnBig.innerText = on ? '🏠 大屋根（寄棟）' : '🏠 大屋根をかける（寄棟）';
                    btnBig.title = '並べた直方体ぜんぶに1枚の寄棟屋根が掛かります。';
                    btnBig.onclick = () => window.setRoofPreset(on ? null : 'yosemune');
                    menu.appendChild(btnBig);
                    if (on) {
                        // ★ 棟をひと続きにするか、棟ごとに分けるか。
                        //   ⚠️ つなぐと、細い棟の屋根は【軒から棟までの距離を
                        //     揃えるぶん】広がる。隣に隠れる側から広げるので
                        //     たいていは見えないが、足りなければ外へも出る。
                        const pr = roofBlock(block).roof.params['自由屋根'];
                        const btnJoin = document.createElement('div');
                        btnJoin.className = 'float-btn';
                        if (pr.join) btnJoin.classList.add('warning');
                        btnJoin.innerText = pr.join ? '⌐ 棟：ひと続き' : '⌐ 棟：別々';
                        btnJoin.title = '棟をひと続きにすると、棟の高さが揃います。';
                        btnJoin.onclick = () => window.setRoofJoin(!pr.join);
                        menu.appendChild(btnJoin);
                    }
                } else {
                    // ★ 絵は入れない。小さな絵は屋根の形を伝えられず、字も
                    //   読めなくなるだけだった。文字だけ、大きく。
                    const roofBar = document.createElement('div');
                    roofBar.style.cssText = 'display:flex;gap:4px;margin:2px 0;'
                        + 'min-width:232px;';
                    for (const it of ROOF_ICONS) {
                        const ic = document.createElement('div');
                        ic.className = 'float-btn';
                        ic.style.cssText = 'flex:1;text-align:center;padding:9px 2px;'
                            + 'font-size:14px;font-weight:700;white-space:nowrap;';
                        const on = isRoofPreset(block, it);
                        if (on) ic.classList.add('warning');
                        ic.innerText = it.name;
                        ic.onclick = () => window.setRoofPreset(on ? null : it.key);
                        roofBar.appendChild(ic);
                    }
                    menu.appendChild(roofBar);
                }

                // ★ 巡回ボタンはやめた。全部アイコンに出ているので、
                //   「あと何回押せば目当ての形になるか」を数えなくてよい。
                if (roofBlock(block).roof) {
                    // ★追加：屋根の切り欠き（上から見て長方形の穴）。
                    //   ⚠️ 自由屋根だけ。パラペット修景屋根は別の作り方なので出さない。
                    const rb = roofBlock(block);
                    if (rb.roof.type === '自由屋根') {
                        const has = !!freeNotch(rb);
                        const btnN = document.createElement('div');
                        btnN.className = 'float-btn';
                        if (has) btnN.classList.add('danger');
                        btnN.innerText = has ? '切り欠きを消す' : '切り欠きを作成';
                        btnN.title = has ? '屋根の穴を埋めます。'
                            : '屋根に長方形の穴を開けます。置いたあとは、'
                                + '穴のつまみで大きさと位置を変えられます。';
                        btnN.onclick = () => window.toggleNotch();
                        menu.appendChild(btnN);
                    }
                    const btnRoof = document.createElement('div');
                    btnRoof.className = 'float-btn danger';
                    btnRoof.innerText = '大屋根を削除';
                    btnRoof.onclick = () => window.setRoofPreset(null);
                    menu.appendChild(btnRoof);
                }
            } else {
                // ★ 下屋も【形をアイコンから選ぶ】。押すたびに次の型へ回る
                //   ボタンでは、何回押せば目当ての形になるのか分からなかった。
                //   ⚠️ 押したあとの寸法は、大屋根と同じくモデルの上のつまみで
                //     決める。ここで選ぶのは【平入りか切妻か】だけ。
                const cur = block.lowerRoof ? (block.lowerRoof.type || '平入り/寄棟') : null;
                const bar = document.createElement('div');
                bar.style.cssText = 'display:flex;gap:4px;margin:2px 0;'
                    + 'min-width:200px;';
                for (const it of GEYA_ICONS) {
                    const ic = document.createElement('div');
                    ic.className = 'float-btn';
                    ic.style.cssText = 'flex:1;text-align:center;padding:9px 2px;'
                        + 'font-size:14px;font-weight:700;white-space:nowrap;';
                    // ⚠️ 「切妻2」で保存された下屋も、切妻のボタンで光らせる。
                    //   ボタンからは選べないが、開いたときに何も光らないと
                    //   屋根が無いように見える。
                    const on = it.type === '妻入り/切妻1'
                        ? (cur === '妻入り/切妻1' || cur === '切妻2') : (cur === it.type);
                    // ⚠️ 名前を入れ忘れると【青い箱が並ぶだけ】になる。選ばれて
                    //   いるものを橙にするのも、大屋根のボタンと揃えること。
                    ic.innerText = it.name;
                    if (on) ic.classList.add('warning');
                    ic.title = it.hint;
                    ic.onclick = () => window.setLowerRoof(on ? null : it.type);
                    bar.appendChild(ic);
                }
                menu.appendChild(bar);
                if (block.lowerRoof) {
                    const btnDel = document.createElement('div');
                    btnDel.className = 'float-btn danger';
                    btnDel.innerText = '下屋を削除';
                    btnDel.onclick = () => window.setLowerRoof(null);
                    menu.appendChild(btnDel);
                }
            }
        } 
        else if (faceType === 'side') {
            // ★ 壁面の修景は【小さな札を並べる】。縦長のボタンの列は、選んで
            //   いる面よりパネルのほうが大きくなり、建物が見えなくなっていた。
            //   ⚠️ 付け柱・付け梁は、いったん外してある（作図しない）。
            //     戻すときは、ここに札を1枚足すだけでよい。
            const ground = !block.y || Math.abs(block.y) < 1;
            const has = (box) => !!(box && box[faceDir]);
            // ★追加：庇。押すたびに 軒庇 → 水平庇 → なし と回る（従来どおり）。
            //   ★ 札の名前は【いま付いているもの】にする。「軒庇」と書いてあるのに
            //     水平庇が付いている、という食い違いを避ける。
            const isVisor = (block.visors || []).includes(faceDir);
            const isFlatVisor = (block.flatVisors || []).includes(faceDir);
            const items = [
                { name: '窓', on: has(block.windows),
                    hint: '押すたびに窓を1つ足す。窓を掴んで移動、つまみで大きさ、'
                        + 'パネルで種類（引違い・FIX・すべり出し）。'
                        + '消すときは、その窓をクリックして Delete。',
                    act: () => window.toggleWindow(faceDir) },
                ground ? { name: '玄関', on: has(block.doors),
                    hint: '押すと玄関を置く／消す。置いたあとは扉を掴んで移動、赤いつまみで大きさ。',
                    act: () => window.toggleDoor(faceDir) } : null,
                { name: 'バルコニー', on: has(block.balconies),
                    hint: '押すとバルコニーを置く／消す。置いたあとはクリックして選び、'
                        + 'つまみで大きさ、パネルで ガラス／手すり子 を選ぶ。',
                    act: () => window.toggleBalcony(faceDir) },
                { name: 'そで壁', on: has(block.sodeWalls),
                    hint: '押すと そで壁を置く／消す。',
                    act: () => window.toggleSodeWall(faceDir) },
                { name: '垂れ壁', on: has(block.tareWalls),
                    hint: '押すと 垂れ壁を置く／消す。',
                    act: () => window.toggleTareWall(faceDir) },
                { name: isFlatVisor ? '水平庇' : '軒庇', on: isVisor || isFlatVisor,
                    hint: '押すたびに 軒庇 → 水平庇 → なし と変わる。'
                        + '寸法（軒の出・ケラバ・勾配／出・高さ）は右上のパネルで。',
                    act: () => window.cycleVisor(faceDir) },
            ].filter(Boolean);
            const bar = document.createElement('div');
            bar.style.cssText = 'display:grid;grid-template-columns:repeat(3,1fr);'
                + 'gap:4px;margin:2px 0;min-width:232px;';
            for (const it of items) {
                const ic = document.createElement('div');
                ic.className = 'float-btn';
                if (it.on) ic.classList.add('warning');
                ic.style.cssText = 'text-align:center;padding:9px 2px;font-size:13px;'
                    + 'font-weight:700;white-space:nowrap;';
                ic.innerText = it.name;
                ic.title = it.hint;
                ic.onclick = it.act;
                bar.appendChild(ic);
            }
            menu.appendChild(bar);
        }
    },

    /* ★追加：選んだ修景要素の【種類】を選ぶパネル。モデルのそばに出す。
       ★ 位置は修景のパネルと同じ場所・同じ見た目。選ぶ相手のすぐ近くに置く。
       ⚠️ 種類の無い要素（そで壁・垂れ壁・玄関）では出さない。 */
    showPartMenu(x, y, b, sel) {
        const types = (b && sel) ? partTypes(sel) : null;
        const menu = document.getElementById('floating-menu');
        if (!menu) return;
        if (!types) { this.hideFloatingMenu(); return; }
        lastMenuX = x; lastMenuY = y;
        menu.innerHTML = '';
        menu.style.display = 'flex';
        menu.style.left = (x + 80) + 'px';
        menu.style.top = (y + 40) + 'px';
        if (menuPos) { menu.style.left = menuPos.left; menu.style.top = menuPos.top; }

        const head = document.createElement('div');
        head.style.cssText = 'text-align:center;padding:3px 8px 5px;user-select:none;'
            + 'color:#98a1ad;font-size:11px;font-weight:600;letter-spacing:.04em;';
        head.innerText = (sel.kind === 'visor' || sel.kind === 'flat')
            ? '庇の種類' : `${PART_BODY[sel.kind] || ''}の種類`;
        menu.appendChild(head);

        const now = partTypeOf(b, sel);
        const bar = document.createElement('div');
        bar.style.cssText = 'display:flex;gap:4px;margin:2px 0;min-width:180px;';
        for (const [k, nm] of types) {
            const ic = document.createElement('div');
            ic.className = 'float-btn';
            if (k === now) ic.classList.add('warning');
            ic.style.cssText = 'flex:1;text-align:center;padding:9px 2px;'
                + 'font-size:13px;font-weight:700;white-space:nowrap;';
            ic.innerText = nm;
            ic.onclick = () => applyPartType(b, sel, k);
            bar.appendChild(ic);
        }
        menu.appendChild(bar);
    },

    hideFloatingMenu() {
        const menu = document.getElementById('floating-menu');
        if(menu) menu.style.display = 'none';
        // ⚠️ 動かした位置は閉じたら忘れる。次に別の面を選んだとき、遠くの
        //   置きっぱなしの場所に出ると、どこに出たのか分からない。
        menuPos = null;
    },

    updateStatusDisplay(currentTool) {
        const statusText = document.getElementById('status-text');
        if (!statusText) return;

        if (currentTool === 'DRAW') {
            statusText.innerHTML = "▶ 床面をドラッグして平面を作図します<br>▶ 背景クリックでキャンセル";
        } else if (currentTool === 'EXTRUDE') {
            statusText.innerHTML = "▶ 面をドラッグして建物をプッシュプルします<br>▶ 面＋Shiftキーで新規ブロックを追加";
        } else if (AppState.selectedId !== null) {
            const b = AppState.buildingData.find(d => d.id === AppState.selectedId);
            if (!b) return;

            let msgs = ["▶ オブジェクトを選択中 (Deleteキーで削除)"];
            // ★ 入口は【面の赤いつまみ】。ボタンではなく、つまみの言葉で説明する。
            if (b.h <= 100) msgs.push("▶ 赤いつまみを引くと立ち上がります");
            else if (AppState.isTopClear(b)) {
                msgs.push("▶ 面のつまみを引くと大きさが変わります"
                    + "（上面は Shift ＋引くと上階が増えます）");
                msgs.push("▶ 屋根・修景はパネルから");
            } else {
                msgs.push("▶ 面のつまみを引くと大きさが変わります");
                msgs.push("▶ 下屋・修景はパネルから");
            }
            statusText.innerHTML = msgs.join("<br>");
        } else {
            statusText.innerHTML = "▶ オブジェクトを選択するか、ツールを選んでください";
        }
    },

    /**
     * トグル系の関数を window に登録する
     */
    setupGlobalToggles() {
        const executeAction = (action) => {
            if (!AppState.selectedId) return;
            const b = AppState.buildingData.find(d => d.id === AppState.selectedId);
            if (!b) return;
            action(b);
            AppState.saveState();
            AppState.updateAllLowerRoofs(); 
            rebuildMeshes();
            if (window.triggerHighlightSync) window.triggerHighlightSync();
            this.updateActionButtons();
        };

        window.addRoof = (type) => executeAction((b) => {
            if (!AppState.isTopClear(b)) return alert('上に別のブロックが乗っているため、大屋根は配置できません。');
            b.roof = { type: type, params: JSON.parse(JSON.stringify(defaultRoofParams)) };
            this.updateGUI(b, 'roof');
        });

        // ★ アイコンから屋根を置く／外す。key が null なら外す。
        window.setRoofPreset = (key) => executeAction((b0) => {
            const b = roofBlock(b0);
            if (!key) { delete b.roof; this.clearGUI(); }
            else {
                if (!AppState.isTopClear(b)) return alert('上に別のブロックが乗っているため、屋根は配置できません。');
                const it = ROOF_ICONS.find((r) => r.key === key);
                const params = JSON.parse(JSON.stringify(
                    b.roof ? b.roof.params : defaultRoofParams));
                if (it.kind === 'free') {
                    // ⚠️ 勾配と軒の出は引き継ぐ。アイコンを押すたびに戻ると、
                    //   形を見比べるだけで寸法をやり直すことになる。
                    const cur = (b.roof && b.roof.params && b.roof.params['自由屋根']) || {};
                    params['自由屋根'] = { ...defaultRoofParams['自由屋根'],
                        slope: cur.slope ?? 4, eaves: cur.eaves ?? 600, ...it.g(b) };
                    b.roof = { type: '自由屋根', params };
                } else {
                    b.roof = { type: it.type, params };
                }
            }
            this.showFloatingMenu(lastMenuX, lastMenuY, b, 'top', null);
            if (b.roof) this.updateGUI(b, 'roof');
        });

        // ★追加：屋根の切り欠き。押すと置く／消す。
        //   ★ 置いたあとの大きさと位置は、屋根の上のつまみで決める（05 と同じ）。
        //   ⚠️ 入る場所が無いときは置かない。無理に置くと屋根の外へはみ出す。
        window.toggleNotch = () => executeAction((b0) => {
            const b = roofBlock(b0);
            const pr = b.roof && b.roof.params && b.roof.params['自由屋根'];
            if (!pr) return;
            if (pr.notch) delete pr.notch;
            else {
                const n = notchSpot(b);
                if (!n) {
                    alert(`一辺 ${NOTCH_MIN} mm の穴が入る場所がありません。\n`
                        + '屋根を大きくしてから、もう一度ためしてください。');
                    return;
                }
                pr.notch = n;
            }
            this.showFloatingMenu(lastMenuX, lastMenuY, b0, 'top', null);
        });

        // ★ 棟をつなぐ／分ける。並べた形のときだけ意味がある。
        window.setRoofJoin = (v) => executeAction((b0) => {
            const b = roofBlock(b0);
            if (!b.roof || b.roof.type !== '自由屋根') return;
            const pr = b.roof.params['自由屋根'];
            pr.join = !!v;
            // ⚠️ 矩形ごとの上書きは【矩形番号】で持っている。棟のつなぎ方を
            //   変えると矩形の分け方そのものが変わるので、番号の意味が
            //   食い違う。掛け直しとみなして捨てる。
            delete pr.outs; delete pr.gbl; delete pr.shf;
            this.showFloatingMenu(lastMenuX, lastMenuY, b0, 'top', null);
            this.updateGUI(b, 'roof');
        });

        // ★ 上階を足す。直方体なら箱が生え、DXF の階なら図面を選びにいく。
        //   ⚠️ 足したら【その上面を選んだ状態】にする。つまみが出ていないと、
        //     次に高さを与える手がかりが無い。
        window.addUpperFloor = () => {
            const b = AppState.buildingData.find(d => d.id === AppState.selectedId);
            if (!b) return;
            if (b.kind === 'dxf') { this.hideFloatingMenu(); window.addDxfFloor(); return; }
            executeAction((bb) => {
                const newId = Date.now().toString();
                AppState.buildingData.push({
                    id: newId, rootBuildingId: bb.rootBuildingId || bb.id,
                    x: bb.x, y: (bb.y || 0) + bb.h, z: bb.z,
                    w: bb.w, d: bb.d, h: 500,
                });
                AppState.selectedId = newId;
                AppState.selectedFaceDir = 'top';
            });
            this.hideFloatingMenu();
        };

        window.toggleRoof = () => executeAction((b) => {
            if (!AppState.isTopClear(b)) return alert('上に別のブロックが乗っているため、大屋根は配置できません。');
            if (!b.roof) b.roof = { type: '切妻', params: JSON.parse(JSON.stringify(defaultRoofParams)) };
            else if (b.roof.type === '切妻' && !b.roof.params['切妻'].rotate90) b.roof.params['切妻'].rotate90 = true;
            else if (b.roof.type === '切妻' && b.roof.params['切妻'].rotate90) b.roof.type = '寄棟';
            else if (b.roof.type === '寄棟') b.roof.type = 'パラペット修景'; 
            else if (b.roof.type === 'パラペット修景') b.roof.type = '陸屋根';
            else if (b.roof.type === '陸屋根') b.roof.type = '自由屋根';
            else { delete b.roof; this.clearGUI(); }
            this.showFloatingMenu(lastMenuX, lastMenuY, b, 'top', null);
            if (b.roof) this.updateGUI(b, 'roof');
        });

        // ★ 下屋を【選んだ形で】置く。type が null なら外す。
        //   ⚠️ 順ぐりに回すのはやめた。何回押せば目当ての形になるか数えさせない。
        window.setLowerRoof = (type) => executeAction((b) => {
            if (!type) { delete b.lowerRoof; this.clearGUI(); }
            else {
                const cur = b.lowerRoof;
                // 寸法は引き継ぐ。形を見比べるだけで数字をやり直すのは面倒すぎる。
                const eaves = (cur && cur.eaves !== undefined) ? cur.eaves : 600;
                const keraba = (cur && cur.keraba !== undefined) ? cur.keraba : 300;
                const slope = (cur && cur.slope !== undefined) ? cur.slope : 4;
                b.lowerRoof = {
                    type, eaves, keraba, slope, thick: 150,
                    eaves_l: (cur && cur.eaves_l !== undefined) ? cur.eaves_l : eaves,
                    eaves_r: (cur && cur.eaves_r !== undefined) ? cur.eaves_r : eaves,
                    keraba_l: (cur && cur.keraba_l !== undefined) ? cur.keraba_l : keraba,
                    keraba_r: (cur && cur.keraba_r !== undefined) ? cur.keraba_r : keraba,
                    ridgeOffset: (cur && cur.ridgeOffset) || 0,
                    // 掛かり幅はこのあと updateAllLowerRoofs が上の階から測り直す。
                    out_nx: (cur && cur.out_nx) || 0, out_px: (cur && cur.out_px) || 0,
                    out_nz: (cur && cur.out_nz) || 0, out_pz: (cur && cur.out_pz) || 0,
                };
                AppState.updateAllLowerRoofs();
            }
            this.showFloatingMenu(lastMenuX, lastMenuY, b, 'top', null);
            if (b.lowerRoof) this.updateGUI(b, 'lowerRoof');
        });
        // ⚠️ 古い呼び名も残しておく。チュートリアルなど、外から呼ぶところがある。
        window.toggleLowerRoof = () => window.setLowerRoof(
            (AppState.buildingData.find(d => d.id === AppState.selectedId) || {}).lowerRoof
                ? null : '平入り/寄棟');

        window.toggleBalcony = (dir) => executeAction((b) => {
            if (!b.balconies) { b.balconies = {}; b.balcParams = {}; }
            // ★ 置く／外すの2段階だけ。ガラスか手すり子かは、置いたあとに
            //   バルコニーをクリックして【パネルで選ぶ】。
            const current = b.balconies[dir];
            if (!current) { b.balconies[dir] = 'glass'; b.balcParams[dir] = { depth: 1000, h_handrail: 1100, h_side: 1100 }; }
            else { delete b.balconies[dir]; delete b.balcParams[dir]; }
            if (Object.keys(b.balconies).length === 0) { delete b.balconies; delete b.balcParams; }
            if (b.balconies && b.balconies[dir]) {
                // ★ 置いた直後は【そのバルコニーを選んだ状態】にして、
                //   ガラス／手すり子の札をそのまま出す。同じ面に2つは置けないので、
                //   修景の札に戻す意味がない。
                AppState.selectedPart = { kind: 'balc', dir };
                this.showPartMenu(lastMenuX, lastMenuY, b, AppState.selectedPart);
                this.showPartInfo(b, AppState.selectedPart, true);
            } else {
                AppState.selectedPart = null;
                this.showFloatingMenu(lastMenuX, lastMenuY, b, 'side', dir);
                this.clearGUI();
            }
        });

        window.togglePilaster = (dir) => executeAction((b) => {
            if (!b.pilasters) { b.pilasters = {}; b.pilasterParams = {}; }
            if (!b.pilasters[dir]) { b.pilasters[dir] = true; b.pilasterParams[dir] = { pitch: 1000, beamY: b.h - 100, visiblePillars: [] }; } 
            else { delete b.pilasters[dir]; delete b.pilasterParams[dir]; }
            if (Object.keys(b.pilasters).length === 0) { delete b.pilasters; delete b.pilasterParams; }
            this.showFloatingMenu(lastMenuX, lastMenuY, b, 'side', dir);
            if (b.pilasters && b.pilasters[dir]) this.updateGUI(b, 'pilaster', dir); else this.clearGUI();
        });

        // ★ 窓は面ごとに【何枚でも】置ける。押すたびに1枚足す。
        //   ⚠️ 消すのはボタンではなく、消したい窓をクリックして Delete。
        //     ボタンで消すと、どの1枚が消えるのかが言えない。
        window.toggleWindow = (dir) => executeAction((b) => {
            if (!b.windows) { b.windows = {}; b.windowParams = {}; }
            if (!b.windows[dir]) { b.windows[dir] = true; b.windowParams[dir] = []; }
            const list = ModelingEngine.openList(b, dir, 'window');
            const L = (dir === 'pz' || dir === 'nz') ? b.w : b.d;
            const W0 = 1970, EDGE = 100, GAP = 300;
            const width = Math.max(600, Math.min(W0, L - EDGE * 2));
            // すでにある窓の【右隣】へ。入らなければ左隣、それも無理なら真ん中。
            let u = 0;
            if (list.length) {
                const rs = list.map((p) => (p.offsetX || 0) + (p.width || W0) / 2);
                const ls = list.map((p) => (p.offsetX || 0) - (p.width || W0) / 2);
                const right = Math.max(...rs), left = Math.min(...ls);
                if (right + GAP + width <= L / 2 - EDGE) u = right + GAP + width / 2;
                else if (left - GAP - width >= -L / 2 + EDGE) u = left - GAP - width / 2;
            }
            const lim = Math.max(0, L / 2 - EDGE - width / 2);
            list.push({ type: 'sliding', width, height: 2000,
                offsetX: Math.round(Math.min(Math.max(u, -lim), lim)), offsetY: 0 });
            // 足した直後は【その1枚】を選んだ状態に。つまみがすぐ出る。
            AppState.selectedPart = { kind: 'window', dir, i: list.length - 1 };
            this.showFloatingMenu(lastMenuX, lastMenuY, b, 'side', dir);
            this.showPartInfo(b, AppState.selectedPart, true);
        });

        window.toggleDoor = (dir) => executeAction((b) => {
            if (!b.doors) { b.doors = {}; b.doorParams = {}; }
            if (!b.doors[dir]) { b.doors[dir] = true; b.doorParams[dir] = { width: 900, height: 2000, offsetX: 0 }; } 
            else { delete b.doors[dir]; delete b.doorParams[dir]; }
            if (Object.keys(b.doors).length === 0) { delete b.doors; delete b.doorParams; }
            this.showFloatingMenu(lastMenuX, lastMenuY, b, 'side', dir);
            if (b.doors && b.doors[dir]) {
                AppState.selectedPart = { kind: 'door', dir, i: 0 };
                this.showPartInfo(b, AppState.selectedPart, true);
            } else { AppState.selectedPart = null; this.clearGUI(); }
        });

        window.cycleVisor = (dir) => executeAction((b) => {
            if (!b.visors) b.visors = []; if (!b.flatVisors) b.flatVisors = [];
            if (!b.visorParams) b.visorParams = {}; if (!b.flatVisorParams) b.flatVisorParams = {};
            const vIdx = b.visors.indexOf(dir); const fIdx = b.flatVisors.indexOf(dir);

            if (vIdx === -1 && fIdx === -1) { b.visors.push(dir); b.visorParams[dir] = { eaves: 600, keraba: 300, slope: 4 }; } 
            else if (vIdx > -1) { b.visors.splice(vIdx, 1); delete b.visorParams[dir]; b.flatVisors.push(dir); b.flatVisorParams[dir] = { depth: 300, offsetY: 0, margin: 0 }; } 
            else if (fIdx > -1) { b.flatVisors.splice(fIdx, 1); delete b.flatVisorParams[dir]; }

            if (b.visors.length === 0) delete b.visors; if (b.flatVisors.length === 0) delete b.flatVisors;
            if (Object.keys(b.visorParams).length === 0) delete b.visorParams; if (Object.keys(b.flatVisorParams).length === 0) delete b.flatVisorParams;
            
            this.showFloatingMenu(lastMenuX, lastMenuY, b, 'side', dir);
            // ★ 置いたらその庇を選んだ状態にする。つまみがすぐ出て、
            //   寸法はモデルの上で決められる（スライダーは置かない）。
            const onV = b.visors && b.visors.includes(dir);
            const onF = b.flatVisors && b.flatVisors.includes(dir);
            if (onV || onF) {
                AppState.selectedPart = { kind: onF ? 'flat' : 'visor', dir };
                this.showPartInfo(b, AppState.selectedPart, true);
            } else {
                AppState.selectedPart = null;
                this.clearGUI();
            }
        });

        window.removeRoof = () => executeAction((b) => {
            let removed = false;
            ['roof', 'lowerRoof', 'visors', 'flatVisors', 'balconies', 'visorParams', 'flatVisorParams'].forEach(key => {
                if (b[key]) { delete b[key]; removed = true; }
            });
            if (removed) this.clearGUI();
        });

        window.toggleSodeWall = (dir) => executeAction((b) => {
            if (!b.sodeWalls) b.sodeWalls = {};
            if (!b.sodeParams) b.sodeParams = {};
            
            // すでに存在する場合は削除、存在しない場合は「両方」で追加の2段階のみ
            if (!b.sodeWalls[dir]) {
                b.sodeWalls[dir] = 'both';
                b.sodeParams[dir] = { left: { depth: 900, topGap: 0, inset: 0 }, right: { depth: 900, topGap: 0, inset: 0 } };
            } else {
                delete b.sodeWalls[dir];
                delete b.sodeParams[dir];
            }
            
            if (Object.keys(b.sodeWalls).length === 0) delete b.sodeWalls;
            if (Object.keys(b.sodeParams).length === 0) delete b.sodeParams;

            rebuildMeshes();

            this.showFloatingMenu(lastMenuX, lastMenuY, b, 'side', dir);
            if (b.sodeWalls && b.sodeWalls[dir]) {
                // 足した直後は【左のそで壁】を選んだ状態に。つまみがすぐ出る。
                AppState.selectedPart = { kind: 'sode', dir, side: 'left' };
                this.showPartInfo(b, AppState.selectedPart, true);
            } else {
                AppState.selectedPart = null;
                this.updateGUI(b, 'side', dir);
            }
        });
        // ★追加：垂れ壁のトグル処理
        window.toggleTareWall = (dir) => executeAction((b) => {
            if (!b.tareWalls) b.tareWalls = {};
            if (!b.tareParams) b.tareParams = {};
            
            // 存在しない場合は「追加（初期値900）」、存在する場合は「削除」
            if (!b.tareWalls[dir]) {
                b.tareWalls[dir] = true;
                b.tareParams[dir] = { height: 900, left: 0, right: 0 };
            } else {
                delete b.tareWalls[dir];
                delete b.tareParams[dir];
            }
            
            if (Object.keys(b.tareWalls).length === 0) delete b.tareWalls;
            if (Object.keys(b.tareParams).length === 0) delete b.tareParams;

            rebuildMeshes();

            this.showFloatingMenu(lastMenuX, lastMenuY, b, 'side', dir);
            if (b.tareWalls && b.tareWalls[dir]) {
                AppState.selectedPart = { kind: 'tare', dir };
                this.showPartInfo(b, AppState.selectedPart, true);
            } else {
                AppState.selectedPart = null;
                this.updateGUI(b, 'side', dir);
            }
        });

    }
};