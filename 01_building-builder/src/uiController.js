// uiController.js
import { GUI } from 'lil-gui';
import { AppState } from './appState.js';

let currentGUI = null;
let lastMenuX = 0;
let lastMenuY = 0;

// index.html側から関数を受け取るための変数
let rebuildMeshes = () => {};
let setTool = () => {};

const defaultRoofParams = {
    '切妻': { eaves_l: 600, eaves_r: 600, keraba_l: 300, keraba_r: 300, slope: 4, rotate90: false, ridgeOffset: 0 },
    '寄棟': { eaves: 600, keraba: 600, slope: 4 },
    'パラペット修景': { pHeight: 300, slope: 3, out_px: 600, in_px: 400, flatEaves: false },
    '陸屋根': { pHeight: 300 }
};

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

    updateGUI(b, targetType = 'roof', faceDir = null) {
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

            if (type === '切妻') {
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
                // 古いセーブデータとの互換性
                if (params.ridge_dist === undefined) params.ridge_dist = params.in_px / 2;

                const maxIn_geom = Math.floor(Math.min(b.w / 2, b.d / 2) / 50) * 50; 
                
                // コントローラーを変数に格納（後で連動させるため）
                const pHeightCtrl = currentGUI.add(params, 'pHeight', 150, 1000, 50).name('パラペット高さ (mm)');
                const slopeCtrl = currentGUI.add(params, 'slope', 0, 10, 0.5).name('笠木勾配 (寸)');
                currentGUI.add(params, 'out_px', 0, 2000, 100).name('外方向の出幅 (mm)').onChange(onChange).onFinishChange(onFinishChange);
                
                const inCtrl = currentGUI.add(params, 'in_px', 0, maxIn_geom, 50).name('内方向の総寸法 (mm)');
                const ridgeCtrl = currentGUI.add(params, 'ridge_dist', 0, maxIn_geom, 50).name('棟の水平位置 (mm)');

                // ★追加：床に到達する限界値を動的に計算し、スライダーの最大値を制限する関数
                const updateLimits = () => {
                    const rSlope = params.slope / 10;
                    let floorHitInPx = maxIn_geom;
                    
                    if (rSlope > 0) {
                        // 床(y=0)に到達する最大の内方向寸法を数式から逆算
                        floorHitInPx = (2 * params.ridge_dist) + (params.pHeight / rSlope);
                    }
                    
                    // 建物の中心(maxIn_geom)か、床に当たる寸法か、どちらか小さい方を限界値とする
                    const dynamicMaxIn = Math.min(maxIn_geom, Math.floor(floorHitInPx / 50) * 50);
                    
                    // 内方向の寸法の「最大値」を更新し、はみ出ていればツマミを限界値まで押し戻す
                    inCtrl.max(dynamicMaxIn);
                    if (params.in_px > dynamicMaxIn) {
                        inCtrl.setValue(dynamicMaxIn);
                    }

                    // 棟の位置の「最大値」は、常に内方向の総寸法までとする
                    ridgeCtrl.max(params.in_px);
                    if (params.ridge_dist > params.in_px) {
                        ridgeCtrl.setValue(params.in_px);
                    }
                };

                // 各スライダーが動くたびに限界値を再計算する
                pHeightCtrl.onChange((val) => { updateLimits(); onChange(); }).onFinishChange(onFinishChange);
                slopeCtrl.onChange((val) => { updateLimits(); onChange(); }).onFinishChange(onFinishChange);

                inCtrl.onChange((val) => {
                    ridgeCtrl.max(val);
                    if (params.ridge_dist > val) {
                        ridgeCtrl.setValue(val);
                    } else {
                        onChange();
                    }
                }).onFinishChange(onFinishChange);
                
                ridgeCtrl.onChange((val) => {
                    updateLimits();
                    onChange();
                }).onFinishChange(onFinishChange);
                
                if (params.flatEaves === undefined) params.flatEaves = false;
                currentGUI.add(params, 'flatEaves').name('水平軒裏にする').onChange(onChange).onFinishChange(onFinishChange);
                // メニューを開いた瞬間に最新の制限を適用
                updateLimits();
            } else if (type === '陸屋根') {
                currentGUI.add(params, 'pHeight', 150, 1000, 50).name('パラペット高さ (mm)').onChange(onChange).onFinishChange(onFinishChange);
            }
            currentGUI.add(resetObj, 'reset').name('↺ デフォルトに戻す');
        }
        else if (targetType === 'lowerRoof') {
            if (!b.lowerRoof) return;
            currentGUI = new GUI({ title: '下屋の寸法設定' });
            currentGUI.domElement.style.position = 'absolute';
            currentGUI.domElement.style.top = '10px';
            currentGUI.domElement.style.right = '10px';

            const lr = b.lowerRoof;
            const type = lr.type || '平入り/寄棟';

            const resetObj = {
                reset: () => {
                    if (type === '妻入り/切妻1' || type === '切妻2') {
                        b.lowerRoof.eaves_l = 600; b.lowerRoof.eaves_r = 600;
                        b.lowerRoof.keraba_l = 300; b.lowerRoof.keraba_r = 300;
                        b.lowerRoof.ridgeOffset = 0;
                    } else {
                        b.lowerRoof.eaves = 600; b.lowerRoof.keraba = 300;
                    }
                    b.lowerRoof.slope = 4;
                    onFinishChange(); rebuildMeshes(); this.updateGUI(b, 'lowerRoof'); 
                }
            };

            // ★追加：切妻系（妻入り）のときは大屋根と同様に左右・前後の個別調整と棟のズレを可能にする
            if (type === '妻入り/切妻1' || type === '切妻2') {
                // 安全対策：パラメータが未定義の場合は初期値を代入
                if (lr.eaves_l === undefined) lr.eaves_l = lr.eaves !== undefined ? lr.eaves : 600;
                if (lr.eaves_r === undefined) lr.eaves_r = lr.eaves !== undefined ? lr.eaves : 600;
                if (lr.keraba_l === undefined) lr.keraba_l = lr.keraba !== undefined ? lr.keraba : 300;
                if (lr.keraba_r === undefined) lr.keraba_r = lr.keraba !== undefined ? lr.keraba : 300;
                if (lr.ridgeOffset === undefined) lr.ridgeOffset = 0;

                // 3D側の棟の反転ロジック(isGableX)に合わせてラベル名を分かりやすく動的に変更
                const isCorner = (lr.out_nx > 0 || lr.out_px > 0) && (lr.out_nz > 0 || lr.out_pz > 0);
                let isGableX = false;
                if (type === '切妻2') isGableX = false;
                else if (isCorner) isGableX = true;
                else if (lr.out_nz > 0 || lr.out_pz > 0) isGableX = false;
                else isGableX = true;

                const labelEavesL = isGableX ? '軒の出 (左) (mm)'   : '軒の出 (手前) (mm)';
                const labelEavesR = isGableX ? '軒の出 (右) (mm)'   : '軒の出 (奥) (mm)';
                const labelKerabaL = isGableX ? 'ケラバ (手前) (mm)' : 'ケラバ (左) (mm)';
                const labelKerabaR = isGableX ? 'ケラバ (奥) (mm)'   : 'ケラバ (右) (mm)';

                currentGUI.add(lr, 'eaves_l', 0, 2000, 50).name(labelEavesL).onChange(onChange).onFinishChange(onFinishChange);
                currentGUI.add(lr, 'eaves_r', 0, 2000, 50).name(labelEavesR).onChange(onChange).onFinishChange(onFinishChange);
                currentGUI.add(lr, 'keraba_l', 0, 2000, 50).name(labelKerabaL).onChange(onChange).onFinishChange(onFinishChange);
                currentGUI.add(lr, 'keraba_r', 0, 2000, 50).name(labelKerabaR).onChange(onChange).onFinishChange(onFinishChange);
                
                // ★修正：棟の位置（ズレ）の限界値を、対象ブロックの壁の端（間口/奥行の半分）までに制限する
                const maxOffset = isGableX ? (b.d / 2) : (b.w / 2);
                currentGUI.add(lr, 'ridgeOffset', -maxOffset, maxOffset, 50).name('棟の位置 (mm)').onChange(onChange).onFinishChange(onFinishChange);
            } else {
                // 従来の寄棟・平入りタイプの表示
                currentGUI.add(lr, 'eaves', 0, 1000, 100).name('軒の出 (mm)').onChange(onChange).onFinishChange(onFinishChange);
                currentGUI.add(lr, 'keraba', 0, 600, 100).name('ケラバ (mm)').onChange(onChange).onFinishChange(onFinishChange);
            }

            // 屋根勾配とリセットボタンは全タイプ共通
            currentGUI.add(lr, 'slope', 3, 4.5, 0.5).name('屋根勾配 (寸)').onChange(onChange).onFinishChange(onFinishChange);
            currentGUI.add(resetObj, 'reset').name('↺ デフォルトに戻す');
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
            if (!faceDir || !b.balconies || !b.balconies[faceDir]) return;
            const dName = { 'pz': '手前', 'nz': '奥', 'px': '右', 'nx': '左' }[faceDir] || faceDir;
            const typeName = b.balconies[faceDir] === 'glass' ? 'ガラス' : '縦格子';

            currentGUI = new GUI({ title: `バルコニー設定 [${typeName}] (${dName})` });
            currentGUI.domElement.style.position = 'absolute';
            currentGUI.domElement.style.top = '10px'; currentGUI.domElement.style.right = '10px';

            const p = b.balcParams[faceDir];
            const maxSideH = Math.max(1100, b.h - 200);
            let previousHandrailH = p.h_handrail;

            currentGUI.add(p, 'depth', 900, 1500, 100).name('奥行 (mm)').onChange(onChange).onFinishChange(onFinishChange);
            const handrailCtrl = currentGUI.add(p, 'h_handrail', 1100, 1300, 50).name('手すり高 (mm)');
            const sideCtrl = currentGUI.add(p, 'h_side', 1100, maxSideH, 10).name('側面壁高 (mm)');

            handrailCtrl.onChange((newVal) => {
                if (p.h_side === previousHandrailH) { p.h_side = newVal; sideCtrl.updateDisplay(); }
                previousHandrailH = newVal; rebuildMeshes();
            }).onFinishChange(onFinishChange);
            sideCtrl.onChange(onChange).onFinishChange(onFinishChange);

            const resetObj = { reset: () => { b.balcParams[faceDir] = { depth: 1000, h_handrail: 1100, h_side: 1100 }; onFinishChange(); rebuildMeshes(); this.updateGUI(b, 'balcony', faceDir); }};
            currentGUI.add(resetObj, 'reset').name('↺ デフォルトに戻す');
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
        else if (targetType === 'window') {
            if (!faceDir || !b.windows || !b.windows[faceDir]) return;
            const dName = { 'pz': '手前', 'nz': '奥', 'px': '右', 'nx': '左' }[faceDir] || faceDir;

            currentGUI = new GUI({ title: `窓 設定 (${dName})` });
            currentGUI.domElement.style.position = 'absolute';
            currentGUI.domElement.style.top = '10px'; currentGUI.domElement.style.right = '10px';

            const p = b.windowParams[faceDir];
            const L = (faceDir === 'pz' || faceDir === 'nz') ? b.w : b.d;
            const limitX = Math.max(0, (L - 1970) / 2);
            let limitY_min = p.height - 2000; 
            const limitY_max = Math.max(limitY_min, b.h - 2100); 

            if (p.offsetX > limitX) p.offsetX = limitX;
            if (p.offsetX < -limitX) p.offsetX = -limitX;
            if (p.offsetY > limitY_max) p.offsetY = limitY_max;
            if (p.offsetY < limitY_min) p.offsetY = limitY_min;

            const heightCtrl = currentGUI.add(p, 'height', 900, 2000, 100).name('窓の高さ (mm)');
            const xCtrl = currentGUI.add(p, 'offsetX', -limitX, limitX, 10).name('ヨコ位置 (mm)');
            const yCtrl = currentGUI.add(p, 'offsetY', limitY_min, limitY_max, 10).name('タテ位置 (mm)');

            heightCtrl.onChange((newHeight) => {
                limitY_min = newHeight - 2000;
                if (yCtrl.min) yCtrl.min(limitY_min); 
                if (p.offsetY < limitY_min) { p.offsetY = limitY_min; yCtrl.updateDisplay(); }
                onChange();
            }).onFinishChange(onFinishChange);

            xCtrl.onChange(onChange).onFinishChange(onFinishChange);
            yCtrl.onChange(onChange).onFinishChange(onFinishChange);

            const resetObj = { reset: () => { b.windowParams[faceDir] = { height: 2000, offsetX: 0, offsetY: 0 }; onFinishChange(); rebuildMeshes(); this.updateGUI(b, 'window', faceDir); }};
            currentGUI.add(resetObj, 'reset').name('↺ デフォルトに戻す');
        }
        else if (targetType === 'door') {
            if (!faceDir || !b.doors || !b.doors[faceDir]) return;
            const dName = { 'pz': '手前', 'nz': '奥', 'px': '右', 'nx': '左' }[faceDir] || faceDir;

            currentGUI = new GUI({ title: `玄関 設定 (${dName})` });
            currentGUI.domElement.style.position = 'absolute';
            currentGUI.domElement.style.top = '10px'; currentGUI.domElement.style.right = '10px';

            const p = b.doorParams[faceDir];
            const L = (faceDir === 'pz' || faceDir === 'nz') ? b.w : b.d;
            const limitX = Math.max(0, (L - 1500) / 2);

            if (p.offsetX > limitX) p.offsetX = limitX;
            if (p.offsetX < -limitX) p.offsetX = -limitX;

            currentGUI.add(p, 'offsetX', -limitX, limitX, 10).name('ヨコ位置 (mm)').onChange(onChange).onFinishChange(onFinishChange);

            const resetObj = { reset: () => { b.doorParams[faceDir] = { offsetX: 0 }; onFinishChange(); rebuildMeshes(); this.updateGUI(b, 'door', faceDir); }};
            currentGUI.add(resetObj, 'reset').name('↺ デフォルトに戻す');
        }
        // uiController.js の updateGUI 内、一番下の else if (targetType === 'door') の後に追加
        else if (targetType === 'sodeWall') {
            if (!faceDir || !b.sodeWalls || !b.sodeWalls[faceDir]) return;
            const dName = { 'pz': '手前', 'nz': '奥', 'px': '右', 'nx': '左' }[faceDir] || faceDir;

            currentGUI = new GUI({ title: `そで壁の設定 (${dName}面)` });
            currentGUI.domElement.style.position = 'absolute';
            currentGUI.domElement.style.top = '10px'; 
            currentGUI.domElement.style.right = '10px';

            const currentMode = b.sodeWalls[faceDir];
            const p = b.sodeParams[faceDir];
            const maxGap = Math.min(1500, Math.max(0, b.h - 100));
            // 表示切り替え用のオブジェクト
            const modeLabels = { 'both': '両方', 'right': '右のみ', 'left': '左のみ' };
            const nextMode = { 'both': 'right', 'right': 'left', 'left': 'both' }; // 両方→右→左の順

            const modeObj = {
                cycleMode: () => {
                    b.sodeWalls[faceDir] = nextMode[b.sodeWalls[faceDir]];
                    onFinishChange(); // 履歴に保存
                    rebuildMeshes();  // 3Dモデルを更新
                    this.updateGUI(b, 'sodeWall', faceDir); // GUIを再描画してフォルダを出し分ける
                }
            };
            
            // ボタンとしてGUIに追加し、現在の状態を名前に表示する
            currentGUI.add(modeObj, 'cycleMode').name(`🔄 表示切替 (現在: ${modeLabels[currentMode]})`);

            // 左側の設定（両方、または左のみのとき表示）
            if (currentMode === 'both' || currentMode === 'left') {
                if (p.left.topGap > maxGap) p.left.topGap = maxGap; // 安全クランプ
                
                const leftFolder = currentGUI.addFolder('左そで壁');
                leftFolder.add(p.left, 'depth', 100, 2000, 100).name('奥行 (mm)').onChange(onChange).onFinishChange(onFinishChange);
                leftFolder.add(p.left, 'topGap', 0, maxGap, 100).name('上面隙間 (mm)').onChange(onChange).onFinishChange(onFinishChange);
            }

            // 右側の設定（両方、または右のみのとき表示）
            if (currentMode === 'both' || currentMode === 'right') {
                if (p.right.topGap > maxGap) p.right.topGap = maxGap; // 安全クランプ
                
                const rightFolder = currentGUI.addFolder('右そで壁');
                rightFolder.add(p.right, 'depth', 100, 2000, 100).name('奥行 (mm)').onChange(onChange).onFinishChange(onFinishChange);
                rightFolder.add(p.right, 'topGap', 0, maxGap, 100).name('上面隙間 (mm)').onChange(onChange).onFinishChange(onFinishChange);
            }

            const resetObj = { 
                reset: () => { 
                    b.sodeParams[faceDir] = { 
                        left: { depth: 900, topGap: 0 }, 
                        right: { depth: 900, topGap: 0 } 
                    }; 
                    onFinishChange(); 
                    rebuildMeshes(); 
                    this.updateGUI(b, 'sodeWall', faceDir); 
                }
            };
            currentGUI.add(resetObj, 'reset').name('↺ デフォルトに戻す');
        }

        else if (targetType === 'tareWall') {
            if (!faceDir || !b.tareWalls || !b.tareWalls[faceDir]) return;
            const dName = { 'pz': '手前', 'nz': '奥', 'px': '右', 'nx': '左' }[faceDir] || faceDir;

            currentGUI = new GUI({ title: `垂れ壁の設定 (${dName}面)` });
            currentGUI.domElement.style.position = 'absolute';
            currentGUI.domElement.style.top = '10px'; 
            currentGUI.domElement.style.right = '10px';

            const p = b.tareParams[faceDir];

            // 下がり幅（高さ）のスライダー（100mm〜1500mm）
            currentGUI.add(p, 'height', 100, 1500, 100).name('下がり幅 (mm)').onChange(onChange).onFinishChange(onFinishChange);

            const resetObj = { 
                reset: () => { 
                    b.tareParams[faceDir] = { height: 900 }; 
                    onFinishChange(); 
                    rebuildMeshes(); 
                    this.updateGUI(b, 'tareWall', faceDir); 
                }
            };
            currentGUI.add(resetObj, 'reset').name('↺ デフォルトに戻す');
        }
        
        else if (targetType === 'size') {
            currentGUI = new GUI({ title: `基本寸法の手入力` });
            currentGUI.domElement.style.position = 'absolute';
            currentGUI.domElement.style.top = '10px'; 
            currentGUI.domElement.style.right = '10px';

            const minX = b.x - b.w / 2;
            const minZ = b.z - b.d / 2;

            const sizeParams = { width: b.w, depth: b.d, height: b.h, step: 100 };

            const onChangeSize = () => {
                // 連動計算のために、サイズ変更前の「元の高さ」を一時的に記憶しておく
                const oldH = b.h;

                // ★修正のキモ：高さ(b.h)を書き換える【前】に、上に積まれているブロックを探しておく
                const stackedBlocks = AppState.getStackedBlocks([b]);

                // 新しい寸法を適用
                b.w = sizeParams.width;
                b.d = sizeParams.depth;
                b.h = sizeParams.height;

                // 記憶した基準点（隅）を保ったまま、新しい「中心座標」を再計算して移動させる
                b.x = minX + b.w / 2;
                b.z = minZ + b.d / 2;

                // 真上に積まれている他のブロックのY座標（高さ位置）を連動させる
                const deltaH = b.h - oldH; 
                if (Math.abs(deltaH) > 0.1) {
                    stackedBlocks.forEach(ob => {
                        // 自分自身（ベースとなった下の階）は除外し、上に乗っている階のベースY座標を差分だけ持ち上げる
                        if (ob.id !== b.id) {
                            ob.y = (ob.y || 0) + deltaH;
                        }
                    });
                }

                AppState.updateAllLowerRoofs(); 
                rebuildMeshes();
            };

            // ★修正：最小値(min)をハードコードせず、stepに依存させる
            const wCtrl = currentGUI.add(sizeParams, 'width').min(sizeParams.step).max(20000).step(sizeParams.step).name('間口 W (mm)').onChange(onChangeSize).onFinishChange(onFinishChange);
            const dCtrl = currentGUI.add(sizeParams, 'depth').min(sizeParams.step).max(20000).step(sizeParams.step).name('奥行 D (mm)').onChange(onChangeSize).onFinishChange(onFinishChange);
            
            let hCtrl = null;
            if (b.h > 100) {
                hCtrl = currentGUI.add(sizeParams, 'height').min(sizeParams.step).max(20000).step(sizeParams.step).name('高さ H (mm)').onChange(onChangeSize).onFinishChange(onFinishChange);
            }

            // ★修正：スナップ幅を変更する際、スライダーの最小値も同時に書き換える
            currentGUI.add(sizeParams, 'step', { '100mm': 100, '50mm': 50, '10mm': 10 }).name('スナップ幅').onChange(val => {
                wCtrl.min(val).step(val);
                dCtrl.min(val).step(val);
                if (hCtrl) hCtrl.min(val).step(val);
                
                // 表示のズレを防ぐため、UIを強制アップデート
                wCtrl.updateDisplay();
                dCtrl.updateDisplay();
                if (hCtrl) hCtrl.updateDisplay();
            });
        }

    },

    showFloatingMenu(x, y, block, faceType, faceDir) {
        lastMenuX = x;
        lastMenuY = y;

        const menu = document.getElementById('floating-menu');
        menu.innerHTML = ''; 
        menu.style.display = 'flex';
        menu.style.left = (x + 80) + 'px'; 
        menu.style.top = (y + 40) + 'px';

        const btnExtrude = document.createElement('div');
        btnExtrude.className = 'float-btn black';
        btnExtrude.innerText = '⇧ プッシュプル';
        btnExtrude.onclick = () => { setTool('EXTRUDE'); this.hideFloatingMenu(); };
        menu.appendChild(btnExtrude);

        if (block.h <= 100) return;

        if (faceType === 'top') {
            if (AppState.isTopClear(block)) {
                const btnRoof = document.createElement('div');
                btnRoof.className = 'float-btn';
                if (!block.roof) {
                    btnRoof.innerText = '大屋根を追加'; 
                } else {
                    btnRoof.classList.add('warning'); 
                    if (block.roof.type === '切妻' && !block.roof.params['切妻'].rotate90) btnRoof.innerText = '屋根変更 (→ 切妻90度)';
                    else if (block.roof.type === '切妻' && block.roof.params['切妻'].rotate90) btnRoof.innerText = '屋根変更 (→ 寄棟)';
                    else if (block.roof.type === '寄棟') btnRoof.innerText = '屋根変更 (→ パラペット修景)';
                    else if (block.roof.type === 'パラペット修景') btnRoof.innerText = '屋根変更 (→ 陸屋根)';
                    else { btnRoof.innerText = '大屋根を削除'; btnRoof.classList.remove('warning'); btnRoof.classList.add('danger'); }
                }
                btnRoof.onclick = () => { window.toggleRoof(); };
                menu.appendChild(btnRoof);
            } else {
                const btnLowerRoof = document.createElement('div');
                btnLowerRoof.className = 'float-btn';
                if (!block.lowerRoof) {
                    btnLowerRoof.innerText = '下屋を追加';
                } else {
                    btnLowerRoof.classList.add('warning');
                    const isCorner = (block.lowerRoof.out_nx > 0 || block.lowerRoof.out_px > 0) && (block.lowerRoof.out_nz > 0 || block.lowerRoof.out_pz > 0);
                    const t = block.lowerRoof.type || '平入り/寄棟';
                    
                    if (t === '平入り/寄棟') {
                        btnLowerRoof.innerText = isCorner ? '下屋変更 (→ 切妻1)' : '下屋変更 (→ 妻入り)';
                    } else if (t === '妻入り/切妻1') {
                        btnLowerRoof.innerText = isCorner ? '下屋変更 (→ 切妻2)' : '下屋を削除';
                        if (!isCorner) {
                            btnLowerRoof.classList.remove('warning');
                            btnLowerRoof.classList.add('danger');
                        }
                    } else if (t === '切妻2') {
                        btnLowerRoof.innerText = '下屋を削除';
                        btnLowerRoof.classList.remove('warning');
                        btnLowerRoof.classList.add('danger');
                    }
                }
                btnLowerRoof.onclick = () => { window.toggleLowerRoof(); };
                menu.appendChild(btnLowerRoof);
            }
        } 
        else if (faceType === 'side') {
            const isVisor = block.visors && block.visors.includes(faceDir);
            const isFlat = block.flatVisors && block.flatVisors.includes(faceDir);
            const btnVisor = document.createElement('div');
            btnVisor.className = 'float-btn';
            if (!isVisor && !isFlat) { btnVisor.innerText = '軒庇・水平庇を追加'; }
            else if (isVisor) { btnVisor.innerText = '庇を変更 (→ 水平庇)'; btnVisor.classList.add('warning'); }
            else { btnVisor.innerText = '庇を削除'; btnVisor.classList.add('danger'); }
            btnVisor.onclick = () => { window.cycleVisor(faceDir); };
            menu.appendChild(btnVisor);

            const balcType = block.balconies && block.balconies[faceDir];
            const btnBalcony = document.createElement('div');
            btnBalcony.className = 'float-btn';
            if (!balcType) { btnBalcony.innerText = 'バルコニーを追加'; }
            else if (balcType === 'glass') { btnBalcony.innerText = 'バルコニー変更 (→ 縦格子)'; btnBalcony.classList.add('warning'); }
            else { btnBalcony.innerText = 'バルコニーを削除'; btnBalcony.classList.add('danger'); }
            btnBalcony.onclick = () => { window.toggleBalcony(faceDir); };
            menu.appendChild(btnBalcony);

            const hasPillar = block.pilasters && block.pilasters[faceDir];
            const btnPillar = document.createElement('div');
            btnPillar.className = 'float-btn';
            btnPillar.innerText = hasPillar ? '付け柱・付け梁を削除' : '付け柱・付け梁を追加';
            if (hasPillar) btnPillar.classList.add('danger');
            btnPillar.onclick = () => { window.togglePilaster(faceDir); };
            menu.appendChild(btnPillar);

            const hasWindow = block.windows && block.windows[faceDir];
            const btnWindow = document.createElement('div');
            btnWindow.className = 'float-btn';
            btnWindow.innerText = hasWindow ? '窓を削除' : '窓を追加';
            if (hasWindow) btnWindow.classList.add('danger');
            btnWindow.onclick = () => { window.toggleWindow(faceDir); };
            menu.appendChild(btnWindow);

            if (!block.y || Math.abs(block.y) < 1) { 
                const hasDoor = block.doors && block.doors[faceDir];
                const btnDoor = document.createElement('div');
                btnDoor.className = 'float-btn';
                btnDoor.innerText = hasDoor ? '玄関を削除' : '玄関を追加';
                if (hasDoor) btnDoor.classList.add('danger');
                btnDoor.onclick = () => { window.toggleDoor(faceDir); };
                menu.appendChild(btnDoor);
            }
            const hasSode = block.sodeWalls && block.sodeWalls[faceDir];
            const btnSode = document.createElement('div');
            btnSode.className = 'float-btn';
            btnSode.innerText = hasSode ? 'そで壁を削除' : 'そで壁を追加';
            if (hasSode) btnSode.classList.add('danger');
            
            // 呼び出す関数名をわかりやすく toggleSodeWall に変更します
            btnSode.onclick = () => { window.toggleSodeWall(faceDir); };
            menu.appendChild(btnSode);
            // ★追加：垂れ壁の追加/削除ボタン
            const tareType = block.tareWalls && block.tareWalls[faceDir];
            const btnTare = document.createElement('div');
            btnTare.className = 'float-btn';
            btnTare.innerText = tareType ? '垂れ壁を削除' : '垂れ壁を追加';
            if (tareType) btnTare.classList.add('danger');
            btnTare.onclick = () => { window.toggleTareWall(faceDir); };
            menu.appendChild(btnTare);
        }
    },

    hideFloatingMenu() {
        const menu = document.getElementById('floating-menu');
        if(menu) menu.style.display = 'none';
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
            if (b.h === 100) msgs.push("▶ 面をクリックしてプッシュプルが可能です");
            else if (AppState.isTopClear(b)) msgs.push("▶ 大屋根の追加・切り替え または 軒庇の追加が可能です");
            else msgs.push("▶ 下屋 または 軒庇の追加が可能です");
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

        window.toggleRoof = () => executeAction((b) => {
            if (!AppState.isTopClear(b)) return alert('上に別のブロックが乗っているため、大屋根は配置できません。');
            if (!b.roof) b.roof = { type: '切妻', params: JSON.parse(JSON.stringify(defaultRoofParams)) };
            else if (b.roof.type === '切妻' && !b.roof.params['切妻'].rotate90) b.roof.params['切妻'].rotate90 = true;
            else if (b.roof.type === '切妻' && b.roof.params['切妻'].rotate90) b.roof.type = '寄棟';
            else if (b.roof.type === '寄棟') b.roof.type = 'パラペット修景'; 
            else if (b.roof.type === 'パラペット修景') b.roof.type = '陸屋根'; 
            else { delete b.roof; this.clearGUI(); }
            this.showFloatingMenu(lastMenuX, lastMenuY, b, 'top', null);
            if (b.roof) this.updateGUI(b, 'roof');
        });

        window.toggleLowerRoof = () => executeAction((b) => {
            const isCorner = b.lowerRoof ? ((b.lowerRoof.out_nx > 0 || b.lowerRoof.out_px > 0) && (b.lowerRoof.out_nz > 0 || b.lowerRoof.out_pz > 0)) : false;
            
            if (!b.lowerRoof) { 
                b.lowerRoof = { type: '平入り/寄棟', eaves: 600, slope: 4, thick: 150, keraba: 300, out_nx: 0, out_px: 0, out_nz: 0, out_pz: 0 }; 
            } else if (b.lowerRoof.type === '平入り/寄棟') {
                b.lowerRoof.type = '妻入り/切妻1';
                // ★追加：切妻専用のパラメータを現在の値から引き継いで初期化
                b.lowerRoof.eaves_l = b.lowerRoof.eaves; b.lowerRoof.eaves_r = b.lowerRoof.eaves;
                b.lowerRoof.keraba_l = b.lowerRoof.keraba; b.lowerRoof.keraba_r = b.lowerRoof.keraba;
                b.lowerRoof.ridgeOffset = 0;
            } else if (b.lowerRoof.type === '妻入り/切妻1') {
                // 角がある（隣り合う）場合は3つ目のパターンへ、そうでない場合は削除へ
                if (isCorner) {
                    b.lowerRoof.type = '切妻2';
                } else {
                    delete b.lowerRoof; this.clearGUI(); 
                }
            } else {
                delete b.lowerRoof; this.clearGUI(); 
            }
            this.showFloatingMenu(lastMenuX, lastMenuY, b, 'top', null);
            if (b.lowerRoof) this.updateGUI(b, 'lowerRoof'); 
        });

        window.toggleBalcony = (dir) => executeAction((b) => {
            if (!b.balconies) { b.balconies = {}; b.balcParams = {}; }
            const current = b.balconies[dir];
            if (!current) { b.balconies[dir] = 'glass'; b.balcParams[dir] = { depth: 1000, h_handrail: 1100, h_side: 1100 }; } 
            else if (current === 'glass') { b.balconies[dir] = 'lattice'; } 
            else { delete b.balconies[dir]; delete b.balcParams[dir]; }
            if (Object.keys(b.balconies).length === 0) { delete b.balconies; delete b.balcParams; }
            this.showFloatingMenu(lastMenuX, lastMenuY, b, 'side', dir);
            if (b.balconies && b.balconies[dir]) this.updateGUI(b, 'balcony', dir); else this.clearGUI();
        });

        window.togglePilaster = (dir) => executeAction((b) => {
            if (!b.pilasters) { b.pilasters = {}; b.pilasterParams = {}; }
            if (!b.pilasters[dir]) { b.pilasters[dir] = true; b.pilasterParams[dir] = { pitch: 1000, beamY: b.h - 100, visiblePillars: [] }; } 
            else { delete b.pilasters[dir]; delete b.pilasterParams[dir]; }
            if (Object.keys(b.pilasters).length === 0) { delete b.pilasters; delete b.pilasterParams; }
            this.showFloatingMenu(lastMenuX, lastMenuY, b, 'side', dir);
            if (b.pilasters && b.pilasters[dir]) this.updateGUI(b, 'pilaster', dir); else this.clearGUI();
        });

        window.toggleWindow = (dir) => executeAction((b) => {
            if (!b.windows) { b.windows = {}; b.windowParams = {}; }
            if (!b.windows[dir]) { b.windows[dir] = true; b.windowParams[dir] = { height: 2000, offsetX: 0, offsetY: 0 }; } 
            else { delete b.windows[dir]; delete b.windowParams[dir]; }
            if (Object.keys(b.windows).length === 0) { delete b.windows; delete b.windowParams; }
            this.showFloatingMenu(lastMenuX, lastMenuY, b, 'side', dir);
            if (b.windows && b.windows[dir]) this.updateGUI(b, 'window', dir); else this.clearGUI();
        });

        window.toggleDoor = (dir) => executeAction((b) => {
            if (!b.doors) { b.doors = {}; b.doorParams = {}; }
            if (!b.doors[dir]) { b.doors[dir] = true; b.doorParams[dir] = { offsetX: 0 }; } 
            else { delete b.doors[dir]; delete b.doorParams[dir]; }
            if (Object.keys(b.doors).length === 0) { delete b.doors; delete b.doorParams; }
            this.showFloatingMenu(lastMenuX, lastMenuY, b, 'side', dir);
            if (b.doors && b.doors[dir]) this.updateGUI(b, 'door', dir); else this.clearGUI();
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
            if ((b.visors && b.visors.includes(dir)) || (b.flatVisors && b.flatVisors.includes(dir))) this.updateGUI(b, 'side', dir); else this.clearGUI();
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
                b.sodeParams[dir] = { left: { depth: 900, topGap: 0 }, right: { depth: 900, topGap: 0 } };
            } else {
                delete b.sodeWalls[dir];
                delete b.sodeParams[dir];
            }
            
            if (Object.keys(b.sodeWalls).length === 0) delete b.sodeWalls;
            if (Object.keys(b.sodeParams).length === 0) delete b.sodeParams;

            rebuildMeshes();

            this.showFloatingMenu(lastMenuX, lastMenuY, b, 'side', dir);
            if (b.sodeWalls && b.sodeWalls[dir]) {
                this.updateGUI(b, 'sodeWall', dir); 
            } else {
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
                b.tareParams[dir] = { height: 900 };
            } else {
                delete b.tareWalls[dir];
                delete b.tareParams[dir];
            }
            
            if (Object.keys(b.tareWalls).length === 0) delete b.tareWalls;
            if (Object.keys(b.tareParams).length === 0) delete b.tareParams;

            rebuildMeshes();

            this.showFloatingMenu(lastMenuX, lastMenuY, b, 'side', dir);
            if (b.tareWalls && b.tareWalls[dir]) {
                this.updateGUI(b, 'tareWall', dir); 
            } else {
                this.updateGUI(b, 'side', dir);
            }
        });

    }
};