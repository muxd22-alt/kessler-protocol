import * as Phaser from 'phaser';
import { scoreOptions, shootUrgency, DIFF_AI, type Difficulty, type BrainState } from '../ai/localBrain';
import { Sfx } from '../fx/sfx';
import { fetchTheme, themeFromSeed, serverEnabled, type Theme } from '../fx/theme';
import { entityScale, resetSafeArea } from '../ui/safeArea';

export type GamePhase = 'menu' | 'playing' | 'paused' | 'over';
export type ControlMode = 'auto' | 'touch' | 'keys';

// ──────────────────────────────────────────────────────────────────────────────
//  GAME SCENE — Kessler Protocol showcase
//  Two-tier AI: System One model sets strategic intent (~150 ms cadence);
//  Craig-Reynolds-style steering runs at 60 FPS. A local heuristic twin keeps
//  the demo intelligent when the decision server is offline.
// ──────────────────────────────────────────────────────────────────────────────

interface EnemyData {
    health: number;
    maxHealth: number;
    type: 'fighter' | 'bomber' | 'support';
    elite: boolean;
    activeIntent: string;
    fireTimer: number;
    seed: number;
}

interface GodConfig { spawnScale: number; speedScale: number; noise: number }

const STAR_LAYERS = 3;
const STAR_COUNT = [130, 85, 50];
const STAR_SPEED = [0.15, 0.4, 0.9];
const DECISION_URL = 'http://127.0.0.1:8088/v1/systemone';
const HEALTH_URL = 'http://127.0.0.1:8088/health';
const MOVE_OPTS = ['adv', 'strf', 'flk_l', 'flk_r', 'ret'];
const TARGET_OPTS = ['p', 'proj', 'ret'];
const HIGH_KEY = 'kessler_highscore';
const DIFF_KEY = 'kessler_diff';

// Gameplay pressure matched to each brain preset: decision cadence, steering
// speed, fire rate, mercy invulnerability, elite spawn rate, enemy shot speed.
// Hard is faster and less forgiving in every axis; easy is the opposite.
const DIFF_PLAY: Record<Difficulty, { cadence: number; speed: number; fire: number; invuln: number; eliteMul: number; bullet: number }> = {
    easy: { cadence: 300, speed: 0.65, fire: 2.0, invuln: 1200, eliteMul: 0, bullet: 0.8 },
    normal: { cadence: 150, speed: 1.0, fire: 1.0, invuln: 600, eliteMul: 1, bullet: 1.0 },
    hard: { cadence: 90, speed: 1.35, fire: 0.5, invuln: 250, eliteMul: 2.2, bullet: 1.15 }
};

export class GameScene extends Phaser.Scene {
    private player!: Phaser.Physics.Arcade.Sprite;
    private enemies!: Phaser.Physics.Arcade.Group;
    private playerBullets!: Phaser.Physics.Arcade.Group;
    private enemyBullets!: Phaser.Physics.Arcade.Group;
    private meteors!: Phaser.Physics.Arcade.Group;

    private starTiles: Phaser.GameObjects.TileSprite[] = [];
    private twinkleGfx!: Phaser.GameObjects.Graphics;
    private twinklers: { x: number; y: number; s: number; c: number; v: number }[] = [];
    private nebulas: Phaser.GameObjects.Image[] = [];
    private overlayGfx!: Phaser.GameObjects.Graphics; // hp bars + intent vectors
    private sfx = new Sfx();

    phase: GamePhase = 'menu';
    difficulty: Difficulty = 'normal';
    private theme: Theme = themeFromSeed((Math.random() * 999999) | 0);
    private keys: Record<string, Phaser.Input.Keyboard.Key> = {};
    private god: GodConfig = { spawnScale: 1, speedScale: 1, noise: 0 };

    // ── Mobile / foldable support ──
    controlMode: ControlMode = 'auto';
    private steerPointer = -1;
    private originX = 0;
    private originY = 0;
    private shipAnchorX = 0;
    private shipAnchorY = 0;
    private uiRects: { x: number; y: number; w: number; h: number }[] = [];
    private touchFire = false;
    private entScale = 1;

    // ── Showcase stats ──
    private decisionCount = 0;
    private confSum = 0;
    private confN = 0;
    private brainState: BrainState | null = null;
    private lastCadence = 150;

    private lastFired = 0;
    private decisionTimer = 0;
    private decisionInFlight = false;
    aiOnline: boolean | null = null;

    private wave = 1;
    private score = 0;
    private high = 0;
    private kills = 0;
    private combo = 0;
    private comboTimer = 0;
    private playerHealth = 5;
    private maxHealth = 5;
    private invulnUntil = 0;
    private elapsed = 0;

    private empActive = false;
    private empTimer = 0;
    private empRing: Phaser.GameObjects.Arc[] = [];

    private spawnTimer?: Phaser.Time.TimerEvent;
    private meteorTimer?: Phaser.Time.TimerEvent;
    private enemiesSpawned = 0;
    private enemiesPerWave = 5;

    constructor() {
        super({ key: 'GameScene' });
    }

    create() {
        this.cameras.main.setBackgroundColor(this.theme.bg);
        this.high = Number(localStorage.getItem(HIGH_KEY) ?? 0) || 0;
        const savedDiff = localStorage.getItem(DIFF_KEY);
        if (savedDiff === 'easy' || savedDiff === 'normal' || savedDiff === 'hard') this.difficulty = savedDiff;

        // Graphics must exist before the starfield bakes into them.
        this.twinkleGfx = this.add.graphics().setDepth(-10);
        this.overlayGfx = this.add.graphics().setDepth(6);
        this.buildStarfield();
        this.buildNebulas();
        void this.loadTheme(); // ask the LLM side for a look-from-a-number

        this.enemies = this.physics.add.group();
        this.playerBullets = this.physics.add.group();
        this.enemyBullets = this.physics.add.group();
        this.meteors = this.physics.add.group();

        // ─── Player ───
        const w = this.scale.width, h = this.scale.height;
        this.player = this.physics.add.sprite(w / 2, h - 110, 'player_ship');
        this.player.setScale(0.7 * this.entScale).setDepth(10).setCollideWorldBounds(true);
        this.player.setTint(this.theme.player);
        this.playerHealth = this.maxHealth;

        this.add.particles(0, 0, 'dot', {
            speed: { min: 20, max: 70 }, angle: { min: 80, max: 100 },
            scale: { start: 0.5, end: 0 }, alpha: { start: 0.8, end: 0 },
            lifespan: 350, blendMode: 'ADD', follow: this.player,
            followOffset: { x: 0, y: 30 },             frequency: 30, tint: this.theme.exhaust
        }).setDepth(9);

        // ─── Input ───
        // Mouse = direct point-to-ship. Touch = relative drag, so the thumb
        // never covers the ship (the ship keeps its offset from the finger).
        // Works one-thumb (drag to fly, auto-fire) or two-thumb (left thumb
        // drags, right thumb holds FIRE).
        this.entScale = entityScale(this.scale.width, this.scale.height);
        this.input.on('pointermove', (p: Phaser.Input.Pointer) => {
            if (this.phase !== 'playing' || !p.isDown || p.id !== this.steerPointer) return;
            if (this.inUiRect(p.x, p.y)) return;
            if (this.dragSteering(p)) {
                const tx = this.shipAnchorX + (p.x - this.originX);
                const ty = this.shipAnchorY + (p.y - this.originY);
                this.physics.moveToObject(this.player, { x: tx, y: ty }, 520);
            } else {
                this.physics.moveToObject(this.player, { x: p.worldX, y: p.worldY }, 420);
            }
        });
        this.input.on('pointerdown', (p: Phaser.Input.Pointer) => {
            this.sfx.unlock();
            if (this.phase !== 'playing') return;
            if (p.button !== 0) return;
            if (this.inUiRect(p.x, p.y)) return; // that thumb belongs to a HUD button
            this.steerPointer = p.id;
            this.originX = p.x; this.originY = p.y;
            this.shipAnchorX = this.player.x; this.shipAnchorY = this.player.y;
        });
        const release = (p: Phaser.Input.Pointer) => {
            if (p.id === this.steerPointer) {
                this.steerPointer = -1;
                if (this.phase === 'playing' && !this.anyKeyHeld()) this.player.setVelocity(0);
            }
        };
        this.input.on('pointerup', release);
        this.input.on('pointerupoutside', release);
        if (this.input.keyboard) {
            const kb = this.input.keyboard;
            this.keys = kb.addKeys('W,A,S,D,UP,DOWN,LEFT,RIGHT,SPACE,P,E,M,R,ENTER,ESC,T') as Record<string, Phaser.Input.Keyboard.Key>;
            kb.on('keydown-P', () => this.togglePause());
            kb.on('keydown-ESC', () => this.togglePause());
            kb.on('keydown-E', () => this.fireEMP());
            kb.on('keydown-T', () => this.remixTheme());
            kb.on('keydown-I', () => this.events.emit('hud:syspanel'));
            kb.on('keydown-M', () => { this.sfx.enabled = !this.sfx.enabled; this.events.emit('sfx_toggle', this.sfx.enabled); });
            kb.on('keydown-R', () => { if (this.phase === 'over') this.restart(); });
            kb.on('keydown-ENTER', () => { if (this.phase === 'menu' || this.phase === 'over') this.startGame(); });
        }

        // ─── Collisions ───
        this.physics.add.overlap(this.playerBullets, this.enemies, this.hitEnemy as never, undefined, this);
        this.physics.add.overlap(this.enemyBullets, this.player, this.hitPlayer as never, undefined, this);
        this.physics.add.overlap(this.playerBullets, this.meteors, this.hitMeteor as never, undefined, this);
        this.physics.add.overlap(this.player, this.enemies, this.ramEnemy as never, undefined, this);
        this.physics.add.overlap(this.player, this.meteors, this.ramMeteor as never, undefined, this);
        // Registered ONCE — creating colliders per frame is a huge perf leak.
        this.physics.add.overlap(this.meteors, this.enemies, this.meteorHitsEnemy as never, undefined, this);

        // ─── Directors ───
        this.spawnTimer = this.time.addEvent({ delay: 2200, callback: this.spawnEnemy, callbackScope: this, loop: true, paused: true });
        this.meteorTimer = this.time.addEvent({ delay: 4200, callback: this.spawnMeteor, callbackScope: this, loop: true, paused: true });

        // ─── God-mode / HUD bridge ───
        this.events.on('god_mode:health', (pct: number) => {
            this.playerHealth = Math.max(1, Math.round(this.maxHealth * pct));
            this.flashShip(0xff4444);
            this.events.emit('player_health', this.playerHealth, this.maxHealth);
        });
        this.events.on('god_mode:missiles', (count: number) => {
            for (let i = 0; i < count; i++) {
                const b = this.playerBullets.create(Phaser.Math.Between(50, w - 50), h + 10, 'laser_green') as Phaser.Physics.Arcade.Sprite;
                b.setScale(0.6).setVelocityY(-340).setDepth(9).setTint(this.theme.bulletPlayer);
            }
        });
        this.events.on('god_mode:emp', () => this.fireEMP());
        this.events.on('god_mode:config', (c: Partial<GodConfig>) => {
            const prevSpawn = this.god.spawnScale;
            Object.assign(this.god, c);
            if (this.god.spawnScale !== prevSpawn) this.retuneSpawnTimer();
        });
        this.events.on('hud:start', () => this.startGame());
        this.events.on('hud:restart', () => this.restart());
        this.events.on('hud:pause', () => this.togglePause());
        this.events.on('hud:remix', () => this.remixTheme());
        this.events.on('hud:difficulty', (d: Difficulty) => this.setDifficulty(d));
        this.events.on('hud:control_mode', (m: ControlMode) => this.setControlMode(m));
        this.events.on('hud:fire', (down: boolean) => { this.touchFire = down; });
        this.events.on('hud:emp_touch', () => this.fireEMP());
        this.events.on('hud:pause_touch', () => this.togglePause());
        this.events.on('hud:start_touch', () => { if (this.phase === 'menu' || this.phase === 'over') this.startGame(); });

        this.scale.on('resize', () => this.buildStarfield());
        // Foldables/tablets report a real viewport change — not just window resize.
        if (window.visualViewport) {
            window.visualViewport.addEventListener('resize', () => this.onResizeFoldable());
        }
        const savedCtrl = localStorage.getItem('kessler_control');
        if (savedCtrl === 'touch' || savedCtrl === 'keys' || savedCtrl === 'auto') this.controlMode = savedCtrl;

        // Backend presence probe (drives the HUD status dot).
        void this.probeBackend();
        this.time.addEvent({ delay: 5000, loop: true, callback: () => void this.probeBackend() });

        this.events.emit('game_phase', this.phase);
        this.events.emit('high_score', this.high);
    }

    // ─── Public API for HUDScene ───
    snapshotEnemies(): { id: string; x: number; y: number }[] {
        return this.enemies.getChildren().map((e) => {
            const s = e as Phaser.Physics.Arcade.Sprite;
            return { id: s.name, x: s.x, y: s.y };
        });
    }

    getStats() {
        return { score: this.score, high: this.high, wave: this.wave, kills: this.kills, elapsed: this.elapsed, aiOnline: this.aiOnline };
    }

    // ─── Flow ───
    startGame() {
        if (this.phase === 'playing') return;
        this.sfx.unlock();
        this.resetWorld();
        this.phase = 'playing';
        if (this.spawnTimer) this.spawnTimer.paused = false;
        if (this.meteorTimer) this.meteorTimer.paused = false;
        this.physics.world.resume();
        this.sfx.wave();
        this.events.emit('game_phase', this.phase);
        this.events.emit('wave_change', this.wave);
        this.events.emit('score_change', this.score);
        this.events.emit('player_health', this.playerHealth, this.maxHealth);
    }

    restart() {
        this.resetWorld();
        this.phase = 'playing';
        if (this.spawnTimer) this.spawnTimer.paused = false;
        if (this.meteorTimer) this.meteorTimer.paused = false;
        this.physics.world.resume();
        this.events.emit('game_phase', this.phase);
        this.events.emit('wave_change', this.wave);
        this.events.emit('score_change', this.score);
        this.events.emit('player_health', this.playerHealth, this.maxHealth);
    }

    setDifficulty(d: Difficulty) {
        if (d !== 'easy' && d !== 'normal' && d !== 'hard') return;
        if (d === this.difficulty) return;
        this.difficulty = d;
        localStorage.setItem(DIFF_KEY, d);
        this.events.emit('difficulty_changed', d);
    }

    togglePause() {
        if (this.phase === 'playing') {
            this.phase = 'paused';
            this.physics.world.pause();
            if (this.spawnTimer) this.spawnTimer.paused = true;
            if (this.meteorTimer) this.meteorTimer.paused = true;
        } else if (this.phase === 'paused') {
            this.phase = 'playing';
            this.physics.world.resume();
            if (this.spawnTimer) this.spawnTimer.paused = false;
            if (this.meteorTimer) this.meteorTimer.paused = false;
        }
        this.events.emit('game_phase', this.phase);
    }

    private resetWorld() {
        this.enemies.clear(true, true);
        this.playerBullets.clear(true, true);
        this.enemyBullets.clear(true, true);
        this.meteors.clear(true, true);
        this.wave = 1; this.score = 0; this.kills = 0; this.combo = 0;
        this.playerHealth = this.maxHealth;
        this.enemiesSpawned = 0; this.enemiesPerWave = 5;
        this.elapsed = 0; this.invulnUntil = 0;
        this.player.setPosition(this.scale.width / 2, this.scale.height - 110).setVelocity(0).setActive(true).setVisible(true).setTint(this.theme.player).clearAlpha();
        this.cameras.main.resetFX();
    }

    private gameOver() {
        this.phase = 'over';
        this.spawnExplosion(this.player.x, this.player.y, 2.2);
        this.player.setVisible(false).setActive(false);
        this.sfx.gameOver();
        this.cameras.main.shake(300, 0.015);
        if (this.spawnTimer) this.spawnTimer.paused = true;
        if (this.meteorTimer) this.meteorTimer.paused = true;
        if (this.score > this.high) {
            this.high = this.score;
            localStorage.setItem(HIGH_KEY, String(this.high));
        }
        this.time.delayedCall(900, () => {
            this.events.emit('game_over', { score: this.score, wave: this.wave, kills: this.kills, high: this.high, elapsed: Math.round(this.elapsed / 1000), difficulty: this.difficulty });
            this.events.emit('game_phase', this.phase);
            this.events.emit('high_score', this.high);
        });
    }

    // ─── Mobile / foldable plumbing (driven by HUDScene) ───
    setControlRects(rects: { x: number; y: number; w: number; h: number }[]) {
        this.uiRects = rects;
    }

    private inUiRect(x: number, y: number): boolean {
        const pad = 6;
        for (const r of this.uiRects) {
            if (x >= r.x - pad && x <= r.x + r.w + pad && y >= r.y - pad && y <= r.y + r.h + pad) return true;
        }
        return false;
    }

    setControlMode(m: ControlMode) {
        this.controlMode = m;
        localStorage.setItem('kessler_control', m);
        this.events.emit('control_mode', m);
    }

    private dragSteering(p: Phaser.Input.Pointer): boolean {
        if (this.controlMode === 'touch') return true;
        if (this.controlMode === 'keys') return false;
        return p.wasTouch === true;
    }

    private anyKeyHeld(): boolean {
        return !!(
            this.keys.A?.isDown || this.keys.D?.isDown || this.keys.W?.isDown || this.keys.S?.isDown ||
            this.keys.LEFT?.isDown || this.keys.RIGHT?.isDown || this.keys.UP?.isDown || this.keys.DOWN?.isDown
        );
    }

    getTouchActive(): boolean {
        if (this.controlMode === 'touch') return true;
        if (this.controlMode === 'keys') return false;
        return !!this.sys.game.device.input.touch;
    }

    getAiStats() {
        return {
            engine: this.aiOnline === true ? 'server / llama.cpp-ready' : 'local twin (in-browser)',
            decisions: this.decisionCount,
            avgConf: this.confN > 0 ? this.confSum / this.confN : 0,
            entities: this.enemies ? this.enemies.getLength() : 0,
            cadence: Math.round(this.lastCadence),
            difficulty: this.difficulty
        };
    }

    getBrainState(): BrainState | null { return this.brainState; }

    private onResizeFoldable() {
        resetSafeArea();
        const w = this.scale.width, h = this.scale.height;
        this.entScale = entityScale(w, h);
        this.buildStarfield();
        this.player.setScale(0.7 * this.entScale);
        this.player.setPosition(
            Phaser.Math.Clamp(this.player.x, 24, w - 24),
            Phaser.Math.Clamp(this.player.y, 40, h - 24)
        );
        this.events.emit('world_resized', { w, h });
    }

    // ─── Seed theme: one number → every color ───
    private async loadTheme(seed?: number) {
        try {
            this.theme = await fetchTheme(seed);
        } catch {
            this.theme = themeFromSeed(seed ?? ((Math.random() * 999999) | 0));
        }
        this.applyTheme();
    }

    remixTheme() {
        if (this.phase !== 'playing' && this.phase !== 'paused') return;
        void this.loadTheme((Math.random() * 999999) | 0);
    }

    private paintEnemy(enemy: Phaser.Physics.Arcade.Sprite, data: EnemyData) {
        enemy.clearTint();
        if (data.elite) enemy.setTint(this.theme.elite);
        else if (data.type === 'fighter') enemy.setTint(this.theme.fighter);
        else if (data.type === 'bomber') enemy.setTint(this.theme.bomber);
        else enemy.setTint(this.theme.support);
    }

    private applyTheme() {
        const t = this.theme;
        this.cameras.main.setBackgroundColor(t.bg);
        this.nebulas.forEach((n, i) => n.setTint(t.nebulas[i % t.nebulas.length]));
        this.player.setTint(t.player);
        this.enemies.getChildren().forEach((e) => {
            const s = e as Phaser.Physics.Arcade.Sprite;
            const d = s.getData('ai') as EnemyData | undefined;
            if (d) this.paintEnemy(s, d);
        });
        this.buildStarfield(); // re-bake with the new palette (only on theme change)
        this.events.emit('theme_changed', { seed: t.seed, name: t.name });
    }

    // ─── Backend probe ───
    private async probeBackend() {
        if (!serverEnabled()) {
            // Hosted build (e.g. GitHub Pages): no backend possible — local twin it is.
            if (this.aiOnline !== false) {
                this.aiOnline = false;
                this.events.emit('ai_status', false);
            }
            return;
        }
        try {
            const ctl = new AbortController();
            const t = window.setTimeout(() => ctl.abort(), 1500);
            const res = await fetch(HEALTH_URL, { signal: ctl.signal });
            window.clearTimeout(t);
            const ok = res.ok;
            if (ok !== this.aiOnline) {
                this.aiOnline = ok;
                this.events.emit('ai_status', ok);
            }
        } catch {
            if (this.aiOnline !== false) {
                this.aiOnline = false;
                this.events.emit('ai_status', false);
            }
        }
    }

    private retuneSpawnTimer() {
        const paused = this.spawnTimer?.paused ?? true;
        if (this.spawnTimer) this.spawnTimer.remove(false);
        this.spawnTimer = this.time.addEvent({
            delay: Math.max(500, 2200 / Math.max(0.2, this.god.spawnScale)),
            callback: this.spawnEnemy, callbackScope: this, loop: true, paused
        });
    }

    // ─── Background ───
    // Stars are baked into one texture per layer and scrolled with TileSprite:
    // 3 draw calls/frame instead of ~265 per-frame circles (huge mobile win).
    private buildStarfield() {
        const w = Math.max(2, Math.ceil(this.scale.width));
        const h = Math.max(2, Math.ceil(this.scale.height));
        this.starTiles.forEach((t) => t.destroy());
        this.starTiles = [];
        for (let layer = 0; layer < STAR_LAYERS; layer++) {
            const key = `starRT${layer}`;
            if (this.textures.exists(key)) this.textures.remove(key);
            const rt = this.textures.createCanvas(key, w, h);
            if (rt) {
                const c = rt.getContext();
                c.clearRect(0, 0, w, h);
                for (let i = 0; i < STAR_COUNT[layer]; i++) {
                    const sx = Math.random() * w;
                    const sy = Math.random() * h;
                    const r = 0.5 + Math.random() * (1.4 + layer);
                    const a = 0.25 + Math.random() * 0.6;
                    const col = this.theme.stars[(Math.random() * this.theme.stars.length) | 0];
                    c.globalAlpha = a;
                    c.fillStyle = `#${col.toString(16).padStart(6, '0')}`;
                    c.beginPath();
                    c.arc(sx, sy, r, 0, Math.PI * 2);
                    c.fill();
                }
                c.globalAlpha = 1;
                rt.refresh();
            }
            const tile = this.add.tileSprite(0, 0, w, h, key).setOrigin(0, 0).setDepth(-10);
            this.starTiles.push(tile);
        }
        // A handful of live twinklers keep the sky breathing (cheap).
        if (this.twinkleGfx) this.twinkleGfx.clear();
        this.twinklers = [];
        for (let i = 0; i < 14; i++) {
            this.twinklers.push({
                x: Math.random() * w, y: Math.random() * h,
                s: 1 + Math.random() * 1.4,
                c: this.theme.stars[(Math.random() * this.theme.stars.length) | 0],
                v: 6 + Math.random() * 10
            });
        }
    }

    private buildNebulas() {
        const w = this.scale.width, h = this.scale.height;
        this.nebulas.forEach((n) => n.destroy());
        this.nebulas = [];
        const spots = [
            { x: w * 0.2, y: h * 0.25, s: 2.6, a: 0.5 },
            { x: w * 0.85, y: h * 0.55, s: 3.2, a: 0.42 },
            { x: w * 0.5, y: h * 0.85, s: 2.2, a: 0.45 }
        ];
        spots.forEach((n, i) => {
            const img = this.add.image(n.x, n.y, 'nebula').setDepth(-9).setScale(n.s).setAlpha(n.a).setTint(this.theme.nebulas[i % this.theme.nebulas.length]).setBlendMode(Phaser.BlendModes.ADD);
            this.nebulas.push(img);
        });
    }

    // ─── Spawners ───
    spawnEnemy() {
        if (this.phase !== 'playing') return;
        const maxConcurrent = Math.min(4 + this.wave, 12);
        if (this.enemies.getLength() >= maxConcurrent) return;
        const w = this.scale.width;
        const x = Phaser.Math.Between(60, Math.max(61, w - 60));
        const roll = Math.random();
        const type: EnemyData['type'] = roll < 0.5 ? 'fighter' : roll < 0.78 ? 'support' : 'bomber';
        const eliteBase = Math.min(0.08 + this.wave * 0.02, 0.3) * DIFF_PLAY[this.difficulty].eliteMul;
        const elite = this.wave >= 3 && Math.random() < eliteBase;
        const textures = { fighter: 'enemy_fighter', bomber: 'enemy_bomber', support: 'enemy_support' };
        const hps = { fighter: 1, bomber: 3, support: 2 };
        const scales = { fighter: 0.55, bomber: 0.52, support: 0.5 };

        const enemy = this.enemies.create(x, -40, textures[type]) as Phaser.Physics.Arcade.Sprite;
        enemy.setScale(0.01).setAngle(180).setDepth(8);
        enemy.name = `e_${Phaser.Math.RND.uuid().slice(0, 5)}`;
        const data: EnemyData = {
            health: hps[type] * (elite ? 2 : 1), maxHealth: hps[type] * (elite ? 2 : 1),
            type, elite, activeIntent: 'adv', fireTimer: Phaser.Math.Between(300, 1200), seed: Math.random() * 1000
        };
        enemy.setData('ai', data);
        this.paintEnemy(enemy, data);
        // Warp-in
        this.tweens.add({ targets: enemy, scale: scales[type] * this.entScale * (elite ? 1.25 : 1), duration: 350, ease: 'Back.easeOut' });
        const flash = this.add.image(x, 10, 'effect_flash').setScale(0.6).setAlpha(0.9).setDepth(8).setBlendMode(Phaser.BlendModes.ADD);
        this.tweens.add({ targets: flash, alpha: 0, scale: 1.4, duration: 300, onComplete: () => flash.destroy() });

        this.enemiesSpawned++;
        if (this.enemiesSpawned >= this.enemiesPerWave) {
            this.wave++;
            this.enemiesSpawned = 0;
            this.enemiesPerWave = Math.min(12, this.enemiesPerWave + 1);
            this.sfx.wave();
            this.events.emit('wave_change', this.wave);
        }
    }

    spawnMeteor() {
        if (this.phase !== 'playing') return;
        const w = this.scale.width;
        const keys = ['meteor1', 'meteor2', 'meteor3', 'meteor4'];
        const m = this.meteors.create(Phaser.Math.Between(30, w - 30), -60, keys[Phaser.Math.Between(0, 3)]) as Phaser.Physics.Arcade.Sprite;
        m.setScale((0.35 + Math.random() * 0.3) * this.entScale).setDepth(3);
        m.setVelocity(Phaser.Math.Between(-40, 40), Phaser.Math.Between(50, 110));
        m.setAngularVelocity(Phaser.Math.Between(-60, 60));
    }

    // ─── Combat ───
    private hitEnemy(bullet: Phaser.GameObjects.GameObject, enemyObj: Phaser.GameObjects.GameObject) {
        const b = bullet as Phaser.Physics.Arcade.Sprite;
        const e = enemyObj as Phaser.Physics.Arcade.Sprite;
        b.destroy();
        const data = e.getData('ai') as EnemyData;
        if (!data) return;
        data.health -= 1;
        this.sfx.hit();
        e.setTintFill(0xffffff);
        this.time.delayedCall(70, () => {
            if (!e.active) return;
            const d = e.getData('ai') as EnemyData | undefined;
            if (d) this.paintEnemy(e, d);
        });
        if (data.health <= 0) {
            this.spawnExplosion(e.x, e.y, data.type === 'bomber' ? 1.6 : 1);
            this.events.emit('enemy_died', e.name);
            this.kills++;
            this.combo++;
            this.comboTimer = 3000;
            const mult = 1 + Math.min(this.combo, 10) * 0.1;
            const base = data.type === 'bomber' ? 30 : data.type === 'support' ? 20 : 10;
            const gained = Math.round(base * mult * (data.elite ? 2 : 1));
            this.score += gained;
            this.events.emit('score_change', this.score);
            this.events.emit('combo_change', this.combo);
            this.scorePopup(e.x, e.y - 20, `+${gained}${data.elite ? ' ELITE' : ''}`, data.elite ? '#ffd166' : '#9df2c0');
            this.sfx.explosion();
            e.destroy();
        }
    }

    private damagePlayer(amount: number) {
        if (this.phase !== 'playing') return;
        const now = this.time.now;
        if (now < this.invulnUntil) return;
        this.invulnUntil = now + DIFF_PLAY[this.difficulty].invuln;
        this.playerHealth -= amount;
        this.combo = 0;
        this.events.emit('combo_change', this.combo);
        this.events.emit('player_health', this.playerHealth, this.maxHealth);
        this.cameras.main.shake(130, 0.008);
        this.flashShip(0xff4444);
        this.sfx.hurt();
        if (this.playerHealth <= 0) this.gameOver();
    }

    private hitPlayer(_p: Phaser.GameObjects.GameObject, bullet: Phaser.GameObjects.GameObject) {
        (bullet as Phaser.Physics.Arcade.Sprite).destroy();
        this.damagePlayer(1);
    }

    private ramEnemy(p: Phaser.GameObjects.GameObject, e: Phaser.GameObjects.GameObject) {
        const enemy = e as Phaser.Physics.Arcade.Sprite;
        const data = enemy.getData('ai') as EnemyData | undefined;
        this.spawnExplosion(enemy.x, enemy.y, 1.2);
        this.events.emit('enemy_died', enemy.name);
        if (data) {
            this.score += 10;
            this.events.emit('score_change', this.score);
        }
        enemy.destroy();
        this.damagePlayer(1);
        void p;
    }

    private ramMeteor(p: Phaser.GameObjects.GameObject, m: Phaser.GameObjects.GameObject) {
        const meteor = m as Phaser.Physics.Arcade.Sprite;
        this.spawnExplosion(meteor.x, meteor.y, 1);
        meteor.destroy();
        this.damagePlayer(1);
        void p;
    }

    private meteorHitsEnemy(m: Phaser.GameObjects.GameObject, e: Phaser.GameObjects.GameObject) {
        const meteor = m as Phaser.Physics.Arcade.Sprite;
        const enemy = e as Phaser.Physics.Arcade.Sprite;
        const data = enemy.getData('ai') as EnemyData | undefined;
        this.spawnExplosion((meteor.x + enemy.x) / 2, (meteor.y + enemy.y) / 2, 0.9);
        meteor.destroy();
        if (data) {
            data.health -= 2;
            if (data.health <= 0) {
                this.events.emit('enemy_died', enemy.name);
                this.score += 5;
                this.events.emit('score_change', this.score);
                enemy.destroy();
            }
        } else enemy.destroy();
    }

    private hitMeteor(bullet: Phaser.GameObjects.GameObject, meteor: Phaser.GameObjects.GameObject) {
        (bullet as Phaser.Physics.Arcade.Sprite).destroy();
        const m = meteor as Phaser.Physics.Arcade.Sprite;
        this.spawnExplosion(m.x, m.y, 0.8);
        m.destroy();
        this.score += 5;
        this.events.emit('score_change', this.score);
        this.sfx.explosion();
    }

    private flashShip(tint: number) {
        this.player.setTint(tint);
        this.time.delayedCall(180, () => { if (this.player.active) this.player.setTint(this.theme.player); });
    }

    private scorePopup(x: number, y: number, text: string, color: string) {
        const t = this.add.text(x, y, text, {
            fontSize: '13px', fontFamily: '"Inter", monospace', color, fontStyle: 'bold'
        }).setOrigin(0.5).setDepth(20);
        this.tweens.add({ targets: t, y: y - 34, alpha: 0, duration: 700, ease: 'Cubic.easeOut', onComplete: () => t.destroy() });
    }

    spawnExplosion(x: number, y: number, scale = 1) {
        const burst = this.add.particles(x, y, 'dot', {
            speed: { min: 50, max: 220 * scale }, scale: { start: 0.9 * scale, end: 0 },
            alpha: { start: 1, end: 0 }, lifespan: 450, blendMode: 'ADD',
            quantity: 14, emitting: false, tint: [0xffe08a, 0xff9a3c, 0x7eb8ff]
        }).setDepth(15);
        burst.explode(14);
        this.time.delayedCall(650, () => burst.destroy());
        const ring = this.add.circle(x, y, 6, 0xffffff, 0).setDepth(15).setStrokeStyle(2, 0x9fd8ff, 0.9);
        this.tweens.add({ targets: ring, radius: 46 * scale, alpha: 0, duration: 350, ease: 'Cubic.easeOut', onComplete: () => ring.destroy() });
    }

    fireEMP() {
        if (this.phase !== 'playing' || this.empActive) return;
        this.empActive = true;
        this.empTimer = 3000;
        this.sfx.emp();
        this.cameras.main.shake(250, 0.012);
        this.cameras.main.flash(350, 120, 170, 255, true);
        // Expanding EMP ring(s)
        for (let i = 0; i < 3; i++) {
            const ring = this.add.circle(this.player.x, this.player.y, 20, 0x88ccff, 0)
                .setDepth(18).setStrokeStyle(3 - i, 0x88ccff, 0.8 - i * 0.2);
            this.empRing.push(ring);
            this.tweens.add({
                targets: ring, radius: Math.max(this.scale.width, this.scale.height),
                alpha: 0, duration: 900 + i * 180, ease: 'Cubic.easeOut',
                onComplete: () => { ring.destroy(); }
            });
        }
        this.time.delayedCall(3000, () => { this.empRing = []; });
        this.events.emit('emp_fired');
    }

    // ──────────────────────────────────────────────────────────────────────────
    //  UPDATE
    // ──────────────────────────────────────────────────────────────────────────
    update(time: number, rawDelta: number) {
        const delta = Math.min(rawDelta, 50);
        const w = this.scale.width, h = this.scale.height;

        // Scrolling baked layers (3 tile writes) + a few live twinklers.
        const speedMul = this.phase === 'playing' ? 1 : 0.35;
        for (let layer = 0; layer < this.starTiles.length; layer++) {
            const tile = this.starTiles[layer];
            tile.tilePositionY = (tile.tilePositionY + STAR_SPEED[layer] * delta * 0.12 * speedMul) % h;
        }
        this.twinkleGfx.clear();
        for (let i = 0; i < this.twinklers.length; i++) {
            const t = this.twinklers[i];
            t.y += t.v * delta * 0.06 * speedMul;
            if (t.y > h) { t.y = 0; t.x = Math.random() * w; }
            const a = 0.3 + Math.abs(Math.sin(time * 0.0025 + t.x)) * 0.7;
            this.twinkleGfx.fillStyle(t.c, a);
            this.twinkleGfx.fillCircle(t.x, t.y, t.s);
        }
        this.nebulas.forEach((n, i) => { n.x += Math.sin(time * 0.0001 + i * 2) * delta * 0.004; });

        if (this.phase === 'menu') {
            // Idle bob for the parked ship.
            this.player.y = h - 110 + Math.sin(time * 0.002) * 8;
            return;
        }
        if (this.phase !== 'playing') return;

        this.elapsed += delta;

        if (this.empActive) {
            this.empTimer -= delta;
            if (this.empTimer <= 0) this.empActive = false;
        }
        if (this.combo > 0) {
            this.comboTimer -= delta;
            if (this.comboTimer <= 0) { this.combo = 0; this.events.emit('combo_change', 0); }
        }

        // ─── Player movement: keyboard + pointer ───
        const body = this.player.body as Phaser.Physics.Arcade.Body;
        let kx = 0, ky = 0;
        if (this.keys.A?.isDown || this.keys.LEFT?.isDown) kx -= 1;
        if (this.keys.D?.isDown || this.keys.RIGHT?.isDown) kx += 1;
        if (this.keys.W?.isDown || this.keys.UP?.isDown) ky -= 1;
        if (this.keys.S?.isDown || this.keys.DOWN?.isDown) ky += 1;
        const steering = this.steerPointer !== -1;
        if (kx !== 0 || ky !== 0) {
            const len = Math.hypot(kx, ky);
            body.velocity.x = Phaser.Math.Linear(body.velocity.x, (kx / len) * 430, 0.35);
            body.velocity.y = Phaser.Math.Linear(body.velocity.y, (ky / len) * 430, 0.35);
        } else if (!steering) {
            body.velocity.x *= 0.9;
            body.velocity.y *= 0.9;
        }
        // Banking tilt
        this.player.setAngle(Phaser.Math.Clamp(body.velocity.x * 0.03, -18, 18));

        // ─── Player fire ───
        // Hold the screen / SPACE / on-screen FIRE. Touch auto-fires while dragging.
        const firing = this.touchFire || this.keys.SPACE?.isDown || (this.steerPointer !== -1);
        if (firing && time > this.lastFired) {
            // Player faction color: gun matches the ship.
            const tint = this.theme.bulletPlayer;
            for (const dx of [-8, 8]) {
                const b = this.playerBullets.create(this.player.x + dx, this.player.y - 26, 'laser_blue') as Phaser.Physics.Arcade.Sprite;
                b.setScale(0.6).setVelocityY(-560).setDepth(9).setTint(tint);
            }
            // Muzzle flash
            const f = this.add.image(this.player.x, this.player.y - 30, 'effect_flash')
                .setScale(0.35).setAlpha(0.9).setDepth(11).setBlendMode(Phaser.BlendModes.ADD);
            this.tweens.add({ targets: f, alpha: 0, scale: 0.15, duration: 90, onComplete: () => f.destroy() });
            this.sfx.shoot();
            this.lastFired = time + 170;
        }

        // ─── Decision tick ───
        this.decisionTimer += delta;
        const load = this.enemies.getLength();
        const interval = Math.min(500, DIFF_PLAY[this.difficulty].cadence + load * 12);
        if (this.decisionTimer >= interval) {
            this.decisionTimer = 0;
            this.lastCadence = interval;
            void this.querySystemOneModel();
        }

        // ─── Steering (per-type, capped, EMP-chaotic) ───
        const spdScale = this.god.speedScale;
        this.enemies.getChildren().forEach((e) => {
            const enemy = e as Phaser.Physics.Arcade.Sprite;
            const data = enemy.getData('ai') as EnemyData;
            if (!data) return;
            const eb = enemy.body as Phaser.Physics.Arcade.Body;
            const base = (data.type === 'fighter' ? 150 : data.type === 'bomber' ? 85 : 105)
                * (data.elite ? 1.3 : 1) * spdScale * DIFF_PLAY[this.difficulty].speed;
            const intent = data.activeIntent;
            const wobble = Math.sin(time * 0.002 + data.seed) * 30;

            if (this.empActive && Math.random() < 0.06) {
                eb.velocity.x += Phaser.Math.Between(-260, 260);
                eb.velocity.y += Phaser.Math.Between(-260, 260);
            } else if (intent === 'adv') {
                const angle = Phaser.Math.Angle.Between(enemy.x, enemy.y, this.player.x, this.player.y);
                eb.velocity.x += (Math.cos(angle) * base - eb.velocity.x) * 0.07;
                eb.velocity.y += (Math.sin(angle) * base - eb.velocity.y) * 0.07;
            } else if (intent === 'strf') {
                const dir = enemy.x < this.player.x ? 1 : -1;
                eb.velocity.x += (dir * base + wobble - eb.velocity.x) * 0.06;
                eb.velocity.y += (30 - eb.velocity.y) * 0.05;
                // Supports weave harder; bombers lumber.
                if (data.type === 'support') eb.velocity.x += Math.cos(time * 0.004 + data.seed) * 6;
            } else if (intent === 'flk_l') {
                eb.velocity.x += (-base + wobble * 0.5 - eb.velocity.x) * 0.06;
                eb.velocity.y += (base * 0.3 - eb.velocity.y) * 0.06;
            } else if (intent === 'flk_r') {
                eb.velocity.x += (base + wobble * 0.5 - eb.velocity.x) * 0.06;
                eb.velocity.y += (base * 0.3 - eb.velocity.y) * 0.06;
            } else if (intent === 'ret') {
                eb.velocity.y += (-base * 1.1 - eb.velocity.y) * 0.07;
                eb.velocity.x *= 0.96;
            }
            // Cap speed (prevents EMP slingshots escaping the sim).
            const maxV = base * 2.4 + 120;
            const sp = Math.hypot(eb.velocity.x, eb.velocity.y);
            if (sp > maxV) { eb.velocity.x = (eb.velocity.x / sp) * maxV; eb.velocity.y = (eb.velocity.y / sp) * maxV; }

            // Enemy fire — urgency from last scalar answer, defaults sane.
            data.fireTimer += delta;
            const urge = (enemy.getData('shootN') as number | undefined) ?? 0.5;
            const period = (data.type === 'fighter' ? 1500 : 2300) * (1.3 - urge * 0.7) / (data.elite ? 1.4 : 1) * DIFF_PLAY[this.difficulty].fire;
            if (data.fireTimer > period && enemy.y > 0 && enemy.y < this.player.y - 40) {
                data.fireTimer = 0;
                const eb2 = this.enemyBullets.create(enemy.x, enemy.y + 20, data.elite ? 'missile' : 'laser_red') as Phaser.Physics.Arcade.Sprite;
                eb2.setScale(0.5).setDepth(7).setTint(data.elite ? this.theme.elite : this.theme.bulletEnemy);
                if (data.elite) eb2.setAngle(180);
                this.physics.moveToObject(eb2, this.player, (data.type === 'fighter' ? 260 : 210) * DIFF_PLAY[this.difficulty].bullet);
                eb2.setRotation(Math.atan2(this.player.y - enemy.y, this.player.x - enemy.x) + Math.PI / 2);
                if (Math.random() < 0.5) this.sfx.enemyShoot();
            }
            if (enemy.y > h + 90 || enemy.y < -140 || enemy.x < -90 || enemy.x > w + 90) {
                this.events.emit('enemy_died', enemy.name);
                enemy.destroy();
            }
        });

        // (meteor × enemy collisions are a persistent collider registered in create())

        // Cleanup — one snapshot per group per frame (getChildren() copies).
        const cleanup = (list: Phaser.GameObjects.GameObject[]) => {
            for (let i = 0; i < list.length; i++) {
                const s = list[i] as Phaser.Physics.Arcade.Sprite;
                if (s.y < -40 || s.y > h + 40 || s.x < -40 || s.x > w + 40) s.destroy();
            }
        };
        cleanup(this.playerBullets.getChildren());
        cleanup(this.enemyBullets.getChildren());
        cleanup(this.meteors.getChildren());

        this.drawOverlay();
    }

    // Per-frame single-Graphics pass: enemy HP pips + intent vectors + player shield.
    private drawOverlay() {
        const g = this.overlayGfx;
        g.clear();
        // Player shield shimmer while invulnerable
        if (this.time.now < this.invulnUntil && this.player.visible) {
            g.lineStyle(2, 0x7eb8ff, 0.7);
            g.strokeCircle(this.player.x, this.player.y, 34 + Math.sin(this.time.now * 0.02) * 2);
        }
        this.enemies.getChildren().forEach((e) => {
            const enemy = e as Phaser.Physics.Arcade.Sprite;
            const data = enemy.getData('ai') as EnemyData;
            if (!data) return;
            // HP pips
            const bw = 30;
            g.fillStyle(0x0a0a18, 0.8);
            g.fillRect(enemy.x - bw / 2, enemy.y - 26, bw, 4);
            const pct = Math.max(0, data.health / data.maxHealth);
            g.fillStyle(data.elite ? 0xffd166 : pct > 0.5 ? 0x51e08c : pct > 0.25 ? 0xffcc44 : 0xff5555, 1);
            g.fillRect(enemy.x - bw / 2, enemy.y - 26, bw * pct, 4);
            // Intent vector
            const eb = enemy.body as Phaser.Physics.Arcade.Body | null;
            if (eb) {
                const sp = Math.hypot(eb.velocity.x, eb.velocity.y);
                if (sp > 20) {
                    const nx = eb.velocity.x / sp, ny = eb.velocity.y / sp;
                    g.lineStyle(1.5, data.activeIntent === 'ret' ? 0xff8888 : 0x6ee7ff, 0.55);
                    g.lineBetween(enemy.x, enemy.y, enemy.x + nx * 34, enemy.y + ny * 34);
                }
            }
        });
    }

    // ─── System One bridge ───
    private async querySystemOneModel() {
        if (this.enemies.getLength() === 0 || this.decisionInFlight) return;
        this.decisionInFlight = true;
        const t0 = performance.now();
        const hp01 = Math.max(0, this.playerHealth / this.maxHealth);
        const noise = (this.empActive ? 1.2 : 0) + this.god.noise + DIFF_AI[this.difficulty].noise;

        const state = {
            p: [Math.round(this.player.x), Math.round(this.player.y), +hp01.toFixed(2)],
            e: this.enemies.getChildren().map((e) => {
                const enemy = e as Phaser.Physics.Arcade.Sprite;
                const data = enemy.getData('ai') as EnemyData;
                const ex = this.empActive ? enemy.x + Phaser.Math.Between(-200, 200) : enemy.x;
                return [enemy.name, Math.round(ex), Math.round(enemy.y), +(data.health / data.maxHealth).toFixed(2)];
            }),
            proj: this.playerBullets.getLength() + this.enemyBullets.getLength(),
            noise: +noise.toFixed(2),
            diff: this.difficulty
        };
        const q: Record<string, string[] | string> = {};
        this.enemies.getChildren().forEach((e) => {
            const id = (e as Phaser.Physics.Arcade.Sprite).name;
            q[`${id}_t`] = TARGET_OPTS.slice();
            q[`${id}_m`] = MOVE_OPTS.slice();
            q[`${id}_s`] = 'noul';
        });

        if (!serverEnabled()) {
            // Hosted build: straight to the local twin, no failed fetches.
            if (this.aiOnline !== false) { this.aiOnline = false; this.events.emit('ai_status', false); }
            this.applyLocalBrain(state, 0.2);
            this.decisionInFlight = false;
            return;
        }

        try {
            const ctl = new AbortController();
            const timeout = window.setTimeout(() => ctl.abort(), 900);
            const res = await fetch(DECISION_URL, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ state, q }), signal: ctl.signal
            });
            window.clearTimeout(timeout);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            if (this.aiOnline !== true) { this.aiOnline = true; this.events.emit('ai_status', true); }
            this.events.emit('decision_latency', { ms: data.latency_ms ?? (performance.now() - t0), source: data.engine ?? 'server' });
            this.applyModelDecisions(data.a);
        } catch {
            if (this.aiOnline !== false) { this.aiOnline = false; this.events.emit('ai_status', false); }
            this.applyLocalBrain(state, performance.now() - t0);
        } finally {
            this.decisionInFlight = false;
        }
    }

    private applyModelDecisions(answers: Record<string, { c?: string; conf?: number; p?: Record<string, number>; n?: number }>) {
        if (!answers) return;
        this.enemies.getChildren().forEach((e) => {
            const enemy = e as Phaser.Physics.Arcade.Sprite;
            const data = enemy.getData('ai') as EnemyData;
            if (!data) return;
            const move = answers[`${enemy.name}_m`];
            const scalar = answers[`${enemy.name}_s`];
            if (typeof scalar?.n === 'number') enemy.setData('shootN', scalar.n);
            if (move?.c) {
                data.activeIntent = move.c;
                this.recordDecision(move.conf ?? 0.5);
                this.events.emit('decision_made', {
                    id: enemy.name, x: enemy.x, y: enemy.y,
                    action: move.c, confidence: move.conf ?? 0.5,
                    probabilities: move.p ?? {}, type: data.type, elite: data.elite
                });
            }
        });
    }

    private recordDecision(conf: number) {
        this.decisionCount++;
        this.confSum += conf;
        this.confN++;
        if (this.confN > 400) { // rolling window so "avg confidence" stays live
            this.confSum *= 0.5;
            this.confN = Math.floor(this.confN * 0.5);
        }
    }

    private buildBrainState(state: { p: number[]; e: unknown[][]; proj: number; noise: number }): BrainState {
        const bs: BrainState = {
            px: state.p[0], py: state.p[1], php01: state.p[2],
            enemies: (state.e as [string, number, number, number][]).map((r) => ({ id: String(r[0]), x: r[1], y: r[2], hp01: r[3] })),
            projCount: state.proj, noise: state.noise
        };
        this.brainState = bs;
        return bs;
    }

    private applyLocalBrain(state: { p: number[]; e: unknown[][]; proj: number; noise: number }, elapsedMs: number) {
        const s = this.buildBrainState(state);
        this.events.emit('decision_latency', { ms: Math.round(elapsedMs * 10) / 10, source: 'local-twin' });
        this.enemies.getChildren().forEach((e) => {
            const enemy = e as Phaser.Physics.Arcade.Sprite;
            const data = enemy.getData('ai') as EnemyData;
            if (!data) return;
            const r = scoreOptions(enemy.name, MOVE_OPTS, s, DIFF_AI[this.difficulty].gain);
            enemy.setData('shootN', shootUrgency(enemy.name, s));
            data.activeIntent = r.choice;
            this.recordDecision(r.conf);
            this.events.emit('decision_made', {
                id: enemy.name, x: enemy.x, y: enemy.y,
                action: r.choice, confidence: r.conf,
                probabilities: r.probs, type: data.type, elite: data.elite
            });
        });
    }
}
