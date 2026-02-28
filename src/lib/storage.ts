import type { Project } from '../types';

interface StoredTrackDTO {
  id: string;
  role: 'vocal' | 'chorus';
  name: string;
  mimeType: string;
  blobDataUrl: string;
  durationSec: number;
  offsetMs: number;
}

interface SessionDTO {
  id: string;
  createdAt: string;
  recordingDataUrl: string;
  recordingMimeType: string;
  durationSec: number;
  analysisReferenceRole?: 'vocal' | 'chorus';
  manualOffsetMs: number;
  analysisConfig: Project['sessions'][number]['analysisConfig'];
  rhythmConfig?: Project['sessions'][number]['rhythmConfig'];
  analysisResult: Project['sessions'][number]['analysisResult'];
}

interface ProjectDTO {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  tracks: StoredTrackDTO[];
  sessions: SessionDTO[];
  referenceAlignConfig?: Project['referenceAlignConfig'];
}

const LEGACY_DB_NAME = 'harmograph-db';
const LEGACY_STORE = 'projects';

const blobToDataUrl = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('blob read failed'));
    reader.readAsDataURL(blob);
  });

const dataUrlToBlob = async (dataUrl: string): Promise<Blob> => {
  const res = await fetch(dataUrl);
  return res.blob();
};

const projectToDTO = async (project: Project): Promise<ProjectDTO> => {
  const tracks = await Promise.all(
    project.tracks.map(async (track) => ({
      ...track,
      blobDataUrl: await blobToDataUrl(track.blob),
    })),
  );
  const sessions = await Promise.all(
    project.sessions.map(async (session) => ({
      id: session.id,
      createdAt: session.createdAt,
      recordingDataUrl: await blobToDataUrl(session.recording),
      recordingMimeType: session.recordingMimeType,
      durationSec: session.durationSec,
      analysisReferenceRole: session.analysisReferenceRole,
      manualOffsetMs: session.manualOffsetMs,
      analysisConfig: session.analysisConfig,
      rhythmConfig: session.rhythmConfig,
      analysisResult: session.analysisResult,
    })),
  );
  return {
    id: project.id,
    name: project.name,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    tracks,
    sessions,
    referenceAlignConfig: project.referenceAlignConfig,
  };
};

const dtoToProject = async (dto: ProjectDTO): Promise<Project> => {
  const tracks = await Promise.all(
    dto.tracks.map(async (track) => ({
      id: track.id,
      role: track.role,
      name: track.name,
      mimeType: track.mimeType,
      blob: await dataUrlToBlob(track.blobDataUrl),
      durationSec: track.durationSec,
      offsetMs: track.offsetMs,
    })),
  );
  const sessions = await Promise.all(
    dto.sessions.map(async (session) => ({
      id: session.id,
      createdAt: session.createdAt,
      recording: await dataUrlToBlob(session.recordingDataUrl),
      recordingMimeType: session.recordingMimeType,
      durationSec: session.durationSec,
      analysisReferenceRole: session.analysisReferenceRole,
      manualOffsetMs: session.manualOffsetMs,
      analysisConfig: session.analysisConfig,
      rhythmConfig: session.rhythmConfig,
      analysisResult: session.analysisResult,
    })),
  );
  return {
    id: dto.id,
    name: dto.name,
    createdAt: dto.createdAt,
    updatedAt: dto.updatedAt,
    tracks,
    sessions,
    referenceAlignConfig: dto.referenceAlignConfig,
  };
};

const requestJson = async <T>(input: RequestInfo, init?: RequestInit): Promise<T> => {
  const res = await fetch(input, init);
  if (!res.ok) {
    throw new Error(`storage request failed: ${res.status}`);
  }
  return (await res.json()) as T;
};

const loadLegacyProjects = async (): Promise<Project[]> =>
  new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') {
      resolve([]);
      return;
    }
    const req = indexedDB.open(LEGACY_DB_NAME, 1);
    req.onerror = () => resolve([]);
    req.onsuccess = () => {
      try {
        const db = req.result;
        if (!db.objectStoreNames.contains(LEGACY_STORE)) {
          resolve([]);
          return;
        }
        const tx = db.transaction(LEGACY_STORE, 'readonly');
        const store = tx.objectStore(LEGACY_STORE);
        const getAllReq = store.getAll();
        getAllReq.onerror = () => resolve([]);
        getAllReq.onsuccess = () => resolve((getAllReq.result as Project[]) ?? []);
      } catch {
        resolve([]);
      }
    };
    req.onupgradeneeded = () => resolve([]);
  });

export const loadProjects = async (): Promise<Project[]> => {
  try {
    const payload = await requestJson<{ projects: ProjectDTO[] }>('/__db/projects');
    const projects = await Promise.all(payload.projects.map((project) => dtoToProject(project)));
    if (projects.length > 0) {
      return projects.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    }

    const legacy = await loadLegacyProjects();
    if (legacy.length > 0) {
      await Promise.all(legacy.map((project) => saveProject(project)));
      return legacy.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    }
    return [];
  } catch {
    const legacy = await loadLegacyProjects();
    return legacy.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
};

export const saveProject = async (project: Project): Promise<void> => {
  const dto = await projectToDTO(project);
  await requestJson<{ ok: boolean }>(`/__db/projects/${project.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(dto),
  });
};

export const deleteProject = async (projectId: string): Promise<void> => {
  await requestJson<{ ok: boolean }>(`/__db/projects/${projectId}`, { method: 'DELETE' });
};
