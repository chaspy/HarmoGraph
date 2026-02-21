export interface RecorderResult {
  blob: Blob;
  mimeType: string;
  durationSec: number;
}

export class Recorder {
  private mediaRecorder: MediaRecorder | null = null;

  private stream: MediaStream | null = null;

  private startedAt = 0;

  async start(): Promise<void> {
    if (this.mediaRecorder?.state === 'recording') {
      throw new Error('すでに録音中です');
    }

    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: false,
      },
    });

    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : 'audio/webm';

    this.mediaRecorder = new MediaRecorder(this.stream, { mimeType });
    this.startedAt = performance.now();
    this.mediaRecorder.start();
  }

  async stop(): Promise<RecorderResult> {
    const recorder = this.mediaRecorder;
    if (!recorder) {
      throw new Error('録音が開始されていません');
    }

    const chunks: BlobPart[] = [];
    const blob = await new Promise<Blob>((resolve, reject) => {
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          chunks.push(event.data);
        }
      };
      recorder.onerror = () => reject(new Error('録音エラー'));
      recorder.onstop = () => {
        resolve(new Blob(chunks, { type: recorder.mimeType || 'audio/webm' }));
      };
      recorder.stop();
    });

    const durationSec = Math.max(0, (performance.now() - this.startedAt) / 1000);
    this.stream?.getTracks().forEach((track) => track.stop());
    this.mediaRecorder = null;
    this.stream = null;

    return {
      blob,
      mimeType: blob.type || recorder.mimeType || 'audio/webm',
      durationSec,
    };
  }
}
