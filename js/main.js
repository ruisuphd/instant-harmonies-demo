// Main - JI Tuning System orchestrator
// Handles MIDI device management, note processing, key detection, and tuning

import { keyDetector, NOTE_NAMES } from './key-detection.js';
import { getKeyRoot, isMinorKey, centsToPitchBend, pitchBendToCents, calculateJIPitchBend } from './tuning-core.js';
import * as mpe from './tuning-mpe.js';
import * as mts from './tuning-mts.js';
import * as audio from './audio-engine.js';
import * as recorder from './midi-recorder.js';
import * as latency from './latency-metrics.js';

let midiAccess = null;
let selectedInput = null;
let selectedOutput = null;
let isRunning = false;
let sysexEnabled = false;

// Key detection uses a sliding window - Temperley (1999) recommends 2 seconds
let keyDetectionBuffer = [];
const DETECTION_WINDOW = 2000;
const MIN_NOTES_FOR_DETECTION = 8;

let activeNoteStacks = {};
let nextNoteId = 1;

let predictiveJITable = {};
let predictiveTuningActive = false;
const predictiveSeenIds = new Set();
let backendHarmonicPrediction = null;
const BACKEND_HARMONIC_TTL_MS = 1500;

async function initMIDI() {
    try {
        midiAccess = await navigator.requestMIDIAccess({ sysex: true });
        console.log('MIDI Access obtained (SysEx enabled)');
        sysexEnabled = true;
        window.sysexEnabled = true;
        
        updateMIDIDevices();
        midiAccess.onstatechange = updateMIDIDevices;
        updateStatus('MIDI initialized (SysEx enabled)');
    } catch (sysexError) {
        console.warn('SysEx denied, trying without:', sysexError.message);
        
        try {
            midiAccess = await navigator.requestMIDIAccess();
            console.log('MIDI Access obtained (SysEx disabled)');
            sysexEnabled = false;
            window.sysexEnabled = false;
            
            updateMIDIDevices();
            midiAccess.onstatechange = updateMIDIDevices;
            updateStatus('MIDI initialized (MPE mode)');
        } catch (basicError) {
            console.error('Failed to get MIDI access:', basicError);
            updateStatus('Failed to initialize MIDI: ' + basicError.message);
        }
    }
}

// Sticky selection — persists across updateMIDIDevices() rebuilds even if the
// device temporarily disappears from midiAccess.inputs/outputs (USB sleep/wake,
// re-enumeration, state-change race). Only updated when the user makes a
// DELIBERATE selection via the dropdown, not by the rebuild itself.
//
// We store BOTH id and name. The id is the primary restore key (precise,
// survives dropdown rebuild as long as the device is still enumerated).
// The name is the fallback key used when the device has been re-enumerated
// with a new id (common after USB sleep/wake) — names typically stay stable
// e.g. "FP-10 MIDI In". The name MUST be captured at user-selection time;
// deriving it on-the-fly from the current device list at rebuild time is
// useless because the very case the fallback exists for is when the id
// is no longer in that list (so the lookup returns null).
let stickyInputId    = null;
let stickyInputName  = null;
let stickyOutputId   = null;
let stickyOutputName = null;

function captureStickyFromSelect(select) {
    if (!select || !select.value) return { id: null, name: null };
    const opt = select.options[select.selectedIndex];
    return { id: select.value, name: opt ? opt.textContent : null };
}

function rememberMidiSelection() {
    const inputSelect  = document.getElementById('midiInput');
    const outputSelect = document.getElementById('midiOutput');
    const inSel  = captureStickyFromSelect(inputSelect);
    const outSel = captureStickyFromSelect(outputSelect);
    if (inSel.id)  { stickyInputId  = inSel.id;  stickyInputName  = inSel.name  || stickyInputName; }
    if (outSel.id) { stickyOutputId = outSel.id; stickyOutputName = outSel.name || stickyOutputName; }
}

function updateMIDIDevices() {
    const inputSelect  = document.getElementById('midiInput');
    const outputSelect = document.getElementById('midiOutput');
    if (!inputSelect || !outputSelect) return;

    inputSelect.innerHTML  = '<option value="">Select MIDI Input...</option>';
    outputSelect.innerHTML = '<option value="">Select MIDI Output...</option>';

    for (const input of midiAccess.inputs.values()) {
        const option = document.createElement('option');
        option.value = input.id;
        option.textContent = input.name;
        inputSelect.appendChild(option);
    }
    for (const output of midiAccess.outputs.values()) {
        const option = document.createElement('option');
        option.value = output.id;
        option.textContent = output.name;
        outputSelect.appendChild(option);
    }

    // Restore sticky selection. Try exact id first; if the device was
    // re-enumerated and has a new id, fall back to a same-name match and
    // update the sticky id to the new one so subsequent rebuilds hit the
    // fast path. setStickyId writes back to the correct module-level
    // variable (input or output) depending on which select is being
    // restored.
    const tryRestore = (select, stickyId, stickyName, setStickyId) => {
        if (!stickyId) return;
        const opts = Array.from(select.options);
        if (opts.some(o => o.value === stickyId)) {
            select.value = stickyId;
            return;
        }
        if (stickyName) {
            const m = opts.find(o => o.textContent === stickyName);
            if (m) {
                select.value = m.value;
                setStickyId(m.value);
            }
        }
    };
    tryRestore(inputSelect,  stickyInputId,  stickyInputName,  id => { stickyInputId  = id; });
    tryRestore(outputSelect, stickyOutputId, stickyOutputName, id => { stickyOutputId = id; });
}

// Wire change events so the sticky captures user selection at the moment
// of deliberate change, not only inside updateMIDIDevices. Without this,
// if the user selects a device and an onstatechange fires before the
// sticky gets captured, the selection vanishes. Captures BOTH id and name
// so the name-fallback in updateMIDIDevices has something to fall back TO
// when the id stops matching after re-enumeration.
document.addEventListener('DOMContentLoaded', () => {
    const inSel  = document.getElementById('midiInput');
    const outSel = document.getElementById('midiOutput');
    if (inSel)  inSel.addEventListener('change',  () => {
        const c = captureStickyFromSelect(inSel);
        if (c.id)   stickyInputId   = c.id;
        if (c.name) stickyInputName = c.name;
    });
    if (outSel) outSel.addEventListener('change', () => {
        const c = captureStickyFromSelect(outSel);
        if (c.id)   stickyOutputId   = c.id;
        if (c.name) stickyOutputName = c.name;
    });
});

function startSystem() {
    const inputId = document.getElementById('midiInput').value;
    const outputId = document.getElementById('midiOutput').value;
    
    if (!inputId) {
        alert('Please select a MIDI input device');
        return;
    }
    
    selectedInput = midiAccess.inputs.get(inputId);
    selectedOutput = outputId ? midiAccess.outputs.get(outputId) : null;
    
    selectedInput.onmidimessage = handleMIDIMessage;
    
    resetPredictiveState();
    resetNoteTracking();
    clearBackendHarmonicPrediction();
    mpe.resetMPEState();
    keyDetector.reset();
    keyDetectionBuffer = [];
    
    const outputMode = document.querySelector('input[name="outputMode"]:checked').value;
    if (outputMode === 'internal') {
        audio.initAudio();
    }
    
    if (outputMode === 'external' && selectedOutput) {
        // If the user opted in to "local control off" (typical when the MIDI
        // output is the same keyboard they're playing on, e.g. Roland FP-10),
        // tell the keyboard to stop playing from its own keybed directly so we
        // avoid the doubled-sound artefact where the keyboard plays the
        // untuned note AND also receives our tuned MIDI, resulting in a
        // chorus/"echoey" effect. CC 122 = Local Control; data 0 = OFF.
        // (2026-04-19 fix for "MPE sounds echoey on FP-10 own speaker" feedback.)
        const localOffCheckbox = document.getElementById('localControlOff');
        if (localOffCheckbox && localOffCheckbox.checked) {
            console.log('Sending Local Control Off (CC 122, 0) on all 16 channels...');
            for (let ch = 0; ch < 16; ch++) {
                selectedOutput.send([0xB0 | ch, 122, 0]);
            }
        }

        mts.detectMTSSupport(
            selectedOutput,
            sysexEnabled,
            () => mpe.initializePitchBendRange(selectedOutput),
            updateTuningModeDisplay
        );

        if (!mts.isMTSSupported()) {
            mpe.initializePitchBendRange(selectedOutput);
        }
    }

    isRunning = true;
    document.getElementById('startButton').disabled = true;
    document.getElementById('stopButton').disabled = false;
    
    updateStatus('System running - play some notes');
    updateKeyDisplay('Listening...', '', 'Source: score-free baseline');
    
    if (outputMode === 'external') {
        updateTuningModeDisplay();
    }
}

function stopSystem() {
    if (selectedInput) {
        selectedInput.onmidimessage = null;
    }
    
    isRunning = false;
    keyDetectionBuffer = [];
    keyDetector.reset();
    clearBackendHarmonicPrediction();
    resetNoteTracking();
    mpe.resetMPEState();
    audio.reset();
    
    if (selectedOutput) {
        mts.resetToEqualTemperament(selectedOutput);
        // Restore Local Control ON so the user's keyboard plays normally
        // after the demo ends. Symmetric with the CC 122, 0 sent in startSystem.
        const localOffCheckbox = document.getElementById('localControlOff');
        if (localOffCheckbox && localOffCheckbox.checked) {
            for (let ch = 0; ch < 16; ch++) {
                selectedOutput.send([0xB0 | ch, 122, 127]);
            }
        }
    }

    mts.resetMTSDetection();
    
    document.getElementById('startButton').disabled = false;
    document.getElementById('stopButton').disabled = true;
    
    updateStatus('System stopped');
    updateKeyDisplay('Stopped', '', 'Source: ensemble detection');
    updateTuningModeDisplay();
    
    resetPredictiveState();
}

function handleMIDIMessage(message) {
    const [status, data1, data2] = message.data;
    const channel = status & 0x0F;
    const command = status & 0xF0;
    const hardwareTimestamp = message.timeStamp;
    
    if (command === 0x90 && data2 > 0) {
        if (window.handleNoteOn) {
            window.handleNoteOn(data1, data2, channel, hardwareTimestamp);
        } else {
            handleNoteOn(data1, data2, channel, hardwareTimestamp);
        }
    }
    else if (command === 0x80 || (command === 0x90 && data2 === 0)) {
        handleNoteOff(data1, channel);
    }
    else if (command === 0xB0) {
        handleControlChange(data1, data2, channel);
    }
}

function handleNoteOn(note, velocity, channel, hardwareTimestamp = null) {
    latency.startMeasurement(hardwareTimestamp);
    latency.setNoteNumber(note);
    
    const now = Date.now();
    const noteId = `${nextNoteId++}_${note}`;
    
    if (!activeNoteStacks[note]) {
        activeNoteStacks[note] = [];
    }
    activeNoteStacks[note].push(noteId);
    
    keyDetectionBuffer.push({ note, time: now, velocity });
    keyDetectionBuffer = keyDetectionBuffer.filter(n => now - n.time < DETECTION_WINDOW);
    
    let keyDetectionRan = false;
    if (keyDetectionBuffer.length >= MIN_NOTES_FOR_DETECTION) {
        keyDetectionRan = true;
        const sensitivity = document.getElementById('sensitivity')?.value || 'medium';
        const activeNotes = Object.keys(activeNoteStacks).map(Number);
        const result = keyDetector.detectKey(keyDetectionBuffer, sensitivity, { activeNotes });
        
        if (result) {
            const twoStageClient = window.twoStageClient;
            const systemState = twoStageClient ? twoStageClient.systemState : 'no_client';
            const scoreFollowingActive = systemState === 'following' || systemState === 'score_following_active';
            
            if (!scoreFollowingActive) {
                updateKeyDisplay(
                    result.key,
                    `Confidence: ${result.confidence}%${result.agreementText ? ` (${result.agreementText})` : ''}`,
                    'Source: causal ensemble baseline'
                );
                updateStatus(`Key changed to ${result.key} (causal ensemble)`);
                
                const outputMode = document.querySelector('input[name="outputMode"]:checked')?.value;
                if (outputMode === 'external' && mts.isMTSSupported() && !mts.isMTSFallbackRequested()) {
                    const keyRoot = getKeyRoot(result.key);
                    const isMinor = isMinorKey(result.key);
                    mts.applyJITuningForKey(selectedOutput, keyRoot, isMinor);
                }
            }
        }
    }
    
    latency.markKeyDetectionDone(keyDetectionRan);
    
    const tunedNote = applyTuning(note, velocity, channel);
    tunedNote.noteId = noteId;
    
    latency.markTuningCalculated();
    
    forwardNote(tunedNote, channel, true);
    
    if (recorder.isRecording()) {
        const keyInfo = getCurrentKeyInfo();
        recorder.recordNoteOn(note, velocity, channel, keyInfo);
    }
}

function getActiveBackendHarmonicPrediction() {
    const twoStageClient = window.twoStageClient;
    const systemState = twoStageClient?.systemState;
    const scoreFollowingActive = systemState === 'following' || systemState === 'score_following_active';
    if (scoreFollowingActive || !backendHarmonicPrediction) {
        return null;
    }

    if ((Date.now() - backendHarmonicPrediction.receivedAtMs) > BACKEND_HARMONIC_TTL_MS) {
        return null;
    }

    return backendHarmonicPrediction;
}

function clearBackendHarmonicPrediction() {
    backendHarmonicPrediction = null;
}

function getCurrentKeyInfo() {
    const twoStageClient = window.twoStageClient;
    const systemState = twoStageClient?.systemState;
    const scoreFollowingActive = systemState === 'following' || systemState === 'score_following_active';
    
    if (scoreFollowingActive && window._lastMusicXMLKey) {
        return {
            key: window._lastMusicXMLKey,
            isMinor: window._lastMusicXMLIsMinor || false,
            source: 'musicxml'
        };
    }

    const backendPrediction = getActiveBackendHarmonicPrediction();
    if (backendPrediction) {
        return {
            key: backendPrediction.key,
            isMinor: backendPrediction.key.includes('m'),
            source: 'harmonic_context_model',
            confidence: backendPrediction.confidence
        };
    }
    
    const currentKey = keyDetector.getCurrentKey();
    if (currentKey) {
        return {
            key: currentKey,
            isMinor: currentKey.includes('m'),
            source: 'causal_ensemble'
        };
    }
    
    return null;
}

function handleNoteOff(note, channel) {
    let noteId = null;
    if (activeNoteStacks[note] && activeNoteStacks[note].length > 0) {
        noteId = activeNoteStacks[note].pop();
        if (activeNoteStacks[note].length === 0) {
            delete activeNoteStacks[note];
        }
    }
    
    if (recorder.isRecording()) {
        recorder.recordNoteOff(note, channel);
    }
    
    const outputMode = document.querySelector('input[name="outputMode"]:checked').value;
    
    if (outputMode === 'internal' && audio.isSustainPedalDown()) {
        audio.addSustainedNote(note);
    } else {
        forwardNote({ note, velocity: 0, noteId }, channel, false);
    }
}

function handleControlChange(controller, value, channel) {
    if (recorder.isRecording()) {
        recorder.recordCC(controller, value, channel);
    }
    
    if (controller === 64) {
        const outputMode = document.querySelector('input[name="outputMode"]:checked').value;
        
        if (outputMode === 'internal') {
            audio.setSustainPedal(value >= 64);
        }
        
        if (outputMode === 'external' && selectedOutput) {
            selectedOutput.send([0xB0 | channel, controller, value]);
        }
    }
}

function applyTuning(note, velocity, channel) {
    const queue = predictiveJITable?.[note];
    if (predictiveTuningActive && queue?.length > 0) {
        const entry = queue.shift();
        
        const PREDICTION_STALENESS_THRESHOLD = 60000;
        if (entry?.timestamp) {
            const age = Date.now() - (entry.timestamp * 1000);
            if (age > PREDICTION_STALENESS_THRESHOLD) {
                console.warn(`Discarding stale prediction for note ${note}`);
                if (entry?.note_id) predictiveSeenIds.delete(entry.note_id);
                if (queue.length === 0) delete predictiveJITable[note];
                predictiveTuningActive = Object.values(predictiveJITable).some(q => q?.length > 0);
            } else {
                return applyPredictiveTuning(entry, note, velocity, queue);
            }
        } else {
            return applyPredictiveTuning(entry, note, velocity, queue);
        }
    }
    
    const twoStageClient = window.twoStageClient;
    const systemState = twoStageClient ? twoStageClient.systemState : 'no_client';
    const scoreFollowingActive = systemState === 'following' || systemState === 'score_following_active';
    
    let currentKey;
    if (scoreFollowingActive && window._lastMusicXMLKey) {
        currentKey = window._lastMusicXMLKey;
    } else {
        currentKey = getActiveBackendHarmonicPrediction()?.key || keyDetector.getCurrentKey();
    }
    
    if (!currentKey) {
        return { note, velocity, pitchBend: 0 };
    }
    
    const pitchBend = calculateJIPitchBend(note, currentKey);
    return { note, velocity, pitchBend };
}

function applyPredictiveTuning(entry, note, velocity, queue) {
    if (entry?.note_id) predictiveSeenIds.delete(entry.note_id);
    if (queue.length === 0) delete predictiveJITable[note];
    predictiveTuningActive = Object.values(predictiveJITable).some(q => q?.length > 0);
    
    let centsDeviation = null;
    if (entry?.cents != null && typeof entry.cents === 'number') {
        centsDeviation = entry.cents;
    } else if (entry?.ratio != null && typeof entry.ratio === 'number') {
        centsDeviation = 1200 * Math.log2(entry.ratio);
    } else if (typeof entry === 'number') {
        centsDeviation = 1200 * Math.log2(entry);
    }
    
    if (centsDeviation != null) {
        const pitchBend = centsToPitchBend(centsDeviation);
        return { note, velocity, pitchBend };
    }
    
    return { note, velocity, pitchBend: 0 };
}

function forwardNote(noteData, channel, isNoteOn) {
    const outputMode = document.querySelector('input[name="outputMode"]:checked').value;
    
    if (outputMode === 'external' && selectedOutput) {
        forwardNoteExternal(noteData, channel, isNoteOn);
    } else if (outputMode === 'internal') {
        if (isNoteOn) {
            audio.playNote(noteData.note, noteData.velocity, noteData.pitchBend || 0);
            latency.completeMeasurement('Internal', { bytesSent: 0 });
        } else {
            audio.stopNote(noteData.note);
        }
    }
}

function forwardNoteExternal(noteData, channel, isNoteOn) {
    let outputChannel = channel;
    const pitchBendValue = typeof noteData.pitchBend === 'number' ? noteData.pitchBend : 0;
    let mtsResult = { success: false, bytesSent: 0 };
    const usingMTS = mts.isMTSSupported();
    
    let totalBytesSent = 0;
    let mtsSubMode = null;
    
    if (!usingMTS) {
        if (!mpe.isPitchBendRangeInitialized() && isNoteOn) {
            mpe.initializePitchBendRange(selectedOutput);
        }

        if (isNoteOn) {
            // F1 fix (2026-04-19): pass pitch so voice-stealing can emit a proper
            // note-off for the stolen note (previously the stolen note hung
            // silently on the synth, causing the "MPE sounds off" complaint).
            const allocationResult = mpe.allocateChannel(noteData.noteId, noteData.note);
            if (allocationResult !== null && typeof allocationResult !== 'undefined') {
                if (typeof allocationResult === 'object' && allocationResult.channel !== undefined) {
                    // Voice stealing happened. Emit a note-off for the STOLEN pitch on this
                    // channel BEFORE the new note-on, so the synth doesn't hang the old note.
                    if (typeof allocationResult.stolenPitch === 'number') {
                        selectedOutput.send([0x80 | allocationResult.channel, allocationResult.stolenPitch, 0]);
                        totalBytesSent += 3;
                    }
                    // Reset pitch bend on the reused channel
                    totalBytesSent += mpe.sendPitchBend(selectedOutput, allocationResult.channel, 0);
                    outputChannel = allocationResult.channel;
                } else if (typeof allocationResult === 'number') {
                    outputChannel = allocationResult;
                }
            } else {
                console.warn(`Cannot send note ${noteData.note} - all MPE channels exhausted`);
                latency.cancelMeasurement();
                return;
            }
        } else if (noteData.noteId) {
            const ch = mpe.getChannelForNote(noteData.noteId);
            if (ch === null) {
                // F1 fix: the note was voice-stolen earlier, so the synth no
                // longer holds it on any known channel. Silently skip the output
                // — sending note-off to a wrong channel would kill the wrong note.
                latency.cancelMeasurement();
                return;
            }
            outputChannel = ch;
        }
    }
    
    if (isNoteOn && pitchBendValue !== 0 && usingMTS) {
        const cents = pitchBendToCents(pitchBendValue);
        mtsResult = mts.applySingleNoteTuning(selectedOutput, noteData.note, cents);
        if (mtsResult.success) {
            totalBytesSent += mtsResult.bytesSent;
            mtsSubMode = 'single_note';
        }
    }
    
    if (!usingMTS) {
        totalBytesSent += mpe.sendPitchBend(selectedOutput, outputChannel, pitchBendValue);
    } else if (isNoteOn && !mtsResult.success && pitchBendValue !== 0) {
        totalBytesSent += mpe.sendPitchBend(selectedOutput, outputChannel, pitchBendValue);
    }
    
    const status = isNoteOn ? (0x90 | outputChannel) : (0x80 | outputChannel);
    selectedOutput.send([status, noteData.note, noteData.velocity || 0]);
    totalBytesSent += 3;
    
    if (isNoteOn) {
        latency.completeMeasurement(usingMTS ? 'MTS' : 'MPE', {
            bytesSent: totalBytesSent,
            mtsSubMode: mtsSubMode
        });
    }
    
    if (!isNoteOn && !usingMTS) {
        mpe.sendPitchBend(selectedOutput, outputChannel, 0);
        mpe.releaseChannel(noteData.noteId);
    }
}

function resetPredictiveState() {
    predictiveJITable = {};
    predictiveTuningActive = false;
    predictiveSeenIds.clear();
}

function resetNoteTracking() {
    activeNoteStacks = {};
    nextNoteId = 1;
}

function updateStatus(message) {
    const statusElement = document.getElementById('detectionStatus');
    if (!statusElement) return;
    
    const outputMode = document.querySelector('input[name="outputMode"]:checked')?.value;
    
    if (outputMode === 'external' && mts.getTuningMode() !== 'detecting' && isRunning) {
        const modeText = mts.getTuningMode() === 'MTS' ? 'MTS (High Precision)' : 'MPE (Pitch Bend)';
        statusElement.textContent = `Status: ${message} | Tuning: ${modeText}`;
    } else {
        statusElement.textContent = `Status: ${message}`;
    }
}

function updateKeyDisplay(key, confidence, methodText = null) {
    const keyNameEl = document.getElementById('keyName');
    const keyConfEl = document.getElementById('keyConfidence');
    const keyMethodEl = document.getElementById('keyMethod');
    if (keyNameEl) keyNameEl.textContent = key;
    if (keyConfEl) keyConfEl.textContent = confidence;
    if (keyMethodEl && methodText) keyMethodEl.textContent = methodText;
}

function updateTuningModeDisplay() {
    const statusElement = document.getElementById('detectionStatus');
    const tuningMode = mts.getTuningMode();
    
    if (statusElement) {
        const modeText = tuningMode === 'MTS' 
            ? 'MTS (Scale/Octave 2-byte)' 
            : tuningMode === 'MPE' 
            ? 'MPE (Per-Channel Pitch Bend)' 
            : 'Detecting...';
        
        const currentText = statusElement.textContent;
        if (currentText.includes('Status:')) {
            const baseStatus = currentText.split('|')[0].trim();
            statusElement.textContent = `${baseStatus} | Tuning: ${modeText}`;
        }
    }
    
    const tuningModeIndicator = document.getElementById('tuningModeIndicator');
    if (tuningModeIndicator) {
        tuningModeIndicator.textContent = tuningMode === 'MTS' ? 'MTS' : 'MPE';
        tuningModeIndicator.className = `tuning-mode-badge ${tuningMode.toLowerCase()}`;
    }
    
    const sysexStatus = document.getElementById('sysexStatus');
    if (sysexStatus) {
        if (sysexEnabled) {
            sysexStatus.textContent = 'SysEx enabled';
            sysexStatus.style.color = 'green';
        } else {
            sysexStatus.textContent = 'SysEx disabled';
            sysexStatus.style.color = 'red';
        }
    }
    
    const sysexHelp = document.getElementById('sysexHelp');
    if (sysexHelp) {
        if (!sysexEnabled) {
            sysexHelp.innerHTML = 'SysEx permission denied - MTS unavailable. Using MPE mode.';
            sysexHelp.style.color = 'olive';
        } else if (tuningMode === 'MTS') {
            sysexHelp.innerHTML = 'If tuning sounds incorrect, switch to MPE mode.';
            sysexHelp.style.color = 'gray';
        } else {
            sysexHelp.innerHTML = 'MPE mode active. Click "Use MTS" to try MTS tuning.';
            sysexHelp.style.color = 'gray';
        }
    }
    
    const mtsButton = document.getElementById('switchToMTS');
    const mpeButton = document.getElementById('switchToMPE');
    if (mtsButton) mtsButton.disabled = tuningMode === 'MTS' || !sysexEnabled;
    if (mpeButton) mpeButton.disabled = tuningMode === 'MPE';
}

function panicStop() {
    if (selectedOutput) {
        for (let channel = 0; channel < 16; channel++) {
            selectedOutput.send([0xB0 | channel, 123, 0]);
        }
    }
    
    keyDetectionBuffer = [];
    audio.reset();
    updateStatus('All notes stopped');
}

// Global exports
window.startSystem = startSystem;
window.stopSystem = stopSystem;
window.panicStop = panicStop;

window.switchToMTSMode = function() {
    mts.switchToMTSMode(
        selectedOutput,
        sysexEnabled,
        getCurrentKeyInfo()?.key || keyDetector.getCurrentKey(),
        updateTuningModeDisplay
    );
};

window.switchToMPEMode = function() {
    mts.switchToMPEMode(
        selectedOutput, 
        () => mpe.initializePitchBendRange(selectedOutput),
        updateTuningModeDisplay
    );
    mpe.resetMPEState();
};

// Called by two-stage server for predictive JI tuning from score following
window.applyJITuning = function(ratioTable) {
    if (!ratioTable || Object.keys(ratioTable).length === 0) {
        resetPredictiveState();
        return;
    }
    
    let musicXMLKey = null;
    let musicXMLIsMinor = false;
    
    Object.entries(ratioTable).forEach(([pitch, entries]) => {
        if (!Array.isArray(entries)) entries = [entries];
        entries.forEach((entry) => {
            if (!entry || typeof entry.note_id === 'undefined') return;
            if (predictiveSeenIds.has(entry.note_id)) return;
            
            predictiveSeenIds.add(entry.note_id);
            if (!predictiveJITable[pitch]) predictiveJITable[pitch] = [];
            predictiveJITable[pitch].push(entry);
            
            if (entry.source === 'musicxml_key_signature' && entry.key) {
                musicXMLKey = entry.key;
                musicXMLIsMinor = entry.is_minor || false;
            }
        });
    });
    
    predictiveTuningActive = Object.values(predictiveJITable).some((queue) => queue && queue.length > 0);
    
    if (musicXMLKey) {
        if (musicXMLKey !== window._lastMusicXMLKey) {
            window._lastMusicXMLKey = musicXMLKey;
            window._lastMusicXMLIsMinor = musicXMLIsMinor;
            console.log(`MusicXML key stored: ${musicXMLKey} (${musicXMLIsMinor ? 'minor' : 'major'})`);
        }
    }
    
    if (musicXMLKey && predictiveTuningActive) {
        const outputMode = document.querySelector('input[name="outputMode"]:checked')?.value;
        if (outputMode === 'external' && selectedOutput && mts.isMTSSupported() && !mts.isMTSFallbackRequested()) {
            const keyRoot = getKeyRoot(musicXMLKey);
            console.log(`MTS tuning applied for ${musicXMLKey} (from MusicXML)`);
            mts.applyJITuningForKey(selectedOutput, keyRoot, musicXMLIsMinor);
        }
    }
};

window.applyBackendHarmonicPrediction = function(prediction) {
    if (!prediction || !prediction.key) {
        return;
    }

    const previousKey = backendHarmonicPrediction?.key;
    backendHarmonicPrediction = {
        ...prediction,
        receivedAtMs: Date.now()
    };

    const twoStageClient = window.twoStageClient;
    const systemState = twoStageClient?.systemState;
    const scoreFollowingActive = systemState === 'following' || systemState === 'score_following_active';
    if (scoreFollowingActive) {
        return;
    }

    const confidencePercent = Number(prediction.confidence) * 100;
    const confidenceText = Number.isFinite(confidencePercent)
        ? `Confidence: ${confidencePercent.toFixed(1)}%`
        : '';
    updateKeyDisplay(prediction.key, confidenceText, 'Source: backend harmonic model');

    if (previousKey !== prediction.key) {
        updateStatus(`Key changed to ${prediction.key} (backend harmonic model)`);

        const outputMode = document.querySelector('input[name="outputMode"]:checked')?.value;
        if (outputMode === 'external' && selectedOutput && mts.isMTSSupported() && !mts.isMTSFallbackRequested()) {
            mts.applyJITuningForKey(selectedOutput, getKeyRoot(prediction.key), isMinorKey(prediction.key));
        }
    }
};

window.clearBackendHarmonicPrediction = clearBackendHarmonicPrediction;

window.handleNoteOn = handleNoteOn;
window.keyDetector = keyDetector;
window.midiRecorder = recorder;

window.showLatencyStats = latency.printStats;
window.clearLatencyStats = latency.clearStats;
window.exportLatencyData = latency.exportData;
window.setLatencyMetrics = latency.setEnabled;
window.compareLatencyModes = latency.compareLatencyModes;

window.addEventListener('load', () => {
    initMIDI();
    console.log('JI Tuning System initialized');
    console.log('Latency metrics enabled. Commands: showLatencyStats() | clearLatencyStats() | exportLatencyData()');
});
