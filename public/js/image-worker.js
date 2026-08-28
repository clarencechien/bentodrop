// Dedicated worker for image compression (README 優化 #4): the 300ms+ of
// canvas work on a phone no longer blocks the UI thread. Same code path as
// the main thread — this just moves where it runs.
import { compressImage } from "./image.js";

self.onmessage = async (e) => {
  const { id, file, original } = e.data;
  try {
    const prepared = await compressImage(file, { original });
    self.postMessage({ id, ok: true, prepared }, [prepared.bytes.buffer]);
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err?.message ?? err) });
  }
};
