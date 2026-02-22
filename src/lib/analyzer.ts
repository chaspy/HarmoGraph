import type {
  AnalysisConfig,
  AnalysisResult,
  ErrorFrame,
  ErrorSegment,
  PitchFrame,
  RhythmConfig,
} from '../types';
import { mixToMono } from './audioUtils';
import { extractPitchByModel } from './modelPitch';
import { median } from './utils';

export const DEFAULT_ANALYSIS_CONFIG: AnalysisConfig = {
  toleranceCents: 25,
  clarityThreshold: 0.2,
  frameSize: 4096,
  hopSize: 1024,
};

const centsError = (userHz: number, refHz: number): number => 1200 * Math.log2(userHz / refHz);

const buildEnvelope = (mono: Float32Array, windowSize: number, hopSize: number): number[] => {
  const envelope: number[] = [];
  for (let i = 0; i + windowSize <= mono.length; i += hopSize) {
    let sum = 0;
    for (let j = 0; j < windowSize; j += 1) {
      const sample = mono[i + j];
      sum += sample * sample;
    }
    envelope.push(Math.sqrt(sum / windowSize));
  }
  return envelope;
};

const estimateGlobalOffsetMs = (
  ref: Float32Array,
  user: Float32Array,
  sampleRate: number,
): number => {
  const windowSize = 1024;
  const hopSize = 512;
  const refEnv = buildEnvelope(ref, windowSize, hopSize);
  const userEnv = buildEnvelope(user, windowSize, hopSize);
  if (refEnv.length === 0 || userEnv.length === 0) {
    return 0;
  }

  const maxLagFrames = Math.floor((5 * sampleRate) / hopSize);
  let bestLag = 0;
  let bestScore = Number.NEGATIVE_INFINITY;

  for (let lag = -maxLagFrames; lag <= maxLagFrames; lag += 1) {
    let dot = 0;
    let refPow = 0;
    let userPow = 0;

    for (let i = 0; i < refEnv.length; i += 1) {
      const userIndex = i + lag;
      if (userIndex < 0 || userIndex >= userEnv.length) continue;
      const rv = refEnv[i];
      const uv = userEnv[userIndex];
      dot += rv * uv;
      refPow += rv * rv;
      userPow += uv * uv;
    }

    if (refPow === 0 || userPow === 0) continue;
    const score = dot / Math.sqrt(refPow * userPow);
    if (score > bestScore) {
      bestScore = score;
      bestLag = lag;
    }
  }

  return (bestLag * hopSize * 1000) / sampleRate;
};

const findNearestPitch = (frames: PitchFrame[], targetSec: number): PitchFrame | null => {
  if (frames.length === 0) return null;
  let lo = 0;
  let hi = frames.length - 1;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (frames[mid].timeSec < targetSec) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }

  const current = frames[lo];
  const prev = lo > 0 ? frames[lo - 1] : current;
  return Math.abs(prev.timeSec - targetSec) < Math.abs(current.timeSec - targetSec) ? prev : current;
};

const buildErrorSegments = (
  errors: ErrorFrame[],
  toleranceCents: number,
  minDurationSec = 0.2,
): ErrorSegment[] => {
  const segments: ErrorSegment[] = [];
  let current: { start: number; end: number; values: number[] } | null = null;

  for (const frame of errors) {
    const exceeds = frame.cents !== null && Math.abs(frame.cents) > toleranceCents;
    if (!exceeds) {
      if (current && current.end - current.start >= minDurationSec) {
        const avgCents = current.values.reduce((a, b) => a + b, 0) / current.values.length;
        segments.push({ startSec: current.start, endSec: current.end, avgCents });
      }
      current = null;
      continue;
    }

    if (!current) {
      current = {
        start: frame.timeSec,
        end: frame.timeSec,
        values: [frame.cents as number],
      };
    } else {
      current.end = frame.timeSec;
      current.values.push(frame.cents as number);
    }
  }

  if (current && current.end - current.start >= minDurationSec) {
    const avgCents = current.values.reduce((a, b) => a + b, 0) / current.values.length;
    segments.push({ startSec: current.start, endSec: current.end, avgCents });
  }

  return segments
    .sort((a, b) => Math.abs(b.avgCents) - Math.abs(a.avgCents))
    .slice(0, 3);
};

const finiteOrZero = (value: number): number => (Number.isFinite(value) ? value : 0);
const hzToMidi = (hz: number): number => 69 + 12 * Math.log2(hz / 440);
const midiToHz = (midi: number): number => 440 * 2 ** ((midi - 69) / 12);

const quantizePitchToRhythmGrid = (frames: PitchFrame[], rhythm: RhythmConfig): PitchFrame[] => {
  if (frames.length === 0) return [];
  const bpm = Math.max(1, rhythm.bpm);
  const subdivision = Math.max(1, rhythm.subdivision);
  const stepSec = (60 / bpm) / subdivision;
  const offsetSec = rhythm.clickOffsetMs / 1000;
  const endSec = frames.at(-1)?.timeSec ?? 0;
  const firstIndex = Math.floor((0 - offsetSec) / stepSec) - 1;
  const lastIndex = Math.ceil((endSec - offsetSec) / stepSec) + 1;

  const out: PitchFrame[] = [];
  let frameIndex = 0;
  for (let gridIndex = firstIndex; gridIndex <= lastIndex; gridIndex += 1) {
    const cellStart = offsetSec + gridIndex * stepSec;
    const cellEnd = cellStart + stepSec;
    const hzValues: number[] = [];
    const clarityValues: number[] = [];

    while (frameIndex < frames.length && frames[frameIndex].timeSec < cellStart) {
      frameIndex += 1;
    }
    let scanIndex = frameIndex;
    while (scanIndex < frames.length && frames[scanIndex].timeSec < cellEnd) {
      const frame = frames[scanIndex];
      if (frame.hz !== null) {
        hzValues.push(frame.hz);
      }
      clarityValues.push(frame.clarity);
      scanIndex += 1;
    }

    const hz = hzValues.length > 0 ? median(hzValues) : null;
    const clarity =
      clarityValues.length > 0
        ? clarityValues.reduce((sum, value) => sum + value, 0) / clarityValues.length
        : 0;
    out.push({
      timeSec: cellStart + stepSec / 2,
      hz,
      clarity,
    });
  }

  return out.filter((frame) => frame.timeSec >= 0 && frame.timeSec <= endSec + stepSec);
};

const fillShortNullGaps = (
  frames: PitchFrame[],
  maxGapCells = 2,
  maxSemitoneDiff = 2,
): PitchFrame[] => {
  const out = frames.map((frame) => ({ ...frame }));
  let i = 0;
  while (i < out.length) {
    if (out[i].hz !== null) {
      i += 1;
      continue;
    }
    const start = i;
    while (i < out.length && out[i].hz === null) i += 1;
    const end = i - 1;
    const gap = end - start + 1;
    if (gap > maxGapCells) continue;

    const prev = start > 0 ? out[start - 1] : null;
    const next = i < out.length ? out[i] : null;
    if (!prev || !next || prev.hz === null || next.hz === null) continue;

    const prevMidi = hzToMidi(prev.hz);
    const nextMidi = hzToMidi(next.hz);
    if (Math.abs(prevMidi - nextMidi) > maxSemitoneDiff) continue;

    for (let k = 0; k < gap; k += 1) {
      const ratio = (k + 1) / (gap + 1);
      const midi = prevMidi * (1 - ratio) + nextMidi * ratio;
      out[start + k] = {
        ...out[start + k],
        hz: midiToHz(midi),
        clarity: Math.min(prev.clarity, next.clarity) * 0.9,
      };
    }
  }
  return out;
};

const holdVoicingOnReferenceCells = (
  userFrames: PitchFrame[],
  refFrames: PitchFrame[],
  maxHoldCells = 1,
): PitchFrame[] => {
  const out = userFrames.map((frame) => ({ ...frame }));
  let hold = 0;
  for (let i = 0; i < out.length; i += 1) {
    const user = out[i];
    const ref = refFrames[i];
    if (!user || user.hz !== null) {
      hold = 0;
      continue;
    }
    if (!ref || ref.hz === null) {
      hold = 0;
      continue;
    }
    const prev = i > 0 ? out[i - 1] : null;
    const prevHz = prev?.hz ?? null;
    if (prevHz !== null && prev && hold < maxHoldCells) {
      out[i] = {
        ...user,
        hz: prevHz,
        clarity: Math.max(0.15, prev.clarity * 0.8),
      };
      hold += 1;
    } else {
      hold = 0;
    }
  }
  return out;
};

export const analyzePitch = async (
  refBuffer: AudioBuffer,
  userBuffer: AudioBuffer,
  config: AnalysisConfig,
  manualOffsetMs: number,
  rhythm: RhythmConfig,
): Promise<AnalysisResult> => {
  const refMono = mixToMono(refBuffer);
  const userMono = mixToMono(userBuffer);

  const [rawRefPitch, rawUserPitch] = await Promise.all([
    extractPitchByModel(refBuffer),
    extractPitchByModel(userBuffer),
  ]);
  const refVoiced = rawRefPitch.map((frame) => ({
    ...frame,
    hz: frame.clarity >= config.clarityThreshold ? frame.hz : null,
  }));
  const userVoiced = rawUserPitch.map((frame) => ({
    ...frame,
    hz: frame.clarity >= config.clarityThreshold ? frame.hz : null,
  }));
  const refPitch = quantizePitchToRhythmGrid(refVoiced, rhythm);
  const userGrid = quantizePitchToRhythmGrid(userVoiced, rhythm);
  const userPitch = holdVoicingOnReferenceCells(fillShortNullGaps(userGrid, 2, 2), refPitch, 1);

  const estimatedOffsetMs = estimateGlobalOffsetMs(refMono, userMono, refBuffer.sampleRate);
  const totalOffsetSec = (estimatedOffsetMs + manualOffsetMs) / 1000;

  const errorFrames: ErrorFrame[] = refPitch.map((refFrame) => {
    if (refFrame.hz === null) {
      return { timeSec: refFrame.timeSec, cents: null };
    }
    const candidate = findNearestPitch(userPitch, refFrame.timeSec + totalOffsetSec);
    if (!candidate || candidate.hz === null) {
      return { timeSec: refFrame.timeSec, cents: null };
    }
    return {
      timeSec: refFrame.timeSec,
      cents: centsError(candidate.hz, refFrame.hz),
    };
  });

  const validErrors = errorFrames
    .map((frame) => frame.cents)
    .filter((value): value is number => value !== null)
    .map((value) => Math.abs(value));

  const passCount = validErrors.filter((value) => value <= config.toleranceCents).length;
  const undetectedCount = errorFrames.filter((frame) => frame.cents === null).length;

  const meanAbsCents =
    validErrors.length === 0 ? 0 : validErrors.reduce((a, b) => a + b, 0) / validErrors.length;
  const medianAbsCents = median(validErrors);
  const maxAbsCents = validErrors.length === 0 ? 0 : Math.max(...validErrors);
  const passRatio = validErrors.length === 0 ? 0 : passCount / validErrors.length;
  const undetectedRatio = errorFrames.length === 0 ? 0 : undetectedCount / errorFrames.length;

  return {
    refPitch,
    userPitch,
    errorFrames,
    estimatedOffsetMs: finiteOrZero(estimatedOffsetMs),
    stats: {
      meanAbsCents: finiteOrZero(meanAbsCents),
      medianAbsCents: finiteOrZero(medianAbsCents),
      maxAbsCents: finiteOrZero(maxAbsCents),
      passRatio: finiteOrZero(passRatio),
      undetectedRatio: finiteOrZero(undetectedRatio),
    },
    topSegments: buildErrorSegments(errorFrames, config.toleranceCents),
  };
};
