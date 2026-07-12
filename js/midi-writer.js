// MIDI Writer - exports files with JI tuning embedded
// Supports MIDI 1.0 with MTS SysEx and MIDI 2.0 Clip File with Pitch 7.25

import { calculateMTSScaleTuning } from './midi-file-tuner.js';
import { centsToPitch725, encodePerNotePitch725UMP } from './tuning-midi2.js';

// includeTuning=false yields a 12-TET reference file: identical note/CC/meta
// content and timing, but no MTS SysEx — the "ET" side of an ET-vs-JI A/B
// pair, guaranteed to differ from the MTS export only in the tuning messages.
export function exportMIDI1WithMTS(tuningResult, includeTuning = true) {
    const { tunedNotes, keySegments, originalMidiData } = tuningResult;
    
    const trackNumbers = new Set();
    for (const note of tunedNotes) {
        trackNumbers.add(note.track || 0);
    }
    const noteTracks = Array.from(trackNumbers).sort((a, b) => a - b);
    const numNoteTracks = Math.max(noteTracks.length, 1);
    
    const chunks = [];
    
    chunks.push(createHeaderChunk(1, 1 + numNoteTracks, originalMidiData.ticksPerQuarterNote));
    
    let lastTick = 0;
    for (const n of tunedNotes) {
        if (n.endTick > lastTick) lastTick = n.endTick;
    }
    
    // Track 0: tempo, time signatures, MTS tuning changes
    const track0Events = [];
    
    for (const tempoChange of originalMidiData.tempoChanges) {
        track0Events.push({ tick: tempoChange.tick, type: 'tempo', tempo: tempoChange.tempo });
    }
    
    for (const timeSig of originalMidiData.timeSignatures) {
        track0Events.push({
            tick: timeSig.tick, type: 'timeSignature',
            numerator: timeSig.numerator, denominator: timeSig.denominator
        });
    }
    
    if (includeTuning) {
        for (const segment of keySegments) {
            // A1 (2026-07-12): prefer the continuity-anchored table computed by
            // the recorder; fall back to the raw per-key table for callers that
            // don't provide one (e.g. midi-file-tuner's ensemble path).
            const mtsData = segment.anchoredCentsArray || calculateMTSScaleTuning(segment.key);
            track0Events.push({
                tick: segment.startTick || 0, type: 'mtsScaleOctave',
                centsArray: mtsData, key: segment.key
            });
        }
    }
    
    track0Events.sort((a, b) => a.tick - b.tick);
    track0Events.push({ tick: lastTick, type: 'endOfTrack' });
    
    chunks.push(createTrack0WithMTS(track0Events));
    
    // Note tracks
    for (let i = 0; i < numNoteTracks; i++) {
        const originalTrackNum = noteTracks[i];
        const trackEvents = [];
        
        for (const note of tunedNotes) {
            if ((note.track || 0) !== originalTrackNum) continue;
            
            trackEvents.push({
                tick: note.startTick, type: 'noteOn',
                channel: note.channel || 0, pitch: note.pitch, velocity: note.velocity
            });
            
            trackEvents.push({
                tick: note.endTick, type: 'noteOff',
                channel: note.channel || 0, pitch: note.pitch, velocity: 0
            });
        }
        
        if (originalMidiData.ccEvents) {
            for (const cc of originalMidiData.ccEvents) {
                trackEvents.push({
                    tick: cc.tick, type: 'controlChange',
                    channel: cc.channel || 0, controller: cc.controller, value: cc.value
                });
            }
        }
        
        trackEvents.sort((a, b) => a.tick - b.tick || (a.type === 'noteOff' ? -1 : 1));
        
        const trackLastTick = trackEvents.length > 0 
            ? Math.max(...trackEvents.map(e => e.tick)) : lastTick;
        trackEvents.push({ tick: trackLastTick, type: 'endOfTrack' });
        
        chunks.push(createNoteTrack(trackEvents));
    }
    
    const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const output = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
        output.set(chunk, offset);
        offset += chunk.length;
    }
    
    return new Blob([output], { type: 'audio/midi' });
}

function createHeaderChunk(format, numTracks, ticksPerQuarter) {
    const chunk = new Uint8Array(14);
    const view = new DataView(chunk.buffer);
    
    chunk[0] = 0x4D; chunk[1] = 0x54; chunk[2] = 0x68; chunk[3] = 0x64; // MThd
    view.setUint32(4, 6, false);
    view.setUint16(8, format, false);
    view.setUint16(10, numTracks, false);
    view.setUint16(12, ticksPerQuarter, false);
    
    return chunk;
}

function createTrack0WithMTS(events) {
    const eventBytes = [];
    let prevTick = 0;
    
    for (const event of events) {
        const deltaTime = event.tick - prevTick;
        eventBytes.push(...encodeVariableLength(deltaTime));
        prevTick = event.tick;
        
        switch (event.type) {
            case 'tempo':
                eventBytes.push(0xFF, 0x51, 0x03);
                eventBytes.push((event.tempo >> 16) & 0xFF);
                eventBytes.push((event.tempo >> 8) & 0xFF);
                eventBytes.push(event.tempo & 0xFF);
                break;
            case 'timeSignature':
                eventBytes.push(0xFF, 0x58, 0x04);
                eventBytes.push(event.numerator);
                eventBytes.push(Math.log2(event.denominator));
                eventBytes.push(24, 8);
                break;
            case 'mtsScaleOctave':
                const sysexData = createMTSScaleOctaveSysExData(event.centsArray);
                eventBytes.push(0xF0);
                eventBytes.push(...encodeVariableLength(sysexData.length));
                eventBytes.push(...sysexData);
                break;
            case 'controlChange':
                // Reused by MPE export: MCM (CC 127 on ch 0) + RPN 0 init on member channels
                eventBytes.push(0xB0 | (event.channel & 0x0F));
                eventBytes.push(event.controller & 0x7F);
                eventBytes.push(event.value & 0x7F);
                break;
            case 'endOfTrack':
                eventBytes.push(0xFF, 0x2F, 0x00);
                break;
        }
    }

    return createTrackChunk(eventBytes);
}

function createMTSScaleOctaveSysExData(centsArray) {
    const data = [0x7F, 0x7F, 0x08, 0x09, 0x7F, 0x7F, 0x03];
    
    for (let i = 0; i < 12; i++) {
        const cents = centsArray[i];
        const clampedCents = Math.max(-100, Math.min(100, cents));
        const value14bit = Math.round(((clampedCents + 100) / 200) * 16383);
        const valueClamped = Math.max(0, Math.min(16383, value14bit));
        
        const msb = (valueClamped >> 7) & 0x7F;
        const lsb = valueClamped & 0x7F;
        data.push(msb, lsb);
    }
    
    data.push(0xF7);
    return data;
}

function createNoteTrack(events) {
    const eventBytes = [];
    let prevTick = 0;
    
    for (const event of events) {
        const deltaTime = event.tick - prevTick;
        eventBytes.push(...encodeVariableLength(deltaTime));
        prevTick = event.tick;
        
        switch (event.type) {
            case 'noteOn':
                eventBytes.push(0x90 | (event.channel & 0x0F));
                eventBytes.push(event.pitch & 0x7F);
                eventBytes.push(event.velocity & 0x7F);
                break;
            case 'noteOff':
                eventBytes.push(0x80 | (event.channel & 0x0F));
                eventBytes.push(event.pitch & 0x7F);
                eventBytes.push(0);
                break;
            case 'controlChange':
                eventBytes.push(0xB0 | (event.channel & 0x0F));
                eventBytes.push(event.controller & 0x7F);
                eventBytes.push(event.value & 0x7F);
                break;
            case 'pitchBend': {
                // Raw signed value in [-8192, +8191] → biased 14-bit → LSB, MSB
                // (matches the live MPE path in js/tuning-mpe.js)
                const raw = Math.max(-8192, Math.min(8191, event.value | 0));
                const biased = raw + 8192;
                eventBytes.push(0xE0 | (event.channel & 0x0F));
                eventBytes.push(biased & 0x7F);          // LSB first (MIDI 1.0 spec)
                eventBytes.push((biased >> 7) & 0x7F);   // then MSB
                break;
            }
            case 'endOfTrack':
                eventBytes.push(0xFF, 0x2F, 0x00);
                break;
        }
    }

    return createTrackChunk(eventBytes);
}

function createTrackChunk(eventBytes) {
    const chunkLength = eventBytes.length;
    const chunk = new Uint8Array(8 + chunkLength);
    const view = new DataView(chunk.buffer);
    
    chunk[0] = 0x4D; chunk[1] = 0x54; chunk[2] = 0x72; chunk[3] = 0x6B; // MTrk
    view.setUint32(4, chunkLength, false);
    chunk.set(new Uint8Array(eventBytes), 8);
    
    return chunk;
}

function encodeVariableLength(value) {
    if (value < 0) value = 0;
    
    const bytes = [];
    bytes.push(value & 0x7F);
    
    while (value > 0x7F) {
        value >>= 7;
        bytes.push((value & 0x7F) | 0x80);
    }
    
    return bytes.reverse();
}

// =============================================================================
// MPE export (MIDI 1.0, per-channel pitch bend instead of MTS SysEx)
// =============================================================================
//
// This path mirrors the live MPE runtime in `js/tuning-mpe.js`:
//   - Track 0 emits the MPE Configuration Message (RP-053 RPN 6, Data Entry = 15
//     member channels, on ch 0) and the RPN 0 init sequence (±2 semitones)
//     on each of the 15 member channels, immediately followed by tempo/
//     time-signature meta events.
//   - Track 1 walks the recorded notes chronologically, allocates a member
//     channel (1..15) via an LRU pool with voice-stealing, and for each
//     note emits:
//         pitch-bend (computed from note.centsDeviation) → note-on
//     and on release:
//         note-off → pitch-bend reset to centre
//
// The result opens correctly in Pianoteq MPE mode, Surge XT, ROLI Equator²,
// Ableton 12's MPE tracks, and any DAW that honours the MCM + RPN 0 pair.
// Non-MPE synths fall back to treating each channel as independent MIDI 1.0
// with a ±2-semitone pitch-bend range — the per-note detune is still applied
// correctly because RPN 0 is universal MIDI 1.0, not an MPE extension.
//
// Each pitch-bend raw value is clamped to [-8192, +8191] and biased to
// 14-bit [0, 16383] at serialization time (see createNoteTrack's pitchBend
// case). Cents → raw: `round(cents / 200 * 8192)` assuming ±2 st range.
//
// Channel allocator is deterministic for a given input, so two runs of the
// export on the same recording produce identical bytes.
// =============================================================================

const MPE_MEMBER_CHANNEL_COUNT = 15;   // lower zone: ch 1 = master, ch 2..16 = members
const MPE_PITCH_BEND_SEMITONES = 2;     // matches live; set via RPN 0 below

export function exportMIDI1WithMPE(tuningResult) {
    const { tunedNotes, keySegments, originalMidiData } = tuningResult;

    const sortedNotes = [...tunedNotes].sort((a, b) =>
        (a.startTick - b.startTick) || (a.pitch - b.pitch)
    );

    // Find total duration for endOfTrack events
    let lastTick = 0;
    for (const n of tunedNotes) {
        if (n.endTick > lastTick) lastTick = n.endTick;
    }

    const chunks = [];
    chunks.push(createHeaderChunk(1, 2, originalMidiData.ticksPerQuarterNote));

    // -------------------------------------------------------------------
    // Track 0 — MPE init (MCM + RPN 0 on every member channel) + meta events
    // -------------------------------------------------------------------
    const track0Events = [];

    // MPE Configuration Message (MCM) on master channel 0. Per RP-053 the MCM is
    // RPN 0x0006 with Data Entry MSB = number of member channels (P0-7 fix
    // 2026-06-26; previously emitted CC 127, which is NOT the MCM — this matches
    // the live fix in js/tuning-mpe.js so exported files actually trigger MPE mode).
    track0Events.push({ tick: 0, type: 'controlChange', channel: 0, controller: 101, value: 0 });   // RPN MSB = 0
    track0Events.push({ tick: 0, type: 'controlChange', channel: 0, controller: 100, value: 6 });   // RPN LSB = 6
    track0Events.push({ tick: 0, type: 'controlChange', channel: 0, controller: 6,
                        value: MPE_MEMBER_CHANNEL_COUNT });                                          // Data Entry MSB = N

    // Per-member-channel RPN 0 init (pitch-bend range = ±2 semitones, fine=0)
    for (let ch = 1; ch <= MPE_MEMBER_CHANNEL_COUNT; ch++) {
        track0Events.push({ tick: 0, type: 'controlChange', channel: ch, controller: 101, value: 0 });    // RPN MSB = 0
        track0Events.push({ tick: 0, type: 'controlChange', channel: ch, controller: 100, value: 0 });    // RPN LSB = 0
        track0Events.push({ tick: 0, type: 'controlChange', channel: ch, controller: 6,   value: MPE_PITCH_BEND_SEMITONES });
        track0Events.push({ tick: 0, type: 'controlChange', channel: ch, controller: 38,  value: 0 });    // Data Entry LSB = 0 cents fine
        track0Events.push({ tick: 0, type: 'controlChange', channel: ch, controller: 101, value: 127 });  // reset RPN null
        track0Events.push({ tick: 0, type: 'controlChange', channel: ch, controller: 100, value: 127 });
    }

    // Tempo + time signature from original recording
    for (const tempoChange of originalMidiData.tempoChanges) {
        track0Events.push({ tick: tempoChange.tick, type: 'tempo', tempo: tempoChange.tempo });
    }
    for (const timeSig of originalMidiData.timeSignatures) {
        track0Events.push({
            tick: timeSig.tick, type: 'timeSignature',
            numerator: timeSig.numerator, denominator: timeSig.denominator
        });
    }

    track0Events.sort((a, b) => a.tick - b.tick);
    track0Events.push({ tick: lastTick, type: 'endOfTrack' });
    chunks.push(createTrack0WithMTS(track0Events));

    // -------------------------------------------------------------------
    // Track 1 — MPE per-note events (allocated via LRU channel pool)
    // -------------------------------------------------------------------
    // Pedal-aware allocation (S1): the CC stream tells the allocator which
    // released notes are still ringing under CC64 and must keep their channels.
    const track1Events = allocateMPEEvents(sortedNotes, originalMidiData.ccEvents || []);

    // Stable sort by (tick, order) — order: noteOff=0, pitchBend=1, noteOn=2
    // ensures correct MPE semantics at same-tick events:
    //   voice-steal note-off (0) → new pitch-bend (1) → new note-on (2)
    //   natural release note-off (0) → pitch-bend reset (1)
    track1Events.sort((a, b) => (a.tick - b.tick) || (a.order - b.order));

    // CC pass-through from original recording (e.g. sustain pedal CC 64)
    // Non-MPE-tuning CCs go on channel 0 (master) per MPE convention —
    // member channels should only carry per-note expression.
    if (originalMidiData.ccEvents) {
        for (const cc of originalMidiData.ccEvents) {
            track1Events.push({
                tick: cc.tick, type: 'controlChange',
                channel: 0, controller: cc.controller, value: cc.value,
                order: 0
            });
        }
        track1Events.sort((a, b) => (a.tick - b.tick) || (a.order - b.order));
    }

    track1Events.push({ tick: lastTick, type: 'endOfTrack' });
    chunks.push(createNoteTrack(track1Events));

    // -------------------------------------------------------------------
    // Assemble final Blob
    // -------------------------------------------------------------------
    const totalLength = chunks.reduce((s, c) => s + c.length, 0);
    const output = new Uint8Array(totalLength);
    let offset = 0;
    for (const c of chunks) {
        output.set(c, offset);
        offset += c.length;
    }

    return new Blob([output], { type: 'audio/midi' });
}

/**
 * Allocate MPE member channels for a time-sorted note list and return the
 * corresponding MIDI event stream (pitch-bend, note-on, note-off, reset
 * pitch-bend events, each tagged with .order for stable at-tick sorting).
 *
 * Allocation rules (mirroring js/tuning-mpe.js):
 *   1. Before processing a note, release any channels whose current note
 *      ends at or before this note's startTick — emit their note-off +
 *      pitch-bend reset, then return the channel to the LRU pool.
 *   2. If free channels exist, pick the oldest-freed (LRU head).
 *   3. Otherwise voice-steal the oldest active channel — emit a note-off
 *      for the stolen pitch on that channel at the CURRENT tick (before
 *      the new pitch-bend + note-on).
 */
function allocateMPEEvents(sortedNotes, ccEvents = []) {
    const POOL = MPE_MEMBER_CHANNEL_COUNT;
    // channels[i] for channel (i+1): null when free, else
    //   { phase: 'active',  startTick, endTick, pitch }            — key down
    //   { phase: 'ringing', startTick, endTick, pitch, freeTick }  — note-off
    //     written, but CC64 holds the voice until freeTick (next pedal-up).
    //
    // Sustain model (S1 fix, 2026-07-12, mirrors js/tuning-mpe.js): a channel
    // whose note ended under a held pedal keeps ringing on the receiving synth,
    // so it must NOT be re-used until the pedal lifts — re-using it would let
    // the next note's pitch bend re-tune the ringing voice. The old allocator
    // freed at endTick and also wrote a pitch-bend reset there, which snapped
    // every pedal-sustained note back to ET in the exported file. If a ringing
    // channel must be stolen, CC120 (All Sound Off) is written first, because
    // its note-off is deferred by the receiver's sustain.
    const channels = new Array(POOL).fill(null);
    // lru: permutation of channel indices ordered by allocation recency;
    // front = least recently allocated = first choice among FREE channels.
    const lru = Array.from({ length: POOL }, (_, i) => i);

    const events = [];

    // Pedal (CC64) state timeline from the recording's CC stream
    const pedalEdges = (ccEvents || [])
        .filter((cc) => cc.controller === 64)
        .sort((a, b) => a.tick - b.tick)
        .map((cc) => ({ tick: cc.tick, down: cc.value >= 64 }));

    const pedalDownAt = (tick) => {
        let down = false;
        for (const e of pedalEdges) {
            if (e.tick > tick) break;
            down = e.down;
        }
        return down;
    };

    // Tick at which a voice released at endTick actually stops sounding:
    // endTick itself if the pedal is up, else the next pedal-up (Infinity if
    // the pedal never lifts again — the channel then frees only at flush).
    const sustainFreeTick = (endTick) => {
        if (!pedalDownAt(endTick)) return endTick;
        for (const e of pedalEdges) {
            if (e.tick > endTick && !e.down) return e.tick;
        }
        return Infinity;
    };

    for (const note of sortedNotes) {
        const t = note.startTick;

        // 1. Retire channels: write the note-off when the note has ended, but
        //    only FREE the channel once the pedal no longer holds its voice.
        for (let i = 0; i < POOL; i++) {
            const state = channels[i];
            if (!state) continue;
            if (state.phase === 'active' && state.endTick <= t) {
                events.push({
                    tick: state.endTick, type: 'noteOff', order: 0,
                    channel: i + 1, pitch: state.pitch
                });
                state.phase = 'ringing';
                state.freeTick = sustainFreeTick(state.endTick);
            }
            if (state.phase === 'ringing' && state.freeTick <= t) {
                channels[i] = null;
            }
        }

        // 2. Allocate a channel — free pool first, then steal the oldest
        //    RINGING voice (least damaging: its key is already up), then the
        //    oldest ACTIVE voice as a last resort.
        let chIdx = -1;
        for (const idx of lru) {
            if (channels[idx] === null) { chIdx = idx; break; }
        }
        if (chIdx === -1) {
            let oldestEnd = Infinity;
            for (let i = 0; i < POOL; i++) {
                if (channels[i].phase === 'ringing' && channels[i].endTick < oldestEnd) {
                    oldestEnd = channels[i].endTick;
                    chIdx = i;
                }
            }
            if (chIdx !== -1) {
                // Note-off already written at endTick; CC120 silences the
                // pedal-held voice before the channel is re-used.
                events.push({
                    tick: t, type: 'controlChange', order: 0,
                    channel: chIdx + 1, controller: 120, value: 0
                });
                channels[chIdx] = null;
            }
        }
        if (chIdx === -1) {
            let oldestStart = Infinity;
            for (let i = 0; i < POOL; i++) {
                if (channels[i] && channels[i].startTick < oldestStart) {
                    oldestStart = channels[i].startTick;
                    chIdx = i;
                }
            }
            // Emit note-off for the stolen pitch BEFORE the new pitch-bend /
            // note-on (order 0 comes first); if the pedal is down that note-off
            // is deferred by the receiver, so CC120 must follow it.
            const stolen = channels[chIdx];
            events.push({
                tick: t, type: 'noteOff', order: 0,
                channel: chIdx + 1, pitch: stolen.pitch
            });
            if (pedalDownAt(t)) {
                events.push({
                    tick: t, type: 'controlChange', order: 0,
                    channel: chIdx + 1, controller: 120, value: 0
                });
            }
            channels[chIdx] = null;
        }

        // Move the chosen channel to the newest end of the recency order.
        lru.splice(lru.indexOf(chIdx), 1);
        lru.push(chIdx);

        // 3. Compute pitch bend from cents deviation (-100..+100 cents → raw bend)
        const cents = Number.isFinite(note.centsDeviation) ? note.centsDeviation : 0;
        const raw = Math.max(-8192, Math.min(8191,
            Math.round(cents / (100 * MPE_PITCH_BEND_SEMITONES) * 8192)
        ));

        const ch = chIdx + 1;
        events.push({
            tick: note.startTick, type: 'pitchBend', order: 1,
            channel: ch, value: raw
        });
        events.push({
            tick: note.startTick, type: 'noteOn', order: 2,
            channel: ch, pitch: note.pitch, velocity: note.velocity
        });

        channels[chIdx] = {
            phase: 'active',
            startTick: note.startTick,
            endTick: note.endTick,
            pitch: note.pitch
        };
    }

    // Flush: write the note-off for channels still active at the end.
    // ('ringing' channels already have theirs; no pitch-bend reset — each
    // channel's bend is rewritten before its next note-on anyway, and a reset
    // here would snap any pedal-held tail back to ET.)
    for (let i = 0; i < POOL; i++) {
        if (channels[i] && channels[i].phase === 'active') {
            events.push({
                tick: channels[i].endTick, type: 'noteOff', order: 0,
                channel: i + 1, pitch: channels[i].pitch
            });
        }
    }

    return events;
}

export function exportMIDI2WithPitch725(tuningResult) {
    const { tunedNotes, keySegments, originalMidiData } = tuningResult;
    
    const packets = [];
    const ticksPerQuarter = originalMidiData.ticksPerQuarterNote;
    
    for (const note of tunedNotes) {
        const pitch725Value = centsToPitch725(note.pitch, note.centsDeviation);
        const pitch725UMP = encodePerNotePitch725UMP(note.channel || 0, note.pitch, pitch725Value);
        
        packets.push({ tick: note.startTick, order: 0, ump: pitch725UMP });
        
        const noteOnUMP = encodeMIDI2NoteOn(note.channel || 0, note.pitch, note.velocity);
        packets.push({ tick: note.startTick, order: 1, ump: noteOnUMP });
        
        const noteOffUMP = encodeMIDI2NoteOff(note.channel || 0, note.pitch);
        packets.push({ tick: note.endTick, order: 0, ump: noteOffUMP });
    }
    
    packets.sort((a, b) => a.tick - b.tick || a.order - b.order);
    
    const clipFile = buildMIDIClipFile(packets, ticksPerQuarter);
    return new Blob([clipFile], { type: 'audio/midi2' });
}

function encodeMIDI2NoteOn(channel, pitch, velocity) {
    const velocity16 = velocity << 9;
    
    const word1 = (0x4 << 28) | (0 << 24) | ((0x90 | (channel & 0x0F)) << 16) |
                  ((pitch & 0x7F) << 8) | 0x00;
    const word2 = (velocity16 << 16) | 0x0000;
    
    return new Uint32Array([word1, word2]);
}

function encodeMIDI2NoteOff(channel, pitch) {
    const word1 = (0x4 << 28) | (0 << 24) | ((0x80 | (channel & 0x0F)) << 16) |
                  ((pitch & 0x7F) << 8) | 0x00;
    const word2 = 0x00000000;
    
    return new Uint32Array([word1, word2]);
}

function buildMIDIClipFile(packets, ticksPerQuarter) {
    const headerSize = 16;
    const packetSize = 12;
    const totalSize = headerSize + (packets.length * packetSize);
    
    const buffer = new ArrayBuffer(totalSize);
    const view = new DataView(buffer);
    const bytes = new Uint8Array(buffer);
    
    const magic = "SMF2CLIP";
    for (let i = 0; i < 8; i++) {
        bytes[i] = magic.charCodeAt(i);
    }
    
    view.setUint32(8, 0x00010000, false);
    view.setUint16(12, ticksPerQuarter, false);
    view.setUint16(14, 0, false);
    
    let offset = headerSize;
    let prevTick = 0;
    
    for (const packet of packets) {
        const deltaTime = packet.tick - prevTick;
        prevTick = packet.tick;
        
        view.setUint32(offset, deltaTime, false);
        offset += 4;
        view.setUint32(offset, packet.ump[0], false);
        offset += 4;
        view.setUint32(offset, packet.ump[1], false);
        offset += 4;
    }
    
    return buffer;
}

export function downloadFile(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

export function generateOutputFilename(originalName, format) {
    const baseName = originalName.replace(/\.(mid|midi|midi2)$/i, '');
    if (format === 'midi2') return `${baseName}_JI.midi2`;
    if (format === 'midi1-mpe') return `${baseName}_JI_MPE.mid`;
    if (format === 'midi1-raw') return `${baseName}_RAW_12TET.mid`;
    return `${baseName}_JI.mid`;
}
