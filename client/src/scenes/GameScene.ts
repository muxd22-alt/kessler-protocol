import * as Phaser from 'phaser';
import { scoreOptions, shootUrgency, DIFF_AI, type Difficulty } from '../ai/localBrain';
import { Sfx } from '../fx/sfx';
import { fetchTheme, themeFromSeed, serverEnabled, type Theme } from '../fx/theme';

// ──────────────────────────────────────────────────────────────────────────────
//  GAME SCENE — Kessler Protocol showcase
//  Two-tier AI: System One model sets strategic intent (~150 ms cadence);
//  Craig-Reynolds-style steering runs at 60 FPS. A local heuristic twin keeps
//  the demo intelligent when the decision server is offline.
// ──────────────────────────────────────────────────────────────────────────────

export type GamePhase = 'menu' | 'playing' | 'paused' | 'over';

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

    private starLayers: Phaser.GameObjects.Graphics[] = [];
    private starPoints: { x: number; y: number; s: number; a: number; c: number }[][] = [];
    private nebulas: Phaser.GameObjects.Image[] = [];
    private overlayGfx!: Phaser.GameObjects.Graphics; // hp bars + intent vectors
    private sfx = new Sfx();

    phase: GamePhase = 'menu';
    difficulty: Difficulty = 'normal';
    private theme: Theme = themeFromSeed((Math.random() * 999999) | 0);
    private keys: Record<string, Phaser.Input.Keyboard.Key> = {};
    private god: GodConfig = { spawnScale: 1, speedScale: 1, noise: 0 };

    private lastFired = 0;
    private decisionTimer = 0;
    private decisionInFlight = false;
    private aiOnline: boolean | null = null;

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

        this.buildStarfield();
        this.buildNebulas();
        void this.loadTheme(); // ask the LLM side for a look-from-a-number

        this.enemies = this.physics.add.group();
        this.playerBullets = this.physics.add.group();
        this.enemyBullets = this.physics.add.group();
        this.meteors = this.physics.add.group();
        this.overlayGfx = this.add.graphics().setDepth(6);

        // ─── Player ───
        const w = this.scale.width, h = this.scale.height;
        this.player = this.physics.add.sprite(w / 2, h - 110, 'player_ship');
        this.player.setScale(0.7).setDepth(10).setCollideWorldBounds(true);
        this.player.setTint(this.theme.player);
        this.playerHealth = this.maxHealth;

        this.add.particles(0, 0, 'dot', {
            speed: { min: 20, max: 70 }, angle: { min: 80, max: 100 },
            scale: { start: 0.5, end: 0 }, alpha: { start: 0.8, end: 0 },
            lifespan: 350, blendMode: 'ADD', follow: this.player,
            followOffset: { x: 0, y: 30 },             frequency: 30, tint: this.theme.exhaust
        }).setDepth(9);

        // ─── Input ───
        this.input.on('pointermove', (p: Phaser.Input.Pointer) => {
            if (this.phase !== 'playing' || !p.isDown) return;
            this.physics.moveToObject(this.player, { x: p.worldX, y: p.worldY }, 420);
        });
        this.input.on('pointerdown', (p: Phaser.Input.Pointer) => {
            this.sfx.unlock();
            if (this.phase !== 'playing') return;
            this.physics.moveToObject(this.player, { x: p.worldX, y: p.worldY }, 420);
        });
        this.input.on('pointerup', () => {
            if (this.phase === 'playing') this.player.setVelocity(0);
        });
        if (this.input.keyboard) {
            const kb = this.input.keyboard;
            this.keys = kb.addKeys('W,A,S,D,UP,DOWN,LEFT,RIGHT,SPACE,P,E,M,R,ENTER,ESC,T') as Record<string, Phaser.Input.Keyboard.Key>;
            kb.on('keydown-P', () => this.togglePause());
            kb.on('keydown-ESC', () => this.togglePause());
            kb.on('keydown-E', () => this.fireEMP());
            kb.on('keydown-T', () => this.remixTheme());
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

        this.scale.on('resize', () => this.buildStarfield());

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
        this.starPoints.forEach((pts) => pts.forEach((p) => {
            p.c = t.stars[(Math.random() * t.stars.length) | 0];
        }));
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
    private buildStarfield() {
        const w = this.scale.width, h = this.scale.height;
        this.starLayers.forEach((g) => g.destroy());
        this.starLayers = []; this.starPoints = [];
        for (let layer = 0; layer < STAR_LAYERS; layer++) {
            const g = this.add.graphics().setDepth(-10);
            this.starLayers.push(g);
            const pts: { x: number; y: number; s: number; a: number; c: number }[] = [];
            for (let i = 0; i < STAR_COUNT[layer]; i++) {
                pts.push({ x: Math.random() * w, y: Math.random() * h, s: 0.5 + Math.random() * (1.4 + layer), a: 0.25 + Math.random() * 0.6, c: this.theme.stars[(Math.random() * this.theme.stars.length) | 0] });
            }
            this.starPoints.push(pts);
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
        this.tweens.add({ targets: enemy, scale: scales[type] * (elite ? 1.25 : 1), duration: 350, ease: 'Back.easeOut' });
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
        m.setScale(0.35 + Math.random() * 0.3).setDepth(3);
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

        // Starfield always drifts (even in menus — alive backdrop).
        for (let layer = 0; layer < STAR_LAYERS; layer++) {
            const g = this.starLayers[layer];
            if (!g) continue;
            g.clear();
            const pts = this.starPoints[layer];
            const speedMul = this.phase === 'playing' ? 1 : 0.35;
            for (const p of pts) {
                p.y += STAR_SPEED[layer] * delta * 0.12 * speedMul;
                if (p.y > h) { p.y = 0; p.x = Math.random() * w; }
                const flicker = p.a + Math.sin(time * 0.003 + p.x) * 0.15;
                g.fillStyle(p.c, Math.max(0.05, Math.min(1, flicker)));
                g.fillCircle(p.x, p.y, p.s);
            }
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
        if (kx !== 0 || ky !== 0) {
            const len = Math.hypot(kx, ky);
            body.velocity.x = Phaser.Math.Linear(body.velocity.x, (kx / len) * 430, 0.35);
            body.velocity.y = Phaser.Math.Linear(body.velocity.y, (ky / len) * 430, 0.35);
        } else if (!this.input.activePointer.isDown) {
            body.velocity.x *= 0.9;
            body.velocity.y *= 0.9;
        }
        // Banking tilt
        this.player.setAngle(Phaser.Math.Clamp(body.velocity.x * 0.03, -18, 18));

        // ─── Player fire (hold pointer or SPACE) ───
        const firing = this.input.activePointer.isDown || this.keys.SPACE?.isDown;
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

        // Meteors vs enemies: rocks don't take sides.
        this.physics.overlap(this.meteors, this.enemies, (m, e) => {
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
        });

        // Cleanup
        const cleanup = (g: Phaser.Physics.Arcade.Group) => {
            g.getChildren().forEach((b) => {
                const s = b as Phaser.Physics.Arcade.Sprite;
                if (s.y < -40 || s.y > h + 40 || s.x < -40 || s.x > w + 40) s.destroy();
            });
        };
        cleanup(this.playerBullets);
        cleanup(this.enemyBullets);
        cleanup(this.meteors);

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
                this.events.emit('decision_made', {
                    id: enemy.name, x: enemy.x, y: enemy.y,
                    action: move.c, confidence: move.conf ?? 0.5,
                    probabilities: move.p ?? {}, type: data.type, elite: data.elite
                });
            }
        });
    }

    private applyLocalBrain(state: { p: number[]; e: unknown[][]; proj: number; noise: number }, elapsedMs: number) {
        const s = {
            px: state.p[0], py: state.p[1], php01: state.p[2],
            enemies: (state.e as [string, number, number, number][]).map((r) => ({ id: String(r[0]), x: r[1], y: r[2], hp01: r[3] })),
            projCount: state.proj, noise: state.noise
        };
        this.events.emit('decision_latency', { ms: Math.round(elapsedMs * 10) / 10, source: 'local-twin' });
        this.enemies.getChildren().forEach((e) => {
            const enemy = e as Phaser.Physics.Arcade.Sprite;
            const data = enemy.getData('ai') as EnemyData;
            if (!data) return;
            const r = scoreOptions(enemy.name, MOVE_OPTS, s, DIFF_AI[this.difficulty].gain);
            enemy.setData('shootN', shootUrgency(enemy.name, s));
            data.activeIntent = r.choice;
            this.events.emit('decision_made', {
                id: enemy.name, x: enemy.x, y: enemy.y,
                action: r.choice, confidence: r.conf,
                probabilities: r.probs, type: data.type, elite: data.elite
            });
        });
    }
}
