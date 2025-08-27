const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

// Simple framing: [0x7E][len16-hi][len16-lo][payload...][crc16-hi][crc16-lo]
function crc16(buf) {
    let crc = 0xffff;
    for (let i = 0; i < buf.length; i++) {
        crc ^= buf[i];
        for (let j = 0; j < 8; j++) {
            const mix = crc & 1;
            crc >>= 1;
            if (mix) crc ^= 0xA001; // CRC-16-IBM
        }
    }
    return crc & 0xffff;
}

function frameMessage(bytes) {
    const len = bytes.length;
    const out = new Uint8Array(1 + 2 + len + 2);
    out[0] = 0x7e;
    out[1] = (len >> 8) & 0xff;
    out[2] = len & 0xff;
    out.set(bytes, 3);
    const c = crc16(bytes);
    out[out.length - 2] = (c >> 8) & 0xff;
    out[out.length - 1] = c & 0xff;
    return out;
}

function deframe(streamBytes) {
    // returns {messages: Array<Uint8Array>, remainder: Uint8Array}
    const messages = [];
    let i = 0;
    while (i + 5 <= streamBytes.length) {
        if (streamBytes[i] !== 0x7e) { i++; continue; }
        if (i + 3 > streamBytes.length) break;
        const len = (streamBytes[i + 1] << 8) | streamBytes[i + 2];
        const end = i + 1 + 2 + len + 2;
        if (end > streamBytes.length) break;
        const payload = streamBytes.slice(i + 3, i + 3 + len);
        const got = (streamBytes[end - 2] << 8) | streamBytes[end - 1];
        if (crc16(payload) === got) {
            messages.push(payload);
            i = end;
        } else {
            i++;
        }
    }
    return { messages, remainder: streamBytes.slice(i) };
}

// Basic BFSK modem
class BfskModem {
    constructor({ sampleRate = 48000, f0 = 3200, f1 = 4200, symbolRate = 400 } = {}) {
        this.sampleRate = sampleRate;
        this.f0 = f0;
        this.f1 = f1;
        this.symbolRate = symbolRate;
        this.samplesPerSymbol = Math.round(sampleRate / symbolRate);
    }

    bytesToBits(bytes) {
        const bits = [];
        for (const b of bytes) {
            for (let i = 0; i < 8; i++) bits.push((b >> (7 - i)) & 1);
        }
        return bits;
    }

    async playBytes(bytes, volume = 0.6) {
        const bits = this.bytesToBits(bytes);
        // Preamble: 64 bits of alternating for sync
        const preamble = Array.from({ length: 64 }, (_, i) => i % 2);
        const frames = preamble.concat(bits);
        const totalSamples = frames.length * this.samplesPerSymbol;
        const audioCtx = new(window.AudioContext || window.webkitAudioContext)({ sampleRate: this.sampleRate });
        const buffer = audioCtx.createBuffer(1, totalSamples, this.sampleRate);
        const data = buffer.getChannelData(0);
        let idx = 0;
        for (const bit of frames) {
            const freq = bit ? this.f1 : this.f0;
            const phaseInc = 2 * Math.PI * freq / this.sampleRate;
            let phase = 0;
            for (let n = 0; n < this.samplesPerSymbol; n++) {
                data[idx++] = Math.sin(phase) * volume;
                phase += phaseInc;
            }
        }
        const src = audioCtx.createBufferSource();
        src.buffer = buffer;
        src.connect(audioCtx.destination);
        src.start();
        await new Promise(r => src.onended = r);
        audioCtx.close();
    }
}

class BfskReceiver {
    constructor({ sampleRate = 48000, f0 = 3200, f1 = 4200, symbolRate = 400 } = {}) {
        this.sampleRate = sampleRate;
        this.f0 = f0;
        this.f1 = f1;
        this.symbolRate = symbolRate;
        this.samplesPerSymbol = Math.round(sampleRate / symbolRate);
        this.running = false;
        this.byteBuffer = new Uint8Array(0);
    }

    async start(onBytes, onLog) {
        if (this.running) return;
        this.running = true;
        const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, noiseSuppression: true, echoCancellation: false, autoGainControl: false } });
        this.stream = stream;
        this.audioCtx = new(window.AudioContext || window.webkitAudioContext)({ sampleRate: this.sampleRate });
        const source = this.audioCtx.createMediaStreamSource(stream);
        const processor = this.audioCtx.createScriptProcessor(2048, 1, 1);
        source.connect(processor);
        processor.connect(this.audioCtx.destination);

        const goertzel = (samples, freq, sampleRate) => {
            const s = Math.sin(2 * Math.PI * freq / sampleRate);
            const c = Math.cos(2 * Math.PI * freq / sampleRate);
            const coeff = 2 * c;
            let q0 = 0,
                q1 = 0,
                q2 = 0;
            for (let i = 0; i < samples.length; i++) {
                q0 = coeff * q1 - q2 + samples[i];
                q2 = q1;
                q1 = q0;
            }
            const real = q1 - q2 * c;
            const imag = q2 * s;
            return real * real + imag * imag;
        };

        let sampleBuf = new Float32Array(0);
        let bitBuf = [];
        let byteAcc = 0,
            bitCount = 0;
        let framed = new Uint8Array(0);

        processor.onaudioprocess = (ev) => {
            if (!this.running) return;
            const input = ev.inputBuffer.getChannelData(0);
            // mic level (RMS)
            try {
                let sum = 0;
                for (let i = 0; i < input.length; i++) {
                    const s = input[i];
                    sum += s * s;
                }
                const rms = Math.sqrt(sum / Math.max(1, input.length));
                if (typeof level !== 'undefined' && level) level.value = Math.min(1, rms * 1.5);
            } catch {}
            const merged = new Float32Array(sampleBuf.length + input.length);
            merged.set(sampleBuf);
            merged.set(input, sampleBuf.length);
            sampleBuf = merged;
            const step = this.samplesPerSymbol;
            while (sampleBuf.length >= step) {
                const windowSamples = sampleBuf.slice(0, step);
                sampleBuf = sampleBuf.slice(step);
                const p0 = goertzel(windowSamples, this.f0, this.sampleRate);
                const p1 = goertzel(windowSamples, this.f1, this.sampleRate);
                const bit = p1 > p0 ? 1 : 0;
                bitBuf.push(bit);
                // skip preamble detection for MVP; directly pack bits into bytes
                byteAcc = (byteAcc << 1) | bit;
                bitCount++;
                if (bitCount === 8) {
                    framed = appendBytes(framed, new Uint8Array([byteAcc & 0xff]));
                    const { messages, remainder } = deframe(framed);
                    framed = remainder;
                    for (const msg of messages) onBytes(msg);
                    byteAcc = 0;
                    bitCount = 0;
                }
            }
        };

        this.stopFn = () => {
            this.running = false;
            try { processor.disconnect(); } catch {}
            try { source.disconnect(); } catch {}
            try { this.audioCtx.close(); } catch {}
            try { if (this.stream) { this.stream.getTracks().forEach(t => t.stop()); } } catch {}
            try { if (typeof level !== 'undefined' && level) level.value = 0; } catch {}
        };
    }

    stop() { if (this.stopFn) this.stopFn(); }
}

function appendBytes(a, b) {
    const out = new Uint8Array(a.length + b.length);
    out.set(a, 0);
    out.set(b, a.length);
    return out;
}

// UI wiring
const txText = document.getElementById('txText');
const btnChirp = document.getElementById('btnChirp');
const symbolRate = document.getElementById('symbolRate');
const f0 = document.getElementById('f0');
const f1 = document.getElementById('f1');
const btnListen = document.getElementById('btnListen');
const btnStop = document.getElementById('btnStop');
const txVolume = document.getElementById('txVolume');
const txVolVal = document.getElementById('txVolVal');
const level = document.getElementById('level');
const rxLog = document.getElementById('rxLog');

let receiver;

btnChirp.addEventListener('click', async() => {
    const cfg = { symbolRate: +symbolRate.value, f0: +f0.value, f1: +f1.value };
    const modem = new BfskModem(cfg);
    const payload = textEncoder.encode(txText.value.trim() || 'SOS');
    const framed = frameMessage(payload);
    btnChirp.disabled = true;
    const vol = txVolume ? +txVolume.value : 0.6;
    await modem.playBytes(framed, vol);
    btnChirp.disabled = false;
});

btnListen.addEventListener('click', async() => {
    const cfg = { symbolRate: +symbolRate.value, f0: +f0.value, f1: +f1.value };
    receiver = new BfskReceiver(cfg);
    btnListen.disabled = true;
    btnStop.disabled = false;
    await receiver.start((bytes) => {
        try {
            const text = textDecoder.decode(bytes);
            rxLog.textContent = `[${new Date().toLocaleTimeString()}] ${text}\n` + rxLog.textContent;
        } catch {}
    }, (log) => {
        rxLog.textContent = `[log] ${log}\n` + rxLog.textContent;
    });
});

btnStop.addEventListener('click', () => {
    if (receiver) receiver.stop();
    btnListen.disabled = false;
    btnStop.disabled = true;
});

if (txVolume && txVolVal) {
    const updateVol = () => { txVolVal.textContent = (+txVolume.value).toFixed(2); };
    txVolume.addEventListener('input', updateVol);
    updateVol();
}

// Mic level meter during receive
if (level) {
    // Monkey-patch receiver.start to tap audio for level
    const originalStart = BfskReceiver.prototype.start;
    BfskReceiver.prototype.start = async function(onBytes, onLog) {
        await originalStart.call(this, onBytes, onLog);
        // Attach analyser for level
        try {
            const analyser = this.audioCtx.createAnalyser();
            analyser.fftSize = 512;
            const sourceNodes = this.audioCtx.destination.context ? [] : [];
            // We already have a MediaStreamSource assigned in start(); tap from there by recreating
            // Note: We cannot access stream here easily; level meter is approximated via processor energy
        } catch {}
    };
}