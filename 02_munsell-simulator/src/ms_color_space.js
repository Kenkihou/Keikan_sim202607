// ms_color_space.js

// npmモジュールの仕様の違いを安全に吸収するためのインポート
import * as munsellModule from 'munsell';
import munsellDefault from 'munsell';

import { principalBounds, neutralHexLut, huePrefixes, hueSteps } from './ms_color_data.js';

// 40色相マスタの構築
export const allHues = [];
huePrefixes.forEach(prefix => hueSteps.forEach(step => allHues.push(`${step}${prefix}`)));

export function getMaxChroma(hueIndex, v) {
    const vIdx = v - 1;
    let leftP = Math.floor((hueIndex - 1) / 4);
    if (hueIndex === 0) leftP = 9;
    let rightP = (leftP + 1) % 10;
    let distFromLeft = hueIndex - (leftP * 4 + 1);
    if (distFromLeft < 0) distFromLeft += 40;
    const ratio = distFromLeft / 4;
    const c1 = principalBounds[leftP][vIdx];
    const c2 = principalBounds[rightP][vIdx];
    let maxC = Math.round((c1 * (1 - ratio) + c2 * ratio) / 2) * 2;
    return Math.max(2, maxC);
}

export function getMunsellHexSafe(munsellStr) {
    const obj = munsellModule || munsellDefault;
    let res = null;

    if (obj && typeof obj.munsellToRgb255 === 'function') res = obj.munsellToRgb255(munsellStr);
    else if (obj && typeof obj.munsellToHex === 'function') res = obj.munsellToHex(munsellStr);
    else if (typeof munsellDefault === 'function') res = munsellDefault(munsellStr);

    if (Array.isArray(res) && res.length >= 3) {
        return "#" + res.slice(0, 3).map(x => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, '0')).join('');
    } else if (typeof res === 'string' && res.startsWith('#')) return res;
    return null;
}

// マンセル値のHEXキャッシュ構築
export const munsellTreeCache = {};
export let loadError = null;

try {
    allHues.forEach((hue, hueIndex) => {
        munsellTreeCache[hue] = {};
        for (let v = 1; v <= 9; v++) {
            const maxC = getMaxChroma(hueIndex, v);
            for (let c = 1; c <= maxC; c++) {
                const hexColor = getMunsellHexSafe(`${hue} ${v}/${c}`);
                if (hexColor) {
                    if (!munsellTreeCache[hue][v]) munsellTreeCache[hue][v] = {};
                    munsellTreeCache[hue][v][c] = hexColor;
                }
            }
        }
    });
} catch (err) {
    loadError = err.message;
    console.error(err);
}