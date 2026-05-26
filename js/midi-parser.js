// MIDI Parser - parses Standard MIDI Files (Format 0 and 1)
// Extracts notes, tempo, time signatures, and key signatures for JI analysis

const CHUNK_TYPES = {
    HEADER: 0x4D546864,  // "MThd"
    TRACK: 0x4D54726B   // "MTrk"
};

const META_EVENTS = {
    SEQUENCE_NUMBER: 0x00,
    TEXT: 0x01,
    COPYRIGHT: 0x02,
    TRACK_NAME: 0x03,
    INSTRUMENT_NAME: 0x04,
    LYRIC: 0x05,
    MARKER: 0x06,
    CUE_POINT: 0x07,
    CHANNEL_PREFIX: 0x20,
    END_OF_TRACK: 0x2F,
    TEMPO: 0x51,
    SMPTE_OFFSET: 0x54,
    TIME_SIGNATURE: 0x58,
    KEY_SIGNATURE: 0x59,
    SEQUENCER_SPECIFIC: 0x7F
};

export class MIDIParser {
    constructor() {
        this.data = null;
        this.position = 0;
    }

    parse(arrayBuffer) {
        this.data = new DataView(arrayBuffer);
        this.position = 0;

        const result = {
            format: 0,
            trackCount: 0,
            ticksPerQuarterNote: 480,
            tracks: [],
            tempoChanges: [],
            timeSignatures: [],
            keySignatures: [],
            notes: [],
            durationSeconds: 0
        };

        const header = this.parseHeaderChunk();
        result.format = header.format;
        result.trackCount = header.trackCount;
        result.ticksPerQuarterNote = header.division;

        for (let i = 0; i < header.trackCount; i++) {
            const track = this.parseTrackChunk(i);
            result.tracks.push(track);
            
            track.events.forEach(event => {
                if (event.type === 'tempo') result.tempoChanges.push(event);
                else if (event.type === 'timeSignature') result.timeSignatures.push(event);
                else if (event.type === 'keySignature') result.keySignatures.push(event);
            });
        }

        result.tempoChanges.sort((a, b) => a.tick - b.tick);
        
        if (result.tempoChanges.length === 0) {
            result.tempoChanges.push({ tick: 0, tempo: 500000, type: 'tempo' });
        }

        result.notes = this.mergeNotesWithTime(result);
        
        if (result.notes.length > 0) {
            const lastNote = result.notes[result.notes.length - 1];
            result.durationSeconds = lastNote.startTime + lastNote.duration;
        }

        return result;
    }

    parseHeaderChunk() {
        const chunkType = this.readUint32();
        if (chunkType !== CHUNK_TYPES.HEADER) {
            throw new Error('Invalid MIDI file: Missing MThd header');
        }

        const chunkLength = this.readUint32();
        const format = this.readUint16();
        const trackCount = this.readUint16();
        const division = this.readUint16();

        if (division & 0x8000) {
            console.warn('SMPTE timing detected');
        }

        return { format, trackCount, division: division & 0x7FFF };
    }

    parseTrackChunk(trackIndex) {
        const chunkType = this.readUint32();
        if (chunkType !== CHUNK_TYPES.TRACK) {
            throw new Error(`Invalid MIDI file: Expected MTrk at position ${this.position - 4}`);
        }

        const chunkLength = this.readUint32();
        const endPosition = this.position + chunkLength;

        const track = { index: trackIndex, events: [], notes: [] };

        let runningStatus = 0;
        let currentTick = 0;
        const activeNotes = {};

        while (this.position < endPosition) {
            const deltaTime = this.readVariableLength();
            currentTick += deltaTime;

            let statusByte = this.readUint8();

            if (statusByte < 0x80) {
                this.position--;
                statusByte = runningStatus;
            } else if (statusByte < 0xF0) {
                runningStatus = statusByte;
            }

            const event = this.parseEvent(statusByte, currentTick, trackIndex);
            
            if (event) {
                track.events.push(event);

                if (event.type === 'noteOn' && event.velocity > 0) {
                    const key = `${event.channel}_${event.pitch}`;
                    activeNotes[key] = {
                        tick: currentTick,
                        velocity: event.velocity,
                        channel: event.channel,
                        pitch: event.pitch
                    };
                } else if (event.type === 'noteOff' || (event.type === 'noteOn' && event.velocity === 0)) {
                    const key = `${event.channel}_${event.pitch}`;
                    if (activeNotes[key]) {
                        track.notes.push({
                            pitch: event.pitch,
                            channel: activeNotes[key].channel,
                            velocity: activeNotes[key].velocity,
                            startTick: activeNotes[key].tick,
                            endTick: currentTick,
                            durationTicks: currentTick - activeNotes[key].tick,
                            track: trackIndex
                        });
                        delete activeNotes[key];
                    }
                }
            }
        }

        return track;
    }

    parseEvent(statusByte, tick, trackIndex) {
        const eventType = statusByte & 0xF0;
        const channel = statusByte & 0x0F;

        switch (eventType) {
            case 0x80:
                return { type: 'noteOff', tick, channel, pitch: this.readUint8(), velocity: this.readUint8() };
            case 0x90:
                return { type: 'noteOn', tick, channel, pitch: this.readUint8(), velocity: this.readUint8() };
            case 0xA0:
                return { type: 'polyAftertouch', tick, channel, pitch: this.readUint8(), pressure: this.readUint8() };
            case 0xB0:
                return { type: 'controlChange', tick, channel, controller: this.readUint8(), value: this.readUint8() };
            case 0xC0:
                return { type: 'programChange', tick, channel, program: this.readUint8() };
            case 0xD0:
                return { type: 'channelAftertouch', tick, channel, pressure: this.readUint8() };
            case 0xE0:
                const lsb = this.readUint8();
                const msb = this.readUint8();
                return { type: 'pitchBend', tick, channel, value: (msb << 7) | lsb };
            case 0xF0:
                if (statusByte === 0xFF) return this.parseMetaEvent(tick);
                else if (statusByte === 0xF0 || statusByte === 0xF7) return this.parseSysExEvent(tick, statusByte);
                break;
        }
        return null;
    }

    parseMetaEvent(tick) {
        const metaType = this.readUint8();
        const length = this.readVariableLength();
        const dataStart = this.position;

        let event = { type: 'meta', metaType, tick, length };

        switch (metaType) {
            case META_EVENTS.TEMPO:
                const tempo = (this.readUint8() << 16) | (this.readUint8() << 8) | this.readUint8();
                event = { type: 'tempo', tick, tempo, bpm: Math.round(60000000 / tempo) };
                break;
            case META_EVENTS.TIME_SIGNATURE:
                event = {
                    type: 'timeSignature', tick,
                    numerator: this.readUint8(),
                    denominator: Math.pow(2, this.readUint8()),
                    clocksPerClick: this.readUint8(),
                    thirtySecondNotesPerQuarter: this.readUint8()
                };
                break;
            case META_EVENTS.KEY_SIGNATURE:
                const sf = this.readInt8();
                const mi = this.readUint8();
                event = { type: 'keySignature', tick, sharpsFlats: sf, mode: mi === 0 ? 'major' : 'minor' };
                break;
            case META_EVENTS.TRACK_NAME:
                event = { type: 'trackName', tick, name: this.readString(length) };
                break;
            case META_EVENTS.END_OF_TRACK:
                event = { type: 'endOfTrack', tick };
                break;
            default:
                this.position = dataStart + length;
                event = { type: 'meta', metaType, tick, length };
        }

        this.position = dataStart + length;
        return event;
    }

    parseSysExEvent(tick, statusByte) {
        const length = this.readVariableLength();
        const data = new Uint8Array(length);
        for (let i = 0; i < length; i++) {
            data[i] = this.readUint8();
        }
        return { type: 'sysex', tick, data };
    }

    mergeNotesWithTime(midiData) {
        const allNotes = [];
        const ticksPerQuarter = midiData.ticksPerQuarterNote;
        const tempoChanges = midiData.tempoChanges;
        const tempoMap = this.buildTempoMap(tempoChanges, ticksPerQuarter);

        for (const track of midiData.tracks) {
            for (const note of track.notes) {
                const startTime = this.tickToSeconds(note.startTick, tempoMap, ticksPerQuarter);
                const endTime = this.tickToSeconds(note.endTick, tempoMap, ticksPerQuarter);

                allNotes.push({
                    pitch: note.pitch,
                    velocity: note.velocity,
                    channel: note.channel,
                    track: note.track,
                    startTick: note.startTick,
                    endTick: note.endTick,
                    startTime,
                    endTime,
                    duration: endTime - startTime
                });
            }
        }

        allNotes.sort((a, b) => a.startTime - b.startTime);
        return allNotes;
    }

    buildTempoMap(tempoChanges, ticksPerQuarter) {
        const map = [];
        let currentTime = 0;
        let prevTick = 0;
        let currentTempo = 500000;

        for (const change of tempoChanges) {
            const tickDelta = change.tick - prevTick;
            const timeDelta = (tickDelta / ticksPerQuarter) * (currentTempo / 1000000);
            currentTime += timeDelta;

            map.push({ tick: change.tick, time: currentTime, tempo: change.tempo });

            prevTick = change.tick;
            currentTempo = change.tempo;
        }

        return map;
    }

    tickToSeconds(tick, tempoMap, ticksPerQuarter) {
        if (tempoMap.length === 0) return 0;

        let tempoEntry = tempoMap[0];
        for (const entry of tempoMap) {
            if (entry.tick <= tick) tempoEntry = entry;
            else break;
        }

        const tickDelta = tick - tempoEntry.tick;
        const timeDelta = (tickDelta / ticksPerQuarter) * (tempoEntry.tempo / 1000000);

        return tempoEntry.time + timeDelta;
    }

    readUint8() {
        return this.data.getUint8(this.position++);
    }

    readInt8() {
        return this.data.getInt8(this.position++);
    }

    readUint16() {
        const value = this.data.getUint16(this.position, false);
        this.position += 2;
        return value;
    }

    readUint32() {
        const value = this.data.getUint32(this.position, false);
        this.position += 4;
        return value;
    }

    readVariableLength() {
        let value = 0;
        let byte;
        do {
            byte = this.readUint8();
            value = (value << 7) | (byte & 0x7F);
        } while (byte & 0x80);
        return value;
    }

    readString(length) {
        let str = '';
        for (let i = 0; i < length; i++) {
            str += String.fromCharCode(this.readUint8());
        }
        return str;
    }
}

export async function parseMIDIFile(file) {
    const arrayBuffer = await file.arrayBuffer();
    const parser = new MIDIParser();
    return parser.parse(arrayBuffer);
}

export function getMIDIFileInfo(arrayBuffer) {
    const view = new DataView(arrayBuffer);
    const headerType = view.getUint32(0, false);
    if (headerType !== CHUNK_TYPES.HEADER) {
        throw new Error('Invalid MIDI file');
    }

    return {
        format: view.getUint16(8, false),
        trackCount: view.getUint16(10, false),
        ticksPerQuarterNote: view.getUint16(12, false) & 0x7FFF,
        fileSize: arrayBuffer.byteLength
    };
}

export { META_EVENTS, CHUNK_TYPES };
