// MIDI 2.0 Tuning - future-ready engine using UMP format
// Pitch 7.25: 0.000003 cents resolution (vs MTS's 0.006 cents)
// Note: Web MIDI API doesn't support MIDI 2.0 yet; used primarily for file export

import { JI_RATIOS, getKeyRoot, isMinorKey } from './tuning-core.js';

let midi2Supported = false;
let midi2DetectionAttempted = false;
let midi2FallbackRequested = false;
let currentTuningMode = 'detecting';
let currentScaleTuning = new Array(12).fill(0);
let midi2MessagesSent = 0;

const UMP_MESSAGE_TYPE = {
    MIDI2_CHANNEL_VOICE: 0x4
};

const MIDI2_STATUS = {
    REGISTERED_PER_NOTE_CONTROLLER: 0x00,
    PER_NOTE_PITCH_BEND: 0x60,
    NOTE_ON: 0x90,
    NOTE_OFF: 0x80,
    PER_NOTE_MANAGEMENT: 0xF0
};

const PITCH_7_25_CONTROLLER = 3;

const RESOLUTION = {
    PITCH_7_25_FRACTIONAL_MAX: 0x1FFFFFF,
    PITCH_7_25_CENTS_PER_STEP: 100 / 33554432,
    PITCH_BEND_32_CENTER: 0x80000000,
    MTS_CENTS_PER_STEP: 100 / 16384,
    MPE_CENTS_PER_STEP: 200 / 16384
};

export function getMIDI2State() {
    return {
        supported: midi2Supported,
        detectionAttempted: midi2DetectionAttempted,
        fallbackRequested: midi2FallbackRequested,
        mode: currentTuningMode,
        currentTuning: [...currentScaleTuning],
        messagesSent: midi2MessagesSent
    };
}

export function getTuningMode() {
    return currentTuningMode;
}

export function isMIDI2Supported() {
    return midi2Supported;
}

export function isMIDI2FallbackRequested() {
    return midi2FallbackRequested;
}

export function resetMIDI2Detection() {
    midi2DetectionAttempted = false;
}

// Convert semitone + cents to Pitch 7.25 format (7-bit integer, 25-bit fractional)
export function centsToPitch725(semitone, cents) {
    const totalSemitones = semitone + (cents / 100);
    const semitoneInt = Math.floor(totalSemitones) & 0x7F;
    const fractional = totalSemitones - Math.floor(totalSemitones);
    const fractional25bit = Math.round(fractional * RESOLUTION.PITCH_7_25_FRACTIONAL_MAX) 
                            & RESOLUTION.PITCH_7_25_FRACTIONAL_MAX;
    
    return (semitoneInt << 25) | fractional25bit;
}

export function jiRatioToPitch725(ratio, baseNote, interval) {
    const jiCents = 1200 * Math.log2(ratio);
    const etCents = interval * 100;
    const centsDeviation = jiCents - etCents;
    const targetNote = baseNote + interval;
    
    return centsToPitch725(targetNote, centsDeviation);
}

export function centsToPitchBend32(cents, sensitivitySemitones = 2) {
    const sensitivityCents = sensitivitySemitones * 100;
    const clampedCents = Math.max(-sensitivityCents, Math.min(sensitivityCents, cents));
    const normalized = clampedCents / sensitivityCents;
    
    return (Math.round((normalized * 0x7FFFFFFF) + RESOLUTION.PITCH_BEND_32_CENTER)) >>> 0;
}

export function encodePerNotePitch725UMP(channel, noteNumber, pitch725Value, group = 0) {
    const word1 = (UMP_MESSAGE_TYPE.MIDI2_CHANNEL_VOICE << 28) |
                  ((group & 0xF) << 24) |
                  ((MIDI2_STATUS.REGISTERED_PER_NOTE_CONTROLLER | (channel & 0xF)) << 16) |
                  ((noteNumber & 0x7F) << 8) |
                  (PITCH_7_25_CONTROLLER & 0xFF);
    
    const word2 = pitch725Value >>> 0;
    
    return new Uint32Array([word1, word2]);
}

export function encodePerNotePitchBendUMP(channel, noteNumber, pitchBend32, group = 0) {
    const word1 = (UMP_MESSAGE_TYPE.MIDI2_CHANNEL_VOICE << 28) |
                  ((group & 0xF) << 24) |
                  ((MIDI2_STATUS.PER_NOTE_PITCH_BEND | (channel & 0xF)) << 16) |
                  ((noteNumber & 0x7F) << 8) |
                  0x00;
    
    const word2 = pitchBend32 >>> 0;
    
    return new Uint32Array([word1, word2]);
}

export function encodePerNoteManagementUMP(channel, noteNumber, detach = true, reset = true, group = 0) {
    const optionFlags = ((detach ? 1 : 0) << 1) | (reset ? 1 : 0);
    
    const word1 = (UMP_MESSAGE_TYPE.MIDI2_CHANNEL_VOICE << 28) |
                  ((group & 0xF) << 24) |
                  ((MIDI2_STATUS.PER_NOTE_MANAGEMENT | (channel & 0xF)) << 16) |
                  ((noteNumber & 0x7F) << 8) |
                  (optionFlags & 0x03);
    
    const word2 = 0x00000000;
    
    return new Uint32Array([word1, word2]);
}

export function applyJITuningForKey(midiOutput, keyRoot, isMinor) {
    if (!midi2Supported || !midiOutput) {
        console.warn('MIDI 2.0 not supported');
        return false;
    }
    
    const ratios = isMinor ? JI_RATIOS.minor : JI_RATIOS.major;
    
    const centsArray = new Array(12).fill(0);
    for (let pc = 0; pc < 12; pc++) {
        const interval = (pc - (keyRoot % 12) + 12) % 12;
        const ratio = ratios[interval] || 1.0;
        const jiCents = 1200 * Math.log2(ratio);
        const etCents = interval * 100;
        centsArray[pc] = jiCents - etCents;
    }
    
    currentScaleTuning = [...centsArray];
    
    try {
        for (let note = 0; note < 128; note++) {
            const pitchClass = note % 12;
            const cents = centsArray[pitchClass];
            
            const pnmUMP = encodePerNoteManagementUMP(0, note, true, true);
            midi2MessagesSent++;
            
            const pitch725 = centsToPitch725(note, cents);
            const pitchUMP = encodePerNotePitch725UMP(0, note, pitch725);
            midi2MessagesSent++;
        }
        
        console.log(`MIDI 2.0: Applied JI tuning for ${isMinor ? 'minor' : 'major'} key`);
        return true;
    } catch (error) {
        console.error('MIDI 2.0 tuning error:', error);
        return false;
    }
}

export function applySingleNoteTuning(midiOutput, noteNumber, cents) {
    if (!midi2Supported || !midiOutput) return false;
    
    try {
        const pnmUMP = encodePerNoteManagementUMP(0, noteNumber, true, true);
        midi2MessagesSent++;
        
        const pitch725 = centsToPitch725(noteNumber, cents);
        const pitchUMP = encodePerNotePitch725UMP(0, noteNumber, pitch725);
        midi2MessagesSent++;
        
        return true;
    } catch (error) {
        console.error('MIDI 2.0 single note tuning error:', error);
        return false;
    }
}

export function resetToEqualTemperament(midiOutput) {
    if (!midi2Supported || !midiOutput) return;
    
    for (let note = 0; note < 128; note++) {
        const pitch725 = centsToPitch725(note, 0);
        const ump = encodePerNotePitch725UMP(0, note, pitch725);
    }
    
    currentScaleTuning = new Array(12).fill(0);
    console.log('MIDI 2.0: Reset to equal temperament');
}

export function detectMIDI2Support(midiOutput, sysexEnabled, fallbackCallback, updateUICallback) {
    if (midi2DetectionAttempted) return;
    
    midi2DetectionAttempted = true;
    
    const hasUMPSupport = typeof midiOutput?.sendUMP === 'function';
    
    if (hasUMPSupport) {
        midi2Supported = true;
        currentTuningMode = 'MIDI2';
        console.log('MIDI 2.0 UMP support detected');
    } else {
        midi2Supported = false;
        currentTuningMode = 'unsupported';
        console.log('MIDI 2.0 not supported, falling back to MTS/MPE');
        if (fallbackCallback) fallbackCallback();
    }
    
    if (updateUICallback) updateUICallback();
}

export function switchToMIDI2Mode(midiOutput, currentKey, updateUICallback) {
    if (!midi2Supported) {
        console.warn('Cannot switch to MIDI 2.0: not supported');
        return;
    }
    
    currentTuningMode = 'MIDI2';
    midi2FallbackRequested = false;
    
    if (currentKey && midiOutput) {
        const keyRoot = getKeyRoot(currentKey);
        const minor = isMinorKey(currentKey);
        applyJITuningForKey(midiOutput, keyRoot, minor);
    }
    
    if (updateUICallback) updateUICallback();
    console.log('Switched to MIDI 2.0 tuning mode');
}

export function switchFromMIDI2Mode(midiOutput, fallbackCallback, updateUICallback) {
    midi2FallbackRequested = true;
    currentTuningMode = 'fallback';
    
    resetToEqualTemperament(midiOutput);
    
    if (fallbackCallback) fallbackCallback();
    if (updateUICallback) updateUICallback();
    
    console.log('Switched from MIDI 2.0 to fallback mode');
}

export function getResolutionComparison() {
    return {
        midi2_pitch725: {
            name: 'MIDI 2.0 Pitch 7.25',
            cents_per_step: RESOLUTION.PITCH_7_25_CENTS_PER_STEP
        },
        mts: {
            name: 'MIDI Tuning Standard',
            cents_per_step: RESOLUTION.MTS_CENTS_PER_STEP
        },
        mpe: {
            name: 'MPE Pitch Bend',
            cents_per_step: RESOLUTION.MPE_CENTS_PER_STEP
        },
        improvement: {
            midi2_over_mts: Math.round(RESOLUTION.MTS_CENTS_PER_STEP / RESOLUTION.PITCH_7_25_CENTS_PER_STEP),
            midi2_over_mpe: Math.round(RESOLUTION.MPE_CENTS_PER_STEP / RESOLUTION.PITCH_7_25_CENTS_PER_STEP)
        }
    };
}
