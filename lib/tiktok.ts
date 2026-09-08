import fs from "fs/promises";
import path from "path";
import { randomBytes } from "crypto";

const AUTHORIZE_URL = "https://www.tiktok.com/v2/auth/authorize/";
const TOKEN_URL = "https://open.tiktokapis.com/v2/oauth/token/";
const CREATOR_INFO_URL = "https://open.tiktokapis.com/v2/post/publish/creator_info/query/";
const INIT_URL = "https://open.tiktokapis.com/v2/post/publish/video/init/";
const STATUS_URL = "https://open.tiktokapis.com/v2/post/publish/status/fetch/";

const TOKENS_PATH = path.join(process.cwd(), "data", "tiktok-tokens.json");

const MIN_CHUNK_BYTES = 5 * 1024 * 1024;
const MAX_CHUNK_BYTES = 64 * 1024 * 1024;
const TARGET_CHUNK_BYTES = 10 * 1024 * 1024;

interface StoredTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  refreshExpiresAt: number;
  openId: string;
  scope: string;
  username?: string;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set - see the TikTok section of the README to set up posting.`);
  }
  return value;
}

export function isConfigured(): boolean {
  return Boolean(process.env.TIKTOK_CLIENT_KEY && process.env.TIKTOK_CLIENT_SECRET && process.env.TIKTOK_REDIRECT_URI);
}

export function getAuthorizeUrl(state: string): string {
  const params = new URLSearchParams({
    client_key: requireEnv("TIKTOK_CLIENT_KEY"),
    scope: "video.publish",
    response_type: "code",
    redirect_uri: requireEnv("TIKTOK_REDIRECT_URI"),
    state,
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

export function generateState(): string {
  return randomBytes(16).toString("hex");
}

async function loadTokens(): Promise<StoredTokens | null> {
  try {
    const raw = await fs.readFile(TOKENS_PATH, "utf8");
    return JSON.parse(raw) as StoredTokens;
  } catch {
    return null;
  }
}

async function saveTokens(tokens: StoredTokens): Promise<void> {
  await fs.mkdir(path.dirname(TOKENS_PATH), { recursive: true });
  await fs.writeFile(TOKENS_PATH, JSON.stringify(tokens, null, 2), "utf8");
}

export async function getConnectionStatus(): Promise<{ connected: boolean; username?: string }> {
  const tokens = await loadTokens();
  if (!tokens) return { connected: false };
  return { connected: true, username: tokens.username };
}

export async function disconnect(): Promise<void> {
  await fs.rm(TOKENS_PATH, { force: true });
}

export async function exchangeCodeForTokens(code: string): Promise<void> {
  const body = new URLSearchParams({
    client_key: requireEnv("TIKTOK_CLIENT_KEY"),
    client_secret: requireEnv("TIKTOK_CLIENT_SECRET"),
    code,
    grant_type: "authorization_code",
    redirect_uri: requireEnv("TIKTOK_REDIRECT_URI"),
  });

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body,
  });

  const json = await response.json();
  if (!response.ok || json.error) {
    throw new Error(`TikTok token exchange failed: ${json.error_description || json.error || response.statusText}`);
  }

  const now = Date.now();
  const tokens: StoredTokens = {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt: now + json.expires_in * 1000,
    refreshExpiresAt: now + json.refresh_expires_in * 1000,
    openId: json.open_id,
    scope: json.scope,
  };
  await saveTokens(tokens);

  // Best-effort - fetch a display name so the UI can show "Connected as @..."
  try {
    const info = await fetchCreatorInfo(tokens.accessToken);
    if (info.creator_username) {
      await saveTokens({ ...tokens, username: info.creator_username });
    }
  } catch {
    // Non-fatal - connection still succeeded without a display name.
  }
}

async function refreshTokens(tokens: StoredTokens): Promise<StoredTokens> {
  const body = new URLSearchParams({
    client_key: requireEnv("TIKTOK_CLIENT_KEY"),
    client_secret: requireEnv("TIKTOK_CLIENT_SECRET"),
    grant_type: "refresh_token",
    refresh_token: tokens.refreshToken,
  });

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body,
  });

  const json = await response.json();
  if (!response.ok || json.error) {
    throw new Error(
      `TikTok token refresh failed: ${json.error_description || json.error || response.statusText} - ` +
        "you may need to reconnect your TikTok account.",
    );
  }

  const now = Date.now();
  const updated: StoredTokens = {
    ...tokens,
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt: now + json.expires_in * 1000,
    refreshExpiresAt: now + json.refresh_expires_in * 1000,
  };
  await saveTokens(updated);
  return updated;
}

async function getValidAccessToken(): Promise<string> {
  let tokens = await loadTokens();
  if (!tokens) {
    throw new Error("TikTok isn't connected yet - use the \"Connect TikTok\" button first.");
  }
  if (tokens.expiresAt < Date.now() + 60_000) {
    tokens = await refreshTokens(tokens);
  }
  return tokens.accessToken;
}

interface CreatorInfo {
  creator_username: string;
  creator_nickname: string;
  privacy_level_options: string[];
  comment_disabled: boolean;
  duet_disabled: boolean;
  stitch_disabled: boolean;
  max_video_post_duration_sec: number;
}

async function fetchCreatorInfo(accessToken: string): Promise<CreatorInfo> {
  const response = await fetch(CREATOR_INFO_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json; charset=UTF-8" },
  });
  const json = await response.json();
  if (!response.ok || json.error?.code !== "ok") {
    throw new Error(`Could not fetch TikTok creator info: ${json.error?.message || response.statusText}`);
  }
  return json.data as CreatorInfo;
}

function pickPrivacyLevel(options: string[]): string {
  const preferred = process.env.TIKTOK_PRIVACY_LEVEL;
  if (preferred && options.includes(preferred)) return preferred;
  if (options.includes("SELF_ONLY")) return "SELF_ONLY";
  return options[0];
}

function computeChunkPlan(videoSize: number): { chunkSize: number; totalChunkCount: number } {
  if (videoSize <= MIN_CHUNK_BYTES) {
    return { chunkSize: videoSize, totalChunkCount: 1 };
  }
  const chunkSize = Math.min(MAX_CHUNK_BYTES, TARGET_CHUNK_BYTES);
  return { chunkSize, totalChunkCount: Math.ceil(videoSize / chunkSize) };
}

export interface PostResult {
  publishId: string;
  status: string;
  postIds?: string[];
}

/**
 * Posts a clip to TikTok via the Content Posting API's Direct Post flow.
 *
 * IMPORTANT: unaudited apps (the default until TikTok reviews yours) can only publish
 * as SELF_ONLY - visible just to the connected account - regardless of what privacy
 * level is requested. Public posting requires submitting the app for review.
 */
export async function postVideoToTikTok(videoPath: string, caption: string): Promise<PostResult> {
  const accessToken = await getValidAccessToken();
  const creatorInfo = await fetchCreatorInfo(accessToken);
  const privacyLevel = pickPrivacyLevel(creatorInfo.privacy_level_options);

  const video = await fs.readFile(videoPath);
  const { chunkSize, totalChunkCount } = computeChunkPlan(video.byteLength);

  const initResponse = await fetch(INIT_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json; charset=UTF-8" },
    body: JSON.stringify({
      post_info: {
        title: caption.slice(0, 2200),
        privacy_level: privacyLevel,
        disable_duet: false,
        disable_comment: creatorInfo.comment_disabled,
        disable_stitch: false,
      },
      source_info: {
        source: "FILE_UPLOAD",
        video_size: video.byteLength,
        chunk_size: chunkSize,
        total_chunk_count: totalChunkCount,
      },
    }),
  });

  const initJson = await initResponse.json();
  if (!initResponse.ok || initJson.error?.code !== "ok") {
    throw new Error(`TikTok upload init failed: ${initJson.error?.message || initResponse.statusText}`);
  }

  const publishId: string = initJson.data.publish_id;
  const uploadUrl: string = initJson.data.upload_url;

  for (let i = 0; i < totalChunkCount; i++) {
    const start = i * chunkSize;
    const end = Math.min(start + chunkSize, video.byteLength) - 1;
    const chunk = video.subarray(start, end + 1);

    const uploadResponse = await fetch(uploadUrl, {
      method: "PUT",
      headers: {
        "Content-Type": "video/mp4",
        "Content-Range": `bytes ${start}-${end}/${video.byteLength}`,
      },
      body: chunk,
    });

    if (!uploadResponse.ok) {
      const text = await uploadResponse.text().catch(() => "");
      throw new Error(`TikTok chunk upload failed (chunk ${i + 1}/${totalChunkCount}): ${uploadResponse.status} ${text}`);
    }
  }

  return pollPublishStatus(accessToken, publishId);
}

async function pollPublishStatus(accessToken: string, publishId: string): Promise<PostResult> {
  const maxAttempts = 30;
  const delayMs = 3000;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const response = await fetch(STATUS_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json; charset=UTF-8" },
      body: JSON.stringify({ publish_id: publishId }),
    });
    const json = await response.json();
    if (!response.ok || json.error?.code !== "ok") {
      throw new Error(`TikTok status check failed: ${json.error?.message || response.statusText}`);
    }

    const status: string = json.data.status;
    if (status === "PUBLISH_COMPLETE") {
      return { publishId, status, postIds: json.data.publicaly_available_post_id };
    }
    if (status === "FAILED") {
      throw new Error(`TikTok publish failed: ${json.data.fail_reason || "unknown reason"}`);
    }

    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  throw new Error("Timed out waiting for TikTok to finish processing the upload.");
}
