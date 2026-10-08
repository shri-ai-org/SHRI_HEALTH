// The teleconsult recording, kept in this browser's IndexedDB a few seconds at a time
// as it is made — so a long call never sits whole in memory, and a reload or a closed
// tab loses at most the last few seconds. The doctor downloads it as one file, and can
// remove it from the device once it is safely kept elsewhere.

const DB = 'shri-tele'
const STORE = 'chunks'

let opening: Promise<IDBDatabase> | null = null

function db(): Promise<IDBDatabase> {
  opening ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: ['sid', 'seq'] })
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => {
      opening = null
      reject(req.error ?? new Error('This browser would not open its storage.'))
    }
  })
  return opening
}

const range = (sid: string) => IDBKeyRange.bound([sid, 0], [sid, Number.MAX_SAFE_INTEGER])

function done(tx: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error ?? new Error('The recording could not be saved. The device may be out of space.'))
  })
}

export async function putChunk(sid: string, seq: number, blob: Blob) {
  const tx = (await db()).transaction(STORE, 'readwrite')
  tx.objectStore(STORE).put({ sid, seq, blob })
  await done(tx)
}

export async function recordingBlob(sid: string, type: string): Promise<Blob | null> {
  const tx = (await db()).transaction(STORE, 'readonly')
  const req = tx.objectStore(STORE).getAll(range(sid))
  const rows = await new Promise<{ seq: number; blob: Blob }[]>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result as { seq: number; blob: Blob }[])
    req.onerror = () => reject(req.error)
  })
  if (!rows.length) return null
  rows.sort((a, b) => a.seq - b.seq)
  return new Blob(
    rows.map((r) => r.blob),
    { type },
  )
}

export async function removeRecording(sid: string) {
  const tx = (await db()).transaction(STORE, 'readwrite')
  tx.objectStore(STORE).delete(range(sid))
  await done(tx)
}
