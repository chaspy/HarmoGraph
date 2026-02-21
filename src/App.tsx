import { useEffect, useMemo, useRef, useState } from 'react';
import './App.css';
import { PitchCanvas } from './components/PitchCanvas';
import { analyzePitch, DEFAULT_ANALYSIS_CONFIG } from './lib/analyzer';
import { decodeBlobToAudioBuffer } from './lib/audioUtils';
import { Recorder } from './lib/recorder';
import { deleteProject, loadProjects, saveProject } from './lib/storage';
import { useObjectUrl } from './lib/useObjectUrl';
import { clamp, createId, formatSec } from './lib/utils';
import type { AnalysisConfig, PlaybackState, Project, Session, StoredTrack, TrackRole } from './types';

const MAX_SONG_SEC = 600;
const WARN_SONG_SEC = 300;

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
  const [playback, setPlayback] = useState<PlaybackState>(defaultPlayback);
  const [isRecording, setIsRecording] = useState(false);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [manualOffsetMs, setManualOffsetMs] = useState(0);
  const [analysisConfig, setAnalysisConfig] = useState<AnalysisConfig>(DEFAULT_ANALYSIS_CONFIG);

  const recorderRef = useRef(new Recorder());
  const recordingRef = useRef(false);
  const vocalAudioRef = useRef<HTMLAudioElement | null>(null);
  const chorusAudioRef = useRef<HTMLAudioElement | null>(null);
  const userAudioRef = useRef<HTMLAudioElement | null>(null);

  const selectedProject = useMemo(
    () => projects.find((project) => project.id === selectedProjectId) ?? null,
    [projects, selectedProjectId],
  );

  const getTrack = (role: TrackRole): StoredTrack | null => {
    if (!selectedProject) return null;
    return selectedProject.tracks.find((track) => track.role === role) ?? null;
  };

  const vocalTrack = getTrack('vocal');
  const chorusTrack = getTrack('chorus');

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

    if (durationSec > MAX_SONG_SEC) {
      setStatus('10分を超える音源はMVP対象外です。10分以内にしてください。');
      return;
    }

    const track: StoredTrack = {
      id: createId(),
      role,
      name: file.name,
      mimeType: file.type || 'audio/mpeg',
      blob: file,
      durationSec,
    };

    const nextProject: Project = {
      ...selectedProject,
      tracks: [...selectedProject.tracks.filter((item) => item.role !== role), track],
    };

    await persistProject(nextProject);

    if (durationSec > WARN_SONG_SEC) {
      setStatus('5分を超える音源です。解析に時間がかかる可能性があります。');
    } else {
      setStatus(`${role === 'vocal' ? 'ボーカル' : 'コーラス'}音源を登録しました。`);
    }
  };

  const stopAllPlayback = (): void => {
    [vocalAudioRef.current, chorusAudioRef.current, userAudioRef.current].forEach((audio) => {
      if (!audio) return;
      audio.pause();
      audio.currentTime = 0;
    });
  };

  const playReference = async (): Promise<void> => {
    if (!vocalUrl && !chorusUrl) {
      setStatus('参照トラックがありません。');
      return;
    }
    const promises: Promise<void>[] = [];
    if (vocalAudioRef.current && vocalUrl) {
      vocalAudioRef.current.currentTime = 0;
      promises.push(vocalAudioRef.current.play());
    }
    if (chorusAudioRef.current && chorusUrl) {
      chorusAudioRef.current.currentTime = 0;
      promises.push(chorusAudioRef.current.play());
    }
    await Promise.allSettled(promises);
  };

  const startPractice = async (): Promise<void> => {
    if (!selectedProject) return;
    if (!chorusTrack) {
      setStatus('練習前に参照コーラス音源をアップロードしてください。');
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
          void playReference();
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
      setStatus('録音停止。解析中です...');
      stopAllPlayback();

      const recording = await recorderRef.current.stop();
      if (!chorusTrack) {
        setStatus('参照コーラスが見つからず解析できませんでした。');
        return;
      }

      const [refBuffer, userBuffer] = await Promise.all([
        decodeBlobToAudioBuffer(chorusTrack.blob),
        decodeBlobToAudioBuffer(recording.blob),
      ]);

      const analysisResult = analyzePitch(refBuffer, userBuffer, analysisConfig, 0);

      const session: Session = {
        id: createId(),
        createdAt: new Date().toISOString(),
        recording: recording.blob,
        recordingMimeType: recording.mimeType,
        durationSec: recording.durationSec,
        manualOffsetMs: 0,
        analysisConfig,
        analysisResult,
      };

      const nextProject: Project = {
        ...selectedProject,
        sessions: [session, ...selectedProject.sessions],
      };

      await persistProject(nextProject);
      setActiveSessionId(session.id);
      setStatus('解析が完了しました。グラフと統計を確認してください。');
    } catch (error) {
      const message = error instanceof Error ? error.message : '録音停止に失敗しました';
      setStatus(`停止/解析エラー: ${message}`);
    } finally {
      setIsRecording(false);
      setCountdown(null);
    }
  };

  const reanalyzeCurrentSession = async (): Promise<void> => {
    if (!selectedProject || !selectedSession || !chorusTrack) {
      setStatus('再解析に必要なデータが不足しています。');
      return;
    }

    try {
      setStatus('オフセットを反映して再解析中...');
      const [refBuffer, userBuffer] = await Promise.all([
        decodeBlobToAudioBuffer(chorusTrack.blob),
        decodeBlobToAudioBuffer(selectedSession.recording),
      ]);
      const result = analyzePitch(refBuffer, userBuffer, analysisConfig, manualOffsetMs);

      const updatedSession: Session = {
        ...selectedSession,
        manualOffsetMs,
        analysisConfig,
        analysisResult: result,
      };

      const nextProject: Project = {
        ...selectedProject,
        sessions: selectedProject.sessions.map((item) =>
          item.id === selectedSession.id ? updatedSession : item,
        ),
      };
      await persistProject(nextProject);
      setStatus('再解析が完了しました。');
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

  return (
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
        <div className="status">{status}</div>

        {!selectedProject ? (
          <section className="card">曲を作成すると練習を開始できます。</section>
        ) : (
          <>
            <section className="card">
              <h2>{selectedProject.name}</h2>
              <div className="upload-grid">
                <label>
                  参照ボーカル (任意)
                  <input
                    type="file"
                    accept="audio/*"
                    onChange={(event) => void onUploadTrack('vocal', event.target.files?.[0] ?? null)}
                  />
                  <span>{vocalTrack?.name ?? '未登録'}</span>
                </label>
                <label>
                  参照コーラス (必須)
                  <input
                    type="file"
                    accept="audio/*"
                    onChange={(event) => void onUploadTrack('chorus', event.target.files?.[0] ?? null)}
                  />
                  <span>{chorusTrack?.name ?? '未登録'}</span>
                </label>
              </div>
            </section>

            <section className="card">
              <h3>練習セッション</h3>
              <p>2秒カウント後に参照再生しながら録音します。</p>
              <div className="controls-row">
                <button type="button" disabled={isRecording} onClick={() => void startPractice()}>
                  練習開始
                </button>
                <button type="button" disabled={!isRecording} onClick={() => void stopPractice()}>
                  停止して解析
                </button>
                {countdown !== null && <strong>開始まで {countdown}</strong>}
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

              <div className="controls-row">
                <button type="button" onClick={() => void playReference()}>
                  参照を再生
                </button>
                <button type="button" onClick={stopAllPlayback}>
                  停止
                </button>
              </div>
            </section>

            {selectedSession && (
              <section className="card">
                <h3>解析結果</h3>
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
              </section>
            )}

            <audio ref={vocalAudioRef} src={vocalUrl} />
            <audio ref={chorusAudioRef} src={chorusUrl} />
          </>
        )}
      </main>
    </div>
  );
}

export default App;
