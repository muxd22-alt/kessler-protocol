import * as Phaser from 'phaser';
import { BootScene } from './scenes/BootScene';
import { GameScene } from './scenes/GameScene';
import { HUDScene } from './scenes/HUDScene';

const config: Phaser.Types.Core.GameConfig = {
    type: Phaser.AUTO,
    parent: 'game-container',
    width: window.innerWidth,
    height: window.innerHeight,
    backgroundColor: '#060612',
    disableContextMenu: true,
    render: { antialias: true, pixelArt: false, roundPixels: false },
    physics: {
        default: 'arcade',
        arcade: { gravity: { x: 0, y: 0 }, debug: false, fps: 60 }
    },
    scale: {
        mode: Phaser.Scale.RESIZE,
        autoCenter: Phaser.Scale.CENTER_BOTH
    },
    fps: { target: 60, smoothStep: true },
    scene: [BootScene, GameScene, HUDScene]
};

export const game = new Phaser.Game(config);

// Keep renderer sized on window/orientation change (RESIZE mode mostly
// handles this, but the explicit call fixes mobile browser chrome jumps).
window.addEventListener('resize', () => {
    game.scale.resize(window.innerWidth, window.innerHeight);
});
window.addEventListener('orientationchange', () => {
    window.setTimeout(() => game.scale.resize(window.innerWidth, window.innerHeight), 200);
});
