import * as Phaser from 'phaser';

// Boot scene: branded loader with progress, tips, and missing-asset tolerance.
// All art is Kenney Space Shooter Extension (CC0).
export class BootScene extends Phaser.Scene {
    private progressGfx!: Phaser.GameObjects.Graphics;
    private progressText!: Phaser.GameObjects.Text;

    constructor() {
        super({ key: 'BootScene' });
    }

    preload() {
        const w = this.cameras.main.width;
        const h = this.cameras.main.height;
        this.cameras.main.setBackgroundColor('#060612');

        this.add.text(w / 2, h / 2 - 96, 'KESSLER PROTOCOL', {
            fontSize: '34px', fontFamily: '"Inter", "Segoe UI", sans-serif',
            color: '#7eb8ff', fontStyle: 'bold'
        }).setOrigin(0.5);

        this.add.text(w / 2, h / 2 - 60, 'EVERY ENEMY · ONE LOCAL AI MODEL · 60 FPS', {
            fontSize: '12px', fontFamily: '"Inter", monospace',
            color: '#445577'
        }).setOrigin(0.5);

        const tip = this.add.text(w / 2, h / 2 + 66, 'TIP: hold mouse / WASD to fly · SPACE to fire · E for EMP', {
            fontSize: '12px', fontFamily: '"Inter", monospace', color: '#5a6c8d', align: 'center'
        }).setOrigin(0.5);

        const barBg = this.add.graphics();
        barBg.fillStyle(0x1a1a2e, 1);
        barBg.fillRoundedRect(w / 2 - 160, h / 2 - 8, 320, 18, 9);

        this.progressGfx = this.add.graphics();
        this.progressText = this.add.text(w / 2, h / 2 + 32, '0%', {
            fontSize: '12px', fontFamily: '"Inter", monospace', color: '#7eb8ff'
        }).setOrigin(0.5);

        this.load.on('progress', (value: number) => {
            this.progressGfx.clear();
            this.progressGfx.fillStyle(0x3b82f6, 1);
            if (value > 0.01) this.progressGfx.fillRoundedRect(w / 2 - 157, h / 2 - 5, 314 * value, 12, 6);
            this.progressText.setText(`${Math.round(value * 100)}%`);
        });
        this.load.on('loaderror', (f: Phaser.Loader.File) => {
            // Never hard-crash the showcase on one missing PNG.
            // eslint-disable-next-line no-console
            console.warn('[boot] missing asset:', f.key, f.url);
        });
        tip.setAlpha(0.9);

        // --- Ships ---
        this.load.image('player_ship', 'assets/ships/spaceShips_001.png');
        this.load.image('enemy_fighter', 'assets/ships/spaceShips_004.png');
        this.load.image('enemy_bomber', 'assets/ships/spaceShips_007.png');
        this.load.image('enemy_support', 'assets/ships/spaceShips_006.png');

        // --- Projectiles ---
        this.load.image('laser_blue', 'assets/missiles/spaceMissiles_001.png');
        this.load.image('laser_red', 'assets/missiles/spaceMissiles_004.png');
        this.load.image('laser_green', 'assets/missiles/spaceMissiles_003.png');
        this.load.image('missile', 'assets/missiles/spaceMissiles_040.png');

        // --- Effects ---
        this.load.image('effect_fire', 'assets/effects/spaceEffects_004.png');
        this.load.image('effect_spark', 'assets/effects/spaceEffects_009.png');
        this.load.image('effect_shield', 'assets/effects/spaceEffects_015.png');
        this.load.image('effect_flash', 'assets/effects/spaceEffects_016.png');

        // --- Meteors ---
        this.load.image('meteor1', 'assets/meteors/spaceMeteors_001.png');
        this.load.image('meteor2', 'assets/meteors/spaceMeteors_002.png');
        this.load.image('meteor3', 'assets/meteors/spaceMeteors_003.png');
        this.load.image('meteor4', 'assets/meteors/spaceMeteors_004.png');
    }

    create() {
        // Soft radial nebula sprite generated once, reused by GameScene.
        const tex = this.textures.createCanvas('nebula');
        if (tex) {
            const c = tex.getContext();
            const g = c.createRadialGradient(128, 128, 8, 128, 128, 128);
            g.addColorStop(0, 'rgba(80,120,255,0.55)');
            g.addColorStop(0.45, 'rgba(90,60,220,0.22)');
            g.addColorStop(1, 'rgba(20,10,60,0)');
            c.fillStyle = g;
            c.fillRect(0, 0, 256, 256);
            tex.refresh();
        }
        // Soft round particle dot (crisper than stretched PNGs for thrusters).
        const dot = this.textures.createCanvas('dot');
        if (dot) {
            const c = dot.getContext();
            const g = c.createRadialGradient(16, 16, 1, 16, 16, 16);
            g.addColorStop(0, 'rgba(255,255,255,1)');
            g.addColorStop(0.4, 'rgba(255,255,255,0.5)');
            g.addColorStop(1, 'rgba(255,255,255,0)');
            c.fillStyle = g;
            c.fillRect(0, 0, 32, 32);
            dot.refresh();
        }
        this.scene.start('GameScene');
        this.scene.start('HUDScene');
    }
}
