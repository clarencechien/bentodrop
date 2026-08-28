// IndexedDB key-value store (§6.8: IndexedDB, not localStorage).
// Shared by the app and the service worker.

const DB_NAME = "bentodrop";
const STORE = "kv";

export function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function kvGet(key) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly").objectStore(STORE).get(key);
      tx.onsuccess = () => resolve(tx.result);
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export async function kvSet(key, value) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite").objectStore(STORE).put(value, key);
      tx.onsuccess = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export async function kvDelete(key) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite").objectStore(STORE).delete(key);
      tx.onsuccess = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

// Well-known keys
export const K = {
  ENTROPY: "entropy",          // Uint8Array(16) — the 128-bit master secret (§5.2)
  USER_NAME: "userName",       // HKDF salt component
  USER_ID: "userId",
  DEVICE_ID: "deviceId",
  DEVICE_TOKEN: "deviceToken",
  DEVICE_LABEL: "deviceLabel",
  BACKED_UP: "backedUpAt",     // §6.5 backup prompt bookkeeping
  BACKUP_PROMPTED: "backupPromptedAt",
  NOTIFY_PREVIEW: "notifyPreview", // §6.3 per-device notification privacy switch
  INSTALL_DISMISSED: "installDismissed", // install-PWA banner closed on this device
  APP_INSTALLED: "appInstalled",         // this device has the PWA installed
  IDENTITY_WRAPPED: "identityWrapped", // user-level identity private key, K_master-wrapped (§5.2)
  MSG_CACHE: "msgCache",           // last inbox listing (ciphertext envelopes) for instant first paint
  VAPID: "vapidPublicKey",
};
