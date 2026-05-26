// Key Detection - Ensemble method using established key-finding profiles
//
// References:
// - Albrecht & Shanahan (2013). Music Perception, 31(1), 59-67.
// - Temperley (1999). Music Perception, 17(1), 65-100.
// - Krumhansl & Kessler (1982). Psychological Review, 89(4), 334-368.

// Albrecht-Shanahan (2013) - corpus-derived from 490 common-practice pieces
// Reported 91.3% accuracy; their meta-algorithm achieved 95.1%
export const ALBRECHT_SHANAHAN_PROFILES = {
    major: [0.238, 0.006, 0.111, 0.006, 0.137, 0.094, 0.016, 0.214, 0.009, 0.080, 0.008, 0.081],
    minor: [0.220, 0.006, 0.104, 0.123, 0.019, 0.103, 0.012, 0.214, 0.062, 0.022, 0.061, 0.052]
};

// Temperley-style profiles (normalized). Key principles from Temperley (1999):
// larger diatonic/chromatic gap, harmonic minor assumption, low weight for flat-7
export const TEMPERLEY_PROFILES = {
    major: [0.176, 0.014, 0.115, 0.019, 0.158, 0.108, 0.023, 0.168, 0.024, 0.086, 0.013, 0.094],
    minor: [0.170, 0.020, 0.113, 0.148, 0.012, 0.110, 0.025, 0.179, 0.097, 0.016, 0.032, 0.079]
};

// Krumhansl-Kessler (1982) - probe-tone profiles from listener experiments
// Known issues: small diatonic/chromatic gap, tendency toward relative major for minor pieces
export const KRUMHANSL_KESSLER_PROFILES = {
    major: [0.152, 0.053, 0.083, 0.056, 0.105, 0.098, 0.060, 0.124, 0.057, 0.088, 0.055, 0.069],
    minor: [0.142, 0.060, 0.079, 0.121, 0.058, 0.079, 0.057, 0.107, 0.089, 0.060, 0.075, 0.071]
};

// Weights reflect relative reliability. Albrecht & Shanahan showed combining algorithms
// yields better results (95.1% meta vs 91.3% single). Kania et al. (2024, Archives of
// Acoustics 49(4)) emphasizes stability for real-time applications.
export const ENSEMBLE_CONFIG = {
    profiles: {
        albrecht_shanahan: { data: ALBRECHT_SHANAHAN_PROFILES, weight: 0.45 },
        temperley: { data: TEMPERLEY_PROFILES, weight: 0.35 },
        krumhansl_kessler: { data: KRUMHANSL_KESSLER_PROFILES, weight: 0.20 }
    },
    threshold: 0.04
};

export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

const KEY_CANDIDATES = NOTE_NAMES.flatMap((root) => [root, `${root}m`]);

const DETECTOR_CONFIG = {
    high: {
        scoreThreshold: 0.037,
        marginThreshold: 0.0045,
        momentum: 0.45,
        candidateStreak: 1,
        decayMs: 900,
        activeNoteWeight: 0.9,
        forceMargin: 0.008
    },
    medium: {
        scoreThreshold: 0.039,
        marginThreshold: 0.006,
        momentum: 0.65,
        candidateStreak: 2,
        decayMs: 1400,
        activeNoteWeight: 1.15,
        forceMargin: 0.011
    },
    low: {
        scoreThreshold: 0.041,
        marginThreshold: 0.008,
        momentum: 0.8,
        candidateStreak: 3,
        decayMs: 2000,
        activeNoteWeight: 1.35,
        forceMargin: 0.014
    }
};

function getDetectorConfig(sensitivity = 'medium') {
    return DETECTOR_CONFIG[sensitivity] || DETECTOR_CONFIG.medium;
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function createEmptyScoreMap() {
    return Object.fromEntries(KEY_CANDIDATES.map((key) => [key, 0]));
}

function sortScoreMap(scoreMap) {
    return Object.entries(scoreMap)
        .map(([key, score]) => ({ key, score }))
        .sort((a, b) => b.score - a.score);
}

export class KeyDetector {
    constructor() {
        this.currentKey = null;
        this.currentConfidence = 0;
        this.pendingCandidate = null;
        this.pendingCandidateCount = 0;
        this.smoothedScores = createEmptyScoreMap();
        this.lastAnalysis = null;
    }

    detectKey(noteBuffer, sensitivity = 'medium', options = {}) {
        return this.detectKeyEnsemble(noteBuffer, sensitivity, options);
    }

    detectKeyEnsemble(noteBuffer, sensitivity = 'medium', options = {}) {
        const config = getDetectorConfig(sensitivity);
        const activeNotes = Array.isArray(options.activeNotes) ? options.activeNotes : [];

        const histogramResult = this.buildWeightedHistogram(noteBuffer, config, activeNotes);
        if (histogramResult.totalWeight === 0) return null;

        const { combinedScores, profileResults, keyVotes } = this.scoreCandidates(histogramResult.normalizedHistogram);
        const smoothedScores = this.applySmoothing(combinedScores, config.momentum);
        const rankedCandidates = sortScoreMap(smoothedScores);
        const bestCandidate = rankedCandidates[0];
        const runnerUp = rankedCandidates[1] || { key: null, score: 0 };

        if (!bestCandidate) return null;

        const agreement = keyVotes[bestCandidate.key]?.voteCount || 0;
        const margin = bestCandidate.score - runnerUp.score;
        const confidencePercent = this.calculateConfidence(bestCandidate.score, margin, agreement, config);
        const agreementText = agreement === 3 ? 'unanimous' : `${agreement}/3 agree`;

        this.lastAnalysis = {
            noteWeight: histogramResult.totalWeight,
            histogram: histogramResult.weightedHistogram,
            normalizedHistogram: histogramResult.normalizedHistogram,
            profileResults,
            topCandidates: rankedCandidates.slice(0, 5).map(({ key, score }) => ({
                key,
                score: Math.round(score * 10000) / 10000
            })),
            bestKey: bestCandidate.key,
            bestScore: bestCandidate.score,
            runnerUp: runnerUp.key,
            runnerUpScore: runnerUp.score,
            margin,
            agreement,
            currentKey: this.currentKey,
            pendingCandidate: this.pendingCandidate
        };

        this.currentConfidence = confidencePercent;

        if (bestCandidate.key === this.currentKey) {
            this.pendingCandidate = null;
            this.pendingCandidateCount = 0;
            return null;
        }

        const meetsThreshold = bestCandidate.score >= config.scoreThreshold;
        const meetsMargin = margin >= config.marginThreshold;
        const forceSwitch = meetsThreshold && margin >= config.forceMargin;

        if (!this.currentKey && meetsThreshold) {
            this.currentKey = bestCandidate.key;
            return {
                key: bestCandidate.key,
                confidence: confidencePercent,
                agreement,
                agreementText,
                profileResults,
                topCandidates: this.lastAnalysis.topCandidates,
                margin: Math.round(margin * 10000) / 10000,
                method: 'causal_ensemble'
            };
        }

        if (!(meetsThreshold && meetsMargin)) {
            if (bestCandidate.key !== this.pendingCandidate) {
                this.pendingCandidate = null;
                this.pendingCandidateCount = 0;
            }
            return null;
        }

        if (bestCandidate.key === this.pendingCandidate) {
            this.pendingCandidateCount += 1;
        } else {
            this.pendingCandidate = bestCandidate.key;
            this.pendingCandidateCount = 1;
        }

        if (!forceSwitch && this.pendingCandidateCount < config.candidateStreak) {
            return null;
        }

        this.currentKey = bestCandidate.key;
        this.pendingCandidate = null;
        this.pendingCandidateCount = 0;

        return {
            key: bestCandidate.key,
            confidence: confidencePercent,
            agreement,
            agreementText,
            profileResults,
            topCandidates: this.lastAnalysis.topCandidates,
            margin: Math.round(margin * 10000) / 10000,
            method: 'causal_ensemble'
        };
    }

    buildWeightedHistogram(noteBuffer, config, activeNotes = []) {
        const weightedHistogram = new Array(12).fill(0);
        const now = Date.now();

        noteBuffer.forEach((noteEvent) => {
            const note = noteEvent.note;
            if (typeof note !== 'number') return;

            const ageMs = typeof noteEvent.time === 'number' ? Math.max(0, now - noteEvent.time) : 0;
            const recencyWeight = Math.exp(-ageMs / config.decayMs);
            const velocity = typeof noteEvent.velocity === 'number' ? noteEvent.velocity : 96;
            const velocityWeight = 0.7 + ((velocity / 127) * 0.6);

            weightedHistogram[note % 12] += recencyWeight * velocityWeight;
        });

        activeNotes.forEach((note) => {
            if (typeof note !== 'number') return;
            weightedHistogram[note % 12] += config.activeNoteWeight;
        });

        const totalWeight = weightedHistogram.reduce((sum, value) => sum + value, 0);
        const normalizedHistogram = totalWeight > 0
            ? weightedHistogram.map((value) => value / totalWeight)
            : weightedHistogram;

        return { weightedHistogram, normalizedHistogram, totalWeight };
    }

    scoreCandidates(normalizedHistogram) {
        const combinedScores = createEmptyScoreMap();
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
                        score += normalizedHistogram[i] * rotated[i];
                    }

                    const keyName = NOTE_NAMES[root] + (mode === 'minor' ? 'm' : '');
                    combinedScores[keyName] += score * weight;

                    if (score > bestScore) {
                        bestScore = score;
                        bestKey = keyName;
                    }
                }
            }

            profileResults[profileName] = { key: bestKey, score: bestScore };

            if (!keyVotes[bestKey]) {
                keyVotes[bestKey] = { voteCount: 0, profiles: [] };
            }
            keyVotes[bestKey].voteCount += 1;
            keyVotes[bestKey].profiles.push(profileName);
        }

        return { combinedScores, profileResults, keyVotes };
    }

    applySmoothing(rawScores, momentum) {
        const nextScores = createEmptyScoreMap();

        for (const key of KEY_CANDIDATES) {
            const previous = this.smoothedScores[key] || 0;
            const current = rawScores[key] || 0;
            nextScores[key] = (previous * momentum) + (current * (1 - momentum));
        }

        this.smoothedScores = nextScores;
        return nextScores;
    }

    calculateConfidence(score, margin, agreement, config) {
        const scoreComponent = clamp((score - config.scoreThreshold) / 0.03, 0, 1);
        const marginComponent = clamp(margin / (config.marginThreshold * 3), 0, 1);
        const agreementComponent = agreement / 3;
        return Math.round((scoreComponent * 0.55 + marginComponent * 0.30 + agreementComponent * 0.15) * 100);
    }

    getEnsembleAnalysis(noteBuffer, sensitivity = 'medium', options = {}) {
        if (noteBuffer.length < 8) {
            return { error: 'Insufficient notes for analysis' };
        }

        const config = getDetectorConfig(sensitivity);
        const activeNotes = Array.isArray(options.activeNotes) ? options.activeNotes : [];
        const histogramResult = this.buildWeightedHistogram(noteBuffer, config, activeNotes);
        const { combinedScores, profileResults } = this.scoreCandidates(histogramResult.normalizedHistogram);
        const topCandidates = sortScoreMap(combinedScores).slice(0, 5);

        return {
            noteWeight: histogramResult.totalWeight,
            histogram: histogramResult.weightedHistogram,
            normalizedHistogram: histogramResult.normalizedHistogram,
            profileResults,
            topCandidates: topCandidates.map(({ key, score }) => ({
                key,
                score: Math.round(score * 10000) / 10000
            })),
            currentKey: this.currentKey,
            currentConfidence: this.currentConfidence,
            pendingCandidate: this.pendingCandidate
        };
    }

    getCurrentKey() {
        return this.currentKey;
    }

    getCurrentConfidence() {
        return this.currentConfidence;
    }

    getLastAnalysis() {
        return this.lastAnalysis;
    }

    reset() {
        this.currentKey = null;
        this.currentConfidence = 0;
        this.pendingCandidate = null;
        this.pendingCandidateCount = 0;
        this.smoothedScores = createEmptyScoreMap();
        this.lastAnalysis = null;
    }
}

export const keyDetector = new KeyDetector();
