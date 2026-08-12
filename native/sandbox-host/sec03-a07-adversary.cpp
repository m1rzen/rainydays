#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <cstddef>

extern "C" void* __cdecl memset(void* destination, int value, std::size_t count) {
  auto* bytes = static_cast<volatile unsigned char*>(destination);
  for (std::size_t index = 0; index < count; ++index) bytes[index] = static_cast<unsigned char>(value);
  return destination;
}

namespace {

bool InExpectedBoundary() {
  BOOL in_job = FALSE;
  if (!IsProcessInJob(GetCurrentProcess(), nullptr, &in_job) || !in_job) return false;
  HANDLE token = nullptr;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) return false;
  BYTE storage[1024]{};
  DWORD bytes = 0;
  const BOOL queried = GetTokenInformation(token, TokenAppContainerSid, storage, sizeof(storage), &bytes);
  CloseHandle(token);
  if (!queried || bytes > sizeof(storage)) return false;
  auto* information = reinterpret_cast<TOKEN_APPCONTAINER_INFORMATION*>(storage);
  return information->TokenAppContainer && IsValidSid(information->TokenAppContainer);
}

DWORD SpawnProbe(DWORD flags, bool require_contained) {
  wchar_t shell[MAX_PATH]{};
  const UINT count = GetSystemDirectoryW(shell, MAX_PATH);
  if (!count || count >= MAX_PATH - 9) return ERROR_FILE_NOT_FOUND;
  if (lstrcatW(shell, L"\\cmd.exe") == nullptr) return ERROR_BUFFER_OVERFLOW;
  wchar_t command[MAX_PATH * 2]{};
  if (lstrcatW(command, L"\"") == nullptr || lstrcatW(command, shell) == nullptr
      || lstrcatW(command, L"\" /d /c exit 0") == nullptr) return ERROR_BUFFER_OVERFLOW;
  STARTUPINFOW startup{};
  startup.cb = sizeof(startup);
  PROCESS_INFORMATION process{};
  if (!CreateProcessW(shell, command, nullptr, nullptr, FALSE,
      CREATE_SUSPENDED | CREATE_NO_WINDOW | flags, nullptr, nullptr, &startup, &process)) return GetLastError();
  BOOL member = FALSE;
  const BOOL queried = IsProcessInJob(process.hProcess, nullptr, &member);
  const DWORD error = queried ? ERROR_SUCCESS : GetLastError();
  TerminateProcess(process.hProcess, 0);
  CloseHandle(process.hThread);
  CloseHandle(process.hProcess);
  if (!queried) return error;
  return require_contained && !member ? ERROR_ACCESS_DENIED : ERROR_SUCCESS;
}

DWORD NestedJobProbe() {
  HANDLE first = CreateJobObjectW(nullptr, nullptr);
  HANDLE second = CreateJobObjectW(nullptr, nullptr);
  JOBOBJECT_BASIC_UI_RESTRICTIONS restrictions{JOB_OBJECT_UILIMIT_HANDLES};
  DWORD result = ERROR_SUCCESS;
  if (!first || !second
      || !SetInformationJobObject(first, JobObjectBasicUIRestrictions, &restrictions, sizeof(restrictions))
      || !AssignProcessToJobObject(first, GetCurrentProcess())
      || !SetInformationJobObject(second, JobObjectBasicUIRestrictions, &restrictions, sizeof(restrictions))) result = GetLastError();
  else if (!AssignProcessToJobObject(second, GetCurrentProcess())) result = GetLastError();
  if (first) CloseHandle(first);
  if (second) CloseHandle(second);
  return result;
}

bool FinalArgumentIs(const wchar_t* expected) {
  const wchar_t* command = GetCommandLineW();
  if (!command || !expected) return false;
  const wchar_t* end = command + lstrlenW(command);
  while (end > command && (end[-1] == L' ' || end[-1] == L'\t' || end[-1] == L'"')) --end;
  const wchar_t* start = end;
  while (start > command && start[-1] != L' ' && start[-1] != L'\t' && start[-1] != L'"') --start;
  const int expected_length = lstrlenW(expected);
  if (end - start != expected_length) return false;
  for (int index = 0; index < expected_length; ++index) if (start[index] != expected[index]) return false;
  return true;
}

}  // namespace

extern "C" void WINAPI Sec03Entry() {
  if (!InExpectedBoundary()) ExitProcess(91);
  if (FinalArgumentIs(L"explicit")) ExitProcess(SpawnProbe(CREATE_BREAKAWAY_FROM_JOB, false));
  if (FinalArgumentIs(L"silent")) ExitProcess(SpawnProbe(0, true));
  if (FinalArgumentIs(L"nested")) ExitProcess(NestedJobProbe());
  ExitProcess(92);
}
