import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

const LARGE_BUFFER = 1024 * 1024 * 100;

export async function run(command: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync(command, args, {
      maxBuffer: LARGE_BUFFER,
    });
    return stdout;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`${command} ${args[0] ?? ""} failed: ${message}`);
  }
}

export async function checkDependency(command: string, versionFlag: string, installHint: string): Promise<void> {
  try {
    await execFileAsync(command, [versionFlag]);
  } catch {
    throw new Error(`Required tool "${command}" was not found on your PATH. ${installHint}`);
  }
}
