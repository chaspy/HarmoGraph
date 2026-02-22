import { PitchDetector } from 'pitchy';
import type {
  AnalysisConfig,
  AnalysisResult,
  ErrorFrame,
  ErrorSegment,
  PitchFrame,
} from '../types';
import { applyMedianSmoothing, mixToMono } from './audioUtils';
import { median } from './utils';

export const DEFAULT_ANALYSIS_CONFIG: AnalysisConfig = {
  toleranceCents: 25,
  clarityThreshold: 0.5,
  frameSize: 4096,
  hopSize: 1024,
};

const MIN_HZ = 70;
const MAX_HZ = 1100;
const MIN_RMS = 0.008;

const rms = (frame: Float32Array): number => {
  let sum = 0;
  for (let i = 0; i < frame.length; i += 1) {
    const sample = frame[i];
    sum += sample * sample;
  }
  return Math.sqrt(sum / frame.length);
};

const centsDiff = (aHz: number, bHz: number): number => 1200 * Math.log2(aHz / bHz);

const octaveNormalize = (
  values: Array<number | null>,
  minHz: number,
  maxHz: number,
): Array<number | null> => {
  const normalized: Array<number | null> = [];
  let prev: number | null = null;

  for (const current of values) {
    if (current === null) {
      normalized.push(null);
      continue;
    }
    if (prev === null) {
      normalized.push(current);
      prev = current;
      continue;
    }

    let best = current;
    let bestAbs = Math.abs(centsDiff(current, prev));
    for (let shift = -2; shift <= 2; shift += 1) {
      const candidate = current * 2 ** shift;
      if (candidate < minHz || candidate > maxHz) continue;
      const abs = Math.abs(centsDiff(candidate, prev));
      if (abs < bestAbs) {
        bestAbs = abs;
        best = candidate;
      }
    }

    if (bestAbs > 700) {
      normalized.push(null);
      continue;
    }
    normalized.push(best);
    prev = best;
  }

  return normalized;
};

const suppressIsolatedSpikes = (values: Array<number | null>): Array<number | null> => {
  const out = [...values];
  for (let i = 1; i < values.length - 1; i += 1) {
    const prev = values[i - 1];
    const cur = values[i];
    const next = values[i + 1];
    if (prev === null || cur === null || next === null) continue;
    const dPrev = Math.abs(centsDiff(cur, prev));
    const dNext = Math.abs(centsDiff(cur, next));
    if (dPrev > 300 && dNext > 300) {
      out[i] = Math.sqrt(prev * next);
    }
  }
  return out;
};

const movingAverageHz = (values: Array<number | null>, windowSize: number): Array<number | null> => {
  if (windowSize <= 1) return [...values];
  const half = Math.floor(windowSize / 2);
  return values.map((value, index) => {
    if (value === null) return null;
    let sum = 0;
    let count = 0;
    for (let i = index - half; i <= index + half; i += 1) {
      const candidate = values[i];
      if (candidate === null) continue;
      sum += candidate;
      count += 1;
    }
    return count > 0 ? sum / count : null;
  });
};

const extractPitch = (
  mono: Float32Array,
  sampleRate: number,
  config: AnalysisConfig,
): PitchFrame[] => {
  const detector = PitchDetector.forFloat32Array(config.frameSize);
  const hzSeries: Array<number | null> = [];
  const claritySeries: number[] = [];
  const timeSeries: number[] = [];

  for (let start = 0; start + config.frameSize <= mono.length; start += config.hopSize) {
    const frame = mono.subarray(start, start + config.frameSize);
    const [hz, clarity] = detector.findPitch(frame, sampleRate);
    const energy = rms(frame);
    const valid =
      Number.isFinite(hz) &&
      clarity >= config.clarityThreshold &&
      energy >= MIN_RMS &&
      hz >= MIN_HZ &&
      hz <= MAX_HZ;
    const value = valid ? hz : null;
    hzSeries.push(value);
    claritySeries.push(clarity);
    timeSeries.push(start / sampleRate);
  }

  const octaveFixed = octaveNormalize(hzSeries, MIN_HZ, MAX_HZ);
  const despiked = suppressIsolatedSpikes(octaveFixed);
  const medianSmoothed = applyMedianSmoothing(despiked, 7);
  const smoothed = movingAverageHz(medianSmoothed, 5);
  return smoothed.map((hz, i) => ({
    timeSec: timeSeries[i],
    hz,
    clarity: claritySeries[i],
  }));
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

export const analyzePitch = (
  refBuffer: AudioBuffer,
  userBuffer: AudioBuffer,
  config: AnalysisConfig,
  manualOffsetMs: number,
): AnalysisResult => {
  const refMono = mixToMono(refBuffer);
  const userMono = mixToMono(userBuffer);

  const refPitch = extractPitch(refMono, refBuffer.sampleRate, config);
  const userPitch = extractPitch(userMono, userBuffer.sampleRate, config);

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
