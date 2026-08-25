import Dexie from "dexie";

export const db = new Dexie("HabitOS");

db.version(1).stores({
  appState: "id",
});

export async function loadAppState() {
  const record = await db.appState.get("main");
  return record?.data ?? null;
}

export async function saveAppState(data) {
  await db.appState.put({
    id: "main",
    data,
    updatedAt: new Date().toISOString(),
  });
}

export async function clearAppState() {
  await db.appState.delete("main");
}