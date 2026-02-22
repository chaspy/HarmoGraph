import { useEffect, useMemo, useRef } from 'react';
import type { ReactElement } from 'react';
import type { NoteEvent } from '../lib/midiPreview';

interface PianoRollProps {
  notes: NoteEvent[];
  durationSec: number;
  cursorSec: number;
}

const WIDTH = 980;
const HEIGHT = 260;

export function PianoRoll(props: PianoRollProps): ReactElement {
  const { notes, durationSec, cursorSec } = props;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const range = useMemo(() => {
    if (notes.length === 0) {
      return { minMidi: 48, maxMidi: 72 };
    }
    const minMidi = Math.min(...notes.map((note) => note.midi)) - 1;
    const maxMidi = Math.max(...notes.map((note) => note.midi)) + 1;
    return { minMidi, maxMidi };
  }, [notes]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const width = canvas.width;
    const height = canvas.height;
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = '#f8fafc';
    ctx.fillRect(0, 0, width, height);

    const laneCount = Math.max(1, range.maxMidi - range.minMidi + 1);
    const laneHeight = height / laneCount;

    ctx.strokeStyle = '#e2e8f0';
    ctx.lineWidth = 1;
    for (let i = 0; i <= laneCount; i += 1) {
      const y = i * laneHeight;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }

    const safeDuration = Math.max(1, durationSec);
    for (const note of notes) {
      const x = (note.startSec / safeDuration) * width;
      const w = Math.max(2, ((note.endSec - note.startSec) / safeDuration) * width);
      const y = (range.maxMidi - note.midi) * laneHeight;
      const alpha = Math.max(0.3, Math.min(1, note.velocity / 127));
      ctx.fillStyle = `rgba(37, 99, 235, ${alpha.toFixed(3)})`;
      ctx.fillRect(x, y, w, laneHeight - 1);
    }

    const cursorX = (Math.min(cursorSec, safeDuration) / safeDuration) * width;
    ctx.strokeStyle = '#dc2626';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cursorX, 0);
    ctx.lineTo(cursorX, height);
    ctx.stroke();
  }, [cursorSec, durationSec, notes, range.maxMidi, range.minMidi]);

  return <canvas className="piano-roll-canvas" ref={canvasRef} width={WIDTH} height={HEIGHT} />;
}
