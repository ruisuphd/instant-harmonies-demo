// Audio Engine - Web Audio playback with Salamander Grand Piano samples
// Supports pitch shifting for JI microtuning by adjusting playback rate

let audioContext = null;
let audioBuffers = {};
let activeNotes = {};
let samplesLoaded = false;
let loadingProgress = 0;

let sustainPedalDown = false;
let sustainedNotes = new Set();

// Salamander samples are spaced ~3 semitones apart for efficient coverage
const SALAMANDER_SAMPLES = [
    { midi: 21, name: 'A0' },
    { midi: 24, name: 'C1' }, { midi: 27, name: 'Ds1' }, { midi: 30, name: 'Fs1' }, { midi: 33, name: 'A1' },
    { midi: 36, name: 'C2' }, { midi: 39, name: 'Ds2' }, { midi: 42, name: 'Fs2' }, { midi: 45, name: 'A2' },
    { midi: 48, name: 'C3' }, { midi: 51, name: 'Ds3' }, { midi: 54, name: 'Fs3' }, { midi: 57, name: 'A3' },
    { midi: 60, name: 'C4' }, { midi: 63, name: 'Ds4' }, { midi: 66, name: 'Fs4' }, { midi: 69, name: 'A4' },
    { midi: 72, name: 'C5' }, { midi: 75, name: 'Ds5' }, { midi: 78, name: 'Fs5' }, { midi: 81, name: 'A5' },
    { midi: 84, name: 'C6' }, { midi: 87, name: 'Ds6' }, { midi: 90, name: 'Fs6' }, { midi: 93, name: 'A6' },
    { midi: 96, name: 'C7' }, { midi: 99, name: 'Ds7' }, { midi: 102, name: 'Fs7' }, { midi: 105, name: 'A7' },
    { midi: 108, name: 'C8' }
];

const CDN_BASE_URL = 'https://tonejs.github.io/audio/salamander/';

export async function initAudio() {
    if (!audioContext) {
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }
    
    if (!samplesLoaded) {
        console.log('Loading Salamander Grand Piano samples...');
        await loadPianoSamples();
    }
}

export function getAudioContext() {
    if (!audioContext) {
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }
    return audioContext;
}

export function areSamplesLoaded() {
    return samplesLoaded;
}

export function getLoadingProgress() {
    return loadingProgress;
}

async function loadPianoSamples() {
    const totalSamples = SALAMANDER_SAMPLES.length;
    let loadedCount = 0;
    
    const loadPromises = SALAMANDER_SAMPLES.map(async ({ midi, name }) => {
        try {
            const url = `${CDN_BASE_URL}${name}.mp3`;
            const response = await fetch(url);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            
            const arrayBuffer = await response.arrayBuffer();
            const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
            
            audioBuffers[midi] = audioBuffer;
            loadedCount++;
            loadingProgress = Math.round((loadedCount / totalSamples) * 100);
            
            console.log(`Loaded: ${name} (MIDI ${midi}) [${loadedCount}/${totalSamples}]`);
            return true;
        } catch (error) {
            console.warn(`Failed to load ${name}: ${error.message}`);
            return false;
        }
    });
    
    const results = await Promise.all(loadPromises);
    const successCount = results.filter(r => r).length;
    
    if (successCount > 0) {
        samplesLoaded = true;
        loadingProgress = 100;
        console.log(`Salamander Piano loaded: ${successCount}/${totalSamples} samples`);
    } else {
        console.error('Failed to load any piano samples');
    }
}

function findClosestSample(targetNote) {
    const loadedNotes = Object.keys(audioBuffers).map(Number);
    if (loadedNotes.length === 0) return null;
    
    let closest = loadedNotes[0];
    let minDistance = Math.abs(targetNote - closest);
    
    for (const sampleNote of loadedNotes) {
        const distance = Math.abs(targetNote - sampleNote);
        if (distance < minDistance) {
            minDistance = distance;
            closest = sampleNote;
        }
    }
    
    return closest;
}

export function playNote(note, velocity, pitchBend = 0) {
    if (!audioContext || !samplesLoaded) {
        console.warn('Audio not ready');
        return;
    }
    
    const closestSample = findClosestSample(note);
    if (closestSample === null) return;
    
    const buffer = audioBuffers[closestSample];
    if (!buffer) return;
    
    const source = audioContext.createBufferSource();
    const gainNode = audioContext.createGain();
    
    source.buffer = buffer;
    
    // Playback rate: transpose from sample note to target, then apply JI pitch adjustment
    const semitoneShift = note - closestSample;
    const basePlaybackRate = Math.pow(2, semitoneShift / 12);
    
    // Pitch bend range is ±2 semitones (±200 cents)
    const cents = (pitchBend / 8192) * 200;
    const jiMultiplier = Math.pow(2, cents / 1200);
    
    source.playbackRate.value = basePlaybackRate * jiMultiplier;
    gainNode.gain.value = (velocity / 127) * 0.8;
    
    source.connect(gainNode);
    gainNode.connect(audioContext.destination);
    source.start(0);
    
    if (!activeNotes[note]) activeNotes[note] = [];
    activeNotes[note].push({ source, gainNode });
}

export function stopNote(note) {
    if (!activeNotes[note] || !audioContext) return;
    
    const now = audioContext.currentTime;
    const releaseTime = 0.15;
    
    activeNotes[note].forEach(({ source, gainNode }) => {
        try {
            gainNode.gain.cancelScheduledValues(now);
            gainNode.gain.setValueAtTime(gainNode.gain.value, now);
            gainNode.gain.exponentialRampToValueAtTime(0.001, now + releaseTime);
            source.stop(now + releaseTime);
        } catch (error) {
            // Ignore errors from already stopped sources
        }
    });
    
    activeNotes[note] = [];
}

export function setSustainPedal(isDown) {
    const wasPedalDown = sustainPedalDown;
    sustainPedalDown = isDown;
    
    if (wasPedalDown && !sustainPedalDown) {
        releaseSustainedNotes();
    }
}

export function isSustainPedalDown() {
    return sustainPedalDown;
}

export function addSustainedNote(note) {
    sustainedNotes.add(note);
}

export function releaseSustainedNotes() {
    sustainedNotes.forEach(note => stopNote(note));
    sustainedNotes.clear();
}

export function reset() {
    sustainPedalDown = false;
    sustainedNotes.clear();
    
    for (const note of Object.keys(activeNotes)) {
        stopNote(parseInt(note));
    }
    activeNotes = {};
}

export function getState() {
    return {
        contextState: audioContext ? audioContext.state : 'not initialized',
        samplesLoaded,
        loadingProgress,
        sampleCount: Object.keys(audioBuffers).length,
        sustainPedalDown,
        sustainedNoteCount: sustainedNotes.size,
        activeNoteCount: Object.keys(activeNotes).length
    };
}
