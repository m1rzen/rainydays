#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <userenv.h>
#include <aclapi.h>
#include <sddl.h>

#include <algorithm>
#include <array>
#include <atomic>
#include <cctype>
#include <cstdint>
#include <cstring>
#include <cwctype>
#include <map>
#include <memory>
#include <mutex>
#include <set>
#include <string>
#include <thread>
#include <vector>

#include "protocol.h"
#include "journal.h"
#include "attestation.h"

#pragma comment(lib, "advapi32.lib")
#pragma comment(lib, "crypt32.lib")
#pragma comment(lib, "userenv.lib")
#pragma comment(lib, "shell32.lib")
#pragma comment(lib, "ole32.lib")

namespace {
bool g_fixed_acl_conflict = false;
std::string g_fixed_acl_crash_variant;
void FixedAclCrash(const char* stage) { if (g_fixed_acl_crash_variant == "A14-01" && !strcmp(stage, "prepared")) TerminateProcess(GetCurrentProcess(), 0xE3A1); if (g_fixed_acl_crash_variant == "A14-02" && !strcmp(stage, "applied")) TerminateProcess(GetCurrentProcess(), 0xE3A2); }
bool FixedAclConflictBarrier(const std::wstring& root) {
  if (!g_fixed_acl_conflict) return true; const std::wstring marker = root + L"\\.sec03-a14-conflict-ready", release = root + L"\\.sec03-a14-conflict-release";
  if (GetFileAttributesW(marker.c_str()) != INVALID_FILE_ATTRIBUTES || GetFileAttributesW(release.c_str()) != INVALID_FILE_ATTRIBUTES) return false;
  HANDLE file = CreateFileW(marker.c_str(), GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr); if (file == INVALID_HANDLE_VALUE) return false; CloseHandle(file);
  bool released = false; for (unsigned i = 0; i < 3000; ++i) { if (GetFileAttributesW(release.c_str()) != INVALID_FILE_ATTRIBUTES) { released = true; break; } Sleep(10); }
  return released && DeleteFileW(marker.c_str()) && DeleteFileW(release.c_str());
}
#ifdef MINI_LUX_SEC03_NATIVE_TEST
std::string g_test_crash;
void TestCrash(const char* stage) { FixedAclCrash(stage); if (g_test_crash == stage) TerminateProcess(GetCurrentProcess(), 0xE3A0); if (g_test_crash == std::string("hold-") + stage) Sleep(INFINITE); }
bool TestPreparedBarrier(const std::wstring& root) {
  if (!FixedAclConflictBarrier(root)) return false;
  if (g_test_crash != "barrier-prepared-hold-applied") return true; const std::wstring marker = root + L"\\.sec03-j5-prepared", release = root + L"\\.sec03-j5-release";
  HANDLE file = CreateFileW(marker.c_str(), GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr); if (file == INVALID_HANDLE_VALUE) return false; CloseHandle(file);
  bool released = false; for (unsigned i = 0; i < 1000; ++i) { if (GetFileAttributesW(release.c_str()) != INVALID_FILE_ATTRIBUTES) { released = true; break; } Sleep(10); }
  const bool cleaned = DeleteFileW(marker.c_str()) && DeleteFileW(release.c_str()); if (!released || !cleaned) return false; g_test_crash = "hold-applied"; return true;
}
#else
void TestCrash(const char* stage) { FixedAclCrash(stage); }
bool TestPreparedBarrier(const std::wstring& root) { return FixedAclConflictBarrier(root); }
#endif
struct Json {
  enum class Kind { null_value, boolean, number, string, array, object } kind = Kind::null_value;
  bool boolean = false;
  std::string scalar;
  std::vector<Json> array;
  std::map<std::string, Json> object;
};

class Parser {
 public:
  explicit Parser(const std::string& text) : text_(text) {}
  bool Parse(Json* result) { if (!Utf8()) { error_ = "utf8"; return false; } return Value(result, 0) && pos_ == text_.size(); }
  const std::string& error() const { return error_; }
 private:
  bool Utf8() const { return !text_.empty() && MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text_.data(), static_cast<int>(text_.size()), nullptr, 0) > 0; }
  bool Value(Json* out, unsigned depth) {
    if (depth > 20 || pos_ >= text_.size()) return false;
    const char c = text_[pos_];
    if (c == '{') return Object(out, depth + 1);
    if (c == '[') return Array(out, depth + 1);
    if (c == '"') { out->kind = Json::Kind::string; return String(&out->scalar); }
    if (Take("true")) { out->kind = Json::Kind::boolean; out->boolean = true; return true; }
    if (Take("false")) { out->kind = Json::Kind::boolean; return true; }
    if (Take("null")) { out->kind = Json::Kind::null_value; return true; }
    return Number(out);
  }
  bool Take(const char* text) { const size_t n = strlen(text); if (text_.compare(pos_, n, text)) return false; pos_ += n; return true; }
  bool String(std::string* out) {
    if (text_[pos_++] != '"') return false;
    while (pos_ < text_.size()) {
      unsigned char c = static_cast<unsigned char>(text_[pos_++]);
      if (c == '"') return true;
      if (c < 0x20) return false;
      if (c != '\\') { out->push_back(static_cast<char>(c)); continue; }
      if (pos_ >= text_.size()) return false;
      const char e = text_[pos_++];
      if (e == '"' || e == '\\' || e == '/') out->push_back(e);
      else if (e == 'b') out->push_back('\b'); else if (e == 'f') out->push_back('\f'); else if (e == 'n') out->push_back('\n'); else if (e == 'r') out->push_back('\r'); else if (e == 't') out->push_back('\t');
      else if (e == 'u') { if (pos_ + 4 > text_.size()) return false; out->append(text_, pos_ - 2, 6); pos_ += 4; }
      else return false;
    }
    return false;
  }
  bool Number(Json* out) {
    const size_t start = pos_; if (pos_ < text_.size() && text_[pos_] == '-') ++pos_;
    if (pos_ >= text_.size() || text_[pos_] < '0' || text_[pos_] > '9') return false;
    while (pos_ < text_.size() && text_[pos_] >= '0' && text_[pos_] <= '9') ++pos_;
    if (pos_ < text_.size() && (text_[pos_] == '.' || text_[pos_] == 'e' || text_[pos_] == 'E')) return false;
    out->kind = Json::Kind::number; out->scalar.assign(text_, start, pos_ - start); return true;
  }
  bool Array(Json* out, unsigned depth) {
    out->kind = Json::Kind::array; ++pos_; if (pos_ < text_.size() && text_[pos_] == ']') { ++pos_; return true; }
    for (;;) { Json value; if (!Value(&value, depth)) return false; out->array.push_back(std::move(value)); if (pos_ >= text_.size()) return false; if (text_[pos_] == ']') { ++pos_; return true; } if (text_[pos_++] != ',') return false; }
  }
  bool Object(Json* out, unsigned depth) {
    out->kind = Json::Kind::object; ++pos_; if (pos_ < text_.size() && text_[pos_] == '}') { ++pos_; return true; }
    for (;;) { if (pos_ >= text_.size() || text_[pos_] != '"') return false; std::string key; if (!String(&key) || pos_ >= text_.size() || text_[pos_++] != ':') return false; if (out->object.count(key)) { error_ = "duplicate-key"; return false; } Json value; if (!Value(&value, depth)) return false; out->object.emplace(std::move(key), std::move(value)); if (pos_ >= text_.size()) return false; if (text_[pos_] == '}') { ++pos_; return true; } if (text_[pos_++] != ',') return false; }
  }
  const std::string& text_; size_t pos_ = 0; std::string error_;
};

struct Handle { HANDLE value = INVALID_HANDLE_VALUE; Handle() = default; explicit Handle(HANDLE h) : value(h) {} ~Handle() { if (value && value != INVALID_HANDLE_VALUE) CloseHandle(value); } Handle(const Handle&) = delete; Handle& operator=(const Handle&) = delete; Handle(Handle&& other) noexcept : value(other.release()) {} Handle& operator=(Handle&& other) noexcept { if (this != &other) { if (value && value != INVALID_HANDLE_VALUE) CloseHandle(value); value = other.release(); } return *this; } HANDLE release() { HANDLE h = value; value = INVALID_HANDLE_VALUE; return h; } };
using CompareObjectHandlesFn = BOOL(WINAPI*)(HANDLE, HANDLE);
bool ObserveUnlistedSentinel(HANDLE process, HANDLE sentinel, DWORD* probe_error, bool* observed) {
  *probe_error = ERROR_SUCCESS; *observed = false; Handle duplicate;
  if (!DuplicateHandle(process, sentinel, GetCurrentProcess(), &duplicate.value, 0, FALSE, DUPLICATE_SAME_ACCESS)) { *probe_error = GetLastError(); return *probe_error == ERROR_INVALID_HANDLE; }
  HMODULE kernelbase = GetModuleHandleW(L"kernelbase.dll"); FARPROC raw_compare = kernelbase ? GetProcAddress(kernelbase, "CompareObjectHandles") : nullptr; CompareObjectHandlesFn compare = nullptr;
  static_assert(sizeof(compare) == sizeof(raw_compare)); memcpy(&compare, &raw_compare, sizeof(compare));
  if (!compare) { *probe_error = ERROR_CALL_NOT_IMPLEMENTED; return false; }
  *observed = compare(sentinel, duplicate.value) != FALSE; return true;
}
bool ReadExact(HANDLE handle, void* buffer, DWORD bytes) { auto* p = static_cast<unsigned char*>(buffer); while (bytes) { DWORD n = 0; if (!ReadFile(handle, p, bytes, &n, nullptr) || !n) return false; p += n; bytes -= n; } return true; }
bool WriteExact(HANDLE handle, const void* buffer, DWORD bytes) { const auto* p = static_cast<const unsigned char*>(buffer); while (bytes) { DWORD n = 0; if (!WriteFile(handle, p, bytes, &n, nullptr) || !n) return false; p += n; bytes -= n; } return true; }

enum class FrameReadResult { ok, channel_lost, length, oversize };
FrameReadResult ReadFrame(std::string* payload) {
  unsigned char h[4]{}; DWORD received = 0;
  while (received < sizeof(h)) {
    DWORD count = 0;
    if (!ReadFile(GetStdHandle(STD_INPUT_HANDLE), h + received, static_cast<DWORD>(sizeof(h)) - received, &count, nullptr) || !count) return received == 0 ? FrameReadResult::channel_lost : FrameReadResult::length;
    received += count;
  }
  const uint32_t n = (static_cast<uint32_t>(h[0]) << 24) | (static_cast<uint32_t>(h[1]) << 16) | (static_cast<uint32_t>(h[2]) << 8) | h[3];
  if (!n) return FrameReadResult::length;
  if (n > mini_lux::sec03::kMaxControlFrame) return FrameReadResult::oversize;
  payload->resize(n); return ReadExact(GetStdHandle(STD_INPUT_HANDLE), payload->data(), n) ? FrameReadResult::ok : FrameReadResult::length;
}

std::string Base64(const unsigned char* data, size_t size) {
  static constexpr char table[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"; std::string out; out.reserve((size + 2) / 3 * 4);
  for (size_t i = 0; i < size; i += 3) { const uint32_t v = (static_cast<uint32_t>(data[i]) << 16) | (i + 1 < size ? static_cast<uint32_t>(data[i + 1]) << 8 : 0) | (i + 2 < size ? data[i + 2] : 0); out.push_back(table[(v >> 18) & 63]); out.push_back(table[(v >> 12) & 63]); out.push_back(i + 1 < size ? table[(v >> 6) & 63] : '='); out.push_back(i + 2 < size ? table[v & 63] : '='); }
  return out;
}

bool DecodeBase64(const std::string& input, std::vector<unsigned char>* out) {
  if (input.size() % 4) return false; auto value = [](char c) -> int { if (c >= 'A' && c <= 'Z') return c - 'A'; if (c >= 'a' && c <= 'z') return c - 'a' + 26; if (c >= '0' && c <= '9') return c - '0' + 52; if (c == '+') return 62; if (c == '/') return 63; return -1; };
  for (size_t i = 0; i < input.size(); i += 4) { const int a = value(input[i]), b = value(input[i + 1]); const int c = input[i + 2] == '=' ? -2 : value(input[i + 2]); const int d = input[i + 3] == '=' ? -2 : value(input[i + 3]); if (a < 0 || b < 0 || c == -1 || d == -1 || (c == -2 && d != -2)) return false; const uint32_t v = (a << 18) | (b << 12) | ((c < 0 ? 0 : c) << 6) | (d < 0 ? 0 : d); out->push_back(static_cast<unsigned char>(v >> 16)); if (c >= 0) out->push_back(static_cast<unsigned char>(v >> 8)); if (d >= 0) out->push_back(static_cast<unsigned char>(v)); }
  return true;
}

std::mutex g_output_mutex;
bool Output(const char* stream, const unsigned char* data, size_t size) {
  const std::string body = std::string("{\"version\":1,\"stream\":\"") + stream + "\",\"data\":\"" + Base64(data, size) + "\"}"; const uint32_t n = static_cast<uint32_t>(body.size());
  unsigned char h[4] = {static_cast<unsigned char>(n >> 24), static_cast<unsigned char>(n >> 16), static_cast<unsigned char>(n >> 8), static_cast<unsigned char>(n)};
  std::lock_guard<std::mutex> lock(g_output_mutex);
  return WriteExact(GetStdHandle(STD_OUTPUT_HANDLE), h, 4) && WriteExact(GetStdHandle(STD_OUTPUT_HANDLE), body.data(), n);
}

void Failure(const char* code) { Output("stderr", reinterpret_cast<const unsigned char*>(code), strlen(code)); }
const Json* Field(const Json& object, const char* key, Json::Kind kind) { const auto it = object.object.find(key); return it != object.object.end() && it->second.kind == kind ? &it->second : nullptr; }
bool ExactLaunchKeys(const Json& request) {
  const bool fixed = request.object.count("fixedAdversary") || request.object.count("fixedStateMac");
#ifdef MINI_LUX_SEC03_NATIVE_TEST
  static const std::array<const char*, 29> keys = {"authorityEpoch","buildIdSha256","candidateId","contextId","entryPoint","environment","executable","executableHandle","executionId","expiresAtMs","hostSha256","launcherSha256","limits","network","payload","payloadDigest","personaDigest","policyDigest","principal","profile","rootHandles","roots","runId","secret","sessionId","sourceSha256","testCrash","type","v"};
  static const std::array<const char*, 31> fixed_keys = {"authorityEpoch","buildIdSha256","candidateId","contextId","entryPoint","environment","executable","executableHandle","executionId","expiresAtMs","fixedAdversary","fixedStateMac","hostSha256","launcherSha256","limits","network","payload","payloadDigest","personaDigest","policyDigest","principal","profile","rootHandles","roots","runId","secret","sessionId","sourceSha256","testCrash","type","v"};
#else
  static const std::array<const char*, 28> keys = {"authorityEpoch","buildIdSha256","candidateId","contextId","entryPoint","environment","executable","executableHandle","executionId","expiresAtMs","hostSha256","launcherSha256","limits","network","payload","payloadDigest","personaDigest","policyDigest","principal","profile","rootHandles","roots","runId","secret","sessionId","sourceSha256","type","v"};
  static const std::array<const char*, 30> fixed_keys = {"authorityEpoch","buildIdSha256","candidateId","contextId","entryPoint","environment","executable","executableHandle","executionId","expiresAtMs","fixedAdversary","fixedStateMac","hostSha256","launcherSha256","limits","network","payload","payloadDigest","personaDigest","policyDigest","principal","profile","rootHandles","roots","runId","secret","sessionId","sourceSha256","type","v"};
#endif
  if (fixed) return request.object.size() == fixed_keys.size() && std::all_of(fixed_keys.begin(), fixed_keys.end(), [&](const char* key) { return request.object.count(key) == 1; });
  return request.object.size() == keys.size() && std::all_of(keys.begin(), keys.end(), [&](const char* key) { return request.object.count(key) == 1; });
}
std::wstring Wide(const std::string& text) { const int n = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text.data(), static_cast<int>(text.size()), nullptr, 0); if (n <= 0) return {}; std::wstring result(n, L'\0'); MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text.data(), static_cast<int>(text.size()), result.data(), n); return result; }
std::string Utf8(const std::wstring& text) { const int n = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, text.data(), static_cast<int>(text.size()), nullptr, 0, nullptr, nullptr); if (n <= 0) return {}; std::string result(n, '\0'); return WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, text.data(), static_cast<int>(text.size()), result.data(), n, nullptr, nullptr) == n ? result : std::string{}; }

bool AllowedEnvironment(const std::string& key) {
  static const std::vector<std::string> fixed = {"APPDATA","ComSpec","ELECTRON_RUN_AS_NODE","HOME","LOCALAPPDATA","MINI_LUX_SANDBOX_ID","MINI_LUX_SESSION_ID","NODE_DISABLE_COLORS","NUMBER_OF_PROCESSORS","OS","PATH","PATHEXT","PROCESSOR_ARCHITECTURE","SystemRoot","TEMP","TMP","USERPROFILE","WINDIR"};
  if (std::find(fixed.begin(), fixed.end(), key) != fixed.end()) return true;
  if (key.rfind("MINI_LUX_ROOT_", 0) != 0 || key.size() <= 14) return false; return std::all_of(key.begin() + 14, key.end(), [](char c) { return c >= '0' && c <= '9'; });
}

bool NativeRuntimePaths(const Json& environment, bool is_e3, std::wstring* windows, std::wstring* system32) {
  std::array<wchar_t, MAX_PATH> windows_buffer{}, system_buffer{}; const UINT windows_count = GetWindowsDirectoryW(windows_buffer.data(), static_cast<UINT>(windows_buffer.size())); const UINT system_count = GetSystemDirectoryW(system_buffer.data(), static_cast<UINT>(system_buffer.size()));
  if (!windows_count || windows_count >= windows_buffer.size() || !system_count || system_count >= system_buffer.size()) return false; windows->assign(windows_buffer.data(), windows_count); system32->assign(system_buffer.data(), system_count);
  auto same = [&](const char* key, const std::wstring& expected) { const Json* value = Field(environment, key, Json::Kind::string); const std::wstring observed = value ? Wide(value->scalar) : std::wstring{}; return !observed.empty() && _wcsicmp(observed.c_str(), expected.c_str()) == 0; };
  if (!same("SystemRoot", *windows) || !same("WINDIR", *windows) || !same("PATH", *system32)) return false;
  const std::wstring command = *system32 + L"\\cmd.exe"; return is_e3 ? environment.object.count("ComSpec") == 0 : same("ComSpec", command);
}

bool BuildEnvironment(const Json& value, std::vector<wchar_t>* block) {
  if (value.kind != Json::Kind::object) return false; std::vector<std::string> normalized;
  for (const auto& [key, item] : value.object) { std::string upper = key; std::transform(upper.begin(), upper.end(), upper.begin(), [](unsigned char c) { return static_cast<char>(toupper(c)); }); if (std::find(normalized.begin(), normalized.end(), upper) != normalized.end()) return false; normalized.push_back(upper); if (!AllowedEnvironment(key) || item.kind != Json::Kind::string || key.find('=') != std::string::npos || item.scalar.find('\0') != std::string::npos) return false; const std::wstring pair = Wide(key + "=" + item.scalar); if (pair.empty()) return false; block->insert(block->end(), pair.begin(), pair.end()); block->push_back(L'\0'); }
  block->push_back(L'\0'); return true;
}

bool ProcessCurrentDirectory(const std::wstring& handle_path, std::wstring* output) {
  if (handle_path.size() < 7 || handle_path.rfind(L"\\\\?\\", 0) != 0 || handle_path[5] != L':' || handle_path[6] != L'\\') return false;
  const wchar_t drive = handle_path[4]; if (!((drive >= L'A' && drive <= L'Z') || (drive >= L'a' && drive <= L'z'))) return false;
  output->assign(handle_path.begin() + 4, handle_path.end()); return output->size() < 32767;
}

uint64_t FileId(const BY_HANDLE_FILE_INFORMATION& value) { return (static_cast<uint64_t>(value.nFileIndexHigh) << 32) | value.nFileIndexLow; }
bool ParseUnsigned(const std::string& text, uint64_t* out) { if (text.empty() || !std::all_of(text.begin(), text.end(), [](char c) { return c >= '0' && c <= '9'; })) return false; char* end = nullptr; const auto value = _strtoui64(text.c_str(), &end, 10); if (!end || *end) return false; *out = value; return true; }
bool ExactKeys(const Json& value, std::initializer_list<const char*> keys) { if (value.kind != Json::Kind::object || value.object.size() != keys.size()) return false; return std::all_of(keys.begin(), keys.end(), [&](const char* key) { return value.object.count(key) == 1; }); }

struct DescendantLease {
  Handle handle; BY_HANDLE_FILE_INFORMATION identity{}; bool directory = false; bool eligible = false; std::string acl_digest;
};
enum class RootPreflightFailure { none, acl_protected, acl_sharing, acl_conflict };
struct RootGrant {
  Handle handle; Handle cwd_handle; BY_HANDLE_FILE_INFORMATION identity{}; BY_HANDLE_FILE_INFORMATION cwd_identity{}; int stage = 0; unsigned acl_mutations = 0; RootPreflightFailure preflight_failure = RootPreflightFailure::none; PSECURITY_DESCRIPTOR original_descriptor = nullptr; std::vector<unsigned char> exact_ace; std::vector<DescendantLease> descendants; std::wstring path; std::wstring cwd_path; std::wstring journal_prefix; mini_lux::sec03::JournalDirectoryLease journal_directory; mini_lux::sec03::JournalRecord journal;
  ~RootGrant() { if (original_descriptor) ::LocalFree(original_descriptor); }
};
struct FixedImageGrant {
  HANDLE handle = INVALID_HANDLE_VALUE; BY_HANDLE_FILE_INFORMATION identity{}; int stage = 0; unsigned acl_mutations = 0; PSECURITY_DESCRIPTOR original_descriptor = nullptr; std::vector<unsigned char> exact_ace; std::wstring path; std::wstring journal_prefix; mini_lux::sec03::JournalDirectoryLease journal_directory; mini_lux::sec03::JournalRecord journal;
  ~FixedImageGrant() { if (original_descriptor) ::LocalFree(original_descriptor); }
};

template <typename Grant> bool NewJournalPrefix(Grant* grant) {
  if (!mini_lux::sec03::JournalDirectory(&grant->journal_directory)) return false; GUID guid{}; if (CoCreateGuid(&guid) != S_OK) return false; wchar_t text[64]{}; if (!StringFromGUID2(guid, text, 64)) return false; std::wstring id; for (wchar_t c : std::wstring(text)) if ((c >= L'0' && c <= L'9') || (c >= L'a' && c <= L'f') || (c >= L'A' && c <= L'F')) id.push_back(static_cast<wchar_t>(towlower(c))); grant->journal_prefix = grant->journal_directory.path + L"\\txn-" + id; return id.size() == 32;
}
template <typename Grant> bool AdvanceJournal(Grant* grant, const char* state) { grant->journal.state = state; ++grant->journal.generation; return mini_lux::sec03::AtomicJournalWrite(grant->journal_directory, grant->journal_prefix, grant->journal); }
bool DeleteIfPresent(const std::wstring& path) { if (DeleteFileW(path.c_str())) return true; return GetLastError() == ERROR_FILE_NOT_FOUND; }
template <typename Grant> bool DeleteJournals(const Grant& grant) {
  wchar_t suffix[32]{}; swprintf_s(suffix, L".%04u.tmp", grant.journal.generation + 1); if (!DeleteIfPresent(grant.journal_prefix + suffix)) return false;
  for (unsigned i = grant.journal.generation; i > 0; --i) { swprintf_s(suffix, L".%04u.jrn", i); if (!DeleteIfPresent(grant.journal_prefix + suffix)) return false; if (i == grant.journal.generation) TestCrash("journal-delete-newest"); }
  return true;
}

bool SameFile(HANDLE handle, const BY_HANDLE_FILE_INFORMATION& expected) {
  BY_HANDLE_FILE_INFORMATION now{}; return GetFileInformationByHandle(handle, &now) && now.dwVolumeSerialNumber == expected.dwVolumeSerialNumber && now.nFileIndexHigh == expected.nFileIndexHigh && now.nFileIndexLow == expected.nFileIndexLow;
}

DWORD ReplacementOpenResult(const std::wstring& path) {
  HANDLE probe = CreateFileW(path.c_str(), DELETE | FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
  if (probe != INVALID_HANDLE_VALUE) { CloseHandle(probe); return ERROR_SUCCESS; }
  return GetLastError();
}

bool SamePathMapping(const std::wstring& path, const BY_HANDLE_FILE_INFORMATION& expected) {
  Handle probe(CreateFileW(path.c_str(), FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
  BY_HANDLE_FILE_INFORMATION observed{}; std::vector<wchar_t> final_path(32768);
  const DWORD count = probe.value != INVALID_HANDLE_VALUE ? GetFinalPathNameByHandleW(probe.value, final_path.data(), static_cast<DWORD>(final_path.size()), FILE_NAME_NORMALIZED | VOLUME_NAME_DOS) : 0;
  return probe.value != INVALID_HANDLE_VALUE && GetFileInformationByHandle(probe.value, &observed) && (observed.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) && !(observed.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT)
    && observed.dwVolumeSerialNumber == expected.dwVolumeSerialNumber && FileId(observed) == FileId(expected) && count && count < final_path.size() && _wcsicmp(path.c_str(), final_path.data()) == 0;
}

bool CopyAclWithChange(PACL source, const std::vector<unsigned char>* append, const std::vector<unsigned char>* remove, std::vector<unsigned char>* storage) {
  DWORD bytes = sizeof(ACL) + (append ? static_cast<DWORD>(append->size()) : 0); unsigned removed = 0;
  for (DWORD i = 0; i < source->AceCount; ++i) { void* ace = nullptr; if (!GetAce(source, i, &ace)) return false; auto* header = static_cast<ACE_HEADER*>(ace); const bool match = remove && header->AceSize == remove->size() && memcmp(ace, remove->data(), remove->size()) == 0; if (match) { ++removed; continue; } bytes += header->AceSize; }
  if (remove && removed != 1) return false;
  storage->assign(bytes, 0); auto* target = reinterpret_cast<PACL>(storage->data()); const DWORD revision = source->AclRevision; if (!InitializeAcl(target, bytes, revision)) return false;
  for (DWORD i = 0; i < source->AceCount; ++i) { void* ace = nullptr; GetAce(source, i, &ace); auto* header = static_cast<ACE_HEADER*>(ace); if (remove && header->AceSize == remove->size() && memcmp(ace, remove->data(), remove->size()) == 0) continue; if (!AddAce(target, revision, MAXDWORD, ace, header->AceSize)) return false; }
  return !append || AddAce(target, revision, MAXDWORD, const_cast<unsigned char*>(append->data()), static_cast<DWORD>(append->size()));
}

bool ReadDacl(HANDLE handle, PACL* acl, PSECURITY_DESCRIPTOR* descriptor) { return GetSecurityInfo(handle, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, nullptr, nullptr, acl, nullptr, descriptor) == ERROR_SUCCESS && *acl; }
bool SameAcl(PACL left, PACL right) { return left && right && left->AclSize == right->AclSize && memcmp(left, right, left->AclSize) == 0; }
bool SameAceSequence(PACL left, PACL right) {
  if (!left || !right || left->AceCount != right->AceCount) return false;
  for (DWORD i = 0; i < left->AceCount; ++i) { void* a = nullptr; void* b = nullptr; if (!GetAce(left, i, &a) || !GetAce(right, i, &b)) return false; const auto* ah = static_cast<ACE_HEADER*>(a); const auto* bh = static_cast<ACE_HEADER*>(b); if (ah->AceSize != bh->AceSize || memcmp(a, b, ah->AceSize) != 0) return false; }
  return true;
}
unsigned ExactAceCount(PACL acl, const std::vector<unsigned char>& exact) { unsigned count = 0; for (DWORD i = 0; acl && i < acl->AceCount; ++i) { void* ace = nullptr; if (!GetAce(acl, i, &ace)) return UINT_MAX; const auto* header = static_cast<ACE_HEADER*>(ace); if (header->AceSize == exact.size() && memcmp(ace, exact.data(), exact.size()) == 0) ++count; } return count; }
bool VerifyApplied(PACL original, PACL observed, const std::vector<unsigned char>& exact) {
  if (!original || !observed || observed->AceCount != original->AceCount + 1) return false;
  DWORD source_index = 0; unsigned matches = 0;
  for (DWORD i = 0; i < observed->AceCount; ++i) { void* ace = nullptr; if (!GetAce(observed, i, &ace)) return false; const auto* header = static_cast<ACE_HEADER*>(ace); if (header->AceSize == exact.size() && memcmp(ace, exact.data(), exact.size()) == 0) { ++matches; continue; } if (source_index >= original->AceCount) return false; void* source = nullptr; if (!GetAce(original, source_index++, &source)) return false; const auto* source_header = static_cast<ACE_HEADER*>(source); if (header->AceSize != source_header->AceSize || memcmp(ace, source, header->AceSize) != 0) return false; }
  return matches == 1 && source_index == original->AceCount;
}

struct TreeEntry { std::wstring path; BY_HANDLE_FILE_INFORMATION identity{}; bool directory = false; };
struct FindHandle { HANDLE value = INVALID_HANDLE_VALUE; ~FindHandle() { if (value != INVALID_HANDLE_VALUE) FindClose(value); } };

bool SidFromAce(const ACE_HEADER* header, PSID* sid) {
  *sid = nullptr; if (!header || header->AceSize < sizeof(ACE_HEADER)) return false; size_t offset = 0;
  switch (header->AceType) {
    case ACCESS_ALLOWED_ACE_TYPE: case ACCESS_DENIED_ACE_TYPE: case SYSTEM_AUDIT_ACE_TYPE: case SYSTEM_ALARM_ACE_TYPE:
    case ACCESS_ALLOWED_CALLBACK_ACE_TYPE: case ACCESS_DENIED_CALLBACK_ACE_TYPE: case SYSTEM_AUDIT_CALLBACK_ACE_TYPE: case SYSTEM_ALARM_CALLBACK_ACE_TYPE:
    case SYSTEM_MANDATORY_LABEL_ACE_TYPE: case SYSTEM_RESOURCE_ATTRIBUTE_ACE_TYPE: case SYSTEM_SCOPED_POLICY_ID_ACE_TYPE:
    case SYSTEM_PROCESS_TRUST_LABEL_ACE_TYPE: case SYSTEM_ACCESS_FILTER_ACE_TYPE:
      offset = sizeof(ACE_HEADER) + sizeof(ACCESS_MASK); break;
    case ACCESS_ALLOWED_OBJECT_ACE_TYPE: case ACCESS_DENIED_OBJECT_ACE_TYPE: case SYSTEM_AUDIT_OBJECT_ACE_TYPE: case SYSTEM_ALARM_OBJECT_ACE_TYPE:
    case ACCESS_ALLOWED_CALLBACK_OBJECT_ACE_TYPE: case ACCESS_DENIED_CALLBACK_OBJECT_ACE_TYPE: case SYSTEM_AUDIT_CALLBACK_OBJECT_ACE_TYPE: case SYSTEM_ALARM_CALLBACK_OBJECT_ACE_TYPE: {
      offset = sizeof(ACE_HEADER) + sizeof(ACCESS_MASK) + sizeof(DWORD); if (header->AceSize < offset) return false; DWORD flags = 0; memcpy(&flags, reinterpret_cast<const unsigned char*>(header) + sizeof(ACE_HEADER) + sizeof(ACCESS_MASK), sizeof(flags));
      if (flags & ACE_OBJECT_TYPE_PRESENT) offset += sizeof(GUID); if (flags & ACE_INHERITED_OBJECT_TYPE_PRESENT) offset += sizeof(GUID); break;
    }
    default: return true;
  }
  if (offset >= header->AceSize) return false; auto* candidate = const_cast<unsigned char*>(reinterpret_cast<const unsigned char*>(header) + offset);
  if (!IsValidSid(candidate)) return false; const DWORD bytes = GetLengthSid(candidate); if (bytes > header->AceSize - offset) return false; *sid = candidate; return true;
}

bool ExpectedAllowAce(const ACE_HEADER* header, PSID sid, DWORD mask, BYTE explicit_flags, bool inherited_allowed) {
  if (!header || header->AceType != ACCESS_ALLOWED_ACE_TYPE || header->AceSize != sizeof(ACCESS_ALLOWED_ACE) - sizeof(DWORD) + GetLengthSid(sid)) return false;
  const auto* ace = reinterpret_cast<const ACCESS_ALLOWED_ACE*>(header); const bool flags = header->AceFlags == explicit_flags || (inherited_allowed && header->AceFlags == static_cast<BYTE>(explicit_flags | INHERITED_ACE));
  return flags && ace->Mask == mask && EqualSid(const_cast<DWORD*>(&ace->SidStart), sid);
}

bool InspectSidAcl(PACL acl, PSID sid, DWORD mask, BYTE explicit_flags, bool inherited_allowed, unsigned* expected, bool* unexpected) {
  *expected = 0; *unexpected = false; if (!acl || !sid || !IsValidSid(sid)) return false;
  for (DWORD i = 0; i < acl->AceCount; ++i) { void* raw = nullptr; if (!GetAce(acl, i, &raw)) return false; const auto* header = static_cast<ACE_HEADER*>(raw); PSID ace_sid = nullptr; if (!SidFromAce(header, &ace_sid)) return false; if (!ace_sid || !EqualSid(ace_sid, sid)) continue; if (ExpectedAllowAce(header, sid, mask, explicit_flags, inherited_allowed)) ++*expected; else *unexpected = true; }
  return true;
}

bool VerifyInheritedApplied(PACL original, PACL observed, PSID sid, DWORD mask, BYTE flags) {
  if (!original || !observed || observed->AceCount != original->AceCount + 1) return false; DWORD source_index = 0; unsigned matches = 0;
  for (DWORD i = 0; i < observed->AceCount; ++i) { void* raw = nullptr; if (!GetAce(observed, i, &raw)) return false; const auto* header = static_cast<ACE_HEADER*>(raw); if (ExpectedAllowAce(header, sid, mask, static_cast<BYTE>(flags | INHERITED_ACE), false)) { ++matches; continue; } if (source_index >= original->AceCount) return false; void* source = nullptr; if (!GetAce(original, source_index++, &source)) return false; const auto* source_header = static_cast<ACE_HEADER*>(source); if (header->AceSize != source_header->AceSize || memcmp(raw, source, header->AceSize) != 0) return false; }
  return matches == 1 && source_index == original->AceCount;
}

bool UnprotectedDescriptor(PSECURITY_DESCRIPTOR descriptor) {
  SECURITY_DESCRIPTOR_CONTROL control{}; DWORD revision = 0; return descriptor && GetSecurityDescriptorControl(descriptor, &control, &revision) && !(control & SE_DACL_PROTECTED);
}

bool ReadPreflightAcl(HANDLE handle, const BY_HANDLE_FILE_INFORMATION& identity, PSID sid, DWORD mask, bool directory, std::string* digest, bool* protected_acl = nullptr) {
  if (protected_acl) *protected_acl = false;
  PACL acl = nullptr; PSECURITY_DESCRIPTOR descriptor = nullptr; if (!ReadDacl(handle, &acl, &descriptor)) return false; unsigned matches = 0; bool unexpected = false; const BYTE flags = directory ? CONTAINER_INHERIT_ACE | OBJECT_INHERIT_ACE : 0;
  const bool unprotected = UnprotectedDescriptor(descriptor); if (protected_acl) *protected_acl = !unprotected;
  const bool ok = unprotected && InspectSidAcl(acl, sid, mask, flags, true, &matches, &unexpected) && matches == 0 && !unexpected && SameFile(handle, identity) && mini_lux::sec03::AclSequenceDigest(acl, digest); LocalFree(descriptor); return ok;
}

bool PreflightRootDescendants(RootGrant* grant, PSID sid, DWORD mask) {
  try {
    std::vector<TreeEntry> pending; pending.push_back({grant->path, grant->identity, true});
    while (!pending.empty()) {
      TreeEntry parent = std::move(pending.back()); pending.pop_back(); grant->stage = 581; Handle directory(CreateFileW(parent.path.c_str(), FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr)); if (directory.value == INVALID_HANDLE_VALUE || !SameFile(directory.value, parent.identity)) return false;
      grant->stage = 582; WIN32_FIND_DATAW data{}; FindHandle search; search.value = FindFirstFileExW((parent.path + L"\\*").c_str(), FindExInfoBasic, &data, FindExSearchNameMatch, nullptr, FIND_FIRST_EX_LARGE_FETCH); if (search.value == INVALID_HANDLE_VALUE) { if (GetLastError() == ERROR_FILE_NOT_FOUND) continue; return false; }
      do {
        const std::wstring name = data.cFileName; if (name == L"." || name == L"..") continue; if (name.empty() || name.find(L'\\') != std::wstring::npos || parent.path.size() + name.size() + 1 >= 32767) return false; const std::wstring path = parent.path + L"\\" + name; const bool hinted_directory = (data.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0; const DWORD flags = FILE_FLAG_OPEN_REPARSE_POINT | (hinted_directory ? FILE_FLAG_BACKUP_SEMANTICS : 0);
        grant->stage = 583; Handle probe(CreateFileW(path.c_str(), READ_CONTROL | FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING, flags, nullptr)); if (probe.value == INVALID_HANDLE_VALUE) return false;
        grant->stage = 584; BY_HANDLE_FILE_INFORMATION info{}; if (!GetFileInformationByHandle(probe.value, &info) || info.dwVolumeSerialNumber != grant->identity.dwVolumeSerialNumber) return false; const bool directory_child = (info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0; const bool reparse = (info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0; std::string probe_digest;
        grant->stage = 585; bool protected_acl = false; if (!ReadPreflightAcl(probe.value, info, sid, mask, directory_child, &probe_digest, &protected_acl)) { if (protected_acl) grant->preflight_failure = RootPreflightFailure::acl_protected; return false; }
        const std::uint64_t file_id = FileId(info); const auto duplicate = std::find_if(grant->descendants.begin(), grant->descendants.end(), [&](const DescendantLease& value) { return FileId(value.identity) == file_id; });
        if (duplicate != grant->descendants.end()) { if (duplicate->directory != directory_child || duplicate->eligible || info.nNumberOfLinks <= 1 || duplicate->acl_digest != probe_digest) return false; continue; }
        if (grant->descendants.size() >= mini_lux::sec03::kMaxJournalObjects) { SetLastError(ERROR_TOO_MANY_OPEN_FILES); return false; }
        grant->stage = 586; const DWORD access = directory_child ? MAXIMUM_ALLOWED : READ_CONTROL | WRITE_DAC | DELETE | FILE_READ_ATTRIBUTES; Handle retained; if (directory_child && file_id == FileId(grant->cwd_identity)) { if (!DuplicateHandle(GetCurrentProcess(), grant->cwd_handle.value, GetCurrentProcess(), &retained.value, 0, FALSE, DUPLICATE_SAME_ACCESS)) return false; } else { retained.value = CreateFileW(path.c_str(), access, FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT | (directory_child ? FILE_FLAG_BACKUP_SEMANTICS : 0), nullptr); if (retained.value == INVALID_HANDLE_VALUE && GetLastError() == ERROR_SHARING_VIOLATION) grant->preflight_failure = RootPreflightFailure::acl_sharing; } if (retained.value == INVALID_HANDLE_VALUE) return false;
        BY_HANDLE_FILE_INFORMATION retained_info{}; std::string retained_digest; if (!GetFileInformationByHandle(retained.value, &retained_info) || retained_info.dwVolumeSerialNumber != info.dwVolumeSerialNumber || FileId(retained_info) != file_id || !ReadPreflightAcl(retained.value, retained_info, sid, mask, directory_child, &retained_digest) || retained_digest != probe_digest) return false;
        const bool eligible = !reparse && (directory_child || retained_info.nNumberOfLinks == 1); grant->descendants.push_back({std::move(retained), retained_info, directory_child, eligible, retained_digest});
        if (directory_child && !reparse) pending.push_back({path, retained_info, true});
      } while (FindNextFileW(search.value, &data)); if (GetLastError() != ERROR_NO_MORE_FILES) return false;
    }
    grant->journal.objects.clear(); grant->journal.objects.reserve(grant->descendants.size()); for (const auto& object : grant->descendants) grant->journal.objects.push_back({FileId(object.identity), object.directory, object.eligible, object.acl_digest});
    std::sort(grant->journal.objects.begin(), grant->journal.objects.end(), [](const mini_lux::sec03::JournalObject& left, const mini_lux::sec03::JournalObject& right) { return left.file < right.file; });
    grant->stage = 5; return true;
  } catch (...) { SetLastError(ERROR_NOT_ENOUGH_MEMORY); return false; }
}

bool VerifyDescendantAcl(const DescendantLease& object, PSID sid, DWORD mask, bool granted) {
  PACL acl = nullptr; PSECURITY_DESCRIPTOR descriptor = nullptr; if (!ReadDacl(object.handle.value, &acl, &descriptor)) return false; unsigned matches = 0; bool unexpected = false; const BYTE flags = object.directory ? CONTAINER_INHERIT_ACE | OBJECT_INHERIT_ACE : 0;
  const BYTE expected_flags = granted ? static_cast<BYTE>(flags | INHERITED_ACE) : flags; const bool ok = SameFile(object.handle.value, object.identity) && InspectSidAcl(acl, sid, mask, expected_flags, !granted, &matches, &unexpected) && !unexpected && matches == (granted ? 1u : 0u) && UnprotectedDescriptor(descriptor); LocalFree(descriptor); return ok;
}

bool StableDescendantClassification(const DescendantLease& object) {
  BY_HANDLE_FILE_INFORMATION observed{}; if (!GetFileInformationByHandle(object.handle.value, &observed) || FileId(observed) != FileId(object.identity) || observed.dwVolumeSerialNumber != object.identity.dwVolumeSerialNumber || ((observed.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0) != object.directory) return false; const bool reparse = (observed.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0; const bool eligible = !reparse && (object.directory || observed.nNumberOfLinks == 1); return eligible == object.eligible;
}

bool ApplyDescendantGrant(RootGrant* grant, DescendantLease* object, PSID sid) {
  grant->stage = 851; PACL original = nullptr; PSECURITY_DESCRIPTOR descriptor = nullptr; if (!ReadDacl(object->handle.value, &original, &descriptor)) return false; std::string digest; const BYTE flags = object->directory ? CONTAINER_INHERIT_ACE | OBJECT_INHERIT_ACE : 0; unsigned matches = 0; bool unexpected = false;
  bool ok = UnprotectedDescriptor(descriptor) && InspectSidAcl(original, sid, grant->journal.access_mask, flags, false, &matches, &unexpected) && matches == 0 && !unexpected && SameFile(object->handle.value, object->identity) && mini_lux::sec03::AclSequenceDigest(original, &digest) && digest == object->acl_digest;
  grant->stage = 854; PACL barrier = nullptr; PSECURITY_DESCRIPTOR barrier_descriptor = nullptr; if (ok) ok = ReadDacl(object->handle.value, &barrier, &barrier_descriptor) && SameAcl(original, barrier) && SameFile(object->handle.value, object->identity); grant->stage = 855; if (ok) { ok = SetSecurityInfo(object->handle.value, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, nullptr, nullptr, original, nullptr) == ERROR_SUCCESS; if (ok) ++grant->acl_mutations; }
  grant->stage = 856; PACL observed = nullptr; PSECURITY_DESCRIPTOR observed_descriptor = nullptr; if (ok) ok = ReadDacl(object->handle.value, &observed, &observed_descriptor) && VerifyInheritedApplied(original, observed, sid, grant->journal.access_mask, flags) && SameFile(object->handle.value, object->identity); if (observed_descriptor) LocalFree(observed_descriptor); if (barrier_descriptor) LocalFree(barrier_descriptor); LocalFree(descriptor); return ok;
}

bool PropagateRootDescendants(RootGrant* grant, PSID sid) {
  try {
    grant->stage = 81; for (const auto& object : grant->descendants) if (!StableDescendantClassification(object) || !VerifyDescendantAcl(object, sid, grant->journal.access_mask, false)) return false;
    grant->stage = 85; for (auto& object : grant->descendants) if (object.eligible) { if (!StableDescendantClassification(object) || !ApplyDescendantGrant(grant, &object, sid)) return false; TestCrash("descendant-applied"); }
    grant->stage = 86; for (const auto& object : grant->descendants) if (!StableDescendantClassification(object) || !VerifyDescendantAcl(object, sid, grant->journal.access_mask, object.eligible)) return false;
    grant->stage = 8; return true;
  } catch (...) { SetLastError(ERROR_NOT_ENOUGH_MEMORY); return false; }
}

bool RemoveExpectedAces(HANDLE handle, const BY_HANDLE_FILE_INFORMATION& identity, PSID sid, DWORD mask, bool directory, bool* anomaly, unsigned* acl_mutations) {
  PACL current = nullptr; PSECURITY_DESCRIPTOR descriptor = nullptr; if (!ReadDacl(handle, &current, &descriptor)) return false; const BYTE flags = directory ? CONTAINER_INHERIT_ACE | OBJECT_INHERIT_ACE : 0; unsigned matches = 0; bool unexpected = false;
  bool ok = InspectSidAcl(current, sid, mask, flags, true, &matches, &unexpected); *anomaly = unexpected || matches > 1; if (!ok) { LocalFree(descriptor); return false; } if (!matches) { LocalFree(descriptor); return true; }
  DWORD bytes = sizeof(ACL); for (DWORD i = 0; i < current->AceCount; ++i) { void* raw = nullptr; if (!GetAce(current, i, &raw)) { LocalFree(descriptor); return false; } const auto* header = static_cast<ACE_HEADER*>(raw); if (!ExpectedAllowAce(header, sid, mask, flags, true)) bytes += header->AceSize; }
  std::vector<unsigned char> storage(bytes); PACL cleaned = reinterpret_cast<PACL>(storage.data()); const DWORD revision = current->AclRevision; ok = InitializeAcl(cleaned, bytes, revision) != FALSE;
  for (DWORD i = 0; ok && i < current->AceCount; ++i) { void* raw = nullptr; ok = GetAce(current, i, &raw) != FALSE; if (!ok) break; const auto* header = static_cast<ACE_HEADER*>(raw); if (!ExpectedAllowAce(header, sid, mask, flags, true)) ok = AddAce(cleaned, revision, MAXDWORD, raw, header->AceSize) != FALSE; }
  PACL barrier = nullptr; PSECURITY_DESCRIPTOR barrier_descriptor = nullptr; if (ok) ok = ReadDacl(handle, &barrier, &barrier_descriptor) && SameAcl(current, barrier) && SameFile(handle, identity); if (ok) { ok = SetSecurityInfo(handle, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, nullptr, nullptr, cleaned, nullptr) == ERROR_SUCCESS; if (ok) ++*acl_mutations; }
  PACL observed = nullptr; PSECURITY_DESCRIPTOR observed_descriptor = nullptr; unsigned remaining = 0; bool observed_unexpected = false; if (ok) ok = ReadDacl(handle, &observed, &observed_descriptor) && SameAceSequence(cleaned, observed) && InspectSidAcl(observed, sid, mask, flags, true, &remaining, &observed_unexpected) && remaining == 0; *anomaly = *anomaly || observed_unexpected;
  if (observed_descriptor) LocalFree(observed_descriptor); if (barrier_descriptor) LocalFree(barrier_descriptor); LocalFree(descriptor); return ok;
}

bool CollectDescendants(const RootGrant& grant, PSID sid, std::vector<TreeEntry>* entries) {
  std::vector<TreeEntry> pending; pending.push_back({grant.path, grant.identity, true});
  while (!pending.empty()) {
    TreeEntry parent = std::move(pending.back()); pending.pop_back(); Handle directory(CreateFileW(parent.path.c_str(), FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr)); if (directory.value == INVALID_HANDLE_VALUE || !SameFile(directory.value, parent.identity)) return false;
    WIN32_FIND_DATAW data{}; FindHandle search; search.value = FindFirstFileExW((parent.path + L"\\*").c_str(), FindExInfoBasic, &data, FindExSearchNameMatch, nullptr, FIND_FIRST_EX_LARGE_FETCH); if (search.value == INVALID_HANDLE_VALUE) { if (GetLastError() == ERROR_FILE_NOT_FOUND) continue; return false; }
    do {
      const std::wstring name = data.cFileName; if (name == L"." || name == L"..") continue; if (name.empty() || name.find(L'\\') != std::wstring::npos || parent.path.size() + name.size() + 1 >= 32767) return false; const std::wstring path = parent.path + L"\\" + name; const bool hinted_directory = (data.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
      Handle child(CreateFileW(path.c_str(), READ_CONTROL, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT | (hinted_directory ? FILE_FLAG_BACKUP_SEMANTICS : 0), nullptr)); if (child.value == INVALID_HANDLE_VALUE) return false; BY_HANDLE_FILE_INFORMATION info{}; if (!GetFileInformationByHandle(child.value, &info) || info.dwVolumeSerialNumber != grant.identity.dwVolumeSerialNumber) return false; const bool directory_child = (info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
      PACL acl = nullptr; PSECURITY_DESCRIPTOR descriptor = nullptr; if (!ReadDacl(child.value, &acl, &descriptor)) return false; unsigned matches = 0; bool unexpected = false; const BYTE ace_flags = directory_child ? CONTAINER_INHERIT_ACE | OBJECT_INHERIT_ACE : 0; const bool inspectable = InspectSidAcl(acl, sid, grant.journal.access_mask, ace_flags, true, &matches, &unexpected); LocalFree(descriptor); if (!inspectable || unexpected || matches > 1) return false;
      entries->push_back({path, info, directory_child}); if (directory_child && !(info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT)) pending.push_back({path, info, true});
    } while (FindNextFileW(search.value, &data)); if (GetLastError() != ERROR_NO_MORE_FILES) return false;
  }
  return true;
}

bool VerifyNoDescendantSid(const RootGrant& grant, PSID sid) {
  std::vector<TreeEntry> entries; if (!CollectDescendants(grant, sid, &entries)) return false; for (const auto& entry : entries) { const DWORD flags = FILE_FLAG_OPEN_REPARSE_POINT | (entry.directory ? FILE_FLAG_BACKUP_SEMANTICS : 0); Handle child(CreateFileW(entry.path.c_str(), READ_CONTROL, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING, flags, nullptr)); if (child.value == INVALID_HANDLE_VALUE || !SameFile(child.value, entry.identity)) return false; PACL acl = nullptr; PSECURITY_DESCRIPTOR descriptor = nullptr; if (!ReadDacl(child.value, &acl, &descriptor)) return false; unsigned matches = 0; bool unexpected = false; const BYTE ace_flags = entry.directory ? CONTAINER_INHERIT_ACE | OBJECT_INHERIT_ACE : 0; const bool ok = InspectSidAcl(acl, sid, grant.journal.access_mask, ace_flags, true, &matches, &unexpected) && matches == 0 && !unexpected; LocalFree(descriptor); if (!ok) return false; } return true;
}

bool CleanupRootDescendants(RootGrant* grant, PSID sid) {
  try {
    std::vector<TreeEntry> entries; if (!CollectDescendants(*grant, sid, &entries)) return false; bool clean = true;
    for (const auto& entry : entries) { const DWORD flags = FILE_FLAG_OPEN_REPARSE_POINT | (entry.directory ? FILE_FLAG_BACKUP_SEMANTICS : 0); Handle child(CreateFileW(entry.path.c_str(), READ_CONTROL | WRITE_DAC, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING, flags, nullptr)); if (child.value == INVALID_HANDLE_VALUE) { const DWORD error = GetLastError(); if (error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND) continue; clean = false; continue; } if (!SameFile(child.value, entry.identity)) { clean = false; continue; } bool anomaly = false; if (!RemoveExpectedAces(child.value, entry.identity, sid, grant->journal.access_mask, entry.directory, &anomaly, &grant->acl_mutations) || anomaly) clean = false; }
    return clean && VerifyNoDescendantSid(*grant, sid);
  } catch (...) { SetLastError(ERROR_NOT_ENOUGH_MEMORY); return false; }
}

bool PrepareRoot(const Json& root_json, const Json& inherited_json, PSID sid, RootGrant* grant) {
  grant->stage = 1;
  if (!ExactKeys(root_json, {"access", "canonicalCwd", "canonicalPath", "cwdIdentity", "identity", "rootId"}) || !ExactKeys(inherited_json, {"cwdHandleValue", "handleValue", "rootIndex"})) return false;
  const Json* access = Field(root_json, "access", Json::Kind::string); const Json* identity = Field(root_json, "identity", Json::Kind::object); const Json* cwd_identity = Field(root_json, "cwdIdentity", Json::Kind::object); const Json* handle = Field(inherited_json, "handleValue", Json::Kind::string); const Json* cwd_handle = Field(inherited_json, "cwdHandleValue", Json::Kind::string);
  if (!access || !identity || !cwd_identity || !handle || !cwd_handle || (access->scalar != "read" && access->scalar != "read-write") || !ExactKeys(*identity, {"fileId", "type", "volumeSerial"}) || !ExactKeys(*cwd_identity, {"fileId", "type", "volumeSerial"})) return false;
  const Json* volume = Field(*identity, "volumeSerial", Json::Kind::string); const Json* file = Field(*identity, "fileId", Json::Kind::string); const Json* type = Field(*identity, "type", Json::Kind::string); const Json* cwd_volume = Field(*cwd_identity, "volumeSerial", Json::Kind::string); const Json* cwd_file = Field(*cwd_identity, "fileId", Json::Kind::string); const Json* cwd_type = Field(*cwd_identity, "type", Json::Kind::string); uint64_t expected_volume = 0, expected_file = 0, handle_value = 0, expected_cwd_volume = 0, expected_cwd_file = 0, cwd_handle_value = 0;
  if (!volume || !file || !type || !cwd_volume || !cwd_file || !cwd_type || type->scalar != "directory" || cwd_type->scalar != "directory" || !ParseUnsigned(volume->scalar, &expected_volume) || !ParseUnsigned(file->scalar, &expected_file) || !ParseUnsigned(handle->scalar, &handle_value) || !ParseUnsigned(cwd_volume->scalar, &expected_cwd_volume) || !ParseUnsigned(cwd_file->scalar, &expected_cwd_file) || !ParseUnsigned(cwd_handle->scalar, &cwd_handle_value) || !handle_value || !cwd_handle_value) return false;
  grant->stage = 2; grant->handle.value = reinterpret_cast<HANDLE>(static_cast<uintptr_t>(handle_value)); SetHandleInformation(grant->handle.value, HANDLE_FLAG_INHERIT, 0);
  if (!GetFileInformationByHandle(grant->handle.value, &grant->identity) || !(grant->identity.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) || (grant->identity.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) || expected_volume != grant->identity.dwVolumeSerialNumber || expected_file != FileId(grant->identity)) return false;
  grant->stage = 3; std::vector<wchar_t> final_path(32768); const DWORD count = GetFinalPathNameByHandleW(grant->handle.value, final_path.data(), static_cast<DWORD>(final_path.size()), FILE_NAME_NORMALIZED | VOLUME_NAME_DOS); if (!count || count >= final_path.size()) return false; grant->path.assign(final_path.data(), count);
  grant->cwd_handle.value = reinterpret_cast<HANDLE>(static_cast<uintptr_t>(cwd_handle_value)); SetHandleInformation(grant->cwd_handle.value, HANDLE_FLAG_INHERIT, 0); if (!GetFileInformationByHandle(grant->cwd_handle.value, &grant->cwd_identity) || grant->cwd_identity.dwVolumeSerialNumber != expected_cwd_volume || FileId(grant->cwd_identity) != expected_cwd_file || !(grant->cwd_identity.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) || (grant->cwd_identity.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT)) return false; std::vector<wchar_t> cwd_path(32768); const DWORD cwd_count = GetFinalPathNameByHandleW(grant->cwd_handle.value, cwd_path.data(), static_cast<DWORD>(cwd_path.size()), FILE_NAME_NORMALIZED | VOLUME_NAME_DOS); if (!cwd_count || cwd_count >= cwd_path.size()) return false; grant->cwd_path.assign(cwd_path.data(), cwd_count); if (grant->cwd_path.size() < grant->path.size() || _wcsnicmp(grant->cwd_path.c_str(), grant->path.c_str(), grant->path.size()) != 0 || (grant->cwd_path.size() > grant->path.size() && grant->cwd_path[grant->path.size()] != L'\\')) return false;
  grant->stage = 4; std::array<wchar_t, MAX_PATH> volume_path{}; std::array<wchar_t, 32> filesystem{}; DWORD serial = 0; if (!GetVolumePathNameW(grant->path.c_str(), volume_path.data(), static_cast<DWORD>(volume_path.size())) || GetDriveTypeW(volume_path.data()) != DRIVE_FIXED || !GetVolumeInformationW(volume_path.data(), nullptr, 0, &serial, nullptr, nullptr, filesystem.data(), static_cast<DWORD>(filesystem.size())) || _wcsicmp(filesystem.data(), L"NTFS") != 0 || serial != grant->identity.dwVolumeSerialNumber) return false;
  grant->stage = 5; PACL d0 = nullptr; if (!ReadDacl(grant->handle.value, &d0, &grant->original_descriptor)) return false;
  DWORD mask = FILE_GENERIC_READ | FILE_GENERIC_EXECUTE | FILE_LIST_DIRECTORY | FILE_TRAVERSE; if (access->scalar == "read-write") mask |= FILE_GENERIC_WRITE | FILE_ADD_FILE | FILE_ADD_SUBDIRECTORY | FILE_DELETE_CHILD | DELETE;
  unsigned existing_sid_aces = 0; bool unexpected_sid_ace = false; if (!InspectSidAcl(d0, sid, mask, CONTAINER_INHERIT_ACE | OBJECT_INHERIT_ACE, false, &existing_sid_aces, &unexpected_sid_ace) || existing_sid_aces != 0 || unexpected_sid_ace) return false;
  grant->journal.root_path = grant->path; grant->journal.volume = grant->identity.dwVolumeSerialNumber; grant->journal.file = FileId(grant->identity); grant->journal.access_mask = mask;
  if (!mini_lux::sec03::AclSequenceDigest(d0, &grant->journal.acl_digest)) return false;
  grant->stage = 58; if (!PreflightRootDescendants(grant, sid, mask)) return false;
  const DWORD sid_bytes = GetLengthSid(sid); grant->exact_ace.assign(sizeof(ACCESS_ALLOWED_ACE) - sizeof(DWORD) + sid_bytes, 0); auto* ace = reinterpret_cast<ACCESS_ALLOWED_ACE*>(grant->exact_ace.data()); ace->Header.AceType = ACCESS_ALLOWED_ACE_TYPE; ace->Header.AceFlags = CONTAINER_INHERIT_ACE | OBJECT_INHERIT_ACE; ace->Header.AceSize = static_cast<WORD>(grant->exact_ace.size()); ace->Mask = mask; if (!CopySid(sid_bytes, &ace->SidStart, sid)) return false;
  grant->journal.ace = grant->exact_ace;
  if (!NewJournalPrefix(grant) || !AdvanceJournal(grant, "prepared") || !TestPreparedBarrier(grant->path)) return false;
  TestCrash("prepared"); grant->stage = 6; std::vector<unsigned char> d1; if (!CopyAclWithChange(d0, &grant->exact_ace, nullptr, &d1)) return false;
  PACL d0_again = nullptr; PSECURITY_DESCRIPTOR again_descriptor = nullptr; std::string d0_again_digest; const bool reread = ReadDacl(grant->handle.value, &d0_again, &again_descriptor) && mini_lux::sec03::AclSequenceDigest(d0_again, &d0_again_digest) && SameFile(grant->handle.value, grant->identity); const bool stable = reread && d0_again_digest == grant->journal.acl_digest && SameAcl(d0, d0_again); if (!stable && g_fixed_acl_conflict && reread && d0_again_digest != grant->journal.acl_digest) grant->preflight_failure = RootPreflightFailure::acl_conflict; if (again_descriptor) ::LocalFree(again_descriptor); if (!stable || SetSecurityInfo(grant->handle.value, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, nullptr, nullptr, reinterpret_cast<PACL>(d1.data()), nullptr) != ERROR_SUCCESS) return false; ++grant->acl_mutations;
  grant->stage = 7; PACL observed = nullptr; PSECURITY_DESCRIPTOR observed_descriptor = nullptr; bool verified = false; if (ReadDacl(grant->handle.value, &observed, &observed_descriptor)) verified = VerifyApplied(d0, observed, grant->exact_ace); if (observed_descriptor) ::LocalFree(observed_descriptor);
  if (!verified || !PropagateRootDescendants(grant, sid) || !AdvanceJournal(grant, "applied")) return false; TestCrash("applied"); return true;
}

bool CleanupRetainedDescendants(RootGrant* grant, PSID sid) {
  bool clean = true; for (auto& object : grant->descendants) { if (!object.eligible) { if (!VerifyDescendantAcl(object, sid, grant->journal.access_mask, false)) clean = false; continue; } bool anomaly = false; if (!RemoveExpectedAces(object.handle.value, object.identity, sid, grant->journal.access_mask, object.directory, &anomaly, &grant->acl_mutations) || anomaly) clean = false; }
  for (const auto& object : grant->descendants) if (!VerifyDescendantAcl(object, sid, grant->journal.access_mask, false)) clean = false; return clean;
}

bool CleanupRoot(RootGrant* grant, PSID sid) {
  if (!SameFile(grant->handle.value, grant->identity)) return false;
  PACL current = nullptr; PSECURITY_DESCRIPTOR descriptor = nullptr; if (!ReadDacl(grant->handle.value, &current, &descriptor)) return false; unsigned matches = 0; bool unexpected = false;
  bool ok = InspectSidAcl(current, sid, grant->journal.access_mask, CONTAINER_INHERIT_ACE | OBJECT_INHERIT_ACE, false, &matches, &unexpected) && !unexpected && matches <= 1; std::vector<unsigned char> cleaned;
  if (ok && matches == 1) ok = CopyAclWithChange(current, nullptr, &grant->exact_ace, &cleaned); else if (ok) { cleaned.assign(current->AclSize, 0); memcpy(cleaned.data(), current, current->AclSize); }
  PACL again = nullptr; PSECURITY_DESCRIPTOR again_descriptor = nullptr; if (ok) ok = ReadDacl(grant->handle.value, &again, &again_descriptor) && SameAcl(current, again) && SameFile(grant->handle.value, grant->identity); if (ok && matches == 1) { ok = SetSecurityInfo(grant->handle.value, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, nullptr, nullptr, reinterpret_cast<PACL>(cleaned.data()), nullptr) == ERROR_SUCCESS; if (ok) ++grant->acl_mutations; }
  PACL final_acl = nullptr; PSECURITY_DESCRIPTOR final_descriptor = nullptr; unsigned remaining = 0; bool final_unexpected = false; if (ok && ReadDacl(grant->handle.value, &final_acl, &final_descriptor)) ok = SameAceSequence(reinterpret_cast<PACL>(cleaned.data()), final_acl) && InspectSidAcl(final_acl, sid, grant->journal.access_mask, CONTAINER_INHERIT_ACE | OBJECT_INHERIT_ACE, false, &remaining, &final_unexpected) && remaining == 0 && !final_unexpected; else ok = false;
  if (final_descriptor) ::LocalFree(final_descriptor); if (again_descriptor) ::LocalFree(again_descriptor); if (descriptor) ::LocalFree(descriptor); if (!ok) return false; const bool retained_clean = CleanupRetainedDescendants(grant, sid); const bool namespace_clean = CleanupRootDescendants(grant, sid); return retained_clean && namespace_clean;
}

bool PrepareFixedImageGrant(HANDLE image, const BY_HANDLE_FILE_INFORMATION& leased_identity, PSID sid, FixedImageGrant* grant) {
  grant->stage = 1; grant->handle = image; grant->identity = leased_identity;
  if (image == INVALID_HANDLE_VALUE || !SameFile(image, leased_identity) || (leased_identity.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT))) return false;
  std::array<wchar_t, 32768> final_path{}; const DWORD count = GetFinalPathNameByHandleW(image, final_path.data(), static_cast<DWORD>(final_path.size()), FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
  if (!count || count >= final_path.size()) return false; grant->path.assign(final_path.data(), count); grant->stage = 2;
  std::array<wchar_t, MAX_PATH> volume_path{}; std::array<wchar_t, 32> filesystem{}; DWORD serial = 0;
  if (!GetVolumePathNameW(grant->path.c_str(), volume_path.data(), static_cast<DWORD>(volume_path.size())) || GetDriveTypeW(volume_path.data()) != DRIVE_FIXED
    || !GetVolumeInformationW(volume_path.data(), nullptr, 0, &serial, nullptr, nullptr, filesystem.data(), static_cast<DWORD>(filesystem.size())) || _wcsicmp(filesystem.data(), L"NTFS") != 0 || serial != leased_identity.dwVolumeSerialNumber) return false;
  grant->stage = 3; PACL original = nullptr; if (!ReadDacl(image, &original, &grant->original_descriptor)) return false;
  const DWORD mask = FILE_GENERIC_READ | FILE_GENERIC_EXECUTE; const DWORD sid_bytes = GetLengthSid(sid); grant->exact_ace.assign(sizeof(ACCESS_ALLOWED_ACE) - sizeof(DWORD) + sid_bytes, 0);
  auto* ace = reinterpret_cast<ACCESS_ALLOWED_ACE*>(grant->exact_ace.data()); ace->Header.AceType = ACCESS_ALLOWED_ACE_TYPE; ace->Header.AceFlags = 0; ace->Header.AceSize = static_cast<WORD>(grant->exact_ace.size()); ace->Mask = mask;
  if (!CopySid(sid_bytes, &ace->SidStart, sid)) return false;
  grant->journal.root_path = grant->path; grant->journal.resource_kind = "file"; grant->journal.volume = leased_identity.dwVolumeSerialNumber; grant->journal.file = FileId(leased_identity); grant->journal.access_mask = mask; grant->journal.ace = grant->exact_ace;
  if (!mini_lux::sec03::AclSequenceDigest(original, &grant->journal.acl_digest) || !NewJournalPrefix(grant) || !AdvanceJournal(grant, "prepared")) return false;
  TestCrash("prepared"); grant->stage = 4; std::vector<unsigned char> applied; if (!CopyAclWithChange(original, &grant->exact_ace, nullptr, &applied)) return false;
  PACL barrier = nullptr; PSECURITY_DESCRIPTOR barrier_descriptor = nullptr; std::string barrier_digest;
  const bool stable = ReadDacl(image, &barrier, &barrier_descriptor) && mini_lux::sec03::AclSequenceDigest(barrier, &barrier_digest) && barrier_digest == grant->journal.acl_digest && SameAcl(original, barrier);
  if (barrier_descriptor) ::LocalFree(barrier_descriptor); if (!stable || !SameFile(image, leased_identity) || SetSecurityInfo(image, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, nullptr, nullptr, reinterpret_cast<PACL>(applied.data()), nullptr) != ERROR_SUCCESS) return false; ++grant->acl_mutations;
  grant->stage = 5; PACL observed = nullptr; PSECURITY_DESCRIPTOR observed_descriptor = nullptr; bool verified = false; if (ReadDacl(image, &observed, &observed_descriptor)) verified = VerifyApplied(original, observed, grant->exact_ace); if (observed_descriptor) ::LocalFree(observed_descriptor);
  if (!verified || !SameFile(image, leased_identity) || !AdvanceJournal(grant, "applied")) return false; TestCrash("applied"); return true;
}

bool CleanupFixedImageGrant(FixedImageGrant* grant) {
  if (!SameFile(grant->handle, grant->identity)) return false;
  PACL current = nullptr; PSECURITY_DESCRIPTOR descriptor = nullptr; if (!ReadDacl(grant->handle, &current, &descriptor)) return false; std::vector<unsigned char> cleaned; bool ok = CopyAclWithChange(current, nullptr, &grant->exact_ace, &cleaned);
  PACL barrier = nullptr; PSECURITY_DESCRIPTOR barrier_descriptor = nullptr; if (ok) ok = ReadDacl(grant->handle, &barrier, &barrier_descriptor) && SameAcl(current, barrier) && SameFile(grant->handle, grant->identity); if (ok) { ok = SetSecurityInfo(grant->handle, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, nullptr, nullptr, reinterpret_cast<PACL>(cleaned.data()), nullptr) == ERROR_SUCCESS; if (ok) ++grant->acl_mutations; }
  PACL observed = nullptr; PSECURITY_DESCRIPTOR observed_descriptor = nullptr; if (ok && ReadDacl(grant->handle, &observed, &observed_descriptor)) ok = ExactAceCount(observed, grant->exact_ace) == 0 && SameAceSequence(reinterpret_cast<PACL>(cleaned.data()), observed); else ok = false;
  if (observed_descriptor) ::LocalFree(observed_descriptor); if (barrier_descriptor) ::LocalFree(barrier_descriptor); if (descriptor) ::LocalFree(descriptor); return ok;
}

bool RetireFixedImageGrant(FixedImageGrant* grant) {
  const bool job_zero = AdvanceJournal(grant, "job-zero"); const bool cleaned = CleanupFixedImageGrant(grant); const bool removed = job_zero && cleaned && AdvanceJournal(grant, "removed"); if (removed) DeleteJournals(*grant); return job_zero && cleaned && removed;
}

std::wstring RandomProfileName() {
  GUID guid{}; if (CoCreateGuid(&guid) != S_OK) return {}; wchar_t text[64]{}; if (!StringFromGUID2(guid, text, 64)) return {}; std::wstring value = L"MiniLux.Sandbox.";
  for (wchar_t c : std::wstring(text)) if ((c >= L'0' && c <= L'9') || (c >= L'a' && c <= L'f') || (c >= L'A' && c <= L'F')) value.push_back(c); return value;
}

bool VerifyTokenAndJob(HANDLE process, PSID sid, HANDLE job) {
  BOOL in_job = FALSE; if (!IsProcessInJob(process, job, &in_job) || !in_job) return false; Handle token; if (!OpenProcessToken(process, TOKEN_QUERY, &token.value)) return false;
  DWORD bytes = 0; BOOL is_app = FALSE; if (!GetTokenInformation(token.value, TokenIsAppContainer, &is_app, sizeof(is_app), &bytes) || !is_app) return false;
  GetTokenInformation(token.value, TokenAppContainerSid, nullptr, 0, &bytes); std::vector<unsigned char> sid_buffer(bytes); if (!bytes || !GetTokenInformation(token.value, TokenAppContainerSid, sid_buffer.data(), bytes, &bytes) || !EqualSid(reinterpret_cast<TOKEN_APPCONTAINER_INFORMATION*>(sid_buffer.data())->TokenAppContainer, sid)) return false;
  GetTokenInformation(token.value, TokenCapabilities, nullptr, 0, &bytes); std::vector<unsigned char> caps(bytes); if (!bytes || !GetTokenInformation(token.value, TokenCapabilities, caps.data(), bytes, &bytes) || reinterpret_cast<TOKEN_GROUPS*>(caps.data())->GroupCount != 0) return false;
  GetTokenInformation(token.value, TokenIntegrityLevel, nullptr, 0, &bytes); std::vector<unsigned char> integrity(bytes); if (!bytes || !GetTokenInformation(token.value, TokenIntegrityLevel, integrity.data(), bytes, &bytes)) return false;
  PSID integrity_sid = reinterpret_cast<TOKEN_MANDATORY_LABEL*>(integrity.data())->Label.Sid; const DWORD rid = *GetSidSubAuthority(integrity_sid, static_cast<DWORD>(*GetSidSubAuthorityCount(integrity_sid) - 1)); return rid <= SECURITY_MANDATORY_LOW_RID;
}

struct HandleDuplicationObservation {
  DWORD host_open_error = ERROR_GEN_FAILURE;
  DWORD job_duplicate_error = ERROR_GEN_FAILURE;
  DWORD control_duplicate_error = ERROR_GEN_FAILURE;
  bool job_blocked = false;
  bool control_blocked = false;
};

bool ObserveChildTokenHandleDuplication(HANDLE child, HANDLE job, HANDLE control, HandleDuplicationObservation* observation) {
  Handle primary, impersonation;
  if (!OpenProcessToken(child, TOKEN_QUERY | TOKEN_DUPLICATE, &primary.value)
    || !DuplicateTokenEx(primary.value, TOKEN_QUERY | TOKEN_IMPERSONATE, nullptr, SecurityImpersonation, TokenImpersonation, &impersonation.value)
    || !SetThreadToken(nullptr, impersonation.value)) return false;
  Handle host_process(OpenProcess(PROCESS_DUP_HANDLE, FALSE, GetCurrentProcessId()));
  if (host_process.value == INVALID_HANDLE_VALUE || !host_process.value) {
    observation->host_open_error = GetLastError();
    observation->job_duplicate_error = observation->host_open_error;
    observation->control_duplicate_error = observation->host_open_error;
  } else {
    observation->host_open_error = ERROR_SUCCESS;
    {
      Handle duplicate;
      if (DuplicateHandle(host_process.value, job, GetCurrentProcess(), &duplicate.value, 0, FALSE, DUPLICATE_SAME_ACCESS)) observation->job_duplicate_error = ERROR_SUCCESS;
      else observation->job_duplicate_error = GetLastError();
    }
    {
      Handle duplicate;
      if (DuplicateHandle(host_process.value, control, GetCurrentProcess(), &duplicate.value, 0, FALSE, DUPLICATE_SAME_ACCESS)) observation->control_duplicate_error = ERROR_SUCCESS;
      else observation->control_duplicate_error = GetLastError();
    }
  }
  const bool reverted = RevertToSelf() != FALSE;
  observation->job_blocked = observation->host_open_error == ERROR_ACCESS_DENIED && observation->job_duplicate_error == ERROR_ACCESS_DENIED;
  observation->control_blocked = observation->host_open_error == ERROR_ACCESS_DENIED && observation->control_duplicate_error == ERROR_ACCESS_DENIED;
  return reverted && observation->job_blocked && observation->control_blocked;
}

bool Amd64Image(HANDLE file) {
  IMAGE_DOS_HEADER dos{}; DWORD got = 0; LARGE_INTEGER offset{}; if (!SetFilePointerEx(file, offset, nullptr, FILE_BEGIN) || !ReadFile(file, &dos, sizeof(dos), &got, nullptr) || got != sizeof(dos) || dos.e_magic != IMAGE_DOS_SIGNATURE || dos.e_lfanew <= 0) return false;
  offset.QuadPart = dos.e_lfanew; DWORD signature = 0; IMAGE_FILE_HEADER header{}; const bool ok = SetFilePointerEx(file, offset, nullptr, FILE_BEGIN) && ReadFile(file, &signature, sizeof(signature), &got, nullptr) && got == sizeof(signature) && signature == IMAGE_NT_SIGNATURE && ReadFile(file, &header, sizeof(header), &got, nullptr) && got == sizeof(header) && header.Machine == IMAGE_FILE_MACHINE_AMD64; offset.QuadPart = 0; SetFilePointerEx(file, offset, nullptr, FILE_BEGIN); return ok;
}
bool Sha256Handle(HANDLE file, std::string* output) {
  BCRYPT_ALG_HANDLE algorithm = nullptr; BCRYPT_HASH_HANDLE hash = nullptr; DWORD object_bytes = 0, hash_bytes = 0, received = 0; std::vector<unsigned char> object, digest; LARGE_INTEGER zero{}; bool success = false;
  if (BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0) < 0) goto done;
  if (BCryptGetProperty(algorithm, BCRYPT_OBJECT_LENGTH, reinterpret_cast<PUCHAR>(&object_bytes), sizeof(object_bytes), &received, 0) < 0 || BCryptGetProperty(algorithm, BCRYPT_HASH_LENGTH, reinterpret_cast<PUCHAR>(&hash_bytes), sizeof(hash_bytes), &received, 0) < 0) goto done;
  object.resize(object_bytes); digest.resize(hash_bytes); if (BCryptCreateHash(algorithm, &hash, object.data(), object_bytes, nullptr, 0, 0) < 0 || !SetFilePointerEx(file, zero, nullptr, FILE_BEGIN)) goto done;
  for (;;) { std::array<unsigned char, 65536> buffer{}; DWORD count = 0; if (!ReadFile(file, buffer.data(), static_cast<DWORD>(buffer.size()), &count, nullptr)) goto done; if (!count) break; if (BCryptHashData(hash, buffer.data(), count, 0) < 0) goto done; }
  if (BCryptFinishHash(hash, digest.data(), hash_bytes, 0) < 0) goto done; *output = mini_lux::sec03::HexBytes(digest.data(), digest.size()); success = true;
done:
  SetFilePointerEx(file, zero, nullptr, FILE_BEGIN); if (hash) BCryptDestroyHash(hash); if (algorithm) BCryptCloseAlgorithmProvider(algorithm, 0); return success;
}

bool InheritedExecutable(const Json& value, Handle* handle, BY_HANDLE_FILE_INFORMATION* identity, std::wstring* path, std::string* sha256) {
  if (!ExactKeys(value, {"fileId", "handleValue", "sha256", "volumeSerial"})) return false; const Json* file = Field(value, "fileId", Json::Kind::string); const Json* raw = Field(value, "handleValue", Json::Kind::string); const Json* digest = Field(value, "sha256", Json::Kind::string); const Json* volume = Field(value, "volumeSerial", Json::Kind::string); uint64_t expected_file = 0, handle_value = 0, expected_volume = 0;
  if (!file || !raw || !digest || digest->scalar.size() != 64 || !std::all_of(digest->scalar.begin(), digest->scalar.end(), [](char c) { return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'); }) || !volume || !ParseUnsigned(file->scalar, &expected_file) || !ParseUnsigned(raw->scalar, &handle_value) || !ParseUnsigned(volume->scalar, &expected_volume) || !handle_value) return false;
  handle->value = reinterpret_cast<HANDLE>(static_cast<uintptr_t>(handle_value)); SetHandleInformation(handle->value, HANDLE_FLAG_INHERIT, 0); if (!GetFileInformationByHandle(handle->value, identity) || identity->dwVolumeSerialNumber != expected_volume || FileId(*identity) != expected_file || (identity->dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) || !Amd64Image(handle->value)) return false;
  std::vector<wchar_t> final_path(32768); const DWORD count = GetFinalPathNameByHandleW(handle->value, final_path.data(), static_cast<DWORD>(final_path.size()), FILE_NAME_NORMALIZED | VOLUME_NAME_DOS); if (!count || count >= final_path.size()) return false; path->assign(final_path.data(), count);
  std::array<wchar_t, MAX_PATH> volume_path{}; std::array<wchar_t, 32> filesystem{}; DWORD serial = 0; if (!GetVolumePathNameW(path->c_str(), volume_path.data(), static_cast<DWORD>(volume_path.size())) || GetDriveTypeW(volume_path.data()) != DRIVE_FIXED || !GetVolumeInformationW(volume_path.data(), nullptr, 0, &serial, nullptr, nullptr, filesystem.data(), static_cast<DWORD>(filesystem.size())) || _wcsicmp(filesystem.data(), L"NTFS") != 0 || serial != identity->dwVolumeSerialNumber || !Sha256Handle(handle->value, sha256) || *sha256 != digest->scalar) return false;
  if (path->rfind(L"\\\\?\\", 0) == 0 && path->size() > 6 && (*path)[5] == L':') path->erase(0, 4);
  return true;
}

bool SameProcessExecutable(HANDLE process, const BY_HANDLE_FILE_INFORMATION& expected, const std::string& expected_sha256) {
  std::vector<wchar_t> path(32768); DWORD count = static_cast<DWORD>(path.size()); if (!QueryFullProcessImageNameW(process, 0, path.data(), &count)) return false;
  Handle image(CreateFileW(std::wstring(path.data(), count).c_str(), GENERIC_READ | FILE_READ_ATTRIBUTES, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT, nullptr)); BY_HANDLE_FILE_INFORMATION identity{}; std::string digest;
  return image.value != INVALID_HANDLE_VALUE && GetFileInformationByHandle(image.value, &identity) && !(identity.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT))
    && identity.dwVolumeSerialNumber == expected.dwVolumeSerialNumber && FileId(identity) == FileId(expected) && Amd64Image(image.value) && Sha256Handle(image.value, &digest) && digest == expected_sha256;
}

struct RuntimeLimits {
  DWORD active = 0; SIZE_T process_memory = 0; SIZE_T job_memory = 0; DWORD cpu = 0;
  unsigned long long job_time = 0, wall = 0, idle = 0, aggregate = 0, retained = 0, input = 0;
  bool has_idle = false;
};

bool ParseLimits(const Json& value, const std::string& entry, RuntimeLimits* out) {
  if (!ExactKeys(value, {"activeProcesses", "aggregateOutputBytes", "cpuRatePercent", "idleTimeMs", "inputBytes", "jobMemoryBytes", "jobUserTimeMs", "processMemoryBytes", "retainedOutputBytes", "wallTimeMs"})) return false;
  auto number = [&](const char* key, unsigned long long* result) { const Json* field = Field(value, key, Json::Kind::number); return field && ParseUnsigned(field->scalar, result) && *result > 0; };
  unsigned long long active = 0, process_memory = 0, job_memory = 0, cpu = 0;
  if (!number("activeProcesses", &active) || !number("processMemoryBytes", &process_memory) || !number("jobMemoryBytes", &job_memory) || !number("cpuRatePercent", &cpu)
    || !number("jobUserTimeMs", &out->job_time) || !number("wallTimeMs", &out->wall) || !number("aggregateOutputBytes", &out->aggregate)
    || !number("retainedOutputBytes", &out->retained) || !number("inputBytes", &out->input)) return false;
  const Json* idle = value.object.count("idleTimeMs") ? &value.object.at("idleTimeMs") : nullptr;
  if (!idle || (idle->kind != Json::Kind::null_value && idle->kind != Json::Kind::number)) return false;
  if (idle->kind == Json::Kind::number) { if (!ParseUnsigned(idle->scalar, &out->idle) || !out->idle) return false; out->has_idle = true; }
  struct Maximum { unsigned long long active, process_memory, job_memory, cpu, job_time, wall, idle, aggregate, retained, input; bool persistent; } max{};
  if (entry == "E1") max = {16, 512ull << 20, 1ull << 30, 50, 30000, 30000, 0, 1ull << 20, 1ull << 20, 128ull << 10, false};
  else if (entry == "E2") max = {32, 512ull << 20, 1ull << 30, 25, 600000, 1800000, 300000, 10ull << 20, 1ull << 20, 64ull << 10, true};
  else if (entry == "E3") max = {1, 256ull << 20, 256ull << 20, 20, 10000, 10000, 0, 1ull << 20, 1ull << 20, 128ull << 10, false};
  else if (entry == "E3A") max = {8, 128ull << 20, 512ull << 20, 50, 10000, 10000, 0, 1ull << 20, 1ull << 20, 128ull << 10, false};
  else if (entry == "E4") max = {64, 1ull << 30, 2ull << 30, 50, 3600000, 28800000, 1800000, 64ull << 20, 1ull << 20, 64ull << 10, true};
  else return false;
  if (active > max.active || process_memory > max.process_memory || job_memory > max.job_memory || cpu > max.cpu || out->job_time > max.job_time || out->wall > max.wall
    || out->aggregate > max.aggregate || out->retained > max.retained || out->input > max.input || out->retained > out->aggregate || job_memory < process_memory
    || (max.persistent ? (!out->has_idle || out->idle > max.idle) : out->has_idle)) return false;
  out->active = static_cast<DWORD>(active); out->process_memory = static_cast<SIZE_T>(process_memory); out->job_memory = static_cast<SIZE_T>(job_memory); out->cpu = static_cast<DWORD>(cpu); return true;
}

bool SetJobLimits(HANDLE job, const RuntimeLimits& limits, DWORD* observed_flags) {
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION info{}; info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_ACTIVE_PROCESS | JOB_OBJECT_LIMIT_PROCESS_MEMORY | JOB_OBJECT_LIMIT_JOB_MEMORY | JOB_OBJECT_LIMIT_JOB_TIME; info.BasicLimitInformation.ActiveProcessLimit = limits.active; info.ProcessMemoryLimit = limits.process_memory; info.JobMemoryLimit = limits.job_memory; info.BasicLimitInformation.PerJobUserTimeLimit.QuadPart = static_cast<LONGLONG>(limits.job_time * 10000);
  if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, &info, sizeof(info))) return false; JOBOBJECT_CPU_RATE_CONTROL_INFORMATION cpu_info{}; cpu_info.ControlFlags = JOB_OBJECT_CPU_RATE_CONTROL_ENABLE | JOB_OBJECT_CPU_RATE_CONTROL_HARD_CAP; cpu_info.CpuRate = limits.cpu * 100; if (!SetInformationJobObject(job, JobObjectCpuRateControlInformation, &cpu_info, sizeof(cpu_info))) return false;
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION readback{}; JOBOBJECT_CPU_RATE_CONTROL_INFORMATION cpu_readback{}; const bool valid = QueryInformationJobObject(job, JobObjectExtendedLimitInformation, &readback, sizeof(readback), nullptr) && QueryInformationJobObject(job, JobObjectCpuRateControlInformation, &cpu_readback, sizeof(cpu_readback), nullptr)
    && readback.BasicLimitInformation.LimitFlags == info.BasicLimitInformation.LimitFlags && readback.BasicLimitInformation.ActiveProcessLimit == info.BasicLimitInformation.ActiveProcessLimit
    && readback.ProcessMemoryLimit == info.ProcessMemoryLimit && readback.JobMemoryLimit == info.JobMemoryLimit && cpu_readback.CpuRate == cpu_info.CpuRate;
  if (valid) *observed_flags = readback.BasicLimitInformation.LimitFlags; return valid;
}

bool FixedExecutable(const std::wstring& path, Handle* handle, BY_HANDLE_FILE_INFORMATION* identity, std::string* digest, DWORD access = GENERIC_READ | FILE_READ_ATTRIBUTES) {
  handle->value = CreateFileW(path.c_str(), access, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
  if (handle->value == INVALID_HANDLE_VALUE || !GetFileInformationByHandle(handle->value, identity) || (identity->dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) || !Amd64Image(handle->value) || !Sha256Handle(handle->value, digest)) return false;
  std::array<wchar_t, MAX_PATH> volume_path{}; std::array<wchar_t, 32> filesystem{}; DWORD serial = 0;
  return GetVolumePathNameW(path.c_str(), volume_path.data(), static_cast<DWORD>(volume_path.size())) && GetDriveTypeW(volume_path.data()) == DRIVE_FIXED
    && GetVolumeInformationW(volume_path.data(), nullptr, 0, &serial, nullptr, nullptr, filesystem.data(), static_cast<DWORD>(filesystem.size())) && serial == identity->dwVolumeSerialNumber && _wcsicmp(filesystem.data(), L"NTFS") == 0;
}

struct RuntimeControl {
  HANDLE job = nullptr; HANDLE input = nullptr; HPCON pseudo = nullptr; std::string secret; RuntimeLimits limits{}; bool persistent = false;
  std::atomic<bool> accepting{true}; std::atomic<int> reason{0}; std::atomic<unsigned long long> activity{0}; std::atomic<unsigned long long> aggregate{0}; std::atomic<unsigned long long> stdin_writes{0};
  std::mutex transcript_mutex; std::vector<unsigned char> transcript; std::string input_digest_material; std::set<std::string> control_frame_digests; std::string protocol_subcode = "none";
};

void FailJob(RuntimeControl* control, int reason) {
  control->accepting = false; int expected = 0; control->reason.compare_exchange_strong(expected, reason);
  const UINT exit_code = reason == 1 ? 0xE071 : reason == 3 ? 0xE080 : reason == 4 ? 0xE081 : reason == 5 ? 0xE082 : reason == 6 ? 0xE084 : reason == 7 ? 0xE085 : reason == 8 ? 0xE086 : reason == 9 ? 0xE087 : reason == 10 ? 0xE088 : reason == 11 ? 0xE089 : reason == 12 ? 0xE08A : reason == 14 ? 0xE08C : 0xE083;
  TerminateJobObject(control->job, exit_code);
}
void FailProtocol(RuntimeControl* control, const char* subcode) { control->protocol_subcode = subcode; FailJob(control, 1); }

void ControlMain(RuntimeControl* control) {
  while (control->accepting) {
    std::string wire; const FrameReadResult read = ReadFrame(&wire); if (read != FrameReadResult::ok) { if (control->accepting) { if (read == FrameReadResult::channel_lost) FailJob(control, 14); else FailProtocol(control, read == FrameReadResult::oversize ? "oversize" : "length"); } return; }
    std::string wire_digest; if (!mini_lux::sec03::Sha256(reinterpret_cast<const unsigned char*>(wire.data()), wire.size(), &wire_digest)) { FailProtocol(control, "state"); return; }
    if (!control->control_frame_digests.insert(wire_digest).second) { FailProtocol(control, "replay"); return; }
    Json frame; Parser parser(wire); if (!parser.Parse(&frame) || frame.kind != Json::Kind::object) { FailProtocol(control, parser.error().empty() ? "state" : parser.error().c_str()); return; }
    const Json* version = Field(frame, "v", Json::Kind::number); const Json* type = Field(frame, "type", Json::Kind::string); const Json* secret = Field(frame, "secret", Json::Kind::string);
    if (type && type->scalar == "launch") { FailProtocol(control, "second-launch"); return; }
    if (!version || version->scalar != "1" || !type) { FailProtocol(control, "state"); return; }
    if (!secret || secret->scalar != control->secret) { FailProtocol(control, "secret"); return; }
    if (type->scalar == "terminate") {
      const Json* reason = Field(frame, "reason", Json::Kind::string);
      if (!ExactKeys(frame, {"reason", "secret", "type", "v"})) { FailProtocol(control, "unknown-key"); return; }
      if (!reason || reason->scalar.empty() || reason->scalar.size() > 64 || !std::all_of(reason->scalar.begin(), reason->scalar.end(), [](char c) { return (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-'; })) { FailProtocol(control, "state"); return; }
      const int termination_reason = reason->scalar == "owner-retired" ? 10 : reason->scalar == "session-retired" ? 11 : reason->scalar == "service-shutdown" ? 12 : 2;
      FailJob(control, termination_reason); return;
    }
    if (type->scalar == "resize" && control->persistent) {
      if (!ExactKeys(frame, {"cols", "rows", "secret", "type", "v"})) { FailProtocol(control, "unknown-key"); return; }
      const Json* cols = Field(frame, "cols", Json::Kind::number); const Json* rows = Field(frame, "rows", Json::Kind::number); uint64_t parsed_cols = 0, parsed_rows = 0;
      if (!cols || !rows || !ParseUnsigned(cols->scalar, &parsed_cols) || !ParseUnsigned(rows->scalar, &parsed_rows)
        || parsed_cols < 2 || parsed_cols > 500 || parsed_rows < 1 || parsed_rows > 300 || !control->pseudo
        || FAILED(ResizePseudoConsole(control->pseudo, COORD{static_cast<SHORT>(parsed_cols), static_cast<SHORT>(parsed_rows)}))) {
        FailProtocol(control, "state"); return;
      }
      control->activity = GetTickCount64(); continue;
    }
    if (type->scalar != "input" || !control->persistent) { FailProtocol(control, "state"); return; }
    if (!ExactKeys(frame, {"appendNewline", "data", "digest", "secret", "type", "v"})) { FailProtocol(control, "unknown-key"); return; }
    const Json* data = Field(frame, "data", Json::Kind::string); const Json* digest = Field(frame, "digest", Json::Kind::string); const Json* newline = Field(frame, "appendNewline", Json::Kind::boolean); std::vector<unsigned char> bytes; std::string observed;
    if (!data || !digest || !newline || !DecodeBase64(data->scalar, &bytes) || Base64(bytes.data(), bytes.size()) != data->scalar || bytes.empty() || bytes.size() > control->limits.input || !mini_lux::sec03::Sha256(bytes.data(), bytes.size(), &observed) || observed != digest->scalar) { FailProtocol(control, "state"); return; }
    if (!WriteExact(control->input, bytes.data(), static_cast<DWORD>(bytes.size())) || (newline->boolean && !WriteExact(control->input, "\r\n", 2))) { FailProtocol(control, "state"); return; }
    { std::lock_guard<std::mutex> lock(control->transcript_mutex); control->input_digest_material += observed + "\n"; }
    ++control->stdin_writes; control->activity = GetTickCount64();
  }
}

void Drain(HANDLE pipe, const char* stream, RuntimeControl* control) {
  std::array<unsigned char, 32768> buffer{};
  for (;;) { DWORD count = 0; if (!ReadFile(pipe, buffer.data(), static_cast<DWORD>(buffer.size()), &count, nullptr) || !count) break; const unsigned long long total = control->aggregate.fetch_add(count) + count; control->activity = GetTickCount64(); if (total > control->limits.aggregate) { FailJob(control, 5); break; } { std::lock_guard<std::mutex> lock(control->transcript_mutex); control->transcript.insert(control->transcript.end(), stream, stream + strlen(stream)); control->transcript.push_back(0); control->transcript.insert(control->transcript.end(), buffer.begin(), buffer.begin() + count); } if (!Output(stream, buffer.data(), count)) break; }
  CloseHandle(pipe);
}

std::string ProofReason(int reason, bool cleanup, DWORD child_exit) {
  if (!cleanup) return "cleanup-failed";
  switch (reason) { case 1: return "protocol-invalid"; case 2: return "cancelled"; case 3: return "limit-wall"; case 4: return "limit-idle"; case 5: return "limit-output"; case 6: return "limit-cpu"; case 7: return "limit-active-process"; case 8: return "limit-process-memory"; case 9: return "limit-job-memory"; case 10: return "owner-retired"; case 11: return "session-retired"; case 12: return "service-shutdown"; case 14: return "channel-lost"; default: return child_exit == 0 ? "completed" : "child-failed"; }
}

bool EmitNativeProof(const mini_lux::sec03::AttestationKey& key, const std::string& proof) {
  std::array<unsigned char, 32> mac{}; if (!mini_lux::sec03::HmacSha256(key, reinterpret_cast<const unsigned char*>(proof.data()), proof.size(), &mac)) return false;
  const std::string body = std::string("{\"version\":1,\"kind\":\"native-proof\",\"proofHex\":\"") + mini_lux::sec03::HexBytes(reinterpret_cast<const unsigned char*>(proof.data()), proof.size()) + "\",\"mac\":\"" + mini_lux::sec03::HexBytes(mac.data(), mac.size()) + "\",\"keyId\":\"" + key.key_id + "\"}";
  const uint32_t n = static_cast<uint32_t>(body.size()); unsigned char h[4] = {static_cast<unsigned char>(n >> 24), static_cast<unsigned char>(n >> 16), static_cast<unsigned char>(n >> 8), static_cast<unsigned char>(n)};
  std::lock_guard<std::mutex> lock(g_output_mutex); return WriteExact(GetStdHandle(STD_OUTPUT_HANDLE), h, 4) && WriteExact(GetStdHandle(STD_OUTPUT_HANDLE), body.data(), n);
}

bool EmitAclPreflightDenialProof(const mini_lux::sec03::AttestationKey& key, const Json& request, const RootGrant& grant, const std::vector<unsigned char>& app_sid_bytes, const RuntimeLimits& limits, const char* reason, unsigned* failure_stage) {
  if (failure_stage) *failure_stage = 1;
  const bool sharing = reason && std::string(reason) == "acl-sharing-failed" && grant.stage == 586 && grant.preflight_failure == RootPreflightFailure::acl_sharing && grant.journal.generation == 0;
  const bool propagation = reason && std::string(reason) == "acl-propagation-failed" && grant.stage == 585 && grant.preflight_failure == RootPreflightFailure::acl_protected && grant.journal.generation == 0;
  const bool conflict = reason && std::string(reason) == "acl-conflict" && grant.stage == 6 && grant.preflight_failure == RootPreflightFailure::acl_conflict && grant.journal.generation == 1;
  if (!key.available || (!sharing && !propagation && !conflict) || grant.acl_mutations != 0 || grant.journal.acl_digest.empty()) return false;
  const Json* candidate = Field(request, "candidateId", Json::Kind::string); const Json* build = Field(request, "buildIdSha256", Json::Kind::string); const Json* source = Field(request, "sourceSha256", Json::Kind::string); const Json* host = Field(request, "hostSha256", Json::Kind::string); const Json* launcher = Field(request, "launcherSha256", Json::Kind::string);
  const Json* execution = Field(request, "executionId", Json::Kind::string); const Json* context = Field(request, "contextId", Json::Kind::string); const Json* session = Field(request, "sessionId", Json::Kind::string); const Json* run = Field(request, "runId", Json::Kind::string); const Json* authority = Field(request, "authorityEpoch", Json::Kind::number); const Json* profile = Field(request, "profile", Json::Kind::string); const Json* payload = Field(request, "payloadDigest", Json::Kind::string); const Json* environment = Field(request, "environment", Json::Kind::object);
  if (!candidate || !build || !source || !host || !launcher || !execution || !context || !session || !run || !authority || !profile || !payload || !environment || app_sid_bytes.empty()) return false;
  if (failure_stage) *failure_stage = 2;
  std::string environment_names, environment_values; for (const auto& [name, value] : environment->object) { if (value.kind != Json::Kind::string) return false; environment_names += name + "\n"; environment_values += name; environment_values.push_back(0); environment_values += value.scalar + "\n"; }
  const std::string root_identity_material = std::to_string(grant.identity.dwVolumeSerialNumber) + ":" + std::to_string(FileId(grant.identity)) + ":" + std::to_string(grant.cwd_identity.dwVolumeSerialNumber) + ":" + std::to_string(FileId(grant.cwd_identity)) + "\n";
  const std::string root_access_material = std::to_string(grant.journal.access_mask) + ":" + grant.journal.acl_digest + "\n"; const std::string acl_profile_material = grant.journal.acl_digest + "\n";
  const std::string job_material = std::to_string(limits.active) + ":" + std::to_string(limits.process_memory) + ":" + std::to_string(limits.job_memory) + ":" + std::to_string(limits.cpu) + ":" + std::to_string(limits.job_time) + ":" + std::to_string(limits.wall) + ":" + (limits.has_idle ? std::to_string(limits.idle) : "null") + ":" + std::to_string(limits.aggregate) + ":" + std::to_string(limits.retained) + ":" + std::to_string(limits.input);
  const std::string transcript = sharing ? "EXEC_ACL_SHARING_FAILED" : conflict ? "EXEC_ACL_CONFLICT" : "EXEC_ACL_PROPAGATION_FAILED"; const std::string empty;
  if (failure_stage) *failure_stage = 3;
  std::string package_sid_digest, job_digest, root_digest, access_digest, acl_profile_digest, names_digest, values_digest, transcript_digest, input_digest_set_digest;
  if (!mini_lux::sec03::Sha256(app_sid_bytes.data(), app_sid_bytes.size(), &package_sid_digest) || !mini_lux::sec03::Sha256(reinterpret_cast<const unsigned char*>(job_material.data()), job_material.size(), &job_digest)
    || !mini_lux::sec03::Sha256(reinterpret_cast<const unsigned char*>(root_identity_material.data()), root_identity_material.size(), &root_digest) || !mini_lux::sec03::Sha256(reinterpret_cast<const unsigned char*>(root_access_material.data()), root_access_material.size(), &access_digest)
    || !mini_lux::sec03::Sha256(reinterpret_cast<const unsigned char*>(acl_profile_material.data()), acl_profile_material.size(), &acl_profile_digest) || !mini_lux::sec03::Sha256(reinterpret_cast<const unsigned char*>(environment_names.data()), environment_names.size(), &names_digest)
    || !mini_lux::sec03::Sha256(reinterpret_cast<const unsigned char*>(environment_values.data()), environment_values.size(), &values_digest) || !mini_lux::sec03::Sha256(reinterpret_cast<const unsigned char*>(transcript.data()), transcript.size(), &transcript_digest)
    || !mini_lux::sec03::Sha256(reinterpret_cast<const unsigned char*>(empty.data()), empty.size(), &input_digest_set_digest)) return false;
  if (failure_stage) *failure_stage = 4;
  std::array<wchar_t, MAX_PATH> windows_path{}, system_volume_path{}; std::array<wchar_t, 32> system_filesystem{}; DWORD system_serial = 0; const UINT windows_count = GetWindowsDirectoryW(windows_path.data(), static_cast<UINT>(windows_path.size()));
  const bool root_observation_ok = windows_count && windows_count < windows_path.size() && GetVolumePathNameW(windows_path.data(), system_volume_path.data(), static_cast<DWORD>(system_volume_path.size())) && GetVolumeInformationW(system_volume_path.data(), nullptr, 0, &system_serial, nullptr, nullptr, system_filesystem.data(), static_cast<DWORD>(system_filesystem.size())) && _wcsicmp(system_filesystem.data(), L"NTFS") == 0;
  if (!root_observation_ok) return false; if (failure_stage) *failure_stage = 5; const bool root_same_system_volume = grant.identity.dwVolumeSerialNumber == system_serial; const bool root_has_space = grant.path.find(L' ') != std::wstring::npos; const bool root_has_non_ascii = std::any_of(grant.path.begin(), grant.path.end(), [](wchar_t c) { return c > 0x7f; });
  const std::string proof = std::string("v=1\nkind=execution-proof\nkeyId=") + key.key_id + "\ncandidate=" + candidate->scalar + "\nbuildIdSha256=" + build->scalar + "\nsourceSha256=" + source->scalar + "\nhostSha256=" + host->scalar + "\nlauncher=" + launcher->scalar
    + "\nexecution=" + execution->scalar + "\ncontext=" + context->scalar + "\nsession=" + session->scalar + "\nrun=" + run->scalar + "\nauthorityEpoch=" + authority->scalar + "\nprofile=" + profile->scalar + "\npayloadDigest=" + payload->scalar
    + "\ntokenIsAppContainer=0\npackageSidSha256=" + package_sid_digest + "\ncapabilityCount=0\nlowIntegrity=0\njobConstrained=0\njobPolicySha256=" + job_digest + "\njobBreakawayAllowed=0\njobSilentBreakawayAllowed=0\nactiveProcessZero=1\nprocessStarts=0\nobservedProcessCount=0\nobservedDescendantCount=0\ndescendantValidationFailures=0\naclMutations=0\nstdinWrites=0\ninputDigestSetSha256=" + input_digest_set_digest
    + "\nconpty=0\nconptyMerged=0\nexecutableLease=" + (profile->scalar == "script" ? "1" : "0") + "\nsentinelHandleInheritable=0\nsentinelHandleListed=0\nsentinelHandleObserved=0\nsentinelProbeWin32=0\nunlistedSentinelBlocked=0\nhostDupOpenWin32=0\njobHandleInheritable=0\ncontrolHandleInheritable=0\njobHandleDuplicateWin32=0\ncontrolHandleDuplicateWin32=0\njobHandleDuplicateBlocked=0\ncontrolHandleDuplicateBlocked=0\npostAclRootDeleteOpenWin32=0\npostAclCwdDeleteOpenWin32=0\npostAclReplacementBlocked=0\nprocessCreatedSuspended=0\npostCreateRootDeleteOpenWin32=0\npostCreateCwdDeleteOpenWin32=0\npostCreateReplacementBlocked=0\npreResumePathIdentityMatch=0\nresumeAfterRecheck=0\nchildExit=0\ncompletionReason=" + reason + "\nprotocolSubcode=none\naggregateOutputBytes=0\ncleanupComplete=1\nhandlesDrained=1\ntreeTerminated=1\nrootIdentityDigest=" + root_digest + "\nrootAccessProfileSha256=" + access_digest + "\nrootFixedNtfs=1\nrootSameSystemVolume=" + (root_same_system_volume ? "1" : "0") + "\nrootHasSpace=" + (root_has_space ? "1" : "0") + "\nrootHasNonAscii=" + (root_has_non_ascii ? "1" : "0")
    + "\nenvironmentNameDigest=" + names_digest + "\nenvironmentValueDigest=" + values_digest + "\nambientLeakCount=0\nnetworkMode=deny\nnetworkAcceptedCount=0\naclProfileSha256=" + acl_profile_digest + "\ntranscriptSha256=" + transcript_digest + "\n";
  std::map<std::string, std::string> fields; if (!mini_lux::sec03::ParseCanonicalProof(proof, candidate->scalar, build->scalar, source->scalar, host->scalar, launcher->scalar, key.key_id, &fields)) { if (failure_stage) *failure_stage = 6; return false; }
  if (failure_stage) *failure_stage = 7; return EmitNativeProof(key, proof);
}

struct FixedAdversarySpec { const char* variant; const char* profile; const wchar_t* mode; const char* expected_code; };
bool FixedAclReceiptTuple(const std::string& tuple, const std::string& entry, const std::string& profile) {
  const std::map<std::string, std::string> profiles = {{"E1","one-shot-shell"},{"E2","agent-shell"},{"E3","script"},{"E4","manual-terminal"}}; const auto expected = profiles.find(entry);
  if (expected == profiles.end() || profile != expected->second) return false; return tuple == "A09-06/" + entry || tuple == "A09-07/" + entry || tuple == "A14-01/" + entry || tuple == "A14-02/" + entry || tuple == "A14-05/" + entry;
}

const FixedAdversarySpec* FindFixedAdversary(const std::string& tuple) {
  static constexpr std::array<FixedAdversarySpec, 9> specs = {{
    {"A06-01","E3A",L"lineage-direct","OBS_JOB_EMPTY"},{"A06-02","E3A",L"lineage-grandchild","OBS_JOB_EMPTY"},{"A06-03","E3A",L"lineage-detached","OBS_JOB_EMPTY"},{"A06-04","E3A",L"lineage-background","OBS_JOB_EMPTY"},
    {"A07-01","E3A",L"breakaway-explicit","EXEC_BREAKAWAY_DENIED"},{"A07-02","E3A",L"breakaway-silent","EXEC_BREAKAWAY_DENIED"},{"A07-03","E3A",L"nested-job","EXEC_JOB_INCOMPATIBLE"},
    {"A08-02","E3A",L"limit-active-process","EXEC_LIMIT_ACTIVE_PROCESS"},{"A08-04","E3A",L"limit-job-memory","EXEC_LIMIT_JOB_MEMORY"},
  }};
  const auto slash = tuple.find('/'); if (slash == std::string::npos || tuple.find('/', slash + 1) != std::string::npos) return nullptr;
  for (const auto& spec : specs) if (tuple.substr(0, slash) == spec.variant && tuple.substr(slash + 1) == spec.profile) return &spec; return nullptr;
}

bool FixedChildBoundary(const std::string& expected_sid_digest) {
  BOOL in_job = FALSE; if (!IsProcessInJob(GetCurrentProcess(), nullptr, &in_job) || !in_job) return false;
  Handle token; token.value = nullptr; if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token.value)) return false;
  DWORD bytes = 0; GetTokenInformation(token.value, TokenAppContainerSid, nullptr, 0, &bytes); std::vector<unsigned char> storage(bytes); if (!bytes || !GetTokenInformation(token.value, TokenAppContainerSid, storage.data(), bytes, &bytes)) return false;
  auto* sid = reinterpret_cast<TOKEN_APPCONTAINER_INFORMATION*>(storage.data())->TokenAppContainer; if (!sid || !IsValidSid(sid)) return false; std::string digest; return mini_lux::sec03::Sha256(static_cast<const unsigned char*>(sid), GetLengthSid(sid), &digest) && digest == expected_sid_digest;
}

bool FixedChildModeAllowed(const FixedAdversarySpec& spec, const std::wstring& mode) {
  if (mode == spec.mode) return true;
  const std::string variant(spec.variant);
  if (variant == "A06-01" || variant == "A06-03" || variant == "A06-04" || variant == "A07-01" || variant == "A07-02" || variant == "A08-02") return mode == L"leaf";
  if (variant == "A06-02") return mode == L"lineage-direct" || mode == L"leaf";
  if (variant == "A08-04") return mode == L"allocate";
  return false;
}

bool ParseFixedChildState(const std::string& state, const std::wstring& mode, std::string* sid) {
  static constexpr std::array<const char*, 5> keys = {"v", "tuple", "secret", "stateMac", "sid"};
  std::map<std::string, std::string> fields; size_t start = 0;
  for (const char* key : keys) {
    const size_t end = state.find('\n', start); if (end == std::string::npos || end == start) return false;
    const std::string line = state.substr(start, end - start); const size_t equal = line.find('=');
    if (equal == std::string::npos || line.find('=', equal + 1) != std::string::npos || line.substr(0, equal) != key) return false;
    fields.emplace(key, line.substr(equal + 1)); start = end + 1;
  }
  const FixedAdversarySpec* spec = FindFixedAdversary(fields["tuple"]);
  if (start != state.size() || fields.size() != keys.size() || fields["v"] != "1" || !spec || !FixedChildModeAllowed(*spec, mode)
    || !mini_lux::sec03::CanonicalHex(fields["secret"], 32, 32) || fields["secret"] == std::string(64, '0')
    || !mini_lux::sec03::CanonicalHex(fields["stateMac"], 32, 32) || !mini_lux::sec03::CanonicalHex(fields["sid"], 32, 32)) return false;
  *sid = fields["sid"]; return true;
}

std::string g_fixed_child_state;
DWORD SpawnFixedSelf(const wchar_t* mode, DWORD flags, bool wait, bool* in_job) {
  std::array<wchar_t, 32768> image{}; const DWORD count = GetModuleFileNameW(nullptr, image.data(), static_cast<DWORD>(image.size())); if (!count || count >= image.size()) return ERROR_FILE_NOT_FOUND;
  SECURITY_ATTRIBUTES inheritable{sizeof(inheritable), nullptr, TRUE}; HANDLE state_read = nullptr, state_write = nullptr; Handle null_output;
  if (!CreatePipe(&state_read, &state_write, &inheritable, 0)) return GetLastError(); SetHandleInformation(state_write, HANDLE_FLAG_INHERIT, 0);
  null_output.value = CreateFileW(L"NUL", GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE, &inheritable, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (null_output.value == INVALID_HANDLE_VALUE) { const DWORD error = GetLastError(); CloseHandle(state_read); CloseHandle(state_write); return error; }
  std::wstring command = L"\"" + std::wstring(image.data(), count) + L"\" --sec03-fixed-child " + mode; PROCESS_INFORMATION child{}; STARTUPINFOEXW startup{}; startup.StartupInfo.cb = sizeof(startup); startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES; startup.StartupInfo.hStdInput = state_read; startup.StartupInfo.hStdOutput = null_output.value; startup.StartupInfo.hStdError = null_output.value;
  SIZE_T bytes = 0; InitializeProcThreadAttributeList(nullptr, 1, 0, &bytes); std::vector<unsigned char> storage(bytes); startup.lpAttributeList = reinterpret_cast<PPROC_THREAD_ATTRIBUTE_LIST>(storage.data()); HANDLE inherited[] = {state_read, null_output.value};
  const bool attributes = InitializeProcThreadAttributeList(startup.lpAttributeList, 1, 0, &bytes) && UpdateProcThreadAttribute(startup.lpAttributeList, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, inherited, sizeof(inherited), nullptr, nullptr);
  const BOOL created = attributes && CreateProcessW(image.data(), command.data(), nullptr, nullptr, TRUE, CREATE_NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT | flags, nullptr, nullptr, &startup.StartupInfo, &child); const DWORD error = created ? ERROR_SUCCESS : GetLastError();
  if (startup.lpAttributeList) DeleteProcThreadAttributeList(startup.lpAttributeList); CloseHandle(state_read);
  if (!created) { CloseHandle(state_write); return error; }
  WriteExact(state_write, g_fixed_child_state.data(), static_cast<DWORD>(g_fixed_child_state.size())); CloseHandle(state_write);
  if (in_job) { BOOL member = FALSE; *in_job = IsProcessInJob(child.hProcess, nullptr, &member) && member; }
  CloseHandle(child.hThread); if (wait) WaitForSingleObject(child.hProcess, 5000); CloseHandle(child.hProcess); return ERROR_SUCCESS;
}

int RunFixedChild(const std::wstring& mode) {
  std::string state; std::array<char, 512> buffer{}; for (;;) { DWORD got = 0; if (!ReadFile(GetStdHandle(STD_INPUT_HANDLE), buffer.data(), static_cast<DWORD>(buffer.size()), &got, nullptr)) { if (GetLastError() == ERROR_BROKEN_PIPE) break; return 90; } if (!got) break; state.append(buffer.data(), got); if (state.size() > 2048) return 90; }
  std::string sid; if (!ParseFixedChildState(state, mode, &sid) || !FixedChildBoundary(sid)) return 91;
  g_fixed_child_state = state;
  if (mode == L"leaf") { Sleep(250); return 0; }
  if (mode == L"allocate") { std::vector<unsigned char> memory(64u << 20, 1); Sleep(30000); return memory[0]; }
  if (mode == L"lineage-direct") return static_cast<int>(SpawnFixedSelf(L"leaf", 0, true, nullptr));
  if (mode == L"lineage-grandchild") return static_cast<int>(SpawnFixedSelf(L"lineage-direct", 0, true, nullptr));
  if (mode == L"lineage-detached") return static_cast<int>(SpawnFixedSelf(L"leaf", DETACHED_PROCESS, true, nullptr));
  if (mode == L"lineage-background") return static_cast<int>(SpawnFixedSelf(L"leaf", 0, false, nullptr));
  if (mode == L"breakaway-explicit") return static_cast<int>(SpawnFixedSelf(L"leaf", CREATE_BREAKAWAY_FROM_JOB, false, nullptr));
  if (mode == L"breakaway-silent") { bool member = false; const DWORD error = SpawnFixedSelf(L"leaf", 0, true, &member); return static_cast<int>(error == ERROR_SUCCESS && member ? ERROR_SUCCESS : error ? error : ERROR_ACCESS_DENIED); }
  if (mode == L"nested-job") {
    Handle first(CreateJobObjectW(nullptr, nullptr)), second(CreateJobObjectW(nullptr, nullptr)); JOBOBJECT_BASIC_UI_RESTRICTIONS ui{JOB_OBJECT_UILIMIT_HANDLES};
    if (!first.value || !second.value || !SetInformationJobObject(first.value, JobObjectBasicUIRestrictions, &ui, sizeof(ui)) || !AssignProcessToJobObject(first.value, GetCurrentProcess()) || !SetInformationJobObject(second.value, JobObjectBasicUIRestrictions, &ui, sizeof(ui))) return static_cast<int>(GetLastError());
    if (AssignProcessToJobObject(second.value, GetCurrentProcess())) return ERROR_SUCCESS; return static_cast<int>(GetLastError());
  }
  if (mode == L"limit-active-process") { SpawnFixedSelf(L"leaf", 0, false, nullptr); Sleep(30000); return 0; }
  if (mode == L"limit-job-memory") { for (unsigned i = 0; i < 4; ++i) SpawnFixedSelf(L"allocate", 0, false, nullptr); Sleep(30000); return 0; }
  return 92;
}


int Run() {
  SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX | SEM_NOOPENFILEERRORBOX);
  const HANDLE host_control = GetStdHandle(STD_INPUT_HANDLE); DWORD control_flags = 0;
  const bool control_handle_private = host_control && host_control != INVALID_HANDLE_VALUE
    && SetHandleInformation(host_control, HANDLE_FLAG_INHERIT, 0)
    && GetHandleInformation(host_control, &control_flags) && (control_flags & HANDLE_FLAG_INHERIT) == 0;
  if (!control_handle_private) { Failure("EXEC_NATIVE_PRIMITIVE_UNAVAILABLE:control-handle"); return 72; }
  std::string wire; const FrameReadResult launch_frame = ReadFrame(&wire); if (launch_frame != FrameReadResult::ok) { Failure(launch_frame == FrameReadResult::oversize ? "EXEC_PROTOCOL_INVALID:oversize" : "EXEC_PROTOCOL_INVALID:length"); return 71; }
  Json request; Parser launch_parser(wire); if (!launch_parser.Parse(&request) || request.kind != Json::Kind::object) { const std::string detail = "EXEC_PROTOCOL_INVALID:" + (launch_parser.error().empty() ? std::string("state") : launch_parser.error()); Failure(detail.c_str()); return 71; }
  if (!ExactLaunchKeys(request)) { Failure("EXEC_PROTOCOL_INVALID:unknown-key"); return 71; }
  const Json* version = Field(request, "v", Json::Kind::number); const Json* candidate = Field(request, "candidateId", Json::Kind::string); const Json* build = Field(request, "buildIdSha256", Json::Kind::string); const Json* source = Field(request, "sourceSha256", Json::Kind::string); const Json* host = Field(request, "hostSha256", Json::Kind::string); const Json* launcher = Field(request, "launcherSha256", Json::Kind::string); const Json* type = Field(request, "type", Json::Kind::string); const Json* secret = Field(request, "secret", Json::Kind::string); const Json* entry = Field(request, "entryPoint", Json::Kind::string); const Json* profile = Field(request, "profile", Json::Kind::string); const Json* execution = Field(request, "executionId", Json::Kind::string); const Json* context = Field(request, "contextId", Json::Kind::string); const Json* session = Field(request, "sessionId", Json::Kind::string); const Json* run_id = Field(request, "runId", Json::Kind::string); const Json* authority = Field(request, "authorityEpoch", Json::Kind::number); const Json* payload = Field(request, "payload", Json::Kind::string); const Json* payload_digest = Field(request, "payloadDigest", Json::Kind::string); const Json* roots = Field(request, "roots", Json::Kind::array); const Json* root_handles = Field(request, "rootHandles", Json::Kind::array); const Json* executable_json = Field(request, "executable", Json::Kind::object); const Json* executable_handle_json = request.object.count("executableHandle") ? &request.object.at("executableHandle") : nullptr; const Json* environment = Field(request, "environment", Json::Kind::object); const Json* limits_json = Field(request, "limits", Json::Kind::object); const Json* network = Field(request, "network", Json::Kind::object);
  auto hash = [](const Json* value) { return value && mini_lux::sec03::CanonicalHex(value->scalar, 32, 32); }; std::uint64_t authority_epoch = 0;
  if (!version || version->scalar != "1" || !hash(candidate) || !hash(build) || !hash(source) || !hash(host) || !hash(launcher) || !execution || !context || !session || !run_id || !mini_lux::sec03::BoundedId(execution->scalar) || !mini_lux::sec03::BoundedId(context->scalar) || !mini_lux::sec03::BoundedId(session->scalar) || !mini_lux::sec03::BoundedId(run_id->scalar) || !authority || !mini_lux::sec03::Decimal(authority->scalar, &authority_epoch) || !authority_epoch || !type || type->scalar != "launch" || !secret || !mini_lux::sec03::CanonicalHex(secret->scalar, 32, 32) || secret->scalar == std::string(64, '0')) { Failure("EXEC_PROTOCOL_INVALID:secret"); return 71; }
  std::string attestation_binding; mini_lux::sec03::AttestationKey attestation_key;
  if (mini_lux::sec03::AttestationBindingDigest(candidate->scalar, build->scalar, source->scalar, host->scalar, launcher->scalar, &attestation_binding)) mini_lux::sec03::LoadAttestationKey(attestation_binding, launcher->scalar, &attestation_key);
  const Json* fixed_tuple = Field(request, "fixedAdversary", Json::Kind::string); const Json* fixed_state_mac = Field(request, "fixedStateMac", Json::Kind::string); const FixedAdversarySpec* fixed_spec = fixed_tuple ? FindFixedAdversary(fixed_tuple->scalar) : nullptr;
  const bool fixed_acl_tuple = fixed_tuple && entry && profile && FixedAclReceiptTuple(fixed_tuple->scalar, entry->scalar, profile->scalar);
  bool fixed_authenticated = false;
  if (fixed_tuple || fixed_state_mac) {
    std::vector<unsigned char> received; std::array<unsigned char, 32> expected{}; const bool fixed_known = fixed_spec || fixed_acl_tuple;
    const std::string material = fixed_known ? mini_lux::sec03::FixedAdversaryStateMaterial(fixed_tuple->scalar, secret->scalar, candidate->scalar, build->scalar, source->scalar, host->scalar, launcher->scalar, execution->scalar, run_id->scalar) : std::string{};
    fixed_authenticated = fixed_known && fixed_state_mac && attestation_key.available && mini_lux::sec03::CanonicalHex(fixed_state_mac->scalar, 32, 32) && mini_lux::sec03::Unhex(fixed_state_mac->scalar, &received) && received.size() == expected.size()
      && mini_lux::sec03::HmacSha256(attestation_key, reinterpret_cast<const unsigned char*>(material.data()), material.size(), &expected) && mini_lux::sec03::ConstantTimeEqual(expected.data(), received.data(), expected.size());
    if (!fixed_authenticated) { Failure("EXEC_PROTOCOL_INVALID:fixed-adversary-state"); return 71; }
  }
#ifdef MINI_LUX_SEC03_NATIVE_TEST
  const Json* test_crash = Field(request, "testCrash", Json::Kind::string); if (!test_crash || (test_crash->scalar != "none" && test_crash->scalar != "prepared" && test_crash->scalar != "applied" && test_crash->scalar != "job-zero" && test_crash->scalar != "hold-applied" && test_crash->scalar != "descendant-applied" && test_crash->scalar != "barrier-prepared-hold-applied" && test_crash->scalar != "force-active-process-proof-failure" && test_crash->scalar != "journal-delete-newest")) { Failure("EXEC_PROTOCOL_INVALID:test-crash"); return 71; } g_test_crash = test_crash->scalar;
#endif
  const bool is_e1 = entry && profile && entry->scalar == "E1" && profile->scalar == "one-shot-shell";
  const bool is_e2 = entry && profile && entry->scalar == "E2" && profile->scalar == "agent-shell";
  const bool is_e3 = entry && profile && entry->scalar == "E3" && profile->scalar == "script";
  const bool is_e4 = entry && profile && entry->scalar == "E4" && profile->scalar == "manual-terminal";
  const bool is_e3a = entry && profile && entry->scalar == "E3A" && profile->scalar == "fixed-adversary";
  const bool is_fixed_adversary = fixed_authenticated && fixed_spec && entry && std::string(fixed_spec->profile) == entry->scalar && (is_e3a || is_e1 || is_e2 || is_e4);
  const bool is_fixed_acl_receipt = fixed_authenticated && fixed_acl_tuple && !fixed_spec && (is_e1 || is_e2 || is_e3 || is_e4);
  g_fixed_acl_conflict = is_fixed_acl_receipt && fixed_tuple->scalar.rfind("A14-05/", 0) == 0; g_fixed_acl_crash_variant = is_fixed_acl_receipt && fixed_tuple->scalar.rfind("A14-01/", 0) == 0 ? "A14-01" : is_fixed_acl_receipt && fixed_tuple->scalar.rfind("A14-02/", 0) == 0 ? "A14-02" : "";
  const bool persistent = !is_fixed_adversary && (is_e2 || is_e4); if (!is_e1 && !is_e2 && !is_e3 && !is_e4 && !is_e3a) { Failure("EXEC_NATIVE_PRIMITIVE_UNAVAILABLE:profile"); return 72; }
  if ((fixed_spec != nullptr) != is_fixed_adversary || fixed_acl_tuple != is_fixed_acl_receipt || (is_e3a && !is_fixed_adversary)) { Failure("EXEC_PROTOCOL_INVALID:fixed-adversary-tuple"); return 71; }
  const Json* executable_kind = executable_json ? Field(*executable_json, "kind", Json::Kind::string) : nullptr; const Json* executable_index = executable_json ? Field(*executable_json, "handleIndex", Json::Kind::number) : nullptr;
  const std::string expected_executable_kind = is_fixed_adversary ? "fixed-adversary-self" : is_e3 ? "current-node" : "fixed-system";
  if (!executable_json || !ExactKeys(*executable_json, {"handleIndex", "kind"}) || !executable_kind || !executable_index || executable_index->scalar != "-1" || executable_kind->scalar != expected_executable_kind) { Failure("EXEC_PROTOCOL_INVALID:executable-profile"); return 71; }
  const Json* mode = network && ExactKeys(*network, {"mode"}) ? Field(*network, "mode", Json::Kind::string) : nullptr; if (!mode || mode->scalar != "deny") { Failure(persistent ? "EXEC_NETWORK_PROFILE_UNSUPPORTED" : "EXEC_NATIVE_PRIMITIVE_UNAVAILABLE:network"); return 72; }
  if (!payload || !roots || !root_handles || roots->array.empty() || roots->array.size() > 8 || root_handles->array.size() != roots->array.size() || !environment || !limits_json) { Failure("EXEC_PROTOCOL_INVALID:launch"); return 71; }
  RuntimeLimits limits{}; if (!ParseLimits(*limits_json, entry->scalar, &limits)) { Failure("EXEC_PROTOCOL_INVALID:limits"); return 71; }
  if (((is_e1 || persistent) && (!executable_handle_json || executable_handle_json->kind != Json::Kind::null_value)) || (is_e3 && (!executable_handle_json || executable_handle_json->kind != Json::Kind::object))) { Failure("EXEC_PROTOCOL_INVALID:executable-lease"); return 71; }
  std::vector<unsigned char> command_bytes; std::string observed_payload_digest; if (!DecodeBase64(payload->scalar, &command_bytes) || Base64(command_bytes.data(), command_bytes.size()) != payload->scalar || command_bytes.empty() || command_bytes.size() > limits.input || std::find(command_bytes.begin(), command_bytes.end(), 0) != command_bytes.end() || !payload_digest || !mini_lux::sec03::Sha256(command_bytes.data(), command_bytes.size(), &observed_payload_digest) || observed_payload_digest != payload_digest->scalar) { Failure("EXEC_PROTOCOL_INVALID:payload"); return 71; }
  const std::string payload_text(command_bytes.begin(), command_bytes.end()); if (persistent && payload_text != "cmd" && payload_text != "powershell") { Failure("EXEC_PROTOCOL_INVALID:shell"); return 71; }
  const std::wstring command = Wide(payload_text); if (command.empty()) { Failure("EXEC_PROTOCOL_INVALID:utf8"); return 71; }
  Handle executable_lease; BY_HANDLE_FILE_INFORMATION executable_identity{}; std::wstring leased_executable; std::string executable_sha256;
  if (is_e3 && !InheritedExecutable(*executable_handle_json, &executable_lease, &executable_identity, &leased_executable, &executable_sha256)) { Failure("EXEC_NATIVE_IDENTITY_INVALID:executable-lease"); return 76; }
  std::wstring trusted_windows, trusted_system32; if (!NativeRuntimePaths(*environment, is_e3, &trusted_windows, &trusted_system32)) { Failure("EXEC_ENV_INVALID:native-runtime"); return 71; }
  if (is_e3 && environment->object.count("ComSpec")) { Failure("EXEC_PROTOCOL_INVALID:e3-environment"); return 71; }
  const auto electron_env = environment->object.find("ELECTRON_RUN_AS_NODE"); if (is_e3 && electron_env != environment->object.end()) { const auto slash = leased_executable.find_last_of(L"\\/"); const std::wstring name = slash == std::wstring::npos ? leased_executable : leased_executable.substr(slash + 1); if (electron_env->second.kind != Json::Kind::string || electron_env->second.scalar != "1" || _wcsicmp(name.c_str(), L"electron.exe") != 0) { Failure("EXEC_PROTOCOL_INVALID:electron-runtime"); return 71; } }

  const std::wstring profile_name = RandomProfileName(); PSID app_sid = nullptr;
  if (profile_name.empty() || CreateAppContainerProfile(profile_name.c_str(), profile_name.c_str(), L"Mini-Lux SEC-03 one-use sandbox", nullptr, 0, &app_sid) != S_OK || !app_sid) { Failure("EXEC_SANDBOX_LAUNCH_FAILED:profile"); return 73; }
  std::uint64_t host_created = 0; if (!mini_lux::sec03::CurrentProcessCreation(&host_created)) { DeleteAppContainerProfile(profile_name.c_str()); ::LocalFree(app_sid); Failure("EXEC_SANDBOX_LAUNCH_FAILED:host-identity"); return 73; }
  std::vector<unsigned char> app_sid_bytes; std::wstring app_sid_string; if (!mini_lux::sec03::AppPackageSid(app_sid) || !mini_lux::sec03::SidToBytesAndString(app_sid, &app_sid_bytes, &app_sid_string)) { DeleteAppContainerProfile(profile_name.c_str()); ::LocalFree(app_sid); Failure("EXEC_SANDBOX_LAUNCH_FAILED:sid"); return 73; }
  std::string fixed_child_state;
  if (is_fixed_adversary) {
    std::string sid_digest;
    if (!mini_lux::sec03::Sha256(app_sid_bytes.data(), app_sid_bytes.size(), &sid_digest)) { DeleteAppContainerProfile(profile_name.c_str()); ::LocalFree(app_sid); Failure("EXEC_NATIVE_EVIDENCE_UNAVAILABLE:fixed-adversary-sid"); return 72; }
    fixed_child_state = "v=1\ntuple=" + fixed_tuple->scalar + "\nsecret=" + secret->scalar + "\nstateMac=" + fixed_state_mac->scalar + "\nsid=" + sid_digest + "\n";
  }
  std::vector<RootGrant> grants(roots->array.size()); for (auto& grant : grants) { grant.journal.candidate_host_sha256 = host->scalar; grant.journal.launcher_sha256 = launcher->scalar; grant.journal.execution_id = execution->scalar; grant.journal.context_id = context->scalar; grant.journal.session_id = session->scalar; grant.journal.run_id = run_id->scalar; grant.journal.authority_epoch = authority_epoch; grant.journal.profile = profile_name; grant.journal.sid_string = app_sid_string; grant.journal.sid_bytes = app_sid_bytes; grant.journal.host_pid = GetCurrentProcessId(); grant.journal.host_created = host_created; }
  bool roots_ok = true; size_t prepared_roots = 0; for (size_t i = 0; i < roots->array.size(); ++i) { if (roots->array[i].kind != Json::Kind::object || root_handles->array[i].kind != Json::Kind::object || !PrepareRoot(roots->array[i], root_handles->array[i], app_sid, &grants[i])) { roots_ok = false; break; } ++prepared_roots; }
  if (!roots_ok) {
    RootGrant& failed = grants[prepared_roots]; const bool propagation_denial = prepared_roots == 0 && failed.stage == 585 && failed.preflight_failure == RootPreflightFailure::acl_protected && failed.journal.generation == 0 && failed.acl_mutations == 0;
    const bool sharing_denial = prepared_roots == 0 && failed.stage == 586 && failed.preflight_failure == RootPreflightFailure::acl_sharing && failed.journal.generation == 0 && failed.acl_mutations == 0;
    const bool conflict_denial = prepared_roots == 0 && failed.stage == 6 && failed.preflight_failure == RootPreflightFailure::acl_conflict && failed.journal.generation == 1 && failed.acl_mutations == 0;
    bool failed_clean = true, failed_journal_deleted = true; if (failed.journal.generation > 0) { failed_clean = CleanupRoot(&failed, app_sid); if (conflict_denial && failed_clean) failed_journal_deleted = DeleteJournals(failed); }
    for (size_t i = 0; i < prepared_roots; ++i) CleanupRoot(&grants[i], app_sid);
    const bool profile_deleted = DeleteAppContainerProfile(profile_name.c_str()) == S_OK;
    const char* acl_reason = sharing_denial ? "acl-sharing-failed" : conflict_denial ? "acl-conflict" : "acl-propagation-failed"; unsigned proof_failure_stage = 0;
    const bool proof_emitted = (sharing_denial || propagation_denial || conflict_denial) && failed_clean && failed_journal_deleted && profile_deleted && EmitAclPreflightDenialProof(attestation_key, request, failed, app_sid_bytes, limits, acl_reason, &proof_failure_stage);
    ::LocalFree(app_sid);
    if (proof_emitted) { Failure(sharing_denial ? "EXEC_ACL_SHARING_FAILED" : conflict_denial ? "EXEC_ACL_CONFLICT" : "EXEC_ACL_PROPAGATION_FAILED"); return 74; }
    if ((sharing_denial || propagation_denial || conflict_denial) && profile_deleted) { const std::string detail = std::string("EXEC_NATIVE_EVIDENCE_UNAVAILABLE:") + (sharing_denial ? "acl-sharing-stage-" : conflict_denial ? "acl-conflict-stage-" : "acl-propagation-stage-") + std::to_string(proof_failure_stage); Failure(detail.c_str()); return 72; }
    const std::string detail = std::string("EXEC_ROOT_UNSUPPORTED:stage-") + std::to_string(failed.stage) + "-win32-" + std::to_string(GetLastError()); Failure(detail.c_str()); return 74;
  }
  DWORD post_acl_root_delete_error = ERROR_SHARING_VIOLATION, post_acl_cwd_delete_error = ERROR_SHARING_VIOLATION;
  bool post_acl_replacement_blocked = true;
  for (const auto& grant : grants) {
    const DWORD root_error = ReplacementOpenResult(grant.path), cwd_error = ReplacementOpenResult(grant.cwd_path);
    if (root_error != ERROR_SHARING_VIOLATION) post_acl_root_delete_error = root_error;
    if (cwd_error != ERROR_SHARING_VIOLATION) post_acl_cwd_delete_error = cwd_error;
    if (root_error != ERROR_SHARING_VIOLATION || cwd_error != ERROR_SHARING_VIOLATION || !SameFile(grant.handle.value, grant.identity) || !SameFile(grant.cwd_handle.value, grant.cwd_identity)) post_acl_replacement_blocked = false;
  }
  if (!post_acl_replacement_blocked) { const std::string detail = "EXEC_ROOT_IDENTITY_CHANGED:post-acl-root-" + std::to_string(post_acl_root_delete_error) + "-cwd-" + std::to_string(post_acl_cwd_delete_error); for (auto& grant : grants) CleanupRoot(&grant, app_sid); DeleteAppContainerProfile(profile_name.c_str()); ::LocalFree(app_sid); Failure(detail.c_str()); return 74; }

  Handle job(CreateJobObjectW(nullptr, nullptr)); Handle completion_port(CreateIoCompletionPort(INVALID_HANDLE_VALUE, nullptr, 0, 1)); JOBOBJECT_ASSOCIATE_COMPLETION_PORT association{job.value, completion_port.value}; DWORD job_handle_flags = 0, job_limit_flags = 0;
  if (!job.value || completion_port.value == INVALID_HANDLE_VALUE || !SetInformationJobObject(job.value, JobObjectAssociateCompletionPortInformation, &association, sizeof(association)) || !SetJobLimits(job.value, limits, &job_limit_flags)
    || !GetHandleInformation(job.value, &job_handle_flags) || (job_handle_flags & HANDLE_FLAG_INHERIT) != 0) { for (auto& grant : grants) CleanupRoot(&grant, app_sid); DeleteAppContainerProfile(profile_name.c_str()); ::LocalFree(app_sid); Failure("EXEC_NATIVE_PRIMITIVE_UNAVAILABLE:job"); return 72; }
  SECURITY_ATTRIBUTES inheritable{sizeof(inheritable), nullptr, TRUE}; Handle inheritance_sentinel(CreateEventW(&inheritable, TRUE, FALSE, nullptr)); DWORD sentinel_flags = 0;
  const bool sentinel_ready = inheritance_sentinel.value && GetHandleInformation(inheritance_sentinel.value, &sentinel_flags) && (sentinel_flags & HANDLE_FLAG_INHERIT) != 0;
  HANDLE stdout_read = nullptr, stdout_write = nullptr, stderr_read = nullptr, stderr_write = nullptr, stdin_read = nullptr, stdin_write = nullptr; Handle nul_stdin; HPCON pseudo = nullptr; HANDLE pseudo_input_read = nullptr, pseudo_output_write = nullptr; bool pipes_ok = sentinel_ready;
  if (persistent) {
    pipes_ok = pipes_ok && CreatePipe(&pseudo_input_read, &stdin_write, nullptr, 0) && CreatePipe(&stdout_read, &pseudo_output_write, nullptr, 0) && SUCCEEDED(CreatePseudoConsole(COORD{120, 30}, pseudo_input_read, pseudo_output_write, 0, &pseudo));
    if (pseudo_input_read) { CloseHandle(pseudo_input_read); pseudo_input_read = nullptr; } if (pseudo_output_write) { CloseHandle(pseudo_output_write); pseudo_output_write = nullptr; }
  } else {
    pipes_ok = pipes_ok && CreatePipe(&stdout_read, &stdout_write, &inheritable, 0) && CreatePipe(&stderr_read, &stderr_write, &inheritable, 0);
    if (is_e3 || is_fixed_adversary) pipes_ok = pipes_ok && CreatePipe(&stdin_read, &stdin_write, &inheritable, 0); else { nul_stdin.value = CreateFileW(L"NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, &inheritable, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr); stdin_read = nul_stdin.value; pipes_ok = pipes_ok && stdin_read != INVALID_HANDLE_VALUE; }
    if (stdout_read) SetHandleInformation(stdout_read, HANDLE_FLAG_INHERIT, 0); if (stderr_read) SetHandleInformation(stderr_read, HANDLE_FLAG_INHERIT, 0); if (stdin_write) SetHandleInformation(stdin_write, HANDLE_FLAG_INHERIT, 0);
  }
  if (!pipes_ok) { if (pseudo) ClosePseudoConsole(pseudo); for (HANDLE h : {stdout_read, stdout_write, stderr_read, stderr_write, stdin_write, pseudo_input_read, pseudo_output_write}) if (h) CloseHandle(h); if ((is_e3 || is_fixed_adversary) && stdin_read) CloseHandle(stdin_read); for (auto& grant : grants) CleanupRoot(&grant, app_sid); DeleteAppContainerProfile(profile_name.c_str()); ::LocalFree(app_sid); Failure("EXEC_SANDBOX_LAUNCH_FAILED:pipes"); return 73; }
  Json exact_environment = *environment; exact_environment.object.at("SystemRoot").scalar = Utf8(trusted_windows); exact_environment.object.at("WINDIR").scalar = Utf8(trusted_windows); exact_environment.object.at("PATH").scalar = Utf8(trusted_system32); if (!is_e3) exact_environment.object.at("ComSpec").scalar = Utf8(trusted_system32 + L"\\cmd.exe");
  size_t aliases = 0; for (const auto& [key, ignored] : exact_environment.object) if (key.rfind("MINI_LUX_ROOT_", 0) == 0) ++aliases; if (aliases != grants.size()) pipes_ok = false;
  for (size_t i = 0; pipes_ok && i < grants.size(); ++i) { const std::string key = "MINI_LUX_ROOT_" + std::to_string(i); const auto found = exact_environment.object.find(key); const std::string trusted = Utf8(grants[i].path); if (found == exact_environment.object.end() || found->second.kind != Json::Kind::string || trusted.empty()) pipes_ok = false; else found->second.scalar = trusted; }
  if (is_e3 || is_fixed_adversary) { const std::string trusted_root = Utf8(grants[0].path); for (const char* key : {"TEMP", "TMP", "USERPROFILE", "HOME", "APPDATA", "LOCALAPPDATA"}) { const auto found = exact_environment.object.find(key); if (found == exact_environment.object.end() || found->second.kind != Json::Kind::string || trusted_root.empty()) pipes_ok = false; else found->second.scalar = trusted_root; } }
  std::vector<wchar_t> env; if (!pipes_ok || !BuildEnvironment(exact_environment, &env)) { if (pseudo) ClosePseudoConsole(pseudo); for (HANDLE h : {stdout_read, stdout_write, stderr_read, stderr_write, stdin_write}) if (h) CloseHandle(h); if ((is_e3 || is_fixed_adversary) && stdin_read) CloseHandle(stdin_read); for (auto& grant : grants) CleanupRoot(&grant, app_sid); DeleteAppContainerProfile(profile_name.c_str()); ::LocalFree(app_sid); Failure("EXEC_PROTOCOL_INVALID:environment"); return 71; }

  std::wstring executable = is_e3 ? leased_executable : trusted_system32 + L"\\cmd.exe"; Handle fixed_executable; BY_HANDLE_FILE_INFORMATION fixed_identity{}; std::string fixed_digest; FixedImageGrant fixed_image_grant;
  if (is_fixed_adversary) { std::array<wchar_t, 32768> image{}; const DWORD count = GetModuleFileNameW(nullptr, image.data(), static_cast<DWORD>(image.size())); if (count && count < image.size()) executable.assign(image.data(), count); }
  if (persistent && payload_text == "powershell") executable = trusted_windows + L"\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
  const DWORD fixed_access = is_fixed_adversary ? GENERIC_READ | FILE_READ_ATTRIBUTES | READ_CONTROL | WRITE_DAC | SYNCHRONIZE : GENERIC_READ | FILE_READ_ATTRIBUTES;
  if ((persistent || is_fixed_adversary) && !FixedExecutable(executable, &fixed_executable, &fixed_identity, &fixed_digest, fixed_access)) { if (pseudo) ClosePseudoConsole(pseudo); CloseHandle(stdout_read); CloseHandle(stdin_write); for (auto& grant : grants) CleanupRoot(&grant, app_sid); DeleteAppContainerProfile(profile_name.c_str()); ::LocalFree(app_sid); Failure("EXEC_NATIVE_IDENTITY_INVALID:fixed-shell"); return 76; }
  if (is_fixed_adversary) {
    fixed_image_grant.journal.candidate_host_sha256 = host->scalar; fixed_image_grant.journal.launcher_sha256 = launcher->scalar; fixed_image_grant.journal.execution_id = execution->scalar; fixed_image_grant.journal.context_id = context->scalar; fixed_image_grant.journal.session_id = session->scalar; fixed_image_grant.journal.run_id = run_id->scalar; fixed_image_grant.journal.authority_epoch = authority_epoch; fixed_image_grant.journal.profile = profile_name; fixed_image_grant.journal.sid_string = app_sid_string; fixed_image_grant.journal.sid_bytes = app_sid_bytes; fixed_image_grant.journal.host_pid = GetCurrentProcessId(); fixed_image_grant.journal.host_created = host_created;
    if (!PrepareFixedImageGrant(fixed_executable.value, fixed_identity, app_sid, &fixed_image_grant)) { if (!fixed_image_grant.exact_ace.empty()) CleanupFixedImageGrant(&fixed_image_grant); if (pseudo) ClosePseudoConsole(pseudo); CloseHandle(stdout_read); CloseHandle(stdin_write); for (auto& grant : grants) CleanupRoot(&grant, app_sid); DeleteAppContainerProfile(profile_name.c_str()); ::LocalFree(app_sid); Failure("EXEC_NATIVE_IDENTITY_INVALID:fixed-image-grant"); return 76; }
  }
  std::wstring command_line = persistent ? L"\"" + executable + L"\" /d /q" : L"\"" + executable + L"\" /d /s /c \"" + command + L"\"";
  if (is_fixed_adversary) command_line = L"\"" + executable + L"\" --sec03-fixed-child " + fixed_spec->mode;
  if (is_e3) {
    command_line = L"\"" + executable + L"\" --permission --no-addons --no-global-search-paths";
    for (const auto& grant : grants) {
      const std::wstring node_path = grant.cwd_path.rfind(L"\\\\?\\", 0) == 0 ? grant.cwd_path.substr(4) : grant.cwd_path;
      const std::wstring descendant_pattern = node_path + L"\\*";
      command_line += L" --allow-fs-read=\"" + descendant_pattern + L"\"";
      if (grant.journal.access_mask & (FILE_GENERIC_WRITE | FILE_ADD_FILE | FILE_ADD_SUBDIRECTORY)) command_line += L" --allow-fs-write=\"" + descendant_pattern + L"\"";
    }
    command_line += L" --input-type=module -";
  }
  if (persistent && payload_text == "powershell") command_line = L"\"" + executable + L"\" -NoLogo -NoProfile";
  SECURITY_CAPABILITIES capabilities{}; capabilities.AppContainerSid = app_sid; capabilities.CapabilityCount = 0; STARTUPINFOEXW startup{}; startup.StartupInfo.cb = sizeof(startup);
  const DWORD attribute_count = 2; SIZE_T attribute_bytes = 0; InitializeProcThreadAttributeList(nullptr, attribute_count, 0, &attribute_bytes); std::vector<unsigned char> storage(attribute_bytes); startup.lpAttributeList = reinterpret_cast<PPROC_THREAD_ATTRIBUTE_LIST>(storage.data());
  bool attributes_ok = InitializeProcThreadAttributeList(startup.lpAttributeList, attribute_count, 0, &attribute_bytes) && UpdateProcThreadAttribute(startup.lpAttributeList, 0, PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES, &capabilities, sizeof(capabilities), nullptr, nullptr);
  if (persistent) {
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput = nullptr;
    startup.StartupInfo.hStdOutput = nullptr;
    startup.StartupInfo.hStdError = nullptr;
    attributes_ok = attributes_ok && UpdateProcThreadAttribute(startup.lpAttributeList, 0, PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, pseudo, sizeof(pseudo), nullptr, nullptr);
  } else { startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES; startup.StartupInfo.hStdInput = stdin_read; startup.StartupInfo.hStdOutput = stdout_write; startup.StartupInfo.hStdError = stderr_write; HANDLE inherited[] = {stdin_read, stdout_write, stderr_write}; attributes_ok = attributes_ok && UpdateProcThreadAttribute(startup.lpAttributeList, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, inherited, sizeof(inherited), nullptr, nullptr); }
  std::wstring process_cwd; const bool process_cwd_ok = ProcessCurrentDirectory(grants[0].cwd_path, &process_cwd);
  const unsigned long long launch_started = GetTickCount64(); PROCESS_INFORMATION process{}; const BOOL created = attributes_ok && process_cwd_ok && CreateProcessW(executable.c_str(), command_line.data(), nullptr, nullptr, persistent ? FALSE : TRUE, EXTENDED_STARTUPINFO_PRESENT | CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | (persistent ? 0 : DETACHED_PROCESS), env.data(), process_cwd.c_str(), &startup.StartupInfo, &process);
  if (startup.lpAttributeList) DeleteProcThreadAttributeList(startup.lpAttributeList); if (stdout_write) CloseHandle(stdout_write); if (stderr_write) CloseHandle(stderr_write); if ((is_e3 || is_fixed_adversary) && stdin_read) CloseHandle(stdin_read);
  const DWORD create_error = created ? ERROR_SUCCESS : GetLastError(); DWORD sentinel_probe_error = ERROR_INVALID_HANDLE; bool sentinel_observed = false;
  const bool unlisted_sentinel_blocked = created && ObserveUnlistedSentinel(process.hProcess, inheritance_sentinel.value, &sentinel_probe_error, &sentinel_observed) && !sentinel_observed;
  const bool assigned = created && unlisted_sentinel_blocked && AssignProcessToJobObject(job.value, process.hProcess); const bool token_job = assigned && VerifyTokenAndJob(process.hProcess, app_sid, job.value);
  HandleDuplicationObservation handle_duplication{}; const bool sensitive_handle_duplication_blocked = token_job && ObserveChildTokenHandleDuplication(process.hProcess, job.value, host_control, &handle_duplication);
  bool roots_stable = true; for (const auto& grant : grants) { if (!SameFile(grant.handle.value, grant.identity) || !SameFile(grant.cwd_handle.value, grant.cwd_identity)) roots_stable = false; for (const auto& object : grant.descendants) if (!StableDescendantClassification(object) || !VerifyDescendantAcl(object, app_sid, grant.journal.access_mask, object.eligible)) roots_stable = false; }
  DWORD post_create_root_delete_error = ERROR_SHARING_VIOLATION, post_create_cwd_delete_error = ERROR_SHARING_VIOLATION;
  bool post_create_replacement_blocked = created && assigned && token_job;
  if (post_create_replacement_blocked) for (const auto& grant : grants) {
    const DWORD root_error = ReplacementOpenResult(grant.path), cwd_error = ReplacementOpenResult(grant.cwd_path);
    if (root_error != ERROR_SHARING_VIOLATION) post_create_root_delete_error = root_error;
    if (cwd_error != ERROR_SHARING_VIOLATION) post_create_cwd_delete_error = cwd_error;
    if (root_error != ERROR_SHARING_VIOLATION || cwd_error != ERROR_SHARING_VIOLATION) post_create_replacement_blocked = false;
  }
  const bool pre_resume_path_identity_match = post_create_replacement_blocked && std::all_of(grants.begin(), grants.end(), [](const RootGrant& grant) { return SamePathMapping(grant.path, grant.identity) && SamePathMapping(grant.cwd_path, grant.cwd_identity); });
  const bool executable_stable = is_e3
    ? created && SameFile(executable_lease.value, executable_identity) && SameProcessExecutable(process.hProcess, executable_identity, executable_sha256)
    : is_fixed_adversary
      ? created && fixed_digest == host->scalar && SameFile(fixed_executable.value, fixed_identity) && SameProcessExecutable(process.hProcess, fixed_identity, fixed_digest)
      : persistent ? created && SameFile(fixed_executable.value, fixed_identity) && SameProcessExecutable(process.hProcess, fixed_identity, fixed_digest) : true;
  const bool constrained = created && assigned && token_job && sensitive_handle_duplication_blocked && roots_stable && post_create_replacement_blocked && pre_resume_path_identity_match && executable_stable;
  bool fixed_input_ok = true;
  if (constrained && is_fixed_adversary) { fixed_input_ok = WriteExact(stdin_write, fixed_child_state.data(), static_cast<DWORD>(fixed_child_state.size())); CloseHandle(stdin_write); stdin_write = nullptr; }
  if (!constrained || !fixed_input_ok || ResumeThread(process.hThread) == static_cast<DWORD>(-1)) { if (created) { TerminateProcess(process.hProcess, 0xE003); CloseHandle(process.hThread); CloseHandle(process.hProcess); } if (pseudo) ClosePseudoConsole(pseudo); if (stdin_write) CloseHandle(stdin_write); if (stdout_read) CloseHandle(stdout_read); if (stderr_read) CloseHandle(stderr_read); if (is_fixed_adversary) RetireFixedImageGrant(&fixed_image_grant); for (auto& grant : grants) CleanupRoot(&grant, app_sid); DeleteAppContainerProfile(profile_name.c_str()); ::LocalFree(app_sid); const std::string detail = "EXEC_SANDBOX_LAUNCH_FAILED:constrain-created-" + std::to_string(created ? 1 : 0) + "-sentinel-" + std::to_string(unlisted_sentinel_blocked ? 1 : 0) + "-sentinel-win32-" + std::to_string(sentinel_probe_error) + "-assigned-" + std::to_string(assigned ? 1 : 0) + "-token-" + std::to_string(token_job ? 1 : 0) + "-handle-dup-" + std::to_string(sensitive_handle_duplication_blocked ? 1 : 0) + "-host-open-" + std::to_string(handle_duplication.host_open_error) + "-roots-" + std::to_string(roots_stable ? 1 : 0) + "-exe-" + std::to_string(executable_stable ? 1 : 0) + "-win32-" + std::to_string(create_error); Failure(detail.c_str()); return 73; }
  bool input_ok = fixed_input_ok; if (is_e3) { input_ok = WriteExact(stdin_write, command_bytes.data(), static_cast<DWORD>(command_bytes.size())); CloseHandle(stdin_write); stdin_write = nullptr; if (!input_ok) TerminateJobObject(job.value, 0xE003); }
  CloseHandle(process.hThread); RuntimeControl control{}; control.job = job.value; control.input = persistent ? stdin_write : nullptr; control.pseudo = persistent ? pseudo : nullptr; control.secret = secret->scalar; control.limits = limits; control.persistent = persistent; control.activity = launch_started; control.stdin_writes = is_e3 ? 1 : 0;
  std::thread controller(ControlMain, &control); std::thread out(Drain, stdout_read, "stdout", &control); std::thread err; if (!persistent) err = std::thread(Drain, stderr_read, "stderr", &control);
  bool root_exited = false, active_process_zero = false;
  unsigned long long observed_process_count = 0, observed_descendant_count = 0, descendant_validation_failures = 0;
  for (;;) {
    DWORD message = 0; ULONG_PTR key = 0; LPOVERLAPPED overlap = nullptr;
    if (GetQueuedCompletionStatus(completion_port.value, &message, &key, &overlap, 25)) {
      do {
        if (message == JOB_OBJECT_MSG_NEW_PROCESS) {
          const DWORD observed_pid = static_cast<DWORD>(reinterpret_cast<ULONG_PTR>(overlap));
          HANDLE observed_process = observed_pid == process.dwProcessId
            ? process.hProcess
            : OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, observed_pid);
          ++observed_process_count;
          if (observed_pid != process.dwProcessId) ++observed_descendant_count;
          if (!observed_process || !VerifyTokenAndJob(observed_process, app_sid, job.value)) ++descendant_validation_failures;
          if (observed_process && observed_process != process.hProcess) CloseHandle(observed_process);
        } else if (message == JOB_OBJECT_MSG_END_OF_JOB_TIME) FailJob(&control, 6);
        else if (message == JOB_OBJECT_MSG_ACTIVE_PROCESS_LIMIT) FailJob(&control, 7);
        else if (message == JOB_OBJECT_MSG_PROCESS_MEMORY_LIMIT) FailJob(&control, 8);
        else if (message == JOB_OBJECT_MSG_JOB_MEMORY_LIMIT) FailJob(&control, 9);
        else if (message == JOB_OBJECT_MSG_ACTIVE_PROCESS_ZERO) active_process_zero = true;
      } while (GetQueuedCompletionStatus(completion_port.value, &message, &key, &overlap, 0));
      if (active_process_zero) break;
    }
    if (!root_exited && WaitForSingleObject(process.hProcess, 0) == WAIT_OBJECT_0) { root_exited = true; TerminateJobObject(job.value, 0xE003); }
    if (!root_exited) {
      const unsigned long long now = GetTickCount64();
      if (control.reason.load() == 0 && now - launch_started >= limits.wall) FailJob(&control, 3);
      if (control.reason.load() == 0 && persistent && now - control.activity.load() >= limits.idle) FailJob(&control, 4);
    }
  }
  if (WaitForSingleObject(process.hProcess, 5000) != WAIT_OBJECT_0) TerminateJobObject(job.value, 0xE003); DWORD child_exit = 0; GetExitCodeProcess(process.hProcess, &child_exit); CloseHandle(process.hProcess);
  JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting{}; for (unsigned i = 0; i < 500; ++i) { if (QueryInformationJobObject(job.value, JobObjectBasicAccountingInformation, &accounting, sizeof(accounting), nullptr) && accounting.ActiveProcesses == 0) break; if (i == 0) TerminateJobObject(job.value, 0xE003); Sleep(10); }
  control.accepting = false; CancelSynchronousIo(controller.native_handle()); controller.join(); if (stdin_write) { CloseHandle(stdin_write); stdin_write = nullptr; }
  if (pseudo) { ClosePseudoConsole(pseudo); pseudo = nullptr; } out.join(); if (err.joinable()) err.join();
#ifdef MINI_LUX_SEC03_NATIVE_TEST
  if (g_test_crash == "force-active-process-proof-failure") { active_process_zero = false; accounting.ActiveProcesses = 1; }
#endif
  bool clean = input_ok && active_process_zero && accounting.ActiveProcesses == 0;
  if (clean) { bool advanced = true; for (auto& grant : grants) if (!AdvanceJournal(&grant, "job-zero")) advanced = false; if (is_fixed_adversary && !AdvanceJournal(&fixed_image_grant, "job-zero")) advanced = false; clean = advanced; }
  if (clean) TestCrash("job-zero");
  if (clean) { bool removed = true; for (auto& grant : grants) { const bool reconciled = CleanupRoot(&grant, app_sid); if (!reconciled || !AdvanceJournal(&grant, "removed")) removed = false; } if (is_fixed_adversary) { const bool reconciled = CleanupFixedImageGrant(&fixed_image_grant); if (!reconciled || !AdvanceJournal(&fixed_image_grant, "removed")) removed = false; } clean = removed; }
  if (clean) { const HRESULT profile_deleted = DeleteAppContainerProfile(profile_name.c_str()); clean = profile_deleted == S_OK; }
  if (clean) { bool deleted = true; for (const auto& grant : grants) if (!DeleteJournals(grant)) deleted = false; if (is_fixed_adversary && !DeleteJournals(fixed_image_grant)) deleted = false; clean = deleted; }
  ::LocalFree(app_sid);
  const std::string evidence = std::string("SEC03_EVIDENCE profile=") + entry->scalar + " appcontainer=1 capabilities=0 job=1 lowIL=1" + (persistent ? " conpty=1 conptyMerged=1 executableLease=1" : (is_e3 || is_fixed_adversary) ? " executableLease=1" : "") + " childExit=" + std::to_string(child_exit) + " completionReason=" + ProofReason(control.reason.load(), clean, child_exit) + "\n"; Output("stderr", reinterpret_cast<const unsigned char*>(evidence.data()), evidence.size());
  if (attestation_key.available) {
    std::string root_identity_material, root_access_material, acl_profile_material, environment_names, environment_values;
    for (const auto& grant : grants) {
      root_identity_material += std::to_string(grant.identity.dwVolumeSerialNumber) + ":" + std::to_string(FileId(grant.identity)) + ":" + std::to_string(grant.cwd_identity.dwVolumeSerialNumber) + ":" + std::to_string(FileId(grant.cwd_identity)) + "\n";
      root_access_material += std::to_string(grant.journal.access_mask) + ":" + grant.journal.acl_digest + "\n"; acl_profile_material += grant.journal.acl_digest + "\n";
    }
    for (const auto& [name, value] : exact_environment.object) { environment_names += name + "\n"; environment_values += name; environment_values.push_back('\0'); environment_values += value.scalar + "\n"; }
    const std::string job_material = std::to_string(limits.active) + ":" + std::to_string(limits.process_memory) + ":" + std::to_string(limits.job_memory) + ":" + std::to_string(limits.cpu) + ":" + std::to_string(limits.job_time) + ":" + std::to_string(limits.wall) + ":" + (limits.has_idle ? std::to_string(limits.idle) : "null") + ":" + std::to_string(limits.aggregate) + ":" + std::to_string(limits.retained) + ":" + std::to_string(limits.input);
    std::string package_sid_digest, job_digest, root_digest, access_digest, acl_profile_digest, names_digest, values_digest, transcript_digest, input_digest_set_digest;
    mini_lux::sec03::Sha256(app_sid_bytes.data(), app_sid_bytes.size(), &package_sid_digest); mini_lux::sec03::Sha256(reinterpret_cast<const unsigned char*>(job_material.data()), job_material.size(), &job_digest); mini_lux::sec03::Sha256(reinterpret_cast<const unsigned char*>(root_identity_material.data()), root_identity_material.size(), &root_digest); mini_lux::sec03::Sha256(reinterpret_cast<const unsigned char*>(root_access_material.data()), root_access_material.size(), &access_digest); mini_lux::sec03::Sha256(reinterpret_cast<const unsigned char*>(acl_profile_material.data()), acl_profile_material.size(), &acl_profile_digest); mini_lux::sec03::Sha256(reinterpret_cast<const unsigned char*>(environment_names.data()), environment_names.size(), &names_digest); mini_lux::sec03::Sha256(reinterpret_cast<const unsigned char*>(environment_values.data()), environment_values.size(), &values_digest); mini_lux::sec03::Sha256(control.transcript.data(), control.transcript.size(), &transcript_digest); mini_lux::sec03::Sha256(reinterpret_cast<const unsigned char*>(control.input_digest_material.data()), control.input_digest_material.size(), &input_digest_set_digest);
    std::array<wchar_t, MAX_PATH> windows_path{}, system_volume_path{}; std::array<wchar_t, 32> system_filesystem{}; DWORD system_serial = 0;
    const UINT windows_count = GetWindowsDirectoryW(windows_path.data(), static_cast<UINT>(windows_path.size()));
    const bool root_observation_ok = windows_count && windows_count < windows_path.size() && GetVolumePathNameW(windows_path.data(), system_volume_path.data(), static_cast<DWORD>(system_volume_path.size())) && GetVolumeInformationW(system_volume_path.data(), nullptr, 0, &system_serial, nullptr, nullptr, system_filesystem.data(), static_cast<DWORD>(system_filesystem.size())) && _wcsicmp(system_filesystem.data(), L"NTFS") == 0;
    const bool root_same_system_volume = root_observation_ok && std::all_of(grants.begin(), grants.end(), [&](const RootGrant& grant) { return grant.identity.dwVolumeSerialNumber == system_serial; });
    const bool root_has_space = std::any_of(grants.begin(), grants.end(), [](const RootGrant& grant) { return grant.path.find(L' ') != std::wstring::npos; });
    const bool root_has_non_ascii = std::any_of(grants.begin(), grants.end(), [](const RootGrant& grant) { return std::any_of(grant.path.begin(), grant.path.end(), [](wchar_t c) { return c > 0x7f; }); });
    std::uint64_t acl_mutations = is_fixed_adversary ? fixed_image_grant.acl_mutations : 0; for (const auto& grant : grants) acl_mutations += grant.acl_mutations;
    if (root_observation_ok) {
      const std::string proof = std::string("v=1\nkind=execution-proof\nkeyId=") + attestation_key.key_id + "\ncandidate=" + candidate->scalar + "\nbuildIdSha256=" + build->scalar + "\nsourceSha256=" + source->scalar + "\nhostSha256=" + host->scalar + "\nlauncher=" + launcher->scalar + "\nexecution=" + execution->scalar + "\ncontext=" + context->scalar + "\nsession=" + session->scalar + "\nrun=" + run_id->scalar + "\nauthorityEpoch=" + authority->scalar + "\nprofile=" + profile->scalar + "\npayloadDigest=" + payload_digest->scalar + "\ntokenIsAppContainer=1\npackageSidSha256=" + package_sid_digest + "\ncapabilityCount=0\nlowIntegrity=1\njobConstrained=1\njobPolicySha256=" + job_digest + "\njobBreakawayAllowed=" + ((job_limit_flags & JOB_OBJECT_LIMIT_BREAKAWAY_OK) ? "1" : "0") + "\njobSilentBreakawayAllowed=" + ((job_limit_flags & JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK) ? "1" : "0") + "\nactiveProcessZero=" + (accounting.ActiveProcesses == 0 ? "1" : "0") + "\nprocessStarts=" + std::to_string(accounting.TotalProcesses) + "\nobservedProcessCount=" + std::to_string(observed_process_count) + "\nobservedDescendantCount=" + std::to_string(observed_descendant_count) + "\ndescendantValidationFailures=" + std::to_string(descendant_validation_failures) + "\naclMutations=" + std::to_string(acl_mutations) + "\nstdinWrites=" + std::to_string(control.stdin_writes.load()) + "\ninputDigestSetSha256=" + input_digest_set_digest + "\nconpty=" + (persistent ? "1" : "0") + "\nconptyMerged=" + (persistent ? "1" : "0") + "\nexecutableLease=" + ((is_e3 || persistent || is_fixed_adversary) ? "1" : "0") + "\nsentinelHandleInheritable=1\nsentinelHandleListed=0\nsentinelHandleObserved=" + (sentinel_observed ? "1" : "0") + "\nsentinelProbeWin32=" + std::to_string(sentinel_probe_error) + "\nunlistedSentinelBlocked=" + (unlisted_sentinel_blocked ? "1" : "0") + "\nhostDupOpenWin32=" + std::to_string(handle_duplication.host_open_error) + "\njobHandleInheritable=" + ((job_handle_flags & HANDLE_FLAG_INHERIT) ? "1" : "0") + "\ncontrolHandleInheritable=" + ((control_flags & HANDLE_FLAG_INHERIT) ? "1" : "0") + "\njobHandleDuplicateWin32=" + std::to_string(handle_duplication.job_duplicate_error) + "\ncontrolHandleDuplicateWin32=" + std::to_string(handle_duplication.control_duplicate_error) + "\njobHandleDuplicateBlocked=" + (handle_duplication.job_blocked ? "1" : "0") + "\ncontrolHandleDuplicateBlocked=" + (handle_duplication.control_blocked ? "1" : "0") + "\npostAclRootDeleteOpenWin32=" + std::to_string(post_acl_root_delete_error) + "\npostAclCwdDeleteOpenWin32=" + std::to_string(post_acl_cwd_delete_error) + "\npostAclReplacementBlocked=" + (post_acl_replacement_blocked ? "1" : "0") + "\nprocessCreatedSuspended=" + (created ? "1" : "0") + "\npostCreateRootDeleteOpenWin32=" + std::to_string(post_create_root_delete_error) + "\npostCreateCwdDeleteOpenWin32=" + std::to_string(post_create_cwd_delete_error) + "\npostCreateReplacementBlocked=" + (post_create_replacement_blocked ? "1" : "0") + "\npreResumePathIdentityMatch=" + (pre_resume_path_identity_match ? "1" : "0") + "\nresumeAfterRecheck=1\nchildExit=" + std::to_string(child_exit) + "\ncompletionReason=" + ProofReason(control.reason.load(), clean, child_exit) + "\nprotocolSubcode=" + control.protocol_subcode + "\naggregateOutputBytes=" + std::to_string(control.aggregate.load()) + "\ncleanupComplete=" + (clean ? "1" : "0") + "\nhandlesDrained=1\ntreeTerminated=" + (accounting.ActiveProcesses == 0 ? "1" : "0") + "\nrootIdentityDigest=" + root_digest + "\nrootAccessProfileSha256=" + access_digest + "\nrootFixedNtfs=1\nrootSameSystemVolume=" + (root_same_system_volume ? "1" : "0") + "\nrootHasSpace=" + (root_has_space ? "1" : "0") + "\nrootHasNonAscii=" + (root_has_non_ascii ? "1" : "0") + "\nenvironmentNameDigest=" + names_digest + "\nenvironmentValueDigest=" + values_digest + "\nambientLeakCount=0\nnetworkMode=deny\nnetworkAcceptedCount=0\naclProfileSha256=" + acl_profile_digest + "\ntranscriptSha256=" + transcript_digest + "\n";
      if (!EmitNativeProof(attestation_key, proof)) Failure("EXEC_NATIVE_EVIDENCE_UNAVAILABLE:proof-publish");
    }
  }
  if (!clean) { Failure("EXEC_SANDBOX_LAUNCH_FAILED:cleanup"); return 75; }
  switch (control.reason.load()) { case 1: Failure("EXEC_PROTOCOL_INVALID:control"); return 71; case 2: return 83; case 3: return 80; case 4: return 81; case 5: return 82; case 6: return 84; case 7: return 85; case 8: return 86; case 9: return 87; case 10: return 88; case 11: return 89; case 12: return 90; case 14: return 92; default: return static_cast<int>(child_exit); }
}
}  // namespace

int wmain(int argc, wchar_t** argv) {
  if (argc == 3 && argv && std::wstring(argv[1]) == L"--sec03-fixed-child") return RunFixedChild(argv[2]);
  if (argc != 1) return 93;
  return Run();
}
