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
//
// Sustain model (S1 fix, 2026-07-12): a note released while CC64 is down keeps
// ringing on the synth, so its channel must stay OWNED until the pedal lifts.
// Previously the channel was returned to the pool at key-up: the next note-on
// re-used it and its pitch bend re-tuned the still-ringing sustained note, and
// stacked note-on/off pairs on one (channel, pitch) slot made the synth flush
// currently-held notes when the pedal lifted ("lift pedal → silence" bug).
// Released-but-ringing notes now live in sustainedNotes until CC64-up.
// Voice stealing prefers them (oldest first) over held notes, and flags the
// caller to send CC120 (All Sound Off) on the stolen channel, because a plain
// note-off is deferred by the synth's sustain and would not free the voice.

export const MPE_MASTER_CHANNEL = 0;
export const MPE_MEMBER_CHANNELS = Array.from({ length: 15 }, (_, i) => i + 1);

let channelPool = [...MPE_MEMBER_CHANNELS];
let activeNotes = new Map();     // noteId -> {channel, pitch} — key physically held
let channelUsageOrder = [];      // oldest-first for LRU voice stealing (held notes)
let sustainedNotes = new Map();  // noteId -> {channel, pitch} — key up, ringing under CC64
let sustainedOrder = [];         // oldest-first noteIds, preferred steal targets
let sustainPedalDown = false;
let pitchBendRangeInitialized = false;

export function resetMPEState() {
    channelPool = [...MPE_MEMBER_CHANNELS];
    activeNotes = new Map();
    channelUsageOrder = [];
    sustainedNotes = new Map();
    sustainedOrder = [];
    sustainPedalDown = false;
    pitchBendRangeInitialized = false;
}

export function isSustainPedalDown() {
    return sustainPedalDown;
}

// Update pedal state. On the down→up transition every sustained note's channel
// returns to the pool: their note-offs were already sent at key-up, and the
// receiver silences them itself when it processes the forwarded CC64-up.
// Returns the number of channels released (diagnostics/tests).
export function setSustainPedal(isDown) {
    const wasDown = sustainPedalDown;
    sustainPedalDown = isDown;

    if (!wasDown || isDown) return 0;

    let released = 0;
    for (const { channel } of sustainedNotes.values()) {
        if (channel !== null && channel !== MPE_MASTER_CHANNEL && !channelPool.includes(channel)) {
            channelPool.push(channel);
            released++;
        }
    }
    channelPool.sort((a, b) => a - b);
    sustainedNotes = new Map();
    sustainedOrder = [];
    return released;
}

// Move a key-released note into the sustained set, KEEPING its channel owned.
// Call instead of releaseChannel when CC64 is down. Returns the channel, or
// null if the noteId is unknown (e.g. it was voice-stolen earlier).
export function sustainNote(noteId) {
    if (!noteId || !activeNotes.has(noteId)) return null;

    const entry = activeNotes.get(noteId);
    activeNotes.delete(noteId);
    const index = channelUsageOrder.indexOf(noteId);
    if (index > -1) channelUsageOrder.splice(index, 1);

    sustainedNotes.set(noteId, entry);
    sustainedOrder.push(noteId);
    return entry.channel;
}

export function isPitchBendRangeInitialized() {
    return pitchBendRangeInitialized;
}

// MPE initialization sequence (F3 fix, 2026-04-19; MCM corrected P0-7, 2026-06-25):
//   1. MCM (MPE Configuration Message) on master channel — tells receiver to
//      enter MPE mode with N member channels on the lower zone.
//      Per MMA/AMEI RP-053 (2018) the MCM is RPN 0x0006 (RPN MSB 0, LSB 6) with
//      Data Entry MSB = N (0..15) — NOT CC 127 (0x7F), which is Poly Mode On.
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
        // 1. MCM (MPE Configuration Message), RP-053: RPN 0x0006 on the master
        //    channel with Data Entry MSB = number of member channels. This is
        //    what tells strict-MPE receivers to enter lower-zone MPE mode.
        //    (P0-7 fix 2026-06-25: previously sent CC 127, which is NOT the MCM.)
        midiOutput.send([0xB0 | MPE_MASTER_CHANNEL, 101, 0]);                        // RPN MSB = 0
        midiOutput.send([0xB0 | MPE_MASTER_CHANNEL, 100, 6]);                        // RPN LSB = 6 (MPE Configuration)
        midiOutput.send([0xB0 | MPE_MASTER_CHANNEL, 6, MPE_MEMBER_CHANNELS.length]); // Data Entry MSB = N member channels

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

// LRU channel allocation with pitch-tracking (F1 fix, 2026-04-19; sustain-aware
// stealing S1, 2026-07-12).
//
// Returns one of:
//   null    — allocation failed (only possible if every channel is leaked)
//   number  — channel allocated cleanly (no stealing)
//   {channel, reusedNoteId, stolenPitch, stolenSustained, needsSoundOff}
//        — channel stolen from an older note. Caller MUST, before the new
//          note-on: send note-off for stolenPitch on `channel` unless
//          stolenSustained (its note-off was already sent at key-up), and
//          send CC120 (All Sound Off) on `channel` when needsSoundOff — a
//          plain note-off is deferred by the receiver while CC64 is down,
//          so without CC120 the stolen voice keeps ringing and the new
//          note's pitch bend would re-tune it.
//
// Steal policy (graceful degradation at the 15-voice ceiling):
//   1. free pool channel;
//   2. oldest SUSTAINED note (released key, ringing only via pedal — the
//      least perceptually damaging voice to lose);
//   3. oldest HELD note (last resort, preserves the F1 behaviour).
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

    const channel = channelPool.length > 0 ? channelPool.shift() : null;
    if (channel !== null) {
        activeNotes.set(noteId, { channel, pitch });
        channelUsageOrder.push(noteId);
        return channel;
    }

    // All channels busy — steal the oldest sustained note first, else oldest held
    const stealFromSustained = sustainedOrder.length > 0;
    const order = stealFromSustained ? sustainedOrder : channelUsageOrder;
    const store = stealFromSustained ? sustainedNotes : activeNotes;
    if (order.length === 0) return null;

    const reusedNoteId = order.shift();
    const stolen = store.get(reusedNoteId) || {};
    store.delete(reusedNoteId);

    activeNotes.set(noteId, { channel: stolen.channel, pitch });
    channelUsageOrder.push(noteId);

    console.warn(`MPE channel ${stolen.channel} stolen from ${stealFromSustained ? 'sustained' : 'held'} noteId=${reusedNoteId} (pitch=${stolen.pitch}) for noteId=${noteId} (pitch=${pitch})`);
    return {
        channel: stolen.channel,
        reusedNoteId,
        stolenPitch: stolen.pitch,
        stolenSustained: stealFromSustained,
        needsSoundOff: sustainPedalDown || stealFromSustained
    };
}

// Release a noteId's channel back to the pool.
// No-op if the noteId was already voice-stolen (the channel belongs to whoever
// stole it now; releasing it here would incorrectly free a channel still in use).
// Also accepts sustained noteIds defensively (normally those are released in
// bulk by setSustainPedal(false)).
export function releaseChannel(noteId) {
    if (!noteId) return;

    let entry = null;
    if (activeNotes.has(noteId)) {
        entry = activeNotes.get(noteId);
        activeNotes.delete(noteId);
        const index = channelUsageOrder.indexOf(noteId);
        if (index > -1) channelUsageOrder.splice(index, 1);
    } else if (sustainedNotes.has(noteId)) {
        entry = sustainedNotes.get(noteId);
        sustainedNotes.delete(noteId);
        const index = sustainedOrder.indexOf(noteId);
        if (index > -1) sustainedOrder.splice(index, 1);
    } else {
        return;   // stolen earlier — no-op
    }

    const { channel } = entry;
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

// CC120 All Sound Off — the only message that silences a voice the receiver is
// holding via sustain (a note-off is deferred until CC64-up). Used before
// re-using a stolen channel whose old voice is still ringing under the pedal.
export function sendAllSoundOff(midiOutput, channel) {
    if (!midiOutput || channel === null || typeof channel === 'undefined') return 0;
    midiOutput.send([0xB0 | channel, 120, 0]);
    return 3;
}

export function getMPEState() {
    // Flatten note maps for JSON-friendly output
    const notes = {};
    for (const [id, val] of activeNotes) {
        notes[id] = val.channel !== undefined ? val : { channel: val, pitch: null };
    }
    const sustained = {};
    for (const [id, val] of sustainedNotes) {
        sustained[id] = val;
    }
    return {
        availableChannels: channelPool.length,
        activeNoteCount: activeNotes.size,
        sustainedNoteCount: sustainedNotes.size,
        sustainPedalDown,
        pitchBendRangeInitialized,
        channelPool: [...channelPool],
        activeNotes: notes,
        sustainedNotes: sustained
    };
}
