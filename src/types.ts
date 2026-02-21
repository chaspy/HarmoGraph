export type TrackRole = 'vocal' | 'chorus';

export interface StoredTrack {
  id: string;
  role: TrackRole;
  name: string;
  mimeType: string;
  blob: Blob;
  durationSec: number;
}

export interface AnalysisConfig {
  toleranceCents: number;
  clarityThreshold: number;
  frameSize: number;
  hopSize: number;
}

export interface PitchFrame {
  timeSec: number;
  hz: number | null;
  clarity: number;
}

export interface ErrorFrame {
  timeSec: number;
  cents: number | null;
}

export interface ErrorSegment {
  startSec: number;
  endSec: number;
  avgCents: number;
}

export interface AnalysisStats {
  meanAbsCents: number;
  medianAbsCents: number;
  maxAbsCents: number;
  passRatio: number;
  undetectedRatio: number;
}

export interface AnalysisResult {
  refPitch: PitchFrame[];
  userPitch: PitchFrame[];
  errorFrames: ErrorFrame[];
  stats: AnalysisStats;
  topSegments: ErrorSegment[];
  estimatedOffsetMs: number;
}

export interface Session {
  id: string;
  createdAt: string;
  recording: Blob;
  recordingMimeType: string;
  durationSec: number;
  manualOffsetMs: number;
  analysisConfig: AnalysisConfig;
  analysisResult: AnalysisResult;
}

export interface Project {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  tracks: StoredTrack[];
  sessions: Session[];
}

export interface PlaybackState {
  vocalEnabled: boolean;
  chorusEnabled: boolean;
  vocalVolume: number;
  chorusVolume: number;
  solo: 'none' | TrackRole;
}
