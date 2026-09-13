import crypto from "crypto";
import fs from "fs/promises";
import path from "path";

/**
 * TikTok Content Posting API integration (https://developers.tiktok.com/doc/content-posting-api-get-started).
 * Requires a TikTok developer app with the Login Kit and Content Posting API products
 * added - see README for setup. Tokens are stored locally (data/tiktok-tokens.json,
 * gitignored along with the rest of data/) since this is a single-user local app, not a
 * multi-tenant service.
 *
 * IMPORTANT LIMITATION: until a TikTok developer app passes TikTok's audit, the
 * Content Posting API restricts it to posting as SELF_ONLY (private) - queryCreatorInfo
 * below reflects whatever TikTok actually allows for the connected account, but for an
 * unaudited app that will be private, not public. You (or whoever's using this) will
 * still need to open TikTok and manually change a post's visibility. This is a TikTok
 * platform restriction, not something this code can work around.
 */

const TOKENS_PATH = path.join(process.cwd(), "data", "tiktok-tokens.json");

const AUTHORIZE_URL = "https://www.tiktok.com/v2/auth/authorize/";
const TOKEN_URL = "https://open.tiktokapis.com/v2/oauth/token/";
const CREATOR_INFO_URL = "https://open.tiktokapis.com/v2/post/publish/creator_info/query/";
const PUBLISH_INIT_URL = "https://open.tiktokapis.com/v2/post/publish/video/init/";
const PUBLISH_STATUS_URL = "https://open.tiktokapis.com/v2/post/publish/status/fetch/";

// video.publish is the Content Posting API's Direct Post scope; user.info.basic just
// lets us confirm which account is connected.
const SCOPES = "user.info.basic,video.publish";

export function getRedirectUri(): string {
  return process.env.TIKTOK_REDIRECT_URI || "http://localhost:3000/api/tiktok/callback";
}

function requireCredentials(): { clientKey: string; clientSecret: string } {
  const clientKey = process.env.TIKTOK_CLIENT_KEY;
  const clientSecret = process.env.TIKTOK_CLIENT_SECRET;
  if (!clientKey || !clientSecret) {
    throw new Error(
      "TIKTOK_CLIENT_KEY / TIKTOK_CLIENT_SECRET aren't set - create a TikTok developer app and add them to " +
        ".env.local (see README's TikTok section).",
    );
  }
  return { clientKey, clientSecret };
}

interface StoredTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  openId: string;
}

async function readTokens(): Promise<StoredTokens | null> {
  try {
    return JSON.parse(await fs.readFile(TOKENS_PATH, "utf8")) as StoredTokens;
  } catch {
    return null;
  }
}

async function writeTokens(tokens: StoredTokens): Promise<void> {
  await fs.mkdir(path.dirname(TOKENS_PATH), { recursive: true });
  await fs.writeFile(TOKENS_PATH, JSON.stringify(tokens, null, 2), "utf8");
}

export async function isConnected(): Promise<boolean> {
  return (await readTokens()) !== null;
}

export async function disconnect(): Promise<void> {
  await fs.rm(TOKENS_PATH, { force: true });
}

// --- OAuth: PKCE + authorize URL + token exchange ---

export function generatePkce(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function buildAuthorizeUrl(state: string, codeChallenge: string): string {
  const { clientKey } = requireCredentials();
  const params = new URLSearchParams({
    client_key: clientKey,
    scope: SCOPES,
    response_type: "code",
    redirect_uri: getRedirectUri(),
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  open_id: string;
}

async function postForm<T>(url: string, params: Record<string, string>): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "Cache-Control": "no-cache" },
    body: new URLSearchParams(params).toString(),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || data?.error) {
    const message = data?.error_description || data?.error || `TikTok request failed (${res.status})`;
    throw new Error(message);
  }
  return data as T;
}

export async function exchangeCodeForTokens(code: string, codeVerifier: string): Promise<void> {
  const { clientKey, clientSecret } = requireCredentials();
  const data = await postForm<TokenResponse>(TOKEN_URL, {
    client_key: clientKey,
    client_secret: clientSecret,
    code,
    grant_type: "authorization_code",
    redirect_uri: getRedirectUri(),
    code_verifier: codeVerifier,
  });
  await writeTokens({
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + data.expires_in * 1000,
    openId: data.open_id,
  });
}

async function refreshTokens(refreshToken: string): Promise<StoredTokens> {
  const { clientKey, clientSecret } = requireCredentials();
  const data = await postForm<TokenResponse>(TOKEN_URL, {
    client_key: clientKey,
    client_secret: clientSecret,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
  const tokens: StoredTokens = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + data.expires_in * 1000,
    openId: data.open_id,
  };
  await writeTokens(tokens);
  return tokens;
}

/** A valid access token, refreshing first if the stored one is expired or about to be. */
async function getAccessToken(): Promise<string> {
  const tokens = await readTokens();
  if (!tokens) {
    throw new Error('TikTok isn\'t connected - click "Connect TikTok" first.');
  }
  const EXPIRY_BUFFER_MS = 60_000;
  if (Date.now() + EXPIRY_BUFFER_MS >= tokens.expiresAt) {
    return (await refreshTokens(tokens.refreshToken)).accessToken;
  }
  return tokens.accessToken;
}

// --- Content Posting API ---

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const accessToken = await getAccessToken();
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json; charset=UTF-8" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || (data?.error && data.error.code !== "ok")) {
    const message = data?.error?.message || `TikTok request failed (${res.status})`;
    throw new Error(message);
  }
  return data as T;
}

interface CreatorInfo {
  privacy_level_options: string[];
  comment_disabled: boolean;
  duet_disabled: boolean;
  stitch_disabled: boolean;
  max_video_post_duration_sec: number;
}

/**
 * TikTok requires querying this before every post, both to know which privacy levels
 * this specific creator/app combination is actually allowed to use (an unaudited app is
 * typically restricted to SELF_ONLY - see the module doc comment) and to respect
 * account-level duet/comment/stitch settings.
 */
async function queryCreatorInfo(): Promise<CreatorInfo> {
  const data = await postJson<{ data: CreatorInfo }>(CREATOR_INFO_URL, {});
  return data.data;
}

// Chunked upload rules per TikTok's docs: a file at or under 64MB can be sent as a
// single chunk; anything larger must be split into chunks (all but the last at least
// 5MB) that together cover the whole file.
const SINGLE_CHUNK_MAX_BYTES = 64 * 1024 * 1024;

export function planChunks(totalSize: number): { chunkSize: number; chunkCount: number } {
  if (totalSize <= SINGLE_CHUNK_MAX_BYTES) {
    return { chunkSize: totalSize, chunkCount: 1 };
  }
  const chunkCount = Math.ceil(totalSize / SINGLE_CHUNK_MAX_BYTES);
  return { chunkSize: Math.ceil(totalSize / chunkCount), chunkCount };
}

async function uploadVideoFile(
  uploadUrl: string,
  filePath: string,
  totalSize: number,
  chunkSize: number,
  chunkCount: number,
): Promise<void> {
  const fileHandle = await fs.open(filePath, "r");
  try {
    for (let i = 0; i < chunkCount; i++) {
      const start = i * chunkSize;
      const end = Math.min(start + chunkSize, totalSize) - 1;
      const length = end - start + 1;
      const buffer = Buffer.alloc(length);
      await fileHandle.read(buffer, 0, length, start);

      const res = await fetch(uploadUrl, {
        method: "PUT",
        headers: {
          "Content-Type": "video/mp4",
          "Content-Range": `bytes ${start}-${end}/${totalSize}`,
          "Content-Length": String(length),
        },
        body: buffer,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`Uploading video to TikTok failed on chunk ${i + 1}/${chunkCount} (${res.status}): ${text}`);
      }
    }
  } finally {
    await fileHandle.close();
  }
}

export interface PublishResult {
  publishId: string;
  privacyLevel: string;
}

/** Uploads a local video file to TikTok and starts a Direct Post. Returns immediately
 * after the upload finishes - TikTok then processes the video asynchronously, so use
 * fetchPublishStatus to find out when (and whether) it actually went through. */
export async function publishVideo(filePath: string, caption: string): Promise<PublishResult> {
  const stat = await fs.stat(filePath);
  const creatorInfo = await queryCreatorInfo();

  const privacyLevel = creatorInfo.privacy_level_options.includes("SELF_ONLY")
    ? "SELF_ONLY"
    : creatorInfo.privacy_level_options[0];
  if (!privacyLevel) {
    throw new Error("TikTok didn't return any allowed privacy level for this account - can't post.");
  }

  const { chunkSize, chunkCount } = planChunks(stat.size);

  const initData = await postJson<{ data: { publish_id: string; upload_url: string } }>(PUBLISH_INIT_URL, {
    post_info: {
      title: caption,
      privacy_level: privacyLevel,
      disable_duet: creatorInfo.duet_disabled,
      disable_comment: creatorInfo.comment_disabled,
      disable_stitch: creatorInfo.stitch_disabled,
    },
    source_info: {
      source: "FILE_UPLOAD",
      video_size: stat.size,
      chunk_size: chunkSize,
      total_chunk_count: chunkCount,
    },
  });

  const { publish_id, upload_url } = initData.data;
  await uploadVideoFile(upload_url, filePath, stat.size, chunkSize, chunkCount);
  return { publishId: publish_id, privacyLevel };
}

export interface PublishStatus {
  status: string;
  failReason?: string;
}

export async function fetchPublishStatus(publishId: string): Promise<PublishStatus> {
  const data = await postJson<{ data: { status: string; fail_reason?: string } }>(PUBLISH_STATUS_URL, {
    publish_id: publishId,
  });
  return { status: data.data.status, failReason: data.data.fail_reason };
}
