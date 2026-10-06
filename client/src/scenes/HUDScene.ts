import * as Phaser from 'phaser';
import type { GameScene } from './GameScene';

// ──────────────────────────────────────────────────────────────────────────────
//  HUD SCENE — showcase overlay: AI telemetry, decision feed, God-Mode lab,
//  menus (start / pause / game-over), and per-enemy probability overlays.
// ──────────────────────────────────────────────────────────────────────────────

const INTENT_LABELS: Record<string, string> = {
    adv: 'ADVANCE', strf: 'STRAFE', flk_l: 'FLANK L', flk_r: 'FLANK R',
    ret: 'RETREAT', p: 'PLAYER', proj: 'DODGE'
};

// What each mode does to the decision system (mirrors server DIFF_PRESETS).
const DIFF_DESC: Record<string, string> = {
    easy: 'dazed AI · slow · gentle fire · no elites',
    normal: 'as designed · balanced',
    hard: 'razor beliefs · decides @90ms · relentless · elites everywhere'
};

interface Overlay {
    c: Phaser.GameObjects.Container;
    label: Phaser.GameObjects.Text;
    sub: Phaser.GameObjects.Text;
    bars: Phaser.GameObjects.Graphics;
    bg: Phaser.GameObjects.Graphics;
    glow: Phaser.GameObjects.Graphics;
    tx: number; ty: number; last: number;
}

export class HUDScene extends Phaser.Scene {
    private gs!: GameScene;
    private latencyText!: Phaser.GameObjects.Text;
    private spark!: Phaser.GameObjects.Graphics;
    private sparkHist: number[] = [];
    private fpsText!: Phaser.GameObjects.Text;
    private aiDot!: Phaser.GameObjects.Arc;
    private aiText!: Phaser.GameObjects.Text;
    private scoreText!: Phaser.GameObjects.Text;
    private waveText!: Phaser.GameObjects.Text;
    private highText!: Phaser.GameObjects.Text;
    private comboText!: Phaser.GameObjects.Text;
    private themeText!: Phaser.GameObjects.Text;
    private healthBar!: Phaser.GameObjects.Graphics;
    private healthText!: Phaser.GameObjects.Text;
    private feedTexts: Phaser.GameObjects.Text[] = [];
    private overlays = new Map<string, Overlay>();
    private godPanel!: Phaser.GameObjects.Container;
    private godOpen = false;
    private godConfig = { spawnScale: 1, speedScale: 1, noise: 0 };
    private menuLayer!: Phaser.GameObjects.Container;
    private pauseLayer!: Phaser.GameObjects.Container;
    private overLayer!: Phaser.GameObjects.Container;
    private overStats!: Phaser.GameObjects.Text;
    private diffSets: ((sel: string) => void)[] = [];
    private diffDesc: Phaser.GameObjects.Text | null = null;
    private menuBlocker: Phaser.Geom.Rectangle | null = null;
    private menuStatus!: Phaser.GameObjects.Text;
    private muted = false;

    constructor() {
        super({ key: 'HUDScene' });
    }

    create() {
        this.gs = this.scene.get('GameScene') as GameScene;
        const W = this.scale.width;

        // ─── Top bar ───
        const topBg = this.add.graphics().setDepth(100);
        topBg.fillStyle(0x000000, 0.5);
        topBg.fillRect(0, 0, W, 46);
        this.latencyBox(topBg);

        this.latencyText = this.add.text(12, 8, '⚡ — ms', {
            fontSize: '13px', color: '#55cc88', fontFamily: '"Inter", monospace'
        }).setDepth(101);
        this.spark = this.add.graphics().setDepth(101);
        this.fpsText = this.add.text(12, 26, '60 fps · 0 entities', {
            fontSize: '10px', color: '#5a6c8d', fontFamily: '"Inter", monospace'
        }).setDepth(101);

        this.aiDot = this.add.circle(150, 14, 5, 0x888888).setDepth(101);
        this.aiText = this.add.text(160, 8, 'AI …', {
            fontSize: '11px', color: '#aabbdd', fontFamily: '"Inter", monospace'
        }).setDepth(101);

        this.scoreText = this.add.text(W / 2, 6, 'SCORE  0', {
            fontSize: '16px', color: '#e8e8ff', fontFamily: '"Inter", sans-serif', fontStyle: 'bold'
        }).setOrigin(0.5, 0).setDepth(101);
        this.highText = this.add.text(W / 2, 27, 'BEST 0', {
            fontSize: '10px', color: '#8a93b8', fontFamily: '"Inter", monospace'
        }).setOrigin(0.5, 0).setDepth(101);

        this.waveText = this.add.text(W - 132, 8, 'WAVE 1', {
            fontSize: '13px', color: '#7eb8ff', fontFamily: '"Inter", sans-serif', fontStyle: 'bold'
        }).setDepth(101);
        this.comboText = this.add.text(W - 132, 26, '', {
            fontSize: '11px', color: '#ffd166', fontFamily: '"Inter", monospace', fontStyle: 'bold'
        }).setDepth(101);
        this.themeText = this.add.text(W - 132, 40, '', {
            fontSize: '9px', color: '#8a93b8', fontFamily: '"Inter", monospace'
        }).setDepth(101);

        this.healthBar = this.add.graphics().setDepth(101);
        this.healthText = this.add.text(108, 27, '', {
            fontSize: '10px', color: '#8a93b8', fontFamily: '"Inter", monospace'
        }).setDepth(101);
        this.drawHealth(5, 5);

        // ─── Bottom help bar ───
        const help = this.add.text(W / 2, this.scale.height - 12,
            'HOLD CLICK / WASD fly · SPACE fire · E emp · T remix theme · P pause · M mute · ⚙ god-mode lab', {
                fontSize: '10px', color: '#4d5f7e', fontFamily: '"Inter", monospace',
                backgroundColor: '#00000055', padding: { left: 8, right: 8, top: 3, bottom: 3 }
            }).setOrigin(0.5, 1).setDepth(101).setAlpha(0.95);

        // ─── God-mode toggle ───
        const gear = this.add.text(W - 30, 54, '⚙', {
            fontSize: '22px', color: '#ffcc00', backgroundColor: '#22222288',
            padding: { left: 6, right: 6, top: 2, bottom: 2 }
        }).setDepth(102).setInteractive({ useHandCursor: true });
        gear.on('pointerdown', () => {
            this.godOpen = !this.godOpen;
            this.godPanel.setVisible(this.godOpen);
        });

        this.createGodPanel();
        this.createMenuLayers();
        void help;

        // ─── Event wiring ───
        const ev = this.gs.events;
        ev.on('decision_latency', (d: { ms: number; source: string }) => this.onLatency(d.ms, d.source));
        ev.on('score_change', (s: number) => this.scoreText.setText(`SCORE  ${s}`));
        ev.on('wave_change', (n: number) => this.onWave(n));
        ev.on('high_score', (n: number) => this.highText.setText(`BEST ${n}`));
        ev.on('combo_change', (n: number) => this.comboText.setText(n >= 2 ? `🔥 x${n} COMBO` : ''));
        ev.on('player_health', (hp: number, max: number) => this.drawHealth(hp, max));
        ev.on('decision_made', (d: { id: string; x: number; y: number; action: string; confidence: number; probabilities: Record<string, number>; type: string; elite: boolean }) => {
            this.upsertOverlay(d.id, d.x, d.y, d.action, d.confidence, d.probabilities, d.elite);
            this.pushFeed(`${d.id} → ${INTENT_LABELS[d.action] ?? d.action}  ${(d.confidence * 100).toFixed(0)}%`, d.confidence);
        });
        ev.on('enemy_died', (id: string) => this.dropOverlay(id, false));
        ev.on('ai_status', (ok: boolean) => this.setAi(ok));
        ev.on('theme_changed', (t: { seed: number; name: string }) => {
            this.themeText.setText(`🎨 ${t.seed} · ${t.name}`);
            this.pushFeed(`THEME: seed ${t.seed} "${t.name}" — ships / bullets / stars / sky re-rolled`, 0.6);
        });
        ev.on('game_phase', (p: string) => this.onPhase(p));
        ev.on('game_over', (s: { score: number; wave: number; kills: number; high: number; elapsed: number; difficulty: string }) => this.showGameOver(s));
        ev.on('sfx_toggle', (on: boolean) => { this.muted = !on; });
        ev.on('emp_fired', () => this.pushFeed('GOD: EMP noise injected — watch probabilities flicker', 0.2));
        ev.on('difficulty_changed', (d: string) => this.onDifficulty(d));
        this.onDifficulty(this.gs.difficulty, true);

        this.scale.on('resize', () => this.relayout());
        this.setAi(false);
    }

    private latencyBox(_bg: Phaser.GameObjects.Graphics) { void _bg; }

    // ─── Top-bar telemetry ───
    private onLatency(ms: number, source: string) {
        const label = source.includes('local') ? 'LOCAL' : source.includes('heuristic') ? 'HEUR' : 'AI';
        this.latencyText.setText(`⚡ ${ms.toFixed(1)} ms · ${label}`);
        this.latencyText.setColor(ms < 50 ? '#55cc88' : ms < 150 ? '#ffcc44' : '#ff5555');
        this.sparkHist.push(Math.min(ms, 400));
        if (this.sparkHist.length > 60) this.sparkHist.shift();
        this.spark.clear();
        this.spark.fillStyle(0x1a2436, 1);
        this.spark.fillRect(12, 40, 122, 4);
        this.sparkHist.forEach((v, i) => {
            const hgt = Math.max(1, (v / 400) * 14);
            this.spark.fillStyle(v < 50 ? 0x55cc88 : v < 150 ? 0xffcc44 : 0xff5555, 0.9);
            this.spark.fillRect(12 + i * 2, 40 + 14 - hgt, 1.6, hgt);
        });
    }

    private setAi(ok: boolean) {
        this.aiDot.setFillStyle(ok ? 0x51e08c : 0xffaa33);
        this.aiText.setText(ok ? 'AI ● SERVER' : 'AI ● LOCAL TWIN');
        this.aiText.setColor(ok ? '#51e08c' : '#ffaa33');
        if (this.menuStatus) {
            this.menuStatus.setText(ok ? '● decision server ONLINE — live model inference' : '● server offline — running on local heuristic twin');
            this.menuStatus.setColor(ok ? '#51e08c' : '#ffaa33');
        }
    }

    private onWave(n: number) {
        this.waveText.setText(`WAVE ${n}`);
        const banner = this.add.text(this.scale.width / 2, this.scale.height * 0.32, `— WAVE ${n} —`, {
            fontSize: '30px', color: '#7eb8ff', fontFamily: '"Inter", sans-serif', fontStyle: 'bold'
        }).setOrigin(0.5).setAlpha(0).setDepth(120);
        this.tweens.add({
            targets: banner, alpha: 1, y: banner.y - 14, duration: 400, yoyo: true, hold: 900,
            onComplete: () => banner.destroy()
        });
    }

    private drawHealth(hp: number, max: number) {
        this.healthBar.clear();
        const x = 108, y = 13, bw = 90, bh = 7;
        this.healthBar.fillStyle(0x222244, 1);
        this.healthBar.fillRoundedRect(x, y, bw, bh, 3);
        const pct = Math.max(0, Math.min(1, hp / Math.max(1, max)));
        this.healthBar.fillStyle(pct > 0.6 ? 0x55cc88 : pct > 0.3 ? 0xffcc44 : 0xff4444, 1);
        if (pct > 0) this.healthBar.fillRoundedRect(x, y, bw * pct, bh, 3);
        this.healthText.setText(`HULL ${Math.max(0, hp)}/${max}`);
    }

    // ─── Decision feed (bottom-left) ───
    private pushFeed(msg: string, conf: number) {
        const H = this.scale.height;
        if (this.feedTexts.length >= 6) {
            const old = this.feedTexts.shift();
            old?.destroy();
        }
        this.feedTexts.forEach((t, i) => t.setY(H - 66 - (this.feedTexts.length - i) * 17));
        const color = conf > 0.65 ? '#7df0b2' : conf > 0.35 ? '#ffd166' : '#ff8a7a';
        const txt = this.add.text(12, H - 66, `› ${msg}`, {
            fontSize: '10px', color, fontFamily: '"Inter", monospace',
            backgroundColor: '#00000066', padding: { left: 5, right: 5, top: 2, bottom: 2 }
        }).setDepth(101).setAlpha(0.95);
        this.feedTexts.push(txt);
    }

    addLog(msg: string) { this.pushFeed(msg, 0.5); }

    // ─── Per-enemy probability overlays ───
    private upsertOverlay(id: string, x: number, y: number, action: string, conf: number, probs: Record<string, number>, elite: boolean) {
        let o = this.overlays.get(id);
        if (!o) {
            const c = this.add.container(x, y - 52).setDepth(90);
            const glow = this.add.graphics();
            const bg = this.add.graphics();
            const label = this.add.text(0, -20, '', {
                fontSize: '10px', color: '#fff', fontFamily: '"Inter", monospace', fontStyle: 'bold'
            }).setOrigin(0.5);
            const sub = this.add.text(0, -9, '', {
                fontSize: '8px', color: '#8a93b8', fontFamily: '"Inter", monospace'
            }).setOrigin(0.5);
            const bars = this.add.graphics();
            c.add([glow, bg, label, sub, bars]);
            o = { c, label, sub, bars, bg, glow, tx: x, ty: y - 52, last: this.time.now };
            this.overlays.set(id, o);
        }
        o.tx = x; o.ty = y - 52; o.last = this.time.now;
        o.label.setText(`${elite ? '★ ' : ''}${INTENT_LABELS[action] ?? action.toUpperCase()}`);
        o.label.setColor(elite ? '#ffd166' : conf > 0.65 ? '#44ffaa' : conf > 0.35 ? '#ffdd44' : '#ff6666');
        o.sub.setText(`${(conf * 100).toFixed(0)}% conf`);
        o.bg.clear();
        o.bg.fillStyle(0x050510, 0.62);
        o.bg.fillRoundedRect(-36, -30, 72, 46, 5);
        o.bg.lineStyle(1, elite ? 0xffd166 : 0x334466, elite ? 0.9 : 0.5);
        o.bg.strokeRoundedRect(-36, -30, 72, 46, 5);
        o.bars.clear();
        const entries = Object.entries(probs).sort((a, b) => b[1] - a[1]).slice(0, 4);
        let cy = -6;
        for (const [, p] of entries) {
            o.bars.fillStyle(0x23233f, 1);
            o.bars.fillRect(-29, cy, 58, 3);
            o.bars.fillStyle(p > 0.5 ? 0x3b82f6 : p > 0.25 ? 0x6366f1 : 0x4b5563, 1);
            o.bars.fillRect(-29, cy, 58 * Math.max(0, Math.min(1, p)), 3);
            cy += 5;
        }
        o.glow.clear();
        o.glow.fillStyle(conf > 0.65 ? 0x2266ff : conf > 0.35 ? 0xffaa00 : 0xff3300, conf > 0.65 ? 0.10 : 0.16);
        o.glow.fillCircle(0, -8, 40);
    }

    private dropOverlay(id: string, _fade: boolean) {
        const o = this.overlays.get(id);
        if (!o) return;
        void _fade;
        o.c.destroy();
        this.overlays.delete(id);
    }

    // ─── Segmented EASY/NORMAL/HARD row ───
    private makeSegRow(x: number, y: number, opts: string[], current: string, cb: (id: string) => void) {
        const c = this.add.container(x, y);
        const bgs: Phaser.GameObjects.Graphics[] = [];
        const txts: Phaser.GameObjects.Text[] = [];
        const bw = 62, gap = 6;
        const paint = (sel: string) => {
            opts.forEach((o, i) => {
                const on = o === sel;
                const g = bgs[i];
                g.clear();
                g.fillStyle(on ? 0x2f4a7a : 0x1a1a3a, 1);
                g.lineStyle(1, on ? 0x7eb8ff : 0x334466, on ? 1 : 0.5);
                g.fillRoundedRect(0, 0, bw, 26, 5);
                g.strokeRoundedRect(0, 0, bw, 26, 5);
                txts[i].setColor(on ? '#ffffff' : '#8a93b8');
            });
        };
        opts.forEach((o, i) => {
            const g = this.add.graphics();
            const t = this.add.text(bw / 2, 13, o.toUpperCase(), {
                fontSize: '10px', color: '#8a93b8', fontFamily: '"Inter", monospace', fontStyle: 'bold'
            }).setOrigin(0.5);
            c.add(this.add.container(i * (bw + gap), 0, [g, t]));
            g.setInteractive(new Phaser.Geom.Rectangle(0, 0, bw, 26), Phaser.Geom.Rectangle.Contains);
            g.on('pointerdown', () => { paint(o); cb(o); });
            bgs.push(g);
            txts.push(t);
        });
        paint(current);
        return { container: c, set: paint };
    }

    private onDifficulty(d: string, silent = false) {
        this.diffSets.forEach((fn) => fn(d));
        if (this.diffDesc) this.diffDesc.setText(DIFF_DESC[d] ?? '');
        if (!silent) this.pushFeed(`MODE: ${d.toUpperCase()} — ${DIFF_DESC[d] ?? ''}`, 0.5);
    }

    // ─── God-mode lab ───
    private makeButton(parent: Phaser.GameObjects.Container, y: number, label: string, cb: () => void) {
        const c = this.add.container(12, y);
        const bg = this.add.graphics();
        const draw = (hover: boolean) => {
            bg.clear();
            bg.fillStyle(hover ? 0x2a2a5a : 0x1a1a3a, 1);
            bg.lineStyle(1, hover ? 0x5577aa : 0x334466, hover ? 0.9 : 0.5);
            bg.fillRoundedRect(0, 0, 196, 30, 5);
            bg.strokeRoundedRect(0, 0, 196, 30, 5);
        };
        draw(false);
        const t = this.add.text(98, 15, label, {
            fontSize: '11px', color: '#ccccee', fontFamily: '"Inter", sans-serif'
        }).setOrigin(0.5);
        c.add([bg, t]);
        bg.setInteractive(new Phaser.Geom.Rectangle(0, 0, 196, 30), Phaser.Geom.Rectangle.Contains);
        bg.on('pointerover', () => draw(true));
        bg.on('pointerout', () => draw(false));
        bg.on('pointerdown', cb);
        parent.add(c);
        return c;
    }

    private makeSlider(parent: Phaser.GameObjects.Container, y: number, name: string, min: number, max: number, val: number, fmt: (v: number) => string, onChange: (v: number) => void) {
        const c = this.add.container(12, y);
        const label = this.add.text(0, 0, '', {
            fontSize: '10px', color: '#8a93b8', fontFamily: '"Inter", monospace'
        });
        const bar = this.add.graphics();
        const knob = this.add.circle(0, 0, 7, 0x7eb8ff);
        const redraw = (v: number) => {
            label.setText(`${name}  ${fmt(v)}`);
            bar.clear();
            bar.fillStyle(0x1a1a3a, 1);
            bar.fillRoundedRect(0, 18, 196, 8, 4);
            const r = (v - min) / (max - min);
            bar.fillStyle(0x3b82f6, 1);
            bar.fillRoundedRect(0, 18, 196 * r, 8, 4);
            knob.setPosition(196 * r, 22);
        };
        redraw(val);
        const zone = this.add.zone(0, 18, 196, 20).setOrigin(0).setInteractive({ useHandCursor: true, draggable: true });
        const setFrom = (px: number) => {
            const local = Phaser.Math.Clamp((px - zone.getWorldTransformMatrix().tx) / zone.displayWidth, 0, 1);
            const v = min + local * (max - min);
            redraw(v);
            onChange(v);
        };
        zone.on('pointerdown', (p: Phaser.Input.Pointer) => setFrom(p.x));
        zone.on('pointermove', (p: Phaser.Input.Pointer) => { if (p.isDown) setFrom(p.x); });
        c.add([label, bar, knob, zone]);
        parent.add(c);
    }

    private createGodPanel() {
        const W = this.scale.width;
        this.godPanel = this.add.container(W - 232, 88).setVisible(false).setDepth(110);
        const bg = this.add.graphics();
        bg.fillStyle(0x0d0d1a, 0.94);
        bg.lineStyle(1, 0x334466, 0.7);
        bg.fillRoundedRect(0, 0, 220, 410, 10);
        bg.strokeRoundedRect(0, 0, 220, 410, 10);
        this.godPanel.add(bg);
        this.godPanel.add(this.add.text(16, 12, 'AI STRESS LAB', {
            fontSize: '12px', color: '#ffcc44', fontFamily: '"Inter", sans-serif', fontStyle: 'bold'
        }));
        this.godPanel.add(this.add.text(16, 30, 'inject chaos · watch beliefs flicker', {
            fontSize: '9px', color: '#5a6c8d', fontFamily: '"Inter", monospace'
        }));

        let by = 52;
        this.makeButton(this.godPanel, by, '💔  Player hull → 10%', () => {
            this.gs.events.emit('god_mode:health', 0.1);
            this.pushFeed('GOD: hull critical — retreat beliefs should spike', 0.3);
        }); by += 38;
        this.makeButton(this.godPanel, by, '🚀  Missile barrage ×10', () => {
            this.gs.events.emit('god_mode:missiles', 10);
            this.pushFeed('GOD: threat barrage — dodge beliefs should spike', 0.3);
        }); by += 38;
        this.makeButton(this.godPanel, by, '⚡  EMP noise pulse  [E]', () => {
            this.gs.events.emit('god_mode:emp');
        }); by += 38;
        this.makeButton(this.godPanel, by, '🌊  Surge: spawn 6 now', () => {
            for (let i = 0; i < 6; i++) this.gs.spawnEnemy();
            this.pushFeed('GOD: surge spawned — batch inference under load', 0.4);
        }); by += 38;
        this.makeButton(this.godPanel, by, '🎨  Remix theme seed  [T]', () => {
            this.gs.events.emit('hud:remix');
            this.pushFeed('GOD: new seed requested — re-theming everything', 0.4);
        }); by += 44;

        this.makeSlider(this.godPanel, by, 'SPAWN', 0.3, 3, 1, (v) => `×${v.toFixed(1)}`, (v) => {
            this.godConfig.spawnScale = v;
            this.gs.events.emit('god_mode:config', this.godConfig);
        }); by += 52;
        this.makeSlider(this.godPanel, by, 'SPEED', 0.5, 2, 1, (v) => `×${v.toFixed(1)}`, (v) => {
            this.godConfig.speedScale = v;
            this.gs.events.emit('god_mode:config', this.godConfig);
        }); by += 52;
        this.makeSlider(this.godPanel, by, 'NOISE', 0, 1.5, 0, (v) => v.toFixed(2), (v) => {
            this.godConfig.noise = v;
            this.gs.events.emit('god_mode:config', this.godConfig);
            if (v > 0.9) this.pushFeed('GOD: heavy noise — low-confidence flicker expected', 0.2);
        }); by += 52;
        this.godPanel.add(this.add.text(14, by + 2, 'DIFFICULTY — retunes the AI brain', {
            fontSize: '10px', color: '#8a93b8', fontFamily: '"Inter", monospace'
        }));
        const labRow = this.makeSegRow(12, by + 18, ['easy', 'normal', 'hard'], this.gs.difficulty, (id) => {
            this.gs.events.emit('hud:difficulty', id);
        });
        this.godPanel.add(labRow.container);
        this.diffSets.push(labRow.set);
    }

    // ─── Menu / pause / game-over layers ───
    private dim(W: number, H: number, alpha: number) {
        return this.add.rectangle(W / 2, H / 2, W, H, 0x03030c, alpha);
    }

    private createMenuLayers() {
        const W = this.scale.width, H = this.scale.height;

        // START
        this.menuLayer = this.add.container(0, 0).setDepth(130);
        this.menuLayer.add(this.dim(W, H, 0.78));
        this.menuLayer.add(this.add.text(W / 2, H * 0.24, 'KESSLER PROTOCOL', {
            fontSize: '44px', color: '#7eb8ff', fontFamily: '"Inter", sans-serif', fontStyle: 'bold'
        }).setOrigin(0.5));
        this.menuLayer.add(this.add.text(W / 2, H * 0.24 + 40, 'ONE LOCAL MODEL FLIES EVERY ENEMY — LIVE PROBABILITIES OVERHEAD', {
            fontSize: '12px', color: '#8a93b8', fontFamily: '"Inter", monospace'
        }).setOrigin(0.5));
        const feats = [
            '◆  System One intent every ~150 ms  →  60 FPS steering underneath',
            '◆  Batched compact JSON (p / e / q) keeps prefill tiny',
            '◆  EMP + sliders inject noise — beliefs flicker in real time',
            '◆  Server offline? Local heuristic twin keeps flying smart',
            '◆  Seed-driven theme — ships, bullets, stars, sky (T to remix)'
        ];
        feats.forEach((f, i) => {
            this.menuLayer.add(this.add.text(W / 2, H * 0.24 + 78 + i * 22, f, {
                fontSize: '12px', color: '#aabbdd', fontFamily: '"Inter", monospace'
            }).setOrigin(0.5));
        });
        this.menuStatus = this.add.text(W / 2, H * 0.24 + 78 + 5 * 22 + 8, '● probing decision server…', {
            fontSize: '12px', color: '#8a93b8', fontFamily: '"Inter", monospace'
        }).setOrigin(0.5);
        this.menuLayer.add(this.menuStatus);
        const baseY = H * 0.24 + 78 + 5 * 22;
        this.menuLayer.add(this.add.text(W / 2, baseY + 34, '— DIFFICULTY · RETUNES THE AI BRAIN —', {
            fontSize: '10px', color: '#5a6c8d', fontFamily: '"Inter", monospace'
        }).setOrigin(0.5));
        const menuRow = this.makeSegRow(W / 2 - 99, baseY + 48, ['easy', 'normal', 'hard'], this.gs.difficulty, (id) => {
            this.gs.events.emit('hud:difficulty', id);
        });
        this.menuLayer.add(menuRow.container);
        this.diffSets.push(menuRow.set);
        this.menuBlocker = new Phaser.Geom.Rectangle(W / 2 - 99, baseY + 48, 198, 26);
        this.diffDesc = this.add.text(W / 2, baseY + 84, '', {
            fontSize: '11px', color: '#8a93b8', fontFamily: '"Inter", monospace'
        }).setOrigin(0.5);
        this.menuLayer.add(this.diffDesc);
        const launch = this.add.text(W / 2, H * 0.24 + 78 + 5 * 22 + 126, '▶  CLICK OR PRESS ENTER TO LAUNCH', {
            fontSize: '17px', color: '#0a0a14', backgroundColor: '#7eb8ff',
            fontFamily: '"Inter", sans-serif', fontStyle: 'bold',
            padding: { left: 18, right: 18, top: 10, bottom: 10 }
        }).setOrigin(0.5).setInteractive({ useHandCursor: true });
        launch.on('pointerdown', () => this.gs.events.emit('hud:start'));
        launch.on('pointerover', () => launch.setBackgroundColor('#a8ccff'));
        launch.on('pointerout', () => launch.setBackgroundColor('#7eb8ff'));
        this.menuLayer.add(launch);
        this.tweens.add({ targets: launch, alpha: 0.75, duration: 700, yoyo: true, repeat: -1 });
        this.input.on('pointerdown', (p: Phaser.Input.Pointer) => {
            if (!this.menuLayer.visible || p.y <= H * 0.5) return;
            if (this.menuBlocker && this.menuBlocker.contains(p.x, p.y)) return; // difficulty buttons
            this.gs.events.emit('hud:start');
        });

        // PAUSE
        this.pauseLayer = this.add.container(0, 0).setDepth(131).setVisible(false);
        this.pauseLayer.add(this.dim(W, H, 0.6));
        this.pauseLayer.add(this.add.text(W / 2, H / 2 - 20, '❚❚  PAUSED', {
            fontSize: '34px', color: '#e8e8ff', fontFamily: '"Inter", sans-serif', fontStyle: 'bold'
        }).setOrigin(0.5));
        this.pauseLayer.add(this.add.text(W / 2, H / 2 + 24, 'P / ESC to resume', {
            fontSize: '13px', color: '#8a93b8', fontFamily: '"Inter", monospace'
        }).setOrigin(0.5));

        // GAME OVER
        this.overLayer = this.add.container(0, 0).setDepth(132).setVisible(false);
        this.overLayer.add(this.dim(W, H, 0.72));
        this.overLayer.add(this.add.text(W / 2, H * 0.3, 'SHIP LOST', {
            fontSize: '42px', color: '#ff6666', fontFamily: '"Inter", sans-serif', fontStyle: 'bold'
        }).setOrigin(0.5));
        this.overStats = this.add.text(W / 2, H * 0.3 + 52, '', {
            fontSize: '14px', color: '#aabbdd', fontFamily: '"Inter", monospace', align: 'center', lineSpacing: 8
        }).setOrigin(0.5, 0);
        this.overLayer.add(this.overStats);
        const again = this.add.text(W / 2, H * 0.3 + 190, '↻  FLY AGAIN  [R]', {
            fontSize: '16px', color: '#0a0a14', backgroundColor: '#51e08c',
            fontFamily: '"Inter", sans-serif', fontStyle: 'bold',
            padding: { left: 18, right: 18, top: 10, bottom: 10 }
        }).setOrigin(0.5).setInteractive({ useHandCursor: true });
        again.on('pointerdown', () => this.gs.events.emit('hud:restart'));
        this.overLayer.add(again);
    }

    private onPhase(p: string) {
        this.menuLayer.setVisible(p === 'menu');
        this.pauseLayer.setVisible(p === 'paused');
        if (p === 'playing') this.overLayer.setVisible(false);
        if (p === 'menu') this.overLayer.setVisible(false);
    }

    private showGameOver(s: { score: number; wave: number; kills: number; high: number; elapsed: number; difficulty: string }) {
        const isBest = s.score >= s.high && s.score > 0;
        this.overStats.setText(
            `MODE  ${(s.difficulty ?? 'normal').toUpperCase()}   ·   SCORE  ${s.score}   ·   WAVE  ${s.wave}   ·   KILLS  ${s.kills}\n` +
            `SURVIVED  ${s.elapsed}s      BEST  ${s.high}${isBest ? '\n★ NEW RECORD ★' : ''}`
        );
        this.overLayer.setVisible(true);
    }

    private relayout() {
        // Simple robust approach for RESIZE: rebuild the whole HUD.
        this.overlays.forEach((o) => o.c.destroy());
        this.overlays.clear();
        this.feedTexts.forEach((t) => t.destroy());
        this.feedTexts = [];
        this.scene.restart();
    }

    update(_time: number, _delta: number) {
        void _time; void _delta;
        // FPS + entity counter
        const ents = this.gs ? this.gs.snapshotEnemies().length : 0;
        this.fpsText.setText(`${Math.round(this.game.loop.actualFps)} fps · ${ents} contacts${this.muted ? ' · MUTED' : ''}`);

        // Follow enemies with their overlays; retire stale ones.
        if (!this.gs) return;
        const live = this.gs.snapshotEnemies();
        const byId = new Map(live.map((e) => [e.id, e]));
        const now = this.time.now;
        const dead: string[] = [];
        this.overlays.forEach((o, id) => {
            const e = byId.get(id);
            if (e) {
                o.tx = e.x; o.ty = e.y - 52; o.last = now;
                o.c.x += (o.tx - o.c.x) * 0.25;
                o.c.y += (o.ty - o.c.y) * 0.25;
                o.c.setAlpha(Math.min(1, o.c.alpha + 0.08));
            } else if (now - o.last > 900) {
                o.c.setAlpha(o.c.alpha - 0.08);
                if (o.c.alpha <= 0) { o.c.destroy(); dead.push(id); }
            }
        });
        dead.forEach((id) => this.overlays.delete(id));
    }
}
