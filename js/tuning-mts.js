// MTS (MIDI Tuning Standard) - microtuning via SysEx messages
// Provides 0.006 cents resolution but requires SysEx permission and synth support

import { NOTE_NAMES } from './key-detection.js';
import { JI_RATIOS, getKeyRoot, isMinorKey, calculateScaleOctaveTuning } from './tuning-core.js';

let mtsSupported = false;
let mtsDetectionAttempted = false;
let mtsFallbackRequested = false;
let mtsLastSuccessTime = 0;
let mtsMessagesSent = 0;
let currentScaleOctaveTuning = new Array(12).fill(0);
let currentTuningMode = 'detecting';

export function getMTSState() {
    return {
        supported: mtsSupported,
        detectionAttempted: mtsDetectionAttempted,
        fallbackRequested: mtsFallbackRequested,
        lastSuccessTime: mtsLastSuccessTime,
        messagesSent: mtsMessagesSent,
        currentTuning: [...currentScaleOctaveTuning],
        mode: currentTuningMode
    };
}

export function getTuningMode() {
    return currentTuningMode;
}

export function isMTSSupported() {
    return mtsSupported;
}

export function isMTSFallbackRequested() {
    return mtsFallbackRequested;
}

export function resetMTSDetection() {
    mtsDetectionAttempted = false;
}

export function resetToEqualTemperament(midiOutput) {
    if (midiOutput && mtsSupported) {
        try {
            const equalTemp = new Array(12).fill(0);
            sendScaleOctaveTuning(midiOutput, equalTemp);
            console.log('Reset tuning to equal temperament');
        } catch (error) {
            console.warn('Could not reset MTS tuning:', error);
        }
    }
}

// Convert cents offset to MTS frequency data [semitone, fraction_MSB, fraction_LSB]
export function centsToMTSFrequencyData(baseMidiNote, centsOffset) {
    const totalCents = (baseMidiNote * 100) + centsOffset;
    const semitone = Math.floor(totalCents / 100);
    
    if (semitone < 0) return [0x00, 0x00, 0x00];
    if (semitone > 127) return [0x7F, 0x7F, 0x7E];
    
    let fractionCents = totalCents - (semitone * 100);
    fractionCents = Math.max(0, Math.min(99.9939, fractionCents));
    
    const fraction14bit = Math.round((fractionCents / 100) * 16383);
    const fractionClamped = Math.max(0, Math.min(16383, fraction14bit));
    
    const fractionMSB = (fractionClamped >> 7) & 0x7F;
    const fractionLSB = fractionClamped & 0x7F;
    
    return [semitone & 0x7F, fractionMSB, fractionLSB];
}

export function buildSingleNoteTuning(noteNumber, centsOffset) {
    const [semitone, fractionMSB, fractionLSB] = centsToMTSFrequencyData(noteNumber, centsOffset);
    
    return [
        0xF0, 0x7F, 0x7F, 0x08, 0x02, 0x00, 0x01,
        noteNumber & 0x7F,
        semitone, fractionMSB, fractionLSB,
        0xF7
    ];
}

export function buildMultiNoteTuning(noteChanges) {
    if (!noteChanges || noteChanges.length === 0) return null;
    
    const numChanges = Math.min(noteChanges.length, 127);
    const message = [0xF0, 0x7F, 0x7F, 0x08, 0x02, 0x00, numChanges];
    
    for (let i = 0; i < numChanges; i++) {
        const change = noteChanges[i];
        const [semitone, fractionMSB, fractionLSB] = centsToMTSFrequencyData(change.note, change.cents);
        message.push(change.note & 0x7F, semitone, fractionMSB, fractionLSB);
    }
    
    message.push(0xF7);
    return message;
}

// Scale/Octave Tuning (2-byte) - tunes all 12 pitch classes at once
export function buildScaleOctaveTuning2Byte(centsArray, channelMask = 'all') {
    if (!centsArray || centsArray.length !== 12) {
        console.error('Scale/Octave tuning requires exactly 12 cent values');
        return null;
    }
    
    let ff, gg, hh;
    if (channelMask === 'all') {
        ff = 0x03; gg = 0x7F; hh = 0x7F;
    } else if (Array.isArray(channelMask) && channelMask.length === 3) {
        [ff, gg, hh] = channelMask;
        ff = ff & 0x03;
    } else {
        ff = 0x03; gg = 0x7F; hh = 0x7F;
    }
    
    const message = [0xF0, 0x7F, 0x7F, 0x08, 0x09, ff, gg, hh];
    
    for (let i = 0; i < 12; i++) {
        const cents = centsArray[i];
        const clampedCents = Math.max(-100, Math.min(100, cents));
        const value14bit = Math.round(((clampedCents + 100) / 200) * 16383);
        const valueClamped = Math.max(0, Math.min(16383, value14bit));
        
        const msb = (valueClamped >> 7) & 0x7F;
        const lsb = valueClamped & 0x7F;
        message.push(msb, lsb);
    }
    
    message.push(0xF7);
    return message;
}

export function sendScaleOctaveTuning(midiOutput, centsArray) {
    if (!midiOutput) return { success: false, bytesSent: 0 };
    
    try {
        const message = buildScaleOctaveTuning2Byte(centsArray);
        if (!message) return { success: false, bytesSent: 0 };
        
        midiOutput.send(message);
        mtsMessagesSent++;
        mtsLastSuccessTime = Date.now();
        currentScaleOctaveTuning = [...centsArray];
        
        return { success: true, bytesSent: message.length };
    } catch (error) {
        console.error('Failed to send MTS Scale/Octave tuning:', error);
        return { success: false, bytesSent: 0 };
    }
}

export function applySingleNoteTuning(midiOutput, note, cents) {
    if (!midiOutput || !mtsSupported) return { success: false, bytesSent: 0 };
    
    try {
        const mtsMessage = buildSingleNoteTuning(note, cents);
        midiOutput.send(mtsMessage);
        mtsMessagesSent++;
        mtsLastSuccessTime = Date.now();
        return { success: true, bytesSent: mtsMessage.length };
    } catch (error) {
        console.warn('MTS tuning failed:', error);
        return { success: false, bytesSent: 0 };
    }
}

export function applyJITuningForKey(midiOutput, keyRoot, isMinor) {
    if (!midiOutput) return { success: false, bytesSent: 0 };
    
    const centsArray = calculateScaleOctaveTuning(keyRoot, isMinor);
    
    if (mtsSupported && !mtsFallbackRequested) {
        const result = sendScaleOctaveTuning(midiOutput, centsArray);
        if (result.success) {
            console.log(`MTS tuning applied for ${NOTE_NAMES[keyRoot % 12]}${isMinor ? 'm' : ''}`);
            return result;
        }
    }
    
    return { success: false, bytesSent: 0 };
}

export function detectMTSSupport(midiOutput, sysexEnabled, initMPE, updateDisplay) {
    if (!midiOutput || mtsDetectionAttempted) return;
    
    console.log('Initializing MTS tuning system...');
    mtsDetectionAttempted = true;
    
    if (!sysexEnabled) {
        console.warn('SysEx not enabled - MTS unavailable, using MPE');
        mtsSupported = false;
        mtsFallbackRequested = true;
        currentTuningMode = 'MPE';
        if (initMPE) initMPE();
        if (updateDisplay) updateDisplay();
        return;
    }
    
    const savedPreference = localStorage.getItem('tuningModePreference');
    if (savedPreference === 'MPE') {
        mtsFallbackRequested = true;
        mtsSupported = false;
        currentTuningMode = 'MPE';
        console.log('Using MPE mode (user preference)');
        if (initMPE) initMPE();
        if (updateDisplay) updateDisplay();
        return;
    }
    
    mtsSupported = true;
    currentTuningMode = 'MTS';
    console.log('MTS mode enabled');
    
    try {
        const equalTempTuning = new Array(12).fill(0);
        sendScaleOctaveTuning(midiOutput, equalTempTuning);
        mtsLastSuccessTime = Date.now();
        console.log('MTS initialization successful');
    } catch (error) {
        console.warn('MTS initialization failed, falling back to MPE:', error);
        mtsSupported = false;
        currentTuningMode = 'MPE';
        if (initMPE) initMPE();
    }
    
    if (updateDisplay) updateDisplay();
}

export function switchToMPEMode(midiOutput, initMPE, updateDisplay) {
    mtsSupported = false;
    mtsFallbackRequested = true;
    currentTuningMode = 'MPE';
    localStorage.setItem('tuningModePreference', 'MPE');
    console.log('Switched to MPE mode');
    
    if (updateDisplay) updateDisplay();
    if (midiOutput && initMPE) initMPE();
}

export function switchToMTSMode(midiOutput, sysexEnabled, currentKey, updateDisplay) {
    if (!sysexEnabled) {
        console.error('Cannot switch to MTS: SysEx permission not granted');
        alert('Cannot switch to MTS mode: SysEx permission is required.');
        return false;
    }
    
    mtsFallbackRequested = false;
    mtsSupported = true;
    currentTuningMode = 'MTS';
    localStorage.removeItem('tuningModePreference');
    console.log('Switched to MTS mode');
    
    const equalTemp = new Array(12).fill(0);
    sendScaleOctaveTuning(midiOutput, equalTemp);
    
    if (currentKey) {
        const keyRoot = getKeyRoot(currentKey);
        const isMinor = isMinorKey(currentKey);
        applyJITuningForKey(midiOutput, keyRoot, isMinor);
    }
    
    if (updateDisplay) updateDisplay();
    return true;
}

export function getTuningModeInfo() {
    return {
        mode: currentTuningMode,
        mtsSupported,
        mtsFallbackRequested,
        messagesSent: mtsMessagesSent,
        lastSuccess: mtsLastSuccessTime,
        currentTuning: currentScaleOctaveTuning
    };
}
