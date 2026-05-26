// MPE Microtuning - per-note pitch bend via channel rotation
// Fallback when MTS SysEx is not available
//
// Channel map (MPE lower-zone convention):
//   MASTER_CHANNEL = 0   → global/master messages (MCM, MPE Configuration)
//   MEMBER_CHANNELS = [1..15] → per-note allocation pool for pitch-bent notes
//
// State model (F1 fix, 2026-04-19): activeNotes stores {channel, pitch} per
// noteId so that voice-stealing can emit a correct note-off for the stolen
// note on its original channel BEFORE the new note-on on the same channel.
// Prior version stored only noteId→channel, leaving stolen notes silently
// hanging on the synth — the primary "MPE sounds off" root cause per the
// engine review in research_data/engine_review_2026-04-19.md.

export const MPE_MASTER_CHANNEL = 0;
export const MPE_MEMBER_CHANNELS = Array.from({ length: 15 }, (_, i) => i + 1);

let channelPool = [...MPE_MEMBER_CHANNELS];
let activeNotes = new Map();     // noteId -> {channel, pitch}
let channelUsageOrder = [];      // oldest-first for LRU voice stealing
let pitchBendRangeInitialized = false;

export function resetMPEState() {
    channelPool = [...MPE_MEMBER_CHANNELS];
    activeNotes = new Map();
    channelUsageOrder = [];
    pitchBendRangeInitialized = false;
}

export function isPitchBendRangeInitialized() {
    return pitchBendRangeInitialized;
}

// MPE initialization sequence (F3 fix, 2026-04-19):
//   1. MCM (MPE Configuration Message) on master channel — tells receiver to
//      enter MPE mode with N member channels on the lower zone.
//      CC 127 (0x7F) + data = N (0..15). MMA/AMEI RP-053 2018.
//   2. Per-member-channel RPN 0 + Data Entry MSB = 2 — sets pitch-bend range
//      to ±2 semitones per note. Matches tuning-core.js:centsToPitchBend scaling.
//
// Without MCM (prior behaviour), synths that require strict MPE compliance
// (ROLI Equator², Pianoteq MPE mode, Ableton 12+) may ignore per-channel
// RPN messages and apply pitch bends globally, causing every channel's
// detuning to "sum" and produce chordal out-of-tune artefacts.
export function initializePitchBendRange(midiOutput) {
    if (!midiOutput) {
        console.warn('Cannot initialize MPE pitch bend range: no MIDI output');
        return false;
    }

    if (pitchBendRangeInitialized) {
        console.log('MPE pitch bend range already initialized');
        return true;
    }

    console.log('Initializing MPE: MCM + pitch-bend range ±2 semitones on 15 member channels...');

    try {
        // 1. MCM: tell the receiver to enter MPE mode (lower zone, 15 member channels)
        //    CC 127 on master channel; data = number of member channels.
        midiOutput.send([0xB0 | MPE_MASTER_CHANNEL, 127, 15]);

        // 2. Per-member-channel pitch-bend range via RPN 0
        for (const channel of MPE_MEMBER_CHANNELS) {
            midiOutput.send([0xB0 | channel, 101, 0]);    // RPN MSB = 0
            midiOutput.send([0xB0 | channel, 100, 0]);    // RPN LSB = 0
            midiOutput.send([0xB0 | channel, 6, 2]);      // Data Entry MSB = 2 semitones
            midiOutput.send([0xB0 | channel, 38, 0]);     // Data Entry LSB = 0
            midiOutput.send([0xB0 | channel, 101, 127]);  // Reset RPN to null
            midiOutput.send([0xB0 | channel, 100, 127]);
        }

        pitchBendRangeInitialized = true;
        console.log('MPE init complete: MCM sent, pitch-bend range ±2 semitones on 15 channels');
        return true;
    } catch (error) {
        console.error('Failed to initialize MPE:', error);
        return false;
    }
}

// LRU channel allocation with pitch-tracking (F1 fix, 2026-04-19).
//
// Returns one of:
//   null                              — allocation failed (shouldn't happen)
//   number                            — channel allocated cleanly (no stealing)
//   {channel, reusedNoteId, stolenPitch} — channel stolen from an older note;
//        caller MUST send note-off for stolenPitch on `channel` BEFORE the new
//        note-on, otherwise the synth leaves the old note hanging.
//
// `pitch` must be the MIDI note number of the note-on this allocation is for.
// Required so voice-stealing can correctly identify the hanging note to release.
export function allocateChannel(noteId, pitch) {
    if (!noteId) return null;

    // Re-use same channel if this noteId is already active (idempotent)
    if (activeNotes.has(noteId)) {
        const index = channelUsageOrder.indexOf(noteId);
        if (index > -1) channelUsageOrder.splice(index, 1);
        channelUsageOrder.push(noteId);
        return activeNotes.get(noteId).channel;
    }

    let channel = channelPool.length > 0 ? channelPool.shift() : null;

    // All channels busy — steal the oldest one (LRU)
    if (channel === null && channelUsageOrder.length > 0) {
        const reusedNoteId = channelUsageOrder.shift();
        const stolen = activeNotes.get(reusedNoteId) || {};
        channel = stolen.channel;
        const stolenPitch = stolen.pitch;
        activeNotes.delete(reusedNoteId);
        activeNotes.set(noteId, { channel, pitch });
        channelUsageOrder.push(noteId);

        console.warn(`MPE channel ${channel} stolen from noteId=${reusedNoteId} (pitch=${stolenPitch}) for noteId=${noteId} (pitch=${pitch})`);
        return { channel, reusedNoteId, stolenPitch };
    }

    if (channel !== null) {
        activeNotes.set(noteId, { channel, pitch });
        channelUsageOrder.push(noteId);
    }

    return channel;
}

// Release a noteId's channel back to the pool.
// No-op if the noteId was already voice-stolen (the channel belongs to whoever
// stole it now; releasing it here would incorrectly free a channel still in use).
export function releaseChannel(noteId) {
    if (!noteId) return;
    if (!activeNotes.has(noteId)) return;   // stolen earlier — no-op

    const { channel } = activeNotes.get(noteId);
    activeNotes.delete(noteId);

    const index = channelUsageOrder.indexOf(noteId);
    if (index > -1) channelUsageOrder.splice(index, 1);

    if (channel !== null && !channelPool.includes(channel) && channel !== MPE_MASTER_CHANNEL) {
        channelPool.push(channel);
        channelPool.sort((a, b) => a - b);
    }
}

// Returns channel number for active noteId, or null if not active (e.g. stolen).
// Caller code MUST treat null as "don't emit output" — the synth no longer has
// this note on any channel, so sending a note-off would target a wrong channel.
export function getChannelForNote(noteId) {
    return activeNotes.has(noteId) ? activeNotes.get(noteId).channel : null;
}

// Returns number of bytes sent (3 for pitch bend)
export function sendPitchBend(midiOutput, channel, bendValue) {
    if (!midiOutput || channel === null || typeof channel === 'undefined') return 0;
    
    const clamped = Math.max(-8192, Math.min(8191, bendValue));
    const bend = clamped + 8192;
    const lsb = bend & 0x7F;
    const msb = (bend >> 7) & 0x7F;
    
    midiOutput.send([0xE0 | channel, lsb, msb]);
    return 3;
}

export function sendNoteOn(midiOutput, channel, note, velocity) {
    if (!midiOutput) return 0;
    midiOutput.send([0x90 | channel, note, velocity]);
    return 3;
}

export function sendNoteOff(midiOutput, channel, note) {
    if (!midiOutput) return 0;
    midiOutput.send([0x80 | channel, note, 0]);
    return 3;
}

export function getMPEState() {
    // Flatten activeNotes for JSON-friendly output
    const notes = {};
    for (const [id, val] of activeNotes) {
        notes[id] = val.channel !== undefined ? val : { channel: val, pitch: null };
    }
    return {
        availableChannels: channelPool.length,
        activeNoteCount: activeNotes.size,
        pitchBendRangeInitialized,
        channelPool: [...channelPool],
        activeNotes: notes
    };
}
