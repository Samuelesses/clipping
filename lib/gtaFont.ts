import fs from "fs/promises";
import path from "path";

const fontDir = path.join(process.cwd(), "data", "fonts");
const bundledDir = path.join(process.cwd(), "fonts");

/** User-supplied Pricedown Black remains on their own Mac, not in the repository. */
export async function getGtaFontPath(): Promise<string | null> {
  const choices = [
    process.env.GTA_TITLE_FONT_PATH,
    path.join(fontDir, "pricedown.ttf"),
    path.join(fontDir, "pricedown.otf"),
    path.join(bundledDir, "Pricedown.ttf"),
    path.join(bundledDir, "PricedownBl-Regular.ttf"),
    path.join(bundledDir, "Pricedown.otf"),
  ].filter((p): p is string => Boolean(p));
  for (const file of choices) {
    try { if ((await fs.stat(file)).isFile()) return file; } catch { /* continue */ }
  }
  return null;
}

/** Remove all uploaded custom fonts without removing other user data. */
export async function saveUserGtaFont(data: Buffer, extension: "ttf" | "otf"): Promise<void> {
  await fs.mkdir(fontDir, { recursive: true, mode: 0o700 });
  const dest = path.join(fontDir, `pricedown.${extension}`);
  const temp = dest + "." + process.pid + ".tmp";
  try {
    await fs.writeFile(temp, data, { mode: 0o600 });
    await fs.rename(temp, dest);
    await fs.rm(path.join(fontDir, extension === "ttf" ? "pricedown.otf" : "pricedown.ttf"), { force: true });
  } finally {
    await fs.rm(temp, { force: true }).catch(() => {});
  }
}
