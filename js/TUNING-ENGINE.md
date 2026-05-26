# Tuning Engine — MTS + MPE Implementation Reference

**Last updated:** 2026-04-19 (F1/F3/F4 fixes landed; see `research_data/engine_review_2026-04-19.md`)

This document is the authoritative reference for how the prototype retunes
incoming MIDI note events to just intonation (JI) in real time. Two output
paths are supported and selectable at runtime:

1. **MTS (MIDI Tuning Standard)** — single-note tuning sysex per the MMA MTS
   spec. Works on any MIDI 1.0 synth that advertises MTS support.
2. **MPE (MIDI Polyphonic Expression)** — per-channel pitch-bend fallback.
   Works on any standard MIDI 1.0 synth, with best results on MPE-aware
   instruments that expect a dedicated channel per note.

## 1. JI ratio model

Implemented in `js/tuning-core.js`.

- Scale degrees are referenced relative to the current key's tonic (1/1 =
  tonic). The 12 pitch classes use 5-limit just ratios:

  | degree | ratio    | cents | interval           |
  |:------:|:---------|:------|:-------------------|
  | 0      | 1/1      | 0     | unison             |
  | 1      | 16/15    | 112   | minor second       |
  | 2      | 9/8      | 204   | major second       |
  | 3      | 6/5      | 316   | minor third        |
  | 4      | 5/4      | 386   | **major third**    |
  | 5      | 4/3      | 498   | perfect fourth     |
  | 6      | 45/32    | 590   | tritone            |
  | 7      | 3/2      | 702   | **perfect fifth**  |
  | 8      | 8/5      | 814   | minor sixth        |
  | 9      | 5/3      | 884   | major sixth        |
  | 10     | 9/5      | 1018  | minor seventh      |
  | 11     | 15/8     | 1088  | major seventh      |

  The interval lookup in `calculateJICentsForNote` uses
  `((midiNote - keyRoot) % 12 + 12) % 12` — canonical positive-modulo over
  12 pitch classes. (Prior implementations used `+ 144` as a positive-safe
  offset; these produce identical output.)

- **Deviation from equal temperament** (what we actually send to the synth):
  each JI ratio's cents value minus the equal-tempered interval's cents.
  E.g. a JI major third at 386 ¢ vs 12-TET's 400 ¢ → a deviation of −14 ¢,
  applied as a downward pitch bend.

- The JI table is expressed relative to the tonic. For a C-major key the
  tonic is pitch class 0; for G-major it's 7; etc. The same table is used
  for minor keys with the minor-variant ratios (`JI_RATIOS.minor`).

## 2. Pitch-bend encoding

- The current implementation assumes a **±2 semitone** pitch-bend range on
  the synth. This is the MIDI 1.0 default (set on reset) and is universally
  understood by DAWs and software synths. It is explicitly requested via
  RPN 0 during MPE initialisation (see §4).
- Cents → 14-bit pitch bend:
  `pitchBend = round((cents / 200) * 8192)`, clamped to [−8192, 8191].
  The neutral centre is 8192 (sent as MSB/LSB = 64/0 after adding the bias).
- 14-bit serialisation: `lsb = (bend + 8192) & 0x7F`,
  `msb = ((bend + 8192) >> 7) & 0x7F`.
- Transmitted as `[0xE0 | channel, lsb, msb]` per MIDI 1.0 spec.
  (LSB first, then MSB — confirmed against the spec during the 2026-04-19
  engine review. Do not swap.)

## 3. MTS path (`js/tuning-mts.js`)

Used when the selected MIDI output device advertises SysEx support and the
host hasn't been explicitly asked to force MPE. Two sub-modes:

- **Single-note tuning** (preferred for live real-time): one SysEx message
  per note-on, targeting only the single MIDI key about to sound. Low
  bandwidth; no channel allocation needed.
- **Scale/Octave** (bulk): send a 12-note scale tuning in one message when
  the entire pitch class layout needs to change (e.g. at a detected key
  modulation). Amortises the cost across many subsequent notes.

The sender falls back to MPE silently if MTS SysEx is rejected.

## 4. MPE path (`js/tuning-mpe.js`)

### Channel map (lower-zone convention)

- **Master channel** `0` (MIDI channel 1) — receives global config messages
  (MPE Configuration Message, RPN, programme changes).
- **Member channels** `1..15` (MIDI channels 2–16) — each carries at most
  one concurrently-sounding note, whose pitch bend tunes it to JI.

### Initialization sequence (after F3 fix — 2026-04-19)

1. **MPE Configuration Message (MCM)** on master channel 0:
   `[0xB0, 127, 15]` — tells the receiver to enter MPE mode with 15 member
   channels on the lower zone. Required by strict-MPE synths (ROLI Equator²,
   Pianoteq MPE mode, Ableton 12+). Without this, per-channel RPN messages
   may be silently ignored and all pitch-bends applied globally.
2. **Per-member-channel RPN 0** to set pitch-bend range to ±2 semitones:
   - `[0xB0 | ch, 101, 0]` RPN MSB = 0
   - `[0xB0 | ch, 100, 0]` RPN LSB = 0 (RPN 0 = pitch-bend sensitivity)
   - `[0xB0 | ch, 6, 2]`   Data Entry MSB = 2 semitones
   - `[0xB0 | ch, 38, 0]`  Data Entry LSB = 0 (fine-tune = 0 cents)
   - `[0xB0 | ch, 101, 127]` + `[0xB0 | ch, 100, 127]` — reset RPN selector
     to "null" so stray data-entry messages don't accidentally reconfigure
     the synth later.

Executed once per MIDI output session; cached in `pitchBendRangeInitialized`.

### Per-note message order

Every note-on MUST have its channel's pitch bend set BEFORE the note-on:

```
[RPN-once-per-session]  → already done in init
[0xE0 | ch, lsb, msb]   ← pitch bend computed from JI cents deviation
[0x90 | ch, note, vel]  ← note-on
...
[0x80 | ch, note, 0]    ← note-off (when physical key released)
[0xE0 | ch, 0, 64]      ← pitch bend reset to centre (0 cents)
```

The prototype's `forwardNoteExternal` in `js/main.js` enforces this order:
pitch-bend first, then note-on. Note-off is followed by a pitch-bend reset
so the channel returns to equal temperament for any future note stolen into
this channel.

### Channel allocation — LRU with voice stealing

State stored in `activeNotes: Map<noteId, {channel, pitch}>` (F1 fix —
earlier versions stored only `noteId → channel`, which lost the pitch
information needed to release a stolen note).

Allocation rules:

1. **Fresh channel from pool** — use it.
2. **Reused channel (same noteId repeatedly)** — return the existing
   assignment; re-insert into LRU tail.
3. **All 15 channels busy, voice-steal the oldest** — return
   `{channel, reusedNoteId, stolenPitch}`. The caller is responsible for
   emitting a note-off for `stolenPitch` on `channel` BEFORE the new
   note-on on the same channel, otherwise the synth leaves the stolen
   note hanging. This is handled in `main.js:forwardNoteExternal`.

Release rules:

- `releaseChannel(noteId)` is a no-op if the noteId was already voice-stolen
  (because a later note is now owning that channel). The caller's note-off
  for that noteId should ALSO be a no-op — see `getChannelForNote` returning
  `null` as the "stolen-note" guard in `main.js`.

## 5. Known limitations

- **Pitch-bend range is hardcoded ±2 semitones.** MPE-native hardware (ROLI
  Seaboard, LinnStrument) often default to ±48 semitones and may ignore RPN
  0. A UI selector for this is planned (F2 — deferred to Day 2 of the demo
  prep plan). Workaround: configure the synth's MPE input range to ±2
  semitones externally.
- **Only the lower zone is used.** MIDI channel 1 is the master, channels
  2–16 are members. The upper-zone MPE layout (master on channel 16) is
  not implemented.
- **No aftertouch / CC 74 mapping.** Standard MPE includes per-note
  Y-axis (CC 74) and Z-axis (channel pressure) expression. Not used for
  tuning here; passthrough for these is out of scope.

## 6. Local Control — doubled-sound avoidance

When the MIDI output is the SAME keyboard you're playing on (common setup:
Roland FP-10, Yamaha P-series, Casio PX-S, ROLI Seaboard, etc. — any self-
contained digital piano/keyboard), the keyboard's default behaviour is
**Local Control ON**: each physical key press does two things in parallel:

1. Triggers the keyboard's internal voice engine directly from the keybed
   (you hear an **equal-tempered** note immediately)
2. Sends a MIDI-out event

If the browser is configured to output to the same keyboard, step 2's MIDI
loops back:

3. Browser receives MIDI-in
4. Browser applies JI detuning + sends MIDI-out to the keyboard
5. Keyboard plays the detuned note from its MIDI-in path

You hear BOTH the equal-tempered direct voice AND the JI-tuned loop-back
voice. Small tuning differences (e.g. JI major third at −14 ¢) cause audible
beating + a chorus/"echoey" effect. **This is not a bug; it's fundamental
MIDI routing.**

### The fix — send `CC 122, 0` (Local Control Off)

The prototype exposes a **Local Control Off** checkbox in the Setup panel.
When checked:

- On Start: `[0xB0 | ch, 122, 0]` is sent to the output on all 16 channels,
  telling the keyboard "stop triggering your internal voice from the keybed
  directly; only play what comes in via MIDI."
- On Stop: `[0xB0 | ch, 122, 127]` restores normal keybed behaviour.

Recommended usage:

- **Check the box** when output is the keyboard you're playing on. You'll
  hear only the JI-tuned loop-back voice, no doubled sound.
- **Leave unchecked** when output is a separate device or a software synth
  (no local-loop doubling is possible; the CC 122 would be a harmless no-op
  but cleaner to not send it).

### Why this happens more audibly in MPE than MTS

Both modes suffer equally from Local Control doubling. User feedback
singled out MPE as "echoey" likely because:

- MPE sends each note on a unique member channel (2–16), while the keyboard
  receives them all on omni mode. Pitch bends are channel-specific so each
  note gets an individual ±N-cent offset — but the LOCAL voice still plays
  equal-tempered. The mismatch per-note makes the beating more noticeable
  than MTS's single-SysEx-per-note model, which some synths ignore
  silently, producing no loop-back voice at all (and thus no doubling).

---

## 7. Verification protocol (for regression testing)

Use a MIDI monitor application (MidiPipe / Snoize SysEx Librarian /
loopMIDI + MIDI-OX) routed between the prototype output and the synth.

**Expected byte sequence on session start:**
```
B0 7F 0F         ← MCM (CC 127, data=15 member channels)
[for each channel 1..15:]
B1+n 65 00       ← RPN MSB = 0
B1+n 64 00       ← RPN LSB = 0
B1+n 06 02       ← Data Entry MSB = 2
B1+n 26 00       ← Data Entry LSB = 0
B1+n 65 7F       ← Reset RPN MSB
B1+n 64 7F       ← Reset RPN LSB
```

**On each note-on** (assuming JI-mapped to pitch class 4 = major third,
deviation −14 cents, bend = round(−14/200 × 8192) = −573 → serialised as
bias+bend = 7619 → LSB = 67 = 0x43, MSB = 59 = 0x3B):
```
E?+ch 43 3B      ← pitch bend LSB=0x43, MSB=0x3B
9?+ch pitch vel  ← note-on
```

**Voice-stealing test** — hold 16 notes simultaneously (one note per member
channel, then one more). The 16th allocation should produce:
```
8?+ch stolen_pitch 0   ← note-off for the stolen note on the reused channel
E?+ch 00 40            ← pitch bend reset to centre (64 << 7 = 8192, bias = 0)
E?+ch new_lsb new_msb  ← pitch bend for the new note
9?+ch new_pitch vel    ← note-on for the new note
```

**A/B listening test** — play `C-E-G` (tonic major triad) in C major with
the prototype on vs off:

- **ET (off):** the major third (E) beats audibly against C at ~1 Hz.
- **JI (on):** the major third is tuned to 5/4 (386 ¢, −14 ¢ from ET). The
  chord rings cleanly with no audible beating at the third.

If the chord sounds WORSE in MPE than in MTS, F1 is not complete; capture a
MIDI monitor log and compare channel routing of notes and their releases.
