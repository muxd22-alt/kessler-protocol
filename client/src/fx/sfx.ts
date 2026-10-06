// Tiny WebAudio synth SFX — zero assets, game-feel on a budget.
// All sounds are short oscillator/noise blips through a shared gain node.

export class Sfx {
    private ctx: AudioContext | null = null;
    private master: GainNode | null = null;
    private lastPlay: Record<string, number> = {};
    enabled = true;

    private ensure(): boolean {
        if (!this.enabled) return false;
        try {
            if (!this.ctx) {
                const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
                this.ctx = new AC();
                this.master = this.ctx.createGain();
                this.master.gain.value = 0.16;
                this.master.connect(this.ctx.destination);
            }
            if (this.ctx.state === 'suspended') void this.ctx.resume();
            return true;
        } catch {
            return false;
        }
    }

    private gate(key: string, ms: number): boolean {
        const now = performance.now();
        if (now - (this.lastPlay[key] ?? 0) < ms) return false;
        this.lastPlay[key] = now;
        return true;
    }

    private blip(freqA: number, freqB: number, dur: number, type: OscillatorType = 'square', vol = 1) {
        if (!this.ensure() || !this.ctx || !this.master) return;
        const t = this.ctx.currentTime;
        const o = this.ctx.createOscillator();
        const g = this.ctx.createGain();
        o.type = type;
        o.frequency.setValueAtTime(freqA, t);
        o.frequency.exponentialRampToValueAtTime(Math.max(20, freqB), t + dur);
        g.gain.setValueAtTime(vol, t);
        g.gain.exponentialRampToValueAtTime(0.001, t + dur);
        o.connect(g).connect(this.master);
        o.start(t);
        o.stop(t + dur + 0.02);
    }

    private noise(dur: number, vol = 1, lowpass = 1200) {
        if (!this.ensure() || !this.ctx || !this.master) return;
        const t = this.ctx.currentTime;
        const len = Math.max(1, Math.floor(this.ctx.sampleRate * dur));
        const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
        const d = buf.getChannelData(0);
        for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
        const src = this.ctx.createBufferSource();
        src.buffer = buf;
        const f = this.ctx.createBiquadFilter();
        f.type = 'lowpass';
        f.frequency.value = lowpass;
        const g = this.ctx.createGain();
        g.gain.setValueAtTime(vol, t);
        g.gain.exponentialRampToValueAtTime(0.001, t + dur);
        src.connect(f).connect(g).connect(this.master);
        src.start(t);
    }

    unlock() { this.ensure(); }
    shoot() { if (this.gate('shoot', 70)) this.blip(880, 220, 0.09, 'square', 0.5); }
    enemyShoot() { if (this.gate('eshoot', 120)) this.blip(330, 120, 0.12, 'sawtooth', 0.4); }
    hit() { if (this.gate('hit', 60)) this.noise(0.12, 0.7, 2400); }
    explosion() { if (this.gate('expl', 90)) { this.noise(0.4, 1, 900); this.blip(160, 35, 0.35, 'sawtooth', 0.8); } }
    hurt() { if (this.gate('hurt', 200)) this.blip(220, 55, 0.3, 'sawtooth', 1); }
    emp() { if (this.gate('emp', 400)) { this.blip(1200, 60, 0.5, 'sine', 1); this.noise(0.5, 0.6, 3000); } }
    wave() { if (this.gate('wave', 400)) { this.blip(440, 660, 0.12, 'triangle', 0.8); window.setTimeout(() => this.blip(660, 880, 0.14, 'triangle', 0.8), 110); } }
    ui() { if (this.gate('ui', 50)) this.blip(660, 660, 0.05, 'sine', 0.5); }
    gameOver() { if (this.gate('over', 800)) { this.blip(330, 82, 0.7, 'sawtooth', 0.9); } }
}
