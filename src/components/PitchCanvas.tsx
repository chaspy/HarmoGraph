import { useEffect, useMemo, useRef } from 'react';
import type { ReactElement } from 'react';
import type { ErrorFrame, PitchFrame } from '../types';

interface PitchCanvasProps {
  refPitch: PitchFrame[];
  userPitch: PitchFrame[];
  errors: ErrorFrame[];
  toleranceCents: number;
  offsetMs: number;
}

const hzToMidi = (hz: number): number => 69 + 12 * Math.log2(hz / 440);

const drawGrid = (ctx: CanvasRenderingContext2D, width: number, height: number): void => {
  ctx.strokeStyle = '#e2e8f0';
  ctx.lineWidth = 1;
  for (let i = 1; i < 6; i += 1) {
    const y = (height / 6) * i;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }
};

const pathFromFrames = (
  ctx: CanvasRenderingContext2D,
  frames: PitchFrame[],
  maxTime: number,
  minMidi: number,
  maxMidi: number,
  width: number,
  height: number,
  offsetSec = 0,
): void => {
  let started = false;
  for (const frame of frames) {
    if (frame.hz === null) {
      started = false;
      continue;
    }
    const midi = hzToMidi(frame.hz);
    const t = frame.timeSec - offsetSec;
    if (t < 0 || t > maxTime) continue;
    const x = (t / maxTime) * width;
    const y = height - ((midi - minMidi) / (maxMidi - minMidi)) * height;
    if (!started) {
      ctx.beginPath();
      ctx.moveTo(x, y);
      started = true;
    } else {
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
};

export function PitchCanvas(props: PitchCanvasProps): ReactElement {
  const { refPitch, userPitch, errors, toleranceCents, offsetMs } = props;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const scale = useMemo(() => {
    const hzValues = [...refPitch, ...userPitch]
      .map((frame) => frame.hz)
      .filter((hz): hz is number => hz !== null)
      .map((hz) => hzToMidi(hz));

    if (hzValues.length === 0) {
      return { minMidi: 40, maxMidi: 80, maxTime: 1 };
    }

    return {
      minMidi: Math.min(...hzValues) - 1,
      maxMidi: Math.max(...hzValues) + 1,
      maxTime: Math.max(
        refPitch.at(-1)?.timeSec ?? 0,
        (userPitch.at(-1)?.timeSec ?? 0) - offsetMs / 1000,
        1,
      ),
    };
  }, [refPitch, userPitch, offsetMs]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const width = canvas.width;
    const height = canvas.height;
    ctx.clearRect(0, 0, width, height);

    drawGrid(ctx, width, height);

    ctx.strokeStyle = 'rgba(220, 38, 38, 0.15)';
    for (const frame of errors) {
      if (frame.cents === null) continue;
      if (Math.abs(frame.cents) <= toleranceCents) continue;
      const x = (frame.timeSec / scale.maxTime) * width;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
    }

    ctx.lineWidth = 2;
    ctx.strokeStyle = '#0f766e';
    pathFromFrames(
      ctx,
      refPitch,
      scale.maxTime,
      scale.minMidi,
      scale.maxMidi,
      width,
      height,
    );

    ctx.strokeStyle = '#0284c7';
    pathFromFrames(
      ctx,
      userPitch,
      scale.maxTime,
      scale.minMidi,
      scale.maxMidi,
      width,
      height,
      offsetMs / 1000,
    );

    ctx.fillStyle = '#0f172a';
    ctx.font = '12px monospace';
    ctx.fillText('緑: 参照コーラス / 青: 自分', 12, 18);
  }, [errors, offsetMs, refPitch, scale.maxMidi, scale.maxTime, scale.minMidi, toleranceCents, userPitch]);

  return <canvas className="pitch-canvas" ref={canvasRef} width={980} height={320} />;
}
