import type { PitchFrame } from '../types';

export interface NoteEvent {
  midi: number;
  startSec: number;
  endSec: number;
  velocity: number;
}

const hzToMidi = (hz: number): number => 69 + 12 * Math.log2(hz / 440);

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

export const extractNoteEvents = (
  frames: PitchFrame[],
  options?: { minDurationSec?: number; maxNotes?: number },
): NoteEvent[] => {
  const minDurationSec = options?.minDurationSec ?? 0.08;
  const maxNotes = options?.maxNotes ?? 2000;

  if (frames.length === 0) return [];

  const quantized = medianFilter(
    frames.map((frame) => (frame.hz === null ? null : Math.round(hzToMidi(frame.hz)))),
    5,
  );

  const notes: NoteEvent[] = [];
  let current: { midi: number; startSec: number; clarities: number[] } | null = null;

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
      };
      continue;
    }

    if (current.midi === midi) {
      current.clarities.push(frame.clarity);
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

export interface PlaybackHandle {
  stop: () => void;
}

export const playNoteEvents = (
  notes: NoteEvent[],
  onPosition?: (sec: number) => void,
  onEnded?: () => void,
): PlaybackHandle => {
  const audioContext = new AudioContext();
  const gain = audioContext.createGain();
  gain.gain.value = 0.18;
  gain.connect(audioContext.destination);

  const startedAt = audioContext.currentTime;
  const oscillators: OscillatorNode[] = [];
  let rafId: number | null = null;
  let stopped = false;

  const maxEnd = notes.reduce((max, note) => Math.max(max, note.endSec), 0);

  for (const note of notes) {
    const osc = audioContext.createOscillator();
    const noteGain = audioContext.createGain();
    const freq = 440 * 2 ** ((note.midi - 69) / 12);
    const start = startedAt + note.startSec;
    const end = startedAt + note.endSec;

    osc.type = 'triangle';
    osc.frequency.setValueAtTime(freq, start);

    const velocityGain = note.velocity / 127;
    noteGain.gain.setValueAtTime(0.0001, start);
    noteGain.gain.exponentialRampToValueAtTime(velocityGain * 0.6, start + 0.01);
    noteGain.gain.exponentialRampToValueAtTime(0.0001, end);

    osc.connect(noteGain);
    noteGain.connect(gain);
    osc.start(start);
    osc.stop(end + 0.02);
    oscillators.push(osc);
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
