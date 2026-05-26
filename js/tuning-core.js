// Tuning Core - 5-limit Just Intonation ratios and conversion utilities
// 5-limit JI uses factors of 2, 3, and 5 only, giving pure thirds and fifths

import { NOTE_NAMES } from './key-detection.js';

export const JI_RATIOS = {
    major: {
        0: 1/1,      // Unison
        1: 16/15,    // Minor 2nd
        2: 9/8,      // Major 2nd
        3: 6/5,      // Minor 3rd
        4: 5/4,      // Major 3rd
        5: 4/3,      // Perfect 4th
        6: 45/32,    // Tritone
        7: 3/2,      // Perfect 5th
        8: 8/5,      // Minor 6th
        9: 5/3,      // Major 6th
        10: 9/5,     // Minor 7th
        11: 15/8,    // Major 7th
        12: 2/1      // Octave
    },
    minor: {
        0: 1/1,
        1: 16/15,
        2: 9/8,
        3: 6/5,
        4: 5/4,
        5: 4/3,
        6: 45/32,
        7: 3/2,
        8: 8/5,
        9: 5/3,
        10: 16/9,    // Minor 7th (different from major)
        11: 15/8,
        12: 2/1
    }
};

const KEY_ROOTS = {
    'C': 60, 'C#': 61, 'Db': 61, 'D': 62, 'D#': 63, 'Eb': 63,
    'E': 64, 'F': 65, 'F#': 66, 'Gb': 66, 'G': 67, 'G#': 68,
    'Ab': 68, 'A': 69, 'A#': 70, 'Bb': 70, 'B': 71,
    'Cm': 60, 'C#m': 61, 'Dm': 62, 'D#m': 63, 'Ebm': 63,
    'Em': 64, 'Fm': 65, 'F#m': 66, 'Gm': 67, 'G#m': 68,
    'Am': 69, 'A#m': 70, 'Bbm': 70, 'Bm': 71
};

export function getKeyRoot(keyName) {
    return KEY_ROOTS[keyName] || 60;
}

export function isMinorKey(keyName) {
    return keyName && keyName.includes('m');
}

// Standard pitch bend range: ±2 semitones = ±200 cents
// MIDI pitch bend range: -8192 to +8191

export function centsToPitchBend(cents) {
    const pitchBend = Math.round((cents / 200) * 8192);
    return Math.max(-8192, Math.min(8191, pitchBend));
}

export function pitchBendToCents(pitchBend) {
    return (pitchBend / 8192) * 200;
}

// Calculate how many cents a JI ratio differs from equal temperament
export function ratioToCentsDeviation(ratio, interval) {
    const jiCents = 1200 * Math.log2(ratio);
    const etCents = interval * 100;
    return jiCents - etCents;
}

export function calculateJICentsForNote(midiNote, keyName) {
    const keyRoot = getKeyRoot(keyName);
    const ratios = isMinorKey(keyName) ? JI_RATIOS.minor : JI_RATIOS.major;
    // F4 polish (2026-04-19): canonical positive-modulo for (midiNote - keyRoot)
    // over 12 pitch classes. Prior form used "+ 144" (12×12) as a safe offset;
    // this idiom is more readable and has identical behaviour for any int input.
    const interval = ((midiNote - keyRoot) % 12 + 12) % 12;
    const ratio = ratios[interval] || 1.0;

    return ratioToCentsDeviation(ratio, interval);
}

export function calculateJIPitchBend(midiNote, keyName) {
    const cents = calculateJICentsForNote(midiNote, keyName);
    return centsToPitchBend(cents);
}

// Generate 12-note scale tuning array for MTS (cents deviation per pitch class)
export function calculateScaleOctaveTuning(keyRoot, isMinor) {
    const ratios = isMinor ? JI_RATIOS.minor : JI_RATIOS.major;
    const centsArray = new Array(12).fill(0);
    
    for (let pc = 0; pc < 12; pc++) {
        const interval = (pc - (keyRoot % 12) + 12) % 12;
        const ratio = ratios[interval] || 1.0;
        const jiCents = 1200 * Math.log2(ratio);
        const etCents = interval * 100;
        const deviation = jiCents - etCents;
        centsArray[pc] = Math.round(deviation * 100) / 100;
    }
    
    return centsArray;
}

const INTERVAL_NAMES = [
    'Unison', 'Minor 2nd', 'Major 2nd', 'Minor 3rd', 
    'Major 3rd', 'Perfect 4th', 'Tritone', 'Perfect 5th',
    'Minor 6th', 'Major 6th', 'Minor 7th', 'Major 7th'
];

export function getIntervalInfo(interval, isMinor = false) {
    const ratios = isMinor ? JI_RATIOS.minor : JI_RATIOS.major;
    const ratio = ratios[interval] || 1.0;
    const deviation = ratioToCentsDeviation(ratio, interval);
    
    return {
        name: INTERVAL_NAMES[interval],
        ratio,
        ratioString: ratioToString(ratio),
        cents: Math.round(deviation * 100) / 100
    };
}

function ratioToString(ratio) {
    const knownRatios = {
        [1/1]: '1/1', [16/15]: '16/15', [9/8]: '9/8', [6/5]: '6/5',
        [5/4]: '5/4', [4/3]: '4/3', [45/32]: '45/32', [3/2]: '3/2',
        [8/5]: '8/5', [5/3]: '5/3', [9/5]: '9/5', [16/9]: '16/9',
        [15/8]: '15/8', [2/1]: '2/1'
    };
    
    return knownRatios[ratio] || ratio.toFixed(4);
}

export function generateTuningTable(keyName) {
    const isMinor = isMinorKey(keyName);
    const table = [];

    for (let interval = 0; interval < 12; interval++) {
        const info = getIntervalInfo(interval, isMinor);
        const keyRoot = getKeyRoot(keyName);
        const notePc = (keyRoot + interval) % 12;

        table.push({
            interval,
            noteName: NOTE_NAMES[notePc],
            ...info
        });
    }

    return table;
}

// =========================================================================
// Chord-Function-Aware JI Ratio Tables (7-limit extension)
// =========================================================================
//
// When the harmonic function (Roman numeral) is known, we can select
// JI ratios relative to the chord root rather than the key tonic.
// This enables 7-limit intervals for dominant contexts (septimal 7/4)
// and correct tuning of chord tones in non-tonic harmonies.

/**
 * Chord-specific JI ratio tables.
 * Keys are intervals (0-11) above the chord root; values are frequency ratios.
 * Non-chord tones fall back to the key-based ratio.
 */
export const CHORD_JI_RATIOS = {
    // Dominant 7th: uses septimal minor seventh (7/4 = 968.8 cents)
    dominant7:   { 0: 1/1, 4: 5/4, 7: 3/2, 10: 7/4 },
    // Major triad: pure 5-limit
    major:       { 0: 1/1, 4: 5/4, 7: 3/2 },
    // Minor triad: pure 5-limit
    minor:       { 0: 1/1, 3: 6/5, 7: 3/2 },
    // Diminished triad: 7-limit tritone (7/5 = 582.5 cents)
    diminished:  { 0: 1/1, 3: 6/5, 6: 7/5 },
    // Augmented triad: 5-limit augmented fifth
    augmented:   { 0: 1/1, 4: 5/4, 8: 25/16 },
    // Minor 7th chord: 5-limit
    minor7:      { 0: 1/1, 3: 6/5, 7: 3/2, 10: 9/5 },
    // Major 7th chord: 5-limit
    major7:      { 0: 1/1, 4: 5/4, 7: 3/2, 11: 15/8 },
    // Half-diminished 7th: 5-limit
    halfDim7:    { 0: 1/1, 3: 6/5, 6: 45/32, 10: 9/5 },
    // Fully diminished 7th: 7-limit
    dim7:        { 0: 1/1, 3: 6/5, 6: 7/5, 9: 12/7 },
};

/**
 * Calculate JI pitch bend using chord-function context.
 *
 * When chordInfo is provided, chord tones are tuned relative to the chord root
 * using the chord-specific ratio table. Non-chord tones fall back to the
 * key-based tuning from calculateJICentsForNote().
 *
 * @param {number} midiNote - MIDI note number (0-127)
 * @param {string} keyName - Current key (e.g., "C", "Am")
 * @param {object|null} chordInfo - Optional chord context:
 *   - chordRootPc {number}: pitch class of chord root (0-11)
 *   - chordQuality {string}: key into CHORD_JI_RATIOS (e.g., "dominant7", "major")
 * @returns {{ cents: number, source: string }}
 *   cents: deviation from 12-TET
 *   source: "chord" if chord-relative ratio used, "key" if key-based fallback
 */
export function calculateJICentsWithFunction(midiNote, keyName, chordInfo) {
    // Fallback: no chord context → use key-based tuning
    if (!chordInfo || !chordInfo.chordRootPc === undefined || !chordInfo.chordQuality) {
        return { cents: calculateJICentsForNote(midiNote, keyName), source: 'key' };
    }

    const { chordRootPc, chordQuality } = chordInfo;
    const chordRatios = CHORD_JI_RATIOS[chordQuality];

    if (!chordRatios) {
        return { cents: calculateJICentsForNote(midiNote, keyName), source: 'key' };
    }

    // Compute interval of the note relative to the chord root
    const notePC = midiNote % 12;
    const intervalFromChordRoot = (notePC - chordRootPc + 12) % 12;

    // Check if this interval exists in the chord ratio table (i.e., is a chord tone)
    if (chordRatios[intervalFromChordRoot] !== undefined) {
        const ratio = chordRatios[intervalFromChordRoot];
        const jiCents = 1200 * Math.log2(ratio);
        const etCents = intervalFromChordRoot * 100;
        const chordToneCentsDev = jiCents - etCents;

        // Also account for the chord root's own deviation from 12-TET
        // relative to the current key
        const keyRoot = getKeyRoot(keyName);
        const rootIntervalFromKey = (chordRootPc - (keyRoot % 12) + 12) % 12;
        const keyRatios = isMinorKey(keyName) ? JI_RATIOS.minor : JI_RATIOS.major;
        const rootRatio = keyRatios[rootIntervalFromKey] || 1.0;
        const rootJiCents = 1200 * Math.log2(rootRatio);
        const rootEtCents = rootIntervalFromKey * 100;
        const rootCentsDev = rootJiCents - rootEtCents;

        // Total deviation = chord-root deviation + chord-tone deviation
        return { cents: rootCentsDev + chordToneCentsDev, source: 'chord' };
    }

    // Not a chord tone → fall back to key-based tuning
    return { cents: calculateJICentsForNote(midiNote, keyName), source: 'key' };
}

/**
 * Convenience wrapper returning MIDI pitch bend value.
 */
export function calculateJIPitchBendWithFunction(midiNote, keyName, chordInfo) {
    const { cents } = calculateJICentsWithFunction(midiNote, keyName, chordInfo);
    return centsToPitchBend(cents);
}


// =========================================================================
// Comma Drift Tracking and Correction
// =========================================================================
//
// Sequential 5-limit JI adjustments accumulate syntonic comma drift
// (21.5 cents) over chromatic passages. This tracker monitors cumulative
// deviation per pitch class and resets when drift exceeds a threshold.
//
// Reference: Stange et al., "Playing Music in Just Intonation: A
// Dynamically Adaptive Tuning Scheme" (CMJ 42(3), 2018, arXiv:1706.04338).

const DRIFT_THRESHOLD_CENTS = 35.0;

export class CommaDriftTracker {
    /**
     * @param {number} thresholdCents - Drift threshold before gradual reset
     * @param {number} smoothingNotes - Number of notes over which to spread correction
     */
    constructor(thresholdCents = DRIFT_THRESHOLD_CENTS, smoothingNotes = 3) {
        this.thresholdCents = thresholdCents;
        this.smoothingNotes = smoothingNotes;

        // Single running total: sum of (JI_cents - ET_cents) across sequential notes
        this.cumulativeDrift = 0.0;
        // Per-pitch-class drift retained for backward-compatible diagnostics
        this.perPcDrift = new Float64Array(12);

        this.resetCount = 0;

        // Gradual-reset internal state
        this._resetRemaining = 0;   // smoothing notes left in current correction
        this._resetPerNote = 0.0;   // cents correction applied per note during reset
    }

    /**
     * Apply JI tuning with interval-sequential drift correction.
     *
     * Instead of abruptly snapping to ET when drift exceeds the threshold,
     * the correction is spread over the next `smoothingNotes` notes.
     *
     * @param {number} midiNote - MIDI note number (0-127)
     * @param {string} keyName - Current key (e.g., "C", "Am")
     * @returns {{ cents: number, driftCorrected: boolean }}
     */
    applyWithDriftCorrection(midiNote, keyName) {
        const pc = midiNote % 12;
        const rawCents = calculateJICentsForNote(midiNote, keyName);

        // Update per-pitch-class drift (diagnostics only)
        this.perPcDrift[pc] += rawCents;

        // --- Currently in gradual-reset phase ---
        if (this._resetRemaining > 0) {
            const adjustedCents = rawCents + this._resetPerNote;
            this._resetRemaining--;
            this.cumulativeDrift += adjustedCents;
            return { cents: adjustedCents, driftCorrected: true };
        }

        // --- Normal path ---
        this.cumulativeDrift += rawCents;

        if (Math.abs(this.cumulativeDrift) >= this.thresholdCents) {
            // Begin gradual reset: spread correction over smoothingNotes
            this._resetPerNote = -this.cumulativeDrift / this.smoothingNotes;
            this._resetRemaining = this.smoothingNotes;
            this.resetCount++;

            // Apply first correction immediately
            const adjustedCents = rawCents + this._resetPerNote;
            this._resetRemaining--;
            // Recompute cumulative drift: undo the raw addition, add adjusted instead
            this.cumulativeDrift = this.cumulativeDrift - rawCents + adjustedCents;
            return { cents: adjustedCents, driftCorrected: true };
        }

        return { cents: rawCents, driftCorrected: false };
    }

    /**
     * Reset all drift tracking (e.g., on key change or piece start).
     */
    reset() {
        this.cumulativeDrift = 0.0;
        this.perPcDrift.fill(0.0);
        this.resetCount = 0;
        this._resetRemaining = 0;
        this._resetPerNote = 0.0;
    }

    /**
     * Get current drift state for diagnostics.
     */
    getDriftState() {
        return {
            cumulativeDrift: this.cumulativeDrift,
            driftPerPitchClass: Array.from(this.perPcDrift),
            maxPcDrift: Math.max(...Array.from(this.perPcDrift).map(Math.abs)),
            resetCount: this.resetCount,
            inReset: this._resetRemaining > 0,
        };
    }
}
