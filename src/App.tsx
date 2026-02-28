import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './App.css';
import { PianoRoll } from './components/PianoRoll';
import { PitchCanvas } from './components/PitchCanvas';
import { ReferenceWaveforms } from './components/ReferenceWaveforms';
import { autoExtractBestNoteEvents, extractGridAlignedNoteEvents, playNoteEvents } from './lib/midiPreview';
import type { AutoExtractResult, NoteEvent } from './lib/midiPreview';
import { analyzePitch, DEFAULT_ANALYSIS_CONFIG } from './lib/analyzer';
import { decodeBlobToAudioBuffer } from './lib/audioUtils';
import { extractPitchByModel } from './lib/modelPitch';
import { Recorder } from './lib/recorder';
import { deleteProject, loadProjects, saveProject } from './lib/storage';
import { useObjectUrl } from './lib/useObjectUrl';
import { clamp, createId, formatSec } from './lib/utils';
import type {
  AnalysisConfig,
  PlaybackState,
  PitchFrame,
  Project,
  ReferenceAlignConfig,
  RhythmConfig,
  Session,
  StoredTrack,
  TrackRole,
} from './types';

const MAX_SONG_SEC = 600;
const WARN_SONG_SEC = 300;
const DEFAULT_BPM = 120;
const DEFAULT_REFERENCE_ALIGN_CONFIG: ReferenceAlignConfig = {
  clickEnabled: true,
  clickVolume: 0.35,
  bpm: DEFAULT_BPM,
  beatsPerBar: 4,
  clickOffsetMs: 0,
};

const defaultPlayback: PlaybackState = {
  vocalEnabled: true,
  chorusEnabled: true,
  vocalVolume: 0.8,
  chorusVolume: 1,
  solo: 'none',
};

function App() {
  type MidiPreviewSource = 'reference_vocal' | 'reference_chorus' | 'user_recording';
  interface PreviewExtractionResult {
    extractResult: AutoExtractResult;
    sourceStartSec: number;
    sourceDurationSec: number;
    sourceLabel: string;
    sourceKind: MidiPreviewSource;
  }
  const midiToHz = (midi: number): number => 440 * 2 ** ((midi - 69) / 12);
  const midiToNoteName = (midi: number): string => {
    const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    const rounded = Math.round(midi);
    const octave = Math.floor(rounded / 12) - 1;
    const name = names[((rounded % 12) + 12) % 12];
    return `${name}${octave}`;
  };
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [newProjectName, setNewProjectName] = useState('');
  const [status, setStatus] = useState('ローカル起動中。マイクは練習開始時に許可してください。');
  const [toastVisible, setToastVisible] = useState(true);
  const [playback, setPlayback] = useState<PlaybackState>(defaultPlayback);
  const [isRecording, setIsRecording] = useState(false);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [referenceRecordingRole, setReferenceRecordingRole] = useState<TrackRole | null>(null);
  const [referenceCursorSec, setReferenceCursorSec] = useState(0);
  const [isReferencePlaying, setIsReferencePlaying] = useState(false);
  const [clickEnabled, setClickEnabled] = useState(DEFAULT_REFERENCE_ALIGN_CONFIG.clickEnabled);
  const [clickVolume, setClickVolume] = useState(DEFAULT_REFERENCE_ALIGN_CONFIG.clickVolume);
  const [bpm, setBpm] = useState(DEFAULT_REFERENCE_ALIGN_CONFIG.bpm);
  const [beatsPerBar, setBeatsPerBar] = useState(DEFAULT_REFERENCE_ALIGN_CONFIG.beatsPerBar);
  const [clickOffsetMs, setClickOffsetMs] = useState(DEFAULT_REFERENCE_ALIGN_CONFIG.clickOffsetMs);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [manualOffsetMs, setManualOffsetMs] = useState(0);
  const [analysisConfig, setAnalysisConfig] = useState<AnalysisConfig>(DEFAULT_ANALYSIS_CONFIG);
  const [previewNotes, setPreviewNotes] = useState<{ sessionId: string; notes: NoteEvent[] } | null>(
    null,
  );
  const [previewMeta, setPreviewMeta] = useState<{ sessionId: string; result: AutoExtractResult } | null>(
    null,
  );
  const [noteCursorSec, setNoteCursorSec] = useState(0);
  const [isNotePlaying, setIsNotePlaying] = useState(false);
  const [isAnalysisComparePlaying, setIsAnalysisComparePlaying] = useState(false);
  const [midiPreviewWithReference, setMidiPreviewWithReference] = useState(true);
  const [midiPreviewWithClick, setMidiPreviewWithClick] = useState(true);
  const [midiPreviewSource, setMidiPreviewSource] = useState<MidiPreviewSource>('reference_vocal');
  const [previewSourceInfo, setPreviewSourceInfo] = useState<{
    sessionId: string;
    startSec: number;
    durationSec: number;
    label: string;
    kind: MidiPreviewSource;
  } | null>(null);

  const recorderRef = useRef(new Recorder());
  const referenceRecorderRef = useRef(new Recorder());
  const recordingRef = useRef(false);
  const vocalAudioRef = useRef<HTMLAudioElement | null>(null);
  const chorusAudioRef = useRef<HTMLAudioElement | null>(null);
  const userAudioRef = useRef<HTMLAudioElement | null>(null);
  const referenceTimeoutIdsRef = useRef<number[]>([]);
  const referenceRafRef = useRef<number | null>(null);
  const metronomeContextRef = useRef<AudioContext | null>(null);
  const referencePlayAnchorRef = useRef<{
    startedAtMs: number;
    startSec: number;
    endSec: number;
  } | null>(null);
  const notePlaybackRef = useRef<{ stop: () => void } | null>(null);
  const midiPreviewTimeoutIdsRef = useRef<number[]>([]);
  const midiPreviewMetronomeRef = useRef<AudioContext | null>(null);
  const analysisCompareTimeoutIdsRef = useRef<number[]>([]);
  const toastTimerRef = useRef<number | null>(null);

  const selectedProject = useMemo(
    () => projects.find((project) => project.id === selectedProjectId) ?? null,
    [projects, selectedProjectId],
  );

  const getTrack = (role: TrackRole): StoredTrack | null => {
    if (!selectedProject) return null;
    return selectedProject.tracks.find((track) => track.role === role) ?? null;
  };
  const getTrackOffsetMs = useCallback(
    (role: TrackRole): number =>
      selectedProject?.tracks.find((track) => track.role === role)?.offsetMs ?? 0,
    [selectedProject],
  );

  const vocalTrack = getTrack('vocal');
  const chorusTrack = getTrack('chorus');
  const getReferenceEndSec = useCallback(
    (vocalOffsetSec: number, chorusOffsetSec: number): number =>
      Math.max(
        (vocalTrack?.durationSec ?? 0) + vocalOffsetSec,
        (chorusTrack?.durationSec ?? 0) + chorusOffsetSec,
        1,
      ),
    [chorusTrack?.durationSec, vocalTrack?.durationSec],
  );

  const selectedSession = useMemo(() => {
    if (!selectedProject) return null;
    if (activeSessionId) {
      return selectedProject.sessions.find((session) => session.id === activeSessionId) ?? null;
    }
    return selectedProject.sessions.at(0) ?? null;
  }, [activeSessionId, selectedProject]);

  const vocalUrl = useObjectUrl(vocalTrack?.blob);
  const chorusUrl = useObjectUrl(chorusTrack?.blob);
  const userRecordingUrl = useObjectUrl(selectedSession?.recording);
  const currentPreviewNotes =
    selectedSession && previewNotes?.sessionId === selectedSession.id ? previewNotes.notes : [];
  const previewDurationSec = currentPreviewNotes.reduce((max, note) => Math.max(max, note.endSec), 1);
  const currentPreviewMeta =
    selectedSession && previewMeta?.sessionId === selectedSession.id ? previewMeta.result : null;
  const activePreviewSourceInfo =
    selectedSession && previewSourceInfo?.sessionId === selectedSession.id ? previewSourceInfo : null;
  const sourceCursorSec = clamp(
    noteCursorSec,
    0,
    Math.max(0.001, activePreviewSourceInfo?.durationSec ?? previewDurationSec),
  );
  const sourceCursorRatio =
    sourceCursorSec / Math.max(0.001, activePreviewSourceInfo?.durationSec ?? previewDurationSec);
  const previewTimelineSec = Math.max(0.001, activePreviewSourceInfo?.durationSec ?? previewDurationSec);
  const activePreviewNote = useMemo(
    () =>
      currentPreviewNotes.find((note) => note.startSec <= noteCursorSec && noteCursorSec <= note.endSec) ?? null,
    [currentPreviewNotes, noteCursorSec],
  );

  useEffect(() => {
    void (async () => {
      const loaded = await loadProjects();
      setProjects(loaded);
      if (loaded.length > 0) {
        setSelectedProjectId(loaded[0].id);
      }
    })();
  }, []);

  useEffect(() => {
    recordingRef.current = isRecording;
  }, [isRecording]);

  useEffect(() => {
    setToastVisible(true);
    if (toastTimerRef.current !== null) {
      window.clearTimeout(toastTimerRef.current);
      toastTimerRef.current = null;
    }
    const isOngoing =
      status.includes('中') || status.includes('待機') || status.includes('解析') || status.includes('録音');
    if (!isOngoing) {
      toastTimerRef.current = window.setTimeout(() => {
        setToastVisible(false);
        toastTimerRef.current = null;
      }, 4200);
    }
  }, [status]);

  useEffect(() => {
    return () => {
      notePlaybackRef.current?.stop();
      notePlaybackRef.current = null;
      midiPreviewTimeoutIdsRef.current.forEach((id) => window.clearTimeout(id));
      midiPreviewTimeoutIdsRef.current = [];
      midiPreviewMetronomeRef.current?.close().catch(() => {});
      midiPreviewMetronomeRef.current = null;
      analysisCompareTimeoutIdsRef.current.forEach((id) => window.clearTimeout(id));
      analysisCompareTimeoutIdsRef.current = [];
      metronomeContextRef.current?.close().catch(() => {});
      metronomeContextRef.current = null;
      if (toastTimerRef.current !== null) {
        window.clearTimeout(toastTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!selectedSession) {
      setManualOffsetMs(0);
      return;
    }
    setManualOffsetMs(selectedSession.manualOffsetMs);
    setAnalysisConfig(selectedSession.analysisConfig);
  }, [selectedSession]);

  useEffect(() => {
    const config = selectedProject?.referenceAlignConfig ?? DEFAULT_REFERENCE_ALIGN_CONFIG;
    setClickEnabled(config.clickEnabled);
    setClickVolume(config.clickVolume);
    setBpm(config.bpm);
    setBeatsPerBar(config.beatsPerBar);
    setClickOffsetMs(config.clickOffsetMs);
  }, [selectedProject]);

  useEffect(() => {
    const vocal = vocalAudioRef.current;
    const chorus = chorusAudioRef.current;
    if (vocal) {
      const enabled = playback.solo === 'none' ? playback.vocalEnabled : playback.solo === 'vocal';
      vocal.muted = !enabled;
      vocal.volume = playback.vocalVolume;
    }
    if (chorus) {
      const enabled = playback.solo === 'none' ? playback.chorusEnabled : playback.solo === 'chorus';
      chorus.muted = !enabled;
      chorus.volume = playback.chorusVolume;
    }
  }, [playback]);

  const persistProject = async (project: Project): Promise<void> => {
    const updated = { ...project, updatedAt: new Date().toISOString() };
    await saveProject(updated);
    setProjects((current) => {
      const next = current.filter((item) => item.id !== updated.id);
      return [updated, ...next].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    });
  };

  const persistReferenceAlignConfig = async (
    patch: Partial<ReferenceAlignConfig>,
  ): Promise<void> => {
    if (!selectedProject) return;
    const current = selectedProject.referenceAlignConfig ?? DEFAULT_REFERENCE_ALIGN_CONFIG;
    const nextProject: Project = {
      ...selectedProject,
      referenceAlignConfig: {
        ...current,
        ...patch,
      },
    };
    await persistProject(nextProject);
  };

  const createProject = async (): Promise<void> => {
    const name = newProjectName.trim();
    if (!name) {
      setStatus('曲名を入力してください。');
      return;
    }
    const now = new Date().toISOString();
    const project: Project = {
      id: createId(),
      name,
      createdAt: now,
      updatedAt: now,
      tracks: [],
      sessions: [],
      referenceAlignConfig: DEFAULT_REFERENCE_ALIGN_CONFIG,
    };
    await saveProject(project);
    setProjects((current) => [project, ...current]);
    setSelectedProjectId(project.id);
    setNewProjectName('');
    setStatus(`曲「${name}」を作成しました。`);
  };

  const registerTrack = async (
    role: TrackRole,
    payload: {
      blob: Blob;
      name: string;
      mimeType: string;
      durationSec: number;
    },
  ): Promise<void> => {
    if (!selectedProject) return;
    if (payload.durationSec > MAX_SONG_SEC) {
      setStatus('10分を超える音源はMVP対象外です。10分以内にしてください。');
      return;
    }

    const track: StoredTrack = {
      id: createId(),
      role,
      name: payload.name,
      mimeType: payload.mimeType,
      blob: payload.blob,
      durationSec: payload.durationSec,
      offsetMs: 0,
    };

    const nextProject: Project = {
      ...selectedProject,
      tracks: [...selectedProject.tracks.filter((item) => item.role !== role), track],
    };

    await persistProject(nextProject);

    if (payload.durationSec > WARN_SONG_SEC) {
      setStatus('5分を超える音源です。解析に時間がかかる可能性があります。');
    } else {
      setStatus(`${role === 'vocal' ? 'ボーカル' : 'コーラス'}音源を登録しました。`);
    }
  };

  const onUploadTrack = async (role: TrackRole, file: File | null): Promise<void> => {
    if (!selectedProject || !file) return;

    const probe = document.createElement('audio');
    const probeUrl = URL.createObjectURL(file);
    probe.src = probeUrl;

    const durationSec = await new Promise<number>((resolve, reject) => {
      probe.onloadedmetadata = () => resolve(probe.duration || 0);
      probe.onerror = () => reject(new Error('音声のメタデータ取得に失敗しました'));
    });
    URL.revokeObjectURL(probeUrl);

    await registerTrack(role, {
      blob: file,
      name: file.name,
      mimeType: file.type || 'audio/mpeg',
      durationSec,
    });
  };

  const startReferenceRecording = async (role: TrackRole): Promise<void> => {
    if (!selectedProject) return;
    if (recordingRef.current || isRecording) {
      setStatus('練習録音中は参照録音を開始できません。');
      return;
    }
    if (referenceRecordingRole) return;

    try {
      setStatus(
        `${role === 'vocal' ? '参照ボーカル' : '参照コーラス'}の録音開始。マイク権限を確認します。`,
      );
      await referenceRecorderRef.current.start();
      setReferenceRecordingRole(role);
    } catch (error) {
      const message = error instanceof Error ? error.message : '参照録音の開始に失敗しました';
      setStatus(`参照録音開始エラー: ${message}`);
      setReferenceRecordingRole(null);
    }
  };

  const stopReferenceRecording = async (): Promise<void> => {
    if (!referenceRecordingRole) return;
    const role = referenceRecordingRole;
    try {
      const recording = await referenceRecorderRef.current.stop();
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const ext = recording.mimeType.includes('mp4') ? 'm4a' : 'webm';
      await registerTrack(role, {
        blob: recording.blob,
        name: `recorded-${role}-${timestamp}.${ext}`,
        mimeType: recording.mimeType,
        durationSec: recording.durationSec,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : '参照録音の停止に失敗しました';
      setStatus(`参照録音停止エラー: ${message}`);
    } finally {
      setReferenceRecordingRole(null);
    }
  };

  const stopAllPlayback = (): void => {
    referenceTimeoutIdsRef.current.forEach((id) => window.clearTimeout(id));
    referenceTimeoutIdsRef.current = [];
    if (referenceRafRef.current !== null) {
      window.cancelAnimationFrame(referenceRafRef.current);
      referenceRafRef.current = null;
    }
    referencePlayAnchorRef.current = null;
    setIsReferencePlaying(false);
    setReferenceCursorSec(0);
    metronomeContextRef.current?.close().catch(() => {});
    metronomeContextRef.current = null;
    midiPreviewTimeoutIdsRef.current.forEach((id) => window.clearTimeout(id));
    midiPreviewTimeoutIdsRef.current = [];
    midiPreviewMetronomeRef.current?.close().catch(() => {});
    midiPreviewMetronomeRef.current = null;
    analysisCompareTimeoutIdsRef.current.forEach((id) => window.clearTimeout(id));
    analysisCompareTimeoutIdsRef.current = [];
    [vocalAudioRef.current, chorusAudioRef.current, userAudioRef.current].forEach((audio) => {
      if (!audio) return;
      audio.pause();
      audio.currentTime = 0;
    });
    notePlaybackRef.current?.stop();
    notePlaybackRef.current = null;
    setIsNotePlaying(false);
    setIsAnalysisComparePlaying(false);
    setNoteCursorSec(0);
  };

  const resetReferencePlayback = (): void => {
    referenceTimeoutIdsRef.current.forEach((id) => window.clearTimeout(id));
    referenceTimeoutIdsRef.current = [];
    if (referenceRafRef.current !== null) {
      window.cancelAnimationFrame(referenceRafRef.current);
      referenceRafRef.current = null;
    }
    referencePlayAnchorRef.current = null;
    setIsReferencePlaying(false);
    setReferenceCursorSec(0);
    metronomeContextRef.current?.close().catch(() => {});
    metronomeContextRef.current = null;
    const vocal = vocalAudioRef.current;
    const chorus = chorusAudioRef.current;
    if (vocal) {
      vocal.pause();
      vocal.currentTime = Math.max(0, -getTrackOffsetMs('vocal') / 1000);
    }
    if (chorus) {
      chorus.pause();
      chorus.currentTime = Math.max(0, -getTrackOffsetMs('chorus') / 1000);
    }
  };

  const updateTrackOffset = async (role: TrackRole, offsetMs: number): Promise<void> => {
    if (!selectedProject) return;
    const target = getTrack(role);
    if (!target) return;
    const nextProject: Project = {
      ...selectedProject,
      tracks: selectedProject.tracks.map((track) =>
        track.id === target.id ? { ...track, offsetMs } : track,
      ),
    };
    await persistProject(nextProject);
  };

  const changeReferenceOffset = async (role: TrackRole, offsetMs: number): Promise<void> => {
    const timelineSec = isReferencePlaying ? computeReferenceTimelineSec() : referenceCursorSec;
    await updateTrackOffset(role, offsetMs);
    if (isReferencePlaying) {
      await playReference(timelineSec);
    }
  };

  const seekReference = (timelineSec: number): void => {
    const sec = Math.max(0, timelineSec);
    setReferenceCursorSec(sec);
    if (isReferencePlaying) {
      void playReference(sec);
      return;
    }
    const vocal = vocalAudioRef.current;
    const chorus = chorusAudioRef.current;
    if (vocal) {
      vocal.currentTime = Math.max(0, sec - getTrackOffsetMs('vocal') / 1000);
    }
    if (chorus) {
      chorus.currentTime = Math.max(0, sec - getTrackOffsetMs('chorus') / 1000);
    }
  };

  const computeReferenceTimelineSec = useCallback((): number => {
    const points: number[] = [];
    const vocal = vocalAudioRef.current;
    const chorus = chorusAudioRef.current;
    if (vocal && !vocal.paused && !Number.isNaN(vocal.currentTime)) {
      points.push(vocal.currentTime + getTrackOffsetMs('vocal') / 1000);
    }
    if (chorus && !chorus.paused && !Number.isNaN(chorus.currentTime)) {
      points.push(chorus.currentTime + getTrackOffsetMs('chorus') / 1000);
    }
    if (points.length === 0) {
      const anchor = referencePlayAnchorRef.current;
      if (anchor) {
        const elapsedSec = (performance.now() - anchor.startedAtMs) / 1000;
        return Math.min(anchor.endSec, Math.max(0, anchor.startSec + elapsedSec));
      }
      return referenceCursorSec;
    }
    return Math.max(...points, 0);
  }, [getTrackOffsetMs, referenceCursorSec]);

  const pauseReference = (): void => {
    referenceTimeoutIdsRef.current.forEach((id) => window.clearTimeout(id));
    referenceTimeoutIdsRef.current = [];
    const timelineSec = computeReferenceTimelineSec();
    setReferenceCursorSec(Math.max(0, timelineSec));
    referencePlayAnchorRef.current = null;
    setIsReferencePlaying(false);
    metronomeContextRef.current?.close().catch(() => {});
    metronomeContextRef.current = null;
    [vocalAudioRef.current, chorusAudioRef.current].forEach((audio) => {
      if (!audio) return;
      audio.pause();
    });
  };

  const playReference = async (fromSec?: number): Promise<void> => {
    if (!vocalUrl && !chorusUrl) {
      setStatus('参照トラックがありません。');
      return;
    }
    const startSec = Math.max(0, fromSec ?? referenceCursorSec);
    const vocalOffsetSec = getTrackOffsetMs('vocal') / 1000;
    const chorusOffsetSec = getTrackOffsetMs('chorus') / 1000;
    const endSec = getReferenceEndSec(vocalOffsetSec, chorusOffsetSec);

    referenceTimeoutIdsRef.current.forEach((id) => window.clearTimeout(id));
    referenceTimeoutIdsRef.current = [];
    [vocalAudioRef.current, chorusAudioRef.current].forEach((audio) => audio?.pause());
    metronomeContextRef.current?.close().catch(() => {});
    metronomeContextRef.current = null;

    const playTrack = (
      audio: HTMLAudioElement | null,
      hasUrl: boolean,
      offsetSec: number,
    ): void => {
      if (!audio || !hasUrl) return;
      const delayMs = Math.max(0, (offsetSec - startSec) * 1000);
      const seekSec = Math.max(0, startSec - offsetSec);
      audio.currentTime = seekSec;
      const timeoutId = window.setTimeout(() => {
        void audio.play();
      }, delayMs);
      referenceTimeoutIdsRef.current.push(timeoutId);
    };

    playTrack(vocalAudioRef.current, Boolean(vocalUrl), vocalOffsetSec);
    playTrack(chorusAudioRef.current, Boolean(chorusUrl), chorusOffsetSec);

    if (clickEnabled) {
      const context = new AudioContext();
      if (context.state === 'suspended') {
        await context.resume().catch(() => {});
      }
      const beatSec = 60 / Math.max(1, bpm);
      const clickOffsetSec = clickOffsetMs / 1000;
      const firstBeatIndex = Math.ceil((startSec - clickOffsetSec) / beatSec);
      const scheduledStart = context.currentTime;
      for (let beatIndex = firstBeatIndex; ; beatIndex += 1) {
        const beatTimeSec = clickOffsetSec + beatIndex * beatSec;
        if (beatTimeSec > endSec + 0.0001) break;
        const delaySec = beatTimeSec - startSec;
        if (delaySec < -0.01) continue;

        const accent = ((beatIndex % beatsPerBar) + beatsPerBar) % beatsPerBar === 0;
        const osc = context.createOscillator();
        const gain = context.createGain();
        osc.type = accent ? 'triangle' : 'sine';
        osc.frequency.setValueAtTime(accent ? 1680 : 1120, scheduledStart + Math.max(0, delaySec));
        const velocity = clickVolume * (accent ? 1 : 0.72);
        gain.gain.setValueAtTime(0.0001, scheduledStart + Math.max(0, delaySec));
        gain.gain.exponentialRampToValueAtTime(
          Math.max(0.0001, velocity),
          scheduledStart + Math.max(0, delaySec) + 0.003,
        );
        gain.gain.exponentialRampToValueAtTime(
          0.0001,
          scheduledStart + Math.max(0, delaySec) + 0.055,
        );
        osc.connect(gain);
        gain.connect(context.destination);
        osc.start(scheduledStart + Math.max(0, delaySec));
        osc.stop(scheduledStart + Math.max(0, delaySec) + 0.06);
      }
      metronomeContextRef.current = context;
    }

    referencePlayAnchorRef.current = {
      startedAtMs: performance.now(),
      startSec,
      endSec,
    };
    setReferenceCursorSec(Math.max(0, startSec));
    setIsReferencePlaying(true);
  };

  useEffect(() => {
    if (!isReferencePlaying) {
      if (referenceRafRef.current !== null) {
        window.cancelAnimationFrame(referenceRafRef.current);
        referenceRafRef.current = null;
      }
      return;
    }

    const tick = (): void => {
      const timeline = computeReferenceTimelineSec();
      setReferenceCursorSec(Math.max(0, timeline));

      const vocal = vocalAudioRef.current;
      const chorus = chorusAudioRef.current;
      const vocalActive = Boolean(vocal && !vocal.paused);
      const chorusActive = Boolean(chorus && !chorus.paused);
      const anchor = referencePlayAnchorRef.current;

      if (!vocalActive && !chorusActive && anchor && timeline >= anchor.endSec - 0.01) {
        referencePlayAnchorRef.current = null;
        setIsReferencePlaying(false);
        metronomeContextRef.current?.close().catch(() => {});
        metronomeContextRef.current = null;
        return;
      }

      referenceRafRef.current = window.requestAnimationFrame(tick);
    };

    referenceRafRef.current = window.requestAnimationFrame(tick);
    return () => {
      if (referenceRafRef.current !== null) {
        window.cancelAnimationFrame(referenceRafRef.current);
        referenceRafRef.current = null;
      }
    };
  }, [computeReferenceTimelineSec, isReferencePlaying]);

  const startPractice = async (): Promise<void> => {
    if (!selectedProject) return;
    const analysisTrack = getTrack('vocal');
    if (!analysisTrack) {
      setStatus('練習前に参照ボーカル（単旋律ガイド）を登録してください。');
      return;
    }
    if (referenceRecordingRole) {
      setStatus('参照録音中は練習録音を開始できません。');
      return;
    }
    if (isRecording) return;

    try {
      setStatus('マイク許可を待機中...');
      await recorderRef.current.start();
      setIsRecording(true);

      let sec = 2;
      setCountdown(sec);
      const timer = window.setInterval(() => {
        sec -= 1;
        if (sec <= 0) {
          window.clearInterval(timer);
          setCountdown(null);
          void playReference(0);
          setStatus('録音中...（停止を押すまで継続）');
          return;
        }
        setCountdown(sec);
      }, 1000);

      window.setTimeout(() => {
        if (recordingRef.current) {
          void stopPractice();
          setStatus('10分に到達したため録音を自動停止しました。');
        }
      }, MAX_SONG_SEC * 1000);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'マイク開始に失敗しました';
      setStatus(`録音開始エラー: ${message}`);
      setIsRecording(false);
      setCountdown(null);
    }
  };

  const stopPractice = async (): Promise<void> => {
    if (!selectedProject || !recordingRef.current) return;

    try {
      setStatus('録音停止。モデル解析中です（少し時間がかかります）...');
      stopAllPlayback();

      const recording = await recorderRef.current.stop();
      const analysisTrack = getTrack('vocal');
      if (!analysisTrack) {
        setStatus('参照ボーカルが見つからず解析できませんでした。');
        return;
      }

      const [refBuffer, userBuffer] = await Promise.all([
        decodeBlobToAudioBuffer(analysisTrack.blob),
        decodeBlobToAudioBuffer(recording.blob),
      ]);
      const rhythmConfig: RhythmConfig = {
        bpm,
        clickOffsetMs,
        subdivision: 4,
      };

      const analysisResult = await analyzePitch(refBuffer, userBuffer, analysisConfig, 0, rhythmConfig);

      const session: Session = {
        id: createId(),
        createdAt: new Date().toISOString(),
        recording: recording.blob,
        recordingMimeType: recording.mimeType,
        durationSec: recording.durationSec,
        analysisReferenceRole: 'vocal',
        manualOffsetMs: 0,
        analysisConfig,
        rhythmConfig,
        analysisResult,
      };

      const nextProject: Project = {
        ...selectedProject,
        sessions: [session, ...selectedProject.sessions],
      };

      await persistProject(nextProject);
      setActiveSessionId(session.id);
      setStatus('解析完了。ノート抽出を自動最適化中...');
      const previewResult = await optimizeNotesForSession(session);
      setPreviewNotes({ sessionId: session.id, notes: previewResult.extractResult.notes });
      setPreviewMeta({ sessionId: session.id, result: previewResult.extractResult });
      setPreviewSourceInfo({
        sessionId: session.id,
        startSec: previewResult.sourceStartSec,
        durationSec: previewResult.sourceDurationSec,
        label: previewResult.sourceLabel,
        kind: previewResult.sourceKind,
      });
      await saveDebugSnapshot(session, previewResult.extractResult, 'analyze');
      setStatus(
        `解析完了。ノート最適化: ${previewResult.extractResult.notes.length} ノート（${previewResult.extractResult.tried}試行）`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : '録音停止に失敗しました';
      setStatus(`停止/解析エラー: ${message}`);
    } finally {
      setIsRecording(false);
      setCountdown(null);
    }
  };

  const reanalyzeCurrentSession = async (): Promise<void> => {
    if (!selectedProject || !selectedSession) {
      setStatus('再解析に必要なデータが不足しています。');
      return;
    }
    const analysisTrack = getTrack('vocal');
    if (!analysisTrack) {
      setStatus('参照ボーカルがないため再解析できません。');
      return;
    }

    try {
      setStatus('オフセットを反映して再解析中...');
      const [refBuffer, userBuffer] = await Promise.all([
        decodeBlobToAudioBuffer(analysisTrack.blob),
        decodeBlobToAudioBuffer(selectedSession.recording),
      ]);
      const rhythmConfig: RhythmConfig = {
        bpm,
        clickOffsetMs,
        subdivision: 4,
      };
      const result = await analyzePitch(refBuffer, userBuffer, analysisConfig, manualOffsetMs, rhythmConfig);

      const updatedSession: Session = {
        ...selectedSession,
        analysisReferenceRole: 'vocal',
        manualOffsetMs,
        analysisConfig,
        rhythmConfig,
        analysisResult: result,
      };

      const nextProject: Project = {
        ...selectedProject,
        sessions: selectedProject.sessions.map((item) =>
          item.id === selectedSession.id ? updatedSession : item,
        ),
      };
      await persistProject(nextProject);
      setStatus('再解析完了。ノート抽出を自動最適化中...');
      const previewResult = await optimizeNotesForSession(updatedSession);
      setPreviewNotes({ sessionId: updatedSession.id, notes: previewResult.extractResult.notes });
      setPreviewMeta({ sessionId: updatedSession.id, result: previewResult.extractResult });
      setPreviewSourceInfo({
        sessionId: updatedSession.id,
        startSec: previewResult.sourceStartSec,
        durationSec: previewResult.sourceDurationSec,
        label: previewResult.sourceLabel,
        kind: previewResult.sourceKind,
      });
      await saveDebugSnapshot(updatedSession, previewResult.extractResult, 'reanalyze');
      setStatus(
        `再解析完了。ノート最適化: ${previewResult.extractResult.notes.length} ノート（${previewResult.extractResult.tried}試行）`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : '再解析に失敗しました';
      setStatus(`再解析エラー: ${message}`);
    }
  };

  const removeProject = async (projectId: string): Promise<void> => {
    await deleteProject(projectId);
    setProjects((current) => {
      const next = current.filter((project) => project.id !== projectId);
      if (selectedProjectId === projectId) {
        setSelectedProjectId(next[0]?.id ?? null);
      }
      return next;
    });
    setStatus('曲データを削除しました。');
  };

  const jumpToSegment = (sec: number): void => {
    const chorus = chorusAudioRef.current;
    const user = userAudioRef.current;
    if (chorus && chorusUrl) {
      chorus.currentTime = sec;
      void chorus.play();
    }
    if (user && userRecordingUrl) {
      user.currentTime = clamp(sec + manualOffsetMs / 1000, 0, user.duration || Number.MAX_SAFE_INTEGER);
      void user.play();
    }
  };

  const playAnalysisCompare = (fromSec = 0): void => {
    if (!selectedSession) return;
    if (!vocalUrl || !userRecordingUrl) {
      setStatus('参照ボーカルと自分の録音が必要です。');
      return;
    }
    stopAllPlayback();
    const vocal = vocalAudioRef.current;
    const user = userAudioRef.current;
    if (!vocal || !user) return;

    const refOffsetSec = getTrackOffsetMs('vocal') / 1000;
    const userOffsetSec =
      (selectedSession.manualOffsetMs + selectedSession.analysisResult.estimatedOffsetMs) / 1000;
    const startSec = Math.max(0, fromSec);

    const schedule = (audio: HTMLAudioElement, offsetSec: number): void => {
      const delayMs = Math.max(0, (offsetSec - startSec) * 1000);
      const seekSec = Math.max(0, startSec - offsetSec);
      audio.currentTime = seekSec;
      const id = window.setTimeout(() => {
        void audio.play();
      }, delayMs);
      analysisCompareTimeoutIdsRef.current.push(id);
    };

    schedule(vocal, refOffsetSec);
    schedule(user, userOffsetSec);

    const endSec = Math.max(
      (vocalTrack?.durationSec ?? 0) + refOffsetSec,
      selectedSession.durationSec + userOffsetSec,
      1,
    );
    const stopId = window.setTimeout(() => {
      [vocalAudioRef.current, userAudioRef.current].forEach((audio) => audio?.pause());
      setIsAnalysisComparePlaying(false);
    }, Math.max(0, (endSec - startSec) * 1000 + 80));
    analysisCompareTimeoutIdsRef.current.push(stopId);
    setIsAnalysisComparePlaying(true);
  };

  const stopAnalysisCompare = (): void => {
    analysisCompareTimeoutIdsRef.current.forEach((id) => window.clearTimeout(id));
    analysisCompareTimeoutIdsRef.current = [];
    [vocalAudioRef.current, userAudioRef.current].forEach((audio) => audio?.pause());
    setIsAnalysisComparePlaying(false);
  };

  const generateMidiPreview = async (): Promise<void> => {
    if (!selectedSession) return;
    const sourceLabel =
      midiPreviewSource === 'reference_vocal'
        ? '参照ボーカル'
        : midiPreviewSource === 'reference_chorus'
          ? '参照コーラス'
          : '自分録音';
    try {
      setStatus(`${sourceLabel}をノート抽出中...`);
      const previewResult = await optimizeNotesForSession(selectedSession);
      setPreviewNotes({ sessionId: selectedSession.id, notes: previewResult.extractResult.notes });
      setPreviewMeta({ sessionId: selectedSession.id, result: previewResult.extractResult });
      setPreviewSourceInfo({
        sessionId: selectedSession.id,
        startSec: previewResult.sourceStartSec,
        durationSec: previewResult.sourceDurationSec,
        label: previewResult.sourceLabel,
        kind: previewResult.sourceKind,
      });
      setNoteCursorSec(0);
      await saveDebugSnapshot(selectedSession, previewResult.extractResult, 'note_extract');
      setStatus(
        `${sourceLabel}: ${previewResult.extractResult.notes.length} ノート（${previewResult.extractResult.tried}試行）を生成し、debugに保存しました。`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'ノート抽出に失敗しました';
      setStatus(`ノート抽出エラー: ${message}`);
    }
  };

  const playMidiPreview = (): void => {
    if (!selectedSession) return;
    const notes = currentPreviewNotes;
    if (notes.length === 0) {
      setStatus('先に「ノート抽出」を実行してください。');
      return;
    }
    stopAllPlayback();
    const previewEndSec = notes.reduce((max, note) => Math.max(max, note.endSec), 0);

    if (midiPreviewWithReference) {
      const sourceAudio =
        activePreviewSourceInfo?.kind === 'reference_chorus'
          ? chorusAudioRef.current
          : activePreviewSourceInfo?.kind === 'user_recording'
            ? userAudioRef.current
            : vocalAudioRef.current;
      if (sourceAudio) {
        const seekSec = Math.max(0, activePreviewSourceInfo?.startSec ?? 0);
        sourceAudio.currentTime = seekSec;
        const timeoutId = window.setTimeout(() => {
          void sourceAudio.play();
        }, 0);
        midiPreviewTimeoutIdsRef.current.push(timeoutId);
        const stopId = window.setTimeout(() => {
          sourceAudio.pause();
        }, Math.max(0, (activePreviewSourceInfo?.durationSec ?? previewEndSec) * 1000 + 80));
        midiPreviewTimeoutIdsRef.current.push(stopId);
      }
    }

    if (midiPreviewWithClick) {
      const context = new AudioContext();
      void context.resume().catch(() => {});
      const beatSec = 60 / Math.max(1, bpm);
      const clickOffsetSec = clickOffsetMs / 1000;
      const firstBeatIndex = Math.ceil((0 - clickOffsetSec) / beatSec);
      const scheduledStart = context.currentTime;
      for (let beatIndex = firstBeatIndex; ; beatIndex += 1) {
        const beatTimeSec = clickOffsetSec + beatIndex * beatSec;
        if (beatTimeSec > previewEndSec + 0.0001) break;
        const accent = ((beatIndex % beatsPerBar) + beatsPerBar) % beatsPerBar === 0;
        const osc = context.createOscillator();
        const gain = context.createGain();
        osc.type = accent ? 'triangle' : 'sine';
        osc.frequency.setValueAtTime(accent ? 1680 : 1120, scheduledStart + Math.max(0, beatTimeSec));
        const velocity = clickVolume * (accent ? 1 : 0.72);
        gain.gain.setValueAtTime(0.0001, scheduledStart + Math.max(0, beatTimeSec));
        gain.gain.exponentialRampToValueAtTime(
          Math.max(0.0001, velocity),
          scheduledStart + Math.max(0, beatTimeSec) + 0.003,
        );
        gain.gain.exponentialRampToValueAtTime(
          0.0001,
          scheduledStart + Math.max(0, beatTimeSec) + 0.055,
        );
        osc.connect(gain);
        gain.connect(context.destination);
        osc.start(scheduledStart + Math.max(0, beatTimeSec));
        osc.stop(scheduledStart + Math.max(0, beatTimeSec) + 0.06);
      }
      midiPreviewMetronomeRef.current = context;
    }

    setIsNotePlaying(true);
    notePlaybackRef.current = playNoteEvents(
      notes,
      (sec) => setNoteCursorSec(sec),
      () => {
        notePlaybackRef.current = null;
        midiPreviewTimeoutIdsRef.current.forEach((id) => window.clearTimeout(id));
        midiPreviewTimeoutIdsRef.current = [];
        midiPreviewMetronomeRef.current?.close().catch(() => {});
        midiPreviewMetronomeRef.current = null;
        [vocalAudioRef.current, chorusAudioRef.current, userAudioRef.current].forEach((audio) => audio?.pause());
        setIsNotePlaying(false);
      },
    );
  };

  const stopMidiPreview = (): void => {
    notePlaybackRef.current?.stop();
    notePlaybackRef.current = null;
    midiPreviewTimeoutIdsRef.current.forEach((id) => window.clearTimeout(id));
    midiPreviewTimeoutIdsRef.current = [];
    midiPreviewMetronomeRef.current?.close().catch(() => {});
    midiPreviewMetronomeRef.current = null;
    [vocalAudioRef.current, chorusAudioRef.current, userAudioRef.current].forEach((audio) => audio?.pause());
    setIsNotePlaying(false);
  };

  const trimFramesToReferenceWindow = (session: Session, frames: typeof session.analysisResult.userPitch): PitchFrame[] => {
    const refPitch = session.analysisResult.refPitch;
    const voicedRef = refPitch.filter((frame) => frame.hz !== null);
    if (voicedRef.length === 0) return frames;
    const startSec = voicedRef[0].timeSec;
    const endSec = voicedRef[voicedRef.length - 1].timeSec;
    const padSec = 0.12;
    return frames.filter((frame) => frame.timeSec >= startSec - padSec && frame.timeSec <= endSec + padSec);
  };

  const trimFramesToReferenceVoicedWindow = (frames: PitchFrame[]): PitchFrame[] => {
    const voiced = frames.filter((frame) => frame.hz !== null);
    if (voiced.length < 2) return frames;

    const maxGapSec = 0.45;
    const minVoicedCount = 8;
    const segments: Array<{ startSec: number; endSec: number; voicedCount: number }> = [];
    let startSec = voiced[0].timeSec;
    let endSec = voiced[0].timeSec;
    let count = 1;

    for (let i = 1; i < voiced.length; i += 1) {
      const prev = voiced[i - 1];
      const cur = voiced[i];
      if (cur.timeSec - prev.timeSec > maxGapSec) {
        segments.push({ startSec, endSec, voicedCount: count });
        startSec = cur.timeSec;
        endSec = cur.timeSec;
        count = 1;
      } else {
        endSec = cur.timeSec;
        count += 1;
      }
    }
    segments.push({ startSec, endSec, voicedCount: count });

    const validSegments = segments.filter((segment) => segment.voicedCount >= minVoicedCount);
    if (validSegments.length === 0) return frames;

    const padSec = 0.18;
    const clipStart = Math.max(0, Math.min(...validSegments.map((segment) => segment.startSec)) - padSec);
    const clipEnd = Math.max(...validSegments.map((segment) => segment.endSec)) + padSec;
    return frames.filter((frame) => frame.timeSec >= clipStart && frame.timeSec <= clipEnd);
  };

  const optimizeNotesFromFrames = (
    frames: PitchFrame[],
    useGridOptimization: boolean,
  ): AutoExtractResult => {
    const auto = autoExtractBestNoteEvents(frames);
    if (!useGridOptimization) return auto;
    const grid = extractGridAlignedNoteEvents(frames);
    return grid.debug.score > auto.debug.score ? grid : auto;
  };

  const optimizeNotesForReferenceTrack = async (
    role: TrackRole,
    useGridOptimization: boolean,
  ): Promise<PreviewExtractionResult> => {
    const track = getTrack(role);
    if (!track) {
      throw new Error(`参照${role === 'vocal' ? 'ボーカル' : 'コーラス'}が未登録です。`);
    }
    const buffer = await decodeBlobToAudioBuffer(track.blob);
    const rawPitch = await extractPitchByModel(buffer);
    const filteredPitch = rawPitch.map((frame) => ({
      ...frame,
      hz: frame.clarity >= analysisConfig.clarityThreshold ? frame.hz : null,
    }));
    const scopedPitch = trimFramesToReferenceVoicedWindow(filteredPitch);
    const sourceStartSec = scopedPitch[0]?.timeSec ?? 0;
    const sourceEndSec = scopedPitch.at(-1)?.timeSec ?? sourceStartSec;
    const rebasedPitch = scopedPitch.map((frame) => ({
      ...frame,
      timeSec: Math.max(0, frame.timeSec - sourceStartSec),
    }));
    return {
      extractResult: optimizeNotesFromFrames(rebasedPitch, useGridOptimization),
      sourceStartSec,
      sourceDurationSec: Math.max(0.001, sourceEndSec - sourceStartSec),
      sourceLabel: role === 'vocal' ? '参照ボーカル' : '参照コーラス',
      sourceKind: role === 'vocal' ? 'reference_vocal' : 'reference_chorus',
    };
  };

  const optimizeNotesForPreviewSource = async (session: Session): Promise<PreviewExtractionResult> => {
    const useGridOptimization = Boolean(session.rhythmConfig);
    if (midiPreviewSource === 'reference_vocal') {
      return optimizeNotesForReferenceTrack('vocal', useGridOptimization);
    }
    if (midiPreviewSource === 'reference_chorus') {
      return optimizeNotesForReferenceTrack('chorus', useGridOptimization);
    }
    const observedPitch = session.analysisResult.userPitchObserved ?? session.analysisResult.userPitch;
    const scopedPitch = trimFramesToReferenceWindow(session, observedPitch);
    if (scopedPitch.length > 0) {
      return {
        extractResult: optimizeNotesFromFrames(scopedPitch, useGridOptimization),
        sourceStartSec: 0,
        sourceDurationSec: Math.max(0.001, session.durationSec),
        sourceLabel: '自分録音',
        sourceKind: 'user_recording',
      };
    }
    const userBuffer = await decodeBlobToAudioBuffer(session.recording);
    const rawPitch = await extractPitchByModel(userBuffer);
    return {
      extractResult: optimizeNotesFromFrames(rawPitch, useGridOptimization),
      sourceStartSec: 0,
      sourceDurationSec: Math.max(0.001, session.durationSec),
      sourceLabel: '自分録音',
      sourceKind: 'user_recording',
    };
  };

  const optimizeNotesForSession = async (session: Session): Promise<PreviewExtractionResult> => {
    return optimizeNotesForPreviewSource(session);
  };

  const saveDebugSnapshot = async (
    session: Session,
    extractResult: AutoExtractResult,
    reason: 'analyze' | 'reanalyze' | 'note_extract',
  ): Promise<void> => {
    if (!selectedProject) return;
    const payload = {
      exportedAt: new Date().toISOString(),
      reason,
      project: {
        id: selectedProject.id,
        name: selectedProject.name,
      },
      session: {
        id: session.id,
        createdAt: session.createdAt,
        durationSec: session.durationSec,
        manualOffsetMs: session.manualOffsetMs,
        analysisReferenceRole: session.analysisReferenceRole ?? 'vocal',
      },
      config: session.analysisConfig,
      rhythm: session.rhythmConfig ?? null,
      stats: session.analysisResult.stats,
      estimatedOffsetMs: session.analysisResult.estimatedOffsetMs,
      input: {
        refPitch: session.analysisResult.refPitch,
        userPitch: session.analysisResult.userPitch,
        userPitchObserved: session.analysisResult.userPitchObserved ?? session.analysisResult.userPitch,
        userPitchImputed: session.analysisResult.userPitchImputed ?? session.analysisResult.userPitch,
        errorFrames: session.analysisResult.errorFrames,
      },
      output: {
        notes: extractResult.notes,
        optimization: {
          options: extractResult.options,
          debug: extractResult.debug,
          tried: extractResult.tried,
        },
      },
    };

    try {
      await fetch('/__debug/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } catch (error) {
      console.warn('debug save failed', error);
    }
  };

  const refDetectedCount = selectedSession
    ? selectedSession.analysisResult.refPitch.filter((frame) => frame.hz !== null).length
    : 0;
  const userDetectedCount = selectedSession
    ? (selectedSession.analysisResult.userPitchObserved ?? selectedSession.analysisResult.userPitch).filter(
        (frame) => frame.hz !== null,
      ).length
    : 0;
  const refTotalCount = selectedSession ? selectedSession.analysisResult.refPitch.length : 0;
  const userTotalCount = selectedSession
    ? (selectedSession.analysisResult.userPitchObserved ?? selectedSession.analysisResult.userPitch).length
    : 0;

  return (
    <>
      {toastVisible && (
        <div aria-live="polite" className="status-toast" role="status">
          {status}
        </div>
      )}
      <div className="app-shell">
      <aside className="sidebar">
        <h1>HarmoGraph</h1>
        <p className="caption">ローカル専用 / オフライン動作 / マイク権限が必要</p>
        <div className="new-project">
          <input
            placeholder="曲名 (例: Song A)"
            value={newProjectName}
            onChange={(event) => setNewProjectName(event.target.value)}
          />
          <button type="button" onClick={() => void createProject()}>
            曲を作成
          </button>
        </div>

        <div className="project-list">
          {projects.map((project) => (
            <div
              className={`project-card ${selectedProjectId === project.id ? 'active' : ''}`}
              key={project.id}
            >
              <button type="button" onClick={() => setSelectedProjectId(project.id)}>
                {project.name}
              </button>
              <small>sessions: {project.sessions.length}</small>
              <button className="danger" type="button" onClick={() => void removeProject(project.id)}>
                削除
              </button>
            </div>
          ))}
        </div>
      </aside>

      <main className="main-panel">
        {!selectedProject ? (
          <section className="card">曲を作成すると練習を開始できます。</section>
        ) : (
          <>
            <section className="card">
              <h2>{selectedProject.name}</h2>
              <div className="upload-grid">
                <label>
                  参照ボーカル (解析必須)
                  <input
                    type="file"
                    accept="audio/*"
                    onChange={(event) => void onUploadTrack('vocal', event.target.files?.[0] ?? null)}
                  />
                  <div className="track-actions">
                    <button
                      type="button"
                      disabled={
                        isRecording ||
                        (referenceRecordingRole !== null && referenceRecordingRole !== 'vocal')
                      }
                      onClick={() => void startReferenceRecording('vocal')}
                    >
                      参照録音開始
                    </button>
                    <button
                      type="button"
                      disabled={referenceRecordingRole !== 'vocal'}
                      onClick={() => void stopReferenceRecording()}
                    >
                      参照録音停止
                    </button>
                  </div>
                  <span>{vocalTrack?.name ?? '未登録'}</span>
                </label>
                <label>
                  参照コーラス (任意)
                  <input
                    type="file"
                    accept="audio/*"
                    onChange={(event) => void onUploadTrack('chorus', event.target.files?.[0] ?? null)}
                  />
                  <div className="track-actions">
                    <button
                      type="button"
                      disabled={
                        isRecording ||
                        (referenceRecordingRole !== null && referenceRecordingRole !== 'chorus')
                      }
                      onClick={() => void startReferenceRecording('chorus')}
                    >
                      参照録音開始
                    </button>
                    <button
                      type="button"
                      disabled={referenceRecordingRole !== 'chorus'}
                      onClick={() => void stopReferenceRecording()}
                    >
                      参照録音停止
                    </button>
                  </div>
                  <span>{chorusTrack?.name ?? '未登録'}</span>
                </label>
              </div>
            </section>

            <ReferenceWaveforms
              vocalBlob={vocalTrack?.blob ?? null}
              chorusBlob={chorusTrack?.blob ?? null}
              vocalOffsetMs={getTrackOffsetMs('vocal')}
              chorusOffsetMs={getTrackOffsetMs('chorus')}
              cursorSec={referenceCursorSec}
              isPlaying={isReferencePlaying}
              onPlay={() => void playReference()}
              onPause={pauseReference}
              onReset={resetReferencePlayback}
              onSeek={seekReference}
              onVocalOffsetChange={(offset) => void changeReferenceOffset('vocal', offset)}
              onChorusOffsetChange={(offset) => void changeReferenceOffset('chorus', offset)}
              clickEnabled={clickEnabled}
              clickVolume={clickVolume}
              bpm={bpm}
              beatsPerBar={beatsPerBar}
              clickOffsetMs={clickOffsetMs}
              onClickEnabledChange={(enabled) => {
                setClickEnabled(enabled);
                void persistReferenceAlignConfig({ clickEnabled: enabled });
                if (isReferencePlaying) {
                  const timelineSec = computeReferenceTimelineSec();
                  void playReference(timelineSec);
                }
              }}
              onClickVolumeChange={(value) => {
                const next = clamp(value, 0, 1);
                setClickVolume(next);
                void persistReferenceAlignConfig({ clickVolume: next });
                if (isReferencePlaying) {
                  const timelineSec = computeReferenceTimelineSec();
                  void playReference(timelineSec);
                }
              }}
              onBpmCommit={(value) => {
                const next = clamp(Number.isFinite(value) ? value : DEFAULT_BPM, 40, 240);
                setBpm(next);
                void persistReferenceAlignConfig({ bpm: next });
                if (isReferencePlaying) {
                  const timelineSec = computeReferenceTimelineSec();
                  void playReference(timelineSec);
                }
              }}
              onBeatsPerBarChange={(value) => {
                const next = value === 3 ? 3 : 4;
                setBeatsPerBar(next);
                void persistReferenceAlignConfig({ beatsPerBar: next });
                if (isReferencePlaying) {
                  const timelineSec = computeReferenceTimelineSec();
                  void playReference(timelineSec);
                }
              }}
              onClickOffsetMsChange={(value) => {
                const next = clamp(Math.round(value), -500, 500);
                setClickOffsetMs(next);
                void persistReferenceAlignConfig({ clickOffsetMs: next });
                if (isReferencePlaying) {
                  const timelineSec = computeReferenceTimelineSec();
                  void playReference(timelineSec);
                }
              }}
            />

            <section className="card">
              <h3>練習セッション</h3>
              <p>2秒カウント後に参照再生しながら録音します。</p>
              <div className="controls-row">
                <strong>解析参照: ボーカル（単旋律ガイド固定）</strong>
                <span>イヤホン利用・伴奏オフ推奨</span>
              </div>
              <div className="controls-row">
                <button
                  type="button"
                  disabled={isRecording || referenceRecordingRole !== null}
                  onClick={() => void startPractice()}
                >
                  練習開始
                </button>
                <button type="button" disabled={!isRecording} onClick={() => void stopPractice()}>
                  停止して解析
                </button>
                {countdown !== null && <strong>開始まで {countdown}</strong>}
                {referenceRecordingRole !== null && (
                  <strong>
                    参照{referenceRecordingRole === 'vocal' ? 'ボーカル' : 'コーラス'}を録音中
                  </strong>
                )}
              </div>

              <div className="playback-grid">
                <div>
                  <h4>参照ボーカル</h4>
                  <div className="inline-controls">
                    <label>
                      <input
                        checked={playback.vocalEnabled}
                        type="checkbox"
                        onChange={(event) =>
                          setPlayback((prev) => ({ ...prev, vocalEnabled: event.target.checked }))
                        }
                      />
                      ON
                    </label>
                    <button
                      type="button"
                      onClick={() =>
                        setPlayback((prev) => ({ ...prev, solo: prev.solo === 'vocal' ? 'none' : 'vocal' }))
                      }
                    >
                      Solo
                    </button>
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.01}
                      value={playback.vocalVolume}
                      onChange={(event) =>
                        setPlayback((prev) => ({ ...prev, vocalVolume: Number(event.target.value) }))
                      }
                    />
                  </div>
                </div>

                <div>
                  <h4>参照コーラス</h4>
                  <div className="inline-controls">
                    <label>
                      <input
                        checked={playback.chorusEnabled}
                        type="checkbox"
                        onChange={(event) =>
                          setPlayback((prev) => ({ ...prev, chorusEnabled: event.target.checked }))
                        }
                      />
                      ON
                    </label>
                    <button
                      type="button"
                      onClick={() =>
                        setPlayback((prev) => ({ ...prev, solo: prev.solo === 'chorus' ? 'none' : 'chorus' }))
                      }
                    >
                      Solo
                    </button>
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.01}
                      value={playback.chorusVolume}
                      onChange={(event) =>
                        setPlayback((prev) => ({ ...prev, chorusVolume: Number(event.target.value) }))
                      }
                    />
                  </div>
                </div>

                <div>
                  <h4>自分の録音</h4>
                  <audio controls ref={userAudioRef} src={userRecordingUrl} />
                </div>
              </div>

            </section>

            {selectedSession && (
              <section className="card">
                <h3>解析結果</h3>
                <p>
                  解析参照トラック: ボーカル（単旋律ガイド） / 16分グリッド評価（BPM {selectedSession.rhythmConfig?.bpm ?? bpm}
                  ） / 参照検出 {refDetectedCount}/{refTotalCount} / 自分検出 {userDetectedCount}/{userTotalCount}
                </p>
                <div className="analysis-controls">
                  <label>
                    許容誤差 ±{analysisConfig.toleranceCents.toFixed(0)} cents
                    <input
                      type="range"
                      min={10}
                      max={80}
                      step={1}
                      value={analysisConfig.toleranceCents}
                      onChange={(event) =>
                        setAnalysisConfig((prev) => ({ ...prev, toleranceCents: Number(event.target.value) }))
                      }
                    />
                  </label>
                  <label>
                    Clarity閾値 {analysisConfig.clarityThreshold.toFixed(2)}
                    <input
                      type="range"
                      min={0.2}
                      max={0.95}
                      step={0.01}
                      value={analysisConfig.clarityThreshold}
                      onChange={(event) =>
                        setAnalysisConfig((prev) => ({ ...prev, clarityThreshold: Number(event.target.value) }))
                      }
                    />
                  </label>
                  <label>
                    手動オフセット {manualOffsetMs} ms
                    <input
                      type="range"
                      min={-500}
                      max={500}
                      step={10}
                      value={manualOffsetMs}
                      onChange={(event) => setManualOffsetMs(Number(event.target.value))}
                    />
                  </label>
                  <button type="button" onClick={() => void reanalyzeCurrentSession()}>
                    オフセット反映で再解析
                  </button>
                </div>

                <div className="stats-grid">
                  <div>
                    <strong>平均誤差</strong>
                    <span>{selectedSession.analysisResult.stats.meanAbsCents.toFixed(1)} cents</span>
                  </div>
                  <div>
                    <strong>中央値</strong>
                    <span>{selectedSession.analysisResult.stats.medianAbsCents.toFixed(1)} cents</span>
                  </div>
                  <div>
                    <strong>合格割合</strong>
                    <span>{(selectedSession.analysisResult.stats.passRatio * 100).toFixed(1)}%</span>
                  </div>
                  <div>
                    <strong>最大誤差</strong>
                    <span>{selectedSession.analysisResult.stats.maxAbsCents.toFixed(1)} cents</span>
                  </div>
                  <div>
                    <strong>未検出率</strong>
                    <span>{(selectedSession.analysisResult.stats.undetectedRatio * 100).toFixed(1)}%</span>
                  </div>
                  <div>
                    <strong>開始ズレ推定</strong>
                    <span>{selectedSession.analysisResult.estimatedOffsetMs.toFixed(0)} ms</span>
                  </div>
                  <div>
                    <strong>ペア距離P95</strong>
                    <span>{(selectedSession.analysisResult.stats.pairDtP95Ms ?? 0).toFixed(1)} ms</span>
                  </div>
                  <div>
                    <strong>距離超過率</strong>
                    <span>
                      {(
                        ((selectedSession.analysisResult.stats.pairDtOverThresholdRatio ?? 0) as number) * 100
                      ).toFixed(1)}
                      %
                    </span>
                  </div>
                </div>

                <div className="analysis-audio-grid">
                  <div className="analysis-audio-panel">
                    <h4>比較再生（参照ボーカル vs 自分録音）</h4>
                    <div className="controls-row">
                      <button type="button" onClick={() => playAnalysisCompare(0)}>
                        同時再生
                      </button>
                      <button type="button" disabled={!isAnalysisComparePlaying} onClick={stopAnalysisCompare}>
                        停止
                      </button>
                    </div>
                    <label>
                      参照ボーカル
                      <audio controls src={vocalUrl} />
                    </label>
                    <label>
                      自分の録音
                      <audio controls src={userRecordingUrl} />
                    </label>
                  </div>
                  <PitchCanvas
                    refPitch={selectedSession.analysisResult.refPitch}
                    userPitch={selectedSession.analysisResult.userPitch}
                    errors={selectedSession.analysisResult.errorFrames}
                    toleranceCents={selectedSession.analysisConfig.toleranceCents}
                    offsetMs={selectedSession.manualOffsetMs + selectedSession.analysisResult.estimatedOffsetMs}
                  />
                </div>

                <div>
                  <h4>外れている区間トップ3</h4>
                  <ul className="segment-list">
                    {selectedSession.analysisResult.topSegments.map((segment, index) => (
                      <li key={`${segment.startSec}-${segment.endSec}`}>
                        <button type="button" onClick={() => jumpToSegment(segment.startSec)}>
                          {index + 1}. {formatSec(segment.startSec)} - {formatSec(segment.endSec)} / 
                          {segment.avgCents > 0 ? ' 高め' : ' 低め'} ({segment.avgCents.toFixed(1)} cents)
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>

                <div className="card-subsection">
                  <h4>MIDIプレビュー（選択音源→ノート化）</h4>
                  <div className="controls-row">
                    <label>
                      ソース
                      <select
                        value={midiPreviewSource}
                        onChange={(event) => setMidiPreviewSource(event.target.value as MidiPreviewSource)}
                      >
                        <option value="reference_vocal">参照ボーカル</option>
                        <option value="reference_chorus">参照コーラス</option>
                        <option value="user_recording">自分録音</option>
                      </select>
                    </label>
                    <button type="button" onClick={() => void generateMidiPreview()}>
                      ノート抽出
                    </button>
                    <button type="button" disabled={currentPreviewNotes.length === 0} onClick={playMidiPreview}>
                      ピアノ再生
                    </button>
                    <button type="button" disabled={!isNotePlaying} onClick={stopMidiPreview}>
                      停止
                    </button>
                    <label>
                      <input
                        type="checkbox"
                        checked={midiPreviewWithReference}
                        onChange={(event) => setMidiPreviewWithReference(event.target.checked)}
                      />
                      参照同時再生
                    </label>
                    <label>
                      <input
                        type="checkbox"
                        checked={midiPreviewWithClick}
                        onChange={(event) => setMidiPreviewWithClick(event.target.checked)}
                      />
                      クリック同時再生
                    </label>
                    <strong>
                      ノート数: {currentPreviewNotes.length} / 再生位置: {formatSec(noteCursorSec)}
                    </strong>
                  </div>
                  <div className="midi-timeline-stack">
                    <div className="source-preview-block">
                      <div className="caption">
                        ソース: {activePreviewSourceInfo?.label ?? '未抽出'} / カーソル {formatSec(sourceCursorSec)} /
                        長さ {formatSec(activePreviewSourceInfo?.durationSec ?? previewDurationSec)}
                      </div>
                      <div className="source-cursor-track">
                        <div
                          className="source-cursor-line"
                          style={{ left: `${Math.min(100, Math.max(0, sourceCursorRatio * 100))}%` }}
                        />
                      </div>
                      <div className="source-midi-readout">
                        {activePreviewNote
                          ? `現在のMIDI: ${midiToNoteName(activePreviewNote.midi)} (midi ${activePreviewNote.midi}, ${midiToHz(activePreviewNote.midi).toFixed(2)} Hz)`
                          : '現在のMIDI: 休符'}
                      </div>
                    </div>
                    {currentPreviewMeta && (
                      <div className="caption">
                        自動最適化: {currentPreviewMeta.tried}試行 / MAE{' '}
                        {currentPreviewMeta.debug.maeCents.toFixed(1)} cents / カバレッジ{' '}
                        {(currentPreviewMeta.debug.coverage * 100).toFixed(1)}% / パラメータ(
                        minDur={currentPreviewMeta.options.minDurationSec.toFixed(2)}s, median=
                        {currentPreviewMeta.options.medianWindow}, smooth=
                        {currentPreviewMeta.options.smoothWindow}, gap=
                        {currentPreviewMeta.options.gapFillSemitone}, cont=
                        {currentPreviewMeta.options.continuityLimitSemitone})
                      </div>
                    )}
                    <PianoRoll
                      notes={currentPreviewNotes}
                      durationSec={previewTimelineSec}
                      cursorSec={noteCursorSec}
                    />
                  </div>
                </div>
              </section>
            )}

            <audio ref={vocalAudioRef} src={vocalUrl} />
            <audio ref={chorusAudioRef} src={chorusUrl} />
          </>
        )}
      </main>
      </div>
    </>
  );
}

export default App;
