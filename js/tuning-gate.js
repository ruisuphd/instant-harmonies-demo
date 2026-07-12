// MTS table gate (G1 fix, 2026-07-12) — defer bulk Scale/Octave retunes to
// note boundaries.
//
// An MTS Scale/Octave SysEx retunes SOUNDING notes instantly on compliant
// receivers. Sent mid-texture (the detector switches keys on a note-on, i.e.
// while at least one key is down — and in the SMC2026 recordings always under
// pedal), the table change stepped ringing notes by up to ±25 c. The gate
// holds the latest table until the texture clears (no held keys, no
// pedal-ringing notes) and transmits it then, when a retune is inaudible.
//
// Interim correctness: while a table is pending, every NEW note-on is tuned
// individually via the MTS single-note real-time message (see
// forwardNoteExternal in main.js), so attacks always sound at the anchored
// tuning; only the bulk base-table sync waits for silence. Newer submissions
// overwrite older pending ones — only the latest table is ever sent.

export class MTSTableGate {
    /**
     * @param {(table: number[], label: string) => void} sendFn - transmits a
     *   12-value cents table (e.g. mts.applyJITuningTable bound to the output)
     */
    constructor(sendFn) {
        this.sendFn = sendFn;
        this.pending = null;
    }

    /**
     * Submit a table for transmission. Sends immediately when the texture is
     * quiet; otherwise queues it (replacing any older pending table).
     * @returns {boolean} true if sent now, false if queued
     */
    submit(table, label, textureBusy) {
        if (!table) return false;
        if (textureBusy) {
            this.pending = { table, label };
            return false;
        }
        this.pending = null;
        this.sendFn(table, label);
        return true;
    }

    /**
     * Transmit the pending table if the texture has cleared.
     * Call on note-off and on pedal-up.
     * @returns {boolean} true if a pending table was sent
     */
    flush(textureBusy) {
        if (!this.pending || textureBusy) return false;
        const { table, label } = this.pending;
        this.pending = null;
        this.sendFn(table, label);
        return true;
    }

    hasPending() {
        return this.pending !== null;
    }

    reset() {
        this.pending = null;
    }
}
