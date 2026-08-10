const DB_NAME = "hy-nhi-care";
const DB_VERSION = 1;
const API_BASE = String(globalThis.HY_NHI_CONFIG?.apiBase || "").replace(/\/$/, "");

let dbPromise;

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || new Error("Giao dịch bị hủy"));
  });
}

export function openDatabase() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("entries")) {
        const entries = db.createObjectStore("entries", { keyPath: "id" });
        entries.createIndex("occurredAt", "occurredAt");
        entries.createIndex("type", "type");
        entries.createIndex("updatedAt", "updatedAt");
      }
      if (!db.objectStoreNames.contains("outbox")) {
        db.createObjectStore("outbox", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("meta")) {
        db.createObjectStore("meta", { keyPath: "key" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return dbPromise;
}

export async function getEntries({ includeDeleted = false } = {}) {
  const db = await openDatabase();
  const transaction = db.transaction("entries", "readonly");
  const entries = await requestToPromise(transaction.objectStore("entries").getAll());
  return entries
    .filter((entry) => includeDeleted || !entry.deleted)
    .sort((a, b) => new Date(b.occurredAt) - new Date(a.occurredAt));
}

export async function getEntry(id) {
  const db = await openDatabase();
  const transaction = db.transaction("entries", "readonly");
  return requestToPromise(transaction.objectStore("entries").get(id));
}

export async function saveEntry(entry, { queue = true } = {}) {
  const db = await openDatabase();
  const transaction = db.transaction(queue ? ["entries", "outbox"] : ["entries"], "readwrite");
  transaction.objectStore("entries").put(entry);
  if (queue) {
    transaction.objectStore("outbox").put({
      id: entry.id,
      operation: entry.deleted ? "delete" : "upsert",
      entry,
      queuedAt: new Date().toISOString(),
    });
  }
  await transactionDone(transaction);
  return entry;
}

export async function softDeleteEntry(id, user) {
  const current = await getEntry(id);
  if (!current) return;
  return saveEntry({
    ...current,
    deleted: true,
    updatedAt: new Date().toISOString(),
    updatedBy: user,
    version: (current.version || 1) + 1,
    syncStatus: "pending",
  });
}

export async function setMeta(key, value) {
  const db = await openDatabase();
  const transaction = db.transaction("meta", "readwrite");
  transaction.objectStore("meta").put({ key, value });
  await transactionDone(transaction);
}

export async function getMeta(key, fallback = null) {
  const db = await openDatabase();
  const transaction = db.transaction("meta", "readonly");
  const item = await requestToPromise(transaction.objectStore("meta").get(key));
  return item ? item.value : fallback;
}

export async function getOutbox() {
  const db = await openDatabase();
  const transaction = db.transaction("outbox", "readonly");
  return requestToPromise(transaction.objectStore("outbox").getAll());
}

async function removeOutboxItems(ids) {
  if (!ids.length) return;
  const db = await openDatabase();
  const transaction = db.transaction("outbox", "readwrite");
  ids.forEach((id) => transaction.objectStore("outbox").delete(id));
  await transactionDone(transaction);
}

export async function pendingCount() {
  return (await getOutbox()).length;
}

export async function syncData(user) {
  if (!navigator.onLine) return { status: "offline", pending: await pendingCount() };
  const outbox = await getOutbox();
  const deviceId = await getDeviceId();
  const cursor = await getMeta("syncCursor", null);

  try {
    const token = localStorage.getItem("hynhi_api_token");
    const headers = { "Content-Type": "application/json", "X-Care-User": user };
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await fetch(API_BASE ? `${API_BASE}/api/sync` : "./api/sync", {
      method: "POST",
      headers,
      credentials: API_BASE ? "omit" : "include",
      body: JSON.stringify({ deviceId, cursor, changes: outbox }),
    });
    if (response.status === 401) return { status: "auth", pending: outbox.length };
    if (!response.ok) throw new Error(`sync_${response.status}`);
    const result = await response.json();
    for (const remoteEntry of result.entries || []) {
      const local = await getEntry(remoteEntry.id);
      if (!local || new Date(remoteEntry.updatedAt) > new Date(local.updatedAt)) {
        await saveEntry({ ...remoteEntry, syncStatus: "synced" }, { queue: false });
      }
    }
    await removeOutboxItems(outbox.map((item) => item.id));
    if (result.cursor) await setMeta("syncCursor", result.cursor);
    return { status: "synced", pending: 0 };
  } catch (error) {
    return { status: "local", pending: outbox.length, error: error.message };
  }
}

export async function getDeviceId() {
  let value = await getMeta("deviceId");
  if (!value) {
    value = crypto.randomUUID ? crypto.randomUUID() : `device-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    await setMeta("deviceId", value);
  }
  return value;
}

export async function clearLocalSession() {
  await setMeta("currentUser", null);
  localStorage.removeItem("hynhi_session");
  localStorage.removeItem("hynhi_profile");
  localStorage.removeItem("hynhi_api_token");
}
