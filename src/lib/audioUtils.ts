import { clamp } from './utils';

export const createAudioContext = (): AudioContext => {
  const Ctx = window.AudioContext;
  if (!Ctx) {
    throw new Error('このブラウザはAudioContextに対応していません');
  }
  return new Ctx();
};

export const decodeBlobToAudioBuffer = async (
  blob: Blob,
  audioContext?: AudioContext,
): Promise<AudioBuffer> => {
  const context = audioContext ?? createAudioContext();
  const arrayBuffer = await blob.arrayBuffer();
  const decoded = await context.decodeAudioData(arrayBuffer.slice(0));
  if (!audioContext) {
    await context.close();
  }
  return decoded;
};

export const mixToMono = (buffer: AudioBuffer): Float32Array => {
  const output = new Float32Array(buffer.length);
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const channelData = buffer.getChannelData(channel);
    for (let i = 0; i < buffer.length; i += 1) {
      output[i] += channelData[i] / buffer.numberOfChannels;
    }
  }
  return output;
};

export const applyMedianSmoothing = (
  values: Array<number | null>,
  windowSize: number,
): Array<number | null> => {
  if (windowSize <= 1) {
    return [...values];
  }
  const half = Math.floor(windowSize / 2);
  return values.map((value, index) => {
    if (value === null) return null;
    const candidates: number[] = [];
    for (let offset = -half; offset <= half; offset += 1) {
      const next = values[index + offset];
      if (next !== null) candidates.push(next);
    }
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => a - b);
    return candidates[Math.floor(candidates.length / 2)];
  });
};

export const createWavBlob = (audioBuffer: AudioBuffer): Blob => {
  const mono = mixToMono(audioBuffer);
  const sampleRate = audioBuffer.sampleRate;
  const bytesPerSample = 2;
  const blockAlign = bytesPerSample;
  const buffer = new ArrayBuffer(44 + mono.length * bytesPerSample);
  const view = new DataView(buffer);

  const writeString = (offset: number, value: string): void => {
    for (let i = 0; i < value.length; i += 1) {
      view.setUint8(offset + i, value.charCodeAt(i));
    }
  };

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + mono.length * bytesPerSample, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeString(36, 'data');
  view.setUint32(40, mono.length * bytesPerSample, true);

  let offset = 44;
  for (let i = 0; i < mono.length; i += 1) {
    const sample = clamp(mono[i], -1, 1);
    view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
    offset += 2;
  }

  return new Blob([buffer], { type: 'audio/wav' });
};
