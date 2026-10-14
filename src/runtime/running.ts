/**
 * Is OpenKneeboard running? Asked only by the profile asserter, never per dial tick.
 *
 * The C API cannot answer this: `OpenKneeboard_send_utf8` returns void and a send to a closed
 * OpenKneeboard looks like one that landed. The executable's name is public, unlike its IPC, so a
 * process-list check is the stand-in until upstream's send reports delivery.
 *
 * `OpenKneeboardApp` is `OUTPUT_NAME` in upstream's `src/app/app-winui3/CMakeLists.txt`.
 *
 * Fails safe: any error answers false, which costs the asserter a redundant switch rather than
 * remembering one that went nowhere.
 */

import koffi from "koffi";

const EXE = "openkneeboardapp.exe";

const TH32CS_SNAPPROCESS = 0x00000002;
const INVALID_HANDLE = 0xffffffffffffffffn;

const PROCESSENTRY32W = koffi.struct("PROCESSENTRY32W", {
  dwSize: "uint32",
  cntUsage: "uint32",
  th32ProcessID: "uint32",
  th32DefaultHeapID: "uintptr_t",
  th32ModuleID: "uint32",
  cntThreads: "uint32",
  th32ParentProcessID: "uint32",
  pcPriClassBase: "int32",
  dwFlags: "uint32",
  szExeFile: koffi.array("char16_t", 260, "String"),
});

const k32 = koffi.load("kernel32.dll");
const CreateToolhelp32Snapshot = k32.func("void* __stdcall CreateToolhelp32Snapshot(uint32, uint32)");
const Process32FirstW = k32.func("bool __stdcall Process32FirstW(void*, _Inout_ PROCESSENTRY32W*)");
const Process32NextW = k32.func("bool __stdcall Process32NextW(void*, _Inout_ PROCESSENTRY32W*)");
const CloseHandle = k32.func("bool __stdcall CloseHandle(void*)");

export function openKneeboardRunning(): boolean {
  try {
    const snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    const address = koffi.address(snapshot);
    if (address === 0n || address === INVALID_HANDLE) return false;
    try {
      const entry = { dwSize: koffi.sizeof(PROCESSENTRY32W) } as { dwSize: number; szExeFile?: string };
      for (let ok = Process32FirstW(snapshot, entry); ok; ok = Process32NextW(snapshot, entry)) {
        if (entry.szExeFile?.toLowerCase() === EXE) return true;
      }
      return false;
    } finally {
      CloseHandle(snapshot);
    }
  } catch {
    return false;
  }
}
