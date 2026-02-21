import { openDB } from 'idb';
import type { DBSchema, IDBPDatabase } from 'idb';
import type { Project } from '../types';

interface HarmoGraphDB extends DBSchema {
  projects: {
    key: string;
    value: Project;
  };
}

const DB_NAME = 'harmograph-db';
const DB_VERSION = 1;

let dbPromise: Promise<IDBPDatabase<HarmoGraphDB>> | null = null;

const getDb = (): Promise<IDBPDatabase<HarmoGraphDB>> => {
  if (!dbPromise) {
    dbPromise = openDB<HarmoGraphDB>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains('projects')) {
          db.createObjectStore('projects', { keyPath: 'id' });
        }
      },
    });
  }
  return dbPromise;
};

export const loadProjects = async (): Promise<Project[]> => {
  const db = await getDb();
  const all = await db.getAll('projects');
  return all.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
};

export const saveProject = async (project: Project): Promise<void> => {
  const db = await getDb();
  await db.put('projects', project);
};

export const deleteProject = async (projectId: string): Promise<void> => {
  const db = await getDb();
  await db.delete('projects', projectId);
};
