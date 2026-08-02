// earthPrefetch.js
// 地球モード（04_earth-simulator）で必ず使うデータを、先にブラウザのキャッシュへ入れておく。
//
// なぜできるか: 04 は同じサイトの /earth-api/ 配下に置く iframe なので、
//   HTTPキャッシュのキー（トップレベルのサイト＋フレームのオリジン）がこちらと一致する。
//   つまり【この画面で fetch しておけば、地球側はそれをキャッシュから読む】。
//
// 何を温めるか: 04 が「カメラの位置に関係なく起動時に必ず取るもの」だけ。
//   ・04 自身の index.html と js（＋ importmap に書かれた CDN のライブラリ）
//   ・PLATEAU の tileset.json（LOD1×11区・LOD2×9区。1本200KB前後）
//   ・地形の layer.json
//   ・規制レイヤーの JSON 10種（合計3MB弱）
//   建物の中身（b3dm。1枚5〜7MB）は【どれを読むかが実行時の走査で決まる】ので温めない。
//   当てずっぽうに取るとキャッシュを押し出して逆効果になる。
//
// URL の二重管理を避けるため、一覧は 04 の js/config.js から実行時に読む。
// config.js は import を1つも持たない純粋な設定なので、importmap 無しでそのまま読める。

// 起動時にアイドルで温めるか（ホバー起点だけにしたいときは false）
const WARM_ON_IDLE = true;
const IDLE_DELAY_MS = 4000;   // 読み込み直後の慌ただしい時間を避ける
const MAX_PARALLEL = 4;       // モデリング側の通信を邪魔しない程度に抑える

// 04 の js（config.js から辿れないので、ここだけは名前を並べる。
// 増えても「温め漏れ」になるだけで壊れはしない）
const EARTH_MODULES = [
  'js/config.js', 'js/core.js', 'js/section.js', 'js/tiles.js',
  'js/viewareas.js', 'js/ui.js', 'js/usermodel.js', 'js/main.js',
];

let started = false;

// 通信を絞りたい状況では何もしない（従量制・低速回線など）
function shouldSkip() {
    const c = navigator.connection;
    if (!c) return false;
    if (c.saveData) return true;
    return c.effectiveType === 'slow-2g' || c.effectiveType === '2g';
}

// ★ body を最後まで読まないとキャッシュに残らないことがあるので、必ず読み切って捨てる。
async function warmOne(url) {
    try {
        const res = await fetch(url, { credentials: 'omit' });
        if (!res.ok) return;
        await res.arrayBuffer();
    } catch {
        // 温めは「できたら得」なので、失敗は握りつぶす（本体の動作には影響しない）
    }
}

async function warmAll(urls) {
    const queue = [...urls];
    const workers = Array.from({ length: Math.min(MAX_PARALLEL, queue.length) }, async () => {
        while (queue.length) await warmOne(queue.shift());
    });
    await Promise.all(workers);
}

// index.html の importmap から CDN のライブラリURLを取り出す
// （04 側で three のバージョンを上げても、古いものを温めてしまわないようにするため）
async function libUrlsFromImportmap(html) {
    try {
        const m = html.match(/<script[^>]*type=["']importmap["'][^>]*>([\s\S]*?)<\/script>/i);
        if (!m) return [];
        const map = JSON.parse(m[1]).imports || {};
        // 末尾が "/" のものは接頭辞の定義なので実体ではない
        return Object.entries(map).filter(([k]) => !k.endsWith('/')).map(([, v]) => v);
    } catch {
        return [];
    }
}

export function warmEarthAssets() {
    if (started || shouldSkip()) return;
    started = true;

    (async () => {
        // iframe の src と同じ解決のしかた（サブパス配信でも正しく効く）
        const base = new URL('./earth-api/', document.baseURI);
        const abs = (p) => new URL(p, base).href;

        // 1. 04 自身のコード（これが揃わないと何も始まらないので最優先）。
        //    index.html は本文も使う（下の importmap 解析）ので、ここで一度だけ取る。
        let html = '';
        try {
            const res = await fetch(abs('index.html'), { credentials: 'omit' });
            if (res.ok) html = await res.text();
        } catch { /* 温めなくても動く */ }
        await warmAll(EARTH_MODULES.map(abs));

        // 2. importmap の CDN ライブラリ
        if (html) await warmAll(await libUrlsFromImportmap(html));

        // 3. 設定から辿れるデータ（tileset の root と地形、規制レイヤーのJSON）
        try {
            const cfg = await import(/* @vite-ignore */ abs('js/config.js'));
            const zoneUrls = (cfg.ZONE_LAYERS || []).map(z => z.url).filter(Boolean);
            await warmAll([
                cfg.TERRAIN_URL,
                ...(cfg.TILESET_URLS_LOD1 || []),
                ...(cfg.TILESET_URLS_LOD2 || []),
            ].filter(Boolean));
            await warmAll([cfg.VIEW_AREA_URL, cfg.VIEW_LIMIT_URL, ...zoneUrls]
                .filter(Boolean).map(abs));
        } catch (e) {
            console.warn('地球モードの設定を読めなかったので先読みを中断しました', e);
        }
    })();
}

// 「開くつもり」が見えた時点で温める。開かない人には1バイトも取らせない。
export function setupEarthPrefetchTriggers(triggerIds) {
    for (const id of triggerIds) {
        const el = document.getElementById(id);
        if (!el) continue;
        el.addEventListener('pointerenter', warmEarthAssets, { once: true });
        el.addEventListener('focus', warmEarthAssets, { once: true });
    }

    if (!WARM_ON_IDLE) return;
    const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, IDLE_DELAY_MS));
    setTimeout(() => idle(() => warmEarthAssets(), { timeout: 10000 }), IDLE_DELAY_MS);
}
