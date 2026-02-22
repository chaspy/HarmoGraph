import { BasicPitch } from '@spotify/basic-pitch';
import type { PitchFrame } from '../types';
import { mixToMono } from './audioUtils';

const MODEL_PATH = '/models/basic-pitch/model.json';
const FRAME_SEC = 256 / 22050;
const MIDI_BASE = 21;
const TOP_K = 12;
const SILENCE_THRESHOLD = 0.06;
const JUMP_PENALTY = 0.28;
const LARGE_JUMP_PENALTY = 1.4;

let detectorPromise: Promise<BasicPitch> | null = null;

const getDetector = async (): Promise<BasicPitch> => {
  if (!detectorPromise) {
    detectorPromise = Promise.resolve(new BasicPitch(MODEL_PATH));
  }
  return detectorPromise;
};

const midiToHz = (midi: number): number => 440 * 2 ** ((midi - 69) / 12);

interface Candidate {
  midi: number | null;
  prob: number;
}

const buildCandidates = (frames: number[][]): Candidate[][] => {
  return frames.map((row) => {
    const ranked = row
      .map((prob, index) => ({ midi: MIDI_BASE + index, prob }))
      .sort((a, b) => b.prob - a.prob)
      .slice(0, TOP_K)
      .filter((item) => item.prob > 0.004);

    const maxProb = ranked[0]?.prob ?? 0;
    const withSilence: Candidate[] = [{ midi: null, prob: Math.max(0.01, 0.4 - maxProb) }, ...ranked];
    return withSilence;
  });
};

const transitionCost = (fromMidi: number | null, toMidi: number | null): number => {
  if (fromMidi === null && toMidi === null) return 0;
  if (fromMidi === null || toMidi === null) return 0.22;
  const diff = Math.abs(toMidi - fromMidi);
  if (diff <= 2) return diff * 0.03;
  if (diff <= 12) return diff * JUMP_PENALTY;
  return LARGE_JUMP_PENALTY + diff * 0.11;
};

const stabilizePath = (path: Array<{ midi: number | null; prob: number }>): Array<{
  midi: number | null;
  prob: number;
}> => {
  const out = [...path];

  // Fill very short gaps to avoid fragmented notes.
  for (let i = 1; i < out.length - 1; i += 1) {
    if (out[i].midi !== null) continue;
    const prev = out[i - 1].midi;
    const next = out[i + 1].midi;
    if (prev !== null && next !== null && Math.abs(prev - next) <= 2) {
      out[i] = { midi: Math.round((prev + next) / 2), prob: Math.min(out[i - 1].prob, out[i + 1].prob) };
    }
  }

  // Octave normalization around local history.
  let anchor: number | null = null;
  for (let i = 0; i < out.length; i += 1) {
    const current = out[i];
    if (current.midi === null) continue;
    if (anchor === null) {
      anchor = current.midi;
      continue;
    }
    let best = current.midi;
    let bestAbs = Math.abs(current.midi - anchor);
    for (let shift = -2; shift <= 2; shift += 1) {
      const candidate = current.midi + 12 * shift;
      const abs = Math.abs(candidate - anchor);
      if (abs < bestAbs) {
        bestAbs = abs;
        best = candidate;
      }
    }
    if (bestAbs <= 9) {
      out[i] = { ...current, midi: best };
      anchor = Math.round(anchor * 0.8 + best * 0.2);
    } else {
      out[i] = { midi: null, prob: current.prob };
    }
  }

  return out;
};

const viterbiTrack = (frames: number[][]): Array<{ midi: number | null; prob: number }> => {
  if (frames.length === 0) return [];

  const candidatesPerFrame = buildCandidates(frames);
  const dp: number[][] = [];
  const back: number[][] = [];

  for (let t = 0; t < candidatesPerFrame.length; t += 1) {
    const cands = candidatesPerFrame[t];
    dp[t] = new Array(cands.length).fill(Number.POSITIVE_INFINITY);
    back[t] = new Array(cands.length).fill(-1);

    for (let i = 0; i < cands.length; i += 1) {
      const cand = cands[i];
      const silencePenalty = cand.midi === null ? 0.15 : 0;
      const weakPenalty = cand.prob < SILENCE_THRESHOLD ? 0.35 : 0;
      const emitCost = -Math.log(Math.max(1e-6, cand.prob)) + silencePenalty + weakPenalty;

      if (t === 0) {
        dp[t][i] = emitCost;
        continue;
      }

      const prev = candidatesPerFrame[t - 1];
      for (let j = 0; j < prev.length; j += 1) {
        const score = dp[t - 1][j] + transitionCost(prev[j].midi, cand.midi) + emitCost;
        if (score < dp[t][i]) {
          dp[t][i] = score;
          back[t][i] = j;
        }
      }
    }
  }

  let best = 0;
  let bestScore = dp.at(-1)?.[0] ?? 0;
  const last = dp.length - 1;
  for (let i = 1; i < dp[last].length; i += 1) {
    if (dp[last][i] < bestScore) {
      bestScore = dp[last][i];
      best = i;
    }
  }

  const path: Array<{ midi: number | null; prob: number }> = new Array(candidatesPerFrame.length);
  let index = best;
  for (let t = candidatesPerFrame.length - 1; t >= 0; t -= 1) {
    const candidate = candidatesPerFrame[t][index];
    path[t] = { midi: candidate.midi, prob: candidate.prob };
    index = t > 0 ? back[t][index] : -1;
    if (index < 0 && t > 0) {
      index = 0;
    }
  }

  return stabilizePath(path);
};

export const extractPitchByModel = async (buffer: AudioBuffer): Promise<PitchFrame[]> => {
  const mono = mixToMono(buffer);
  const detector = await getDetector();
  const frames: number[][] = [];

  await detector.evaluateModel(
    mono,
    (batchFrames) => {
      frames.push(...batchFrames);
    },
    () => {
      // no-op
    },
  );

  const tracked = viterbiTrack(frames);
  return tracked.map((item, index) => ({
    timeSec: index * FRAME_SEC,
    hz: item.midi === null ? null : midiToHz(item.midi),
    clarity: item.prob,
  }));
};
