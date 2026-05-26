// MIDI File Tuner - applies JI tuning to MIDI files with automatic multi-key detection
// Analyzes music in segments and detects key changes to apply appropriate tuning

import { JI_RATIOS, getKeyRoot, isMinorKey, ratioToCentsDeviation } from './tuning-core.js';
import { ENSEMBLE_CONFIG, NOTE_NAMES } from './key-detection.js';

const TUNER_CONFIG = {
    segmentDurationSeconds: 4.0,
    minNotesPerSegment: 8,
    keyChangeThreshold: 0.04,
    minConfidence: 0.03
};

// Same key detection algorithm as real-time, applied to file segments
function detectKeyFromNotes(notes) {
    if (!notes || notes.length < TUNER_CONFIG.minNotesPerSegment) return null;

    const noteCounts = new Array(12).fill(0);
    notes.forEach(note => { noteCounts[note.pitch % 12]++; });

    const total = noteCounts.reduce((a, b) => a + b, 0);
    if (total === 0) return null;

    const normalized = noteCounts.map(c => c / total);

    const keyVotes = {};
    const profileResults = {};

    for (const [profileName, profileConfig] of Object.entries(ENSEMBLE_CONFIG.profiles)) {
        const profile = profileConfig.data;
        const weight = profileConfig.weight;

        let bestKey = null;
        let bestScore = -Infinity;

        for (let root = 0; root < 12; root++) {
            for (const mode of ['major', 'minor']) {
                const profileData = profile[mode];
                const rotated = [...profileData.slice(12 - root), ...profileData.slice(0, 12 - root)];

                let score = 0;
                for (let i = 0; i < 12; i++) {
                    score += normalized[i] * rotated[i];
                }

                if (score > bestScore) {
                    bestScore = score;
                    bestKey = NOTE_NAMES[root] + (mode === 'minor' ? 'm' : '');
                }
            }
        }

        profileResults[profileName] = { key: bestKey, score: bestScore };

        if (!keyVotes[bestKey]) {
            keyVotes[bestKey] = { weightedScore: 0, voteCount: 0, profiles: [] };
        }
        keyVotes[bestKey].weightedScore += weight * bestScore;
        keyVotes[bestKey].voteCount += 1;
        keyVotes[bestKey].profiles.push(profileName);
    }

    let finalKey = null;
    let finalScore = -Infinity;
    let agreement = 0;

    for (const [key, data] of Object.entries(keyVotes)) {
        if (data.weightedScore > finalScore) {
            finalScore = data.weightedScore;
            finalKey = key;
            agreement = data.voteCount;
        }
    }

    const agreementBonus = agreement === 3 ? 1.2 : agreement === 2 ? 1.0 : 0.8;
    const confidencePercent = Math.round(finalScore * 400 * agreementBonus);

    return {
        key: finalKey,
        confidence: confidencePercent,
        score: finalScore,
        agreement,
        agreementText: agreement === 3 ? 'unanimous' : `${agreement}/3 agree`,
        profileResults,
        noteCount: total
    };
}

export function analyzeKeyChanges(midiData, options = {}) {
    const segmentDuration = options.segmentDuration || TUNER_CONFIG.segmentDurationSeconds;
    const minNotes = options.minNotes || TUNER_CONFIG.minNotesPerSegment;

    const notes = midiData.notes;
    if (!notes || notes.length === 0) {
        return [{ startTime: 0, endTime: 0, key: 'C', confidence: 0, notes: [] }];
    }

    const totalDuration = midiData.durationSeconds || 
        (notes.length > 0 ? notes[notes.length - 1].endTime : 0);

    const segments = [];
    let currentTime = 0;

    while (currentTime < totalDuration) {
        const segmentEnd = Math.min(currentTime + segmentDuration, totalDuration);
        
        const segmentNotes = notes.filter(n => 
            (n.startTime >= currentTime && n.startTime < segmentEnd) ||
            (n.startTime < currentTime && n.endTime > currentTime)
        );

        const detection = detectKeyFromNotes(segmentNotes);

        segments.push({
            startTime: currentTime,
            endTime: segmentEnd,
            startTick: segmentNotes.length > 0 ? segmentNotes[0].startTick : 0,
            endTick: segmentNotes.length > 0 ? segmentNotes[segmentNotes.length - 1].endTick : 0,
            key: detection ? detection.key : null,
            confidence: detection ? detection.confidence : 0,
            score: detection ? detection.score : 0,
            agreement: detection ? detection.agreement : 0,
            noteCount: segmentNotes.length
        });

        currentTime = segmentEnd;
    }

    const mergedSegments = mergeConsecutiveKeys(segments);
    fillMissingKeys(mergedSegments);

    return mergedSegments;
}

function mergeConsecutiveKeys(segments) {
    if (segments.length === 0) return segments;

    const merged = [segments[0]];

    for (let i = 1; i < segments.length; i++) {
        const current = segments[i];
        const previous = merged[merged.length - 1];

        if (current.key === previous.key) {
            previous.endTime = current.endTime;
            previous.endTick = current.endTick;
            previous.noteCount += current.noteCount;
            previous.confidence = Math.round((previous.confidence + current.confidence) / 2);
        } else {
            merged.push(current);
        }
    }

    return merged;
}

function fillMissingKeys(segments) {
    let firstKey = 'C';
    for (const seg of segments) {
        if (seg.key) { firstKey = seg.key; break; }
    }

    let lastKey = firstKey;
    for (const seg of segments) {
        if (!seg.key) {
            seg.key = lastKey;
            seg.confidence = 0;
        } else {
            lastKey = seg.key;
        }
    }
}

export function detectSingleKey(midiData) {
    const detection = detectKeyFromNotes(midiData.notes);
    return detection || { key: 'C', confidence: 0, agreement: 0 };
}

export function calculateJITuning(midiData, keySegments) {
    const tunedNotes = [];

    for (const note of midiData.notes) {
        const segment = keySegments.find(seg => 
            note.startTime >= seg.startTime && note.startTime < seg.endTime
        ) || keySegments[keySegments.length - 1];

        const key = segment.key;
        const keyRoot = getKeyRoot(key);
        const isMinor = isMinorKey(key);
        const ratios = isMinor ? JI_RATIOS.minor : JI_RATIOS.major;

        const interval = ((note.pitch % 12) - (keyRoot % 12) + 12) % 12;
        const ratio = ratios[interval] || 1.0;
        const centsDeviation = ratioToCentsDeviation(ratio, interval);

        tunedNotes.push({
            ...note,
            key,
            keyRoot,
            interval,
            jiRatio: ratio,
            centsDeviation,
            pitchClass: note.pitch % 12,
            pitchClassName: NOTE_NAMES[note.pitch % 12]
        });
    }

    return tunedNotes;
}

export function calculateMTSScaleTuning(key) {
    const keyRoot = getKeyRoot(key);
    const isMinor = isMinorKey(key);
    const ratios = isMinor ? JI_RATIOS.minor : JI_RATIOS.major;

    const centsArray = new Array(12).fill(0);

    for (let pc = 0; pc < 12; pc++) {
        const interval = (pc - (keyRoot % 12) + 12) % 12;
        const ratio = ratios[interval] || 1.0;
        centsArray[pc] = ratioToCentsDeviation(ratio, interval);
    }

    return centsArray;
}

export function processMIDIForJI(midiData, options = {}) {
    const multiKey = options.multiKey !== false;
    const manualKey = options.manualKey || null;

    let keySegments;

    if (manualKey) {
        keySegments = [{
            startTime: 0,
            endTime: midiData.durationSeconds,
            startTick: 0,
            endTick: midiData.tracks.reduce((max, t) => 
                Math.max(max, ...t.notes.map(n => n.endTick)), 0),
            key: manualKey,
            confidence: 100,
            agreement: 3,
            noteCount: midiData.notes.length,
            source: 'manual'
        }];
    } else if (multiKey) {
        keySegments = analyzeKeyChanges(midiData);
    } else {
        const detection = detectSingleKey(midiData);
        keySegments = [{
            startTime: 0,
            endTime: midiData.durationSeconds,
            startTick: 0,
            endTick: midiData.tracks.reduce((max, t) => 
                Math.max(max, ...t.notes.map(n => n.endTick)), 0),
            key: detection.key,
            confidence: detection.confidence,
            agreement: detection.agreement,
            noteCount: midiData.notes.length,
            source: 'auto-single'
        }];
    }

    const tunedNotes = calculateJITuning(midiData, keySegments);

    const summary = {
        totalNotes: midiData.notes.length,
        durationSeconds: midiData.durationSeconds,
        keyChanges: keySegments.length,
        keys: keySegments.map(s => ({
            key: s.key,
            startTime: s.startTime,
            endTime: s.endTime,
            confidence: s.confidence
        })),
        averageConfidence: Math.round(
            keySegments.reduce((sum, s) => sum + s.confidence, 0) / keySegments.length
        )
    };

    return { tunedNotes, keySegments, summary, originalMidiData: midiData };
}

export { NOTE_NAMES, detectKeyFromNotes, TUNER_CONFIG };
