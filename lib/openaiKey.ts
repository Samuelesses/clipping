import fs from "fs/promises";
import path from "path";
import OpenAI from "openai";

const secretDir = path.join(process.cwd(), "data", "settings");
const secretFile = path.join(secretDir, "openai-key");

export async function hasOpenAIKey(): Promise<boolean> {
  const saved = await readStoredKey();
  return Boolean(saved || process.env.OPENAI_API_KEY?.trim());
}

async function readStoredKey(): Promise<string | null> {
  try {
    const value = (await fs.readFile(secretFile, "utf8")).trim();
    return value || null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Saved in the gitignored data directory on this device, never sent to the client. */
export async function saveOpenAIKey(key: string): Promise<void> {
  await fs.mkdir(secretDir, { recursive: true, mode: 0o700 });
  const temporary = path.join(secretDir, `openai-key-${process.pid}.tmp`);
  try {
    await fs.writeFile(temporary, key, { encoding: "utf8", mode: 0o600, flag: "w" });
    await fs.chmod(temporary, 0o600);
    await fs.rename(temporary, secretFile);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

export async function clearOpenAIKey(): Promise<void> {
  await fs.rm(secretFile, { force: true });
}

export async function createOpenAIClient(): Promise<OpenAI> {
  // An in-app key takes precedence; .env.local remains supported for existing users.
  const apiKey = (await readStoredKey()) || process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("No OpenAI API key configured. Open Settings and save your API key.");
  }
  return new OpenAI({ apiKey });
}
