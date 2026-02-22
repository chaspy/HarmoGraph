import type { PitchFrame } from '../types';

export interface NoteEvent {
  midi: number;
  startSec: number;
  endSec: number;
  velocity: number;
}

export interface NoteExtractionOptions {
  minDurationSec?: number;
  maxNotes?: number;
  medianWindow?: number;
  smoothWindow?: number;
  gapFillSemitone?: number;
  continuityLimitSemitone?: number;
  sameNoteToleranceSemitone?: number;
  maxInNoteRangeSemitone?: number;
  maxMergeCells?: number;
}

export interface NoteExtractionDebug {
  score: number;
  coverage: number;
  maeCents: number;
  noteCount: number;
  jumpRatio: number;
  shortRatio: number;
}

export interface AutoExtractResult {
  notes: NoteEvent[];
  options: Required<NoteExtractionOptions>;
  debug: NoteExtractionDebug;
  tried: number;
}

const DEFAULT_EXTRACTION_OPTIONS: Required<NoteExtractionOptions> = {
  minDurationSec: 0.04,
  maxNotes: 2000,
  medianWindow: 7,
  smoothWindow: 5,
  gapFillSemitone: 2,
  continuityLimitSemitone: 9,
  sameNoteToleranceSemitone: 1,
  maxInNoteRangeSemitone: 3,
  maxMergeCells: 2,
};

const hzToMidi = (hz: number): number => 69 + 12 * Math.log2(hz / 440);

const smoothFloat = (values: Array<number | null>, windowSize: number): Array<number | null> => {
  if (windowSize <= 1) return [...values];
  const half = Math.floor(windowSize / 2);
  return values.map((value, index) => {
    if (value === null) return null;
    let sum = 0;
    let count = 0;
    for (let i = index - half; i <= index + half; i += 1) {
      const current = values[i];
      if (current === null) continue;
      sum += current;
      count += 1;
    }
    return count > 0 ? sum / count : null;
  });
};

const medianFilter = (values: Array<number | null>, windowSize: number): Array<number | null> => {
  if (windowSize <= 1) return [...values];
  const half = Math.floor(windowSize / 2);
  return values.map((value, index) => {
    if (value === null) return null;
    const candidates: number[] = [];
    for (let i = index - half; i <= index + half; i += 1) {
      const current = values[i];
      if (current !== null) candidates.push(current);
    }
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => a - b);
    return candidates[Math.floor(candidates.length / 2)];
  });
};

const segmentMedianMidi = (frames: PitchFrame[], startSec: number, endSec: number): number | null => {
  const values = frames
    .filter((frame) => frame.hz !== null && frame.timeSec >= startSec && frame.timeSec < endSec)
    .map((frame) => hzToMidi(frame.hz as number));
  if (values.length === 0) return null;
  values.sort((a, b) => a - b);
  return Math.round(values[Math.floor(values.length / 2)]);
};

export const extractNoteEvents = (
  frames: PitchFrame[],
  options?: NoteExtractionOptions,
): NoteEvent[] => {
  const minDurationSec = options?.minDurationSec ?? 0.04;
  const maxNotes = options?.maxNotes ?? 2000;
  const medianWindow = options?.medianWindow ?? 7;
  const smoothWindow = options?.smoothWindow ?? 5;
  const gapFillSemitone = options?.gapFillSemitone ?? 2;
  const continuityLimitSemitone = options?.continuityLimitSemitone ?? 9;
  const sameNoteToleranceSemitone = options?.sameNoteToleranceSemitone ?? 1;
  const maxInNoteRangeSemitone = options?.maxInNoteRangeSemitone ?? 3;

  if (frames.length === 0) return [];

  const midiTrack = smoothFloat(
    medianFilter(frames.map((frame) => (frame.hz === null ? null : hzToMidi(frame.hz))), medianWindow),
    smoothWindow,
  );

  const quantized = midiTrack.map((midi) => (midi === null ? null : Math.round(midi)));

  // Fill tiny gaps so notes are not split too aggressively.
  for (let i = 1; i < quantized.length - 1; i += 1) {
    if (quantized[i] !== null) continue;
    const prev = quantized[i - 1];
    const next = quantized[i + 1];
    if (prev !== null && next !== null && Math.abs(prev - next) <= gapFillSemitone) {
      quantized[i] = Math.round((prev + next) / 2);
    }
  }

  // Octave continuity correction.
  let anchor: number | null = null;
  for (let i = 0; i < quantized.length; i += 1) {
    const midi = quantized[i];
    if (midi === null) continue;
    if (anchor === null) {
      anchor = midi;
      continue;
    }
    let best = midi;
    let bestAbs = Math.abs(midi - anchor);
    for (let shift = -2; shift <= 2; shift += 1) {
      const candidate = midi + 12 * shift;
      const abs = Math.abs(candidate - anchor);
      if (abs < bestAbs) {
        bestAbs = abs;
        best = candidate;
      }
    }
    quantized[i] = bestAbs <= continuityLimitSemitone ? best : null;
    if (quantized[i] !== null) {
      anchor = Math.round(anchor * 0.75 + (quantized[i] as number) * 0.25);
    }
  }

  const notes: NoteEvent[] = [];
  let current: { midi: number; startSec: number; clarities: number[]; minMidi: number; maxMidi: number } | null =
    null;

  for (let i = 0; i < frames.length; i += 1) {
    const midi = quantized[i];
    const frame = frames[i];
    const nextTime = i + 1 < frames.length ? frames[i + 1].timeSec : frame.timeSec + 0.02;

    if (midi === null) {
      if (current) {
        const duration = frame.timeSec - current.startSec;
        if (duration >= minDurationSec) {
          const meanClarity = current.clarities.reduce((a, b) => a + b, 0) / current.clarities.length;
          notes.push({
            midi: current.midi,
            startSec: current.startSec,
            endSec: frame.timeSec,
            velocity: Math.max(30, Math.min(120, Math.round(meanClarity * 100))),
          });
        }
        current = null;
      }
      continue;
    }

    if (!current) {
      current = {
        midi,
        startSec: frame.timeSec,
        clarities: [frame.clarity],
        minMidi: midi,
        maxMidi: midi,
      };
      continue;
    }

    const nextMin = Math.min(current.minMidi, midi);
    const nextMax = Math.max(current.maxMidi, midi);
    const canContinueByStep = Math.abs(current.midi - midi) <= sameNoteToleranceSemitone;
    const canContinueByRange = nextMax - nextMin <= maxInNoteRangeSemitone;

    if (canContinueByStep && canContinueByRange) {
      current.clarities.push(frame.clarity);
      current.midi = Math.round((current.midi + midi) / 2);
      current.minMidi = nextMin;
      current.maxMidi = nextMax;
      continue;
    }

    const duration = frame.timeSec - current.startSec;
    if (duration >= minDurationSec) {
      const meanClarity = current.clarities.reduce((a, b) => a + b, 0) / current.clarities.length;
      notes.push({
        midi: current.midi,
        startSec: current.startSec,
        endSec: frame.timeSec,
        velocity: Math.max(30, Math.min(120, Math.round(meanClarity * 100))),
      });
    }

    current = {
      midi,
      startSec: frame.timeSec,
      clarities: [frame.clarity],
      minMidi: midi,
      maxMidi: midi,
    };

    if (notes.length >= maxNotes) break;
    if (nextTime <= frame.timeSec) continue;
  }

  if (current) {
    const lastTime = frames.at(-1)?.timeSec ?? current.startSec;
    const duration = lastTime - current.startSec;
    if (duration >= minDurationSec) {
      const meanClarity = current.clarities.reduce((a, b) => a + b, 0) / current.clarities.length;
      notes.push({
        midi: current.midi,
        startSec: current.startSec,
        endSec: lastTime,
        velocity: Math.max(30, Math.min(120, Math.round(meanClarity * 100))),
      });
    }
  }

  return notes;
};

const buildDebugScore = (frames: PitchFrame[], notes: NoteEvent[]): NoteExtractionDebug => {
  if (frames.length === 0) {
    return {
      score: Number.NEGATIVE_INFINITY,
      coverage: 0,
      maeCents: 9999,
      noteCount: 0,
      jumpRatio: 1,
      shortRatio: 1,
    };
  }
  const voicedFrames = frames.filter((frame) => frame.hz !== null).length;
  const durationSec = Math.max(frames.at(-1)?.timeSec ?? 0, 0.001);
  const noteCount = notes.length;
  const notesDuration = notes.reduce((sum, note) => sum + Math.max(0, note.endSec - note.startSec), 0);
  const frameStepSec = durationSec / Math.max(1, frames.length - 1);
  const voicedSec = voicedFrames * frameStepSec;
  const coverage = voicedSec > 0 ? Math.min(1.2, notesDuration / voicedSec) : 0;
  const targetNoteCount = Math.min(320, Math.max(24, Math.round(voicedSec / 0.12)));

  let maeCentsSum = 0;
  let maeCount = 0;
  let noteIndex = 0;
  for (const frame of frames) {
    if (frame.hz === null) continue;
    while (noteIndex < notes.length && notes[noteIndex].endSec < frame.timeSec) {
      noteIndex += 1;
    }
    const note = notes[noteIndex];
    if (!note || frame.timeSec < note.startSec || frame.timeSec > note.endSec) continue;
    const noteHz = 440 * 2 ** ((note.midi - 69) / 12);
    const cents = Math.abs(1200 * Math.log2(frame.hz / noteHz));
    maeCentsSum += cents;
    maeCount += 1;
  }
  const maeCents = maeCount > 0 ? maeCentsSum / maeCount : 9999;

  let jumpCount = 0;
  for (let i = 1; i < notes.length; i += 1) {
    const diff = Math.abs(notes[i].midi - notes[i - 1].midi);
    if (diff >= 8) jumpCount += 1;
  }
  const jumpRatio = notes.length > 1 ? jumpCount / (notes.length - 1) : 0;
  const shortCount = notes.filter((note) => note.endSec - note.startSec < 0.05).length;
  const shortRatio = noteCount > 0 ? shortCount / noteCount : 1;
  const noteCountScore = -Math.abs(Math.log((noteCount + 1) / (targetNoteCount + 1))) * 44;
  const hardLowPenalty = noteCount < targetNoteCount * 0.6 ? (targetNoteCount * 0.6 - noteCount) * 0.75 : 0;

  const score =
    coverage * 240 -
    maeCents * 0.9 -
    jumpRatio * 70 -
    shortRatio * 30 -
    hardLowPenalty +
    noteCountScore;

  return {
    score,
    coverage,
    maeCents,
    noteCount,
    jumpRatio,
    shortRatio,
  };
};

const densifyNotes = (frames: PitchFrame[], notes: NoteEvent[], targetCount: number): NoteEvent[] => {
  if (notes.length === 0 || notes.length >= targetCount) return notes;

  const maxChunkSec = 0.14;
  const out: NoteEvent[] = [];
  for (const note of notes) {
    if (out.length >= targetCount) {
      out.push(note);
      continue;
    }
    const duration = Math.max(0, note.endSec - note.startSec);
    const remain = targetCount - out.length;
    const desiredCuts = Math.min(remain, Math.max(1, Math.ceil(duration / maxChunkSec)));
    if (desiredCuts <= 1 || duration < maxChunkSec * 1.2) {
      out.push(note);
      continue;
    }

    for (let i = 0; i < desiredCuts; i += 1) {
      const segStart = note.startSec + (duration * i) / desiredCuts;
      const segEnd = note.startSec + (duration * (i + 1)) / desiredCuts;
      const midi = segmentMedianMidi(frames, segStart, segEnd) ?? note.midi;
      out.push({
        midi,
        startSec: segStart,
        endSec: segEnd,
        velocity: note.velocity,
      });
    }
  }
  return out;
};

export const autoExtractBestNoteEvents = (frames: PitchFrame[]): AutoExtractResult => {
  const minDurationSecSet = [0.015, 0.02, 0.03, 0.04];
  const medianWindowSet = [5, 7, 9];
  const smoothWindowSet = [3, 5, 7];
  const gapFillSemitoneSet = [1, 2, 3];
  const continuityLimitSet = [7, 9, 11];
  const sameNoteToleranceSet = [0, 1];
  const maxInNoteRangeSet = [1, 2, 3];

  let tried = 0;
  let bestNotes: NoteEvent[] = [];
  let bestOptions: Required<NoteExtractionOptions> = { ...DEFAULT_EXTRACTION_OPTIONS };
  let bestDebug = buildDebugScore(frames, []);
  const voicedFrames = frames.filter((frame) => frame.hz !== null).length;
  const durationSec = Math.max(frames.at(-1)?.timeSec ?? 0, 0.001);
  const frameStepSec = durationSec / Math.max(1, frames.length - 1);
  const voicedSec = voicedFrames * frameStepSec;
  const targetNoteCount = Math.min(320, Math.max(24, Math.round(voicedSec / 0.12)));

  for (const minDurationSec of minDurationSecSet) {
    for (const medianWindow of medianWindowSet) {
      for (const smoothWindow of smoothWindowSet) {
        for (const gapFillSemitone of gapFillSemitoneSet) {
          for (const continuityLimitSemitone of continuityLimitSet) {
            for (const sameNoteToleranceSemitone of sameNoteToleranceSet) {
              for (const maxInNoteRangeSemitone of maxInNoteRangeSet) {
                const options: Required<NoteExtractionOptions> = {
                  minDurationSec,
                  maxNotes: 2000,
                  medianWindow,
                  smoothWindow,
                  gapFillSemitone,
                  continuityLimitSemitone,
                  sameNoteToleranceSemitone,
                  maxInNoteRangeSemitone,
                  maxMergeCells: DEFAULT_EXTRACTION_OPTIONS.maxMergeCells,
                };
                const notes = extractNoteEvents(frames, options);
                const debug = buildDebugScore(frames, notes);
                tried += 1;
                if (debug.score > bestDebug.score) {
                  bestDebug = debug;
                  bestNotes = notes;
                  bestOptions = options;
                }
              }
            }
          }
        }
      }
    }
  }

  if (bestDebug.noteCount < targetNoteCount * 0.72) {
    const aggressive: Required<NoteExtractionOptions> = {
      minDurationSec: 0.01,
      maxNotes: 3000,
      medianWindow: 3,
      smoothWindow: 3,
      gapFillSemitone: 1,
      continuityLimitSemitone: 12,
      sameNoteToleranceSemitone: 0,
      maxInNoteRangeSemitone: 1,
      maxMergeCells: DEFAULT_EXTRACTION_OPTIONS.maxMergeCells,
    };
    const aggressiveNotes = extractNoteEvents(frames, aggressive);
    const aggressiveDebug = buildDebugScore(frames, aggressiveNotes);
    tried += 1;

    const chooseAggressive =
      aggressiveDebug.noteCount > bestDebug.noteCount * 1.2 &&
      aggressiveDebug.maeCents <= bestDebug.maeCents + 45;

    if (chooseAggressive) {
      bestNotes = aggressiveNotes;
      bestOptions = aggressive;
      bestDebug = aggressiveDebug;
    }
  }

  if (bestNotes.length < targetNoteCount * 0.9) {
    const densified = densifyNotes(frames, bestNotes, Math.round(targetNoteCount));
    const densifiedDebug = buildDebugScore(frames, densified);
    tried += 1;
    if (densifiedDebug.score >= bestDebug.score - 28 && densifiedDebug.noteCount > bestDebug.noteCount) {
      bestNotes = densified;
      bestDebug = densifiedDebug;
    }
  }

  return {
    notes: bestNotes,
    options: bestOptions,
    debug: bestDebug,
    tried,
  };
};

export const extractGridAlignedNoteEvents = (frames: PitchFrame[]): AutoExtractResult => {
  if (frames.length === 0) {
    return {
      notes: [],
      options: { ...DEFAULT_EXTRACTION_OPTIONS },
      debug: {
        score: 0,
        coverage: 0,
        maeCents: 0,
        noteCount: 0,
        jumpRatio: 0,
        shortRatio: 0,
      },
      tried: 1,
    };
  }

  const notes: NoteEvent[] = [];
  let current: NoteEvent | null = null;
  let currentCells = 0;
  const maxMergeCells = DEFAULT_EXTRACTION_OPTIONS.maxMergeCells;

  const frameWindow = (index: number): { startSec: number; endSec: number } => {
    const time = frames[index].timeSec;
    const prevTime = index > 0 ? frames[index - 1].timeSec : time;
    const nextTime = index + 1 < frames.length ? frames[index + 1].timeSec : time;
    const start = index > 0 ? (prevTime + time) / 2 : Math.max(0, time - (nextTime - time) / 2);
    const end = index + 1 < frames.length ? (time + nextTime) / 2 : time + (time - prevTime) / 2;
    return {
      startSec: Math.max(0, start),
      endSec: Math.max(Math.max(0, start), end),
    };
  };

  for (let i = 0; i < frames.length; i += 1) {
    const frame = frames[i];
    const window = frameWindow(i);
    if (frame.hz === null) {
      if (current) {
        notes.push(current);
        current = null;
      }
      continue;
    }

    const midi = Math.round(hzToMidi(frame.hz));
    const velocity = Math.max(30, Math.min(120, Math.round(frame.clarity * 100)));
    if (
      current &&
      current.midi === midi &&
      Math.abs(current.endSec - window.startSec) <= 0.03 &&
      currentCells < maxMergeCells
    ) {
      current.endSec = window.endSec;
      current.velocity = Math.max(current.velocity, velocity);
      currentCells += 1;
      continue;
    }

    if (current) {
      notes.push(current);
    }
    current = {
      midi,
      startSec: window.startSec,
      endSec: window.endSec,
      velocity,
    };
    currentCells = 1;
  }

  if (current) {
    notes.push(current);
  }

  const debug = buildDebugScore(frames, notes);
  return {
    notes,
    options: { ...DEFAULT_EXTRACTION_OPTIONS },
    debug,
    tried: 1,
  };
};

export interface PlaybackHandle {
  stop: () => void;
}

export const playNoteEvents = (
  notes: NoteEvent[],
  onPosition?: (sec: number) => void,
  onEnded?: () => void,
): PlaybackHandle => {
  const audioContext = new AudioContext();
  const limiter = audioContext.createDynamicsCompressor();
  limiter.threshold.value = -10;
  limiter.knee.value = 14;
  limiter.ratio.value = 3;
  limiter.attack.value = 0.003;
  limiter.release.value = 0.2;

  const gain = audioContext.createGain();
  gain.gain.value = 0.8;
  gain.connect(limiter);
  limiter.connect(audioContext.destination);

  const startedAt = audioContext.currentTime;
  const oscillators: OscillatorNode[] = [];
  let rafId: number | null = null;
  let stopped = false;

  const maxEnd = notes.reduce((max, note) => Math.max(max, note.endSec), 0);

  for (const note of notes) {
    const osc = audioContext.createOscillator();
    const osc2 = audioContext.createOscillator();
    const osc3 = audioContext.createOscillator();
    const noteGain = audioContext.createGain();
    const freq = 440 * 2 ** ((note.midi - 69) / 12);
    const start = startedAt + note.startSec;
    const end = startedAt + note.endSec;

    osc.type = 'triangle';
    osc2.type = 'sine';
    osc3.type = 'sawtooth';
    osc.frequency.setValueAtTime(freq, start);
    osc2.frequency.setValueAtTime(freq * 2, start);
    osc3.frequency.setValueAtTime(freq * 0.5, start);

    const velocityGain = Math.max(0.25, note.velocity / 127);
    noteGain.gain.setValueAtTime(0.0001, start);
    noteGain.gain.exponentialRampToValueAtTime(velocityGain, start + 0.006);
    noteGain.gain.exponentialRampToValueAtTime(0.0001, end);

    osc.connect(noteGain);
    osc2.connect(noteGain);
    osc3.connect(noteGain);
    noteGain.connect(gain);
    osc.start(start);
    osc2.start(start);
    osc3.start(start);
    osc.stop(end + 0.02);
    osc2.stop(end + 0.02);
    osc3.stop(end + 0.02);
    oscillators.push(osc);
    oscillators.push(osc2);
    oscillators.push(osc3);
  }

  const tick = (): void => {
    if (stopped) return;
    const sec = audioContext.currentTime - startedAt;
    onPosition?.(Math.max(0, sec));
    if (sec >= maxEnd) {
      stopped = true;
      onEnded?.();
      void audioContext.close();
      return;
    }
    rafId = window.requestAnimationFrame(tick);
  };
  rafId = window.requestAnimationFrame(tick);

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    for (const osc of oscillators) {
      try {
        osc.stop();
      } catch {
        // ignore
      }
    }
    if (rafId !== null) {
      window.cancelAnimationFrame(rafId);
    }
    onEnded?.();
    void audioContext.close();
  };

  return { stop };
};
