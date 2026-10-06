// Safe-area insets for notches, punch-holes and foldable hinges.
// Reads the CSS env() values through a hidden probe element added by index.html.

export interface Insets { top: number; right: number; bottom: number; left: number }

let cached: Insets | null = null;

function px(v: string): number {
    const n = Number.parseFloat(v);
    return Number.isFinite(n) ? n : 0;
}

export function safeArea(): Insets {
    if (cached) return cached;
    const probe = document.getElementById('safe-area-probe');
    if (!probe) {
        cached = { top: 0, right: 0, bottom: 0, left: 0 };
        return cached;
    }
    const cs = getComputedStyle(probe);
    cached = {
        top: px(cs.paddingTop),
        right: px(cs.paddingRight),
        bottom: px(cs.paddingBottom),
        left: px(cs.paddingLeft)
    };
    return cached;
}

/** Invalidate after a resize/orientation change (foldables re-report insets). */
export function resetSafeArea(): void {
    cached = null;
}

/**
 * UI scale for foldables/tablets: keeps text and controls legible on small
 * phones without ballooning on large displays. Clamped so it never gets silly.
 */
export function uiScale(w: number, h: number): number {
    return Math.max(0.72, Math.min(1.18, Math.min(w, h) / 760));
}

/**
 * World scale for sprites: tablets get slightly bigger ships, phones keep
 * theirs compact. Clamped to avoid absurd sizes on desktop monitors.
 */
export function entityScale(w: number, h: number): number {
    return Math.max(0.85, Math.min(1.35, Math.min(w, h) / 780));
}