import * as Phaser from 'phaser';
import type { GameScene } from './GameScene';
import { explainFactors, type Factor } from '../ai/localBrain';
import { safeArea, uiScale } from '../ui/safeArea';

// ──────────────────────────────────────────────────────────────────────────────
//  HUD SCENE — responsive showcase overlay.
//  · adapts to phones, tablets and foldables (safe-area aware, no overlaps)
//  · one/two-thumb on-screen controls (relative-drag steer + FIRE / EMP pads)
//  · SYSTEM ONE panel: what it is, how it differs, live stats, and WHY the
//    selected agent chose what it chose (explainability, not a black box)
// ──────────────────────────────────────────────────────────────────────────────

const INTENT_LABELS: Record<string, string> = {
    adv: 'ADVANCE', strf: 'STRAFE', flk_l: 'FLANK L', flk_r: 'FLANK R',
    ret: 'RETREAT', p: 'PLAYER', proj: 'DODGE'
};

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
    tx: number; ty: number; last: number; conf: number; action: string;
}

const SYS_CAPS = [
    'Strategic intent @90-300ms · steering @60fps',
    'Full probability distribution per agent',
    'Uncertainty aware — EMP makes beliefs flicker',
    'Difficulty = brain params, not stat inflation',
    'One seed generates the entire visual identity'
];

const SYS_DIFFS = [
    ['vs behavior trees', 'no hand rules; intent is a probability, not a branch'],
    ['vs utility AI', 'one shared model drives every agent, batched in one call'],
    ['vs scripted patterns', 'improvises when no rule matches'],
    ['vs cloud LLMs', 'on-device, millisecond, works fully offline']
];

const SYS_TRY = [
    '⚡ EMP (E) — confidence collapses, then recovers',
    '⚙ lab → HARD — beliefs sharpen instantly',
    '🌊 surge — one call decides 6+ agents',
    '🎨 T — one seed re-skins ships, fire, stars, sky',
    '💔 hull 10% — retreat beliefs spike'
];

export class HUDScene extends Phaser.Scene {
    private gs!: GameScene;
    private s = 1;

    // Top / edge telemetry
    private topBg!: Phaser.GameObjects.Graphics;
    private latencyText!: Phaser.GameObjects.Text;
    private spark!: Phaser.GameObjects.Graphics;
    private sparkHist: number[] = [];
    private fpsText!: Phaser.GameObjects.Text;
    private scoreText!: Phaser.GameObjects.Text;
    private waveText!: Phaser.GameObjects.Text;
    private bestText!: Phaser.GameObjects.Text;
    private comboText!: Phaser.GameObjects.Text;
    private themeText!: Phaser.GameObjects.Text;
    private helpText!: Phaser.GameObjects.Text;

    // Toggles
    private gearBtn!: Phaser.GameObjects.Text;
    private sysPill!: Phaser.GameObjects.Text;
    private pauseBtn!: Phaser.GameObjects.Text;

    // Panels
    private godPanel!: Phaser.GameObjects.Container;
    private godOpen = false;
    private godConfig = { spawnScale: 1, speedScale: 1, noise: 0 };
    private sysPanel!: Phaser.GameObjects.Container;
    private sysOpen = false;
    private sysStat: Record<string, Phaser.GameObjects.Text> = {};
    private factorRows: { label: Phaser.GameObjects.Text; detail: Phaser.GameObjects.Text; bar: Phaser.GameObjects.Graphics; impact: number }[] = [];
    private sysFocus!: Phaser.GameObjects.Text;

    // Menus
    private menuLayer!: Phaser.GameObjects.Container;
    private pauseLayer!: Phaser.GameObjects.Container;
    private overLayer!: Phaser.GameObjects.Container;
    private overStats!: Phaser.GameObjects.Text;
    private menuStatus!: Phaser.GameObjects.Text;
    private diffDesc: Phaser.GameObjects.Text | null = null;
    private diffSets: ((sel: string) => void)[] = [];
    private menuBlocker: { x: number; y: number; w: number; h: number }[] = [];

    // Touch pads
    private touchLayer!: Phaser.GameObjects.Container;
    private fireZone!: Phaser.GameObjects.Zone;
    private fireGfx!: Phaser.GameObjects.Graphics;
    private empZone!: Phaser.GameObjects.Zone;
    private empGfx!: Phaser.GameObjects.Graphics;
    private fireDown = false;
    private empRects: { x: number; y: number; w: number; h: number }[] = [];

    // Misc
    private feedTexts: Phaser.GameObjects.Text[] = [];
    private overlays = new Map<string, Overlay>();
    private muted = false;
    private statTimer = 0;

    constructor() {
        super({ key: 'HUDScene' });
    }

    create() {
        this.gs = this.scene.get('GameScene') as GameScene;
        this.s = uiScale(this.scale.width, this.scale.height);

        this.topBg = this.add.graphics().setDepth(100);
        this.latencyText = this.txt(12, 8, '⚡ — ms', 13, '#55cc88').setDepth(101);
        this.spark = this.add.graphics().setDepth(101);
        this.fpsText = this.txt(0, 0, '', 10, '#5a6c8d').setDepth(101);
        this.scoreText = this.txt(0, 6, 'SCORE  0', 16, '#e8e8ff').setOrigin(0.5, 0).setDepth(101);
        this.waveText = this.txt(0, 7, 'WAVE 1', 13, '#7eb8ff').setOrigin(1, 0).setDepth(101);
        this.bestText = this.txt(0, 27, 'BEST 0', 10, '#8a93b8').setOrigin(0.5, 0).setDepth(101);
        this.comboText = this.txt(0, 26, '', 11, '#ffd166').setOrigin(1, 0).setDepth(101);
        this.themeText = this.txt(0, 40, '', 9, '#8a93b8').setOrigin(1, 0).setDepth(101);
        this.helpText = this.add.text(0, 0, '', {
            fontSize: '10px', color: '#4d5f7e', fontFamily: '"Inter", monospace',
            backgroundColor: '#00000055', padding: { left: 8, right: 8, top: 3, bottom: 3 }
        }).setOrigin(0.5, 1).setDepth(101).setAlpha(0.95);

        this.gearBtn = this.txt(0, 0, '⚙', 22, '#ffcc00').setOrigin(0.5).setDepth(102)
            .setInteractive({ useHandCursor: true });
        this.gearBtn.on('pointerdown', () => this.toggleGod());

        this.sysPill = this.add.text(0, 0, '◈ SYSTEM ONE', {
            fontSize: '11px', color: '#0a0a14', backgroundColor: '#7eb8ff',
            fontFamily: '"Inter", sans-serif', fontStyle: 'bold',
            padding: { left: 8, right: 8, top: 4, bottom: 4 }
        }).setOrigin(0, 0).setDepth(102).setInteractive({ useHandCursor: true });
        this.sysPill.on('pointerdown', () => this.toggleSys());

        this.pauseBtn = this.txt(0, 0, '❚❚', 13, '#cfe0ff').setOrigin(0.5).setDepth(102)
            .setInteractive({ useHandCursor: true });
        this.pauseBtn.on('pointerdown', () => this.gs.events.emit('hud:pause_touch'));

        this.createTouchPads();
        this.createGodPanel();
        this.createSysPanel();
        this.createMenuLayers();
        this.wireEvents();
        this.layout();
        this.setAi(false);

        this.scale.on('resize', () => this.layout());
        this.gs.events.on('world_resized', () => this.layout());
    }

    private txt(x: number, y: number, t: string, size: number, color: string): Phaser.GameObjects.Text {
        return this.add.text(x, y, t, { fontSize: `${size}px`, color, fontFamily: '"Inter", monospace' });
    }

    // ──────────────────────────────────────────────────────────────────────────
    //  RESPONSIVE LAYOUT (phones / tablets / foldables, safe-area aware)
    // ──────────────────────────────────────────────────────────────────────────
    private layout() {
        const W = this.scale.width, H = this.scale.height;
        const ins = safeArea();
        const s = this.s = uiScale(W, H);
        const narrow = W < 520;
        const barH = Math.round(46 * s);
        const top = ins.top;

        this.topBg.clear();
        this.topBg.fillStyle(0x000000, 0.5);
        this.topBg.fillRect(0, top, W, barH);

        const fs = (o: Phaser.GameObjects.Text, size: number) => o.setStyle({ fontSize: `${Math.round(size * s)}px` });
        fs(this.latencyText, narrow ? 11 : 13);
        this.latencyText.setPosition(ins.left + 10, top + 6);

        this.scoreText.setPosition(W / 2, top + 5);
        fs(this.scoreText, narrow ? 14 : 16);
        this.bestText.setPosition(W / 2, top + 25);
        fs(this.bestText, 10);

        this.waveText.setPosition(W - ins.right - 10, top + 6);
        fs(this.waveText, narrow ? 12 : 13);
        this.comboText.setPosition(W - ins.right - 10, top + 25);
        fs(this.comboText, 11);
        this.themeText.setPosition(W - ins.right - 10, top + 39);
        fs(this.themeText, 9);

        this.fpsText.setPosition(W - ins.right - 8, H - ins.bottom - 26).setOrigin(1, 1);
        fs(this.fpsText, 10);

        this.helpText.setStyle({ fontSize: `${Math.round(10 * s)}px` });
        this.helpText.setText(narrow
            ? 'drag to fly · ⚡ EMP · 🎨 theme · ❚❚ pause'
            : 'hold click / WASD fly · SPACE fire · E emp · T remix theme · P pause · M mute · R restart');
        this.helpText.setPosition(W / 2, H - ins.bottom - 2);

        // Toggles
        const ty = top + barH + Math.round(14 * s);
        this.sysPill.setPosition(ins.left + 8, ty).setStyle({ fontSize: `${Math.round(11 * s)}px` });
        this.gearBtn.setPosition(W - ins.right - Math.round(16 * s), ty).setStyle({ fontSize: `${Math.round(20 * s)}px` });
        this.pauseBtn.setPosition(W - ins.right - Math.round(50 * s), ty).setStyle({ fontSize: `${Math.round(12 * s)}px` });

        // Touch pads
        this.layoutTouchPads();

        // Panels (designed at a fixed width, then scaled for the device)
        this.godPanel.setPosition(W - ins.right - Math.min(220 * s, W - ins.left - ins.right - 16) - 8, ty + Math.round(26 * s));
        this.godPanel.setScale(s);
        this.sysPanel.setPosition(ins.left + 8, ty + Math.round(26 * s));
        this.sysPanel.setScale(s);

        // Menu layers: center-anchored blocks that reflow for portrait/landscape
        const my = H * 0.5;
        const compact = H < 520 || narrow;
        const titleY = compact ? my - 130 : my - 160;
        const rowY = titleY + Math.round((compact ? 178 : 224) * s);
        this.menuParts.title.setPosition(W / 2, titleY).setStyle({ fontSize: `${Math.round((compact ? 26 : 40) * s)}px` });
        this.menuParts.tagline.setPosition(W / 2, titleY + Math.round((compact ? 26 : 38) * s)).setStyle({ fontSize: `${Math.round(10 * s)}px` });
        this.menuParts.bullets.forEach((b, i) => {
            b.setVisible(!compact || i < 3);
            b.setPosition(W / 2, titleY + Math.round((compact ? 62 : 74) * s) + i * Math.round(19 * s))
                .setStyle({ fontSize: `${Math.round(11 * s)}px` });
        });
        this.menuStatus.setPosition(W / 2, titleY + Math.round((compact ? 132 : 176) * s)).setStyle({ fontSize: `${Math.round(11 * s)}px` });
        this.menuParts.diffHead.setPosition(W / 2, titleY + Math.round((compact ? 164 : 210) * s)).setStyle({ fontSize: `${Math.round(10 * s)}px` });
        this.menuParts.diffRow.container.setPosition(W / 2 - 99 * s, rowY);
        this.diffDesc?.setPosition(W / 2, rowY + Math.round(30 * s)).setStyle({ fontSize: `${Math.round(11 * s)}px` });
        this.menuParts.launch.setPosition(W / 2, rowY + Math.round(66 * s)).setStyle({ fontSize: `${Math.round(15 * s)}px` });

        this.pauseParts.title.setPosition(W / 2, my).setStyle({ fontSize: `${Math.round(30 * s)}px` });
        this.pauseParts.hint.setPosition(W / 2, my + Math.round(28 * s)).setStyle({ fontSize: `${Math.round(12 * s)}px` });
        const menuDim = this.menuLayer.getAt(0) as Phaser.GameObjects.Rectangle;
        menuDim.setSize(W, H).setPosition(W / 2, H / 2);
        const dimR = this.pauseLayer.getAt(0) as Phaser.GameObjects.Rectangle;
        dimR.setSize(W, H).setPosition(W / 2, H / 2);
        const overDim = this.overLayer.getAt(0) as Phaser.GameObjects.Rectangle;
        overDim.setSize(W, H).setPosition(W / 2, H / 2);

        const oy = compact ? my - 110 : my - 90;
        this.overParts.title.setPosition(W / 2, oy).setStyle({ fontSize: `${Math.round((compact ? 26 : 38) * s)}px` });
        this.overStats.setPosition(W / 2, oy + Math.round(44 * s)).setStyle({ fontSize: `${Math.round(12 * s)}px` });
        this.overParts.again.setPosition(W / 2, oy + Math.round(130 * s)).setStyle({ fontSize: `${Math.round(14 * s)}px` });

        this.repositionFeed();
        this.menuBlocker = [
            { x: W / 2 - 99 * s, y: rowY, w: 198 * s, h: 26 * s },
            ...this.empRects
        ];
        // Tell GameScene which screen regions belong to HUD (no ship steering there)
        this.gs.setControlRects([
            { x: this.sysPill.x, y: this.sysPill.y, w: this.sysPill.width, h: this.sysPill.height },
            { x: this.gearBtn.x - 22 * s, y: this.gearBtn.y - 22 * s, w: 44 * s, h: 44 * s },
            { x: this.pauseBtn.x - 20 * s, y: this.pauseBtn.y - 20 * s, w: 40 * s, h: 40 * s },
            ...this.empRects
        ]);
    }

    // ──────────────────────────────────────────────────────────────────────────
    //  TOUCH PADS — one-thumb (drag) or two-thumb (drag + FIRE)
    // ──────────────────────────────────────────────────────────────────────────
    private createTouchPads() {
        this.touchLayer = this.add.container(0, 0).setDepth(105);
        this.fireGfx = this.add.graphics();
        this.empGfx = this.add.graphics();
        this.fireZone = this.add.zone(0, 0, 10, 10).setInteractive();
        this.empZone = this.add.zone(0, 0, 10, 10).setInteractive();
        this.fireZone.on('pointerdown', () => this.setFire(true));
        this.fireZone.on('pointerup', () => this.setFire(false));
        this.fireZone.on('pointerupoutside', () => this.setFire(false));
        this.empZone.on('pointerdown', () => { this.gs.events.emit('hud:emp_touch'); this.sfxPulse(); });
        this.touchLayer.add([this.fireGfx, this.empGfx, this.fireZone, this.empZone]);
    }

    private setFire(down: boolean) {
        if (this.fireDown === down) return;
        this.fireDown = down;
        this.gs.events.emit('hud:fire', down);
        this.drawPads();
    }

    private sfxPulse() { /* EMP sfx handled by GameScene */ }

    private layoutTouchPads() {
        const W = this.scale.width, H = this.scale.height;
        const ins = safeArea();
        const s = this.s;
        const visible = this.gs ? this.gs.getTouchActive() : false;
        this.touchLayer.setVisible(visible);
        if (!visible) { this.empRects = []; return; }

        const fr = Math.round(54 * s);
        const fx = W - ins.right - fr - Math.round(14 * s);
        const fy = H - ins.bottom - fr - Math.round(14 * s);
        this.fireZone.setPosition(fx, fy).setSize(fr * 2, fr * 2, true);

        const er = Math.round(32 * s);
        const ex = fx - fr - er - Math.round(12 * s);
        const ey = fy - Math.round(6 * s);
        this.empZone.setPosition(ex, ey).setSize(er * 2, er * 2, true);

        this.empRects = [
            { x: fx - fr, y: fy - fr, w: fr * 2, h: fr * 2 },
            { x: ex - er, y: ey - er, w: er * 2, h: er * 2 }
        ];
        this.fireR = fr; this.empR = er;
        this.firePos = { x: fx, y: fy };
        this.empPos = { x: ex, y: ey };
        this.drawPads();
    }

    private fireR = 0; private empR = 0;
    private firePos = { x: 0, y: 0 }; private empPos = { x: 0, y: 0 };

    private drawPads() {
        if (!this.fireR) return;
        this.fireGfx.clear();
        this.fireGfx.fillStyle(this.fireDown ? 0x7eb8ff : 0x7eb8ff, this.fireDown ? 0.42 : 0.18);
        this.fireGfx.fillCircle(this.firePos.x, this.firePos.y, this.fireR);
        this.fireGfx.lineStyle(2, 0x9fd8ff, this.fireDown ? 1 : 0.6);
        this.fireGfx.strokeCircle(this.firePos.x, this.firePos.y, this.fireR);
        this.fireGfx.fillStyle(0xffffff, this.fireDown ? 0.95 : 0.75);
        // tiny crosshair glyph = "shoot"
        const t = this.fireR * 0.34;
        this.fireGfx.fillRect(this.firePos.x - t, this.firePos.y - 2, t * 2, 4);
        this.fireGfx.fillRect(this.firePos.x - 2, this.firePos.y - t, 4, t * 2);

        this.empGfx.clear();
        this.empGfx.fillStyle(0xffcc44, 0.16);
        this.empGfx.fillCircle(this.empPos.x, this.empPos.y, this.empR);
        this.empGfx.lineStyle(2, 0xffcc44, 0.7);
        this.empGfx.strokeCircle(this.empPos.x, this.empPos.y, this.empR);
        this.empGfx.fillStyle(0xffe9a8, 0.9);
        this.empGfx.fillRect(this.empPos.x - 2, this.empPos.y - 10, 4, 20);
        this.empGfx.fillRect(this.empPos.x - 10, this.empPos.y - 2, 20, 4);
    }

    // ──────────────────────────────────────────────────────────────────────────
    //  PANELS
    // ──────────────────────────────────────────────────────────────────────────
    private toggleGod() {
        this.godOpen = !this.godOpen;
        this.godPanel.setVisible(this.godOpen);
    }

    private toggleSys() {
        this.sysOpen = !this.sysOpen;
        this.sysPanel.setVisible(this.sysOpen);
    }

    private panelShell(w: number, h: number, title: string, color: string): Phaser.GameObjects.Container {
        const c = this.add.container(0, 0);
        const bg = this.add.graphics();
        bg.fillStyle(0x0b0b18, 0.94);
        bg.lineStyle(1, 0x334466, 0.7);
        bg.fillRoundedRect(0, 0, w, h, 10);
        bg.strokeRoundedRect(0, 0, w, h, 10);
        c.add(bg);
        c.add(this.add.text(14, 10, title, {
            fontSize: '12px', color, fontFamily: '"Inter", sans-serif', fontStyle: 'bold'
        }));
        return c;
    }

    private createGodPanel() {
        this.godPanel = this.panelShell(220, 410, 'AI STRESS LAB', '#ffcc44').setVisible(false).setDepth(110);
        this.godPanel.add(this.add.text(14, 28, 'inject chaos · watch beliefs flicker', {
            fontSize: '9px', color: '#5a6c8d', fontFamily: '"Inter", monospace'
        }));

        let by = 52;
        this.makeBtn(this.godPanel, by, '💔  Hull → 10%', () => {
            this.gs.events.emit('god_mode:health', 0.1);
            this.pushFeed('GOD: hull critical — retreat beliefs should spike', 0.3);
        }); by += 38;
        this.makeBtn(this.godPanel, by, '🚀  Missile barrage ×10', () => {
            this.gs.events.emit('god_mode:missiles', 10);
            this.pushFeed('GOD: threat barrage — dodge beliefs should spike', 0.3);
        }); by += 38;
        this.makeBtn(this.godPanel, by, '⚡  EMP noise pulse  [E]', () => this.gs.events.emit('god_mode:emp')); by += 38;
        this.makeBtn(this.godPanel, by, '🌊  Surge: spawn 6 now', () => {
            for (let i = 0; i < 6; i++) this.gs.spawnEnemy();
            this.pushFeed('GOD: surge — one batched call now decides 6+ agents', 0.4);
        }); by += 38;
        this.makeBtn(this.godPanel, by, '🎨  Remix theme seed  [T]', () => this.gs.events.emit('hud:remix')); by += 46;

        this.makeSlider(this.godPanel, by, 'SPAWN', 0.3, 3, 1, (v) => `×${v.toFixed(1)}`, (v) => {
            this.godConfig.spawnScale = v; this.gs.events.emit('god_mode:config', this.godConfig);
        }); by += 54;
        this.makeSlider(this.godPanel, by, 'SPEED', 0.5, 2, 1, (v) => `×${v.toFixed(1)}`, (v) => {
            this.godConfig.speedScale = v; this.gs.events.emit('god_mode:config', this.godConfig);
        }); by += 54;
        this.makeSlider(this.godPanel, by, 'NOISE', 0, 1.5, 0, (v) => v.toFixed(2), (v) => {
            this.godConfig.noise = v; this.gs.events.emit('god_mode:config', this.godConfig);
        }); by += 56;

        this.godPanel.add(this.add.text(14, by, 'DIFFICULTY — retunes the AI brain', {
            fontSize: '10px', color: '#8a93b8', fontFamily: '"Inter", monospace'
        }));
        const labRow = this.makeSegRow(12, by + 16, ['easy', 'normal', 'hard'], this.gs.difficulty, (id) => {
            this.gs.events.emit('hud:difficulty', id);
        });
        this.godPanel.add(labRow.container);
        this.diffSets.push(labRow.set);
        by += 52;
        this.makeBtn(this.godPanel, by, '📱  Controls: touch / keys', () => {
            const next = this.gs.controlMode === 'touch' ? 'keys' : 'touch';
            this.gs.events.emit('hud:control_mode', next);
            this.pushFeed(`CONTROLS: ${next.toUpperCase()} mode`, 0.5);
        });
    }

    private createSysPanel() {
        const W = 300, H = 384;
        this.sysPanel = this.panelShell(W, H, 'SYSTEM ONE · WHAT MAKES THIS DIFFERENT', '#7eb8ff')
            .setVisible(false).setDepth(111);
        let y = 32;
        const mk = (t: string, size: number, color: string, x = 14) => {
            const o = this.add.text(x, y, t, { fontSize: `${size}px`, color, fontFamily: '"Inter", monospace', wordWrap: { width: W - 28 } });
            this.sysPanel.add(o);
            y += Math.round(size) + 5;
            return o;
        };
        mk('CAPABILITIES', 10, '#7eb8ff');
        SYS_CAPS.forEach((c) => mk(`· ${c}`, 9, '#aabbdd'));
        y += 6;
        mk('VERSUS CLASSIC GAME AI', 10, '#7eb8ff');
        SYS_DIFFS.forEach(([a, b]) => mk(`${a}\n   ${b}`, 9, '#aabbdd'));
        y += 6;
        mk('LIVE — THIS SESSION', 10, '#51e08c');
        ['engine', 'decisions', 'avg confidence', 'agents in batch', 'cadence / difficulty'].forEach((k) => {
            const v = this.add.text(W - 14, y, '—', { fontSize: '9px', color: '#e8e8ff', fontFamily: '"Inter", monospace' }).setOrigin(1, 0);
            this.sysPanel.add(v);
            this.sysStat[k] = v;
            mk(k.toUpperCase(), 9, '#8a93b8');
        });
        y += 4;
        mk('WHY IT CHOSE — TOP CONFIDENCE AGENT', 10, '#ffd166');
        this.sysFocus = mk('—', 9, '#e8e8ff');
        for (let i = 0; i < 5; i++) {
            const bar = this.add.graphics();
            const label = this.add.text(14, y, '', { fontSize: '9px', color: '#aabbdd', fontFamily: '"Inter", monospace' });
            const detail = this.add.text(W - 14, y, '', { fontSize: '9px', color: '#5a6c8d', fontFamily: '"Inter", monospace' }).setOrigin(1, 0);
            this.sysPanel.add([bar, label, detail]);
            this.factorRows.push({ label, detail, bar, impact: 0 });
            y += 15;
        }
        y += 6;
        mk('WHAT TO TRY', 10, '#ff9a3c');
        SYS_TRY.forEach((c) => mk(`· ${c}`, 9, '#aabbdd'));
    }

    private updateSysStats() {
        if (!this.sysOpen || !this.gs) return;
        const st = this.gs.getAiStats();
        const set = (k: string, v: string) => { const t = this.sysStat[k]; if (t) t.setText(v); };
        set('engine', st.engine.includes('server') ? 'server' : 'local twin');
        set('decisions', String(st.decisions));
        set('avg confidence', `${Math.round(st.avgConf * 100)}%`);
        set('agents in batch', String(st.entities));
        set('cadence / difficulty', `${st.cadence}ms · ${st.difficulty}`);

        // Explainability for the most certain agent on screen.
        let bestId = '', bestConf = -1;
        this.overlays.forEach((o, id) => { if (o.conf > bestConf) { bestConf = o.conf; bestId = id; } });
        const bs = this.gs.getBrainState();
        if (!bs || !bestId) {
            this.sysFocus.setText(bestId ? 'no state yet' : 'spawn an enemy to inspect it');
            this.factorRows.forEach((r) => r.bar.clear());
            return;
        }
        const factors: Factor[] = explainFactors(bestId, bs);
        const o = this.overlays.get(bestId);
        this.sysFocus.setText(o
            ? `${bestId} → ${INTENT_LABELS[o.action] ?? o.action.toUpperCase()} @ ${Math.round(o.conf * 100)}%`
            : bestId);
        const rowW = 300 - 28;
        this.factorRows.forEach((row, i) => {
            const f = factors[i];
            if (!f) { row.label.setText(''); row.detail.setText(''); row.bar.clear(); return; }
            row.label.setText(f.label);
            row.detail.setText(f.detail);
            row.impact = f.impact;
            const mid = 14 + rowW / 2;
            row.bar.clear();
            row.bar.fillStyle(0x1a1a3a, 1);
            row.bar.fillRect(14, row.label.y + 11, rowW, 3);
            const wpx = (f.impact * rowW) / 2;
            row.bar.fillStyle(f.impact >= 0 ? 0xff8a5c : 0x5cc8ff, 1);
            if (wpx >= 0) row.bar.fillRect(mid, row.label.y + 11, wpx, 3);
            else row.bar.fillRect(mid + wpx, row.label.y + 11, -wpx, 3);
            row.bar.fillStyle(0xffffff, 0.6);
            row.bar.fillRect(mid - 1, row.label.y + 9, 2, 7);
        });
    }

    // ──────────────────────────────────────────────────────────────────────────
    //  WIDGET FACTORY
    // ──────────────────────────────────────────────────────────────────────────
    private makeBtn(parent: Phaser.GameObjects.Container, y: number, label: string, cb: () => void) {
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
        const t = this.add.text(98, 15, label, { fontSize: '11px', color: '#ccccee', fontFamily: '"Inter", sans-serif' }).setOrigin(0.5);
        c.add([bg, t]);
        bg.setInteractive(new Phaser.Geom.Rectangle(0, 0, 196, 30), Phaser.Geom.Rectangle.Contains);
        bg.on('pointerover', () => draw(true));
        bg.on('pointerout', () => draw(false));
        bg.on('pointerdown', cb);
        parent.add(c);
    }

    private makeSlider(parent: Phaser.GameObjects.Container, y: number, name: string, min: number, max: number, val: number, fmt: (v: number) => string, onChange: (v: number) => void) {
        const c = this.add.container(12, y);
        const label = this.add.text(0, 0, '', { fontSize: '10px', color: '#8a93b8', fontFamily: '"Inter", monospace' });
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

    private makeSegRow(x: number, y: number, opts: string[], current: string, cb: (id: string) => void) {
        const c = this.add.container(x, y);
        const bgs: Phaser.GameObjects.Graphics[] = [];
        const txts: Phaser.GameObjects.Text[] = [];
        const bw = 62, gap = 6;
        const paint = (sel: string) => {
            opts.forEach((o, i) => {
                const on = o === sel;
                bgs[i].clear();
                bgs[i].fillStyle(on ? 0x2f4a7a : 0x1a1a3a, 1);
                bgs[i].lineStyle(1, on ? 0x7eb8ff : 0x334466, on ? 1 : 0.5);
                bgs[i].fillRoundedRect(0, 0, bw, 26, 5);
                bgs[i].strokeRoundedRect(0, 0, bw, 26, 5);
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
            bgs.push(g); txts.push(t);
        });
        paint(current);
        return { container: c, set: paint };
    }

    // ──────────────────────────────────────────────────────────────────────────
    //  MENUS
    // ──────────────────────────────────────────────────────────────────────────
    private menuParts!: {
        title: Phaser.GameObjects.Text; tagline: Phaser.GameObjects.Text; bullets: Phaser.GameObjects.Text[];
        diffHead: Phaser.GameObjects.Text; diffRow: { container: Phaser.GameObjects.Container; set: (sel: string) => void };
        launch: Phaser.GameObjects.Text;
    };
    private overParts!: { title: Phaser.GameObjects.Text; again: Phaser.GameObjects.Text };
    private pauseParts!: { title: Phaser.GameObjects.Text; hint: Phaser.GameObjects.Text };

    private createMenuLayers() {
        const W = this.scale.width, H = this.scale.height;

        this.menuLayer = this.add.container(0, 0).setDepth(130);
        const dim = this.add.rectangle(W / 2, H / 2, W, H, 0x03030c, 0.78);
        this.menuLayer.add(dim);
        const title = this.add.text(W / 2, H * 0.24, 'KESSLER PROTOCOL', {
            fontSize: '40px', color: '#7eb8ff', fontFamily: '"Inter", sans-serif', fontStyle: 'bold'
        }).setOrigin(0.5);
        const tagline = this.add.text(W / 2, H * 0.24 + 38, 'ONE LOCAL MODEL FLIES EVERY ENEMY — LIVE PROBABILITIES OVERHEAD', {
            fontSize: '11px', color: '#8a93b8', fontFamily: '"Inter", monospace'
        }).setOrigin(0.5);
        this.menuLayer.add([title, tagline]);
        const bullets = [
            '◆  System One intent ~90-300ms → 60 FPS steering beneath',
            '◆  Batched compact JSON (p / e / q) — one call, all agents',
            '◆  EMP + sliders: watch probabilities flicker and recover',
            '◆  Difficulty retunes the BRAIN, not the stats',
            '◆  Seed-driven theme: ships, fire, stars, sky'
        ].map((t) => {
            const o = this.add.text(W / 2, 0, t, { fontSize: '11px', color: '#aabbdd', fontFamily: '"Inter", monospace' }).setOrigin(0.5);
            this.menuLayer.add(o);
            return o;
        });
        this.menuStatus = this.add.text(W / 2, 0, '● probing decision server…', {
            fontSize: '11px', color: '#8a93b8', fontFamily: '"Inter", monospace'
        }).setOrigin(0.5);
        this.menuLayer.add(this.menuStatus);
        const diffHead = this.add.text(W / 2, 0, '— DIFFICULTY · RETUNES THE AI BRAIN —', {
            fontSize: '10px', color: '#5a6c8d', fontFamily: '"Inter", monospace'
        }).setOrigin(0.5);
        this.menuLayer.add(diffHead);
        const diffRow = this.makeSegRow(0, 0, ['easy', 'normal', 'hard'], this.gs.difficulty, (id) => {
            this.gs.events.emit('hud:difficulty', id);
        });
        this.menuLayer.add(diffRow.container);
        this.diffSets.push(diffRow.set);
        this.diffDesc = this.add.text(W / 2, 0, '', {
            fontSize: '11px', color: '#8a93b8', fontFamily: '"Inter", monospace'
        }).setOrigin(0.5);
        this.menuLayer.add(this.diffDesc);
        const launch = this.add.text(W / 2, 0, '▶  TAP / CLICK / ENTER TO LAUNCH', {
            fontSize: '15px', color: '#0a0a14', backgroundColor: '#7eb8ff',
            fontFamily: '"Inter", sans-serif', fontStyle: 'bold',
            padding: { left: 16, right: 16, top: 9, bottom: 9 }
        }).setOrigin(0.5).setInteractive({ useHandCursor: true });
        launch.on('pointerdown', () => this.gs.events.emit('hud:start_touch'));
        this.menuLayer.add(launch);
        this.tweens.add({ targets: launch, alpha: 0.75, duration: 700, yoyo: true, repeat: -1 });
        this.menuParts = { title, tagline, bullets, diffHead, diffRow, launch };

        // Tap anywhere to launch (mobile-friendly) — but never on the difficulty
        // row or the touch pads, so those taps register as real choices.
        this.input.on('pointerdown', (p: Phaser.Input.Pointer) => {
            if (!this.menuLayer.visible || p.y <= this.scale.height * 0.5) return;
            for (const r of this.menuBlocker) {
                if (p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h) return;
            }
            this.gs.events.emit('hud:start_touch');
        });

        this.pauseLayer = this.add.container(0, 0).setDepth(131).setVisible(false);
        this.pauseLayer.add(this.add.rectangle(W / 2, H / 2, W, H, 0x03030c, 0.6));
        const pTitle = this.add.text(W / 2, H / 2, '❚❚  PAUSED', {
            fontSize: '30px', color: '#e8e8ff', fontFamily: '"Inter", sans-serif', fontStyle: 'bold'
        }).setOrigin(0.5);
        const pHint = this.add.text(W / 2, H / 2 + 24, 'P / ESC / ❚❚ to resume', {
            fontSize: '12px', color: '#8a93b8', fontFamily: '"Inter", monospace'
        }).setOrigin(0.5);
        this.pauseLayer.add([pTitle, pHint]);
        this.pauseParts = { title: pTitle, hint: pHint };

        this.overLayer = this.add.container(0, 0).setDepth(132).setVisible(false);
        this.overLayer.add(this.add.rectangle(W / 2, H / 2, W, H, 0x03030c, 0.72));
        const otitle = this.add.text(W / 2, H * 0.3, 'SHIP LOST', {
            fontSize: '38px', color: '#ff6666', fontFamily: '"Inter", sans-serif', fontStyle: 'bold'
        }).setOrigin(0.5);
        this.overStats = this.add.text(W / 2, 0, '', {
            fontSize: '13px', color: '#aabbdd', fontFamily: '"Inter", monospace', align: 'center', lineSpacing: 7
        }).setOrigin(0.5, 0);
        const again = this.add.text(W / 2, 0, '↻  FLY AGAIN  [R]', {
            fontSize: '15px', color: '#0a0a14', backgroundColor: '#51e08c',
            fontFamily: '"Inter", sans-serif', fontStyle: 'bold',
            padding: { left: 16, right: 16, top: 9, bottom: 9 }
        }).setOrigin(0.5).setInteractive({ useHandCursor: true });
        again.on('pointerdown', () => this.gs.events.emit('hud:restart'));
        this.overLayer.add([otitle, this.overStats, again]);
        this.overParts = { title: otitle, again };
    }

    private onDifficulty(d: string, silent = false) {
        this.diffSets.forEach((fn) => fn(d));
        this.diffDesc?.setText(DIFF_DESC[d] ?? '');
        if (!silent) this.pushFeed(`MODE: ${d.toUpperCase()} — ${DIFF_DESC[d] ?? ''}`, 0.5);
    }

    // ──────────────────────────────────────────────────────────────────────────
    //  EVENTS + TELEMETRY
    // ──────────────────────────────────────────────────────────────────────────
    private wireEvents() {
        const ev = this.gs.events;
        ev.on('decision_latency', (d: { ms: number; source: string }) => this.onLatency(d.ms, d.source));
        ev.on('score_change', (v: number) => this.scoreText.setText(`SCORE  ${v}`));
        ev.on('wave_change', (n: number) => this.onWave(n));
        ev.on('high_score', (n: number) => this.bestText.setText(`BEST ${n}`));
        ev.on('combo_change', (n: number) => this.comboText.setText(n >= 2 ? `🔥 x${n}` : ''));
        ev.on('player_health', (hp: number, max: number) => this.drawHealth(hp, max));
        ev.on('decision_made', (d: { id: string; x: number; y: number; action: string; confidence: number; probabilities: Record<string, number>; elite: boolean }) => {
            this.upsertOverlay(d.id, d.x, d.y, d.action, d.confidence, d.probabilities, d.elite);
            this.pushFeed(`${d.id} → ${INTENT_LABELS[d.action] ?? d.action}  ${(d.confidence * 100).toFixed(0)}%`, d.confidence);
        });
        ev.on('enemy_died', (id: string) => this.dropOverlay(id));
        ev.on('ai_status', (ok: boolean) => this.setAi(ok));
        ev.on('theme_changed', (t: { seed: number; name: string }) => {
            this.themeLabel = `🎨 ${t.seed} · ${t.name}`;
            this.setAi(this.gs.aiOnline === true);
            this.pushFeed(`THEME: seed ${t.seed} "${t.name}" — ships / fire / stars / sky re-rolled`, 0.6);
        });
        ev.on('game_phase', (p: string) => this.onPhase(p));
        ev.on('game_over', (s: { score: number; wave: number; kills: number; high: number; elapsed: number; difficulty: string }) => this.showGameOver(s));
        ev.on('sfx_toggle', (on: boolean) => { this.muted = !on; });
        ev.on('emp_fired', () => this.pushFeed('GOD: EMP injected — watch every confidence bar collapse', 0.2));
        ev.on('difficulty_changed', (d: string) => this.onDifficulty(d));
        ev.on('control_mode', (m: string) => {
            this.pushFeed(`CONTROLS: ${m.toUpperCase()}`, 0.5);
            this.layoutTouchPads();
        });
        ev.on('hud:syspanel', () => this.toggleSys());
        this.onDifficulty(this.gs.difficulty, true);
        this.drawHealth(5, 5);
    }

    private onLatency(ms: number, source: string) {
        const tag = source.includes('local') ? 'LOCAL' : source.includes('heuristic') ? 'HEUR' : 'AI';
        this.latencyText.setText(`⚡ ${ms < 10 ? ms.toFixed(1) : Math.round(ms)} ms · ${tag}`);
        this.latencyText.setColor(ms < 50 ? '#55cc88' : ms < 150 ? '#ffcc44' : '#ff5555');
        this.sparkHist.push(Math.min(ms, 400));
        if (this.sparkHist.length > 60) this.sparkHist.shift();
        const s = this.s;
        this.spark.clear();
        this.spark.fillStyle(0x1a2436, 1);
        this.spark.fillRect(this.latencyText.x, 40 * s, 118 * s, 4);
        this.sparkHist.forEach((v, i) => {
            const hgt = Math.max(1, (v / 400) * 13);
            this.spark.fillStyle(v < 50 ? 0x55cc88 : v < 150 ? 0xffcc44 : 0xff5555, 0.9);
            this.spark.fillRect(this.latencyText.x + i * 2 * s, 40 * s + 13 - hgt, 1.6, hgt);
        });
    }

    private setAi(ok: boolean) {
        const dot = ok ? '●' : '○';
        const tag = `· ${dot} AI ${ok ? 'SERVER' : 'LOCAL'}`;
        this.themeText.setText(this.themeLabel ? `${this.themeLabel} ${tag}` : `🎨${tag}`);
        this.themeText.setColor(ok ? '#51e08c' : '#ffaa33');
        if (this.menuStatus) {
            this.menuStatus.setText(ok ? '● decision server ONLINE — live model inference' : '● local twin — on-device heuristic brain, zero backend');
            this.menuStatus.setColor(ok ? '#51e08c' : '#ffaa33');
        }
    }

    private themeLabel = '';

    private onWave(n: number) {
        this.waveText.setText(`WAVE ${n}`);
        const H = this.scale.height;
        const banner = this.add.text(this.scale.width / 2, H * 0.32, `— WAVE ${n} —`, {
            fontSize: `${Math.round(26 * this.s)}px`, color: '#7eb8ff', fontFamily: '"Inter", sans-serif', fontStyle: 'bold'
        }).setOrigin(0.5).setAlpha(0).setDepth(120);
        this.tweens.add({
            targets: banner, alpha: 1, y: banner.y - 14, duration: 400, yoyo: true, hold: 900,
            onComplete: () => banner.destroy()
        });
    }

    private healthBar!: Phaser.GameObjects.Graphics;
    private healthText!: Phaser.GameObjects.Text;

    private drawHealth(hp: number, max: number) {
        if (!this.healthBar) {
            this.healthBar = this.add.graphics().setDepth(101);
            this.healthText = this.add.text(0, 0, '', {
                fontSize: '9px', color: '#8a93b8', fontFamily: '"Inter", monospace'
            }).setDepth(101);
        }
        const s = this.s;
        const ins = safeArea();
        const x = ins.left + 10, y = ins.top + 24 * s, bw = 86 * s, bh = 6 * s;
        this.healthBar.clear();
        this.healthBar.fillStyle(0x222244, 1);
        this.healthBar.fillRoundedRect(x, y, bw, bh, 3);
        const pct = Math.max(0, Math.min(1, hp / Math.max(1, max)));
        this.healthBar.fillStyle(pct > 0.6 ? 0x55cc88 : pct > 0.3 ? 0xffcc44 : 0xff4444, 1);
        if (pct > 0) this.healthBar.fillRoundedRect(x, y, bw * pct, bh, 3);
        this.healthText.setPosition(x, y + 8 * s).setText(`HULL ${Math.max(0, hp)}/${max}`).setStyle({ fontSize: `${Math.round(9 * s)}px` });
    }

    private pushFeed(msg: string, conf: number) {
        const ins = safeArea();
        const H = this.scale.height;
        const maxLines = this.scale.width < 520 ? 4 : 6;
        if (this.feedTexts.length >= maxLines) this.feedTexts.shift()?.destroy();
        this.repositionFeed();
        const color = conf > 0.65 ? '#7df0b2' : conf > 0.35 ? '#ffd166' : '#ff8a7a';
        const t = this.add.text(ins.left + 10, H - ins.bottom - 40 * this.s, `› ${msg}`, {
            fontSize: `${Math.round(10 * this.s)}px`, color, fontFamily: '"Inter", monospace',
            backgroundColor: '#00000066', padding: { left: 5, right: 5, top: 2, bottom: 2 }
        }).setDepth(101).setAlpha(0.95);
        this.feedTexts.push(t);
        this.repositionFeed();
    }

    private repositionFeed() {
        const ins = safeArea();
        const H = this.scale.height;
        const step = Math.round(17 * this.s);
        const base = H - ins.bottom - 40 * this.s;
        this.feedTexts.forEach((t, i) => {
            t.setPosition(ins.left + 10, base - (this.feedTexts.length - 1 - i) * step);
        });
    }

    // ──────────────────────────────────────────────────────────────────────────
    //  PER-AGENT PROBABILITY OVERLAYS
    // ──────────────────────────────────────────────────────────────────────────
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
            o = { c, label, sub, bars, bg, glow, tx: x, ty: y - 52, last: this.time.now, conf, action };
            this.overlays.set(id, o);
        }
        o.tx = x; o.ty = y - 52; o.last = this.time.now; o.conf = conf; o.action = action;
        o.label.setText(`${elite ? '★ ' : ''}${INTENT_LABELS[action] ?? action.toUpperCase()}`);
        o.label.setColor(elite ? '#ffd166' : conf > 0.65 ? '#44ffaa' : conf > 0.35 ? '#ffdd44' : '#ff6666');
        o.sub.setText(`${Math.round(conf * 100)}%`);
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
        o.glow.fillStyle(conf > 0.65 ? 0x2266ff : conf > 0.35 ? 0xffaa00 : 0xff3300, conf > 0.65 ? 0.1 : 0.16);
        o.glow.fillCircle(0, -8, 40);
    }

    private dropOverlay(id: string) {
        const o = this.overlays.get(id);
        if (!o) return;
        o.c.destroy();
        this.overlays.delete(id);
    }

    private onPhase(p: string) {
        this.menuLayer.setVisible(p === 'menu');
        this.pauseLayer.setVisible(p === 'paused');
        this.overLayer.setVisible(p === 'over');
        if (p !== 'playing') this.setFire(false);
        this.layoutTouchPads();
    }

    private showGameOver(s: { score: number; wave: number; kills: number; high: number; elapsed: number; difficulty: string }) {
        const isBest = s.score >= s.high && s.score > 0;
        this.overStats.setText(
            `MODE ${(s.difficulty ?? 'normal').toUpperCase()} · SCORE ${s.score} · WAVE ${s.wave} · KILLS ${s.kills}\n` +
            `SURVIVED ${s.elapsed}s      BEST ${s.high}${isBest ? '\n★ NEW RECORD ★' : ''}`
        );
        this.overLayer.setVisible(true);
        this.setFire(false);
        this.touchLayer.setVisible(false);
    }

    update(_t: number, delta: number) {
        if (!this.gs) return;
        const live = this.gs.snapshotEnemies();
        this.fpsText.setText(`${Math.round(this.game.loop.actualFps)} fps · ${live.length} contacts${this.muted ? ' · MUTED' : ''}`);

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

        this.statTimer += delta;
        if (this.statTimer > 250) {
            this.statTimer = 0;
            this.updateSysStats();
        }
    }
}