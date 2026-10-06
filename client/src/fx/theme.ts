// Seed-driven procedural theme. The decision server (the "LLM" side) owns the
// canonical generator (GET /v1/theme); this module mirrors it so the showcase
// can re-theme instantly while offline. EVERY visible color derives from one
// seed: player ship + player fire vs enemy ships + enemy fire, plus stars,
// background and nebulas.

export interface Theme {
    seed: number;
    name: string;
    bg: string;
    player: number;
    fighter: number;
    bomber: number;
    support: number;
    elite: number;
    bulletPlayer: number;
    bulletEnemy: number;
    stars: number[];
    nebulas: number[];
    exhaust: number;
}

const NAMES = [
    'VOID BLOOM', 'SOLAR DRIFT', 'NEBULA CHOIR', 'ION GARDEN',
    'STARFALL MARKET', 'CRIMSON EXPANSE', 'TEAL ABYSS', 'GILDED VOID',
    'OPAL STORM', 'MAGNETAR DAWN', 'PALE SUPERNOVA', 'DUST HALO'
];

function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a |= 0; a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function hsv(h: number, s: number, v: number): number {
    const hh = ((((h % 360) + 360) % 360) / 60);
    s = Math.max(0, Math.min(1, s));
    v = Math.max(0, Math.min(1, v));
    const c = v * s;
    const x = c * (1 - Math.abs((hh % 2) - 1));
    const m = v - c;
    let r = 0, g = 0, b = 0;
    if (hh < 1) { r = c; g = x; }
    else if (hh < 2) { r = x; g = c; }
    else if (hh < 3) { g = c; b = x; }
    else if (hh < 4) { g = x; b = c; }
    else if (hh < 5) { r = x; b = c; }
    else { r = c; b = x; }
    return (Math.round((r + m) * 255) << 16) | (Math.round((g + m) * 255) << 8) | Math.round((b + m) * 255);
}

function css(n: number): string {
    return `#${n.toString(16).padStart(6, '0')}`;
}

function pick<T>(arr: T[], rng: () => number): T {
    return arr[(rng() * arr.length) | 0];
}

export function themeFromSeed(seed: number, mood = 'nebula'): Theme {
    const rng = mulberry32(seed);
    const ml = mood.toLowerCase();
    let base: number;
    if (ml.includes('ember') || ml.includes('crimson') || ml.includes('solar')) base = pick([8, 18, 32, 350], rng);
    else if (ml.includes('frost') || ml.includes('abyss') || ml.includes('teal')) base = pick([170, 190, 205, 220], rng);
    else if (ml.includes('violet') || ml.includes('nebula')) base = pick([265, 285, 305, 320], rng);
    else base = (rng() * 360) | 0;
    return {
        seed,
        name: pick(NAMES, rng),
        bg: css(hsv(base, 0.7, 0.07)),
        player: hsv(base, 0.65, 1),
        fighter: hsv(base + 150, 0.9, 1),
        bomber: hsv(base + 205, 0.95, 1),
        support: hsv(base + 45, 0.8, 1),
        elite: hsv(45, 1, 1),
        bulletPlayer: hsv(base, 0.65, 1),
        bulletEnemy: hsv(base + 180, 1, 1),
        stars: [0, 40, 180, 300].map((o) => hsv(base + o, 0.55 + rng() * 0.4, 1)),
        nebulas: [0, 50, 200].map((o) => hsv(base + o, 0.9, 0.75)),
        exhaust: hsv(base, 0.8, 1)
    };
}

const THEME_URL = 'http://127.0.0.1:8088/v1/theme';

/**
 * True only when a local decision server could plausibly exist.
 * On GitHub Pages / any hosted build the hostname isn't localhost, so the
 * game skips server probes entirely and runs on the local heuristic twin —
 * zero failed-fetch spam, instant smart AI. Run the backend locally
 * (python main.py) AND open the game via localhost to use live inference.
 */
export function serverEnabled(): boolean {
    try {
        const h = window.location.hostname;
        return h === 'localhost' || h === '127.0.0.1' || h === '';
    } catch {
        return false;
    }
}

function num(v: unknown, fb: number): number {
    return typeof v === 'number' ? v : fb;
}

function numArr(v: unknown, fb: number[]): number[] {
    return Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'number') ? (v as number[]) : fb;
}

/** Ask the server for a look-from-a-number; fall back to the local mirror. */
export async function fetchTheme(seed?: number, mood = 'nebula'): Promise<Theme> {
    const fb = themeFromSeed(seed ?? ((Math.random() * 999999) | 0), mood);
    if (!serverEnabled()) return fb; // hosted demo: local look, no backend round-trip
    const q = new URLSearchParams({ mood });
    if (seed !== undefined) q.set('seed', String(seed));
    const ctl = new AbortController();
    const t = window.setTimeout(() => ctl.abort(), 1500);
    try {
        const res = await fetch(`${THEME_URL}?${q}`, { signal: ctl.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const d = await res.json() as { seed?: number; name?: string; palette?: Record<string, unknown> };
        const p = d.palette ?? {};
        // Back-compat: older server sent bullets_player: [a, b]; current sends bullet_player.
        const bpRaw = p.bullet_player;
        const bpArr = numArr(p.bullets_player, []);
        const bpLocal = Array.isArray(bpArr) && bpArr.length > 0 ? bpArr[0] : fb.bulletPlayer;
        return {
            seed: typeof d.seed === 'number' ? d.seed : fb.seed,
            name: typeof d.name === 'string' ? d.name : fb.name,
            bg: typeof p.bg === 'string' ? p.bg : fb.bg,
            player: num(p.player, fb.player),
            fighter: num(p.fighter, fb.fighter),
            bomber: num(p.bomber, fb.bomber),
            support: num(p.support, fb.support),
            elite: num(p.elite, fb.elite),
            bulletPlayer: num(bpRaw, bpLocal),
            bulletEnemy: num(p.bullet_enemy, fb.bulletEnemy),
            stars: numArr(p.stars, fb.stars),
            nebulas: numArr(p.nebulas, fb.nebulas),
            exhaust: num(p.exhaust, fb.exhaust)
        };
    } finally {
        window.clearTimeout(t);
    }
}
