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
  Project,
  RhythmConfig,
  Session,
  StoredTrack,
  TrackRole,
} from './types';

const MAX_SONG_SEC = 600;
const WARN_SONG_SEC = 300;
const DEFAULT_BPM = 120;

const defaultPlayback: PlaybackState = {
  vocalEnabled: true,
  chorusEnabled: true,
  vocalVolume: 0.8,
  chorusVolume: 1,
  solo: 'none',
};

function App() {
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
  const [clickEnabled, setClickEnabled] = useState(true);
  const [clickVolume, setClickVolume] = useState(0.35);
  const [bpm, setBpm] = useState(DEFAULT_BPM);
  const [beatsPerBar, setBeatsPerBar] = useState(4);
  const [clickOffsetMs, setClickOffsetMs] = useState(0);
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
    [vocalAudioRef.current, chorusAudioRef.current, userAudioRef.current].forEach((audio) => {
      if (!audio) return;
      audio.pause();
      audio.currentTime = 0;
    });
    notePlaybackRef.current?.stop();
    notePlaybackRef.current = null;
    setIsNotePlaying(false);
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
      const optimizeResult = await optimizeNotesForSession(session);
      setPreviewNotes({ sessionId: session.id, notes: optimizeResult.notes });
      setPreviewMeta({ sessionId: session.id, result: optimizeResult });
      await saveDebugSnapshot(session, optimizeResult, 'analyze');
      setStatus(
        `解析完了。ノート最適化: ${optimizeResult.notes.length} ノート（${optimizeResult.tried}試行）`,
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
      const optimizeResult = await optimizeNotesForSession(updatedSession);
      setPreviewNotes({ sessionId: updatedSession.id, notes: optimizeResult.notes });
      setPreviewMeta({ sessionId: updatedSession.id, result: optimizeResult });
      await saveDebugSnapshot(updatedSession, optimizeResult, 'reanalyze');
      setStatus(
        `再解析完了。ノート最適化: ${optimizeResult.notes.length} ノート（${optimizeResult.tried}試行）`,
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

  const generateMidiPreview = async (): Promise<void> => {
    if (!selectedSession) return;
    setStatus('ノート抽出を自動最適化中...');
    const optimizeResult = await optimizeNotesForSession(selectedSession);
    setPreviewNotes({ sessionId: selectedSession.id, notes: optimizeResult.notes });
    setPreviewMeta({ sessionId: selectedSession.id, result: optimizeResult });
    setNoteCursorSec(0);
    await saveDebugSnapshot(selectedSession, optimizeResult, 'note_extract');
    setStatus(
      `ノート抽出: ${optimizeResult.notes.length} ノート（${optimizeResult.tried}試行）を生成し、debugに自動保存しました。`,
    );
  };

  const playMidiPreview = (): void => {
    if (!selectedSession) return;
    const notes = currentPreviewNotes;
    if (notes.length === 0) {
      setStatus('先に「ノート抽出」を実行してください。');
      return;
    }
    notePlaybackRef.current?.stop();
    setIsNotePlaying(true);
    notePlaybackRef.current = playNoteEvents(
      notes,
      (sec) => setNoteCursorSec(sec),
      () => {
        notePlaybackRef.current = null;
        setIsNotePlaying(false);
      },
    );
  };

  const stopMidiPreview = (): void => {
    notePlaybackRef.current?.stop();
    notePlaybackRef.current = null;
    setIsNotePlaying(false);
  };

  const optimizeNotesForSession = async (session: Session): Promise<AutoExtractResult> => {
    if (session.rhythmConfig && session.analysisResult.userPitch.length > 0) {
      return extractGridAlignedNoteEvents(session.analysisResult.userPitch);
    }
    if (session.analysisResult.userPitch.length > 0) {
      return autoExtractBestNoteEvents(session.analysisResult.userPitch);
    }
    const userBuffer = await decodeBlobToAudioBuffer(session.recording);
    const rawPitch = await extractPitchByModel(userBuffer);
    return autoExtractBestNoteEvents(rawPitch);
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
    ? selectedSession.analysisResult.userPitch.filter((frame) => frame.hz !== null).length
    : 0;
  const refTotalCount = selectedSession ? selectedSession.analysisResult.refPitch.length : 0;
  const userTotalCount = selectedSession ? selectedSession.analysisResult.userPitch.length : 0;

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
                if (isReferencePlaying) {
                  const timelineSec = computeReferenceTimelineSec();
                  void playReference(timelineSec);
                }
              }}
              onClickVolumeChange={(value) => {
                setClickVolume(clamp(value, 0, 1));
                if (isReferencePlaying) {
                  const timelineSec = computeReferenceTimelineSec();
                  void playReference(timelineSec);
                }
              }}
              onBpmCommit={(value) => {
                setBpm(clamp(Number.isFinite(value) ? value : DEFAULT_BPM, 40, 240));
                if (isReferencePlaying) {
                  const timelineSec = computeReferenceTimelineSec();
                  void playReference(timelineSec);
                }
              }}
              onBeatsPerBarChange={(value) => {
                setBeatsPerBar(value === 3 ? 3 : 4);
                if (isReferencePlaying) {
                  const timelineSec = computeReferenceTimelineSec();
                  void playReference(timelineSec);
                }
              }}
              onClickOffsetMsChange={(value) => {
                setClickOffsetMs(clamp(Math.round(value), -500, 500));
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
                </div>

                <PitchCanvas
                  refPitch={selectedSession.analysisResult.refPitch}
                  userPitch={selectedSession.analysisResult.userPitch}
                  errors={selectedSession.analysisResult.errorFrames}
                  toleranceCents={selectedSession.analysisConfig.toleranceCents}
                  offsetMs={selectedSession.manualOffsetMs + selectedSession.analysisResult.estimatedOffsetMs}
                />

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
                  <h4>MIDIプレビュー（録音→ノート化）</h4>
                  <div className="controls-row">
                    <button type="button" onClick={() => void generateMidiPreview()}>
                      ノート抽出
                    </button>
                    <button type="button" disabled={currentPreviewNotes.length === 0} onClick={playMidiPreview}>
                      ピアノ再生
                    </button>
                    <button type="button" disabled={!isNotePlaying} onClick={stopMidiPreview}>
                      停止
                    </button>
                    <strong>
                      ノート数: {currentPreviewNotes.length} / 再生位置: {formatSec(noteCursorSec)}
                    </strong>
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
                    durationSec={previewDurationSec}
                    cursorSec={noteCursorSec}
                  />
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
