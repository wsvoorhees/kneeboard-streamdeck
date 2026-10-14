/**
 * Where OpenKneeboard's C API DLL lives.
 *
 * The DLL is the supported way to send to OpenKneeboard: it ships with each release and speaks that
 * release's IPC, which is an implementation detail upstream changes without notice
 * (https://openkneeboard.com/api/c/). So the plugin never names the IPC itself, only this file.
 *
 * The lookup order is the one upstream's own `src/utilities/capi-test.py` uses:
 *
 *   1. `OPENKNEEBOARD_CAPI_DLL`: a full path, taken as-is. An override that points at nothing is a
 *      mistake to report, not a reason to quietly fall through to some other DLL.
 *   2. `HKCU\Software\Fred Emmott\OpenKneeboard` → `InstallationBinPath`, which OpenKneeboard writes
 *      every time it launches (1.8.4+). This is the one that finds a self-built dev install: it
 *      always names whichever build ran last.
 *   3. `%ProgramFiles%\OpenKneeboard\bin`, for an install that has never been launched.
 *
 * Pure, so the order is tested on Linux. The registry read and the existence check are injected by
 * `runtime/capi.ts`.
 */

/** 64-bit only: Stream Deck runs plugins on its own 64-bit Node. */
export const CAPI_DLL = "OpenKneeboard_CAPI64.dll";
export const REGISTRY_KEY = "Software\\Fred Emmott\\OpenKneeboard";
export const REGISTRY_VALUE = "InstallationBinPath";

export interface CapiLookup {
  env: Record<string, string | undefined>;
  /** `InstallationBinPath`, or undefined when the key or value is absent. */
  registryBinPath: () => string | undefined;
  exists: (path: string) => boolean;
}

export type CapiResolution =
  | {
      ok: true;
      path: string;
      source: "env" | "registry" | "program-files";
      /** Set when the registry named a DLL that is gone and Program Files was used instead. That
       * fallback may be an older install speaking an older IPC, so it is worth a line in the log. */
      skipped?: string;
    }
  | { ok: false; reason: string };

/** Join a Windows directory and file name with one backslash, whatever the directory ends with. */
const winJoin = (dir: string, file: string): string => `${dir.replace(/[\\/]+$/, "")}\\${file}`;

export function resolveCapiDll({ env, registryBinPath, exists }: CapiLookup): CapiResolution {
  const override = env.OPENKNEEBOARD_CAPI_DLL;
  if (override) {
    return exists(override)
      ? { ok: true, path: override, source: "env" }
      : { ok: false, reason: `OPENKNEEBOARD_CAPI_DLL names ${override}, which does not exist` };
  }

  let skipped: string | undefined;
  const bin = registryBinPath();
  if (bin) {
    const path = winJoin(bin, CAPI_DLL);
    if (exists(path)) return { ok: true, path, source: "registry" };
    skipped = `${REGISTRY_VALUE} names ${path}, which does not exist`;
  }

  const programFiles = env.ProgramFiles;
  if (programFiles) {
    const path = winJoin(`${programFiles}\\OpenKneeboard\\bin`, CAPI_DLL);
    if (exists(path)) return { ok: true, path, source: "program-files", ...(skipped ? { skipped } : {}) };
  }

  return {
    ok: false,
    reason: `${CAPI_DLL} not found: launch OpenKneeboard once so it records InstallationBinPath, ` +
      "or set OPENKNEEBOARD_CAPI_DLL",
  };
}
