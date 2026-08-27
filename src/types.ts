export interface Env {
  DB: D1Database;
  INBOX: R2Bucket;
  ASSETS: Fetcher;
  VAPID_PUBLIC_KEY: string;
  VAPID_SUBJECT: string;
  VAPID_PRIVATE_JWK: string;
  URL_SIGNING_SECRET: string;
}

// Spec constants
export const TEXT_PLAINTEXT_MAX = 2000;          // §3.1 / §12.4 plaintext byte budget
export const PUSH_ENVELOPE_MAX = 3800;           // §3.1 encoded envelope must fit ~4KB push payload
export const FILE_MAX_BYTES = 20 * 1024 * 1024;  // §1.2
export const UPLOAD_URL_TTL_S = 600;             // §3.2 presigned PUT TTL 10 min
export const DOWNLOAD_URL_TTL_S = 600;
export const PAIR_TTL_MS = 5 * 60 * 1000;        // §6.6 guardrail: 5 minutes
export const PAIR_MAX_ATTEMPTS = 3;              // §6.6 guardrail: 3 tries
export const PAIR_RATE_PER_HOUR = 5;             // §6.6 guardrail: 5 pairings/user/hour
export const PUSH_TTL_TEXT_S = 600;              // §8.2
export const PUSH_TTL_FILE_S = 86400;            // §8.2
export const SUB_FAIL_LIMIT = 5;                 // §8.3
export const RETENTION_ALLOWED = [1, 7, 30];     // §10.2

export interface DeviceCtx {
  deviceId: string;
  userId: string;
  label: string | null;
}
