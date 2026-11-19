export interface LocalRecording {
  id: string;
  userId: string;
  title: string;
  filename: string;
  blob: Blob;
  instruction?: string;
  recordedAt?: string;
  recordedTimezone?: string;
  createdAt: string;
  error?: string;
  errorCode?: string;
}
let promise: Promise<IDBDatabase> | undefined;
function database() {
  return (promise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open('nota-recordings', 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore('uploads', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(new Error('浏览器无法保存录音，请检查隐私模式或存储空间'));
  }));
}
export async function putLocal(record: LocalRecording) {
  const db = await database();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('uploads', 'readwrite');
    tx.objectStore('uploads').put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(new Error('录音保存失败，可能是本机存储空间不足'));
  });
}
export async function listLocal(userId: string) {
  const db = await database();
  return new Promise<LocalRecording[]>((resolve, reject) => {
    const request = db.transaction('uploads').objectStore('uploads').getAll();
    request.onsuccess = () =>
      resolve(
        (request.result as LocalRecording[])
          .filter((r) => r.userId === userId)
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
      );
    request.onerror = () => reject(request.error);
  });
}
export async function deleteLocal(id: string) {
  const db = await database();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('uploads', 'readwrite');
    tx.objectStore('uploads').delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
