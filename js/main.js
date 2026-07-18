// Main - JI Tuning System orchestrator
// Handles MIDI device management, note processing, key detection, and tuning

import { keyDetector, NOTE_NAMES } from './key-detection.js';
import { getKeyRoot, isMinorKey, centsToPitchBend, pitchBendToCents, computeAnchoredScaleOctaveTuning } from './tuning-core.js';
import * as mpe from './tuning-mpe.js';
import * as mts from './tuning-mts.js';
import { MTSTableGate } from './tuning-gate.js';
import { resolveKeySource, KEY_SOURCE_MODES, KEY_SOURCE_DISPLAY } from './key-source.js';
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

// Key-source policy (KS1, 2026-07-17): which detector drives the tonal centre.
// 'auto' | 'gru' | 'classical' | 'manual' — resolved per note through
// resolveKeySource (js/key-source.js); persisted across sessions.
let keySourceMode = 'auto';
let liveManualKey = 'C';

// Assemble the live context the key-source resolver decides over.
function currentKeyContext() {
    const twoStageClient = window.twoStageClient;
    const systemState = twoStageClient?.systemState;
    const scoreFollowingActive = systemState === 'following' || systemState === 'score_following_active';
    const gru = backendHarmonicPrediction;
    return {
        scoreFollowingActive,
        musicXMLKey: window._lastMusicXMLKey || null,
        gruKey: gru?.key || null,
        gruFresh: !!gru && (Date.now() - gru.receivedAtMs) <= BACKEND_HARMONIC_TTL_MS,
        ensembleKey: keyDetector.getCurrentKey(),
        manualKey: liveManualKey,
    };
}

// Continuity-preserving tuning anchor (A1 fix, 2026-07-12).
// appliedTuning holds the 12-pc cents table currently in force — INCLUDING the
// anchor offset — so a key change can be re-anchored against what listeners
// are actually hearing. pedalRingingPcs approximates the pitch classes still
// sounding via the sustain pedal (cleared on CC64-up): they carry the same
// perceptual weight as held keys when choosing the anchor offset.
let appliedTuning = { key: null, table: null, offsetCents: 0 };
let pedalRingingPcs = new Set();

// Resolve (and cache) the anchored tuning table for a key. On a key CHANGE the
// new table is offset so that the pitch classes sounding right now move as
// little as possible (see tuning-core.js computeAnchoredScaleOctaveTuning);
// the syntonic comma lands on notes nobody is sounding. With nothing sounding
// the offset re-anchors to 0 (inaudible, and bleeds accumulated drift back
// toward concert pitch).
function resolveAnchoredTuning(keyName) {
    if (!keyName) return null;
    if (appliedTuning.key === keyName && appliedTuning.table) return appliedTuning.table;

    const soundingPcs = [];
    for (const note of Object.keys(activeNoteStacks)) soundingPcs.push(Number(note) % 12);
    for (const pc of pedalRingingPcs) soundingPcs.push(pc);

    const { centsArray, offsetCents } = computeAnchoredScaleOctaveTuning(
        getKeyRoot(keyName), isMinorKey(keyName), soundingPcs, appliedTuning.table
    );
    appliedTuning = { key: keyName, table: centsArray, offsetCents };
    if (offsetCents !== 0) {
        console.log(`Key ${keyName}: table re-anchored ${offsetCents > 0 ? '+' : ''}${offsetCents}c for continuity`);
    }
    return centsArray;
}

// G1 fix (2026-07-12): bulk MTS Scale/Octave sends retune SOUNDING notes
// instantly, so they are gated to note boundaries. While anything is held or
// ringing under the pedal the table is queued; new attacks are covered by the
// per-note single-note MTS message in forwardNoteExternal, so nothing sounds
// out of tune in the interim.
const mtsGate = new MTSTableGate((table, label) => {
    const outputMode = document.querySelector('input[name="outputMode"]:checked')?.value;
    if (outputMode !== 'external' || !selectedOutput) return;
    mts.applyJITuningTable(selectedOutput, table, label);
});

function textureIsBusy() {
    return Object.keys(activeNoteStacks).length > 0 || pedalRingingPcs.size > 0;
}

let predictiveJITable = {};
let predictiveTuningActive = false;
const predictiveSeenIds = new Set();
let backendHarmonicPrediction = null;
const BACKEND_HARMONIC_TTL_MS = 1500;

async function initMIDI() {
    if (!navigator.requestMIDIAccess) {
        console.warn('Web MIDI API not supported by this browser');
        updateStatus('This browser has no Web MIDI support (Safari does not) — live MIDI input is disabled. File Tuning below works in any browser.');
        return;
    }
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
            console.error('Failed to get MIDI access: ' + (basicError.message || basicError));
            updateStatus('MIDI unavailable (' + (basicError.message || basicError) + ') — live input disabled. File Tuning below still works without a MIDI device.');
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
        audio.initAudio().then(() => {
            if (!audio.areSamplesLoaded()) {
                updateStatus('Warning: piano samples not loaded — internal sound is silent. Check network and press Start again.');
            }
        });
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
            console.log('Sending Local Control Off (CC 122, 0) on all 16 channels... '
                + '(Note: some pianos, e.g. Roland FP-10, do not receive CC 122 — '
                + 'if doubling persists, lower the instrument volume and use Internal Sound.)');
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
    applyKeySourceChange();   // KS1: show the active policy (manual shows its fixed key)
    
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
    updateKeyDisplay('Stopped', '', 'System stopped');
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
    // KS1: the classical ensemble runs only under policies that can use it —
    // in 'gru' and 'manual' modes it is bypassed entirely so an ablation run
    // is never contaminated (and per-note latency drops accordingly).
    const ensembleActive = keySourceMode === 'auto' || keySourceMode === 'classical';
    if (ensembleActive && keyDetectionBuffer.length >= MIN_NOTES_FOR_DETECTION) {
        keyDetectionRan = true;
        const sensitivity = document.getElementById('sensitivity')?.value || 'medium';
        const activeNotes = Object.keys(activeNoteStacks).map(Number);
        const result = keyDetector.detectKey(keyDetectionBuffer, sensitivity, { activeNotes });

        if (result) {
            // The ensemble drives the display/tables only while it is the
            // policy's active source: always in 'classical'; in 'auto' only
            // when neither the score follower nor a fresh GRU prediction
            // outranks it (resolver priority, KS1).
            const ctx = currentKeyContext();
            const drivesOutput = keySourceMode === 'classical' ||
                (!ctx.scoreFollowingActive && !(ctx.gruKey && ctx.gruFresh));

            if (drivesOutput) {
                updateKeyDisplay(
                    result.key,
                    `Confidence: ${result.confidence}%${result.agreementText ? ` (${result.agreementText})` : ''}`,
                    KEY_SOURCE_DISPLAY.ensemble
                );
                updateStatus(`Key changed to ${result.key} (classical ensemble)`);

                const outputMode = document.querySelector('input[name="outputMode"]:checked')?.value;
                if (outputMode === 'external' && mts.isMTSSupported() && !mts.isMTSFallbackRequested()) {
                    // A1: continuity-anchored table; G1: held until the texture clears
                    mtsGate.submit(resolveAnchoredTuning(result.key), result.key, textureIsBusy());
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

function clearBackendHarmonicPrediction() {
    backendHarmonicPrediction = null;
}

function getCurrentKeyInfo() {
    // KS1: one policy resolver for tuning, display, and the recorder alike.
    // Source labels keep the recorder's historical vocabulary so exported key
    // segments stay comparable across takes.
    const resolved = resolveKeySource(keySourceMode, currentKeyContext());
    if (!resolved) return null;

    const sourceLabel = {
        musicxml: 'musicxml',
        gru: 'harmonic_context_model',
        ensemble: 'causal_ensemble',
        manual: 'manual',
    }[resolved.source];

    const info = {
        key: resolved.key,
        isMinor: resolved.source === 'musicxml'
            ? (window._lastMusicXMLIsMinor || false)
            : resolved.key.includes('m'),
        source: sourceLabel
    };
    if (resolved.source === 'gru' && backendHarmonicPrediction?.confidence != null) {
        info.confidence = backendHarmonicPrediction.confidence;
    }
    return info;
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
        pedalRingingPcs.add(note % 12);          // A1: still audible for anchoring
    } else {
        if (outputMode === 'external' && mpe.isSustainPedalDown()) {
            pedalRingingPcs.add(note % 12);      // A1: rings on via the receiver's pedal
        }
        forwardNote({ note, velocity: 0, noteId }, channel, false);
    }

    mtsGate.flush(textureIsBusy());              // G1: send queued table once quiet
}

function handleControlChange(controller, value, channel) {
    if (recorder.isRecording()) {
        recorder.recordCC(controller, value, channel);
    }
    
    if (controller === 64) {
        const outputMode = document.querySelector('input[name="outputMode"]:checked').value;
        const pedalDown = value >= 64;

        if (outputMode === 'internal') {
            audio.setSustainPedal(pedalDown);
        }

        if (outputMode === 'external' && selectedOutput) {
            if (mts.isMTSSupported()) {
                // MTS mode: notes stay on their incoming channel — forward as-is.
                selectedOutput.send([0xB0 | channel, controller, value]);
            } else {
                // S2 fix (2026-07-12): in MPE mode the notes live on member
                // channels 1..15, NOT on the pedal's incoming channel, so a
                // pass-through CC64 never reached them on non-MPE receivers.
                // Broadcast to the master channel (zone-wide sustain for
                // MPE-strict receivers, RP-053) AND every member channel
                // (per-channel sustain for non-MPE receivers such as the
                // FP-10 or GM modules) — covers both, duplication is benign.
                for (let ch = 0; ch < 16; ch++) {
                    selectedOutput.send([0xB0 | ch, controller, value]);
                }
            }
            // S1 fix (2026-07-12): the MPE channel allocator must know the pedal
            // state — released-but-ringing notes keep their channels while the
            // pedal is down, and get them back into the pool on pedal-up.
            mpe.setSustainPedal(pedalDown);
        }

        if (!pedalDown) {
            // A1: nothing rings past pedal-up. G1: flush AFTER the CC64-up has
            // been forwarded, so the receiver releases its sustained voices
            // before the bulk table arrives (QA fix: the flush previously
            // preceded the forward, momentarily retuning still-ringing notes).
            pedalRingingPcs.clear();
            mtsGate.flush(textureIsBusy());
        }
    }
}

function applyTuning(note, velocity, channel) {
    // KS1: score-informed per-note predictive tuning belongs to the Auto
    // policy only — single-detector and manual modes must stay pure.
    const queue = keySourceMode === 'auto' ? predictiveJITable?.[note] : null;
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
    
    // KS1: the policy resolver picks the tonal centre; until one exists the
    // note passes through untuned (12-TET).
    const resolved = resolveKeySource(keySourceMode, currentKeyContext());
    if (!resolved) {
        return { note, velocity, pitchBend: 0 };
    }

    // A1 fix (2026-07-12): tune from the anchored table (shared with the MTS
    // path) instead of the tonic-anchored calculateJIPitchBend, so MPE bends
    // and MTS tables agree and key changes keep common tones in place — the
    // anchoring applies identically under every key-source policy.
    const table = resolveAnchoredTuning(resolved.key);
    const pitchBend = centsToPitchBend(table[note % 12]);
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
                    // Sustained-stolen notes already got their note-off at key-up (S1).
                    if (!allocationResult.stolenSustained && typeof allocationResult.stolenPitch === 'number') {
                        selectedOutput.send([0x80 | allocationResult.channel, allocationResult.stolenPitch, 0]);
                        totalBytesSent += 3;
                    }
                    // While CC64 is down the receiver defers note-offs, so the stolen
                    // voice keeps ringing — CC120 is the only way to free it before
                    // the new note's pitch bend would re-tune it (S1, 2026-07-12).
                    if (allocationResult.needsSoundOff) {
                        totalBytesSent += mpe.sendAllSoundOff(selectedOutput, allocationResult.channel);
                    }
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
    
    // G1 (2026-07-12): sync EVERY attack via single-note MTS, not only nonzero
    // bends. While a bulk table is gated (notes ringing), the note number may
    // still carry a stale value from an earlier key — a 0-cent target must be
    // transmitted too, or the attack sounds at the old tuning.
    if (isNoteOn && usingMTS) {
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
        // S1 fix (2026-07-12): no pitch-bend reset here. The old bend-to-0 send
        // instantly detuned the still-ringing sustained note back to ET on every
        // key release under pedal (each channel's bend is set again immediately
        // before its next note-on, so the reset served no purpose).
        if (mpe.isSustainPedalDown()) {
            // Pedal down: the receiver keeps this voice ringing, so keep its
            // channel owned until CC64-up (setSustainPedal releases it).
            mpe.sustainNote(noteData.noteId);
        } else {
            mpe.releaseChannel(noteData.noteId);
        }
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
    // A1: a fresh session (or panic) starts from the tonic-anchored table —
    // with nothing sounding, snapping the anchor offset to 0 is inaudible.
    appliedTuning = { key: null, table: null, offsetCents: 0 };
    pedalRingingPcs = new Set();
    mtsGate.reset();                               // G1: drop any queued table
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
            // CC64-up + CC120 first: CC123 (All Notes Off) is deferred by a held
            // sustain pedal per the MIDI spec, so on its own it doesn't silence
            // a pedalled texture (S1, 2026-07-12).
            selectedOutput.send([0xB0 | channel, 64, 0]);
            selectedOutput.send([0xB0 | channel, 120, 0]);
            selectedOutput.send([0xB0 | channel, 123, 0]);
        }
    }

    keyDetectionBuffer = [];
    audio.reset();
    mpe.resetMPEState();
    resetNoteTracking();
    updateStatus('All notes stopped');
}

// Global exports
window.startSystem = startSystem;
window.stopSystem = stopSystem;
window.panicStop = panicStop;

window.switchToMTSMode = function() {
    // A1: pass no key — the raw per-key table inside switchToMTSMode would
    // bypass the continuity anchor. Re-apply the anchored table ourselves.
    const ok = mts.switchToMTSMode(selectedOutput, sysexEnabled, null, updateTuningModeDisplay);
    const key = getCurrentKeyInfo()?.key || keyDetector.getCurrentKey();
    if (ok && key && selectedOutput) {
        mtsGate.submit(resolveAnchoredTuning(key), key, textureIsBusy());
    }
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
    
    // KS1: score-informed tables belong to the Auto policy only.
    if (keySourceMode === 'auto' && musicXMLKey && predictiveTuningActive) {
        const outputMode = document.querySelector('input[name="outputMode"]:checked')?.value;
        if (outputMode === 'external' && selectedOutput && mts.isMTSSupported() && !mts.isMTSFallbackRequested()) {
            console.log(`MTS tuning queued for ${musicXMLKey} (from MusicXML)`);
            // A1: continuity-anchored table; G1: held until the texture clears
            mtsGate.submit(resolveAnchoredTuning(musicXMLKey), musicXMLKey, textureIsBusy());
        }
    }
};

window.applyBackendHarmonicPrediction = function(prediction) {
    if (!prediction || !prediction.key) {
        return;
    }

    const previousKey = backendHarmonicPrediction?.key;
    // Always stored — switching to the 'gru' policy mid-performance can then
    // pick up the latest prediction immediately (KS1).
    backendHarmonicPrediction = {
        ...prediction,
        receivedAtMs: Date.now()
    };

    // KS1: predictions drive output only under policies that use the neural
    // model. In 'auto', the score follower outranks it; in 'gru' it is the
    // sole source (score following is ignored for ablation purity).
    if (keySourceMode !== 'auto' && keySourceMode !== 'gru') return;
    if (keySourceMode === 'auto') {
        const twoStageClient = window.twoStageClient;
        const systemState = twoStageClient?.systemState;
        const scoreFollowingActive = systemState === 'following' || systemState === 'score_following_active';
        if (scoreFollowingActive) return;
    }

    const confidencePercent = Number(prediction.confidence) * 100;
    const confidenceText = Number.isFinite(confidencePercent)
        ? `Confidence: ${confidencePercent.toFixed(1)}%`
        : '';
    updateKeyDisplay(prediction.key, confidenceText, KEY_SOURCE_DISPLAY.gru);

    if (previousKey !== prediction.key) {
        updateStatus(`Key changed to ${prediction.key} (GRU harmonic model)`);

        const outputMode = document.querySelector('input[name="outputMode"]:checked')?.value;
        if (outputMode === 'external' && selectedOutput && mts.isMTSSupported() && !mts.isMTSFallbackRequested()) {
            // A1: continuity-anchored table; G1: held until the texture clears
            mtsGate.submit(resolveAnchoredTuning(prediction.key), prediction.key, textureIsBusy());
        }
    }
};

window.clearBackendHarmonicPrediction = clearBackendHarmonicPrediction;

// KS1: apply a key-source policy change immediately — refresh the display to
// the newly-resolved source and (in external MTS mode) queue its anchored
// table. The A1 anchor makes even a live switch land softly: sounding common
// tones do not move.
function applyKeySourceChange() {
    const resolved = resolveKeySource(keySourceMode, currentKeyContext());
    if (resolved) {
        updateKeyDisplay(
            resolved.key,
            resolved.source === 'manual' ? 'fixed tonal centre' : '',
            KEY_SOURCE_DISPLAY[resolved.source]
        );
        updateStatus(`Key source: ${keySourceMode}${resolved.source === 'manual' ? ` (${resolved.key})` : ''}`);
        const outputMode = document.querySelector('input[name="outputMode"]:checked')?.value;
        if (outputMode === 'external' && selectedOutput && mts.isMTSSupported() && !mts.isMTSFallbackRequested()) {
            mtsGate.submit(resolveAnchoredTuning(resolved.key), resolved.key, textureIsBusy());
        }
    } else {
        updateKeyDisplay(
            keySourceMode === 'gru' ? 'Awaiting GRU…' : 'Listening…',
            '',
            keySourceMode === 'gru' ? KEY_SOURCE_DISPLAY.gru : KEY_SOURCE_DISPLAY.ensemble
        );
    }
}

// Exposed so two_stage_client.js can defer its score-follow display updates
// to the active policy (only Auto is score-driven).
window.getKeySourceMode = () => keySourceMode;

document.addEventListener('DOMContentLoaded', () => {
    const keySourceSel = document.getElementById('keySource');
    const manualSel = document.getElementById('liveManualKey');
    if (!keySourceSel) return;

    const storedMode = localStorage.getItem('keySourceMode');
    if (storedMode && KEY_SOURCE_MODES.includes(storedMode)) keySourceMode = storedMode;
    const storedKey = localStorage.getItem('liveManualKey');
    if (storedKey && getKeyRoot(storedKey)) liveManualKey = storedKey;
    keySourceSel.value = keySourceMode;
    if (manualSel) manualSel.value = liveManualKey;

    const syncManualVisibility = () => {
        if (manualSel) manualSel.classList.toggle('hidden', keySourceMode !== 'manual');
    };
    syncManualVisibility();

    keySourceSel.addEventListener('change', () => {
        keySourceMode = KEY_SOURCE_MODES.includes(keySourceSel.value) ? keySourceSel.value : 'auto';
        localStorage.setItem('keySourceMode', keySourceMode);
        syncManualVisibility();
        applyKeySourceChange();
        console.log(`Key source policy: ${keySourceMode}`);
    });
    manualSel?.addEventListener('change', () => {
        liveManualKey = manualSel.value;
        localStorage.setItem('liveManualKey', liveManualKey);
        if (keySourceMode === 'manual') applyKeySourceChange();
    });
});

window.handleNoteOn = handleNoteOn;
window.keyDetector = keyDetector;
window.midiRecorder = recorder;

window.showLatencyStats = latency.printStats;
window.clearLatencyStats = latency.clearStats;
window.exportLatencyData = latency.exportData;
window.setLatencyMetrics = latency.setEnabled;
window.compareLatencyModes = latency.compareLatencyModes;

// Preload the Salamander samples as soon as the user opts into internal
// sound, so the first Start doesn't stall on the CDN fetch — and surface
// load failures instead of playing silence (playNote() silently no-ops
// while samples are missing).
async function preloadInternalAudio() {
    if (audio.areSamplesLoaded()) return;
    updateStatus('Loading piano samples…');
    try {
        await audio.initAudio();
        updateStatus(audio.areSamplesLoaded()
            ? 'Piano samples loaded'
            : 'Piano samples failed to load (CDN unreachable?) — internal sound will be silent');
    } catch (e) {
        updateStatus('Piano samples failed to load: ' + (e.message || e));
    }
}

document.querySelectorAll('input[name="outputMode"]').forEach(radio => {
    radio.addEventListener('change', function () {
        if (this.value === 'internal') preloadInternalAudio();
    });
});

window.addEventListener('load', () => {
    initMIDI();
    console.log('JI Tuning System initialized');
    console.log('Latency metrics enabled. Commands: showLatencyStats() | clearLatencyStats() | exportLatencyData()');
});
