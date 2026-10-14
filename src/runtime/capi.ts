/**
 * The Windows half: load OpenKneeboard's C API DLL and hand it messages.
 *
 * Until 2026-10-10 this opened `\\.\mailslot\com.openkneeboard.events.v1.3` with CreateFileW and
 * wrote the length-prefixed packet itself. That mailslot and its framing are an unsupported
 * implementation detail: upstream has changed them incompatibly before and expects to rewrite them
 * before v2.0. `OpenKneeboard_send_utf8` is the supported API, and each release's DLL speaks that
 * release's IPC, so the plugin no longer knows the wire format at all.
 *
 * Still koffi: Node cannot call a C export without an FFI, and koffi is already the floor here.
 *
 * The DLL is held for the plugin's life. Windows will not let anything overwrite a loaded DLL, so an
 * OpenKneeboard upgrade while Stream Deck runs fails loudly ("file in use") rather than leaving the
 * plugin speaking an old format. Quit Stream Deck before upgrading or rebuilding OpenKneeboard.
 */

import fs from "node:fs";
import koffi, { type LibraryHandle } from "koffi";

import { CAPI_DLL, resolveCapiDll, REGISTRY_KEY, REGISTRY_VALUE, type CapiResolution } from "../capi-path.ts";
import type { Message } from "../protocol.ts";

// HKEY_CURRENT_USER is ((HKEY)(ULONG_PTR)((LONG)0x80000001)): sign-extended, so on x64 the handle
// is 0xFFFFFFFF80000001, not 0x80000001. Passing it as a signed intptr gets that right.
const HKEY_CURRENT_USER = -0x7fffffff;
const RRF_RT_REG_SZ = 0x00000002;
const ERROR_SUCCESS = 0;
const ERROR_MORE_DATA = 234;

const advapi32 = koffi.load("advapi32.dll");
const RegGetValueW = advapi32.func(
  "long __stdcall RegGetValueW(intptr_t, str16, str16, uint32, void*, void*, _Inout_ uint32*)",
);

function registryBinPath(): string | undefined {
  let data = Buffer.alloc(1024);
  const size = [data.length];
  let status = RegGetValueW(HKEY_CURRENT_USER, REGISTRY_KEY, REGISTRY_VALUE, RRF_RT_REG_SZ, null, data, size);
  if (status === ERROR_MORE_DATA) {
    // On ERROR_MORE_DATA the size holds what the value needs, so one retry at that size reads it.
    data = Buffer.alloc(size[0]!);
    status = RegGetValueW(HKEY_CURRENT_USER, REGISTRY_KEY, REGISTRY_VALUE, RRF_RT_REG_SZ, null, data, size);
  }
  if (status !== ERROR_SUCCESS) return undefined;
  // size counts bytes and includes the terminating NUL.
  return data.subarray(0, size[0]).toString("utf16le").replace(/\0+$/, "") || undefined;
}

export const locateCapi = (): CapiResolution =>
  resolveCapiDll({ env: process.env, registryBinPath, exists: (p) => fs.existsSync(p) });

export interface Sender {
  /**
   * True when the message was handed to OpenKneeboard's DLL; false only when the DLL could not be
   * found or loaded. It is NOT delivery: the DLL returns void and reports a closed OpenKneeboard to
   * ETW tracing only, so a send with OpenKneeboard closed returns true and does nothing.
   *
   * Never throws: a dial tick that cannot reach OpenKneeboard is not worth crashing a plugin the
   * rest of the deck depends on.
   */
  send(message: Message): boolean;
  /** Why the last failed send failed, for the log. Cleared by the next successful load. */
  readonly problem: string | undefined;
  /** Which DLL is loaded and how it was found; undefined until a send has loaded one. */
  readonly loaded: Extract<CapiResolution, { ok: true }> | undefined;
  close(): void;
}

/**
 * Loaded lazily and retried on every send until it loads: OpenKneeboard records its install path when
 * it launches, so on a fresh machine the DLL becomes findable only after OpenKneeboard has run once.
 */
export function createCapiSender(locate: () => CapiResolution = locateCapi): Sender {
  let lib: LibraryHandle | undefined;
  let sendUtf8: ReturnType<LibraryHandle["func"]> | undefined;
  let problem: string | undefined;
  let loaded: Extract<CapiResolution, { ok: true }> | undefined;

  const load = (): boolean => {
    if (sendUtf8) return true;
    // Inside the try too: the registry read is an FFI call, and `send` promises never to throw.
    try {
      const found = locate();
      if (!found.ok) {
        problem = found.reason;
        return false;
      }
      try {
        lib = koffi.load(found.path);
        sendUtf8 = lib.func("void OpenKneeboard_send_utf8(const uint8_t*, size_t, const uint8_t*, size_t)");
      } catch (error) {
        lib = undefined;
        problem = `could not load ${found.path}: ${(error as Error).message}`;
        return false;
      }
      loaded = found;
      problem = undefined;
      return true;
    } catch (error) {
      problem = `could not locate ${CAPI_DLL}: ${(error as Error).message}`;
      return false;
    }
  };

  return {
    send({ name, value }: Message): boolean {
      if (!load()) return false;
      // The counts are BYTES: a tab title with a non-ASCII character is longer in UTF-8 than in JS
      // characters, and the DLL reads exactly the count it is given.
      const nameBytes = Buffer.from(name, "utf8");
      const valueBytes = Buffer.from(value, "utf8");
      try {
        sendUtf8!(nameBytes, nameBytes.length, valueBytes, valueBytes.length);
        return true;
      } catch (error) {
        problem = `OpenKneeboard_send_utf8 threw: ${(error as Error).message}`;
        return false;
      }
    },
    get problem() {
      return problem;
    },
    get loaded() {
      return loaded;
    },
    close(): void {
      try { lib?.unload(); } catch { /* already gone */ }
      lib = undefined;
      sendUtf8 = undefined;
      loaded = undefined;
    },
  };
}
