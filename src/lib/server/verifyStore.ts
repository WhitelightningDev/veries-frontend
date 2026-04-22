import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

export type VerifyEvent = {
  at: number
  name: string
  data?: Record<string, unknown>
}

export type VerifySessionStatus = 'started' | 'submitted'

export type VerifySessionRecord = {
  session_id: string
  status: VerifySessionStatus
  created_at: number
  submitted_at: number | null
  events: VerifyEvent[]
  assets: {
    face_image_bytes: number | null
    document_image_bytes: number | null
    background_video_bytes: number | null
  } | null
}

const sessions = new Map<string, VerifySessionRecord>()

function baseDir() {
  return path.join(process.cwd(), '.veries_uploads')
}

function sessionDir(sessionId: string) {
  return path.join(baseDir(), sessionId)
}

async function ensureDirs(sessionId: string) {
  await mkdir(sessionDir(sessionId), { recursive: true })
}

async function persistSession(record: VerifySessionRecord) {
  await ensureDirs(record.session_id)
  await writeFile(
    path.join(sessionDir(record.session_id), 'session.json'),
    JSON.stringify(record, null, 2) + '\n',
    'utf8',
  )
}

async function appendEvent(sessionId: string, event: VerifyEvent) {
  await ensureDirs(sessionId)
  await appendFile(
    path.join(sessionDir(sessionId), 'events.ndjson'),
    JSON.stringify(event) + '\n',
    'utf8',
  )
}

export async function getOrCreateSession(sessionId: string) {
  const existing = sessions.get(sessionId)
  if (existing) return existing

  const record: VerifySessionRecord = {
    session_id: sessionId,
    status: 'started',
    created_at: Date.now(),
    submitted_at: null,
    events: [],
    assets: null,
  }
  sessions.set(sessionId, record)
  await persistSession(record)
  return record
}

export async function logSessionEvent(
  sessionId: string,
  name: string,
  data?: Record<string, unknown>,
) {
  const record = await getOrCreateSession(sessionId)
  const event: VerifyEvent = { at: Date.now(), name, ...(data ? { data } : {}) }
  record.events.push(event)
  await appendEvent(sessionId, event)
  await persistSession(record)
  return record
}

export async function markSessionSubmitted(
  sessionId: string,
  assets: {
    face_image_bytes: number | null
    document_image_bytes: number | null
    background_video_bytes: number | null
  },
) {
  const record = await getOrCreateSession(sessionId)
  record.status = 'submitted'
  record.submitted_at = Date.now()
  record.assets = assets
  await logSessionEvent(sessionId, 'submission', assets)
  await persistSession(record)
  return record
}

export async function writeSessionAsset(
  sessionId: string,
  filename: string,
  bytes: Uint8Array,
) {
  await ensureDirs(sessionId)
  const fullPath = path.join(sessionDir(sessionId), filename)
  await writeFile(fullPath, bytes)
  return fullPath
}
