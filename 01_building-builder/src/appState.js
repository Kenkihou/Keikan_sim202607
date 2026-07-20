// appState.js

export const AppState = {
    // --- コアデータ ---
    buildingData: [],
    selectedId: null,
    selectedFaceDir: null,

    // --- 履歴管理データ ---
    history: [],
    historyIndex: -1,
    MAX_HISTORY: 3,

    /**
     * 現在の状態を履歴に保存
     */
    saveState() {
        if (this.historyIndex < this.history.length - 1) {
            this.history = this.history.slice(0, this.historyIndex + 1);
        }
        this.history.push(JSON.stringify(this.buildingData));
        if (this.history.length > this.MAX_HISTORY + 1) {
            this.history.shift();
        } else {
            this.historyIndex++;
        }
    },

    /**
     * 元に戻す
     */
    undo() {
        if (this.historyIndex > 0) {
            this.historyIndex--;
            this.buildingData = JSON.parse(this.history[this.historyIndex]);
            this.selectedId = null;
            this.selectedFaceDir = null;
            return true; // 成功
        }
        return false;
    },

    /**
     * やり直す
     */
    redo() {
        if (this.historyIndex < this.history.length - 1) {
            this.historyIndex++;
            this.buildingData = JSON.parse(this.history[this.historyIndex]);
            this.selectedId = null;
            this.selectedFaceDir = null;
            return true; // 成功
        }
        return false;
    },

    /**
     * 全消去
     */
    clearAll() {
        this.buildingData = [];
        this.selectedId = null;
        this.selectedFaceDir = null;
        this.saveState();
    },

    /**
     * 上にブロックが乗っていないか判定
     */
    isTopClear(b) {
        for (let ob of this.buildingData) {
            if (ob.id === b.id) continue;
            const obBottom = ob.y || 0;
            const obTop = obBottom + ob.h;
            const bTop = (b.y || 0) + b.h;
            
            if (obBottom <= bTop + 1 && obTop >= bTop - 1) {
                const overlapX = Math.abs(ob.x - b.x) * 2 < (ob.w + b.w) - 1;
                const overlapZ = Math.abs(ob.z - b.z) * 2 < (ob.d + b.d) - 1;
                if (overlapX && overlapZ) return false;
            }
        }
        return true;
    },

    /**
     * 乗っているブロックを再帰的に取得
     */
    getStackedBlocks(baseBlocks) {
        let result = [...baseBlocks];
        let added = true;
        while(added) {
            added = false;
            this.buildingData.forEach(ob => {
                if (!result.find(r => r.id === ob.id)) {
                    for(let b of result) {
                        const bTop = (b.y || 0) + b.h;
                        const obBottom = ob.y || 0;
                        if (Math.abs(obBottom - bTop) < 1) { 
                            const overlapX = Math.abs(ob.x - b.x) * 2 < (ob.w + b.w) - 1;
                            const overlapZ = Math.abs(ob.z - b.z) * 2 < (ob.d + b.d) - 1;
                            if (overlapX && overlapZ) {
                                result.push(ob);
                                added = true;
                                break;
                            }
                        }
                    }
                }
            });
        }
        return result;
    },

    /**
     * 全ての下屋の干渉（軒の出）を更新
     */
    updateAllLowerRoofs() {
        this.buildingData.forEach(b => {
            if (b.lowerRoof) {
                let upperB = null;
                for (let ob of this.buildingData) {
                    if (ob.id === b.id) continue;
                    const obBottom = ob.y || 0;
                    const lowerTop = (b.y || 0) + b.h;
                    if (Math.abs(obBottom - lowerTop) < 1) {
                        const overlapX = Math.abs(ob.x - b.x) * 2 < (ob.w + b.w) - 1;
                        const overlapZ = Math.abs(ob.z - b.z) * 2 < (ob.d + b.d) - 1;
                        if (overlapX && overlapZ) { upperB = ob; break; }
                    }
                }
                if (upperB) {
                    const L1 = b.x - b.w/2; const R1 = b.x + b.w/2;
                    const B1 = b.z - b.d/2; const F1 = b.z + b.d/2;
                    const L2 = upperB.x - upperB.w/2; const R2 = upperB.x + upperB.w/2;
                    const B2 = upperB.z - upperB.d/2; const F2 = upperB.z + upperB.d/2;
                    b.lowerRoof.out_nx = Math.max(0, L2 - L1);
                    b.lowerRoof.out_px = Math.max(0, R1 - R2);
                    b.lowerRoof.out_nz = Math.max(0, B2 - B1);
                    b.lowerRoof.out_pz = Math.max(0, F1 - F2);
                }
            }
        });
    },
    
/**
     * ★追加：JSONから状態を読み込み（履歴のリセットとマイグレーションを実行）
     */
    loadState(importedData, version) {
        // 古いバージョンデータのデフォルト値補完
        this.buildingData = this.migrateData(importedData, version);
        this.selectedId = null;
        this.selectedFaceDir = null;

        // ロードした状態を起点として履歴を完全に初期化
        this.history = [JSON.stringify(this.buildingData)];
        this.historyIndex = 0;
    },

    /**
     * ★追加：バージョニング互換性のためのデータマイグレーション
     */
    migrateData(data, version) {
        if (!Array.isArray(data)) return [];

        return data.map(b => {
            // ★追加：古いデータに rootBuildingId がなければ、自身の id を割り当てる
            if (!b.rootBuildingId) {
                b.rootBuildingId = b.id;
            }
            // ★追加：建物ごと・階ごと・部位ごとの着色データの器がなければ、安全に初期化する
            if (!b.materialColors) b.materialColors = {};
            // ★追加：建物ごと・階ごと・部位ごとの質感（砂壁調・杉板調など）データの器がなければ、安全に初期化する
            if (!b.materialTextures) b.materialTextures = {};
            // 大屋根（roof）のパラメータ構造の互換性チェックとデフォルト補完
            if (b.roof && b.roof.type) {
                const type = b.roof.type;
                if (!b.roof.params) b.roof.params = {};

                const defaultRoofParams = {
                    '切妻': { eaves_l: 600, eaves_r: 600, keraba_l: 300, keraba_r: 300, slope: 4, rotate90: false, ridgeOffset: 0, flatEaves: false, cutout: { active: false, x: 0, z: 0, w: 1000, d: 1000 } },
                    '寄棟': { eaves: 600, keraba: 600, slope: 4, flatEaves: false, cutout: { active: false, x: 0, z: 0, w: 1000, d: 1000 } },
                    'パラペット修景': { pHeight: 300, slope: 3, out_px: 600, in_px: 400, ridge_dist: 200, flatEaves: false },
                    '陸屋根': { pHeight: 300 }
                };

                if (defaultRoofParams[type]) {
                    // 該当する屋根タイプのオブジェクト自体がない場合は丸ごと補完
                    if (!b.roof.params[type]) {
                        b.roof.params[type] = { ...defaultRoofParams[type] };
                    } else {
                        // オブジェクトは存在しても、特定のキー（例: 後から追加された ridgeOffset など）が欠損していれば補完
                        b.roof.params[type] = { ...defaultRoofParams[type], ...b.roof.params[type] };
                    }
                }
            }

            // その他の各種装飾パーツ用パラメータの器がなければ、空のオブジェクトで安全に初期化
            if (b.visors && !b.visorParams) b.visorParams = {};
            if (b.flatVisors && !b.flatVisorParams) b.flatVisorParams = {};
            if (b.balconies && !b.balcParams) b.balcParams = {};
            if (b.pilasters && !b.pilasterParams) b.pilasterParams = {};
            if (b.windows && !b.windowParams) b.windowParams = {};
            if (b.doors && !b.doorParams) b.doorParams = {};
            if (b.sodeWalls && !b.sodeParams) b.sodeParams = {};

            return b;
        });
    }
    
};