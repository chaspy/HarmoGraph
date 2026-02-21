import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { decodeBlobToAudioBuffer } from '../lib/audioUtils';

interface TrackWave {
  peaks: Float32Array;
  durationSec: number;
}

interface ReferenceWaveformsProps {
  vocalBlob: Blob | null;
  chorusBlob: Blob | null;
  vocalOffsetMs: number;
  chorusOffsetMs: number;
  cursorSec: number;
  onVocalOffsetChange: (offsetMs: number) => void;
  onChorusOffsetChange: (offsetMs: number) => void;
}

const WAVE_WIDTH = 1000;
const WAVE_HEIGHT = 120;
const PEAK_BINS = 800;

const buildPeaks = (buffer: AudioBuffer): TrackWave => {
  const mono = new Float32Array(buffer.length);
  for (let ch = 0; ch < buffer.numberOfChannels; ch += 1) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < data.length; i += 1) {
      mono[i] += data[i] / buffer.numberOfChannels;
    }
  }

  const peaks = new Float32Array(PEAK_BINS);
  const step = Math.max(1, Math.floor(mono.length / PEAK_BINS));
  for (let i = 0; i < PEAK_BINS; i += 1) {
    const start = i * step;
    const end = Math.min(mono.length, start + step);
    let peak = 0;
    for (let j = start; j < end; j += 1) {
      const abs = Math.abs(mono[j]);
      if (abs > peak) peak = abs;
    }
    peaks[i] = peak;
  }

  return {
    peaks,
    durationSec: buffer.duration,
  };
};

const drawWave = (
  canvas: HTMLCanvasElement,
  wave: TrackWave | null,
  color: string,
  offsetSec: number,
  viewStartSec: number,
  viewSpanSec: number,
  cursorSec: number,
): void => {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const width = canvas.width;
  const height = canvas.height;
  const centerY = height / 2;

  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = '#f8fafc';
  ctx.fillRect(0, 0, width, height);

  ctx.strokeStyle = '#dbe3ed';
  ctx.beginPath();
  ctx.moveTo(0, centerY);
  ctx.lineTo(width, centerY);
  ctx.stroke();

  if (wave) {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;

    for (let i = 0; i < wave.peaks.length; i += 1) {
      const trackSec = (i / (wave.peaks.length - 1)) * wave.durationSec;
      const timelineSec = trackSec + offsetSec;
      const x = ((timelineSec - viewStartSec) / viewSpanSec) * width;
      if (x < 0 || x > width) continue;
      const amp = wave.peaks[i] * (height * 0.4);
      ctx.beginPath();
      ctx.moveTo(x, centerY - amp);
      ctx.lineTo(x, centerY + amp);
      ctx.stroke();
    }
  }

  const cursorX = ((cursorSec - viewStartSec) / viewSpanSec) * width;
  ctx.strokeStyle = '#dc2626';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(cursorX, 0);
  ctx.lineTo(cursorX, height);
  ctx.stroke();
};

export function ReferenceWaveforms(props: ReferenceWaveformsProps): ReactElement {
  const {
    vocalBlob,
    chorusBlob,
    vocalOffsetMs,
    chorusOffsetMs,
    cursorSec,
    onVocalOffsetChange,
    onChorusOffsetChange,
  } = props;

  const [vocalWave, setVocalWave] = useState<TrackWave | null>(null);
  const [chorusWave, setChorusWave] = useState<TrackWave | null>(null);

  const vocalCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const chorusCanvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      if (!vocalBlob) {
        setVocalWave(null);
        return;
      }
      const buffer = await decodeBlobToAudioBuffer(vocalBlob);
      if (!alive) return;
      setVocalWave(buildPeaks(buffer));
    })();
    return () => {
      alive = false;
    };
  }, [vocalBlob]);

  useEffect(() => {
    let alive = true;
    void (async () => {
      if (!chorusBlob) {
        setChorusWave(null);
        return;
      }
      const buffer = await decodeBlobToAudioBuffer(chorusBlob);
      if (!alive) return;
      setChorusWave(buildPeaks(buffer));
    })();
    return () => {
      alive = false;
    };
  }, [chorusBlob]);

  const viewport = useMemo(() => {
    const vocalOffsetSec = vocalOffsetMs / 1000;
    const chorusOffsetSec = chorusOffsetMs / 1000;
    const start = Math.min(vocalOffsetSec, chorusOffsetSec, 0);
    const end = Math.max(
      (vocalWave?.durationSec ?? 0) + vocalOffsetSec,
      (chorusWave?.durationSec ?? 0) + chorusOffsetSec,
      1,
    );
    return {
      startSec: start,
      spanSec: Math.max(1, end - start),
    };
  }, [chorusOffsetMs, chorusWave?.durationSec, vocalOffsetMs, vocalWave?.durationSec]);

  useEffect(() => {
    if (vocalCanvasRef.current) {
      drawWave(
        vocalCanvasRef.current,
        vocalWave,
        '#0284c7',
        vocalOffsetMs / 1000,
        viewport.startSec,
        viewport.spanSec,
        cursorSec,
      );
    }
    if (chorusCanvasRef.current) {
      drawWave(
        chorusCanvasRef.current,
        chorusWave,
        '#0f766e',
        chorusOffsetMs / 1000,
        viewport.startSec,
        viewport.spanSec,
        cursorSec,
      );
    }
  }, [
    chorusOffsetMs,
    chorusWave,
    cursorSec,
    viewport.spanSec,
    viewport.startSec,
    vocalOffsetMs,
    vocalWave,
  ]);

  return (
    <section className="card">
      <h3>参照トラック位置合わせ</h3>
      <p>波形を見ながら、再生中にms単位で位置調整できます。</p>

      <div className="wave-stack">
        <div>
          <strong>参照ボーカル</strong>
          <canvas className="wave-canvas" ref={vocalCanvasRef} width={WAVE_WIDTH} height={WAVE_HEIGHT} />
          <label className="offset-slider">
            オフセット: {vocalOffsetMs} ms
            <input
              type="range"
              min={-2000}
              max={2000}
              step={10}
              disabled={!vocalWave}
              value={vocalOffsetMs}
              onChange={(event) => onVocalOffsetChange(Number(event.target.value))}
            />
          </label>
        </div>

        <div>
          <strong>参照コーラス</strong>
          <canvas className="wave-canvas" ref={chorusCanvasRef} width={WAVE_WIDTH} height={WAVE_HEIGHT} />
          <label className="offset-slider">
            オフセット: {chorusOffsetMs} ms
            <input
              type="range"
              min={-2000}
              max={2000}
              step={10}
              disabled={!chorusWave}
              value={chorusOffsetMs}
              onChange={(event) => onChorusOffsetChange(Number(event.target.value))}
            />
          </label>
        </div>
      </div>
    </section>
  );
}
