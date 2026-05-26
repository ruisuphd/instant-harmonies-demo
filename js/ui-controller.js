import { parseMIDIFile } from './midi-parser.js';
import { processMIDIForJI } from './midi-file-tuner.js';
import { exportMIDI1WithMTS, exportMIDI2WithPitch725, downloadFile, generateOutputFilename } from './midi-writer.js';

const consoleDiv = document.getElementById('consoleDisplay');
const originalLog = console.log, originalWarn = console.warn, originalError = console.error;
function addConsoleEntry(msg) {
    const entry = document.createElement('div');
    entry.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
    consoleDiv.appendChild(entry);
    consoleDiv.scrollTop = consoleDiv.scrollHeight;
    while (consoleDiv.children.length > 100) consoleDiv.removeChild(consoleDiv.firstChild);
}
console.log = (...args) => { originalLog.apply(console, args); addConsoleEntry(args.join(' ')); };
console.warn = (...args) => { originalWarn.apply(console, args); addConsoleEntry(args.join(' ')); };
console.error = (...args) => { originalError.apply(console, args); addConsoleEntry(args.join(' ')); };
console.log('System initialized');

let currentMidiData = null, currentTuningResult = null, currentFileName = '';

async function handleMIDIFileSelect(event) {
    const file = event.target.files[0];
    if (!file) return;
    currentFileName = file.name;
    const statusEl = document.getElementById('tuningStatus');
    const fileInfoEl = document.getElementById('fileInfo');
    const fileInfoContentEl = document.getElementById('fileInfoContent');
    statusEl.textContent = 'Status: Parsing MIDI file...';
    fileInfoEl.classList.remove('hidden');
    document.getElementById('keySegmentsDisplay').classList.add('hidden');
    document.getElementById('downloadButton').disabled = true;
    currentTuningResult = null;
    try {
        currentMidiData = await parseMIDIFile(file);
        const duration = currentMidiData.durationSeconds;
        const minutes = Math.floor(duration / 60);
        const seconds = Math.round(duration % 60);
        fileInfoContentEl.innerHTML = `<strong>File:</strong> ${file.name}<br><strong>Format:</strong> SMF Type ${currentMidiData.format}<br><strong>Tracks:</strong> ${currentMidiData.trackCount}<br><strong>Notes:</strong> ${currentMidiData.notes.length.toLocaleString()}<br><strong>Duration:</strong> ${minutes}:${seconds.toString().padStart(2, '0')}<br><strong>Resolution:</strong> ${currentMidiData.ticksPerQuarterNote} ticks/quarter`;
        document.getElementById('processButton').disabled = false;
        statusEl.textContent = 'Status: File loaded. Click "Apply Tuning" to process.';
        console.log(`Loaded MIDI file: ${file.name} (${currentMidiData.notes.length} notes)`);
    } catch (error) {
        console.error('Error parsing MIDI file:', error);
        fileInfoContentEl.innerHTML = `<span style="color: red;">Error: ${error.message}</span>`;
        document.getElementById('processButton').disabled = true;
        statusEl.textContent = 'Status: Error parsing file';
    }
}

function processMIDIFile() {
    if (!currentMidiData) { alert('Please select a MIDI file first'); return; }
    const statusEl = document.getElementById('tuningStatus');
    const keySegmentsEl = document.getElementById('keySegmentsDisplay');
    statusEl.textContent = 'Status: Analyzing keys and applying tuning...';
    const keyMode = document.querySelector('input[name="keyMode"]:checked').value;
    const manualKey = keyMode === 'manual' ? document.getElementById('manualKeySelect').value : null;
    try {
        currentTuningResult = processMIDIForJI(currentMidiData, { multiKey: keyMode === 'auto', manualKey });
        const segments = currentTuningResult.keySegments;
        let html = `<strong>Detected Keys (${segments.length} segment${segments.length > 1 ? 's' : ''}):</strong><br>`;
        for (const seg of segments) {
            const timeRange = `${Math.floor(seg.startTime / 60)}:${Math.round(seg.startTime % 60).toString().padStart(2, '0')} - ${Math.floor(seg.endTime / 60)}:${Math.round(seg.endTime % 60).toString().padStart(2, '0')}`;
            html += `<div class="key-segment"><strong>${seg.key}</strong> | ${timeRange} | ${seg.confidence}%</div>`;
        }
        keySegmentsEl.innerHTML = html;
        keySegmentsEl.classList.remove('hidden');
        document.getElementById('downloadButton').disabled = false;
        statusEl.textContent = `Status: Tuning applied. ${currentTuningResult.summary.totalNotes} notes, ${segments.length} key segment(s).`;
        console.log(`Tuning complete: ${segments.length} key segments`);
    } catch (error) {
        console.error('Error processing MIDI:', error);
        statusEl.textContent = `Status: Error - ${error.message}`;
        document.getElementById('downloadButton').disabled = true;
    }
}

function downloadTunedMIDI() {
    if (!currentTuningResult) { alert('Please process a MIDI file first'); return; }
    const statusEl = document.getElementById('tuningStatus');
    const outputFormat = document.querySelector('input[name="outputFormat"]:checked').value;
    try {
        let blob, filename;
        if (outputFormat === 'midi2') {
            blob = exportMIDI2WithPitch725(currentTuningResult);
            filename = generateOutputFilename(currentFileName, 'midi2');
        } else {
            blob = exportMIDI1WithMTS(currentTuningResult);
            filename = generateOutputFilename(currentFileName, 'midi1');
        }
        statusEl.textContent = `Status: Downloading ${filename}`;
        downloadFile(blob, filename);
        console.log(`Downloaded: ${filename}`);
    } catch (error) {
        console.error('Error exporting MIDI:', error);
        statusEl.textContent = `Status: Export error - ${error.message}`;
    }
}

document.querySelectorAll('input[name="keyMode"]').forEach(radio => {
    radio.addEventListener('change', function() { document.getElementById('manualKeySelect').disabled = this.value !== 'manual'; });
});

window.addEventListener('load', () => {
    let hookRetries = 0;
    const maxRetries = 50; // 5 seconds max
    const checkAndHook = setInterval(() => {
        hookRetries++;
        if (window.handleNoteOn) {
            const original = window.handleNoteOn;
            window.handleNoteOn = function(note, velocity, channel, hardwareTimestamp) {
                original.call(this, note, velocity, channel, hardwareTimestamp);
                if (window.twoStageClient?.connected) window.twoStageClient.sendMidiNote(note, velocity);
            };
            clearInterval(checkAndHook);
            console.log('Two-stage note hook installed');
        } else if (hookRetries >= maxRetries) {
            clearInterval(checkAndHook);
            console.warn('Two-stage note hook: handleNoteOn not found after 5s — hook not installed');
        }
    }, 100);
});

function resetSystem() {
    window.stopSystem?.();
    window.panicStop?.();
    window.keyDetector?.reset();
    document.getElementById('keyName').textContent = '\u2014';
    document.getElementById('keyConfidence').textContent = '';
    document.getElementById('detectionStatus').textContent = 'Status: Reset';
    document.getElementById('stage1Status').innerHTML = 'Ready';
    document.getElementById('stage1Status').style.backgroundColor = '';
    document.getElementById('songResults').innerHTML = '';
    document.getElementById('scoreProgress').innerHTML = '';
    document.getElementById('predictedNotes').innerHTML = '';
    window.twoStageClient?.connected ? window.twoStageClient.reset() : window.twoStageClient?.clearAllUI?.();
    console.log('System reset');
}

let recordingUpdateInterval = null;
const getRecorder = () => window.midiRecorder;

function toggleRecording() {
    const recorder = getRecorder();
    if (!recorder) { alert('Recording module not loaded yet.'); return; }
    recorder.isRecording() ? stopRecordingSession() : startRecordingSession();
}

function startRecordingSession() {
    const recorder = getRecorder();
    if (!recorder) return;
    if (!document.getElementById('startButton').disabled) {
        if (!confirm('Tuning system not running. JI tuning will be applied at download time.\n\nProceed?')) return;
    }
    recorder.startRecording();
    document.getElementById('recordButton').textContent = 'Stop';
    document.getElementById('clearRecordingButton').disabled = true;
    document.getElementById('recordingIndicator').textContent = 'REC';
    document.getElementById('recordingStatus').textContent = 'Recording...';
    document.getElementById('recordingInfo').classList.remove('hidden');
    document.getElementById('downloadSection').classList.add('hidden');
    recordingUpdateInterval = setInterval(updateRecordingDisplay, 200);
    console.log('Recording started');
}

function stopRecordingSession() {
    const recorder = getRecorder();
    if (!recorder) return;
    recorder.stopRecording();
    if (recordingUpdateInterval) { clearInterval(recordingUpdateInterval); recordingUpdateInterval = null; }
    document.getElementById('recordButton').textContent = 'Record';
    document.getElementById('clearRecordingButton').disabled = false;
    document.getElementById('recordingIndicator').textContent = 'Done';
    const stats = recorder.getRecordingStats();
    let statusText = `${stats.completedNotes} notes, ${stats.ccEventCount || 0} pedal events`;
    if (stats.completedNotes > 0) {
        document.getElementById('downloadSection').classList.remove('hidden');
        try {
            const keyInfo = recorder.getDetectedKeys();
            if (keyInfo.keySegments.length > 0) {
                statusText += ` | Keys: ${keyInfo.keySegments.map(s => s.key).join(' \u2192 ')} ${keyInfo.keySource === 'musicxml' ? '(MusicXML)' : '(detected)'}`;
            }
        } catch (e) {}
    }
    document.getElementById('recordingStatus').textContent = statusText;
    updateRecordingDisplay();
    console.log('Recording stopped');
}

function updateRecordingDisplay() {
    const recorder = getRecorder();
    if (!recorder) return;
    const stats = recorder.getRecordingStats();
    if (!stats.isRecording && recordingUpdateInterval) { stopRecordingSession(); return; }
    const minutes = Math.floor(stats.durationSeconds / 60);
    const seconds = Math.floor(stats.durationSeconds % 60);
    document.getElementById('recordingDuration').textContent = `${minutes}:${seconds.toString().padStart(2, '0')}`;
    document.getElementById('recordingNoteCount').textContent = stats.noteCount;
    document.getElementById('recordingCurrentKey').textContent = stats.currentKey || '\u2014';
    if (stats.currentKey) document.getElementById('recordingKeySource').textContent = stats.keySource === 'musicxml' ? '(MusicXML)' : '(detected)';
}

function clearRecordingData() {
    const recorder = getRecorder();
    if (!recorder) return;
    recorder.clearRecording();
    document.getElementById('recordButton').textContent = 'Record';
    document.getElementById('clearRecordingButton').disabled = true;
    document.getElementById('recordingIndicator').textContent = '';
    document.getElementById('recordingStatus').textContent = 'Ready';
    document.getElementById('recordingInfo').classList.add('hidden');
    document.getElementById('downloadSection').classList.add('hidden');
    document.getElementById('recordingDuration').textContent = '0:00';
    document.getElementById('recordingNoteCount').textContent = '0';
    console.log('Recording cleared');
}

function downloadRecordingFile() {
    const recorder = getRecorder();
    if (!recorder?.hasRecording()) { alert('No recording available'); return; }
    const format = document.querySelector('input[name="recordingFormat"]:checked').value;
    try {
        recorder.downloadRecording(format);
        const label = {
            'midi2': 'MIDI 2.0 (Pitch 7.25)',
            'midi1-mpe': 'MIDI 1.0 MPE (per-channel pitch bend)',
            'midi1-mts': 'MIDI 1.0 MTS (Scale/Octave SysEx)',
            'midi1': 'MIDI 1.0 MTS (legacy alias)',
        }[format] || format;
        console.log(`Downloaded as ${label}`);
    } catch (error) { alert('Download failed: ' + error.message); }
}

window.handleMIDIFileSelect = handleMIDIFileSelect;
window.processMIDIFile = processMIDIFile;
window.downloadTunedMIDI = downloadTunedMIDI;
window.resetSystem = resetSystem;
window.toggleRecording = toggleRecording;
window.clearRecordingData = clearRecordingData;
window.downloadRecordingFile = downloadRecordingFile;
