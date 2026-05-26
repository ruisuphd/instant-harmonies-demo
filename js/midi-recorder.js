// MIDI Recorder - records live performances and exports with JI tuning
// Key changes tracked from MusicXML or ensemble detection

import { processMIDIForJI, NOTE_NAMES } from './midi-file-tuner.js';
import { exportMIDI1WithMTS, exportMIDI1WithMPE, exportMIDI2WithPitch725, downloadFile } from './midi-writer.js';
import { getKeyRoot, isMinorKey, JI_RATIOS, ratioToCentsDeviation } from './tuning-core.js';

const CONFIG = {
    maxDurationSeconds: 600,
    ticksPerQuarter: 480,
    defaultTempo: 500000,
    minNotesForTempo: 4
};

let isRecordingActive = false;
let recordingStartTime = 0;
let recordedNotes = [];
let recordedCCEvents = [];
let activeNotes = {};
let noteOnTimes = [];
let recordedKeyChanges = [];
let currentRecordedKey = null;
let keySource = 'ensemble';

export function isRecording() {
    return isRecordingActive;
}

export function startRecording() {
    if (isRecordingActive) {
        console.warn('Recording already in progress');
        return false;
    }
    
    clearRecordingData();
    isRecordingActive = true;
    recordingStartTime = performance.now();
    
    console.log('Recording started');
    return true;
}

export function stopRecording() {
    if (!isRecordingActive) {
        console.warn('No recording in progress');
        return false;
    }
    
    const recordingEndTime = performance.now();
    
    for (const [key, noteData] of Object.entries(activeNotes)) {
        const endTimeSeconds = (recordingEndTime - recordingStartTime) / 1000;
        finalizeNote(noteData, endTimeSeconds);
    }
    activeNotes = {};
    
    isRecordingActive = false;
    console.log(`Recording stopped: ${recordedNotes.length} notes captured`);
    return true;
}

export function clearRecording() {
    if (isRecordingActive) stopRecording();
    clearRecordingData();
    console.log('Recording cleared');
}

function clearRecordingData() {
    recordedNotes = [];
    recordedCCEvents = [];
    activeNotes = {};
    noteOnTimes = [];
    recordingStartTime = 0;
    recordedKeyChanges = [];
    currentRecordedKey = null;
    keySource = 'ensemble';
}

export function recordNoteOn(pitch, velocity, channel = 0, keyInfo = null) {
    if (!isRecordingActive) return;
    
    const currentTime = performance.now();
    const elapsedSeconds = (currentTime - recordingStartTime) / 1000;
    
    if (elapsedSeconds > CONFIG.maxDurationSeconds) {
        console.warn('Maximum recording duration reached');
        stopRecording();
        return;
    }
    
    noteOnTimes.push(elapsedSeconds);
    
    if (keyInfo && keyInfo.key) {
        if (keyInfo.key !== currentRecordedKey) {
            recordedKeyChanges.push({
                key: keyInfo.key,
                isMinor: keyInfo.isMinor || false,
                source: keyInfo.source || 'ensemble',
                timeSeconds: elapsedSeconds
            });
            currentRecordedKey = keyInfo.key;
            keySource = keyInfo.source || 'ensemble';
            console.log(`Recording: Key change to ${keyInfo.key} at ${elapsedSeconds.toFixed(2)}s`);
        }
    }
    
    const noteKey = `${pitch}_${channel}`;
    activeNotes[noteKey] = {
        pitch, velocity, channel,
        startTimeSeconds: elapsedSeconds,
        key: currentRecordedKey
    };
}

export function recordNoteOff(pitch, channel = 0) {
    if (!isRecordingActive) return;
    
    const noteKey = `${pitch}_${channel}`;
    const noteData = activeNotes[noteKey];
    
    if (!noteData) return;
    
    const currentTime = performance.now();
    const endTimeSeconds = (currentTime - recordingStartTime) / 1000;
    
    finalizeNote(noteData, endTimeSeconds);
    delete activeNotes[noteKey];
}

export function recordCC(controller, value, channel = 0) {
    if (!isRecordingActive) return;
    
    const currentTime = performance.now();
    const elapsedSeconds = (currentTime - recordingStartTime) / 1000;
    
    recordedCCEvents.push({ controller, value, channel, timeSeconds: elapsedSeconds });
}

function finalizeNote(noteData, endTimeSeconds) {
    const durationSeconds = endTimeSeconds - noteData.startTimeSeconds;
    if (durationSeconds < 0.01) return;
    
    recordedNotes.push({
        pitch: noteData.pitch,
        velocity: noteData.velocity,
        channel: noteData.channel,
        startTimeSeconds: noteData.startTimeSeconds,
        endTimeSeconds,
        durationSeconds,
        key: noteData.key
    });
}

export function getRecordingDuration() {
    if (!isRecordingActive) {
        if (recordedNotes.length === 0) return 0;
        return Math.max(...recordedNotes.map(n => n.endTimeSeconds));
    }
    return (performance.now() - recordingStartTime) / 1000;
}

export function getRecordingStats() {
    return {
        isRecording: isRecordingActive,
        noteCount: recordedNotes.length + Object.keys(activeNotes).length,
        completedNotes: recordedNotes.length,
        activeNotes: Object.keys(activeNotes).length,
        ccEventCount: recordedCCEvents.length,
        durationSeconds: getRecordingDuration(),
        keySource,
        keyChangeCount: recordedKeyChanges.length,
        currentKey: currentRecordedKey
    };
}

export function hasRecording() {
    return recordedNotes.length > 0;
}

export function hasRecordedKeys() {
    return recordedKeyChanges.length > 0;
}

export function getKeySource() {
    return keySource;
}

// Estimate tempo from note-on timings using median IOI
function calculateTempo() {
    if (noteOnTimes.length < CONFIG.minNotesForTempo) {
        return CONFIG.defaultTempo;
    }
    
    const intervals = [];
    for (let i = 1; i < noteOnTimes.length; i++) {
        const interval = noteOnTimes[i] - noteOnTimes[i - 1];
        if (interval > 0.1 && interval < 2.0) {
            intervals.push(interval);
        }
    }
    
    if (intervals.length === 0) return CONFIG.defaultTempo;
    
    intervals.sort((a, b) => a - b);
    const medianInterval = intervals[Math.floor(intervals.length / 2)];
    
    // Assume median is 8th note
    const quarterNoteSeconds = medianInterval * 2;
    const tempoMicroseconds = Math.round(quarterNoteSeconds * 1000000);
    
    const minTempo = 288462;   // 208 BPM
    const maxTempo = 1500000;  // 40 BPM
    
    return Math.max(minTempo, Math.min(maxTempo, tempoMicroseconds));
}

function convertToMidiData() {
    if (recordedNotes.length === 0) throw new Error('No recording to convert');
    
    const tempo = calculateTempo();
    const ticksPerQuarter = CONFIG.ticksPerQuarter;
    
    const secondsToTicks = (seconds) => {
        const secondsPerQuarter = tempo / 1000000;
        const quarters = seconds / secondsPerQuarter;
        return Math.round(quarters * ticksPerQuarter);
    };
    
    const sortedNotes = [...recordedNotes].sort((a, b) => a.startTimeSeconds - b.startTimeSeconds);
    
    const notes = sortedNotes.map(note => ({
        pitch: note.pitch,
        velocity: note.velocity,
        channel: note.channel,
        track: 1,
        startTick: secondsToTicks(note.startTimeSeconds),
        endTick: secondsToTicks(note.endTimeSeconds),
        startTime: note.startTimeSeconds,
        endTime: note.endTimeSeconds,
        duration: note.durationSeconds,
        recordedKey: note.key
    }));
    
    const ccEvents = recordedCCEvents.map(cc => ({
        type: 'controlChange',
        controller: cc.controller,
        value: cc.value,
        channel: cc.channel,
        tick: secondsToTicks(cc.timeSeconds),
        time: cc.timeSeconds
    }));
    
    const totalDuration = Math.max(...notes.map(n => n.endTime));
    
    const tracks = [
        { index: 0, events: [], notes: [] },
        { index: 1, events: ccEvents, notes }
    ];
    
    return {
        format: 1,
        trackCount: 2,
        ticksPerQuarterNote: ticksPerQuarter,
        tracks,
        tempoChanges: [{ tick: 0, tempo, type: 'tempo' }],
        timeSignatures: [{ tick: 0, numerator: 4, denominator: 4 }],
        keySignatures: [],
        notes,
        ccEvents,
        durationSeconds: totalDuration
    };
}

function buildKeySegmentsFromRecording(totalDuration, ticksPerQuarter, tempo) {
    if (recordedKeyChanges.length === 0) return null;
    
    const secondsToTicks = (seconds) => {
        const secondsPerQuarter = tempo / 1000000;
        const quarters = seconds / secondsPerQuarter;
        return Math.round(quarters * ticksPerQuarter);
    };
    
    const segments = [];
    
    for (let i = 0; i < recordedKeyChanges.length; i++) {
        const change = recordedKeyChanges[i];
        const nextChange = recordedKeyChanges[i + 1];
        
        const startTime = change.timeSeconds;
        const endTime = nextChange ? nextChange.timeSeconds : totalDuration;
        
        segments.push({
            key: change.key,
            startTime,
            endTime,
            startTick: secondsToTicks(startTime),
            endTick: secondsToTicks(endTime),
            confidence: 100,
            source: change.source,
            isMinor: change.isMinor
        });
    }
    
    console.log(`Built ${segments.length} key segments from recording`);
    return segments;
}

function processRecordingForExport(options = {}) {
    const midiData = convertToMidiData();
    
    if (hasRecordedKeys() && !options.manualKey) {
        console.log('Using recorded key signatures for JI tuning');
        
        const tempo = calculateTempo();
        const ticksPerQuarter = CONFIG.ticksPerQuarter;
        const keySegments = buildKeySegmentsFromRecording(
            midiData.durationSeconds, ticksPerQuarter, tempo
        );
        
        if (keySegments && keySegments.length > 0) {
            return processWithRecordedKeys(midiData, keySegments);
        }
    }
    
    console.log('Using ensemble key detection for JI tuning');
    return processMIDIForJI(midiData, {
        multiKey: options.multiKey !== false,
        manualKey: options.manualKey || null
    });
}

function processWithRecordedKeys(midiData, keySegments) {
    const tunedNotes = [];
    
    for (const note of midiData.notes) {
        const segment = keySegments.find(seg => 
            note.startTime >= seg.startTime && note.startTime < seg.endTime
        ) || keySegments[keySegments.length - 1];
        
        const key = segment.key;
        const keyRootVal = getKeyRoot(key);
        const isMinorKey_ = isMinorKey(key);
        const ratios = isMinorKey_ ? JI_RATIOS.minor : JI_RATIOS.major;
        
        const interval = ((note.pitch % 12) - (keyRootVal % 12) + 12) % 12;
        const ratio = ratios[interval] || 1.0;
        const centsDeviation = ratioToCentsDeviation(ratio, interval);
        
        tunedNotes.push({
            ...note,
            key,
            keyRoot: keyRootVal,
            interval,
            jiRatio: ratio,
            centsDeviation,
            pitchClass: note.pitch % 12,
            pitchClassName: NOTE_NAMES[note.pitch % 12]
        });
    }
    
    return {
        tunedNotes,
        keySegments,
        summary: {
            totalNotes: midiData.notes.length,
            durationSeconds: midiData.durationSeconds,
            keyChanges: keySegments.length,
            keySource: 'musicxml',
            keys: keySegments.map(s => ({
                key: s.key,
                startTime: s.startTime,
                endTime: s.endTime,
                confidence: s.confidence
            }))
        },
        originalMidiData: midiData
    };
}

export function exportAsMIDI1(options = {}) {
    const tuningResult = processRecordingForExport(options);
    return exportMIDI1WithMTS(tuningResult);
}

export function exportAsMIDI1MPE(options = {}) {
    const tuningResult = processRecordingForExport(options);
    return exportMIDI1WithMPE(tuningResult);
}

export function exportAsMIDI2(options = {}) {
    const tuningResult = processRecordingForExport(options);
    return exportMIDI2WithPitch725(tuningResult);
}

/**
 * @param format One of:
 *   'midi1'     — (legacy alias) MIDI 1.0 with MTS Scale/Octave SysEx
 *   'midi1-mts' — MIDI 1.0 with MTS Scale/Octave SysEx (universal — any
 *                 MTS-aware synth: Pianoteq, Surge XT, Logic Sampler, …)
 *   'midi1-mpe' — MIDI 1.0 with MPE per-channel pitch bend (MCM + RPN 0
 *                 init + per-note pitch-bend on channels 2..16). Works
 *                 with Pianoteq MPE mode, Ableton 12 MPE tracks, ROLI
 *                 Equator², and any lower-zone-MPE-aware synth. Falls
 *                 back gracefully on non-MPE synths because RPN 0 is
 *                 universal MIDI 1.0.
 *   'midi2'     — MIDI 2.0 clip file with Pitch 7.25 per-note tuning
 */
export function downloadRecording(format = 'midi1', options = {}) {
    if (!hasRecording()) throw new Error('No recording to download');

    const timestamp = new Date().toISOString().slice(0, 19).replace(/[:-]/g, '');

    let blob, defaultFilename, formatLabel;

    if (format === 'midi2') {
        blob = exportAsMIDI2(options);
        defaultFilename = `recording_JI_${timestamp}.midi2`;
        formatLabel = 'MIDI 2.0 Pitch 7.25';
    } else if (format === 'midi1-mpe') {
        blob = exportAsMIDI1MPE(options);
        defaultFilename = `recording_JI_MPE_${timestamp}.mid`;
        formatLabel = 'MIDI 1.0 MPE';
    } else {
        // 'midi1' (legacy alias) and 'midi1-mts' → MTS SysEx
        blob = exportAsMIDI1(options);
        defaultFilename = `recording_JI_MTS_${timestamp}.mid`;
        formatLabel = 'MIDI 1.0 MTS';
    }

    downloadFile(blob, options.filename || defaultFilename);

    const stats = getRecordingStats();
    console.log(`Downloaded: ${stats.completedNotes} notes, ${formatLabel}`);
}

export function getDetectedKeys() {
    if (!hasRecording()) {
        return { keySegments: [], summary: null, keySource: 'none' };
    }
    
    if (hasRecordedKeys()) {
        const midiData = convertToMidiData();
        const tempo = calculateTempo();
        const ticksPerQuarter = CONFIG.ticksPerQuarter;
        const keySegments = buildKeySegmentsFromRecording(
            midiData.durationSeconds, ticksPerQuarter, tempo
        );
        
        if (keySegments && keySegments.length > 0) {
            return {
                keySegments,
                summary: { keyChanges: keySegments.length, keys: keySegments.map(s => s.key) },
                keySource: 'musicxml'
            };
        }
    }
    
    const midiData = convertToMidiData();
    const tuningResult = processMIDIForJI(midiData, { multiKey: true });
    
    return {
        keySegments: tuningResult.keySegments,
        summary: tuningResult.summary,
        keySource: 'ensemble'
    };
}

console.log('MIDI Recorder loaded');
