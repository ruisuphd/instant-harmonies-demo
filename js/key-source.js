// Key-source policy (KS1, 2026-07-17) — selects which detector drives the
// tonal centre used by the tuning engine.
//
// Modes:
//   auto      — research default: score-informed key while the two-stage
//               system follows an identified score; otherwise the neural
//               harmonic-context model (T6_T1 GRU) while its prediction is
//               fresh; otherwise the classical profile ensemble.
//   gru       — neural model only. Sticky: holds the last prediction rather
//               than falling back to another detector, so an ablation run is
//               never silently contaminated by a different key source.
//   classical — causal profile ensemble only (Albrecht–Shanahan 2013 /
//               Temperley 1999 / Krumhansl–Kessler 1982).
//   manual    — fixed tonal centre chosen by the performer; detection is
//               bypassed entirely.
//
// The resolver is a pure function so the policy is unit-testable (AT-16);
// js/main.js supplies the live context and applies the result through the
// continuity-anchoring layer (A1), which operates identically in every mode.

export const KEY_SOURCE_MODES = ['auto', 'gru', 'classical', 'manual'];

/**
 * Resolve the tonal centre under a given policy.
 *
 * @param {string} mode - one of KEY_SOURCE_MODES; unknown values behave as 'auto'
 * @param {object} ctx
 *   scoreFollowingActive {boolean} - two-stage system locked onto a score
 *   musicXMLKey {string|null}      - key signature from the identified score
 *   gruKey {string|null}           - latest neural-model prediction
 *   gruFresh {boolean}             - prediction younger than its TTL
 *   ensembleKey {string|null}      - classical ensemble's current key
 *   manualKey {string|null}        - user-fixed key
 * @returns {{key: string, source: string}|null}
 *   source ∈ 'musicxml' | 'gru' | 'ensemble' | 'manual'; null = no key yet
 *   (the engine passes notes through untuned at 12-TET until one exists)
 */
export function resolveKeySource(mode, ctx = {}) {
    switch (mode) {
        case 'manual':
            return ctx.manualKey ? { key: ctx.manualKey, source: 'manual' } : null;
        case 'gru':
            return ctx.gruKey ? { key: ctx.gruKey, source: 'gru' } : null;
        case 'classical':
            return ctx.ensembleKey ? { key: ctx.ensembleKey, source: 'ensemble' } : null;
        case 'auto':
        default:
            if (ctx.scoreFollowingActive && ctx.musicXMLKey) {
                return { key: ctx.musicXMLKey, source: 'musicxml' };
            }
            if (ctx.gruKey && ctx.gruFresh) {
                return { key: ctx.gruKey, source: 'gru' };
            }
            if (ctx.ensembleKey) {
                return { key: ctx.ensembleKey, source: 'ensemble' };
            }
            return null;
    }
}

// Display strings shared by main.js UI updates (single source of truth).
export const KEY_SOURCE_DISPLAY = {
    musicxml: 'Source: score (MusicXML key signature)',
    gru: 'Source: GRU harmonic model (T6_T1)',
    ensemble: 'Source: classical ensemble (causal)',
    manual: 'Source: manual (fixed tonal centre)',
};
