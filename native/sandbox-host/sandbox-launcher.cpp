#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <bcrypt.h>
#include <node_api.h>
#include <delayimp.h>
#include <userenv.h>
#include <winnetwk.h>
#include <tlhelp32.h>
#include <shlobj.h>
#ifdef MINI_LUX_SEC03_NATIVE_TEST
#include <cmath>
#include <cstddef>
#include <iterator>
#endif

#include <array>
#include <atomic>
#include <cstdint>
#include <algorithm>
#include <map>
#include <memory>
#include <mutex>
#include <sstream>
#include <set>
#include <string>
#include <thread>
#include <vector>

#include "protocol.h"
#include "journal.h"
#include "attestation.h"

#pragma comment(lib, "bcrypt.lib")
#pragma comment(lib, "crypt32.lib")
#pragma comment(lib, "advapi32.lib")
#pragma comment(lib, "userenv.lib")
#pragma comment(lib, "shell32.lib")
#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "mpr.lib")

FARPROC WINAPI ResolveNodeExecutable(unsigned notification, PDelayLoadInfo info) {
  if (notification == dliNotePreLoadLibrary && info && info->szDll && _stricmp(info->szDll, "node.exe") == 0) {
    return reinterpret_cast<FARPROC>(GetModuleHandleW(nullptr));
  }
  return nullptr;
}
extern "C" const PfnDliHook __pfnDliNotifyHook2 = ResolveNodeExecutable;

namespace {
constexpr uint32_t kProtocolVersion = 1;
constexpr uint32_t kMaxFrame = 512u * 1024u;

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
  bool Parse(Json* out) { if (!Utf8()) return false; Whitespace(); if (!Value(out, 0)) return false; Whitespace(); return pos_ == text_.size(); }
 private:
  bool Utf8() const { return !text_.empty() && MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text_.data(), static_cast<int>(text_.size()), nullptr, 0) > 0; }
  void Whitespace() { while (pos_ < text_.size() && (text_[pos_] == ' ' || text_[pos_] == '\t' || text_[pos_] == '\r' || text_[pos_] == '\n')) ++pos_; }
  bool Take(const char* value) { const size_t n = strlen(value); if (text_.compare(pos_, n, value)) return false; pos_ += n; return true; }
  bool Value(Json* out, unsigned depth) {
    Whitespace(); if (depth > 20 || pos_ >= text_.size()) return false;
    if (text_[pos_] == '{') return Object(out, depth + 1);
    if (text_[pos_] == '[') return Array(out, depth + 1);
    if (text_[pos_] == '"') { out->kind = Json::Kind::string; return String(&out->scalar); }
    if (Take("true")) { out->kind = Json::Kind::boolean; out->boolean = true; return true; }
    if (Take("false")) { out->kind = Json::Kind::boolean; return true; }
    if (Take("null")) { out->kind = Json::Kind::null_value; return true; }
    return Number(out);
  }
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
      else if (e == 'u') { if (pos_ + 4 > text_.size()) return false; return false; }
      else return false;
    }
    return false;
  }
  bool Number(Json* out) { const size_t start = pos_; if (pos_ < text_.size() && text_[pos_] == '-') ++pos_; if (pos_ >= text_.size() || text_[pos_] < '0' || text_[pos_] > '9') return false; while (pos_ < text_.size() && text_[pos_] >= '0' && text_[pos_] <= '9') ++pos_; if (pos_ < text_.size() && (text_[pos_] == '.' || text_[pos_] == 'e' || text_[pos_] == 'E')) return false; out->kind = Json::Kind::number; out->scalar.assign(text_, start, pos_ - start); return true; }
  bool Array(Json* out, unsigned depth) { out->kind = Json::Kind::array; ++pos_; Whitespace(); if (pos_ < text_.size() && text_[pos_] == ']') { ++pos_; return true; } for (;;) { Json item; if (!Value(&item, depth)) return false; out->array.push_back(std::move(item)); Whitespace(); if (pos_ >= text_.size()) return false; if (text_[pos_] == ']') { ++pos_; return true; } if (text_[pos_++] != ',') return false; } }
  bool Object(Json* out, unsigned depth) { out->kind = Json::Kind::object; ++pos_; Whitespace(); if (pos_ < text_.size() && text_[pos_] == '}') { ++pos_; return true; } for (;;) { Whitespace(); if (pos_ >= text_.size() || text_[pos_] != '"') return false; std::string key; if (!String(&key)) return false; Whitespace(); if (pos_ >= text_.size() || text_[pos_++] != ':' || out->object.count(key)) return false; Json item; if (!Value(&item, depth)) return false; out->object.emplace(std::move(key), std::move(item)); Whitespace(); if (pos_ >= text_.size()) return false; if (text_[pos_] == '}') { ++pos_; return true; } if (text_[pos_++] != ',') return false; } }
  const std::string& text_; size_t pos_ = 0;
};

const Json* Field(const Json& value, const char* key, Json::Kind kind) { const auto it = value.object.find(key); return it != value.object.end() && it->second.kind == kind ? &it->second : nullptr; }
bool ExactKeys(const Json& value, std::initializer_list<const char*> keys) { if (value.kind != Json::Kind::object || value.object.size() != keys.size()) return false; return std::all_of(keys.begin(), keys.end(), [&](const char* key) { return value.object.count(key) == 1; }); }
std::wstring Wide(const std::string& text) { const int n = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text.data(), static_cast<int>(text.size()), nullptr, 0); if (n <= 0) return {}; std::wstring result(n, L'\0'); MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text.data(), static_cast<int>(text.size()), result.data(), n); return result; }
std::string Utf8(const std::wstring& text) { const int n = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, text.data(), static_cast<int>(text.size()), nullptr, 0, nullptr, nullptr); if (n <= 0) return {}; std::string result(n, '\0'); return WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, text.data(), static_cast<int>(text.size()), result.data(), n, nullptr, nullptr) == n ? result : std::string{}; }
uint64_t FileId(const BY_HANDLE_FILE_INFORMATION& value) { return (static_cast<uint64_t>(value.nFileIndexHigh) << 32) | value.nFileIndexLow; }
bool ParseUnsigned(const std::string& text, uint64_t* out) { if (text.empty() || !std::all_of(text.begin(), text.end(), [](char c) { return c >= '0' && c <= '9'; })) return false; char* end = nullptr; const auto value = _strtoui64(text.c_str(), &end, 10); if (!end || *end) return false; *out = value; return true; }

struct Lease {
  HANDLE file = INVALID_HANDLE_VALUE;
  std::wstring path;
  std::string sha256;
  std::string launcher_sha256;
  BY_HANDLE_FILE_INFORMATION identity{};
  std::atomic<bool> attempted{false};
  bool closed = false;
};

#ifdef MINI_LUX_SEC03_NATIVE_TEST
struct TestExecutableLease {
  HANDLE file = INVALID_HANDLE_VALUE;
  std::wstring path;
  std::string sha256;
  BY_HANDLE_FILE_INFORMATION identity{};
  bool closed = false;
};
#endif

struct EvidenceVerifier {
  mini_lux::sec03::AttestationKey key;
  std::string candidate;
  std::string build;
  std::string source;
  std::string host;
  std::string launcher;
};

struct Execution {
  HANDLE process = nullptr;
  HANDLE control = nullptr;
  HANDLE events = nullptr;
  HANDLE lifecycle_job = nullptr;
  DWORD pid = 0;
  std::uint64_t host_created = 0;
  std::string execution_id;
  std::string candidate_sha256;
  std::string build_sha256;
  std::string source_sha256;
  std::string host_sha256;
  std::string launcher_sha256;
  napi_env env = nullptr;
  napi_deferred completion = nullptr;
  napi_threadsafe_function tsfn = nullptr;
  napi_ref self_reference = nullptr;
  std::thread reader;
  std::mutex write_mutex;
  std::string control_secret;
  std::vector<uint8_t> native_proof;
  std::string native_proof_mac;
  std::string native_proof_key_id;
  std::string launcher_channel_marker;
  mini_lux::sec03::AttestationKey attestation_key;
  Json launch_request;
  std::string fixed_acl_variant;
  std::string expected_root_identity_digest;
  bool proof_seen = false;
  bool host_evidence_seen = false;
  DWORD host_evidence_child_exit = 0;
  std::string host_evidence_reason;
  bool launcher_observation = false;
  bool protocol_failed = false;
  std::uint64_t lifecycle_process_starts = 0;
  std::atomic<std::uint64_t> aggregate_output_bytes{0};
  std::atomic<bool> lifecycle_triggered{false};
  std::atomic<bool> terminate_sent{false};
  std::atomic<bool> closed{false};
};

struct Dispatch {
  Execution* execution;
  std::vector<uint8_t> frame;
  bool completion;
  DWORD exit_code;
  bool child_failed = false;
};

void Throw(napi_env env, const char* code, const char* message) { napi_throw_error(env, code, message); }
bool Ok(napi_env env, napi_status status, const char* message) {
  if (status == napi_ok) return true;
  Throw(env, "EXEC_NATIVE_ABI_ERROR", message);
  return false;
}

bool ReadExact(HANDLE handle, void* buffer, DWORD size) {
  auto* cursor = static_cast<uint8_t*>(buffer);
  while (size) {
    DWORD count = 0;
    if (!ReadFile(handle, cursor, size, &count, nullptr) || count == 0) return false;
    cursor += count;
    size -= count;
  }
  return true;
}

bool WriteExact(HANDLE handle, const void* buffer, DWORD size) {
  const auto* cursor = static_cast<const uint8_t*>(buffer);
  while (size) {
    DWORD count = 0;
    if (!WriteFile(handle, cursor, size, &count, nullptr) || count == 0) return false;
    cursor += count;
    size -= count;
  }
  return true;
}

std::string Hex(const uint8_t* bytes, size_t size) {
  static constexpr char digits[] = "0123456789abcdef";
  std::string result(size * 2, '\0');
  for (size_t i = 0; i < size; ++i) {
    result[i * 2] = digits[bytes[i] >> 4];
    result[i * 2 + 1] = digits[bytes[i] & 15];
  }
  return result;
}

std::string CanonicalBase64(const unsigned char* data, size_t size) {
  static constexpr char table[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"; std::string out; out.reserve((size + 2) / 3 * 4);
  for (size_t i = 0; i < size; i += 3) { const uint32_t value = (static_cast<uint32_t>(data[i]) << 16) | (i + 1 < size ? static_cast<uint32_t>(data[i + 1]) << 8 : 0) | (i + 2 < size ? data[i + 2] : 0); out.push_back(table[(value >> 18) & 63]); out.push_back(table[(value >> 12) & 63]); out.push_back(i + 1 < size ? table[(value >> 6) & 63] : '='); out.push_back(i + 2 < size ? table[value & 63] : '='); }
  return out;
}

bool DecodeCanonicalBase64(const std::string& input, std::vector<unsigned char>* out) {
  if (input.empty() || input.size() % 4) return false; auto value = [](char c) -> int { if (c >= 'A' && c <= 'Z') return c - 'A'; if (c >= 'a' && c <= 'z') return c - 'a' + 26; if (c >= '0' && c <= '9') return c - '0' + 52; if (c == '+') return 62; if (c == '/') return 63; return -1; };
  for (size_t i = 0; i < input.size(); i += 4) { const int a = value(input[i]), b = value(input[i + 1]); const int c = input[i + 2] == '=' ? -2 : value(input[i + 2]); const int d = input[i + 3] == '=' ? -2 : value(input[i + 3]); if (a < 0 || b < 0 || c == -1 || d == -1 || (c == -2 && d != -2) || ((c == -2 || d == -2) && i + 4 != input.size())) return false; const uint32_t bits = (a << 18) | (b << 12) | ((c < 0 ? 0 : c) << 6) | (d < 0 ? 0 : d); out->push_back(static_cast<unsigned char>(bits >> 16)); if (c >= 0) out->push_back(static_cast<unsigned char>(bits >> 8)); if (d >= 0) out->push_back(static_cast<unsigned char>(bits)); }
  return CanonicalBase64(out->data(), out->size()) == input;
}

bool Sha256Handle(HANDLE file, std::string* output) {
  BCRYPT_ALG_HANDLE algorithm = nullptr;
  BCRYPT_HASH_HANDLE hash = nullptr;
  DWORD object_bytes = 0, hash_bytes = 0, received = 0;
  std::vector<uint8_t> object, digest;
  LARGE_INTEGER zero{};
  bool success = false;
  if (BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0) < 0) goto done;
  if (BCryptGetProperty(algorithm, BCRYPT_OBJECT_LENGTH, reinterpret_cast<PUCHAR>(&object_bytes), sizeof(object_bytes), &received, 0) < 0) goto done;
  if (BCryptGetProperty(algorithm, BCRYPT_HASH_LENGTH, reinterpret_cast<PUCHAR>(&hash_bytes), sizeof(hash_bytes), &received, 0) < 0) goto done;
  object.resize(object_bytes); digest.resize(hash_bytes);
  if (BCryptCreateHash(algorithm, &hash, object.data(), object_bytes, nullptr, 0, 0) < 0) goto done;
  if (!SetFilePointerEx(file, zero, nullptr, FILE_BEGIN)) goto done;
  for (;;) {
    std::array<uint8_t, 65536> buffer{}; DWORD count = 0;
    if (!ReadFile(file, buffer.data(), static_cast<DWORD>(buffer.size()), &count, nullptr)) goto done;
    if (!count) break;
    if (BCryptHashData(hash, buffer.data(), count, 0) < 0) goto done;
  }
  if (BCryptFinishHash(hash, digest.data(), hash_bytes, 0) < 0) goto done;
  *output = Hex(digest.data(), digest.size()); success = true;
done:
  SetFilePointerEx(file, zero, nullptr, FILE_BEGIN);
  if (hash) BCryptDestroyHash(hash);
  if (algorithm) BCryptCloseAlgorithmProvider(algorithm, 0);
  return success;
}

bool PeMachine(HANDLE file, WORD* machine) {
  IMAGE_DOS_HEADER dos{}; DWORD count = 0; LARGE_INTEGER offset{};
  if (!machine || !SetFilePointerEx(file, offset, nullptr, FILE_BEGIN) || !ReadFile(file, &dos, sizeof(dos), &count, nullptr) || count != sizeof(dos) || dos.e_magic != IMAGE_DOS_SIGNATURE || dos.e_lfanew <= 0) return false;
  offset.QuadPart = dos.e_lfanew; DWORD signature = 0; IMAGE_FILE_HEADER header{};
  const bool valid = SetFilePointerEx(file, offset, nullptr, FILE_BEGIN) && ReadFile(file, &signature, sizeof(signature), &count, nullptr) && count == sizeof(signature) && signature == IMAGE_NT_SIGNATURE && ReadFile(file, &header, sizeof(header), &count, nullptr) && count == sizeof(header);
  offset.QuadPart = 0; SetFilePointerEx(file, offset, nullptr, FILE_BEGIN); if (valid) *machine = header.Machine; return valid;
}

bool IsAmd64Pe(HANDLE file) { WORD machine = 0; return PeMachine(file, &machine) && machine == IMAGE_FILE_MACHINE_AMD64; }

std::wstring CurrentLauncherPath() {
  HMODULE module = nullptr;
  if (!GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT, reinterpret_cast<LPCWSTR>(&CurrentLauncherPath), &module)) return {};
  std::vector<wchar_t> path(32768); const DWORD count = GetModuleFileNameW(module, path.data(), static_cast<DWORD>(path.size()));
  return count && count < path.size() ? std::wstring(path.data(), count) : std::wstring{};
}

std::wstring FixedHostPath() {
  std::wstring result = CurrentLauncherPath(); const auto slash = result.find_last_of(L"\\/");
  if (slash == std::wstring::npos) return {};
  result.resize(slash + 1); result += L"sandbox-host.exe"; return result;
}

struct FixedAdversarySpec {
  const char* variant;
  const char* profile;
  const char* mode;
  const char* expected_code;
};

const FixedAdversarySpec* FindFixedAdversary(const std::string& tuple) {
  static constexpr std::array<FixedAdversarySpec, 9> specs = {{
    {"A06-01", "E3A", "lineage-direct", "OBS_JOB_EMPTY"},
    {"A06-02", "E3A", "lineage-grandchild", "OBS_JOB_EMPTY"},
    {"A06-03", "E3A", "lineage-detached", "OBS_JOB_EMPTY"},
    {"A06-04", "E3A", "lineage-background", "OBS_JOB_EMPTY"},
    {"A07-01", "E3A", "breakaway-explicit", "EXEC_BREAKAWAY_DENIED"},
    {"A07-02", "E3A", "breakaway-silent", "EXEC_BREAKAWAY_DENIED"},
    {"A07-03", "E3A", "nested-job", "EXEC_JOB_INCOMPATIBLE"},
    {"A08-02", "E3A", "limit-active-process", "EXEC_LIMIT_ACTIVE_PROCESS"},
    {"A08-04", "E3A", "limit-job-memory", "EXEC_LIMIT_JOB_MEMORY"},
  }};
  const auto slash = tuple.find('/');
  if (slash == std::string::npos || tuple.find('/', slash + 1) != std::string::npos) return nullptr;
  for (const auto& spec : specs) if (tuple.substr(0, slash) == spec.variant && tuple.substr(slash + 1) == spec.profile) return &spec;
  return nullptr;
}

std::string JsonQuoted(const std::string& value) {
  std::string out = "\"";
  for (const unsigned char c : value) {
    if (c == '"' || c == '\\') { out.push_back('\\'); out.push_back(static_cast<char>(c)); }
    else if (c >= 0x20 && c <= 0x7e) out.push_back(static_cast<char>(c));
    else return {};
  }
  out.push_back('"'); return out;
}

std::string FixedAdversaryLimits(const FixedAdversarySpec& spec) {
  unsigned active = 8, process_memory = 128u << 20, job_memory = 512u << 20, cpu = 50, job_time = 10000, wall = 10000, aggregate = 1u << 20, retained = 1u << 20, input = 128u << 10;
  const char* idle = "null";
  if (std::string(spec.variant) == "A08-02") active = 1;
  if (std::string(spec.variant) == "A08-04") { process_memory = 96u << 20; job_memory = 160u << 20; }
  return std::string("{\"activeProcesses\":") + std::to_string(active) + ",\"aggregateOutputBytes\":" + std::to_string(aggregate)
    + ",\"cpuRatePercent\":" + std::to_string(cpu) + ",\"idleTimeMs\":" + idle + ",\"inputBytes\":" + std::to_string(input)
    + ",\"jobMemoryBytes\":" + std::to_string(job_memory) + ",\"jobUserTimeMs\":" + std::to_string(job_time)
    + ",\"processMemoryBytes\":" + std::to_string(process_memory) + ",\"retainedOutputBytes\":" + std::to_string(retained)
    + ",\"wallTimeMs\":" + std::to_string(wall) + "}";
}

bool BuildFixedAdversaryRequest(const Json& request, const Lease& lease, std::string* json) {
  if (!ExactKeys(request, {"buildIdSha256","candidateId","executionId","hostSha256","launcherSha256","runId","secret","sourceSha256","tuple","type","v"})) return false;
  const Json* version = Field(request, "v", Json::Kind::number); const Json* type = Field(request, "type", Json::Kind::string); const Json* tuple = Field(request, "tuple", Json::Kind::string);
  const Json* candidate = Field(request, "candidateId", Json::Kind::string); const Json* build = Field(request, "buildIdSha256", Json::Kind::string); const Json* source = Field(request, "sourceSha256", Json::Kind::string);
  const Json* host = Field(request, "hostSha256", Json::Kind::string); const Json* launcher = Field(request, "launcherSha256", Json::Kind::string); const Json* execution = Field(request, "executionId", Json::Kind::string); const Json* run = Field(request, "runId", Json::Kind::string); const Json* secret = Field(request, "secret", Json::Kind::string);
  const FixedAdversarySpec* spec = tuple ? FindFixedAdversary(tuple->scalar) : nullptr;
  if (!version || version->scalar != "1" || !type || type->scalar != "fixed-adversary" || !spec || !candidate || !build || !source || !host || !launcher || !execution || !run || !secret
    || !mini_lux::sec03::CanonicalHex(candidate->scalar, 32, 32) || !mini_lux::sec03::CanonicalHex(build->scalar, 32, 32) || !mini_lux::sec03::CanonicalHex(source->scalar, 32, 32)
    || host->scalar != std::string(64, '0') || launcher->scalar != std::string(64, '0') || secret->scalar != std::string(64, '0')
    || !mini_lux::sec03::LauncherObservationId(execution->scalar) || !mini_lux::sec03::LauncherObservationId(run->scalar)) return false;
  std::string execution_digest;
  if (!mini_lux::sec03::Sha256(reinterpret_cast<const unsigned char*>(execution->scalar.data()), execution->scalar.size(), &execution_digest)) return false;
  PWSTR known = nullptr; if (SHGetKnownFolderPath(FOLDERID_LocalAppData, KF_FLAG_DEFAULT, nullptr, &known) != S_OK || !known) return false;
  std::wstring base(known); CoTaskMemFree(known); mini_lux::sec03::JournalDirectoryLease qualified;
  const std::wstring mini = base + L"\\Mini-Lux"; const std::wstring leaf = mini + L"\\sec03-fixed-adversary-v1-" + Wide(execution_digest.substr(0, 16));
  if ((!CreateDirectoryW(mini.c_str(), nullptr) && GetLastError() != ERROR_ALREADY_EXISTS) || (!CreateDirectoryW(leaf.c_str(), nullptr) && GetLastError() != ERROR_ALREADY_EXISTS)
    || !mini_lux::sec03::QualifyFixedNtfsDirectory(leaf, &qualified)) return false;
  BY_HANDLE_FILE_INFORMATION info{};
  if (!GetFileInformationByHandle(qualified.handle, &info) || !(info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) || (info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT)) return false;
  std::array<wchar_t, MAX_PATH> windows{}, system32{}; const UINT wn = GetWindowsDirectoryW(windows.data(), static_cast<UINT>(windows.size())); const UINT sn = GetSystemDirectoryW(system32.data(), static_cast<UINT>(system32.size()));
  auto dos_path = [](std::wstring value) { if (value.rfind(L"\\\\?\\UNC\\", 0) == 0) return L"\\\\" + value.substr(8); if (value.rfind(L"\\\\?\\", 0) == 0) return value.substr(4); return value; };
  const std::string root_text = Utf8(dos_path(qualified.path));
  const std::string windows_text = Utf8(std::wstring(windows.data(), wn)), system_text = Utf8(std::wstring(system32.data(), sn));
  if (!wn || wn >= windows.size() || !sn || sn >= system32.size() || root_text.empty() || windows_text.empty() || system_text.empty()) return false;
  const std::string payload = std::string("mini-lux/sec03/fixed-adversary/v1/") + tuple->scalar; std::string payload_digest, persona_digest, policy_digest;
  if (!mini_lux::sec03::Sha256(reinterpret_cast<const unsigned char*>(payload.data()), payload.size(), &payload_digest)
    || !mini_lux::sec03::Sha256(reinterpret_cast<const unsigned char*>("fixed-adversary-persona"), 23, &persona_digest)
    || !mini_lux::sec03::Sha256(reinterpret_cast<const unsigned char*>(tuple->scalar.data()), tuple->scalar.size(), &policy_digest)) return false;
  const std::string profile = "fixed-adversary";
  const std::string environment = std::string("{\"APPDATA\":") + JsonQuoted(root_text) + ",\"ComSpec\":" + JsonQuoted(system_text + "\\cmd.exe") + ",\"HOME\":" + JsonQuoted(root_text) + ",\"LOCALAPPDATA\":" + JsonQuoted(root_text) + ",\"MINI_LUX_ROOT_0\":" + JsonQuoted(root_text) + ",\"MINI_LUX_SANDBOX_ID\":\"fixed-adversary\",\"MINI_LUX_SESSION_ID\":\"fixed-adversary\",\"NUMBER_OF_PROCESSORS\":\"1\",\"OS\":\"Windows_NT\",\"PATH\":" + JsonQuoted(system_text) + ",\"PATHEXT\":\".COM;.EXE;.BAT;.CMD\",\"PROCESSOR_ARCHITECTURE\":\"AMD64\",\"SystemRoot\":" + JsonQuoted(windows_text) + ",\"TEMP\":" + JsonQuoted(root_text) + ",\"TMP\":" + JsonQuoted(root_text) + ",\"USERPROFILE\":" + JsonQuoted(root_text) + ",\"WINDIR\":" + JsonQuoted(windows_text) + "}";
  const std::string identity = "{\"fileId\":\"" + std::to_string(FileId(info)) + "\",\"type\":\"directory\",\"volumeSerial\":\"" + std::to_string(info.dwVolumeSerialNumber) + "\"}";
  *json = std::string("{\"authorityEpoch\":1,\"buildIdSha256\":") + JsonQuoted(build->scalar) + ",\"candidateId\":" + JsonQuoted(candidate->scalar) + ",\"contextId\":\"sec03-fixed-adversary\",\"entryPoint\":" + JsonQuoted(spec->profile)
    + ",\"environment\":" + environment + ",\"executable\":{\"handleIndex\":-1,\"kind\":\"fixed-adversary-self\"},\"executionId\":" + JsonQuoted(execution->scalar) + ",\"expiresAtMs\":4102444800000,\"fixedAdversary\":" + JsonQuoted(tuple->scalar) + ",\"fixedStateMac\":\"" + std::string(64, '0')
    + "\",\"hostSha256\":\"" + std::string(64, '0') + "\",\"launcherSha256\":\"" + std::string(64, '0') + "\",\"limits\":" + FixedAdversaryLimits(*spec) + ",\"network\":{\"mode\":\"deny\"},\"payload\":" + JsonQuoted(CanonicalBase64(reinterpret_cast<const unsigned char*>(payload.data()), payload.size()))
    + ",\"payloadDigest\":" + JsonQuoted(payload_digest) + ",\"personaDigest\":" + JsonQuoted(persona_digest) + ",\"policyDigest\":" + JsonQuoted(policy_digest) + ",\"principal\":\"sec03-fixed-adversary\",\"profile\":" + JsonQuoted(profile)
    + ",\"roots\":[{\"access\":\"read-write\",\"canonicalCwd\":" + JsonQuoted(root_text) + ",\"canonicalPath\":" + JsonQuoted(root_text) + ",\"cwdIdentity\":" + identity + ",\"identity\":" + identity + ",\"rootId\":\"fixed-adversary-root\"}],\"runId\":" + JsonQuoted(run->scalar)
    + ",\"secret\":\"" + std::string(64, '0') + "\",\"sessionId\":\"sec03-fixed-adversary\",\"sourceSha256\":" + JsonQuoted(source->scalar) + ",\"type\":\"launch\",\"v\":1}";
  return !json->empty() && lease.path == FixedHostPath();
}

std::wstring FixedTestProjectionPath() {
  std::wstring launcher = CurrentLauncherPath();
  if (launcher.rfind(L"\\\\?\\UNC\\", 0) == 0) launcher = L"\\\\" + launcher.substr(8); else if (launcher.rfind(L"\\\\?\\", 0) == 0) launcher = launcher.substr(4);
  constexpr wchar_t suffix[] = L"\\dist\\native\\sandbox-launcher.node";
  constexpr size_t suffix_length = (sizeof(suffix) / sizeof(suffix[0])) - 1;
  if (launcher.size() <= suffix_length || _wcsicmp(launcher.c_str() + launcher.size() - suffix_length, suffix) != 0) return {};
  launcher.resize(launcher.size() - suffix_length);
  launcher += L"\\.sec03-native-test\\sandbox-launcher.node";
  return launcher;
}

bool FixedModulePathIsAbsent(const std::wstring& path) {
  HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPMODULE | TH32CS_SNAPMODULE32, GetCurrentProcessId());
  if (snapshot == INVALID_HANDLE_VALUE) return false;
  MODULEENTRY32W entry{}; entry.dwSize = static_cast<DWORD>(sizeof(entry));
  bool valid = Module32FirstW(snapshot, &entry) != FALSE; size_t count = 0;
  while (valid) {
    if (++count > 4096 || _wcsicmp(entry.szExePath, path.c_str()) == 0) { valid = false; break; }
    entry.dwSize = static_cast<DWORD>(sizeof(entry)); SetLastError(ERROR_SUCCESS);
    if (!Module32NextW(snapshot, &entry)) { valid = GetLastError() == ERROR_NO_MORE_FILES; break; }
  }
  CloseHandle(snapshot); return valid;
}

napi_value LoadValidatedTestProjection(napi_env env, napi_callback_info info) {
  size_t argc = 3; napi_value argv[3]; size_t hash_length = 0; int64_t expected_bytes = 0;
  if (!Ok(env, napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr), "Cannot read native test projection identity") || argc != 2
      || napi_get_value_string_utf8(env, argv[0], nullptr, 0, &hash_length) != napi_ok || hash_length != 64
      || napi_get_value_int64(env, argv[1], &expected_bytes) != napi_ok || expected_bytes <= 0 || expected_bytes > 16 * 1024 * 1024) {
    Throw(env, "EXEC_NATIVE_TEST_PROJECTION_INVALID", "Native test projection identity is invalid"); return nullptr;
  }
  std::vector<char> expected_text(hash_length + 1); napi_get_value_string_utf8(env, argv[0], expected_text.data(), expected_text.size(), &hash_length);
  const std::string expected(expected_text.data(), hash_length); const std::wstring path = FixedTestProjectionPath();
  if (!mini_lux::sec03::CanonicalHex(expected, 32, 32)) { Throw(env, "EXEC_NATIVE_TEST_PROJECTION_INVALID", "Native test projection identity is invalid"); return nullptr; }
  if (path.empty()) { Throw(env, "EXEC_NATIVE_TEST_PROJECTION_LOCATION", "Native test projection location is invalid"); return nullptr; }
  HANDLE file = CreateFileW(path.c_str(), GENERIC_READ | FILE_READ_ATTRIBUTES, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
  LARGE_INTEGER size{}; BY_HANDLE_FILE_INFORMATION identity{}; std::string digest; std::array<wchar_t, 32768> final_path{};
  const DWORD final_count = file == INVALID_HANDLE_VALUE ? 0 : GetFinalPathNameByHandleW(file, final_path.data(), static_cast<DWORD>(final_path.size()), FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
  std::wstring opened = final_count && final_count < final_path.size() ? std::wstring(final_path.data(), final_count) : std::wstring{};
  if (opened.rfind(L"\\\\?\\UNC\\", 0) == 0) opened = L"\\\\" + opened.substr(8); else if (opened.rfind(L"\\\\?\\", 0) == 0) opened = opened.substr(4);
  const bool file_identity = file != INVALID_HANDLE_VALUE && GetFileInformationByHandle(file, &identity)
    && !(identity.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) && GetFileSizeEx(file, &size) && size.QuadPart == expected_bytes
    && IsAmd64Pe(file) && Sha256Handle(file, &digest) && digest == expected;
  if (!file_identity) { if (file != INVALID_HANDLE_VALUE) CloseHandle(file); Throw(env, "EXEC_NATIVE_TEST_PROJECTION_INVALID", "Native test projection identity is invalid"); return nullptr; }
  if (opened != path) { CloseHandle(file); Throw(env, "EXEC_NATIVE_TEST_PROJECTION_PATH", "Native test projection path is not canonical"); return nullptr; }
  if (!FixedModulePathIsAbsent(path)) { CloseHandle(file); Throw(env, "EXEC_NATIVE_TEST_PROJECTION_LOADED", "Native test projection was already loaded"); return nullptr; }
  HMODULE module = LoadLibraryExW(path.c_str(), nullptr, LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_DEFAULT_DIRS);
  using RegisterModule = napi_value (*)(napi_env, napi_value);
  FARPROC raw_register = module ? GetProcAddress(module, "napi_register_module_v1") : nullptr; RegisterModule register_module = nullptr;
  static_assert(sizeof(register_module) == sizeof(raw_register)); memcpy(&register_module, &raw_register, sizeof(register_module));
  std::array<wchar_t, 32768> loaded_path{}; const DWORD loaded_count = module ? GetModuleFileNameW(module, loaded_path.data(), static_cast<DWORD>(loaded_path.size())) : 0;
  HMODULE registration_module = nullptr;
  const bool loaded = module && register_module && loaded_count && loaded_count < loaded_path.size() && std::wstring(loaded_path.data(), loaded_count) == path
    && GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT, reinterpret_cast<LPCWSTR>(register_module), &registration_module)
    && registration_module == module;
  if (!loaded) { if (module) FreeLibrary(module); CloseHandle(file); Throw(env, "EXEC_NATIVE_TEST_PROJECTION_LOAD_INVALID", "Native test projection load is invalid"); return nullptr; }
  napi_value exports; if (napi_create_object(env, &exports) != napi_ok) { CloseHandle(file); Throw(env, "EXEC_NATIVE_ABI_ERROR", "Cannot create native test projection exports"); return nullptr; }
  napi_value initialized = register_module(env, exports); CloseHandle(file);
  if (!initialized) { Throw(env, "EXEC_NATIVE_ABI_ERROR", "Native test projection initialization failed"); return nullptr; }
  return initialized;
}

bool FixedEvidenceIdentity(const std::string& candidate, const std::string& launcher) {
  const std::wstring host_path = FixedHostPath(), launcher_path = CurrentLauncherPath();
  if (host_path.empty() || launcher_path.empty()) return false;
  HANDLE host = CreateFileW(host_path.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
  HANDLE addon = CreateFileW(launcher_path.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
  BY_HANDLE_FILE_INFORMATION host_info{}, addon_info{}; std::string host_digest, addon_digest;
  const bool valid = host != INVALID_HANDLE_VALUE && addon != INVALID_HANDLE_VALUE
    && GetFileInformationByHandle(host, &host_info) && GetFileInformationByHandle(addon, &addon_info)
    && !(host_info.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT))
    && !(addon_info.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT))
    && IsAmd64Pe(host) && IsAmd64Pe(addon) && Sha256Handle(host, &host_digest) && Sha256Handle(addon, &addon_digest)
    && host_digest == candidate && addon_digest == launcher;
  if (host != INVALID_HANDLE_VALUE) CloseHandle(host); if (addon != INVALID_HANDLE_VALUE) CloseHandle(addon); return valid;
}

bool SameExecutableIdentity(const BY_HANDLE_FILE_INFORMATION& expected_identity, const std::string& expected_sha256, DWORD pid) {
  HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, pid);
  if (!process) return false;
  std::vector<wchar_t> path(32768); DWORD count = static_cast<DWORD>(path.size());
  bool same = false;
  if (WaitForSingleObject(process, 0) == WAIT_TIMEOUT && QueryFullProcessImageNameW(process, 0, path.data(), &count)) {
    HANDLE image = CreateFileW(std::wstring(path.data(), count).c_str(), GENERIC_READ | FILE_READ_ATTRIBUTES,
        FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
    if (image != INVALID_HANDLE_VALUE) {
      BY_HANDLE_FILE_INFORMATION identity{}; std::string digest;
      same = GetFileInformationByHandle(image, &identity)
        && !(identity.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT))
        && identity.dwVolumeSerialNumber == expected_identity.dwVolumeSerialNumber
        && identity.nFileIndexHigh == expected_identity.nFileIndexHigh
        && identity.nFileIndexLow == expected_identity.nFileIndexLow
        && Sha256Handle(image, &digest) && digest == expected_sha256;
      CloseHandle(image);
    }
  }
  CloseHandle(process); return same;
}

bool SameIdentity(const Lease& lease, DWORD pid) {
  return SameExecutableIdentity(lease.identity, lease.sha256, pid);
}

std::string ExtractExecutionId(const std::string& json) {
  const std::string marker = "\"executionId\":\""; const auto start = json.find(marker);
  if (start == std::string::npos) return {};
  const auto value = start + marker.size(); const auto end = json.find('"', value);
  if (end == std::string::npos || end - value > 128) return {};
  return json.substr(value, end - value);
}

enum class ProofFrame { ordinary, valid, invalid };
bool CanonicalOutputFrame(const Json& parsed, std::string* stream_value, std::vector<unsigned char>* decoded_value) {
  if (!ExactKeys(parsed, {"data", "stream", "version"})) return false; const Json* version = Field(parsed, "version", Json::Kind::number); const Json* stream = Field(parsed, "stream", Json::Kind::string); const Json* data = Field(parsed, "data", Json::Kind::string); std::vector<unsigned char> decoded;
  const bool valid = version && version->scalar == "1" && stream && (stream->scalar == "stdout" || stream->scalar == "stderr") && data && data->scalar.size() <= ((kMaxFrame + 2) / 3) * 4 && DecodeCanonicalBase64(data->scalar, &decoded) && decoded.size() <= kMaxFrame;
  if (valid && stream_value) *stream_value = stream->scalar; if (valid && decoded_value) *decoded_value = std::move(decoded); return valid;
}
ProofFrame CaptureProofFrame(Execution* execution, const std::vector<uint8_t>& frame) {
  if (frame.size() < 5) return ProofFrame::invalid; std::string json(reinterpret_cast<const char*>(frame.data() + 4), frame.size() - 4); Json parsed;
  if (!Parser(json).Parse(&parsed) || parsed.kind != Json::Kind::object) return ProofFrame::invalid;
  const Json* kind = Field(parsed, "kind", Json::Kind::string); if (!kind) {
    std::string stream; std::vector<unsigned char> decoded; if (!CanonicalOutputFrame(parsed, &stream, &decoded)) return ProofFrame::invalid; execution->aggregate_output_bytes.fetch_add(decoded.size());
    const std::string text(decoded.begin(), decoded.end()); const std::string prefix = "SEC03_EVIDENCE "; const std::string exit_marker = " childExit="; const std::string reason_marker = " completionReason=";
    if (stream == "stderr" && text.rfind(prefix, 0) == 0) {
      const auto exit_start = text.find(exit_marker); const auto reason_start = text.find(reason_marker);
      if (exit_start != std::string::npos && reason_start != std::string::npos && reason_start > exit_start + exit_marker.size() && text.back() == '\n') {
        std::uint64_t child_exit = 0; const std::string exit_text = text.substr(exit_start + exit_marker.size(), reason_start - exit_start - exit_marker.size()); const std::string reason = text.substr(reason_start + reason_marker.size(), text.size() - reason_start - reason_marker.size() - 1);
        if (execution->host_evidence_seen || !mini_lux::sec03::Decimal(exit_text, &child_exit) || child_exit > MAXDWORD || reason.empty() || reason.size() > 64) return ProofFrame::invalid;
        execution->host_evidence_seen = true; execution->host_evidence_child_exit = static_cast<DWORD>(child_exit); execution->host_evidence_reason = reason;
      }
    }
    return ProofFrame::ordinary;
  }
  const Json* version = Field(parsed, "version", Json::Kind::number); const Json* proof_hex = Field(parsed, "proofHex", Json::Kind::string); const Json* mac = Field(parsed, "mac", Json::Kind::string); const Json* key_id = Field(parsed, "keyId", Json::Kind::string);
  if (execution->proof_seen || !ExactKeys(parsed, {"keyId", "kind", "mac", "proofHex", "version"}) || kind->scalar != "native-proof" || !version || version->scalar != "1" || !proof_hex || !mac || !key_id || !mini_lux::sec03::CanonicalHex(proof_hex->scalar, 1, mini_lux::sec03::kMaxProofBytes) || !mini_lux::sec03::CanonicalHex(mac->scalar, 32, 32) || !mini_lux::sec03::CanonicalHex(key_id->scalar, 32, 32)) return ProofFrame::invalid;
  std::vector<unsigned char> proof; std::map<std::string, std::string> fields; if (!mini_lux::sec03::Unhex(proof_hex->scalar, &proof) || proof.size() > mini_lux::sec03::kMaxProofBytes || !mini_lux::sec03::ParseCanonicalProof(std::string(proof.begin(), proof.end()), execution->candidate_sha256, execution->build_sha256, execution->source_sha256, execution->host_sha256, execution->launcher_sha256, key_id->scalar, &fields) || fields.at("execution") != execution->execution_id) return ProofFrame::invalid;
  execution->native_proof.assign(proof.begin(), proof.end()); execution->native_proof_mac = mac->scalar; execution->native_proof_key_id = key_id->scalar; execution->proof_seen = true; return ProofFrame::valid;
}

bool AuthenticatedProofChildExit(const Execution& execution, DWORD* output) {
  if (!output || !execution.proof_seen || execution.native_proof.empty()) return false;
  const std::string proof(execution.native_proof.begin(), execution.native_proof.end());
  const std::string marker = "\nchildExit="; const auto start = proof.find(marker);
  if (start == std::string::npos || proof.find(marker, start + marker.size()) != std::string::npos) return false;
  const auto value_start = start + marker.size(); const auto end = proof.find('\n', value_start);
  if (end == std::string::npos || end == value_start) return false;
  std::uint64_t value = 0; if (!mini_lux::sec03::Decimal(proof.substr(value_start, end - value_start), &value) || value > MAXDWORD) return false;
  *output = static_cast<DWORD>(value); return true;
}

bool AuthenticatedProofCompletionReason(const Execution& execution, std::string* output) {
  if (!output || !execution.proof_seen || execution.native_proof.empty()) return false;
  const std::string proof(execution.native_proof.begin(), execution.native_proof.end());
  const std::string marker = "\ncompletionReason="; const auto start = proof.find(marker);
  if (start == std::string::npos || proof.find(marker, start + marker.size()) != std::string::npos) return false;
  const auto value_start = start + marker.size(); const auto end = proof.find('\n', value_start);
  if (end == std::string::npos || end == value_start || end - value_start > 64) return false;
  *output = proof.substr(value_start, end - value_start); return true;
}

DWORD ProofHostExitCode(const std::map<std::string, std::string>& fields) {
  const auto reason = fields.find("completionReason"); if (reason == fields.end()) return 1;
  if (reason->second == "completed") return 0; if (reason->second == "child-failed") { const auto child = fields.find("childExit"); std::uint64_t value = 0; return child != fields.end() && mini_lux::sec03::Decimal(child->second, &value) && value <= MAXDWORD ? static_cast<DWORD>(value) : 1; } if (reason->second == "protocol-invalid") return 71; if (reason->second == "acl-sharing-failed" || reason->second == "acl-propagation-failed" || reason->second == "acl-conflict") return 74; if (reason->second == "limit-wall") return 80; if (reason->second == "limit-idle") return 81; if (reason->second == "limit-output") return 82; if (reason->second == "cancelled") return 83; if (reason->second == "limit-cpu") return 84; if (reason->second == "limit-active-process") return 85; if (reason->second == "limit-process-memory") return 86; if (reason->second == "limit-job-memory") return 87; if (reason->second == "owner-retired") return 88; if (reason->second == "session-retired") return 89; if (reason->second == "service-shutdown") return 90; if (reason->second == "channel-lost") return 92; if (reason->second == "cleanup-failed") return 75; return 1;
}

std::string LauncherMarkerPayload(const Execution& execution, DWORD exit_code) {
  std::string proof_sha256; if (!mini_lux::sec03::Sha256(execution.native_proof.data(), execution.native_proof.size(), &proof_sha256)) return {};
  return std::string("v=1\nkind=launcher-exit\nkeyId=") + execution.native_proof_key_id + "\ncandidate=" + execution.candidate_sha256 + "\nbuildIdSha256=" + execution.build_sha256 + "\nsourceSha256=" + execution.source_sha256 + "\nhostSha256=" + execution.host_sha256 + "\nlauncher=" + execution.launcher_sha256 + "\nexecution=" + execution.execution_id + "\nproofSha256=" + proof_sha256 + "\nproofMac=" + execution.native_proof_mac + "\nhostExitCode=" + std::to_string(exit_code) + "\nhostExited=1\n";
}

bool CreateLauncherChannelMarker(Execution* execution, DWORD exit_code) {
  if (!execution->proof_seen || !execution->attestation_key.available) return false; const std::string payload = LauncherMarkerPayload(*execution, exit_code); std::array<unsigned char, 32> mac{};
  if (payload.empty() || !mini_lux::sec03::HmacSha256(execution->attestation_key, reinterpret_cast<const unsigned char*>(payload.data()), payload.size(), &mac)) return false;
  execution->launcher_channel_marker = mini_lux::sec03::HexBytes(mac.data(), mac.size()); return true;
}

void CallJs(napi_env env, napi_value callback, void*, void* data) {
  std::unique_ptr<Dispatch> dispatch(static_cast<Dispatch*>(data));
  Execution* execution = dispatch->execution;
  if (!env) return;
  if (dispatch->completion) {
    if (execution->protocol_failed) { napi_value message, error; napi_create_string_utf8(env, "Native host proof frame is malformed or duplicated", NAPI_AUTO_LENGTH, &message); napi_create_error(env, nullptr, message, &error); napi_value code; napi_create_string_utf8(env, "EXEC_NATIVE_PROTOCOL", NAPI_AUTO_LENGTH, &code); napi_set_named_property(env, error, "code", code); napi_reject_deferred(env, execution->completion, error); if (execution->self_reference) { napi_delete_reference(env, execution->self_reference); execution->self_reference = nullptr; } return; }
    napi_value result, value;
    napi_create_object(env, &result);
    napi_create_uint32(env, dispatch->exit_code, &value); napi_set_named_property(env, result, "exitCode", value);
    DWORD proof_child_exit = 0;
    if (AuthenticatedProofChildExit(*execution, &proof_child_exit)) napi_create_uint32(env, proof_child_exit, &value); else napi_get_null(env, &value);
    napi_set_named_property(env, result, "childExit", value);
    const char* reason = "host-failed"; std::string proof_reason;
    if (dispatch->child_failed || (AuthenticatedProofCompletionReason(*execution, &proof_reason) && proof_reason == "child-failed")) reason = "child-failed";
    else switch (dispatch->exit_code) {
      case 0: reason = "completed"; break;
      case 71: reason = "EXEC_PROTOCOL_INVALID"; break;
      case 72: reason = "EXEC_NATIVE_PRIMITIVE_UNAVAILABLE"; break;
      case 80: reason = "EXEC_LIMIT_WALL"; break;
      case 81: reason = "EXEC_LIMIT_IDLE"; break;
      case 82: reason = "EXEC_LIMIT_OUTPUT"; break;
      case 83: reason = "EXEC_CANCELLED"; break;
      case 84: reason = "EXEC_LIMIT_CPU"; break;
      case 85: reason = "EXEC_LIMIT_ACTIVE_PROCESS"; break;
      case 86: reason = "EXEC_LIMIT_PROCESS_MEMORY"; break;
      case 87: reason = "EXEC_LIMIT_JOB_MEMORY"; break;
      case 88: reason = "EXEC_OWNER_RETIRED"; break;
      case 89: reason = "EXEC_SESSION_RETIRED"; break;
      case 90: reason = "EXEC_SERVICE_SHUTDOWN"; break;
      case 92: reason = "EXEC_CHANNEL_LOST"; break;
      default: break;
    }
    napi_create_string_utf8(env, reason, NAPI_AUTO_LENGTH, &value); napi_set_named_property(env, result, "reason", value);
    if (execution->proof_seen) { napi_value proof, bytes, mac, key_id; napi_create_object(env, &proof); void* target = nullptr; napi_create_buffer_copy(env, execution->native_proof.size(), execution->native_proof.data(), &target, &bytes); napi_set_named_property(env, proof, "proof", bytes); napi_create_string_utf8(env, execution->native_proof_mac.c_str(), NAPI_AUTO_LENGTH, &mac); napi_set_named_property(env, proof, "mac", mac); napi_create_string_utf8(env, execution->native_proof_key_id.c_str(), NAPI_AUTO_LENGTH, &key_id); napi_set_named_property(env, proof, "keyId", key_id); napi_create_string_utf8(env, execution->launcher_channel_marker.c_str(), NAPI_AUTO_LENGTH, &value); napi_set_named_property(env, proof, "channelMarker", value); napi_set_named_property(env, result, "nativeProof", proof); } else { napi_get_null(env, &value); napi_set_named_property(env, result, "nativeProof", value); }
    napi_resolve_deferred(env, execution->completion, result);
    if (execution->self_reference) { napi_delete_reference(env, execution->self_reference); execution->self_reference = nullptr; }
    return;
  }
  napi_value global, buffer, ignored;
  void* target = nullptr;
  napi_get_global(env, &global);
  napi_create_buffer_copy(env, dispatch->frame.size(), dispatch->frame.data(), &target, &buffer);
  napi_call_function(env, global, callback, 1, &buffer, &ignored);
}

bool RecoverFixedAclReceipt(Execution* execution, DWORD exit_code);

void ReaderMain(Execution* execution) {
  for (;;) {
    uint8_t header[4]{};
    if (!ReadExact(execution->events, header, sizeof(header))) break;
    const uint32_t size = (static_cast<uint32_t>(header[0]) << 24) | (static_cast<uint32_t>(header[1]) << 16) | (static_cast<uint32_t>(header[2]) << 8) | header[3];
    if (!size || size > kMaxFrame) { execution->protocol_failed = true; break; }
    auto dispatch = std::make_unique<Dispatch>(); dispatch->execution = execution; dispatch->completion = false;
    dispatch->frame.resize(size + 4); memcpy(dispatch->frame.data(), header, 4);
    if (!ReadExact(execution->events, dispatch->frame.data() + 4, size)) { execution->protocol_failed = true; break; }
    const ProofFrame proof = CaptureProofFrame(execution, dispatch->frame); if (proof == ProofFrame::valid) continue; if (proof == ProofFrame::invalid) { execution->protocol_failed = true; continue; }
    napi_call_threadsafe_function(execution->tsfn, dispatch.release(), napi_tsfn_blocking);
  }
  WaitForSingleObject(execution->process, INFINITE); DWORD code = 1; GetExitCodeProcess(execution->process, &code);
  if (!execution->fixed_acl_variant.empty()) {
    if (execution->proof_seen || !RecoverFixedAclReceipt(execution, code) || !execution->launcher_observation) execution->protocol_failed = true;
  } else if (execution->proof_seen && (execution->launcher_observation || !CreateLauncherChannelMarker(execution, code))) execution->protocol_failed = true;
  DWORD authenticated_child_exit = 0; std::string authenticated_reason;
  const bool child_exit_available = AuthenticatedProofChildExit(*execution, &authenticated_child_exit);
  const bool reason_available = AuthenticatedProofCompletionReason(*execution, &authenticated_reason);
  if (!execution->host_evidence_seen || execution->host_evidence_reason.empty()) execution->protocol_failed = true;
  if (execution->proof_seen && (!child_exit_available || !reason_available
    || authenticated_child_exit != execution->host_evidence_child_exit || authenticated_reason != execution->host_evidence_reason)) execution->protocol_failed = true;
  const bool child_failed = execution->host_evidence_seen && execution->host_evidence_reason == "child-failed";
  if (child_failed && code != execution->host_evidence_child_exit) execution->protocol_failed = true;
  auto completion = std::make_unique<Dispatch>(); completion->execution = execution; completion->completion = true; completion->exit_code = child_failed ? execution->host_evidence_child_exit : code; completion->child_failed = child_failed;
  napi_call_threadsafe_function(execution->tsfn, completion.release(), napi_tsfn_blocking);
  napi_release_threadsafe_function(execution->tsfn, napi_tsfn_release);
}

void FinalizeLease(napi_env, void* data, void*) {
  auto* lease = static_cast<Lease*>(data); if (!lease) return;
  if (lease->file != INVALID_HANDLE_VALUE) CloseHandle(lease->file); delete lease;
}
void FinalizeExecution(napi_env, void* data, void*) {
  auto* execution = static_cast<Execution*>(data); if (!execution) return;
  if (!execution->closed.exchange(true) && execution->process) TerminateProcess(execution->process, 0xE003);
  if (execution->reader.joinable()) { CancelSynchronousIo(execution->reader.native_handle()); execution->reader.join(); }
  if (execution->control) CloseHandle(execution->control);
  if (execution->events) CloseHandle(execution->events);
  if (execution->lifecycle_job) CloseHandle(execution->lifecycle_job);
  if (execution->process) CloseHandle(execution->process);
  delete execution;
}

Lease* GetLease(napi_env env, napi_callback_info info, size_t* argc, napi_value* argv, napi_value* self) {
  if (!Ok(env, napi_get_cb_info(env, info, argc, argv, self, nullptr), "Cannot read lease arguments")) return nullptr;
  Lease* lease = nullptr;
  if (!Ok(env, napi_unwrap(env, *self, reinterpret_cast<void**>(&lease)), "Invalid host lease") || !lease || lease->closed || lease->file == INVALID_HANDLE_VALUE) { Throw(env, "EXEC_NATIVE_LEASE_CLOSED", "Host lease is closed"); return nullptr; }
  return lease;
}

bool ConsumeLeaseAttempt(napi_env env, Lease* lease) {
  if (!lease || lease->attempted.exchange(true)) { Throw(env, "EXEC_GRANT_REPLAYED", "Exclusive host lease attempt was already consumed"); return false; }
  return true;
}

Execution* GetExecution(napi_env env, napi_callback_info info, size_t* argc, napi_value* argv) {
  napi_value self;
  if (!Ok(env, napi_get_cb_info(env, info, argc, argv, &self, nullptr), "Cannot read execution arguments")) return nullptr;
  Execution* execution = nullptr;
  if (!Ok(env, napi_unwrap(env, self, reinterpret_cast<void**>(&execution)), "Invalid execution handle") || !execution || execution->closed) { Throw(env, "EXEC_NATIVE_HANDLE_CLOSED", "Execution handle is closed"); return nullptr; }
  return execution;
}

napi_value ResolvedPromise(napi_env env) {
  napi_deferred deferred; napi_value promise, value;
  napi_create_promise(env, &deferred, &promise); napi_get_undefined(env, &value); napi_resolve_deferred(env, deferred, value); return promise;
}

bool AuthenticatedControlFrame(const void* data, size_t size, const char* expected_type, const std::string& secret, std::vector<uint8_t>* output) {
  if (!data || size < 5 || size > kMaxFrame + 4 || secret.size() != 64) return false;
  const auto* bytes = static_cast<const uint8_t*>(data);
  const uint32_t declared = (static_cast<uint32_t>(bytes[0]) << 24) | (static_cast<uint32_t>(bytes[1]) << 16) | (static_cast<uint32_t>(bytes[2]) << 8) | bytes[3];
  if (declared != size - 4) return false;
  std::string json(reinterpret_cast<const char*>(bytes + 4), size - 4); Json parsed;
  if (!Parser(json).Parse(&parsed) || parsed.kind != Json::Kind::object) return false;
  const Json* version = Field(parsed, "v", Json::Kind::number); const Json* type = Field(parsed, "type", Json::Kind::string); const Json* slot = Field(parsed, "secret", Json::Kind::string);
  if (!version || version->scalar != "1" || !type || type->scalar != expected_type || !slot || slot->scalar != std::string(64, '0')) return false;
  if (strcmp(expected_type, "input") == 0) {
    if (!ExactKeys(parsed, {"appendNewline", "data", "digest", "secret", "type", "v"}) || !Field(parsed, "appendNewline", Json::Kind::boolean) || !Field(parsed, "data", Json::Kind::string)) return false;
    const Json* digest = Field(parsed, "digest", Json::Kind::string); if (!digest || digest->scalar.size() != 64 || !std::all_of(digest->scalar.begin(), digest->scalar.end(), [](char c) { return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'); })) return false;
  } else if (strcmp(expected_type, "resize") == 0) {
    if (!ExactKeys(parsed, {"cols", "rows", "secret", "type", "v"})) return false;
    const Json* cols = Field(parsed, "cols", Json::Kind::number); const Json* rows = Field(parsed, "rows", Json::Kind::number); uint64_t parsed_cols = 0, parsed_rows = 0;
    if (!cols || !rows || !ParseUnsigned(cols->scalar, &parsed_cols) || !ParseUnsigned(rows->scalar, &parsed_rows) || parsed_cols < 2 || parsed_cols > 500 || parsed_rows < 1 || parsed_rows > 300) return false;
  } else {
    if (!ExactKeys(parsed, {"reason", "secret", "type", "v"})) return false;
    const Json* reason = Field(parsed, "reason", Json::Kind::string); if (!reason || reason->scalar.empty() || reason->scalar.size() > 64 || !std::all_of(reason->scalar.begin(), reason->scalar.end(), [](char c) { return (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-'; })) return false;
  }
  const std::string placeholder = "\"secret\":\"" + std::string(64, '0') + "\""; const auto position = json.find(placeholder);
  if (position == std::string::npos || json.find(placeholder, position + 1) != std::string::npos) return false;
  json.replace(position + 10, 64, secret); output->assign(bytes, bytes + 4); output->insert(output->end(), json.begin(), json.end()); return true;
}

napi_value WriteFrame(napi_env env, napi_callback_info info) {
  size_t argc = 1; napi_value argv[1]; Execution* execution = GetExecution(env, info, &argc, argv);
  if (!execution || argc != 1 || execution->terminate_sent) return nullptr;
  bool is_buffer = false; napi_is_buffer(env, argv[0], &is_buffer); void* data = nullptr; size_t size = 0; std::vector<uint8_t> authenticated;
  if (!is_buffer || napi_get_buffer_info(env, argv[0], &data, &size) != napi_ok
    || (!AuthenticatedControlFrame(data, size, "input", execution->control_secret, &authenticated)
      && !AuthenticatedControlFrame(data, size, "resize", execution->control_secret, &authenticated))) {
    Throw(env, "EXEC_NATIVE_PROTOCOL", "Interactive control frame is invalid"); return nullptr;
  }
  std::lock_guard<std::mutex> lock(execution->write_mutex);
  if (!WriteExact(execution->control, authenticated.data(), static_cast<DWORD>(authenticated.size()))) { Throw(env, "EXEC_NATIVE_IO", "Control pipe write failed"); return nullptr; }
  return ResolvedPromise(env);
}

napi_value TerminateHost(napi_env env, napi_callback_info info) {
  size_t argc = 1; napi_value argv[1]; Execution* execution = GetExecution(env, info, &argc, argv);
  if (!execution || argc != 1) return nullptr;
  bool is_buffer = false; napi_is_buffer(env, argv[0], &is_buffer); void* data = nullptr; size_t size = 0; std::vector<uint8_t> authenticated;
  if (!is_buffer || napi_get_buffer_info(env, argv[0], &data, &size) != napi_ok || !AuthenticatedControlFrame(data, size, "terminate", execution->control_secret, &authenticated) || execution->terminate_sent.exchange(true)) { Throw(env, "EXEC_NATIVE_PROTOCOL", "Terminate frame is invalid or replayed"); return nullptr; }
  std::lock_guard<std::mutex> lock(execution->write_mutex);
  if (!WriteExact(execution->control, authenticated.data(), static_cast<DWORD>(authenticated.size()))) { Throw(env, "EXEC_NATIVE_IO", "Control pipe write failed"); return nullptr; }
  return ResolvedPromise(env);
}

napi_value CloseControlChannel(napi_env env, napi_callback_info info) {
  size_t argc = 0; Execution* execution = GetExecution(env, info, &argc, nullptr);
  if (!execution || argc != 0 || execution->terminate_sent.exchange(true)) { Throw(env, "EXEC_NATIVE_PROTOCOL", "Control channel close is invalid or replayed"); return nullptr; }
  std::lock_guard<std::mutex> lock(execution->write_mutex);
  if (!execution->control || execution->control == INVALID_HANDLE_VALUE) { Throw(env, "EXEC_NATIVE_IO", "Control channel is unavailable"); return nullptr; }
  CloseHandle(execution->control); execution->control = nullptr;
  return ResolvedPromise(env);
}

#ifdef MINI_LUX_SEC03_NATIVE_TEST
napi_value CrashHostForTest(napi_env env, napi_callback_info info) {
  size_t argc = 0; Execution* execution = GetExecution(env, info, &argc, nullptr);
  if (!execution || argc != 0) return nullptr;
  if (!TerminateProcess(execution->process, 0xE3A0)) { Throw(env, "EXEC_NATIVE_IO", "Test host crash failed"); return nullptr; }
  return ResolvedPromise(env);
}
#endif

napi_value TriggerLifecycleCrashForReceipt(napi_env env, napi_callback_info info) {
  size_t argc = 0; Execution* execution = GetExecution(env, info, &argc, nullptr);
  if (!execution || argc != 0 || (execution->fixed_acl_variant != "A09-06" && execution->fixed_acl_variant != "A09-07") || !execution->lifecycle_job || execution->lifecycle_triggered.exchange(true)) { Throw(env, "EXEC_NATIVE_PROTOCOL", "Lifecycle crash receipt trigger is invalid or replayed"); return nullptr; }
  const DWORD exit_code = execution->fixed_acl_variant == "A09-06" ? 0xE3A6u : 0xE3A7u;
  const BOOL terminated = execution->fixed_acl_variant == "A09-06" ? TerminateJobObject(execution->lifecycle_job, exit_code) : TerminateProcess(execution->process, exit_code);
  if (!terminated) { execution->lifecycle_triggered = false; Throw(env, "EXEC_NATIVE_IO", "Lifecycle crash receipt trigger failed"); return nullptr; }
  return ResolvedPromise(env);
}

std::vector<uint8_t> ProtocolCaseFrame(const std::string& payload) {
  const uint32_t size = static_cast<uint32_t>(payload.size()); std::vector<uint8_t> result = {static_cast<uint8_t>(size >> 24), static_cast<uint8_t>(size >> 16), static_cast<uint8_t>(size >> 8), static_cast<uint8_t>(size)};
  result.insert(result.end(), payload.begin(), payload.end()); return result;
}

napi_value ProbeFixedHostProtocol(napi_env env, napi_callback_info info) {
  size_t argc = 1; napi_value argv[1]; Execution* execution = GetExecution(env, info, &argc, argv);
  if (!execution || argc != 1 || execution->terminate_sent.exchange(true)) { Throw(env, "EXEC_NATIVE_PROTOCOL", "Protocol case is invalid or replayed"); return nullptr; }
  size_t length = 0; if (napi_get_value_string_utf8(env, argv[0], nullptr, 0, &length) != napi_ok || !length || length > 32) { Throw(env, "EXEC_NATIVE_PROTOCOL", "Protocol case is invalid"); return nullptr; }
  std::vector<char> variant_buffer(length + 1, '\0'); if (napi_get_value_string_utf8(env, argv[0], variant_buffer.data(), variant_buffer.size(), &length) != napi_ok) { Throw(env, "EXEC_NATIVE_PROTOCOL", "Protocol case is invalid"); return nullptr; } const std::string variant(variant_buffer.data(), length);
  static const std::array<const char*, 9> allowed = {"length","oversize","unknown-key","duplicate-key","utf8","replay","second-launch","secret","state"};
  if (std::find(allowed.begin(), allowed.end(), variant) == allowed.end()) { Throw(env, "EXEC_NATIVE_PROTOCOL", "Protocol case is unsupported"); return nullptr; }
  std::lock_guard<std::mutex> lock(execution->write_mutex); if (!execution->control) { Throw(env, "EXEC_NATIVE_IO", "Control pipe is closed"); return nullptr; }
  if (variant == "length" || variant == "oversize") {
    const uint32_t declared = variant == "oversize" ? mini_lux::sec03::kMaxControlFrame + 1 : 8; const uint8_t header[4] = {static_cast<uint8_t>(declared >> 24), static_cast<uint8_t>(declared >> 16), static_cast<uint8_t>(declared >> 8), static_cast<uint8_t>(declared)};
    const bool wrote = WriteExact(execution->control, header, sizeof(header)) && (variant == "oversize" || WriteExact(execution->control, "x", 1)); CloseHandle(execution->control); execution->control = nullptr;
    if (!wrote) { Throw(env, "EXEC_NATIVE_IO", "Protocol frame write failed"); return nullptr; } return ResolvedPromise(env);
  }
  std::string digest; const unsigned char input = 'x'; if (!mini_lux::sec03::Sha256(&input, 1, &digest)) { Throw(env, "EXEC_NATIVE_EVIDENCE_UNAVAILABLE", "Protocol input digest failed"); return nullptr; }
  const std::string valid = "{\"v\":1,\"type\":\"input\",\"secret\":\"" + execution->control_secret + "\",\"data\":\"eA==\",\"digest\":\"" + digest + "\",\"appendNewline\":false}";
  std::vector<uint8_t> first;
  if (variant == "unknown-key") first = ProtocolCaseFrame(valid.substr(0, valid.size() - 1) + ",\"unexpected\":1}");
  else if (variant == "duplicate-key") first = ProtocolCaseFrame("{\"v\":1,\"type\":\"input\",\"secret\":\"" + execution->control_secret + "\",\"secret\":\"" + execution->control_secret + "\"}");
  else if (variant == "utf8") { first = {0, 0, 0, 1, 0xff}; }
  else if (variant == "second-launch") first = ProtocolCaseFrame("{\"v\":1,\"type\":\"launch\",\"secret\":\"" + execution->control_secret + "\"}");
  else if (variant == "secret") first = ProtocolCaseFrame("{\"v\":1,\"type\":\"input\",\"secret\":\"" + std::string(64, execution->control_secret[0] == '0' ? '1' : '0') + "\"}");
  else if (variant == "state") first = ProtocolCaseFrame("{\"v\":1,\"type\":\"event\",\"secret\":\"" + execution->control_secret + "\"}");
  else first = ProtocolCaseFrame(valid);
  bool wrote = WriteExact(execution->control, first.data(), static_cast<DWORD>(first.size())); if (wrote && variant == "replay") wrote = WriteExact(execution->control, first.data(), static_cast<DWORD>(first.size()));
  if (!wrote) { Throw(env, "EXEC_NATIVE_IO", "Protocol frame write failed"); return nullptr; } return ResolvedPromise(env);
}

struct TrustedRootHandle {
  HANDLE handle = INVALID_HANDLE_VALUE;
  HANDLE cwd_handle = INVALID_HANDLE_VALUE;
  BY_HANDLE_FILE_INFORMATION identity{};
  BY_HANDLE_FILE_INFORMATION cwd_identity{};
  ~TrustedRootHandle() { if (handle != INVALID_HANDLE_VALUE) CloseHandle(handle); if (cwd_handle != INVALID_HANDLE_VALUE) CloseHandle(cwd_handle); }
  TrustedRootHandle() = default;
  TrustedRootHandle(const TrustedRootHandle&) = delete;
  TrustedRootHandle& operator=(const TrustedRootHandle&) = delete;
  TrustedRootHandle(TrustedRootHandle&& other) noexcept : handle(other.handle), cwd_handle(other.cwd_handle), identity(other.identity), cwd_identity(other.cwd_identity) { other.handle = INVALID_HANDLE_VALUE; other.cwd_handle = INVALID_HANDLE_VALUE; }
};

enum class RootFailureClass { none, unc, mapped_remote, non_ntfs, removable_ntfs, reparse_root };
enum class RootOpenResult { trusted, unsupported, identity_changed, invalid };
enum class RootPathKind { drive, unc };
enum class LauncherObservationOutcome { unsupported_root, root_identity_changed };

struct RootIdentityPair {
  std::uint32_t expected_root_volume = 0;
  std::uint64_t expected_root_file = 0;
  std::uint32_t expected_cwd_volume = 0;
  std::uint64_t expected_cwd_file = 0;
  BY_HANDLE_FILE_INFORMATION observed_root{};
  BY_HANDLE_FILE_INFORMATION observed_cwd{};
};

struct RootObservationDigests {
  std::string expected;
  std::string observed;
};

const char* RootFailureClassName(RootFailureClass value) {
  switch (value) {
    case RootFailureClass::unc: return "unc";
    case RootFailureClass::mapped_remote: return "mapped-remote";
    case RootFailureClass::non_ntfs: return "non-ntfs";
    case RootFailureClass::removable_ntfs: return "removable-ntfs";
    case RootFailureClass::reparse_root: return "reparse-root";
    case RootFailureClass::none: return "";
  }
  return "";
}

bool CanonicalRootPath(const std::wstring& path, RootPathKind* kind) {
  if (path.size() < 3 || path.size() >= 32767 || path.find(L'/') != std::wstring::npos) return false;
  const bool drive = ((path[0] >= L'A' && path[0] <= L'Z') || (path[0] >= L'a' && path[0] <= L'z')) && path[1] == L':' && path[2] == L'\\';
  const bool unc = path.size() >= 5 && path[0] == L'\\' && path[1] == L'\\' && path[2] != L'?' && path[2] != L'.' && path[2] != L'\\';
  if (!drive && !unc) return false;
  if (unc) { const size_t server_end = path.find(L'\\', 2); if (server_end == std::wstring::npos || server_end == 2 || server_end + 1 >= path.size() || path[server_end + 1] == L'\\') return false; }
  const DWORD required = GetFullPathNameW(path.c_str(), 0, nullptr, nullptr); if (!required || required > 32767) return false;
  std::vector<wchar_t> full(static_cast<size_t>(required) + 1); const DWORD count = GetFullPathNameW(path.c_str(), static_cast<DWORD>(full.size()), full.data(), nullptr);
  if (!count || count >= full.size() || path.size() != count || _wcsicmp(path.c_str(), full.data()) != 0) return false;
  *kind = drive ? RootPathKind::drive : RootPathKind::unc; return true;
}

#ifdef MINI_LUX_SEC03_NATIVE_TEST
constexpr size_t kTestObserverMaxHolders = 4096;
constexpr size_t kTestObserverMaxProcesses = 65536;

class TestObserverHandle {
 public:
  explicit TestObserverHandle(HANDLE value) : value_(value) {}
  ~TestObserverHandle() { if (value_ && value_ != INVALID_HANDLE_VALUE) CloseHandle(value_); }
  TestObserverHandle(const TestObserverHandle&) = delete;
  TestObserverHandle& operator=(const TestObserverHandle&) = delete;
  HANDLE get() const { return value_; }
 private:
  HANDLE value_;
};

constexpr size_t kTestRegistryMaxSubkeyChars = 32766;
constexpr DWORD kTestRegistryMaxItems = 4096;
constexpr DWORD kTestRegistryMaxChildNameChars = 255;
constexpr DWORD kTestRegistryMaxValueBytes = 1024u * 1024u;

class TestObserverRegistryKey {
 public:
  explicit TestObserverRegistryKey(HKEY value) : value_(value) {}
  ~TestObserverRegistryKey() { if (value_) RegCloseKey(value_); }
  TestObserverRegistryKey(const TestObserverRegistryKey&) = delete;
  TestObserverRegistryKey& operator=(const TestObserverRegistryKey&) = delete;
  HKEY get() const { return value_; }
 private:
  HKEY value_;
};

struct TestRegistryKeyState {
  DWORD subkey_count = 0;
  DWORD max_subkey_name = 0;
  FILETIME last_write{};
};

struct TestRegistryValue {
  bool present = false;
  std::wstring text;
};

struct TestRegistryItem {
  std::wstring child_name;
  std::array<TestRegistryValue, 5> values;
};

bool StrictTestRegistrySubkey(const std::wstring& subkey) {
  if (subkey.empty() || subkey.size() > kTestRegistryMaxSubkeyChars || subkey.front() == L'\\' || subkey.back() == L'\\'
      || subkey.find(L'/') != std::wstring::npos || subkey.find(L':') != std::wstring::npos) return false;
  static constexpr std::array<const wchar_t*, 11> hive_prefixes = {
    L"HKCR", L"HKCU", L"HKLM", L"HKU", L"HKCC", L"HKEY_CLASSES_ROOT", L"HKEY_CURRENT_USER",
    L"HKEY_LOCAL_MACHINE", L"HKEY_USERS", L"HKEY_CURRENT_CONFIG", L"Computer",
  };
  size_t start = 0;
  bool first = true;
  while (start < subkey.size()) {
    const size_t end = subkey.find(L'\\', start);
    const size_t count = (end == std::wstring::npos ? subkey.size() : end) - start;
    if (!count) return false;
    const std::wstring component = subkey.substr(start, count);
    if (component == L"." || component == L"..") return false;
    if (first && std::any_of(hive_prefixes.begin(), hive_prefixes.end(), [&](const wchar_t* prefix) { return _wcsicmp(component.c_str(), prefix) == 0; })) return false;
    if (end == std::wstring::npos) break;
    first = false;
    start = end + 1;
  }
  return true;
}

bool ReadTestRegistrySubkey(napi_env env, napi_value value, std::wstring* subkey) {
  napi_valuetype type = napi_undefined;
  if (napi_typeof(env, value, &type) != napi_ok || type != napi_string) return false;
  size_t length = 0;
  if (napi_get_value_string_utf16(env, value, nullptr, 0, &length) != napi_ok || !length || length > kTestRegistryMaxSubkeyChars) return false;
  std::vector<char16_t> text(length + 1);
  size_t received = 0;
  if (napi_get_value_string_utf16(env, value, text.data(), text.size(), &received) != napi_ok || received != length) return false;
  subkey->clear(); subkey->reserve(length);
  for (size_t index = 0; index < length; ++index) {
    if (!text[index]) return false;
    subkey->push_back(static_cast<wchar_t>(text[index]));
  }
  return StrictTestRegistrySubkey(*subkey);
}

bool SameTestRegistryWriteTime(const FILETIME& left, const FILETIME& right) {
  return left.dwLowDateTime == right.dwLowDateTime && left.dwHighDateTime == right.dwHighDateTime;
}

bool QueryTestRegistryRootState(HKEY key, TestRegistryKeyState* state) {
  TestRegistryKeyState observed;
  if (RegQueryInfoKeyW(key, nullptr, nullptr, nullptr, &observed.subkey_count, &observed.max_subkey_name, nullptr, nullptr, nullptr, nullptr, nullptr, &observed.last_write) != ERROR_SUCCESS
      || observed.subkey_count > kTestRegistryMaxItems || observed.max_subkey_name > kTestRegistryMaxChildNameChars
      || (observed.subkey_count != 0 && observed.max_subkey_name == 0)) return false;
  *state = observed;
  return true;
}

bool QueryTestRegistryWriteTime(HKEY key, FILETIME* last_write) {
  return RegQueryInfoKeyW(key, nullptr, nullptr, nullptr, nullptr, nullptr, nullptr, nullptr, nullptr, nullptr, nullptr, last_write) == ERROR_SUCCESS;
}

bool ReadTestRegistryValue(HKEY key, const wchar_t* name, TestRegistryValue* value) {
  constexpr DWORD flags = RRF_RT_REG_SZ | RRF_RT_REG_EXPAND_SZ | RRF_NOEXPAND;
  DWORD type = 0;
  DWORD bytes = 0;
  const LSTATUS query = RegGetValueW(key, nullptr, name, flags, &type, nullptr, &bytes);
  if (query == ERROR_FILE_NOT_FOUND || query == ERROR_PATH_NOT_FOUND) {
    value->present = false;
    value->text.clear();
    return true;
  }
  if (query != ERROR_SUCCESS || (type != REG_SZ && type != REG_EXPAND_SZ)
      || bytes > kTestRegistryMaxValueBytes - sizeof(wchar_t) || bytes % sizeof(wchar_t) != 0) return false;
  std::vector<wchar_t> buffer(bytes / sizeof(wchar_t) + 1);
  DWORD read_type = 0;
  DWORD read_bytes = bytes + sizeof(wchar_t);
  if (RegGetValueW(key, nullptr, name, flags, &read_type, buffer.data(), &read_bytes) != ERROR_SUCCESS || read_type != type
      || read_bytes < sizeof(wchar_t) || read_bytes > bytes + sizeof(wchar_t) || read_bytes % sizeof(wchar_t) != 0
      || buffer[read_bytes / sizeof(wchar_t) - 1] != L'\0') return false;
  value->present = true;
  value->text.assign(buffer.data(), read_bytes / sizeof(wchar_t) - 1);
  return true;
}

bool TestRegistryDisplayNameMatches(const TestRegistryValue& display_name) {
  static constexpr wchar_t needle[] = L"RainyDays";
  constexpr size_t needle_length = (sizeof(needle) / sizeof(needle[0])) - 1;
  if (!display_name.present || display_name.text.size() < needle_length) return false;
  for (size_t index = 0; index <= display_name.text.size() - needle_length; ++index) {
    if (CompareStringOrdinal(display_name.text.data() + index, static_cast<int>(needle_length), needle, static_cast<int>(needle_length), TRUE) == CSTR_EQUAL) return true;
  }
  return false;
}

bool EnumerateTestRegistryItems(HKEY root, const TestRegistryKeyState& initial, std::vector<TestRegistryItem>* items) {
  std::vector<std::wstring> child_names;
  child_names.reserve(initial.subkey_count);
  std::vector<wchar_t> name_buffer(static_cast<size_t>(initial.max_subkey_name) + 1);
  for (DWORD index = 0; index < initial.subkey_count; ++index) {
    DWORD name_length = static_cast<DWORD>(name_buffer.size());
    FILETIME child_write{};
    if (RegEnumKeyExW(root, index, name_buffer.data(), &name_length, nullptr, nullptr, nullptr, &child_write) != ERROR_SUCCESS
        || !name_length || name_length > initial.max_subkey_name) return false;
    child_names.emplace_back(name_buffer.data(), name_length);
  }
  DWORD extra_length = static_cast<DWORD>(name_buffer.size());
  if (RegEnumKeyExW(root, initial.subkey_count, name_buffer.data(), &extra_length, nullptr, nullptr, nullptr, nullptr) != ERROR_NO_MORE_ITEMS) return false;
  TestRegistryKeyState after_enumeration;
  if (!QueryTestRegistryRootState(root, &after_enumeration) || after_enumeration.subkey_count != initial.subkey_count
      || after_enumeration.max_subkey_name != initial.max_subkey_name || !SameTestRegistryWriteTime(after_enumeration.last_write, initial.last_write)) return false;
  std::sort(child_names.begin(), child_names.end());
  items->clear();
  for (const auto& child_name : child_names) {
    HKEY raw_child = nullptr;
    if (RegOpenKeyExW(root, child_name.c_str(), 0, KEY_READ, &raw_child) != ERROR_SUCCESS) return false;
    TestObserverRegistryKey child(raw_child);
    FILETIME before_values{}, after_values{};
    TestRegistryItem item; item.child_name = child_name;
    static constexpr std::array<const wchar_t*, 5> value_names = {
      L"DisplayName", L"DisplayVersion", L"InstallLocation", L"UninstallString", L"QuietUninstallString",
    };
    if (!QueryTestRegistryWriteTime(child.get(), &before_values)
        || !ReadTestRegistryValue(child.get(), value_names[0], &item.values[0])) return false;
    const bool matched = TestRegistryDisplayNameMatches(item.values[0]);
    if (matched) {
      for (size_t index = 1; index < value_names.size(); ++index) {
        if (!ReadTestRegistryValue(child.get(), value_names[index], &item.values[index])) return false;
      }
    }
    if (!QueryTestRegistryWriteTime(child.get(), &after_values) || !SameTestRegistryWriteTime(before_values, after_values)) return false;
    if (matched) items->push_back(std::move(item));
  }
  TestRegistryKeyState final_state;
  return QueryTestRegistryRootState(root, &final_state) && final_state.subkey_count == initial.subkey_count
    && final_state.max_subkey_name == initial.max_subkey_name && SameTestRegistryWriteTime(final_state.last_write, initial.last_write);
}

struct TestFileProcessIds {
  ULONG count;
  ULONG_PTR process_ids[1];
};

constexpr size_t kTestObserverQueryBytes = offsetof(TestFileProcessIds, process_ids) + kTestObserverMaxHolders * sizeof(ULONG_PTR);
static_assert(kTestObserverQueryBytes <= UINT32_MAX);

using NtQueryInformationFileForTest = LONG(NTAPI*)(HANDLE, void*, void*, ULONG, ULONG);

enum class TestTreeMembership { outside, inside, invalid };

bool StrictTestObserverPath(const std::wstring& path) {
  RootPathKind kind{};
  if (!CanonicalRootPath(path, &kind)) return false;
  const bool drive_root = kind == RootPathKind::drive && path.size() == 3;
  if (!drive_root && path.back() == L'\\') return false;
  const size_t first = kind == RootPathKind::drive ? 3 : 2;
  size_t start = first;
  while (start < path.size()) {
    const size_t end = path.find(L'\\', start);
    const size_t count = (end == std::wstring::npos ? path.size() : end) - start;
    if (!count) return false;
    const std::wstring component = path.substr(start, count);
    if (component == L"." || component == L".." || component.back() == L'.' || component.back() == L' ' || component.find(L':') != std::wstring::npos) return false;
    if (end == std::wstring::npos) break;
    start = end + 1;
  }
  return true;
}

bool ReadTestObserverPath(napi_env env, napi_value value, std::wstring* path) {
  napi_valuetype type = napi_undefined;
  if (napi_typeof(env, value, &type) != napi_ok || type != napi_string) return false;
  size_t length = 0;
  if (napi_get_value_string_utf16(env, value, nullptr, 0, &length) != napi_ok || !length || length >= 32767) return false;
  std::vector<char16_t> text(length + 1);
  size_t received = 0;
  if (napi_get_value_string_utf16(env, value, text.data(), text.size(), &received) != napi_ok || received != length) return false;
  path->clear(); path->reserve(length);
  for (size_t index = 0; index < length; ++index) {
    if (!text[index]) return false;
    path->push_back(static_cast<wchar_t>(text[index]));
  }
  return StrictTestObserverPath(*path);
}

void FinalizeTestExecutableLease(napi_env, void* data, void*) {
  auto* lease = static_cast<TestExecutableLease*>(data);
  if (!lease) return;
  if (lease->file != INVALID_HANDLE_VALUE) CloseHandle(lease->file);
  delete lease;
}

TestExecutableLease* GetTestExecutableLease(napi_env env, napi_callback_info info, size_t* argc,
    napi_value* argv, napi_value* self) {
  if (napi_get_cb_info(env, info, argc, argv, self, nullptr) != napi_ok) return nullptr;
  TestExecutableLease* lease = nullptr;
  if (napi_unwrap(env, *self, reinterpret_cast<void**>(&lease)) != napi_ok || !lease || lease->closed
      || lease->file == INVALID_HANDLE_VALUE) return nullptr;
  return lease;
}

napi_value AssertTestExecutableProcessIdentity(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1], self;
  TestExecutableLease* lease = GetTestExecutableLease(env, info, &argc, argv, &self);
  uint32_t pid = 0;
  if (!lease || argc != 1 || napi_get_value_uint32(env, argv[0], &pid) != napi_ok || !pid
      || !SameExecutableIdentity(lease->identity, lease->sha256, pid)) {
    Throw(env, "EXEC_NATIVE_TEST_EXECUTABLE_IDENTITY", "Launched test executable differs from its exclusive identity lease");
    return nullptr;
  }
  napi_value result;
  napi_get_boolean(env, true, &result);
  return result;
}

napi_value CloseTestExecutableLease(napi_env env, napi_callback_info info) {
  size_t argc = 0;
  napi_value self;
  if (napi_get_cb_info(env, info, &argc, nullptr, &self, nullptr) != napi_ok || argc != 0) return nullptr;
  TestExecutableLease* lease = nullptr;
  if (napi_unwrap(env, self, reinterpret_cast<void**>(&lease)) != napi_ok || !lease) {
    Throw(env, "EXEC_NATIVE_TEST_EXECUTABLE_IDENTITY", "Test executable identity lease is unavailable");
    return nullptr;
  }
  if (!lease->closed) {
    if (lease->file != INVALID_HANDLE_VALUE) CloseHandle(lease->file);
    lease->file = INVALID_HANDLE_VALUE;
    lease->closed = true;
  }
  napi_value result;
  napi_get_undefined(env, &result);
  return result;
}

napi_value OpenTestExecutableIdentityLease(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3];
  std::wstring path;
  int64_t expected_bytes = 0;
  size_t hash_length = 0;
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc != 3
      || !ReadTestObserverPath(env, argv[0], &path)
      || napi_get_value_int64(env, argv[1], &expected_bytes) != napi_ok || expected_bytes <= 0
      || expected_bytes > 1024LL * 1024LL * 1024LL
      || napi_get_value_string_utf8(env, argv[2], nullptr, 0, &hash_length) != napi_ok || hash_length != 64) {
    Throw(env, "EXEC_NATIVE_TEST_EXECUTABLE_IDENTITY", "Test executable identity arguments are invalid");
    return nullptr;
  }
  std::vector<char> hash_text(hash_length + 1);
  if (napi_get_value_string_utf8(env, argv[2], hash_text.data(), hash_text.size(), &hash_length) != napi_ok) {
    Throw(env, "EXEC_NATIVE_TEST_EXECUTABLE_IDENTITY", "Test executable identity arguments are invalid");
    return nullptr;
  }
  const std::string expected_sha256(hash_text.data(), hash_length);
  if (!mini_lux::sec03::CanonicalHex(expected_sha256, 32, 32)) {
    Throw(env, "EXEC_NATIVE_TEST_EXECUTABLE_IDENTITY", "Test executable identity arguments are invalid");
    return nullptr;
  }
  auto lease = std::make_unique<TestExecutableLease>();
  lease->path = path;
  lease->file = CreateFileW(path.c_str(), GENERIC_READ | FILE_READ_ATTRIBUTES, FILE_SHARE_READ, nullptr,
      OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
  LARGE_INTEGER bytes{};
  std::array<wchar_t, 32768> final_path{};
  const DWORD final_count = lease->file == INVALID_HANDLE_VALUE ? 0
    : GetFinalPathNameByHandleW(lease->file, final_path.data(), static_cast<DWORD>(final_path.size()),
        FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
  std::wstring opened = final_count && final_count < final_path.size()
    ? std::wstring(final_path.data(), final_count) : std::wstring{};
  if (opened.rfind(L"\\\\?\\UNC\\", 0) == 0) opened = L"\\\\" + opened.substr(8);
  else if (opened.rfind(L"\\\\?\\", 0) == 0) opened = opened.substr(4);
  std::array<wchar_t, MAX_PATH> volume_path{};
  std::array<wchar_t, 32> filesystem{};
  DWORD volume_serial = 0;
  std::string observed_sha256;
  const bool valid = lease->file != INVALID_HANDLE_VALUE
    && GetFileInformationByHandle(lease->file, &lease->identity)
    && !(lease->identity.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT))
    && GetFileSizeEx(lease->file, &bytes) && bytes.QuadPart == expected_bytes
    && opened == path
    && GetVolumePathNameW(opened.c_str(), volume_path.data(), static_cast<DWORD>(volume_path.size()))
    && GetDriveTypeW(volume_path.data()) == DRIVE_FIXED
    && GetVolumeInformationW(volume_path.data(), nullptr, 0, &volume_serial, nullptr, nullptr,
        filesystem.data(), static_cast<DWORD>(filesystem.size()))
    && volume_serial == lease->identity.dwVolumeSerialNumber && _wcsicmp(filesystem.data(), L"NTFS") == 0
    && Sha256Handle(lease->file, &observed_sha256) && observed_sha256 == expected_sha256;
  if (!valid) {
    if (lease->file != INVALID_HANDLE_VALUE) CloseHandle(lease->file);
    Throw(env, "EXEC_NATIVE_TEST_EXECUTABLE_IDENTITY", "Test executable does not match its exclusive identity lease");
    return nullptr;
  }
  lease->sha256 = expected_sha256;
  napi_value result, fn;
  if (napi_create_object(env, &result) != napi_ok
      || napi_create_function(env, "assertProcessIdentity", NAPI_AUTO_LENGTH,
          AssertTestExecutableProcessIdentity, nullptr, &fn) != napi_ok
      || napi_set_named_property(env, result, "assertProcessIdentity", fn) != napi_ok
      || napi_create_function(env, "close", NAPI_AUTO_LENGTH, CloseTestExecutableLease, nullptr, &fn) != napi_ok
      || napi_set_named_property(env, result, "close", fn) != napi_ok
      || napi_wrap(env, result, lease.get(), FinalizeTestExecutableLease, nullptr, nullptr) != napi_ok) {
    CloseHandle(lease->file);
    Throw(env, "EXEC_NATIVE_ABI_ERROR", "Cannot create test executable identity lease");
    return nullptr;
  }
  lease.release();
  return result;
}

napi_value OpenAclSharingLeaseForTest(napi_env env, napi_callback_info info) {
  size_t argc = 1; napi_value argv[1]; std::wstring path;
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc != 1 || !ReadTestObserverPath(env, argv[0], &path)) {
    Throw(env, "EXEC_NATIVE_TEST_ACL_SHARING", "ACL sharing stimulus path is invalid"); return nullptr;
  }
  auto lease = std::make_unique<TestExecutableLease>(); lease->path = path;
  lease->file = CreateFileW(path.c_str(), DELETE | READ_CONTROL | WRITE_DAC | FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
  std::array<wchar_t, 32768> final_path{}; const DWORD final_count = lease->file == INVALID_HANDLE_VALUE ? 0 : GetFinalPathNameByHandleW(lease->file, final_path.data(), static_cast<DWORD>(final_path.size()), FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
  std::wstring opened = final_count && final_count < final_path.size() ? std::wstring(final_path.data(), final_count) : std::wstring{}; if (opened.rfind(L"\\\\?\\", 0) == 0) opened = opened.substr(4);
  std::array<wchar_t, MAX_PATH> volume_path{}; std::array<wchar_t, 32> filesystem{}; DWORD volume_serial = 0;
  const bool valid = lease->file != INVALID_HANDLE_VALUE && GetFileInformationByHandle(lease->file, &lease->identity) && !(lease->identity.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) && lease->identity.nNumberOfLinks == 1 && opened == path
    && GetVolumePathNameW(opened.c_str(), volume_path.data(), static_cast<DWORD>(volume_path.size())) && GetDriveTypeW(volume_path.data()) == DRIVE_FIXED
    && GetVolumeInformationW(volume_path.data(), nullptr, 0, &volume_serial, nullptr, nullptr, filesystem.data(), static_cast<DWORD>(filesystem.size())) && volume_serial == lease->identity.dwVolumeSerialNumber && _wcsicmp(filesystem.data(), L"NTFS") == 0;
  if (!valid) { if (lease->file != INVALID_HANDLE_VALUE) CloseHandle(lease->file); Throw(env, "EXEC_NATIVE_TEST_ACL_SHARING", "ACL sharing stimulus is unavailable"); return nullptr; }
  napi_value result, fn; if (napi_create_object(env, &result) != napi_ok || napi_create_function(env, "close", NAPI_AUTO_LENGTH, CloseTestExecutableLease, nullptr, &fn) != napi_ok || napi_set_named_property(env, result, "close", fn) != napi_ok || napi_wrap(env, result, lease.get(), FinalizeTestExecutableLease, nullptr, nullptr) != napi_ok) {
    CloseHandle(lease->file); Throw(env, "EXEC_NATIVE_ABI_ERROR", "Cannot create ACL sharing stimulus lease"); return nullptr;
  }
  lease.release(); return result;
}

NtQueryInformationFileForTest ResolveTestFileHolderQuery() {
  HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
  FARPROC raw_query = ntdll ? GetProcAddress(ntdll, "NtQueryInformationFile") : nullptr;
  NtQueryInformationFileForTest query = nullptr;
  static_assert(sizeof(query) == sizeof(raw_query));
  memcpy(&query, &raw_query, sizeof(query));
  return query;
}

bool QueryTestFileHolders(NtQueryInformationFileForTest query, HANDLE file, std::set<DWORD>* holders) {
  alignas(ULONG_PTR) std::array<unsigned char, kTestObserverQueryBytes> storage{};
  std::array<ULONG_PTR, 2> io_status{};
  if (!query || query(file, io_status.data(), storage.data(), static_cast<ULONG>(storage.size()), 47) != 0) return false;
  const auto* information = reinterpret_cast<const TestFileProcessIds*>(storage.data());
  constexpr size_t first_pid = offsetof(TestFileProcessIds, process_ids);
  constexpr ULONG capacity = static_cast<ULONG>((kTestObserverQueryBytes - first_pid) / sizeof(ULONG_PTR));
  if (information->count > capacity) return false;
  holders->clear();
  for (ULONG index = 0; index < information->count; ++index) {
    const ULONG_PTR value = information->process_ids[index];
    if (!value || value > UINT32_MAX) return false;
    holders->insert(static_cast<DWORD>(value));
  }
  return true;
}

bool SnapshotTestProcessParents(std::map<DWORD, DWORD>* parents) {
  TestObserverHandle snapshot(CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0));
  if (snapshot.get() == INVALID_HANDLE_VALUE) return false;
  PROCESSENTRY32W entry{}; entry.dwSize = static_cast<DWORD>(sizeof(entry));
  if (!Process32FirstW(snapshot.get(), &entry)) return false;
  parents->clear();
  for (;;) {
    if (!parents->emplace(entry.th32ProcessID, entry.th32ParentProcessID).second || parents->size() > kTestObserverMaxProcesses) return false;
    entry.dwSize = static_cast<DWORD>(sizeof(entry));
    SetLastError(ERROR_SUCCESS);
    if (!Process32NextW(snapshot.get(), &entry)) return GetLastError() == ERROR_NO_MORE_FILES;
  }
}

bool TestProcessCreationTime(DWORD process, uint64_t* creation) {
  HANDLE handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, process);
  if (!handle) return false;
  FILETIME created{}, exited{}, kernel{}, user{}; const bool valid = GetProcessTimes(handle, &created, &exited, &kernel, &user) != FALSE; CloseHandle(handle);
  if (!valid) return false;
  *creation = (static_cast<uint64_t>(created.dwHighDateTime) << 32) | created.dwLowDateTime; return true;
}

bool CaptureTestProcessIdentities(const std::set<DWORD>& processes, std::map<DWORD, uint64_t>* identities) {
  identities->clear();
  for (DWORD process : processes) {
    uint64_t creation = 0;
    if (!TestProcessCreationTime(process, &creation) || !identities->emplace(process, creation).second) return false;
  }
  return true;
}

TestTreeMembership TestProcessInTree(DWORD process, uint64_t expected_creation, DWORD root, uint64_t root_creation, const std::map<DWORD, DWORD>& parents, const char** invalid_stage) {
  if (!parents.count(process)) { *invalid_stage = "Native test observer process snapshot is invalid"; return TestTreeMembership::invalid; }
  uint64_t current_creation = 0;
  if (!TestProcessCreationTime(process, &current_creation) || current_creation != expected_creation) { *invalid_stage = "Native test observer process identity is invalid"; return TestTreeMembership::invalid; }
  if (root_creation > current_creation) return TestTreeMembership::outside;
  std::set<DWORD> seen;
  DWORD current = process;
  for (size_t depth = 0; depth <= parents.size(); ++depth) {
    if (current == root) {
      if (current_creation == root_creation) return TestTreeMembership::inside;
      *invalid_stage = "Native test observer root identity is invalid"; return TestTreeMembership::invalid;
    }
    if (!current || !seen.insert(current).second) { *invalid_stage = "Native test observer ancestry is invalid"; return TestTreeMembership::invalid; }
    const auto parent = parents.find(current);
    if (parent == parents.end()) { *invalid_stage = "Native test observer ancestry is incomplete"; return TestTreeMembership::invalid; }
    const DWORD parent_process = parent->second;
    if (!parent_process) { *invalid_stage = "Native test observer ancestry is incomplete"; return TestTreeMembership::invalid; }
    uint64_t parent_creation = 0;
    if (!TestProcessCreationTime(parent_process, &parent_creation)) { *invalid_stage = "Native test observer ancestor identity is unavailable"; return TestTreeMembership::invalid; }
    if (parent_creation > current_creation) { *invalid_stage = "Native test observer ancestry chronology is invalid"; return TestTreeMembership::invalid; }
    current = parent_process;
    current_creation = parent_creation;
  }
  *invalid_stage = "Native test observer ancestry depth is invalid"; return TestTreeMembership::invalid;
}

napi_value ObserveWindowsFileHandleInProcessTreeForTest(napi_env env, napi_callback_info info) {
  size_t argc = 3; napi_value argv[3];
  if (!Ok(env, napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr), "Cannot read native test observer arguments")) return nullptr;
  napi_valuetype pid_type = napi_undefined; double pid_number = 0;
  std::wstring canonical_path;
  if (argc != 2 || !ReadTestObserverPath(env, argv[0], &canonical_path) || napi_typeof(env, argv[1], &pid_type) != napi_ok || pid_type != napi_number
      || napi_get_value_double(env, argv[1], &pid_number) != napi_ok || !std::isfinite(pid_number) || pid_number < 1 || pid_number > UINT32_MAX
      || pid_number != static_cast<double>(static_cast<uint32_t>(pid_number))) {
    Throw(env, "EXEC_NATIVE_TEST_OBSERVER_INPUT", "Native test observer arguments are invalid"); return nullptr;
  }
  const DWORD root = static_cast<DWORD>(pid_number);
  TestObserverHandle file(CreateFileW(canonical_path.c_str(), FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr));
  if (file.get() == INVALID_HANDLE_VALUE) { Throw(env, "EXEC_NATIVE_TEST_OBSERVER_UNAVAILABLE", "Native test observer target is unavailable"); return nullptr; }
  std::array<wchar_t, 32768> normalized{}; const DWORD normalized_count = GetFinalPathNameByHandleW(file.get(), normalized.data(), static_cast<DWORD>(normalized.size()), FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
  std::wstring opened = normalized_count && normalized_count < normalized.size() ? std::wstring(normalized.data(), normalized_count) : std::wstring{};
  if (opened.rfind(L"\\\\?\\UNC\\", 0) == 0) opened = L"\\\\" + opened.substr(8); else if (opened.rfind(L"\\\\?\\", 0) == 0) opened = opened.substr(4);
  if (opened != canonical_path) { Throw(env, "EXEC_NATIVE_TEST_OBSERVER_INPUT", "Native test observer arguments are invalid"); return nullptr; }
  const NtQueryInformationFileForTest query = ResolveTestFileHolderQuery();
  std::set<DWORD> before, after;
  std::map<DWORD, uint64_t> before_identities;
  std::map<DWORD, DWORD> parents;
  if (!QueryTestFileHolders(query, file.get(), &before) || !CaptureTestProcessIdentities(before, &before_identities)
      || !SnapshotTestProcessParents(&parents) || !QueryTestFileHolders(query, file.get(), &after)) {
    Throw(env, "EXEC_NATIVE_TEST_OBSERVER_QUERY", "Native test observer query failed"); return nullptr;
  }
  uint64_t root_creation = 0;
  if (!parents.count(root) || !TestProcessCreationTime(root, &root_creation)) { Throw(env, "EXEC_NATIVE_TEST_OBSERVER_DOMAIN", "Native test observer domain is invalid"); return nullptr; }
  const DWORD observer = GetCurrentProcessId();
  uint64_t observer_creation = 0;
  if (!TestProcessCreationTime(observer, &observer_creation)) { Throw(env, "EXEC_NATIVE_TEST_OBSERVER_DOMAIN", "Native test observer domain is invalid"); return nullptr; }
  const char* invalid_stage = "Native test observer domain is invalid";
  const TestTreeMembership observer_membership = TestProcessInTree(observer, observer_creation, root, root_creation, parents, &invalid_stage);
  if (observer_membership != TestTreeMembership::outside) { Throw(env, "EXEC_NATIVE_TEST_OBSERVER_DOMAIN", observer_membership == TestTreeMembership::invalid ? invalid_stage : "Native test observer domain is invalid"); return nullptr; }
  std::vector<DWORD> holders;
  std::set_intersection(before.begin(), before.end(), after.begin(), after.end(), std::back_inserter(holders));
  holders.erase(std::remove(holders.begin(), holders.end(), observer), holders.end());
  uint32_t matching = 0;
  for (DWORD holder : holders) {
    const auto holder_identity = before_identities.find(holder);
    if (holder_identity == before_identities.end()) { Throw(env, "EXEC_NATIVE_TEST_OBSERVER_DOMAIN", "Native test observer domain is invalid"); return nullptr; }
    const TestTreeMembership membership = TestProcessInTree(holder, holder_identity->second, root, root_creation, parents, &invalid_stage);
    if (membership == TestTreeMembership::invalid) { Throw(env, "EXEC_NATIVE_TEST_OBSERVER_DOMAIN", invalid_stage); return nullptr; }
    if (membership == TestTreeMembership::inside) ++matching;
  }
  napi_value holder_count, matching_count, matched, result;
  if (napi_create_uint32(env, static_cast<uint32_t>(holders.size()), &holder_count) != napi_ok || napi_create_uint32(env, matching, &matching_count) != napi_ok
      || napi_get_boolean(env, matching != 0, &matched) != napi_ok || napi_create_object(env, &result) != napi_ok) {
    Throw(env, "EXEC_NATIVE_ABI_ERROR", "Cannot create native test observer result"); return nullptr;
  }
  napi_property_descriptor properties[] = {
    {"holderCount", nullptr, nullptr, nullptr, nullptr, holder_count, napi_enumerable, nullptr},
    {"matchingCount", nullptr, nullptr, nullptr, nullptr, matching_count, napi_enumerable, nullptr},
    {"matched", nullptr, nullptr, nullptr, nullptr, matched, napi_enumerable, nullptr},
  };
  if (napi_define_properties(env, result, sizeof(properties) / sizeof(properties[0]), properties) != napi_ok || napi_object_freeze(env, result) != napi_ok) {
    Throw(env, "EXEC_NATIVE_ABI_ERROR", "Cannot freeze native test observer result"); return nullptr;
  }
  return result;
}

bool CreateTestRegistryText(napi_env env, const std::wstring& text, napi_value* result) {
  static_assert(sizeof(wchar_t) == sizeof(char16_t));
  return napi_create_string_utf16(env, reinterpret_cast<const char16_t*>(text.data()), text.size(), result) == napi_ok;
}

bool CreateTestRegistryValue(napi_env env, const TestRegistryValue& value, napi_value* result) {
  return value.present ? CreateTestRegistryText(env, value.text, result) : napi_get_null(env, result) == napi_ok;
}

bool CreateFrozenTestRegistryItem(napi_env env, const TestRegistryItem& item, napi_value* result) {
  std::array<napi_value, 6> values{};
  if (!CreateTestRegistryText(env, item.child_name, &values[0])) return false;
  for (size_t index = 0; index < item.values.size(); ++index) {
    if (!CreateTestRegistryValue(env, item.values[index], &values[index + 1])) return false;
  }
  if (napi_create_object(env, result) != napi_ok) return false;
  napi_property_descriptor properties[] = {
    {"PSChildName", nullptr, nullptr, nullptr, nullptr, values[0], napi_enumerable, nullptr},
    {"DisplayName", nullptr, nullptr, nullptr, nullptr, values[1], napi_enumerable, nullptr},
    {"DisplayVersion", nullptr, nullptr, nullptr, nullptr, values[2], napi_enumerable, nullptr},
    {"InstallLocation", nullptr, nullptr, nullptr, nullptr, values[3], napi_enumerable, nullptr},
    {"UninstallString", nullptr, nullptr, nullptr, nullptr, values[4], napi_enumerable, nullptr},
    {"QuietUninstallString", nullptr, nullptr, nullptr, nullptr, values[5], napi_enumerable, nullptr},
  };
  return napi_define_properties(env, *result, sizeof(properties) / sizeof(properties[0]), properties) == napi_ok
    && napi_object_freeze(env, *result) == napi_ok;
}

bool CreateFrozenTestRegistrySnapshot(napi_env env, bool root_present, const std::vector<TestRegistryItem>& items, napi_value* result) {
  napi_value present, array;
  if (napi_get_boolean(env, root_present, &present) != napi_ok || napi_create_array_with_length(env, items.size(), &array) != napi_ok) return false;
  for (size_t index = 0; index < items.size(); ++index) {
    napi_value item;
    if (!CreateFrozenTestRegistryItem(env, items[index], &item) || napi_set_element(env, array, static_cast<uint32_t>(index), item) != napi_ok) return false;
  }
  if (napi_object_freeze(env, array) != napi_ok || napi_create_object(env, result) != napi_ok) return false;
  napi_property_descriptor properties[] = {
    {"rootPresent", nullptr, nullptr, nullptr, nullptr, present, napi_enumerable, nullptr},
    {"items", nullptr, nullptr, nullptr, nullptr, array, napi_enumerable, nullptr},
  };
  return napi_define_properties(env, *result, sizeof(properties) / sizeof(properties[0]), properties) == napi_ok
    && napi_object_freeze(env, *result) == napi_ok;
}

napi_value ObserveWindowsRegistrySnapshotForTest(napi_env env, napi_callback_info info) {
  size_t argc = 2; napi_value argv[2];
  if (!Ok(env, napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr), "Cannot read native test observer arguments")) return nullptr;
  std::wstring subkey;
  if (argc != 1 || !ReadTestRegistrySubkey(env, argv[0], &subkey)) {
    Throw(env, "EXEC_NATIVE_TEST_OBSERVER_INPUT", "Native test observer arguments are invalid"); return nullptr;
  }
  HKEY raw_root = nullptr;
  const LSTATUS open = RegOpenKeyExW(HKEY_CURRENT_USER, subkey.c_str(), 0, KEY_READ, &raw_root);
  if (open == ERROR_FILE_NOT_FOUND || open == ERROR_PATH_NOT_FOUND) {
    napi_value missing;
    if (!CreateFrozenTestRegistrySnapshot(env, false, {}, &missing)) {
      Throw(env, "EXEC_NATIVE_ABI_ERROR", "Cannot create native test observer result"); return nullptr;
    }
    return missing;
  }
  if (open != ERROR_SUCCESS) {
    Throw(env, "EXEC_NATIVE_TEST_OBSERVER_QUERY", "Native test observer query failed"); return nullptr;
  }
  TestObserverRegistryKey root(raw_root);
  TestRegistryKeyState initial;
  std::vector<TestRegistryItem> items;
  if (!QueryTestRegistryRootState(root.get(), &initial) || !EnumerateTestRegistryItems(root.get(), initial, &items)) {
    Throw(env, "EXEC_NATIVE_TEST_OBSERVER_QUERY", "Native test observer query failed"); return nullptr;
  }
  napi_value result;
  if (!CreateFrozenTestRegistrySnapshot(env, true, items, &result)) {
    Throw(env, "EXEC_NATIVE_ABI_ERROR", "Cannot create native test observer result"); return nullptr;
  }
  return result;
}

napi_value ObserveWindowsRegistryKeyForTest(napi_env env, napi_callback_info info) {
  size_t argc = 2; napi_value argv[2];
  if (!Ok(env, napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr), "Cannot read native test observer arguments")) return nullptr;
  std::wstring subkey;
  if (argc != 1 || !ReadTestRegistrySubkey(env, argv[0], &subkey)) {
    Throw(env, "EXEC_NATIVE_TEST_OBSERVER_INPUT", "Native test observer arguments are invalid"); return nullptr;
  }
  HKEY raw_key = nullptr;
  const LSTATUS open = RegOpenKeyExW(HKEY_CURRENT_USER, subkey.c_str(), 0, KEY_QUERY_VALUE, &raw_key);
  if (open == ERROR_FILE_NOT_FOUND || open == ERROR_PATH_NOT_FOUND) {
    napi_value missing;
    if (!CreateFrozenTestRegistrySnapshot(env, false, {}, &missing)) {
      Throw(env, "EXEC_NATIVE_ABI_ERROR", "Cannot create native test observer result"); return nullptr;
    }
    return missing;
  }
  if (open != ERROR_SUCCESS) {
    Throw(env, "EXEC_NATIVE_TEST_OBSERVER_QUERY", "Native test observer query failed"); return nullptr;
  }
  TestObserverRegistryKey key(raw_key);
  TestRegistryItem item;
  const size_t separator = subkey.find_last_of(L'\\');
  item.child_name = separator == std::wstring::npos ? subkey : subkey.substr(separator + 1);
  static constexpr std::array<const wchar_t*, 5> value_names = {
    L"DisplayName", L"DisplayVersion", L"InstallLocation", L"UninstallString", L"QuietUninstallString",
  };
  FILETIME before_values{}, after_values{};
  if (!QueryTestRegistryWriteTime(key.get(), &before_values)) {
    Throw(env, "EXEC_NATIVE_TEST_OBSERVER_QUERY", "Native test observer query failed"); return nullptr;
  }
  for (size_t index = 0; index < value_names.size(); ++index) {
    if (!ReadTestRegistryValue(key.get(), value_names[index], &item.values[index])) {
      Throw(env, "EXEC_NATIVE_TEST_OBSERVER_QUERY", "Native test observer query failed"); return nullptr;
    }
  }
  if (!TestRegistryDisplayNameMatches(item.values[0]) || !QueryTestRegistryWriteTime(key.get(), &after_values)
      || !SameTestRegistryWriteTime(before_values, after_values)) {
    Throw(env, "EXEC_NATIVE_TEST_OBSERVER_QUERY", "Native test observer query failed"); return nullptr;
  }
  napi_value result;
  if (!CreateFrozenTestRegistrySnapshot(env, true, {item}, &result)) {
    Throw(env, "EXEC_NATIVE_ABI_ERROR", "Cannot create native test observer result"); return nullptr;
  }
  return result;
}

constexpr size_t kTestKnownFolderMaxChars = 32766;
constexpr size_t kTestProcessNeedleMaxChars = 32766;
constexpr size_t kTestProcessNeedleMaxCount = 16;
constexpr size_t kTestProcessNeedleMaxBytes = 128u * 1024u;
constexpr size_t kTestProcessImageMaxChars = 32767;
constexpr ULONG kTestProcessCommandLineMaxBytes = 128u * 1024u;
constexpr ULONG kTestProcessSnapshotInitialBytes = 64u * 1024u;
constexpr ULONG kTestProcessSnapshotMaxBytes = 16u * 1024u * 1024u;
constexpr size_t kTestProcessDiagnosticMaxBytes = 1024u * 1024u;
constexpr ULONGLONG kTestProcessQueryDeadlineMilliseconds = 5000;

enum class TestObserverInputResult { valid, invalid, abi_error };

class TestObserverKnownFolderPath {
 public:
  TestObserverKnownFolderPath() = default;
  ~TestObserverKnownFolderPath() { CoTaskMemFree(value_); }
  TestObserverKnownFolderPath(const TestObserverKnownFolderPath&) = delete;
  TestObserverKnownFolderPath& operator=(const TestObserverKnownFolderPath&) = delete;
  PWSTR* put() { return &value_; }
  const wchar_t* get() const { return value_; }
 private:
  PWSTR value_ = nullptr;
};

bool StrictTestProcessNeedlePath(const std::wstring& path) {
  if (path.size() < 3 || path.size() > kTestProcessNeedleMaxChars || path.find(L'/') != std::wstring::npos) return false;
  const bool drive = ((path[0] >= L'A' && path[0] <= L'Z') || (path[0] >= L'a' && path[0] <= L'z')) && path[1] == L':' && path[2] == L'\\';
  const bool unc = path.size() >= 5 && path[0] == L'\\' && path[1] == L'\\' && path[2] != L'?' && path[2] != L'.' && path[2] != L'\\';
  if (!drive && !unc) return false;
  size_t start = drive ? 3 : 2;
  size_t components = 0;
  while (start < path.size()) {
    const size_t end = path.find(L'\\', start);
    const size_t count = (end == std::wstring::npos ? path.size() : end) - start;
    if (!count) return false;
    const std::wstring component = path.substr(start, count);
    if (component == L"." || component == L".." || component.back() == L'.' || component.back() == L' '
        || component.find_first_of(L"\"<>|?*:") != std::wstring::npos
        || std::any_of(component.begin(), component.end(), [](wchar_t value) { return value < 0x20; })) return false;
    ++components;
    if (end == std::wstring::npos) break;
    start = end + 1;
    if (start == path.size()) break;
  }
  return drive || components >= 2;
}

TestObserverInputResult ReadTestProcessNeedle(napi_env env, napi_value value, size_t* total_bytes, std::wstring* result) {
  napi_valuetype type = napi_undefined;
  if (napi_typeof(env, value, &type) != napi_ok) return TestObserverInputResult::abi_error;
  if (type != napi_string) return TestObserverInputResult::invalid;
  size_t length = 0;
  if (napi_get_value_string_utf16(env, value, nullptr, 0, &length) != napi_ok) return TestObserverInputResult::abi_error;
  if (!length || length > kTestProcessNeedleMaxChars || length > (kTestProcessNeedleMaxBytes - *total_bytes) / sizeof(char16_t)) return TestObserverInputResult::invalid;
  std::vector<char16_t> text(length + 1);
  size_t received = 0;
  if (napi_get_value_string_utf16(env, value, text.data(), text.size(), &received) != napi_ok || received != length) return TestObserverInputResult::abi_error;
  result->clear(); result->reserve(length);
  for (size_t index = 0; index < length; ++index) {
    if (!text[index]) return TestObserverInputResult::invalid;
    result->push_back(static_cast<wchar_t>(text[index]));
  }
  if (!StrictTestProcessNeedlePath(*result)) return TestObserverInputResult::invalid;
  *total_bytes += length * sizeof(char16_t);
  return TestObserverInputResult::valid;
}

bool CreateFrozenTestKnownFolders(napi_env env, const std::wstring& programs, const std::wstring& desktop, napi_value* result) {
  static_assert(sizeof(wchar_t) == sizeof(char16_t));
  napi_value programs_value, desktop_value;
  if (napi_create_string_utf16(env, reinterpret_cast<const char16_t*>(programs.data()), programs.size(), &programs_value) != napi_ok
      || napi_create_string_utf16(env, reinterpret_cast<const char16_t*>(desktop.data()), desktop.size(), &desktop_value) != napi_ok
      || napi_create_object(env, result) != napi_ok) return false;
  napi_property_descriptor properties[] = {
    {"programs", nullptr, nullptr, nullptr, nullptr, programs_value, napi_enumerable, nullptr},
    {"desktop", nullptr, nullptr, nullptr, nullptr, desktop_value, napi_enumerable, nullptr},
  };
  return napi_define_properties(env, *result, sizeof(properties) / sizeof(properties[0]), properties) == napi_ok
    && napi_object_freeze(env, *result) == napi_ok;
}

napi_value ObserveWindowsKnownFolderPathsForTest(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  if (!Ok(env, napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr), "Cannot read native test observer arguments")) return nullptr;
  if (argc != 0) { Throw(env, "EXEC_NATIVE_TEST_OBSERVER_INPUT", "Native test observer arguments are invalid"); return nullptr; }
  TestObserverKnownFolderPath programs;
  TestObserverKnownFolderPath desktop;
  if (FAILED(SHGetKnownFolderPath(FOLDERID_Programs, KF_FLAG_DEFAULT, nullptr, programs.put()))
      || FAILED(SHGetKnownFolderPath(FOLDERID_Desktop, KF_FLAG_DEFAULT, nullptr, desktop.put()))) {
    Throw(env, "EXEC_NATIVE_TEST_OBSERVER_QUERY", "Native test observer query failed"); return nullptr;
  }
  const size_t programs_length = programs.get() ? wcsnlen_s(programs.get(), kTestKnownFolderMaxChars + 1) : 0;
  const size_t desktop_length = desktop.get() ? wcsnlen_s(desktop.get(), kTestKnownFolderMaxChars + 1) : 0;
  if (!programs_length || programs_length > kTestKnownFolderMaxChars || !desktop_length || desktop_length > kTestKnownFolderMaxChars) {
    Throw(env, "EXEC_NATIVE_TEST_OBSERVER_QUERY", "Native test observer query failed"); return nullptr;
  }
  napi_value result;
  if (!CreateFrozenTestKnownFolders(env, std::wstring(programs.get(), programs_length), std::wstring(desktop.get(), desktop_length), &result)) {
    Throw(env, "EXEC_NATIVE_ABI_ERROR", "Cannot create native test observer result"); return nullptr;
  }
  return result;
}

using NtQueryInformationProcessForTest = LONG(NTAPI*)(HANDLE, ULONG, void*, ULONG, ULONG*);
using NtQuerySystemInformationForTest = LONG(NTAPI*)(ULONG, void*, ULONG, ULONG*);

struct TestProcessUnicodeString {
  USHORT length;
  USHORT maximum_length;
  wchar_t* buffer;
};

struct TestSystemUnicodeStringX64 {
  std::uint16_t length;
  std::uint16_t maximum_length;
  std::uint32_t padding;
  std::uint64_t buffer;
};

struct TestSystemProcessInformationX64 {
  std::uint32_t next_entry_offset;
  std::uint32_t number_of_threads;
  std::int64_t working_set_private_size;
  std::uint32_t hard_fault_count;
  std::uint32_t number_of_threads_high_watermark;
  std::uint64_t cycle_time;
  std::int64_t create_time;
  std::int64_t user_time;
  std::int64_t kernel_time;
  TestSystemUnicodeStringX64 image_name;
  std::int32_t base_priority;
  std::uint32_t padding;
  std::uint64_t process_id;
  std::uint64_t parent_process_id;
  std::uint32_t handle_count;
  std::uint32_t session_id;
};

static_assert(sizeof(void*) == 8);
static_assert(sizeof(TestProcessUnicodeString) == 16);
static_assert(sizeof(TestSystemProcessInformationX64) == 104);
static_assert(offsetof(TestSystemProcessInformationX64, create_time) == 32);
static_assert(offsetof(TestSystemProcessInformationX64, process_id) == 80);
static_assert(offsetof(TestSystemProcessInformationX64, parent_process_id) == 88);
static_assert(offsetof(TestSystemProcessInformationX64, session_id) == 100);

struct TestProcessIdentity {
  DWORD session_id;
  DWORD pid;
  std::uint64_t creation;
  DWORD parent_pid;
};

constexpr bool SameTestProcessIdentity(const TestProcessIdentity& left, const TestProcessIdentity& right) {
  return left.session_id == right.session_id && left.pid == right.pid && left.creation == right.creation;
}

constexpr bool ConfirmedTestProcessIdentity(const TestProcessIdentity& expected, const TestProcessIdentity* observed) {
  return observed && SameTestProcessIdentity(expected, *observed);
}

enum class TestProcessSnapshotTransition { already_inspected, inspect_again };

constexpr TestProcessSnapshotTransition ClassifyTestProcessSnapshotTransition(
    const TestProcessIdentity* inspected, const TestProcessIdentity& current) {
  return ConfirmedTestProcessIdentity(current, inspected)
    ? TestProcessSnapshotTransition::already_inspected
    : TestProcessSnapshotTransition::inspect_again;
}

constexpr TestProcessIdentity kTestProcessIdentityProof{1, 2, 3, 0};
constexpr TestProcessIdentity kTestProcessIdentitySame{1, 2, 3, 0};
constexpr TestProcessIdentity kTestProcessIdentityOtherSession{4, 2, 3, 0};
constexpr TestProcessIdentity kTestProcessIdentityOtherPid{1, 5, 3, 0};
constexpr TestProcessIdentity kTestProcessIdentityReusedPid{1, 2, 4, 0};
static_assert(ClassifyTestProcessSnapshotTransition(&kTestProcessIdentitySame, kTestProcessIdentityProof)
  == TestProcessSnapshotTransition::already_inspected);
static_assert(ClassifyTestProcessSnapshotTransition(&kTestProcessIdentityOtherSession, kTestProcessIdentityProof)
  == TestProcessSnapshotTransition::inspect_again);
static_assert(ClassifyTestProcessSnapshotTransition(&kTestProcessIdentityOtherPid, kTestProcessIdentityProof)
  == TestProcessSnapshotTransition::inspect_again);
static_assert(ClassifyTestProcessSnapshotTransition(&kTestProcessIdentityReusedPid, kTestProcessIdentityProof)
  == TestProcessSnapshotTransition::inspect_again);
static_assert(ClassifyTestProcessSnapshotTransition(nullptr, kTestProcessIdentityProof)
  == TestProcessSnapshotTransition::inspect_again);

class TestObservedProcess {
 public:
  TestObservedProcess(const TestProcessIdentity& process_identity, HANDLE process_handle)
      : identity(process_identity), handle(process_handle) {}
  ~TestObservedProcess() { if (handle) CloseHandle(handle); }
  TestObservedProcess(const TestObservedProcess&) = delete;
  TestObservedProcess& operator=(const TestObservedProcess&) = delete;
  TestObservedProcess(TestObservedProcess&& other) noexcept
      : identity(other.identity), handle(other.handle), image_name(std::move(other.image_name)),
        image_matched(other.image_matched), command_line_matched(other.command_line_matched),
        reconciled(other.reconciled) { other.handle = nullptr; }
  TestObservedProcess& operator=(TestObservedProcess&&) = delete;
  TestProcessIdentity identity;
  HANDLE handle;
  std::wstring image_name;
  bool image_matched = false;
  bool command_line_matched = false;
  bool reconciled = false;
};

struct TestProcessMatch {
  std::string identity_id;
  DWORD pid;
  DWORD parent_pid;
  std::wstring image_name;
  bool image_matched;
  bool command_line_matched;
};

NtQueryInformationProcessForTest ResolveTestProcessQuery() {
  HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
  FARPROC raw_query = ntdll ? GetProcAddress(ntdll, "NtQueryInformationProcess") : nullptr;
  NtQueryInformationProcessForTest query = nullptr;
  static_assert(sizeof(query) == sizeof(raw_query));
  memcpy(&query, &raw_query, sizeof(query));
  return query;
}

NtQuerySystemInformationForTest ResolveTestSystemProcessQuery() {
  HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
  FARPROC raw_query = ntdll ? GetProcAddress(ntdll, "NtQuerySystemInformation") : nullptr;
  NtQuerySystemInformationForTest query = nullptr;
  static_assert(sizeof(query) == sizeof(raw_query));
  memcpy(&query, &raw_query, sizeof(query));
  return query;
}

bool TestProcessBeforeDeadline(ULONGLONG deadline) {
  return GetTickCount64() < deadline;
}

bool ParseTestSystemProcessSnapshot(const void* buffer, ULONG bytes, DWORD observer_session, ULONGLONG deadline,
    std::map<DWORD, TestProcessIdentity>* processes) {
  if (!buffer || bytes < sizeof(TestSystemProcessInformationX64)
      || (reinterpret_cast<uintptr_t>(buffer) % alignof(TestSystemProcessInformationX64)) != 0) return false;
  const auto* raw = static_cast<const unsigned char*>(buffer);
  const uintptr_t base = reinterpret_cast<uintptr_t>(buffer);
  std::set<DWORD> seen;
  processes->clear();
  size_t offset = 0;
  for (;;) {
    if (!TestProcessBeforeDeadline(deadline) || (offset % alignof(TestSystemProcessInformationX64)) != 0
        || offset > bytes || sizeof(TestSystemProcessInformationX64) > bytes - offset) return false;
    TestSystemProcessInformationX64 entry{};
    memcpy(&entry, raw + offset, sizeof(entry));
    const size_t entry_bytes = entry.next_entry_offset ? entry.next_entry_offset : static_cast<size_t>(bytes) - offset;
    if (entry_bytes < sizeof(entry) || (entry.next_entry_offset && ((entry.next_entry_offset % alignof(TestSystemProcessInformationX64)) != 0
        || entry.next_entry_offset > bytes - offset))) return false;
    if ((entry.image_name.length % sizeof(wchar_t)) != 0 || (entry.image_name.maximum_length % sizeof(wchar_t)) != 0
        || entry.image_name.length > entry.image_name.maximum_length) return false;
    if (!entry.image_name.buffer) {
      if (entry.image_name.length || entry.image_name.maximum_length) return false;
    } else {
      if ((entry.image_name.buffer % alignof(wchar_t)) != 0 || entry.image_name.buffer < base) return false;
      const std::uint64_t image_offset64 = entry.image_name.buffer - base;
      if (image_offset64 > bytes || image_offset64 < offset + sizeof(entry)) return false;
      const size_t image_offset = static_cast<size_t>(image_offset64);
      if (image_offset > offset + entry_bytes || entry.image_name.maximum_length > offset + entry_bytes - image_offset) return false;
    }
    if (entry.process_id > UINT32_MAX || entry.parent_process_id > UINT32_MAX) return false;
    const DWORD pid = static_cast<DWORD>(entry.process_id);
    if (!seen.insert(pid).second || seen.size() > kTestObserverMaxProcesses) return false;
    if (pid != 0 && entry.create_time <= 0) return false;
    if (pid != 0 && entry.session_id == observer_session) {
      TestProcessIdentity identity{entry.session_id, pid, static_cast<std::uint64_t>(entry.create_time), static_cast<DWORD>(entry.parent_process_id)};
      if (!processes->emplace(pid, identity).second) return false;
    }
    if (!entry.next_entry_offset) return true;
    offset += entry.next_entry_offset;
  }
}

bool SnapshotTestProcesses(NtQuerySystemInformationForTest query, DWORD observer_session, ULONGLONG deadline,
    std::map<DWORD, TestProcessIdentity>* processes) {
  if (!query) return false;
  ULONG buffer_bytes = kTestProcessSnapshotInitialBytes;
  for (size_t attempt = 0; attempt < 10; ++attempt) {
    if (!TestProcessBeforeDeadline(deadline) || buffer_bytes > kTestProcessSnapshotMaxBytes) return false;
    std::vector<std::uint64_t> storage((static_cast<size_t>(buffer_bytes) + sizeof(std::uint64_t) - 1) / sizeof(std::uint64_t));
    const ULONG capacity = static_cast<ULONG>(storage.size() * sizeof(std::uint64_t));
    ULONG returned = 0;
    const ULONG status = static_cast<ULONG>(query(5, storage.data(), capacity, &returned));
    if (!TestProcessBeforeDeadline(deadline)) return false;
    if (status == 0) {
      return returned >= sizeof(TestSystemProcessInformationX64) && returned <= capacity
        && ParseTestSystemProcessSnapshot(storage.data(), returned, observer_session, deadline, processes);
    }
    if (status != 0xC0000004UL && status != 0xC0000023UL && status != 0x80000005UL) return false;
    if (returned > kTestProcessSnapshotMaxBytes || capacity == kTestProcessSnapshotMaxBytes) return false;
    ULONG next = capacity <= kTestProcessSnapshotMaxBytes / 2 ? capacity * 2 : kTestProcessSnapshotMaxBytes;
    if (returned > next) next = returned;
    if (next > kTestProcessSnapshotMaxBytes || next <= capacity) return false;
    buffer_bytes = static_cast<ULONG>((next + sizeof(std::uint64_t) - 1) & ~(sizeof(std::uint64_t) - 1));
  }
  return false;
}

bool TestProcessExitState(HANDLE process, bool* exited) {
  const DWORD wait = WaitForSingleObject(process, 0);
  if (wait == WAIT_OBJECT_0) { *exited = true; return true; }
  if (wait == WAIT_TIMEOUT) { *exited = false; return true; }
  return false;
}

bool TestProcessHandleCreationTime(HANDLE process, uint64_t* creation) {
  FILETIME created{}, exited{}, kernel{}, user{};
  if (!GetProcessTimes(process, &created, &exited, &kernel, &user)) return false;
  *creation = (static_cast<uint64_t>(created.dwHighDateTime) << 32) | created.dwLowDateTime;
  return true;
}

enum class TestProcessReadResult { observed, unavailable, malformed };
enum class TestProcessInspectResult { observed, unknown, gone, failed };

constexpr bool TestProcessInspectionAccountsForActive(TestProcessInspectResult inspected) {
  return inspected == TestProcessInspectResult::observed || inspected == TestProcessInspectResult::unknown;
}

static_assert(TestProcessInspectionAccountsForActive(TestProcessInspectResult::observed));
static_assert(TestProcessInspectionAccountsForActive(TestProcessInspectResult::unknown));
static_assert(!TestProcessInspectionAccountsForActive(TestProcessInspectResult::gone));
static_assert(!TestProcessInspectionAccountsForActive(TestProcessInspectResult::failed));

TestProcessReadResult ReadTestProcessImagePath(HANDLE process, std::wstring* path) {
  std::array<wchar_t, kTestProcessImageMaxChars> buffer{};
  DWORD length = static_cast<DWORD>(buffer.size());
  if (!QueryFullProcessImageNameW(process, 0, buffer.data(), &length)) return TestProcessReadResult::unavailable;
  if (!length || length >= buffer.size()
      || std::find(buffer.begin(), buffer.begin() + length, L'\0') != buffer.begin() + length) return TestProcessReadResult::malformed;
  path->assign(buffer.data(), length);
  return TestProcessReadResult::observed;
}

TestProcessReadResult ReadTestProcessCommandLine(NtQueryInformationProcessForTest query, HANDLE process,
    ULONGLONG deadline, std::wstring* command_line) {
  if (!query) return TestProcessReadResult::unavailable;
  ULONG required = 0;
  if (!TestProcessBeforeDeadline(deadline)) return TestProcessReadResult::malformed;
  const ULONG first_status = static_cast<ULONG>(query(process, 60, nullptr, 0, &required));
  if (!TestProcessBeforeDeadline(deadline)) return TestProcessReadResult::malformed;
  if (first_status != 0xC0000004UL && first_status != 0xC0000023UL && first_status != 0x80000005UL) {
    return TestProcessReadResult::unavailable;
  }
  if (required < sizeof(TestProcessUnicodeString) || required > kTestProcessCommandLineMaxBytes) return TestProcessReadResult::malformed;
  std::vector<unsigned char> storage(required);
  ULONG returned = 0;
  if (!TestProcessBeforeDeadline(deadline)) return TestProcessReadResult::malformed;
  const ULONG status = static_cast<ULONG>(query(process, 60, storage.data(), required, &returned));
  if (!TestProcessBeforeDeadline(deadline)) return TestProcessReadResult::malformed;
  if (status != 0) return TestProcessReadResult::unavailable;
  if (returned < sizeof(TestProcessUnicodeString) || returned > storage.size()) return TestProcessReadResult::malformed;
  const auto* value = reinterpret_cast<const TestProcessUnicodeString*>(storage.data());
  if ((value->length % sizeof(wchar_t)) != 0 || (value->maximum_length % sizeof(wchar_t)) != 0
      || value->length > value->maximum_length) return TestProcessReadResult::malformed;
  if (!value->buffer) {
    if (value->length || value->maximum_length) return TestProcessReadResult::malformed;
    command_line->clear();
    return TestProcessReadResult::observed;
  }
  const uintptr_t base = reinterpret_cast<uintptr_t>(storage.data());
  const uintptr_t text = reinterpret_cast<uintptr_t>(value->buffer);
  if (text < base + sizeof(TestProcessUnicodeString) || (text % alignof(wchar_t)) != 0) return TestProcessReadResult::malformed;
  const size_t offset = static_cast<size_t>(text - base);
  if (offset > returned || value->maximum_length > returned - offset) return TestProcessReadResult::malformed;
  const size_t length = value->length / sizeof(wchar_t);
  if (std::find(value->buffer, value->buffer + length, L'\0') != value->buffer + length) return TestProcessReadResult::malformed;
  command_line->assign(value->buffer, length);
  return TestProcessReadResult::observed;
}

bool TestProcessTextReferencesNeedle(const std::wstring& text, const std::vector<std::wstring>& needles,
    ULONGLONG deadline, bool* matched) {
  *matched = false;
  for (const auto& needle : needles) {
    if (needle.size() > text.size()) continue;
    const size_t last = text.size() - needle.size();
    for (size_t index = 0; index <= last; ++index) {
      if (!TestProcessBeforeDeadline(deadline)) return false;
      const int comparison = CompareStringOrdinal(text.data() + index, static_cast<int>(needle.size()),
          needle.data(), static_cast<int>(needle.size()), TRUE);
      if (!comparison) return false;
      if (comparison == CSTR_EQUAL) { *matched = true; return true; }
    }
  }
  return true;
}

TestProcessInspectResult TestProcessUnavailableOrGone(HANDLE process, ULONGLONG deadline) {
  if (!TestProcessBeforeDeadline(deadline)) return TestProcessInspectResult::failed;
  bool exited = false;
  if (TestProcessExitState(process, &exited) && exited) return TestProcessInspectResult::gone;
  return TestProcessBeforeDeadline(deadline) ? TestProcessInspectResult::unknown : TestProcessInspectResult::failed;
}

TestProcessInspectResult InspectTestProcess(const TestProcessIdentity& identity, NtQueryInformationProcessForTest query,
    const std::vector<std::wstring>& needles, ULONGLONG deadline, std::vector<TestObservedProcess>* observations) {
  if (!TestProcessBeforeDeadline(deadline)) return TestProcessInspectResult::failed;
  HANDLE raw_process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, identity.pid);
  if (!TestProcessBeforeDeadline(deadline)) { if (raw_process) CloseHandle(raw_process); return TestProcessInspectResult::failed; }
  if (!raw_process) return TestProcessInspectResult::unknown;
  TestObservedProcess process(identity, raw_process);
  bool exited = false;
  if (!TestProcessExitState(process.handle, &exited)) return TestProcessInspectResult::unknown;
  if (exited) return TestProcessInspectResult::gone;
  uint64_t creation = 0;
  if (!TestProcessHandleCreationTime(process.handle, &creation)) return TestProcessUnavailableOrGone(process.handle, deadline);
  if (!creation) return TestProcessInspectResult::failed;
  if (creation != identity.creation) return TestProcessUnavailableOrGone(process.handle, deadline);
  std::wstring image_path;
  std::wstring command_line;
  const TestProcessReadResult image = ReadTestProcessImagePath(process.handle, &image_path);
  const TestProcessReadResult command = ReadTestProcessCommandLine(query, process.handle, deadline, &command_line);
  if (!TestProcessBeforeDeadline(deadline) || image == TestProcessReadResult::malformed || command == TestProcessReadResult::malformed) {
    return TestProcessInspectResult::failed;
  }
  if (image != TestProcessReadResult::observed || command != TestProcessReadResult::observed) {
    return TestProcessUnavailableOrGone(process.handle, deadline);
  }
  bool image_matched = false;
  bool command_matched = false;
  if (!TestProcessTextReferencesNeedle(image_path, needles, deadline, &image_matched)
      || !TestProcessTextReferencesNeedle(command_line, needles, deadline, &command_matched)) return TestProcessInspectResult::failed;
  uint64_t confirmed_creation = 0;
  if (!TestProcessHandleCreationTime(process.handle, &confirmed_creation)) return TestProcessUnavailableOrGone(process.handle, deadline);
  if (confirmed_creation != identity.creation) return TestProcessInspectResult::failed;
  if (!TestProcessExitState(process.handle, &exited)) return TestProcessInspectResult::unknown;
  if (exited) return TestProcessInspectResult::gone;
  if (!TestProcessBeforeDeadline(deadline)) return TestProcessInspectResult::failed;
  if (image_matched || command_matched) {
    const size_t separator = image_path.find_last_of(L"\\/");
    process.image_name = separator == std::wstring::npos ? image_path : image_path.substr(separator + 1);
    if (process.image_name.empty()) return TestProcessInspectResult::failed;
  }
  process.image_matched = image_matched;
  process.command_line_matched = command_matched;
  observations->push_back(std::move(process));
  return TestProcessInspectResult::observed;
}

void AppendTestProcessU64(std::vector<unsigned char>* material, std::uint64_t value) {
  for (unsigned shift = 0; shift < 64; shift += 8) material->push_back(static_cast<unsigned char>(value >> shift));
}

bool TestProcessIdentityId(const TestProcessIdentity& identity, std::string* output) {
  static constexpr char domain[] = "mini-lux/sec03/windows-process-identity/v1";
  std::vector<unsigned char> material(domain, domain + sizeof(domain) - 1);
  material.push_back(0);
  mini_lux::sec03::AppendU32(&material, identity.session_id);
  mini_lux::sec03::AppendU32(&material, identity.pid);
  AppendTestProcessU64(&material, identity.creation);
  return mini_lux::sec03::Sha256(material.data(), material.size(), output)
    && mini_lux::sec03::CanonicalHex(*output, 32, 32);
}

bool AddUnknownTestProcessIdentity(const TestProcessIdentity& identity, size_t* diagnostic_bytes,
    std::set<std::string>* identities) {
  std::string digest;
  if (!TestProcessIdentityId(identity, &digest)) return false;
  const auto inserted = identities->insert(std::move(digest));
  if (inserted.second) {
    constexpr size_t record_bytes = 96;
    if (*diagnostic_bytes > kTestProcessDiagnosticMaxBytes - record_bytes) return false;
    *diagnostic_bytes += record_bytes;
  }
  return true;
}

bool AddTestProcessMatch(const TestObservedProcess& process, size_t* diagnostic_bytes,
    std::vector<TestProcessMatch>* matches) {
  constexpr size_t fixed_bytes = 128;
  if (process.image_name.empty() || process.image_name.size() > (kTestProcessDiagnosticMaxBytes - fixed_bytes) / sizeof(wchar_t)) return false;
  const size_t record_bytes = fixed_bytes + process.image_name.size() * sizeof(wchar_t);
  if (*diagnostic_bytes > kTestProcessDiagnosticMaxBytes - record_bytes) return false;
  TestProcessMatch match{};
  if (!TestProcessIdentityId(process.identity, &match.identity_id)) return false;
  match.pid = process.identity.pid;
  match.parent_pid = process.identity.parent_pid;
  match.image_name = process.image_name;
  match.image_matched = process.image_matched;
  match.command_line_matched = process.command_line_matched;
  matches->push_back(std::move(match));
  *diagnostic_bytes += record_bytes;
  return true;
}

bool ReconcileObservedTestProcess(TestObservedProcess* process, const TestProcessIdentity* second_identity,
    ULONGLONG deadline, bool* live) {
  *live = false;
  if (!TestProcessBeforeDeadline(deadline)) return false;
  bool exited = false;
  if (!TestProcessExitState(process->handle, &exited)) return false;
  if (exited) { process->reconciled = true; return true; }
  if (!second_identity || !SameTestProcessIdentity(process->identity, *second_identity)) return false;
  uint64_t creation = 0;
  if (!TestProcessHandleCreationTime(process->handle, &creation) || creation != process->identity.creation
      || !TestProcessBeforeDeadline(deadline) || !TestProcessExitState(process->handle, &exited)) return false;
  process->reconciled = true;
  *live = !exited;
  return true;
}

bool QueryTestProcessesReferencingPaths(const std::vector<std::wstring>& needles,
    std::vector<TestProcessMatch>* matching_processes, std::set<std::string>* unknown_identity_ids) {
  const ULONGLONG deadline = GetTickCount64() + kTestProcessQueryDeadlineMilliseconds;
  DWORD observer_session = 0;
  if (!TestProcessBeforeDeadline(deadline) || !ProcessIdToSessionId(GetCurrentProcessId(), &observer_session)) return false;
  const NtQuerySystemInformationForTest system_query = ResolveTestSystemProcessQuery();
  const NtQueryInformationProcessForTest process_query = ResolveTestProcessQuery();
  if (!system_query) return false;
  std::map<DWORD, TestProcessIdentity> current;
  if (!SnapshotTestProcesses(system_query, observer_session, deadline, &current)) return false;
  const DWORD observer_pid = GetCurrentProcessId();
  const auto observer_initial = current.find(observer_pid);
  if (observer_initial == current.end()) return false;
  const TestProcessIdentity observer_identity = observer_initial->second;
  for (;;) {
    if (!TestProcessBeforeDeadline(deadline)) return false;
    std::vector<TestObservedProcess> observations;
    observations.reserve(current.size());
    std::map<DWORD, TestProcessInspectResult> inspection_results;
    std::map<DWORD, size_t> observed_indices;
    std::map<DWORD, TestProcessIdentity> unknown_current;
    for (const auto& [pid, identity] : current) {
      const TestProcessInspectResult inspected = InspectTestProcess(identity, process_query, needles, deadline, &observations);
      if (!inspection_results.emplace(pid, inspected).second || inspected == TestProcessInspectResult::failed) return false;
      if (inspected == TestProcessInspectResult::observed) {
        if (!observed_indices.emplace(pid, observations.size() - 1).second) return false;
      } else if (inspected == TestProcessInspectResult::unknown) {
        if (!unknown_current.emplace(pid, identity).second) return false;
      }
    }
    std::map<DWORD, TestProcessIdentity> next;
    if (!SnapshotTestProcesses(system_query, observer_session, deadline, &next)) return false;
    const auto observer_next = next.find(observer_pid);
    if (observer_next == next.end() || !SameTestProcessIdentity(observer_identity, observer_next->second)) return false;
    std::map<DWORD, bool> observed_live;
    for (auto& process : observations) {
      const auto next_identity = next.find(process.identity.pid);
      const TestProcessIdentity* reconciled_identity = next_identity != next.end()
          && SameTestProcessIdentity(process.identity, next_identity->second) ? &next_identity->second : nullptr;
      bool live = false;
      if (!ReconcileObservedTestProcess(&process, reconciled_identity, deadline, &live)) return false;
      if (!observed_live.emplace(process.identity.pid, live).second) return false;
    }
    bool inspect_again = false;
    for (const auto& [pid, identity] : next) {
      const auto inspected = current.find(pid);
      const TestProcessIdentity* inspected_identity = inspected == current.end() ? nullptr : &inspected->second;
      if (ClassifyTestProcessSnapshotTransition(inspected_identity, identity)
          == TestProcessSnapshotTransition::inspect_again) {
        inspect_again = true;
        break;
      }
      if (!TestProcessInspectionAccountsForActive(inspection_results.at(pid))
          || (!observed_indices.count(pid) && !unknown_current.count(pid))) return false;
    }
    if (inspect_again) {
      current = std::move(next);
      continue;
    }
    matching_processes->clear();
    unknown_identity_ids->clear();
    size_t diagnostic_bytes = 0;
    for (const auto& [pid, identity] : next) {
      const auto observed = observed_indices.find(pid);
      if (observed != observed_indices.end()) {
        const TestObservedProcess& process = observations.at(observed->second);
        if (observed_live.at(pid) && (process.image_matched || process.command_line_matched)
            && !AddTestProcessMatch(process, &diagnostic_bytes, matching_processes)) return false;
      } else if (!AddUnknownTestProcessIdentity(identity, &diagnostic_bytes, unknown_identity_ids)) {
        return false;
      }
    }
    if (matching_processes->size() > kTestObserverMaxProcesses
        || unknown_identity_ids->size() > kTestObserverMaxProcesses || !TestProcessBeforeDeadline(deadline)) return false;
    return true;
  }
}

bool CreateFrozenTestProcessMatch(napi_env env, const TestProcessMatch& match, napi_value* result) {
  static_assert(sizeof(wchar_t) == sizeof(char16_t));
  napi_value identity, pid, parent_pid, image_name, image_matched, command_line_matched;
  if (napi_create_string_utf8(env, match.identity_id.c_str(), match.identity_id.size(), &identity) != napi_ok
      || napi_create_uint32(env, match.pid, &pid) != napi_ok
      || napi_create_uint32(env, match.parent_pid, &parent_pid) != napi_ok
      || napi_create_string_utf16(env, reinterpret_cast<const char16_t*>(match.image_name.data()), match.image_name.size(), &image_name) != napi_ok
      || napi_get_boolean(env, match.image_matched, &image_matched) != napi_ok
      || napi_get_boolean(env, match.command_line_matched, &command_line_matched) != napi_ok
      || napi_create_object(env, result) != napi_ok) return false;
  napi_property_descriptor properties[] = {
    {"identityId", nullptr, nullptr, nullptr, nullptr, identity, napi_enumerable, nullptr},
    {"processId", nullptr, nullptr, nullptr, nullptr, pid, napi_enumerable, nullptr},
    {"inheritedFromProcessId", nullptr, nullptr, nullptr, nullptr, parent_pid, napi_enumerable, nullptr},
    {"imageName", nullptr, nullptr, nullptr, nullptr, image_name, napi_enumerable, nullptr},
    {"imageMatched", nullptr, nullptr, nullptr, nullptr, image_matched, napi_enumerable, nullptr},
    {"commandLineMatched", nullptr, nullptr, nullptr, nullptr, command_line_matched, napi_enumerable, nullptr},
  };
  return napi_define_properties(env, *result, sizeof(properties) / sizeof(properties[0]), properties) == napi_ok
    && napi_object_freeze(env, *result) == napi_ok;
}

bool CreateFrozenTestProcessObservation(napi_env env, const std::vector<TestProcessMatch>& matching_processes,
    const std::set<std::string>& unknown_identity_ids, napi_value* result) {
  napi_value count, matches, identities;
  if (napi_create_uint32(env, static_cast<uint32_t>(matching_processes.size()), &count) != napi_ok
      || napi_create_array_with_length(env, matching_processes.size(), &matches) != napi_ok
      || napi_create_array_with_length(env, unknown_identity_ids.size(), &identities) != napi_ok) return false;
  for (size_t index = 0; index < matching_processes.size(); ++index) {
    napi_value value;
    if (!CreateFrozenTestProcessMatch(env, matching_processes[index], &value)
        || napi_set_element(env, matches, static_cast<uint32_t>(index), value) != napi_ok) return false;
  }
  uint32_t index = 0;
  for (const auto& identity : unknown_identity_ids) {
    napi_value value;
    if (napi_create_string_utf8(env, identity.c_str(), identity.size(), &value) != napi_ok
        || napi_set_element(env, identities, index++, value) != napi_ok) return false;
  }
  if (napi_object_freeze(env, matches) != napi_ok || napi_object_freeze(env, identities) != napi_ok
      || napi_create_object(env, result) != napi_ok) return false;
  napi_property_descriptor properties[] = {
    {"matchingCount", nullptr, nullptr, nullptr, nullptr, count, napi_enumerable, nullptr},
    {"matchingProcesses", nullptr, nullptr, nullptr, nullptr, matches, napi_enumerable, nullptr},
    {"unknownProcessIdentityIds", nullptr, nullptr, nullptr, nullptr, identities, napi_enumerable, nullptr},
  };
  return napi_define_properties(env, *result, sizeof(properties) / sizeof(properties[0]), properties) == napi_ok
    && napi_object_freeze(env, *result) == napi_ok;
}

napi_value ObserveWindowsProcessReferencesForTest(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  if (!Ok(env, napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr), "Cannot read native test observer arguments")) return nullptr;
  bool is_array = false;
  if (argc != 1) { Throw(env, "EXEC_NATIVE_TEST_OBSERVER_INPUT", "Native test observer arguments are invalid"); return nullptr; }
  if (napi_is_array(env, argv[0], &is_array) != napi_ok) { Throw(env, "EXEC_NATIVE_ABI_ERROR", "Cannot inspect native test observer arguments"); return nullptr; }
  if (!is_array) { Throw(env, "EXEC_NATIVE_TEST_OBSERVER_INPUT", "Native test observer arguments are invalid"); return nullptr; }
  uint32_t length = 0;
  if (napi_get_array_length(env, argv[0], &length) != napi_ok) { Throw(env, "EXEC_NATIVE_ABI_ERROR", "Cannot inspect native test observer arguments"); return nullptr; }
  if (!length || length > kTestProcessNeedleMaxCount) { Throw(env, "EXEC_NATIVE_TEST_OBSERVER_INPUT", "Native test observer arguments are invalid"); return nullptr; }
  std::vector<std::wstring> needles;
  needles.reserve(length);
  size_t total_bytes = 0;
  for (uint32_t index = 0; index < length; ++index) {
    napi_value value;
    if (napi_get_element(env, argv[0], index, &value) != napi_ok) { Throw(env, "EXEC_NATIVE_ABI_ERROR", "Cannot inspect native test observer arguments"); return nullptr; }
    std::wstring needle;
    const TestObserverInputResult read = ReadTestProcessNeedle(env, value, &total_bytes, &needle);
    if (read == TestObserverInputResult::abi_error) { Throw(env, "EXEC_NATIVE_ABI_ERROR", "Cannot inspect native test observer arguments"); return nullptr; }
    if (read != TestObserverInputResult::valid) { Throw(env, "EXEC_NATIVE_TEST_OBSERVER_INPUT", "Native test observer arguments are invalid"); return nullptr; }
    needles.push_back(std::move(needle));
  }
  std::vector<TestProcessMatch> matching_processes;
  std::set<std::string> unknown_identity_ids;
  if (!QueryTestProcessesReferencingPaths(needles, &matching_processes, &unknown_identity_ids)) {
    Throw(env, "EXEC_NATIVE_TEST_OBSERVER_QUERY", "Native test observer query failed"); return nullptr;
  }
  napi_value result;
  if (!CreateFrozenTestProcessObservation(env, matching_processes, unknown_identity_ids, &result)) {
    Throw(env, "EXEC_NATIVE_ABI_ERROR", "Cannot create native test observer result"); return nullptr;
  }
  return result;
}
#endif

std::wstring DosPathFromHandlePath(const wchar_t* path, DWORD count) {
  const std::wstring value(path, count);
  if (value.rfind(L"\\\\?\\UNC\\", 0) == 0) return L"\\\\" + value.substr(8);
  if (value.rfind(L"\\\\?\\", 0) == 0) return value.substr(4);
  return value;
}

bool SameCanonicalPath(std::wstring left, std::wstring right) {
  const auto trim = [](std::wstring* value) { while (value->size() > 3 && value->back() == L'\\') value->pop_back(); };
  trim(&left); trim(&right); return _wcsicmp(left.c_str(), right.c_str()) == 0;
}

bool HandleOpenedAs(HANDLE handle, const std::wstring& canonical) {
  std::array<wchar_t, 32768> opened{}; const DWORD count = GetFinalPathNameByHandleW(handle, opened.data(), static_cast<DWORD>(opened.size()), FILE_NAME_OPENED | VOLUME_NAME_DOS);
  if (!count || count >= opened.size()) return false; const std::wstring observed = DosPathFromHandlePath(opened.data(), count); if (SameCanonicalPath(observed, canonical)) return true;
  if (canonical.size() < 3 || canonical[1] != L':' || GetDriveTypeW(canonical.substr(0, 3).c_str()) != DRIVE_REMOTE) return false;
  std::vector<unsigned char> storage(128u * 1024u); DWORD bytes = static_cast<DWORD>(storage.size()); auto* universal = reinterpret_cast<UNIVERSAL_NAME_INFOW*>(storage.data());
  return WNetGetUniversalNameW(canonical.c_str(), UNIVERSAL_NAME_INFO_LEVEL, universal, &bytes) == NO_ERROR && universal->lpUniversalName && SameCanonicalPath(observed, universal->lpUniversalName);
}

bool PathWithin(const std::wstring& root, const std::wstring& cwd) {
  if (cwd.size() < root.size() || _wcsnicmp(cwd.c_str(), root.c_str(), root.size()) != 0) return false;
  return cwd.size() == root.size() || root.back() == L'\\' || cwd[root.size()] == L'\\';
}

bool RootId(const std::string& value) {
  return !value.empty() && value.size() <= 64 && ((value[0] >= 'a' && value[0] <= 'z') || (value[0] >= '0' && value[0] <= '9'))
    && std::all_of(value.begin(), value.end(), [](char c) { return (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-'; });
}

void AppendU64(std::vector<unsigned char>* material, std::uint64_t value) {
  for (unsigned shift = 0; shift < 64; shift += 8) material->push_back(static_cast<unsigned char>(value >> shift));
}

bool RootIdentityDigest(const std::vector<RootIdentityPair>& identities, bool observed, std::string* output) {
  static constexpr char domain[] = "mini-lux/sec03/launcher-root-handle-identities/v1";
  std::vector<unsigned char> material(domain, domain + sizeof(domain) - 1); material.push_back(0);
  mini_lux::sec03::AppendU32(&material, static_cast<std::uint32_t>(identities.size()));
  for (size_t index = 0; index < identities.size(); ++index) {
    const auto& value = identities[index]; mini_lux::sec03::AppendU32(&material, static_cast<std::uint32_t>(index));
    material.push_back('r'); mini_lux::sec03::AppendU32(&material, observed ? value.observed_root.dwVolumeSerialNumber : value.expected_root_volume); AppendU64(&material, observed ? FileId(value.observed_root) : value.expected_root_file);
    material.push_back('c'); mini_lux::sec03::AppendU32(&material, observed ? value.observed_cwd.dwVolumeSerialNumber : value.expected_cwd_volume); AppendU64(&material, observed ? FileId(value.observed_cwd) : value.expected_cwd_file);
  }
  return mini_lux::sec03::Sha256(material.data(), material.size(), output);
}

bool FixedNtfsDirectory(HANDLE handle, const BY_HANDLE_FILE_INFORMATION& identity) {
  if (handle == INVALID_HANDLE_VALUE || !(identity.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) || (identity.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT)) return false;
  std::array<wchar_t, 32768> final{}; std::array<wchar_t, MAX_PATH> volume{}; std::array<wchar_t, 32> filesystem{}; DWORD serial = 0;
  const DWORD count = GetFinalPathNameByHandleW(handle, final.data(), static_cast<DWORD>(final.size()), FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
  return count && count < final.size() && GetVolumePathNameW(final.data(), volume.data(), static_cast<DWORD>(volume.size())) && GetDriveTypeW(volume.data()) == DRIVE_FIXED
    && GetVolumeInformationW(volume.data(), nullptr, 0, &serial, nullptr, nullptr, filesystem.data(), static_cast<DWORD>(filesystem.size())) && serial == identity.dwVolumeSerialNumber && _wcsicmp(filesystem.data(), L"NTFS") == 0;
}

RootOpenResult OpenTrustedRoots(const Json& launch, std::vector<TrustedRootHandle>* opened, std::string* handles_json, RootFailureClass* failure_class, RootObservationDigests* identity_digests) {
  const Json* roots = Field(launch, "roots", Json::Kind::array);
  if (!roots || roots->array.empty() || roots->array.size() > 8 || !opened || !handles_json || !failure_class || !identity_digests) return RootOpenResult::invalid;
  *failure_class = RootFailureClass::none; identity_digests->expected.clear(); identity_digests->observed.clear();
  std::vector<TrustedRootHandle> probes; std::vector<RootFailureClass> dispositions; std::vector<RootIdentityPair> identity_records; bool ordinary_unsupported = false; bool identity_mismatch = false;
  for (const Json& root : roots->array) {
    if (!ExactKeys(root, {"access", "canonicalCwd", "canonicalPath", "cwdIdentity", "identity", "rootId"})) return RootOpenResult::invalid;
    const Json* path = Field(root, "canonicalPath", Json::Kind::string); const Json* cwd = Field(root, "canonicalCwd", Json::Kind::string); const Json* cwd_identity = Field(root, "cwdIdentity", Json::Kind::object); const Json* access = Field(root, "access", Json::Kind::string); const Json* identity = Field(root, "identity", Json::Kind::object); const Json* root_id = Field(root, "rootId", Json::Kind::string);
    if (!path || !cwd || !cwd_identity || !access || !identity || !root_id || !RootId(root_id->scalar) || (access->scalar != "read" && access->scalar != "read-write") || !ExactKeys(*identity, {"fileId", "type", "volumeSerial"}) || !ExactKeys(*cwd_identity, {"fileId", "type", "volumeSerial"})) return RootOpenResult::invalid;
    const Json* volume = Field(*identity, "volumeSerial", Json::Kind::string); const Json* file = Field(*identity, "fileId", Json::Kind::string); const Json* type = Field(*identity, "type", Json::Kind::string); const Json* cwd_volume = Field(*cwd_identity, "volumeSerial", Json::Kind::string); const Json* cwd_file = Field(*cwd_identity, "fileId", Json::Kind::string); const Json* cwd_type = Field(*cwd_identity, "type", Json::Kind::string);
    uint64_t expected_volume = 0, expected_file = 0, expected_cwd_volume = 0, expected_cwd_file = 0; const std::wstring canonical = Wide(path->scalar); const std::wstring canonical_cwd = Wide(cwd->scalar); RootPathKind path_kind{}, cwd_kind{};
    if (!volume || !file || !type || !cwd_volume || !cwd_file || !cwd_type || type->scalar != "directory" || cwd_type->scalar != "directory" || canonical.empty() || canonical_cwd.empty() || !CanonicalRootPath(canonical, &path_kind) || !CanonicalRootPath(canonical_cwd, &cwd_kind) || path_kind != cwd_kind || !PathWithin(canonical, canonical_cwd)
      || !ParseUnsigned(volume->scalar, &expected_volume) || expected_volume > MAXDWORD || !ParseUnsigned(file->scalar, &expected_file) || !ParseUnsigned(cwd_volume->scalar, &expected_cwd_volume) || expected_cwd_volume > MAXDWORD || !ParseUnsigned(cwd_file->scalar, &expected_cwd_file)) return RootOpenResult::invalid;
    TrustedRootHandle probe; probe.handle = CreateFileW(canonical.c_str(), FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
    probe.cwd_handle = CreateFileW(canonical_cwd.c_str(), FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
    if (probe.handle == INVALID_HANDLE_VALUE || probe.cwd_handle == INVALID_HANDLE_VALUE || !GetFileInformationByHandle(probe.handle, &probe.identity) || !GetFileInformationByHandle(probe.cwd_handle, &probe.cwd_identity)
      || !(probe.identity.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) || !(probe.cwd_identity.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY)
      || !HandleOpenedAs(probe.handle, canonical) || !HandleOpenedAs(probe.cwd_handle, canonical_cwd)) return RootOpenResult::invalid;
    RootIdentityPair identity_record; identity_record.expected_root_volume = static_cast<std::uint32_t>(expected_volume); identity_record.expected_root_file = expected_file; identity_record.expected_cwd_volume = static_cast<std::uint32_t>(expected_cwd_volume); identity_record.expected_cwd_file = expected_cwd_file; identity_record.observed_root = probe.identity; identity_record.observed_cwd = probe.cwd_identity; identity_records.push_back(identity_record);
    if (expected_volume != probe.identity.dwVolumeSerialNumber || expected_file != FileId(probe.identity) || expected_cwd_volume != probe.cwd_identity.dwVolumeSerialNumber || expected_cwd_file != FileId(probe.cwd_identity)) identity_mismatch = true;
    RootFailureClass disposition = RootFailureClass::none;
    if (probe.identity.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) {
      disposition = RootFailureClass::reparse_root;
    } else if (probe.cwd_identity.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) {
      ordinary_unsupported = true;
    } else if (path_kind == RootPathKind::unc) {
      std::array<wchar_t, 32768> final{}; std::array<wchar_t, MAX_PATH> volume_path{}; const DWORD count = GetFinalPathNameByHandleW(probe.handle, final.data(), static_cast<DWORD>(final.size()), FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
      if (count && count < final.size() && GetVolumePathNameW(final.data(), volume_path.data(), static_cast<DWORD>(volume_path.size())) && GetDriveTypeW(volume_path.data()) == DRIVE_REMOTE) disposition = RootFailureClass::unc; else ordinary_unsupported = true;
    } else {
      const std::wstring drive_root = canonical.substr(0, 3); const UINT input_drive_type = GetDriveTypeW(drive_root.c_str());
      if (input_drive_type == DRIVE_REMOTE) {
        disposition = RootFailureClass::mapped_remote;
      } else {
        std::array<wchar_t, 32768> final{}; std::array<wchar_t, MAX_PATH> volume_path{}; std::array<wchar_t, 32> filesystem{}; DWORD serial = 0; const DWORD count = GetFinalPathNameByHandleW(probe.handle, final.data(), static_cast<DWORD>(final.size()), FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
        if (!count || count >= final.size() || !GetVolumePathNameW(final.data(), volume_path.data(), static_cast<DWORD>(volume_path.size())) || !GetVolumeInformationW(volume_path.data(), nullptr, 0, &serial, nullptr, nullptr, filesystem.data(), static_cast<DWORD>(filesystem.size())) || serial != probe.identity.dwVolumeSerialNumber) ordinary_unsupported = true;
        else { const UINT actual_drive_type = GetDriveTypeW(volume_path.data()); if (actual_drive_type == DRIVE_FIXED && _wcsicmp(filesystem.data(), L"NTFS") != 0) disposition = RootFailureClass::non_ntfs; else if (actual_drive_type == DRIVE_REMOVABLE && _wcsicmp(filesystem.data(), L"NTFS") == 0) disposition = RootFailureClass::removable_ntfs; else if (actual_drive_type != DRIVE_FIXED || _wcsicmp(filesystem.data(), L"NTFS") != 0) ordinary_unsupported = true; }
      }
    }
    if (disposition == RootFailureClass::none && (!FixedNtfsDirectory(probe.handle, probe.identity) || !FixedNtfsDirectory(probe.cwd_handle, probe.cwd_identity))) ordinary_unsupported = true;
    dispositions.push_back(disposition); probes.push_back(std::move(probe));
  }
  RootFailureClass observed = RootFailureClass::none;
  for (RootFailureClass disposition : dispositions) if (disposition != RootFailureClass::none) { if (observed != RootFailureClass::none && observed != disposition) ordinary_unsupported = true; else observed = disposition; }
  if (!RootIdentityDigest(identity_records, false, &identity_digests->expected) || !RootIdentityDigest(identity_records, true, &identity_digests->observed)) ordinary_unsupported = true;
  probes.clear();
  if (ordinary_unsupported || (identity_mismatch && observed != RootFailureClass::none)) return RootOpenResult::invalid;
  if (observed != RootFailureClass::none) { *failure_class = observed; return RootOpenResult::unsupported; }
  if (identity_mismatch) return RootOpenResult::identity_changed;
  std::ostringstream wire; wire << "[";
  for (size_t index = 0; index < roots->array.size(); ++index) {
    const Json& root = roots->array[index]; const Json* path = Field(root, "canonicalPath", Json::Kind::string); const Json* cwd = Field(root, "canonicalCwd", Json::Kind::string); const Json* cwd_identity = Field(root, "cwdIdentity", Json::Kind::object); const Json* identity = Field(root, "identity", Json::Kind::object);
    const Json* volume = Field(*identity, "volumeSerial", Json::Kind::string); const Json* file = Field(*identity, "fileId", Json::Kind::string); const Json* cwd_volume = Field(*cwd_identity, "volumeSerial", Json::Kind::string); const Json* cwd_file = Field(*cwd_identity, "fileId", Json::Kind::string); uint64_t expected_volume = 0, expected_file = 0, expected_cwd_volume = 0, expected_cwd_file = 0;
    ParseUnsigned(volume->scalar, &expected_volume); ParseUnsigned(file->scalar, &expected_file); ParseUnsigned(cwd_volume->scalar, &expected_cwd_volume); ParseUnsigned(cwd_file->scalar, &expected_cwd_file); const std::wstring canonical = Wide(path->scalar); const std::wstring canonical_cwd = Wide(cwd->scalar);
    TrustedRootHandle value; value.handle = CreateFileW(canonical.c_str(), MAXIMUM_ALLOWED, FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
    if (value.handle == INVALID_HANDLE_VALUE || !GetFileInformationByHandle(value.handle, &value.identity) || !(value.identity.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) || (value.identity.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT)) return RootOpenResult::invalid;
    std::array<wchar_t, 32768> final_path{}; const DWORD final_count = GetFinalPathNameByHandleW(value.handle, final_path.data(), static_cast<DWORD>(final_path.size()), FILE_NAME_NORMALIZED | VOLUME_NAME_DOS); std::array<wchar_t, MAX_PATH> volume_path{}; std::array<wchar_t, 32> filesystem{}; DWORD serial = 0;
    if (!final_count || final_count >= final_path.size() || !GetVolumePathNameW(final_path.data(), volume_path.data(), static_cast<DWORD>(volume_path.size())) || GetDriveTypeW(volume_path.data()) != DRIVE_FIXED || !GetVolumeInformationW(volume_path.data(), nullptr, 0, &serial, nullptr, nullptr, filesystem.data(), static_cast<DWORD>(filesystem.size())) || _wcsicmp(filesystem.data(), L"NTFS") != 0) return RootOpenResult::invalid;
    if (serial != value.identity.dwVolumeSerialNumber || expected_volume != value.identity.dwVolumeSerialNumber || expected_file != FileId(value.identity) || !SetHandleInformation(value.handle, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT)) return RootOpenResult::invalid;
    if (expected_cwd_volume == expected_volume && expected_cwd_file == expected_file) {
      if (!DuplicateHandle(GetCurrentProcess(), value.handle, GetCurrentProcess(), &value.cwd_handle, 0, TRUE, DUPLICATE_SAME_ACCESS)) return RootOpenResult::invalid;
    } else {
      value.cwd_handle = CreateFileW(canonical_cwd.c_str(), MAXIMUM_ALLOWED, FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
    }
    if (value.cwd_handle == INVALID_HANDLE_VALUE || !GetFileInformationByHandle(value.cwd_handle, &value.cwd_identity) || !(value.cwd_identity.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) || (value.cwd_identity.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) || expected_cwd_volume != value.cwd_identity.dwVolumeSerialNumber || expected_cwd_file != FileId(value.cwd_identity)) return RootOpenResult::invalid;
    std::array<wchar_t, 32768> final_cwd{}; const DWORD cwd_count = GetFinalPathNameByHandleW(value.cwd_handle, final_cwd.data(), static_cast<DWORD>(final_cwd.size()), FILE_NAME_NORMALIZED | VOLUME_NAME_DOS); if (!cwd_count || cwd_count >= final_cwd.size()) return RootOpenResult::invalid; std::wstring root_name(final_path.data(), final_count), cwd_name(final_cwd.data(), cwd_count); if (cwd_name.size() < root_name.size() || _wcsnicmp(cwd_name.c_str(), root_name.c_str(), root_name.size()) != 0 || (cwd_name.size() > root_name.size() && cwd_name[root_name.size()] != L'\\')) return RootOpenResult::invalid;
    if (!SetHandleInformation(value.cwd_handle, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT)) return RootOpenResult::invalid;
    if (index) wire << ','; wire << "{\"cwdHandleValue\":\"" << reinterpret_cast<uintptr_t>(value.cwd_handle) << "\",\"handleValue\":\"" << reinterpret_cast<uintptr_t>(value.handle) << "\",\"rootIndex\":" << index << "}"; opened->push_back(std::move(value));
  }
  wire << "]"; *handles_json = wire.str(); return RootOpenResult::trusted;
}

void AppendDigestValue(std::vector<unsigned char>* material, const std::string& value) {
  mini_lux::sec03::AppendU32(material, static_cast<std::uint32_t>(value.size())); material->insert(material->end(), value.begin(), value.end());
}

bool AppendCanonicalJsonDigest(const Json& value, std::vector<unsigned char>* material, unsigned depth = 0) {
  if (depth > 20) return false;
  switch (value.kind) {
    case Json::Kind::null_value: material->push_back('n'); return true;
    case Json::Kind::boolean: material->push_back(value.boolean ? 't' : 'f'); return true;
    case Json::Kind::number: material->push_back('d'); AppendDigestValue(material, value.scalar); return true;
    case Json::Kind::string: material->push_back('s'); AppendDigestValue(material, value.scalar); return true;
    case Json::Kind::array:
      material->push_back('a'); mini_lux::sec03::AppendU32(material, static_cast<std::uint32_t>(value.array.size()));
      for (const auto& item : value.array) if (!AppendCanonicalJsonDigest(item, material, depth + 1)) return false; return true;
    case Json::Kind::object:
      material->push_back('o'); mini_lux::sec03::AppendU32(material, static_cast<std::uint32_t>(value.object.size()));
      for (const auto& [key, item] : value.object) { AppendDigestValue(material, key); if (!AppendCanonicalJsonDigest(item, material, depth + 1)) return false; } return true;
  }
  return false;
}

bool CanonicalJsonDigest(const char* domain, const Json& value, std::string* output) {
  std::vector<unsigned char> material(domain, domain + strlen(domain)); material.push_back(0);
  return AppendCanonicalJsonDigest(value, &material) && mini_lux::sec03::Sha256(material.data(), material.size(), output);
}

bool AppendCanonicalJsonText(const Json& value, std::string* output, unsigned depth = 0, const char* omitted_root_key = nullptr) {
  if (!output || depth > 20) return false;
  switch (value.kind) {
    case Json::Kind::null_value: output->append("null"); return true;
    case Json::Kind::boolean: output->append(value.boolean ? "true" : "false"); return true;
    case Json::Kind::number: output->append(value.scalar); return true;
    case Json::Kind::string: {
      output->push_back('"');
      for (const unsigned char c : value.scalar) { if (c == '"' || c == '\\') { output->push_back('\\'); output->push_back(static_cast<char>(c)); } else if (c < 0x20) return false; else output->push_back(static_cast<char>(c)); }
      output->push_back('"'); return true;
    }
    case Json::Kind::array:
      output->push_back('['); for (size_t i = 0; i < value.array.size(); ++i) { if (i) output->push_back(','); if (!AppendCanonicalJsonText(value.array[i], output, depth + 1)) return false; } output->push_back(']'); return true;
    case Json::Kind::object: {
      output->push_back('{'); bool first = true;
      for (const auto& [key, item] : value.object) { if (!depth && omitted_root_key && key == omitted_root_key) continue; if (!first) output->push_back(','); first = false; Json key_value; key_value.kind = Json::Kind::string; key_value.scalar = key; if (!AppendCanonicalJsonText(key_value, output, depth + 1)) return false; output->push_back(':'); if (!AppendCanonicalJsonText(item, output, depth + 1)) return false; }
      output->push_back('}'); return true;
    }
  }
  return false;
}

bool CanonicalJsonSha256(const Json& value, const char* omitted_root_key, std::string* output) {
  std::string canonical; return AppendCanonicalJsonText(value, &canonical, 0, omitted_root_key) && mini_lux::sec03::Sha256(reinterpret_cast<const unsigned char*>(canonical.data()), canonical.size(), output);
}

bool SequenceDigest(const char* domain, std::initializer_list<std::string> values, std::string* output) {
  std::vector<unsigned char> material(domain, domain + strlen(domain)); material.push_back(0); for (const auto& value : values) AppendDigestValue(&material, value);
  return mini_lux::sec03::Sha256(material.data(), material.size(), output);
}

bool EnvironmentDigests(const Json& environment, std::string* names_digest, std::string* values_digest) {
  if (environment.kind != Json::Kind::object) return false;
  std::vector<unsigned char> names{'m','i','n','i','-','l','u','x','/','s','e','c','0','3','/','l','a','u','n','c','h','e','r','-','e','n','v','-','n','a','m','e','s','/','v','1',0};
  std::vector<unsigned char> values{'m','i','n','i','-','l','u','x','/','s','e','c','0','3','/','l','a','u','n','c','h','e','r','-','e','n','v','-','v','a','l','u','e','s','/','v','1',0};
  for (const auto& [name, value] : environment.object) { if (value.kind != Json::Kind::string) return false; AppendDigestValue(&names, name); AppendDigestValue(&values, name); AppendDigestValue(&values, value.scalar); }
  return mini_lux::sec03::Sha256(names.data(), names.size(), names_digest) && mini_lux::sec03::Sha256(values.data(), values.size(), values_digest);
}

struct LauncherObservation {
  std::vector<unsigned char> proof;
  std::string mac;
  std::string key_id;
  std::string channel_marker;
};

const char* ObservationClassName(LauncherObservationOutcome outcome) {
  switch (outcome) {
    case LauncherObservationOutcome::unsupported_root: return "unsupported-root";
    case LauncherObservationOutcome::root_identity_changed: return "root-identity-changed";
  }
  return "";
}

const char* ObservationRaceStage(LauncherObservationOutcome outcome) {
  switch (outcome) {
    case LauncherObservationOutcome::unsupported_root: return "root-qualification";
    case LauncherObservationOutcome::root_identity_changed: return "before-retained-handle";
  }
  return "";
}

const char* ObservationCode(LauncherObservationOutcome outcome) {
  switch (outcome) {
    case LauncherObservationOutcome::unsupported_root: return "EXEC_ROOT_UNSUPPORTED";
    case LauncherObservationOutcome::root_identity_changed: return "EXEC_ROOT_IDENTITY_CHANGED";
  }
  return "";
}

bool CreateRootObservation(const Json& launch, LauncherObservationOutcome outcome, RootFailureClass failure_class, const RootObservationDigests& identity_digests, const std::string& candidate, const std::string& build, const std::string& source, const std::string& host, const std::string& launcher, LauncherObservation* output) {
  const Json* execution = Field(launch, "executionId", Json::Kind::string); const Json* context = Field(launch, "contextId", Json::Kind::string); const Json* session = Field(launch, "sessionId", Json::Kind::string); const Json* run = Field(launch, "runId", Json::Kind::string); const Json* authority = Field(launch, "authorityEpoch", Json::Kind::number);
  const Json* entry = Field(launch, "entryPoint", Json::Kind::string); const Json* profile = Field(launch, "profile", Json::Kind::string); const Json* persona = Field(launch, "personaDigest", Json::Kind::string); const Json* policy = Field(launch, "policyDigest", Json::Kind::string); const Json* payload = Field(launch, "payload", Json::Kind::string); const Json* payload_digest = Field(launch, "payloadDigest", Json::Kind::string);
  const Json* roots = Field(launch, "roots", Json::Kind::array); const Json* environment = Field(launch, "environment", Json::Kind::object); const Json* limits = Field(launch, "limits", Json::Kind::object); const Json* network = Field(launch, "network", Json::Kind::object); const Json* network_mode = network && ExactKeys(*network, {"mode"}) ? Field(*network, "mode", Json::Kind::string) : nullptr;
  const std::string observation_class = ObservationClassName(outcome); const std::string race_stage = ObservationRaceStage(outcome); const std::string observed_code = ObservationCode(outcome);
  const std::string root_failure_class = outcome == LauncherObservationOutcome::root_identity_changed ? "none" : RootFailureClassName(failure_class); std::uint64_t authority_epoch = 0;
  const bool profile_pair = entry && profile && ((entry->scalar == "E1" && profile->scalar == "one-shot-shell") || (entry->scalar == "E2" && profile->scalar == "agent-shell") || (entry->scalar == "E3" && profile->scalar == "script") || (entry->scalar == "E4" && profile->scalar == "manual-terminal"));
  const bool outcome_valid = (outcome == LauncherObservationOutcome::unsupported_root && failure_class != RootFailureClass::none && identity_digests.expected == identity_digests.observed)
    || (outcome == LauncherObservationOutcome::root_identity_changed && failure_class == RootFailureClass::none && identity_digests.expected != identity_digests.observed);
  if (!outcome_valid || observation_class.empty() || race_stage.empty() || observed_code.empty() || !output || !execution || !context || !session || !run || !authority || !profile_pair || !persona || !policy || !payload || !payload_digest || !roots || roots->array.empty() || roots->array.size() > 8 || !environment || !limits || !network_mode || network_mode->scalar != "deny"
    || !mini_lux::sec03::LauncherObservationId(execution->scalar) || !mini_lux::sec03::LauncherObservationId(context->scalar) || !mini_lux::sec03::LauncherObservationId(session->scalar) || !mini_lux::sec03::LauncherObservationId(run->scalar) || !mini_lux::sec03::Decimal(authority->scalar, &authority_epoch) || !authority_epoch
    || !mini_lux::sec03::CanonicalHex(persona->scalar, 32, 32) || !mini_lux::sec03::CanonicalHex(policy->scalar, 32, 32) || !mini_lux::sec03::CanonicalHex(payload_digest->scalar, 32, 32)
    || !mini_lux::sec03::CanonicalHex(identity_digests.expected, 32, 32) || !mini_lux::sec03::CanonicalHex(identity_digests.observed, 32, 32)) return false;
  std::vector<unsigned char> payload_bytes; std::string observed_payload_digest;
  if (!DecodeCanonicalBase64(payload->scalar, &payload_bytes) || payload_bytes.empty() || payload_bytes.size() > kMaxFrame || std::find(payload_bytes.begin(), payload_bytes.end(), 0) != payload_bytes.end()
    || !mini_lux::sec03::Sha256(payload_bytes.data(), payload_bytes.size(), &observed_payload_digest) || observed_payload_digest != payload_digest->scalar) return false;
  std::string request_digest, root_request_digest, root_access_digest, stimulus_digest, job_policy_digest, environment_names_digest, environment_values_digest;
  std::string transcript_digest, package_sid_digest, input_set_digest, acl_profile_digest;
  if (!CanonicalJsonDigest("mini-lux/sec03/launcher-request/v1", launch, &request_digest)
    || !CanonicalJsonDigest("mini-lux/sec03/launcher-root-request/v1", *roots, &root_request_digest)
    || !CanonicalJsonDigest("mini-lux/sec03/launcher-root-access/v1", *roots, &root_access_digest)
    || !CanonicalJsonDigest("mini-lux/sec03/launcher-job-policy/v1", *limits, &job_policy_digest)
    || !EnvironmentDigests(*environment, &environment_names_digest, &environment_values_digest)
    || !SequenceDigest("mini-lux/sec03/launcher-stimulus/v1", {"launch", "none", observed_code, request_digest, payload_digest->scalar, candidate, build, source, host, launcher, execution->scalar, context->scalar, session->scalar, run->scalar, authority->scalar, entry->scalar, profile->scalar, persona->scalar, policy->scalar, root_request_digest, observation_class, race_stage, root_failure_class, identity_digests.expected, identity_digests.observed}, &stimulus_digest)
    || !SequenceDigest("mini-lux/sec03/launcher-transcript-sentinel/v1", {request_digest, root_request_digest, observation_class, race_stage, identity_digests.expected, identity_digests.observed, observed_code}, &transcript_digest)
    || !SequenceDigest("mini-lux/sec03/launcher-sentinel/v1", {"package-sid-not-created"}, &package_sid_digest)
    || !SequenceDigest("mini-lux/sec03/launcher-sentinel/v1", {"input-set-empty"}, &input_set_digest)
    || !SequenceDigest("mini-lux/sec03/launcher-sentinel/v1", {"acl-profile-not-created"}, &acl_profile_digest)) return false;
  std::string binding; mini_lux::sec03::AttestationKey key;
  if (!mini_lux::sec03::AttestationBindingDigest(candidate, build, source, host, launcher, &binding) || !mini_lux::sec03::ProvisionAttestationKey(binding, launcher, &key)) return false;
  std::ostringstream proof; proof << "v=1\nkind=launcher-observation\nkeyId=" << key.key_id << "\ncandidate=" << candidate << "\nbuildIdSha256=" << build << "\nsourceSha256=" << source << "\nhostSha256=" << host << "\nlauncher=" << launcher
    << "\nexecution=" << execution->scalar << "\ncontext=" << context->scalar << "\nsession=" << session->scalar << "\nrun=" << run->scalar << "\nauthorityEpoch=" << authority->scalar << "\nentryPoint=" << entry->scalar << "\nprofile=" << profile->scalar << "\noperation=launch\ndecisionState=none"
    << "\npersonaDigest=" << persona->scalar << "\npolicyDigest=" << policy->scalar << "\npayloadDigest=" << payload_digest->scalar << "\nstimulusDigest=" << stimulus_digest << "\nrequestDigest=" << request_digest << "\nrootRequestDigest=" << root_request_digest
    << "\nobservationClass=" << observation_class << "\nraceStage=" << race_stage << "\nrootFailureClass=" << root_failure_class << "\nexpectedRootIdentityDigest=" << identity_digests.expected << "\nobservedRootIdentityDigest=" << identity_digests.observed
    << "\nobservedCode=" << observed_code << "\nobservedSubcode=none\nhostExitCode=none\nrecoveryJournalState=none\nrecoveryJournalGeneration=0\ntranscriptSha256=" << transcript_digest << "\ntokenIsAppContainer=0\npackageSidSha256=" << package_sid_digest << "\ncapabilityCount=0\nlowIntegrity=0\njobConstrained=0\njobPolicySha256=" << job_policy_digest
    << "\nactiveProcessZero=1\nprocessStarts=0\nprofileCreates=0\njournalWrites=0\naclMutations=0\nstdinWrites=0\ninputDigestSetSha256=" << input_set_digest << "\nconpty=0\nconptyMerged=0\nexecutableLease=0\nchildExit=none\ncompletionReason=pre-host-denial\naggregateOutputBytes=0\ncleanupComplete=1\njobClosed=1\nhandlesDrained=1\nhostExited=1\ntreeTerminated=1\nrootIdentityDigest=" << identity_digests.expected
    << "\nrootAccessProfileSha256=" << root_access_digest << "\nrootFixedNtfs=" << (outcome == LauncherObservationOutcome::root_identity_changed ? "1" : "0") << "\nrootSameSystemVolume=0\nrootHasSpace=0\nrootHasNonAscii=0\nenvironmentNameDigest=" << environment_names_digest << "\nenvironmentValueDigest=" << environment_values_digest << "\nambientLeakCount=0\nnetworkMode=deny\nnetworkAttemptCount=0\nnetworkAcceptedCount=0\naclProfileSha256=" << acl_profile_digest << "\n";
  const std::string proof_text = proof.str(); std::map<std::string, std::string> fields; std::array<unsigned char, 32> mac{}, marker{}; std::string proof_sha256;
  if (!mini_lux::sec03::ParseCanonicalLauncherObservation(proof_text, candidate, build, source, host, launcher, key.key_id, &fields)
    || !mini_lux::sec03::HmacSha256(key, reinterpret_cast<const unsigned char*>(proof_text.data()), proof_text.size(), &mac)
    || !mini_lux::sec03::Sha256(reinterpret_cast<const unsigned char*>(proof_text.data()), proof_text.size(), &proof_sha256)) return false;
  const std::string mac_hex = mini_lux::sec03::HexBytes(mac.data(), mac.size()); const std::string marker_payload = mini_lux::sec03::LauncherObservationMarkerPayload(fields, proof_sha256, mac_hex);
  if (marker_payload.empty() || !mini_lux::sec03::HmacSha256(key, reinterpret_cast<const unsigned char*>(marker_payload.data()), marker_payload.size(), &marker)) return false;
  output->proof.assign(proof_text.begin(), proof_text.end()); output->mac = mac_hex; output->key_id = key.key_id; output->channel_marker = mini_lux::sec03::HexBytes(marker.data(), marker.size()); return true;
}

bool CreateServiceDenialObservation(const Json& request, const std::string& wire, const Lease& lease, bool* request_valid, LauncherObservation* output) {
  if (!request_valid || !output) return false; *request_valid = false;
  if (!ExactKeys(request, {"authorityEpoch", "buildIdSha256", "candidateId", "contextId", "decisionState", "entryPoint", "executionId", "operation", "payloadDigest", "personaDigest", "policyDigest", "profile", "requestDigest", "runId", "sessionId", "sourceSha256", "type", "v"})) return false;
  const Json* version = Field(request, "v", Json::Kind::number); const Json* type = Field(request, "type", Json::Kind::string);
  const Json* candidate = Field(request, "candidateId", Json::Kind::string); const Json* build = Field(request, "buildIdSha256", Json::Kind::string); const Json* source = Field(request, "sourceSha256", Json::Kind::string);
  const Json* execution = Field(request, "executionId", Json::Kind::string); const Json* context = Field(request, "contextId", Json::Kind::string); const Json* session = Field(request, "sessionId", Json::Kind::string); const Json* run = Field(request, "runId", Json::Kind::string); const Json* authority = Field(request, "authorityEpoch", Json::Kind::number);
  const Json* entry = Field(request, "entryPoint", Json::Kind::string); const Json* profile = Field(request, "profile", Json::Kind::string); const Json* persona = Field(request, "personaDigest", Json::Kind::string); const Json* policy = Field(request, "policyDigest", Json::Kind::string); const Json* payload = Field(request, "payloadDigest", Json::Kind::string); const Json* request_digest = Field(request, "requestDigest", Json::Kind::string); const Json* operation = Field(request, "operation", Json::Kind::string); const Json* state = Field(request, "decisionState", Json::Kind::string);
  std::uint64_t authority_epoch = 0;
  const bool identity_valid = candidate && build && source && mini_lux::sec03::CanonicalHex(candidate->scalar, 32, 32) && mini_lux::sec03::CanonicalHex(build->scalar, 32, 32) && mini_lux::sec03::CanonicalHex(source->scalar, 32, 32);
  const bool ids_valid = execution && context && session && run && mini_lux::sec03::LauncherObservationId(execution->scalar) && mini_lux::sec03::LauncherObservationId(context->scalar) && mini_lux::sec03::LauncherObservationId(session->scalar) && mini_lux::sec03::LauncherObservationId(run->scalar);
  const bool digests_valid = persona && policy && payload && request_digest && mini_lux::sec03::CanonicalHex(persona->scalar, 32, 32) && mini_lux::sec03::CanonicalHex(policy->scalar, 32, 32) && mini_lux::sec03::CanonicalHex(payload->scalar, 32, 32) && mini_lux::sec03::CanonicalHex(request_digest->scalar, 32, 32);
  const char* observed_code = state ? mini_lux::sec03::ServiceDenialCode(state->scalar) : "";
  const bool consent_state = state && state->scalar.rfind("consent-", 0) == 0;
  const bool network_profile_unsupported = state && state->scalar == "network-profile-unsupported";
  const bool recovery_state = state && state->scalar == "recovery-journal-invalid";
  const bool terminal_direct_state = state && (state->scalar == "terminal-direct-start" || state->scalar == "terminal-direct-input");
  const bool terminal_owner_state = state && (state->scalar == "terminal-owner-kill" || state->scalar == "terminal-owner-close");
  const bool native_identity_state = state && (state->scalar == "native-missing-launcher" || state->scalar == "native-missing-host" || state->scalar == "native-extra-artifact" || state->scalar == "native-changed-launcher" || state->scalar == "native-changed-host" || state->scalar == "native-wrong-pe-machine" || state->scalar == "native-forbidden-import-digest" || state->scalar == "native-host-replacement-blocked" || state->scalar == "native-source-toolchain-mismatch");
  const bool pair_valid = entry && profile && operation && observed_code[0]
    && ((!consent_state && !network_profile_unsupported && !recovery_state && !terminal_direct_state && !terminal_owner_state && !native_identity_state && ((entry->scalar == "E1" && profile->scalar == "one-shot-shell" && operation->scalar == "launch") || (entry->scalar == "E2" && profile->scalar == "agent-shell" && operation->scalar == "input") || (entry->scalar == "E3" && profile->scalar == "script" && operation->scalar == "launch")))
      || (consent_state && entry->scalar == "E4" && profile->scalar == "manual-terminal" && operation->scalar == "consent")
      || (network_profile_unsupported && entry->scalar == "E4" && profile->scalar == "manual-terminal" && operation->scalar == "launch")
      || (recovery_state && operation->scalar == "launch")
      || (terminal_direct_state && entry->scalar == "E4" && profile->scalar == "manual-terminal"
        && ((state->scalar == "terminal-direct-start" && operation->scalar == "launch") || (state->scalar == "terminal-direct-input" && operation->scalar == "input")))
      || (terminal_owner_state && entry->scalar == "E4" && profile->scalar == "manual-terminal"
        && ((state->scalar == "terminal-owner-kill" && operation->scalar == "kill") || (state->scalar == "terminal-owner-close" && operation->scalar == "close")))
      || (native_identity_state && operation->scalar == "launch"));
  if (!version || version->scalar != "1" || !type || type->scalar != "service-denial" || !identity_valid || !ids_valid || !digests_valid || !pair_valid || !authority || !mini_lux::sec03::Decimal(authority->scalar, &authority_epoch) || !authority_epoch || authority->scalar != std::to_string(authority_epoch)) return false;
  std::ostringstream canonical; canonical << "{\"v\":1,\"type\":\"service-denial\",\"candidateId\":\"" << candidate->scalar << "\",\"buildIdSha256\":\"" << build->scalar << "\",\"sourceSha256\":\"" << source->scalar
    << "\",\"executionId\":\"" << execution->scalar << "\",\"contextId\":\"" << context->scalar << "\",\"sessionId\":\"" << session->scalar << "\",\"runId\":\"" << run->scalar << "\",\"authorityEpoch\":" << authority->scalar
    << ",\"entryPoint\":\"" << entry->scalar << "\",\"profile\":\"" << profile->scalar << "\",\"personaDigest\":\"" << persona->scalar << "\",\"policyDigest\":\"" << policy->scalar << "\",\"payloadDigest\":\"" << payload->scalar
    << "\",\"requestDigest\":\"" << request_digest->scalar << "\",\"operation\":\"" << operation->scalar << "\",\"decisionState\":\"" << state->scalar << "\"}";
  if (canonical.str() != wire) return false;
  *request_valid = true;
  std::string root_sentinel, root_request_digest, root_access_digest, job_policy_digest, environment_names_digest, environment_values_digest, package_sid_digest, input_set_digest, acl_profile_digest, stimulus_digest, transcript_digest;
  if (!mini_lux::sec03::LauncherObservationSentinel("root-not-consumed", &root_sentinel)
    || !mini_lux::sec03::LauncherObservationSentinel("root-request-not-consumed", &root_request_digest)
    || !mini_lux::sec03::LauncherObservationSentinel("root-access-not-consumed", &root_access_digest)
    || !mini_lux::sec03::LauncherObservationSentinel("job-policy-not-created", &job_policy_digest)
    || !mini_lux::sec03::LauncherObservationSentinel("environment-names-not-created", &environment_names_digest)
    || !mini_lux::sec03::LauncherObservationSentinel("environment-values-not-created", &environment_values_digest)
    || !mini_lux::sec03::LauncherObservationSentinel("package-sid-not-created", &package_sid_digest)
    || !mini_lux::sec03::LauncherObservationSentinel("input-set-empty", &input_set_digest)
    || !mini_lux::sec03::LauncherObservationSentinel("acl-profile-not-created", &acl_profile_digest)
    || !SequenceDigest("mini-lux/sec03/service-denial-stimulus/v1", {operation->scalar, state->scalar, observed_code, request_digest->scalar, payload->scalar, candidate->scalar, build->scalar, source->scalar, lease.sha256, lease.launcher_sha256, execution->scalar, context->scalar, session->scalar, run->scalar, authority->scalar, entry->scalar, profile->scalar, persona->scalar, policy->scalar}, &stimulus_digest)) return false;
  const bool transcript_valid = consent_state || network_profile_unsupported || recovery_state || terminal_direct_state || terminal_owner_state || native_identity_state
    ? SequenceDigest("mini-lux/sec03/service-denial-transcript/v1", {request_digest->scalar, payload->scalar, operation->scalar, state->scalar, observed_code, candidate->scalar, execution->scalar, context->scalar, session->scalar, run->scalar, entry->scalar, profile->scalar, persona->scalar, policy->scalar}, &transcript_digest)
    : SequenceDigest("mini-lux/sec03/service-denial-transcript/v1", {request_digest->scalar, payload->scalar, operation->scalar, state->scalar, observed_code, execution->scalar, context->scalar, session->scalar, run->scalar, entry->scalar, profile->scalar}, &transcript_digest);
  if (!transcript_valid) return false;
  std::string binding; mini_lux::sec03::AttestationKey key;
  if (!mini_lux::sec03::AttestationBindingDigest(candidate->scalar, build->scalar, source->scalar, lease.sha256, lease.launcher_sha256, &binding) || !mini_lux::sec03::ProvisionAttestationKey(binding, lease.launcher_sha256, &key)) return false;
  std::ostringstream proof; proof << "v=1\nkind=launcher-observation\nkeyId=" << key.key_id << "\ncandidate=" << candidate->scalar << "\nbuildIdSha256=" << build->scalar << "\nsourceSha256=" << source->scalar << "\nhostSha256=" << lease.sha256 << "\nlauncher=" << lease.launcher_sha256
    << "\nexecution=" << execution->scalar << "\ncontext=" << context->scalar << "\nsession=" << session->scalar << "\nrun=" << run->scalar << "\nauthorityEpoch=" << authority->scalar << "\nentryPoint=" << entry->scalar << "\nprofile=" << profile->scalar << "\noperation=" << operation->scalar << "\ndecisionState=" << state->scalar
    << "\npersonaDigest=" << persona->scalar << "\npolicyDigest=" << policy->scalar << "\npayloadDigest=" << payload->scalar << "\nstimulusDigest=" << stimulus_digest << "\nrequestDigest=" << request_digest->scalar << "\nrootRequestDigest=" << root_request_digest
    << "\nobservationClass=" << (native_identity_state ? "native-identity-denial" : recovery_state ? "recovery-denial" : "service-denial") << "\nraceStage=" << (native_identity_state ? "native-projection-validation" : recovery_state ? "startup-recovery" : "trusted-service-decision") << "\nrootFailureClass=none\nexpectedRootIdentityDigest=" << root_sentinel << "\nobservedRootIdentityDigest=" << root_sentinel << "\nobservedCode=" << observed_code
    << "\nobservedSubcode=none\nhostExitCode=none\nrecoveryJournalState=none\nrecoveryJournalGeneration=0\ntranscriptSha256=" << transcript_digest << "\ntokenIsAppContainer=0\npackageSidSha256=" << package_sid_digest << "\ncapabilityCount=0\nlowIntegrity=0\njobConstrained=0\njobPolicySha256=" << job_policy_digest
    << "\nactiveProcessZero=1\nprocessStarts=0\nprofileCreates=0\njournalWrites=0\naclMutations=0\nstdinWrites=0\ninputDigestSetSha256=" << input_set_digest << "\nconpty=0\nconptyMerged=0\nexecutableLease=0\nchildExit=none\ncompletionReason=pre-host-denial\naggregateOutputBytes=0\ncleanupComplete=1\njobClosed=1\nhandlesDrained=1\nhostExited=1\ntreeTerminated=1\nrootIdentityDigest=" << root_sentinel
    << "\nrootAccessProfileSha256=" << root_access_digest << "\nrootFixedNtfs=0\nrootSameSystemVolume=0\nrootHasSpace=0\nrootHasNonAscii=0\nenvironmentNameDigest=" << environment_names_digest << "\nenvironmentValueDigest=" << environment_values_digest << "\nambientLeakCount=0\nnetworkMode=deny\nnetworkAttemptCount=0\nnetworkAcceptedCount=0\naclProfileSha256=" << acl_profile_digest << "\n";
  const std::string proof_text = proof.str(); std::map<std::string, std::string> fields; std::array<unsigned char, 32> mac{}, marker{}; std::string proof_sha256;
  if (!mini_lux::sec03::ParseCanonicalLauncherObservation(proof_text, candidate->scalar, build->scalar, source->scalar, lease.sha256, lease.launcher_sha256, key.key_id, &fields)
    || !mini_lux::sec03::HmacSha256(key, reinterpret_cast<const unsigned char*>(proof_text.data()), proof_text.size(), &mac)
    || !mini_lux::sec03::Sha256(reinterpret_cast<const unsigned char*>(proof_text.data()), proof_text.size(), &proof_sha256)) return false;
  const std::string mac_hex = mini_lux::sec03::HexBytes(mac.data(), mac.size()); const std::string marker_payload = mini_lux::sec03::LauncherObservationMarkerPayload(fields, proof_sha256, mac_hex);
  if (marker_payload.empty() || !mini_lux::sec03::HmacSha256(key, reinterpret_cast<const unsigned char*>(marker_payload.data()), marker_payload.size(), &marker)) return false;
  output->proof.assign(proof_text.begin(), proof_text.end()); output->mac = mac_hex; output->key_id = key.key_id; output->channel_marker = mini_lux::sec03::HexBytes(marker.data(), marker.size()); return true;
}

bool ReadSmallFile(const std::wstring& path, std::string* wire);

bool CreateFixedNativeIdentityObservation(const Json& request, const std::string& wire, const Lease& lease, LauncherObservation* output) {
  if (!output || !ExactKeys(request, {"authorityEpoch", "buildIdSha256", "candidateId", "contextId", "entryPoint", "executionId", "personaDigest", "policyDigest", "profile", "runId", "sessionId", "sourceSha256", "subjectPath", "type", "v", "variantId"})) return false;
  const Json* version = Field(request, "v", Json::Kind::number); const Json* type = Field(request, "type", Json::Kind::string); const Json* variant = Field(request, "variantId", Json::Kind::string);
  const Json* candidate = Field(request, "candidateId", Json::Kind::string); const Json* build = Field(request, "buildIdSha256", Json::Kind::string); const Json* source = Field(request, "sourceSha256", Json::Kind::string);
  const Json* execution = Field(request, "executionId", Json::Kind::string); const Json* context = Field(request, "contextId", Json::Kind::string); const Json* session = Field(request, "sessionId", Json::Kind::string); const Json* run = Field(request, "runId", Json::Kind::string); const Json* authority = Field(request, "authorityEpoch", Json::Kind::number);
  const Json* entry = Field(request, "entryPoint", Json::Kind::string); const Json* profile = Field(request, "profile", Json::Kind::string); const Json* persona = Field(request, "personaDigest", Json::Kind::string); const Json* policy = Field(request, "policyDigest", Json::Kind::string); const Json* subject = Field(request, "subjectPath", Json::Kind::string);
  const std::map<std::string, std::string> states = {{"A15-01", "native-missing-launcher"}, {"A15-02", "native-missing-host"}, {"A15-03", "native-extra-artifact"}, {"A15-04", "native-changed-launcher"}, {"A15-05", "native-changed-host"}, {"A15-06", "native-wrong-pe-machine"}, {"A15-07", "native-forbidden-import-digest"}, {"A15-08", "native-host-replacement-blocked"}, {"A15-09", "native-source-toolchain-mismatch"}}; const auto state = variant ? states.find(variant->scalar) : states.end();
  std::uint64_t authority_epoch = 0; const bool profile_pair = entry && profile && ((entry->scalar == "E1" && profile->scalar == "one-shot-shell") || (entry->scalar == "E2" && profile->scalar == "agent-shell") || (entry->scalar == "E3" && profile->scalar == "script") || (entry->scalar == "E4" && profile->scalar == "manual-terminal"));
  if (!version || version->scalar != "1" || !type || type->scalar != "native-identity-observation" || state == states.end() || !candidate || !build || !source || !execution || !context || !session || !run || !authority || !profile_pair || !persona || !policy || !subject
    || !mini_lux::sec03::CanonicalHex(candidate->scalar, 32, 32) || !mini_lux::sec03::CanonicalHex(build->scalar, 32, 32) || !mini_lux::sec03::CanonicalHex(source->scalar, 32, 32)
    || !mini_lux::sec03::LauncherObservationId(execution->scalar) || !mini_lux::sec03::LauncherObservationId(context->scalar) || !mini_lux::sec03::LauncherObservationId(session->scalar) || !mini_lux::sec03::LauncherObservationId(run->scalar)
    || !mini_lux::sec03::Decimal(authority->scalar, &authority_epoch) || !authority_epoch || authority->scalar != std::to_string(authority_epoch)
    || !mini_lux::sec03::CanonicalHex(persona->scalar, 32, 32) || !mini_lux::sec03::CanonicalHex(policy->scalar, 32, 32) || subject->scalar.empty() || subject->scalar.size() > 1024) return false;
  const std::string quoted_subject = JsonQuoted(subject->scalar); if (quoted_subject.empty()) return false;
  std::ostringstream canonical; canonical << "{\"v\":1,\"type\":\"native-identity-observation\",\"candidateId\":\"" << candidate->scalar << "\",\"buildIdSha256\":\"" << build->scalar << "\",\"sourceSha256\":\"" << source->scalar
    << "\",\"executionId\":\"" << execution->scalar << "\",\"contextId\":\"" << context->scalar << "\",\"sessionId\":\"" << session->scalar << "\",\"runId\":\"" << run->scalar << "\",\"authorityEpoch\":" << authority->scalar
    << ",\"entryPoint\":\"" << entry->scalar << "\",\"profile\":\"" << profile->scalar << "\",\"personaDigest\":\"" << persona->scalar << "\",\"policyDigest\":\"" << policy->scalar << "\",\"subjectPath\":" << quoted_subject << ",\"variantId\":\"" << variant->scalar << "\"}";
  if (canonical.str() != wire) return false;
  const auto create_denial = [&](const std::string& launcher_state, const std::string& host_state, const std::string& extra_state) {
    std::string payload_digest, request_digest;
    if (!SequenceDigest("mini-lux/sec03/native-identity-subject/v1", {variant->scalar, "sandbox-launcher.node", launcher_state, "sandbox-host.exe", host_state, "unexpected-native.bin", extra_state}, &payload_digest)
      || !SequenceDigest("mini-lux/sec03/native-identity-request/v1", {candidate->scalar, build->scalar, source->scalar, execution->scalar, context->scalar, session->scalar, run->scalar, authority->scalar, entry->scalar, profile->scalar, persona->scalar, policy->scalar, payload_digest}, &request_digest)) return false;
    std::ostringstream denial_wire; denial_wire << "{\"v\":1,\"type\":\"service-denial\",\"candidateId\":\"" << candidate->scalar << "\",\"buildIdSha256\":\"" << build->scalar << "\",\"sourceSha256\":\"" << source->scalar
      << "\",\"executionId\":\"" << execution->scalar << "\",\"contextId\":\"" << context->scalar << "\",\"sessionId\":\"" << session->scalar << "\",\"runId\":\"" << run->scalar << "\",\"authorityEpoch\":" << authority->scalar
      << ",\"entryPoint\":\"" << entry->scalar << "\",\"profile\":\"" << profile->scalar << "\",\"personaDigest\":\"" << persona->scalar << "\",\"policyDigest\":\"" << policy->scalar << "\",\"payloadDigest\":\"" << payload_digest
      << "\",\"requestDigest\":\"" << request_digest << "\",\"operation\":\"launch\",\"decisionState\":\"" << state->second << "\"}";
    Json denial; bool valid = false; const std::string denial_text = denial_wire.str(); return Parser(denial_text).Parse(&denial) && CreateServiceDenialObservation(denial, denial_text, lease, &valid, output) && valid;
  };
  if (variant->scalar == "A15-08") {
    if (subject->scalar != "fixed-host-directory") return false;
    HANDLE delete_probe = CreateFileW(lease.path.c_str(), DELETE | FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
    const DWORD denial = delete_probe == INVALID_HANDLE_VALUE ? GetLastError() : ERROR_SUCCESS; if (delete_probe != INVALID_HANDLE_VALUE) CloseHandle(delete_probe);
    BY_HANDLE_FILE_INFORMATION identity{}; std::string digest;
    if (denial != ERROR_SHARING_VIOLATION || !GetFileInformationByHandle(lease.file, &identity) || identity.dwVolumeSerialNumber != lease.identity.dwVolumeSerialNumber || FileId(identity) != FileId(lease.identity) || !Sha256Handle(lease.file, &digest) || digest != lease.sha256) return false;
    return create_denial(lease.launcher_sha256, "replacement-blocked-win32-32", "none");
  }
  if (variant->scalar == "A15-07" || variant->scalar == "A15-09") {
    const size_t slash = lease.path.find_last_of(L"\\/"); const std::wstring subject_path = Wide(subject->scalar); mini_lux::sec03::JournalDirectoryLease directory;
    if (slash == std::wstring::npos || subject_path.empty() || !mini_lux::sec03::QualifyFixedNtfsDirectory(subject_path, &directory) || !SameCanonicalPath(subject_path, DosPathFromHandlePath(directory.path.data(), static_cast<DWORD>(directory.path.size())))) return false;
    unsigned entries = 0; bool exact_set = true; WIN32_FIND_DATAW found{}; HANDLE search = FindFirstFileW((directory.path + L"\\*").c_str(), &found); if (search == INVALID_HANDLE_VALUE) return false;
    do { if (!wcscmp(found.cFileName, L".") || !wcscmp(found.cFileName, L"..")) continue; ++entries; if (_wcsicmp(found.cFileName, L"sec03-native-manifest.json")) exact_set = false; } while (FindNextFileW(search, &found));
    const DWORD enumeration_error = GetLastError(); FindClose(search); if (enumeration_error != ERROR_NO_MORE_FILES || !exact_set || entries != 1) return false;
    std::string production, observed; if (!ReadSmallFile(lease.path.substr(0, slash) + L"\\sec03-native-manifest.json", &production) || !ReadSmallFile(directory.path + L"\\sec03-native-manifest.json", &observed)) return false;
    if (production.rfind("{\n  \"schemaVersion\": 1,\n  \"architecture\": \"x64\",\n", 0) != 0 || production.size() > 1024 * 1024 || production.back() != '\n' || production.find('\r') != std::string::npos) return false;
    const auto occurs_once = [&](const std::string& needle) { const size_t position = production.find(needle); return position != std::string::npos && production.find(needle, position + 1) == std::string::npos; };
    const auto extract_digest = [&](const char* key, std::string* digest) {
      const std::string prefix = std::string("\"") + key + "\": \""; const size_t position = production.find(prefix);
      if (position == std::string::npos || production.find(prefix, position + 1) != std::string::npos || position + prefix.size() + 65 > production.size() || production[position + prefix.size() + 64] != '\"') return false;
      digest->assign(production, position + prefix.size(), 64); return mini_lux::sec03::CanonicalHex(*digest, 32, 32);
    };
    const auto output_matches = [&](const char* output_path, const std::string& digest) {
      const std::string path_field = std::string("\"path\": \"") + output_path + "\""; const size_t position = production.find(path_field);
      if (position == std::string::npos || production.find(path_field, position + 1) != std::string::npos) return false; const size_t end = std::min(production.size(), position + 256); const std::string block = production.substr(position, end - position);
      return block.find(std::string("\"sha256\": \"") + digest + "\"") != std::string::npos && block.find("\"machine\": \"AMD64\"") != std::string::npos;
    };
    std::string native_source, native_toolchain;
    if (!occurs_once("\"signatureStatus\": \"unsigned-local\"") || !extract_digest("sourceDigest", &native_source) || !extract_digest("toolchainDigest", &native_toolchain)
      || !output_matches("dist/native/sandbox-host.exe", lease.sha256) || !output_matches("dist/native/sandbox-launcher.node", lease.launcher_sha256)) return false;
    std::string expected = production;
    const auto replace_digest = [&](const char* key, const std::string& actual, char replacement) {
      const std::string needle = std::string("\"") + key + "\": \"" + actual + "\""; const size_t position = expected.find(needle);
      if (position == std::string::npos || expected.find(needle, position + 1) != std::string::npos) return false; expected.replace(position, needle.size(), std::string("\"") + key + "\": \"" + std::string(64, replacement) + "\""); return true;
    };
    bool mutated = false;
    if (variant->scalar == "A15-07") {
      const std::string host_path = "\"path\": \"dist/native/sandbox-host.exe\""; const std::string import_prefix = "\"importedDllAllowlistDigest\": \"";
      const size_t host_position = expected.find(host_path); const size_t import_position = host_position == std::string::npos ? std::string::npos : expected.find(import_prefix, host_position);
      if (import_position != std::string::npos && import_position < host_position + 384 && import_position + import_prefix.size() + 65 <= expected.size() && expected[import_position + import_prefix.size() + 64] == '\"') {
        const std::string import_digest = expected.substr(import_position + import_prefix.size(), 64);
        if (mini_lux::sec03::CanonicalHex(import_digest, 32, 32) && import_digest != std::string(64, '0')) { expected.replace(import_position + import_prefix.size(), 64, std::string(64, '0')); mutated = true; }
      }
    } else mutated = replace_digest("sourceDigest", native_source, '0') && replace_digest("toolchainDigest", native_toolchain, '1');
    std::string observed_sha256;
    if (!mutated || observed != expected || !mini_lux::sec03::Sha256(reinterpret_cast<const unsigned char*>(observed.data()), observed.size(), &observed_sha256)) return false;
    return create_denial(lease.launcher_sha256, observed_sha256, "none");
  }

  const std::wstring subject_path = Wide(subject->scalar); mini_lux::sec03::JournalDirectoryLease directory;
  if (subject_path.empty() || !mini_lux::sec03::QualifyFixedNtfsDirectory(subject_path, &directory) || !SameCanonicalPath(subject_path, DosPathFromHandlePath(directory.path.data(), static_cast<DWORD>(directory.path.size())))) return false;
  struct SubjectArtifact { bool present = false; bool regular = false; bool pe = false; WORD machine = 0; std::string sha256; } launcher_artifact, host_artifact, extra_artifact;
  const auto inspect = [&](const wchar_t* name, bool pe_required, SubjectArtifact* artifact) {
    HANDLE file = CreateFileW((directory.path + L"\\" + name).c_str(), GENERIC_READ | FILE_READ_ATTRIBUTES, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
    if (file == INVALID_HANDLE_VALUE) return GetLastError() == ERROR_FILE_NOT_FOUND;
    artifact->present = true; BY_HANDLE_FILE_INFORMATION identity{}; artifact->regular = GetFileInformationByHandle(file, &identity) && !(identity.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)); artifact->pe = artifact->regular && PeMachine(file, &artifact->machine); const bool hashed = artifact->regular && Sha256Handle(file, &artifact->sha256); CloseHandle(file); return artifact->regular && hashed && (!pe_required || artifact->pe);
  };
  if (!inspect(L"sandbox-launcher.node", true, &launcher_artifact) || !inspect(L"sandbox-host.exe", true, &host_artifact) || !inspect(L"unexpected-native.bin", false, &extra_artifact)) return false;
  const bool extra_variant = variant->scalar == "A15-03"; unsigned subject_files = 0; bool exact_set = true; WIN32_FIND_DATAW found{}; HANDLE search = FindFirstFileW((directory.path + L"\\*").c_str(), &found); if (search == INVALID_HANDLE_VALUE) return false;
  do { if (!wcscmp(found.cFileName, L".") || !wcscmp(found.cFileName, L"..")) continue; ++subject_files; if (_wcsicmp(found.cFileName, L"sandbox-launcher.node") && _wcsicmp(found.cFileName, L"sandbox-host.exe") && (!extra_variant || _wcsicmp(found.cFileName, L"unexpected-native.bin"))) exact_set = false; } while (FindNextFileW(search, &found));
  const DWORD enumeration_error = GetLastError(); FindClose(search); if (enumeration_error != ERROR_NO_MORE_FILES || !exact_set || (extra_variant != extra_artifact.present)) return false;
  const bool launcher_exact = launcher_artifact.present && launcher_artifact.machine == IMAGE_FILE_MACHINE_AMD64 && launcher_artifact.sha256 == lease.launcher_sha256;
  const bool host_exact = host_artifact.present && host_artifact.machine == IMAGE_FILE_MACHINE_AMD64 && host_artifact.sha256 == lease.sha256;
  static constexpr char kExtraArtifact[] = "mini-lux/sec03/A15-03/unexpected-native-artifact/v1"; std::string expected_extra_sha256;
  if (!mini_lux::sec03::Sha256(reinterpret_cast<const unsigned char*>(kExtraArtifact), sizeof(kExtraArtifact) - 1, &expected_extra_sha256)) return false;
  bool condition = false; std::string launcher_state, host_state, extra_state = "none";
  if (variant->scalar == "A15-01") { condition = !launcher_artifact.present && host_exact && subject_files == 1; launcher_state = "absent"; host_state = lease.sha256; }
  else if (variant->scalar == "A15-02") { condition = launcher_exact && !host_artifact.present && subject_files == 1; launcher_state = lease.launcher_sha256; host_state = "absent"; }
  else if (variant->scalar == "A15-03") { condition = launcher_exact && host_exact && extra_artifact.regular && extra_artifact.sha256 == expected_extra_sha256 && subject_files == 3; launcher_state = lease.launcher_sha256; host_state = lease.sha256; extra_state = expected_extra_sha256; }
  else if (variant->scalar == "A15-04") { condition = launcher_artifact.present && launcher_artifact.machine == IMAGE_FILE_MACHINE_AMD64 && launcher_artifact.sha256 != lease.launcher_sha256 && host_exact && subject_files == 2; launcher_state = "changed-amd64"; host_state = lease.sha256; }
  else if (variant->scalar == "A15-05") { condition = launcher_exact && host_artifact.present && host_artifact.machine == IMAGE_FILE_MACHINE_AMD64 && host_artifact.sha256 != lease.sha256 && subject_files == 2; launcher_state = lease.launcher_sha256; host_state = "changed-amd64"; }
  else { condition = launcher_exact && host_artifact.present && host_artifact.machine == IMAGE_FILE_MACHINE_I386 && subject_files == 2; launcher_state = lease.launcher_sha256; host_state = "machine-014c"; }
  return condition && create_denial(launcher_state, host_state, extra_state);
}

bool FrozenObservationObject(napi_env env, const LauncherObservation& observation, napi_value* result) {
  napi_value proof, mac, key_id, marker; void* copied = nullptr;
  if (napi_create_buffer_copy(env, observation.proof.size(), observation.proof.data(), &copied, &proof) != napi_ok || napi_create_string_utf8(env, observation.mac.c_str(), NAPI_AUTO_LENGTH, &mac) != napi_ok
    || napi_create_string_utf8(env, observation.key_id.c_str(), NAPI_AUTO_LENGTH, &key_id) != napi_ok || napi_create_string_utf8(env, observation.channel_marker.c_str(), NAPI_AUTO_LENGTH, &marker) != napi_ok || napi_create_object(env, result) != napi_ok) return false;
  napi_property_descriptor properties[] = {{"proof", nullptr, nullptr, nullptr, nullptr, proof, napi_enumerable, nullptr}, {"mac", nullptr, nullptr, nullptr, nullptr, mac, napi_enumerable, nullptr}, {"keyId", nullptr, nullptr, nullptr, nullptr, key_id, napi_enumerable, nullptr}, {"channelMarker", nullptr, nullptr, nullptr, nullptr, marker, napi_enumerable, nullptr}};
  return napi_define_properties(env, *result, sizeof(properties) / sizeof(properties[0]), properties) == napi_ok && napi_object_freeze(env, *result) == napi_ok;
}

napi_value ObserveFixedNativeIdentity(napi_env env, napi_callback_info info) {
  size_t argc = 2; napi_value argv[2], self; Lease* lease = GetLease(env, info, &argc, argv, &self);
  if (!lease || !ConsumeLeaseAttempt(env, lease)) return nullptr;
  bool is_buffer = false; void* frame_data = nullptr; size_t frame_size = 0;
  if (argc != 1 || napi_is_buffer(env, argv[0], &is_buffer) != napi_ok || !is_buffer || napi_get_buffer_info(env, argv[0], &frame_data, &frame_size) != napi_ok || frame_size < 6 || frame_size > 16u * 1024u + 4u) { Throw(env, "EXEC_NATIVE_PROTOCOL", "observeFixedNativeIdentity requires one bounded canonical frame"); return nullptr; }
  const auto* frame = static_cast<const unsigned char*>(frame_data); const std::uint32_t declared = (static_cast<std::uint32_t>(frame[0]) << 24) | (static_cast<std::uint32_t>(frame[1]) << 16) | (static_cast<std::uint32_t>(frame[2]) << 8) | frame[3];
  if (declared != frame_size - 4) { Throw(env, "EXEC_NATIVE_PROTOCOL", "Native identity observation frame length is invalid"); return nullptr; }
  const std::string wire(reinterpret_cast<const char*>(frame + 4), frame_size - 4); Json request; LauncherObservation observation;
  if (!Parser(wire).Parse(&request) || request.kind != Json::Kind::object || !CreateFixedNativeIdentityObservation(request, wire, *lease, &observation)) { Throw(env, "EXEC_NATIVE_IDENTITY_INVALID", "Missing-host subject does not match the fixed native identity case"); return nullptr; }
  napi_value result; if (!FrozenObservationObject(env, observation, &result)) { Throw(env, "EXEC_NATIVE_EVIDENCE_UNAVAILABLE", "Native identity observation result is unavailable"); return nullptr; }
  return result;
}

bool ThrowRootObservation(napi_env env, LauncherObservationOutcome outcome, const LauncherObservation& observation) {
  const char* observed_code = ObservationCode(outcome); const char* observed_message = outcome == LauncherObservationOutcome::root_identity_changed ? "Root identity changed before retained handle" : "Root identity or local NTFS policy mismatch";
  napi_value proof, mac, key_id, marker, native_observation, code, message, error; void* copied = nullptr;
  if (!observed_code[0] || napi_create_buffer_copy(env, observation.proof.size(), observation.proof.data(), &copied, &proof) != napi_ok
    || napi_create_string_utf8(env, observation.mac.c_str(), NAPI_AUTO_LENGTH, &mac) != napi_ok || napi_create_string_utf8(env, observation.key_id.c_str(), NAPI_AUTO_LENGTH, &key_id) != napi_ok
    || napi_create_string_utf8(env, observation.channel_marker.c_str(), NAPI_AUTO_LENGTH, &marker) != napi_ok || napi_create_object(env, &native_observation) != napi_ok) return false;
  napi_property_descriptor properties[] = {{"proof", nullptr, nullptr, nullptr, nullptr, proof, napi_enumerable, nullptr}, {"mac", nullptr, nullptr, nullptr, nullptr, mac, napi_enumerable, nullptr}, {"keyId", nullptr, nullptr, nullptr, nullptr, key_id, napi_enumerable, nullptr}, {"channelMarker", nullptr, nullptr, nullptr, nullptr, marker, napi_enumerable, nullptr}};
  if (napi_define_properties(env, native_observation, sizeof(properties) / sizeof(properties[0]), properties) != napi_ok || napi_object_freeze(env, native_observation) != napi_ok
    || napi_create_string_utf8(env, observed_code, NAPI_AUTO_LENGTH, &code) != napi_ok || napi_create_string_utf8(env, observed_message, NAPI_AUTO_LENGTH, &message) != napi_ok
    || napi_create_error(env, code, message, &error) != napi_ok) return false;
  napi_property_descriptor native_property = {"nativeObservation", nullptr, nullptr, nullptr, nullptr, native_observation, napi_enumerable, nullptr};
  return napi_define_properties(env, error, 1, &native_property) == napi_ok && napi_throw(env, error) == napi_ok;
}

bool OpenCurrentExecutable(TrustedRootHandle* executable, std::string* sha256) {
  std::array<wchar_t, 32768> path{}; const DWORD count = GetModuleFileNameW(nullptr, path.data(), static_cast<DWORD>(path.size()));
  if (!count || count >= path.size()) return false;
  executable->handle = CreateFileW(path.data(), GENERIC_READ | FILE_READ_ATTRIBUTES, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
  if (executable->handle == INVALID_HANDLE_VALUE || !GetFileInformationByHandle(executable->handle, &executable->identity)
      || (executable->identity.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) || !IsAmd64Pe(executable->handle)) return false;
  std::array<wchar_t, 32768> final_path{}; const DWORD final_count = GetFinalPathNameByHandleW(executable->handle, final_path.data(), static_cast<DWORD>(final_path.size()), FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
  std::array<wchar_t, MAX_PATH> volume_path{}; std::array<wchar_t, 32> filesystem{}; DWORD serial = 0;
  if (!final_count || final_count >= final_path.size() || !GetVolumePathNameW(final_path.data(), volume_path.data(), static_cast<DWORD>(volume_path.size()))
      || GetDriveTypeW(volume_path.data()) != DRIVE_FIXED || !GetVolumeInformationW(volume_path.data(), nullptr, 0, &serial, nullptr, nullptr, filesystem.data(), static_cast<DWORD>(filesystem.size()))
      || _wcsicmp(filesystem.data(), L"NTFS") != 0 || serial != executable->identity.dwVolumeSerialNumber || !Sha256Handle(executable->handle, sha256)) return false;
  return SetHandleInformation(executable->handle, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT);
}

bool ReadSmallFile(const std::wstring& path, std::string* wire) {
  HANDLE file = CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT, nullptr); if (file == INVALID_HANDLE_VALUE) return false;
  BY_HANDLE_FILE_INFORMATION info{}; LARGE_INTEGER size{}; bool ok = GetFileInformationByHandle(file, &info) && !(info.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) && GetFileSizeEx(file, &size) && size.QuadPart > 0 && size.QuadPart <= 1024 * 1024;
  if (ok) { wire->resize(static_cast<size_t>(size.QuadPart)); DWORD got = 0; ok = ReadFile(file, wire->data(), static_cast<DWORD>(wire->size()), &got, nullptr) && got == wire->size(); } CloseHandle(file); return ok;
}
bool SameJournalIdentity(const mini_lux::sec03::JournalRecord& a, const mini_lux::sec03::JournalRecord& b) {
  return a.format_version == b.format_version && a.candidate_host_sha256 == b.candidate_host_sha256 && a.launcher_sha256 == b.launcher_sha256 && a.execution_id == b.execution_id && a.context_id == b.context_id && a.session_id == b.session_id && a.run_id == b.run_id && a.authority_epoch == b.authority_epoch && a.profile == b.profile && a.sid_string == b.sid_string && a.sid_bytes == b.sid_bytes && a.root_path == b.root_path && a.resource_kind == b.resource_kind && a.volume == b.volume && a.file == b.file && a.access_mask == b.access_mask && a.acl_digest == b.acl_digest && a.ace == b.ace && a.objects == b.objects && a.host_pid == b.host_pid && a.host_created == b.host_created;
}
bool OwnedHostAlive(const mini_lux::sec03::JournalRecord& record) { HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, record.host_pid); if (!process) return false; FILETIME created{}, exited{}, kernel{}, user{}; const bool same = GetProcessTimes(process, &created, &exited, &kernel, &user) && mini_lux::sec03::FileTimeValue(created) == record.host_created && WaitForSingleObject(process, 0) == WAIT_TIMEOUT; CloseHandle(process); return same; }
bool SameAcl(PACL a, PACL b) { return a && b && a->AclSize == b->AclSize && memcmp(a, b, a->AclSize) == 0; }
bool SameAceSequence(PACL a, PACL b) { if (!a || !b || a->AceCount != b->AceCount) return false; for (DWORD i = 0; i < a->AceCount; ++i) { void* x = nullptr; void* y = nullptr; if (!GetAce(a, i, &x) || !GetAce(b, i, &y)) return false; const auto* xh = static_cast<ACE_HEADER*>(x); const auto* yh = static_cast<ACE_HEADER*>(y); if (xh->AceSize != yh->AceSize || memcmp(x, y, xh->AceSize)) return false; } return true; }
bool QualifyRecoveryResource(HANDLE resource, const mini_lux::sec03::JournalRecord& record) {
  BY_HANDLE_FILE_INFORMATION identity{}; std::array<wchar_t, 32768> final{}; std::array<wchar_t, MAX_PATH> volume_path{}; std::array<wchar_t, 32> filesystem{}; DWORD serial = 0;
  if (!GetFileInformationByHandle(resource, &identity)) return false; const DWORD n = GetFinalPathNameByHandleW(resource, final.data(), static_cast<DWORD>(final.size()), FILE_NAME_NORMALIZED | VOLUME_NAME_DOS); const bool directory = (identity.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
  return !(identity.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) && directory == (record.resource_kind == "directory") && (record.resource_kind == "directory" || record.resource_kind == "file")
    && identity.dwVolumeSerialNumber == record.volume && FileId(identity) == record.file && n && n < final.size() && _wcsicmp(final.data(), record.root_path.c_str()) == 0
    && GetVolumePathNameW(final.data(), volume_path.data(), static_cast<DWORD>(volume_path.size())) && GetDriveTypeW(volume_path.data()) == DRIVE_FIXED && GetVolumeInformationW(volume_path.data(), nullptr, 0, &serial, nullptr, nullptr, filesystem.data(), static_cast<DWORD>(filesystem.size())) && serial == identity.dwVolumeSerialNumber && _wcsicmp(filesystem.data(), L"NTFS") == 0;
}

struct RecoveryTreeEntry { std::wstring path; BY_HANDLE_FILE_INFORMATION identity{}; bool directory = false; };
struct RecoveryFileHandle { HANDLE value = INVALID_HANDLE_VALUE; explicit RecoveryFileHandle(HANDLE handle = INVALID_HANDLE_VALUE) : value(handle) {} ~RecoveryFileHandle() { if (value != INVALID_HANDLE_VALUE) CloseHandle(value); } RecoveryFileHandle(const RecoveryFileHandle&) = delete; RecoveryFileHandle& operator=(const RecoveryFileHandle&) = delete; };
struct RecoveryLedgerLease {
  HANDLE value = INVALID_HANDLE_VALUE;
  BY_HANDLE_FILE_INFORMATION identity{};
  const mini_lux::sec03::JournalObject* object = nullptr;
  ~RecoveryLedgerLease() { if (value != INVALID_HANDLE_VALUE) CloseHandle(value); }
  RecoveryLedgerLease() = default;
  RecoveryLedgerLease(const RecoveryLedgerLease&) = delete;
  RecoveryLedgerLease& operator=(const RecoveryLedgerLease&) = delete;
  RecoveryLedgerLease(RecoveryLedgerLease&& other) noexcept : value(other.value), identity(other.identity), object(other.object) { other.value = INVALID_HANDLE_VALUE; other.object = nullptr; }
};
struct RecoveryFindHandle { HANDLE value = INVALID_HANDLE_VALUE; ~RecoveryFindHandle() { if (value != INVALID_HANDLE_VALUE) FindClose(value); } };

bool RecoverySidFromAce(const ACE_HEADER* header, PSID* sid) {
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
  if (offset >= header->AceSize) return false; auto* candidate = const_cast<unsigned char*>(reinterpret_cast<const unsigned char*>(header) + offset); if (!IsValidSid(candidate)) return false; if (GetLengthSid(candidate) > header->AceSize - offset) return false; *sid = candidate; return true;
}

bool RecoveryExpectedAce(const ACE_HEADER* header, const mini_lux::sec03::JournalRecord& record, BYTE explicit_flags, bool inherited_allowed) {
  PSID sid = const_cast<unsigned char*>(record.sid_bytes.data()); if (!header || header->AceType != ACCESS_ALLOWED_ACE_TYPE || header->AceSize != sizeof(ACCESS_ALLOWED_ACE) - sizeof(DWORD) + GetLengthSid(sid)) return false;
  const auto* ace = reinterpret_cast<const ACCESS_ALLOWED_ACE*>(header); const bool flags = header->AceFlags == explicit_flags || (inherited_allowed && header->AceFlags == static_cast<BYTE>(explicit_flags | INHERITED_ACE)); return flags && ace->Mask == record.access_mask && EqualSid(const_cast<DWORD*>(&ace->SidStart), sid);
}

bool InspectRecoveryAcl(PACL acl, const mini_lux::sec03::JournalRecord& record, BYTE explicit_flags, bool inherited_allowed, unsigned* expected, bool* unexpected) {
  *expected = 0; *unexpected = false; PSID sid = const_cast<unsigned char*>(record.sid_bytes.data()); if (!acl || !IsValidSid(sid)) return false;
  for (DWORD i = 0; i < acl->AceCount; ++i) { void* raw = nullptr; if (!GetAce(acl, i, &raw)) return false; const auto* header = static_cast<ACE_HEADER*>(raw); PSID ace_sid = nullptr; if (!RecoverySidFromAce(header, &ace_sid)) return false; if (!ace_sid || !EqualSid(ace_sid, sid)) continue; if (RecoveryExpectedAce(header, record, explicit_flags, inherited_allowed)) ++*expected; else *unexpected = true; }
  return true;
}

bool CanonicalJournalGrant(const mini_lux::sec03::JournalRecord& record) {
  if (!mini_lux::sec03::AppPackageSid(const_cast<unsigned char*>(record.sid_bytes.data()))) return false; const BYTE flags = record.resource_kind == "directory" ? CONTAINER_INHERIT_ACE | OBJECT_INHERIT_ACE : 0; if ((record.resource_kind == "directory" && record.format_version != 3 && record.format_version != 5) || (record.resource_kind == "file" && record.format_version != 4) || (record.resource_kind != "directory" && record.resource_kind != "file") || record.objects.size() > mini_lux::sec03::kMaxJournalObjects || (record.format_version != 5 && !record.objects.empty())) return false;
  std::uint64_t previous = 0; for (const auto& object : record.objects) { if (!object.file || object.file == record.file || object.file <= previous || !mini_lux::sec03::CanonicalHex(object.acl_digest, 32, 32)) return false; previous = object.file; }
  const size_t expected_bytes = sizeof(ACCESS_ALLOWED_ACE) - sizeof(DWORD) + record.sid_bytes.size(); return record.ace.size() == expected_bytes && record.ace.size() <= MAXWORD && RecoveryExpectedAce(reinterpret_cast<const ACE_HEADER*>(record.ace.data()), record, flags, false) && reinterpret_cast<const ACE_HEADER*>(record.ace.data())->AceSize == record.ace.size();
}

bool JournalProfileSid(const mini_lux::sec03::JournalRecord& record) {
  PSID derived = nullptr; const HRESULT result = DeriveAppContainerSidFromAppContainerName(record.profile.c_str(), &derived); if (result != S_OK || !derived) return false; const bool same = IsValidSid(derived) && GetLengthSid(derived) == record.sid_bytes.size() && memcmp(derived, record.sid_bytes.data(), record.sid_bytes.size()) == 0; FreeSid(derived); return same;
}

void RecoveryStage(unsigned stage);
bool RecoveryAclDigest(PACL acl, const std::string* expected) { if (!expected) return true; std::string digest; return mini_lux::sec03::AclSequenceDigest(acl, &digest) && digest == *expected; }
bool RemoveRecoveryAces(HANDLE resource, const BY_HANDLE_FILE_INFORMATION& identity, const mini_lux::sec03::JournalRecord& record, bool directory, bool root, bool* anomaly, const std::string* expected_digest = nullptr) {
  PACL current = nullptr; PSECURITY_DESCRIPTOR descriptor = nullptr; if (GetSecurityInfo(resource, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, nullptr, nullptr, &current, nullptr, &descriptor) != ERROR_SUCCESS || !current) return false; const BYTE flags = directory ? CONTAINER_INHERIT_ACE | OBJECT_INHERIT_ACE : 0; unsigned matches = 0; bool unexpected = false;
  bool ok = InspectRecoveryAcl(current, record, flags, !root, &matches, &unexpected); *anomaly = unexpected || matches > 1; if (!ok) { if (expected_digest) RecoveryStage(4131); LocalFree(descriptor); return false; } if (!matches) { ok = RecoveryAclDigest(current, expected_digest); if (!ok && expected_digest) RecoveryStage(4132); LocalFree(descriptor); return ok; }
  DWORD bytes = sizeof(ACL); for (DWORD i = 0; i < current->AceCount; ++i) { void* raw = nullptr; if (!GetAce(current, i, &raw)) { LocalFree(descriptor); return false; } const auto* header = static_cast<ACE_HEADER*>(raw); if (!RecoveryExpectedAce(header, record, flags, !root)) bytes += header->AceSize; }
  std::vector<unsigned char> storage(bytes); PACL cleaned = reinterpret_cast<PACL>(storage.data()); const DWORD revision = current->AclRevision; ok = InitializeAcl(cleaned, bytes, revision) != FALSE;
  for (DWORD i = 0; ok && i < current->AceCount; ++i) { void* raw = nullptr; ok = GetAce(current, i, &raw) != FALSE; if (!ok) break; const auto* header = static_cast<ACE_HEADER*>(raw); if (!RecoveryExpectedAce(header, record, flags, !root)) ok = AddAce(cleaned, revision, MAXDWORD, raw, header->AceSize) != FALSE; }
  if (ok) ok = RecoveryAclDigest(cleaned, expected_digest); if (!ok) { if (expected_digest) RecoveryStage(4133); LocalFree(descriptor); return false; }
  PACL barrier = nullptr; PSECURITY_DESCRIPTOR barrier_descriptor = nullptr; BY_HANDLE_FILE_INFORMATION barrier_identity{}; ok = GetSecurityInfo(resource, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, nullptr, nullptr, &barrier, nullptr, &barrier_descriptor) == ERROR_SUCCESS && SameAcl(current, barrier) && GetFileInformationByHandle(resource, &barrier_identity) && barrier_identity.dwVolumeSerialNumber == identity.dwVolumeSerialNumber && FileId(barrier_identity) == FileId(identity); if (ok) ok = SetSecurityInfo(resource, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, nullptr, nullptr, cleaned, nullptr) == ERROR_SUCCESS; if (!ok && expected_digest) RecoveryStage(4134);
  PACL observed = nullptr; PSECURITY_DESCRIPTOR observed_descriptor = nullptr; unsigned remaining = 0; bool observed_unexpected = false; if (ok) ok = GetSecurityInfo(resource, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, nullptr, nullptr, &observed, nullptr, &observed_descriptor) == ERROR_SUCCESS && SameAceSequence(cleaned, observed) && InspectRecoveryAcl(observed, record, flags, !root, &remaining, &observed_unexpected) && remaining == 0; if (!ok && expected_digest) RecoveryStage(4135); *anomaly = *anomaly || observed_unexpected;
  if (observed_descriptor) LocalFree(observed_descriptor); if (barrier_descriptor) LocalFree(barrier_descriptor); LocalFree(descriptor); return ok;
}

enum class RecoveryLedgerState { clean, retry, fatal };
RecoveryLedgerState InspectRecoveryLedgerState(HANDLE resource, const mini_lux::sec03::JournalRecord& record, const mini_lux::sec03::JournalObject& object) {
  PACL current = nullptr; PSECURITY_DESCRIPTOR descriptor = nullptr; if (GetSecurityInfo(resource, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, nullptr, nullptr, &current, nullptr, &descriptor) != ERROR_SUCCESS || !current) return RecoveryLedgerState::fatal;
  const BYTE flags = object.directory ? CONTAINER_INHERIT_ACE | OBJECT_INHERIT_ACE : 0; unsigned matches = 0; bool unexpected = false; bool ok = InspectRecoveryAcl(current, record, flags, true, &matches, &unexpected); if (!ok || unexpected || matches > 1) { LocalFree(descriptor); return RecoveryLedgerState::fatal; }
  if (!matches) { const bool clean = RecoveryAclDigest(current, &object.acl_digest); LocalFree(descriptor); return clean ? RecoveryLedgerState::clean : RecoveryLedgerState::fatal; }
  DWORD bytes = sizeof(ACL); for (DWORD i = 0; i < current->AceCount; ++i) { void* raw = nullptr; if (!GetAce(current, i, &raw)) { LocalFree(descriptor); return RecoveryLedgerState::fatal; } const auto* header = static_cast<ACE_HEADER*>(raw); if (!RecoveryExpectedAce(header, record, flags, true)) bytes += header->AceSize; }
  std::vector<unsigned char> storage(bytes); PACL cleaned = reinterpret_cast<PACL>(storage.data()); const DWORD revision = current->AclRevision; ok = InitializeAcl(cleaned, bytes, revision) != FALSE;
  for (DWORD i = 0; ok && i < current->AceCount; ++i) { void* raw = nullptr; ok = GetAce(current, i, &raw) != FALSE; if (!ok) break; const auto* header = static_cast<ACE_HEADER*>(raw); if (!RecoveryExpectedAce(header, record, flags, true)) ok = AddAce(cleaned, revision, MAXDWORD, raw, header->AceSize) != FALSE; }
  const bool retry = ok && RecoveryAclDigest(cleaned, &object.acl_digest); LocalFree(descriptor); return retry ? RecoveryLedgerState::retry : RecoveryLedgerState::fatal;
}

bool CollectRecoveryDescendants(HANDLE root, const mini_lux::sec03::JournalRecord& record, std::vector<RecoveryTreeEntry>* entries) {
  BY_HANDLE_FILE_INFORMATION root_identity{}; if (!GetFileInformationByHandle(root, &root_identity)) return false; std::vector<RecoveryTreeEntry> pending; pending.push_back({record.root_path, root_identity, true});
  while (!pending.empty()) {
    RecoveryTreeEntry parent = std::move(pending.back()); pending.pop_back(); RecoveryFileHandle directory(CreateFileW(parent.path.c_str(), FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr)); if (directory.value == INVALID_HANDLE_VALUE) return false; BY_HANDLE_FILE_INFORMATION parent_identity{}; const bool parent_ok = GetFileInformationByHandle(directory.value, &parent_identity) && parent_identity.dwVolumeSerialNumber == parent.identity.dwVolumeSerialNumber && FileId(parent_identity) == FileId(parent.identity) && (parent_identity.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) && !(parent_identity.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT); if (!parent_ok) return false;
    WIN32_FIND_DATAW data{}; RecoveryFindHandle search; search.value = FindFirstFileExW((parent.path + L"\\*").c_str(), FindExInfoBasic, &data, FindExSearchNameMatch, nullptr, FIND_FIRST_EX_LARGE_FETCH); if (search.value == INVALID_HANDLE_VALUE) { if (GetLastError() == ERROR_FILE_NOT_FOUND) continue; return false; }
    do {
      const std::wstring name = data.cFileName; if (name == L"." || name == L"..") continue; if (name.empty() || name.find(L'\\') != std::wstring::npos || parent.path.size() + name.size() + 1 >= 32767) return false; const std::wstring path = parent.path + L"\\" + name; const bool hinted_directory = (data.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
      RecoveryFileHandle child(CreateFileW(path.c_str(), READ_CONTROL, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT | (hinted_directory ? FILE_FLAG_BACKUP_SEMANTICS : 0), nullptr)); if (child.value == INVALID_HANDLE_VALUE) return false; BY_HANDLE_FILE_INFORMATION info{}; if (!GetFileInformationByHandle(child.value, &info) || info.dwVolumeSerialNumber != record.volume) return false; const bool child_directory = (info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
      PACL acl = nullptr; PSECURITY_DESCRIPTOR descriptor = nullptr; if (GetSecurityInfo(child.value, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, nullptr, nullptr, &acl, nullptr, &descriptor) != ERROR_SUCCESS || !acl) return false; unsigned matches = 0; bool unexpected = false; const BYTE flags = child_directory ? CONTAINER_INHERIT_ACE | OBJECT_INHERIT_ACE : 0; const bool inspectable = InspectRecoveryAcl(acl, record, flags, true, &matches, &unexpected); LocalFree(descriptor); if (!inspectable || unexpected || matches > 1) return false;
      entries->push_back({path, info, child_directory}); if (child_directory && !(info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT)) pending.push_back({path, info, true});
    } while (FindNextFileW(search.value, &data)); if (GetLastError() != ERROR_NO_MORE_FILES) return false;
  }
  return true;
}

bool VerifyRecoveryDescendants(HANDLE root, const mini_lux::sec03::JournalRecord& record) {
  std::vector<RecoveryTreeEntry> entries; if (!CollectRecoveryDescendants(root, record, &entries)) return false;
  for (const auto& entry : entries) { HANDLE resource = CreateFileW(entry.path.c_str(), READ_CONTROL, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT | (entry.directory ? FILE_FLAG_BACKUP_SEMANTICS : 0), nullptr); if (resource == INVALID_HANDLE_VALUE) return false; BY_HANDLE_FILE_INFORMATION identity{}; PACL acl = nullptr; PSECURITY_DESCRIPTOR descriptor = nullptr; const bool same = GetFileInformationByHandle(resource, &identity) && identity.dwVolumeSerialNumber == entry.identity.dwVolumeSerialNumber && FileId(identity) == FileId(entry.identity); bool ok = same && GetSecurityInfo(resource, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, nullptr, nullptr, &acl, nullptr, &descriptor) == ERROR_SUCCESS && acl; unsigned matches = 0; bool unexpected = false; const BYTE flags = entry.directory ? CONTAINER_INHERIT_ACE | OBJECT_INHERIT_ACE : 0; if (ok) ok = InspectRecoveryAcl(acl, record, flags, true, &matches, &unexpected) && matches == 0 && !unexpected; if (descriptor) LocalFree(descriptor); CloseHandle(resource); if (!ok) return false; }
  return true;
}

enum class LedgerOpenResult { opened, absent, failed };
LedgerOpenResult OpenLedgerObject(HANDLE volume_hint, const mini_lux::sec03::JournalRecord& record, const mini_lux::sec03::JournalObject& object, DWORD access, HANDLE* output, BY_HANDLE_FILE_INFORMATION* identity) {
  FILE_ID_DESCRIPTOR descriptor{}; descriptor.dwSize = sizeof(descriptor); descriptor.Type = FileIdType; descriptor.FileId.QuadPart = static_cast<LONGLONG>(object.file); const DWORD flags = FILE_FLAG_OPEN_REPARSE_POINT | (object.directory ? FILE_FLAG_BACKUP_SEMANTICS : 0);
  HANDLE resource = OpenFileById(volume_hint, &descriptor, access, FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, flags); if (resource == INVALID_HANDLE_VALUE) { const DWORD error = GetLastError(); return error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND ? LedgerOpenResult::absent : LedgerOpenResult::failed; }
  BY_HANDLE_FILE_INFORMATION observed{}; const bool information = GetFileInformationByHandle(resource, &observed) != FALSE; const bool directory = information && (observed.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
  if (!information || directory != object.directory || observed.dwVolumeSerialNumber != record.volume || FileId(observed) != object.file) { CloseHandle(resource); return LedgerOpenResult::failed; }
  *output = resource; *identity = observed; return LedgerOpenResult::opened;
}

#ifdef MINI_LUX_SEC03_NATIVE_TEST
thread_local unsigned g_recovery_stage = 0;
void RecoveryStage(unsigned stage) { g_recovery_stage = stage; }
#else
void RecoveryStage(unsigned) {}
#endif
bool RecoverLedgerAces(HANDLE root, const mini_lux::sec03::JournalRecord& record) {
  try {
    std::vector<RecoveryLedgerLease> leases; leases.reserve(record.objects.size()); unsigned ledger_index = 0;
    for (const auto& object : record.objects) { RecoveryStage(4100 + ledger_index++); RecoveryLedgerLease lease; const auto opened = OpenLedgerObject(root, record, object, MAXIMUM_ALLOWED, &lease.value, &lease.identity); if (opened != LedgerOpenResult::opened) return false; lease.object = &object; leases.push_back(std::move(lease)); }
    size_t previous_clean = 0;
    for (size_t pass = 0; pass <= leases.size(); ++pass) {
      ledger_index = 0; for (const auto& lease : leases) { RecoveryStage(4200 + ledger_index++); bool anomaly = false; RemoveRecoveryAces(lease.value, lease.identity, record, lease.object->directory, false, &anomaly, &lease.object->acl_digest); }
      size_t clean = 0; ledger_index = 0;
      for (const auto& lease : leases) { RecoveryStage(4300 + ledger_index++); const auto state = InspectRecoveryLedgerState(lease.value, record, *lease.object); if (state == RecoveryLedgerState::fatal) return false; if (state == RecoveryLedgerState::clean) ++clean; }
      if (clean == leases.size()) return true;
      if (pass > 0 && clean <= previous_clean) return false;
      previous_clean = clean;
    }
    return false;
  } catch (...) { SetLastError(ERROR_NOT_ENOUGH_MEMORY); return false; }
}

bool RecoverDirectoryAces(HANDLE root, const mini_lux::sec03::JournalRecord& record) {
  if (record.format_version == 5 && !RecoverLedgerAces(root, record)) return false;
  std::vector<RecoveryTreeEntry> entries; if (!CollectRecoveryDescendants(root, record, &entries)) return false; bool clean = true;
  for (const auto& entry : entries) { HANDLE resource = CreateFileW(entry.path.c_str(), READ_CONTROL | WRITE_DAC, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT | (entry.directory ? FILE_FLAG_BACKUP_SEMANTICS : 0), nullptr); if (resource == INVALID_HANDLE_VALUE) { clean = false; continue; } BY_HANDLE_FILE_INFORMATION identity{}; bool anomaly = false; if (!GetFileInformationByHandle(resource, &identity) || identity.dwVolumeSerialNumber != entry.identity.dwVolumeSerialNumber || FileId(identity) != FileId(entry.identity) || !RemoveRecoveryAces(resource, entry.identity, record, entry.directory, false, &anomaly) || anomaly) clean = false; CloseHandle(resource); }
  return clean && VerifyRecoveryDescendants(root, record);
}

bool RemoveExactAce(HANDLE root, const mini_lux::sec03::JournalRecord& record, bool exact_d0 = false) {
  if (!QualifyRecoveryResource(root, record)) return false; BY_HANDLE_FILE_INFORMATION identity{}; if (!GetFileInformationByHandle(root, &identity)) return false; bool anomaly = false; const std::string* expected_digest = exact_d0 ? &record.acl_digest : nullptr;
  if (!RemoveRecoveryAces(root, identity, record, record.resource_kind == "directory", true, &anomaly, expected_digest) || anomaly) return false;
  return record.resource_kind != "directory" || RecoverDirectoryAces(root, record);
}
struct JournalGroup { std::map<unsigned, std::wstring> published; std::map<unsigned, std::wstring> temporary; };
struct FixedAclRecoveryEvidence {
  mini_lux::sec03::JournalRecord record;
  std::string execution_id;
  std::string context_id;
  std::string session_id;
  std::string run_id;
  std::uint64_t authority_epoch = 0;
  DWORD host_pid = 0;
  std::uint64_t host_created = 0;
  std::uint64_t root_volume = 0;
  std::uint64_t root_file = 0;
  std::string expected_state;
  unsigned expected_generation = 0;
  unsigned journal_writes = 0;
  unsigned acl_mutations = 0;
  std::uint64_t process_starts = 0;
  bool active_process_zero = false;
  bool lifecycle_job_closed = false;
  bool profile_deleted = false;
  bool root_acl_exact = false;
  bool appcontainer_aces_absent = false;
  bool journals_deleted = false;
};
bool DeleteJournalFile(const std::wstring& path) { if (DeleteFileW(path.c_str())) return true; return GetLastError() == ERROR_FILE_NOT_FOUND; }
bool JournalDirectoryEmpty(const std::wstring& path) {
  WIN32_FIND_DATAW data{}; HANDLE search = FindFirstFileW((path + L"\\*").c_str(), &data); if (search == INVALID_HANDLE_VALUE) return GetLastError() == ERROR_FILE_NOT_FOUND; bool empty = true;
  do { const std::wstring name = data.cFileName; if (name != L"." && name != L"..") { empty = false; break; } } while (FindNextFileW(search, &data)); const DWORD error = GetLastError(); FindClose(search); return empty && error == ERROR_NO_MORE_FILES;
}
bool JournalName(const std::wstring& name, std::wstring* prefix, unsigned* generation, bool* temporary) {
  if (name.size() != 45 || name.rfind(L"txn-", 0) != 0 || name[36] != L'.') return false; for (size_t i = 4; i < 36; ++i) if (!((name[i] >= L'0' && name[i] <= L'9') || (name[i] >= L'a' && name[i] <= L'f'))) return false;
  unsigned value = 0; for (size_t i = 37; i < 41; ++i) { if (name[i] < L'0' || name[i] > L'9') return false; value = value * 10 + static_cast<unsigned>(name[i] - L'0'); } if (value < 1 || value > 9999) return false; const std::wstring ext = name.substr(41); if (ext != L".jrn" && ext != L".tmp") return false; *prefix = name.substr(0, 36); *generation = static_cast<unsigned>(value); *temporary = ext == L".tmp"; return true;
}
bool RecoverJournals(const std::string& candidate, const std::string& launcher, FixedAclRecoveryEvidence* evidence = nullptr) {
  mini_lux::sec03::JournalDirectoryLease directory; if (!mini_lux::sec03::JournalDirectory(&directory)) return false; std::map<std::wstring, JournalGroup> groups; WIN32_FIND_DATAW data{}; HANDLE search = FindFirstFileW((directory.path + L"\\*").c_str(), &data); if (search == INVALID_HANDLE_VALUE) return !evidence && GetLastError() == ERROR_FILE_NOT_FOUND;
  bool names_ok = true; do { const std::wstring name = data.cFileName; if ((data.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) && (name == L"." || name == L"..")) continue; std::wstring prefix; unsigned generation = 0; bool temporary = false; if ((data.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) || !JournalName(name, &prefix, &generation, &temporary)) { names_ok = false; break; } auto& target = temporary ? groups[prefix].temporary : groups[prefix].published; if (!target.emplace(generation, directory.path + L"\\" + name).second) { names_ok = false; break; } } while (FindNextFileW(search, &data)); FindClose(search); if (!names_ok || (evidence && groups.size() != 1)) return false;
  for (auto& [prefix, group] : groups) {
    if (group.published.empty()) { if (evidence || group.temporary.size() != 1 || group.temporary.begin()->first != 1 || !DeleteJournalFile(group.temporary.begin()->second)) return false; continue; }
    for (unsigned i = 1; i <= group.published.size(); ++i) if (!group.published.count(i)) return false;
    if (group.temporary.size() > 1 || (!group.temporary.empty() && group.temporary.begin()->first != group.published.size() + 1)) return false;
    mini_lux::sec03::JournalRecord first{}, latest{}; const std::array<const char*, 4> states = {"prepared","applied","job-zero","removed"};
    for (unsigned i = 1; i <= group.published.size(); ++i) { std::string wire; mini_lux::sec03::JournalRecord current{}; if (!ReadSmallFile(group.published.at(i), &wire) || !mini_lux::sec03::ParseJournal(wire, &current) || current.generation != i || i > states.size() || current.state != states[i - 1] || (i > 1 && !SameJournalIdentity(first, current))) return false; if (i == 1) first = current; latest = current; }
    if (latest.candidate_host_sha256 != candidate || latest.launcher_sha256 != launcher || OwnedHostAlive(latest) || !CanonicalJournalGrant(latest) || !JournalProfileSid(latest)) return false;
    if (evidence && (!group.temporary.empty() || group.published.size() != evidence->expected_generation || latest.format_version != 5 || latest.resource_kind != "directory" || !latest.objects.empty()
      || latest.execution_id != evidence->execution_id || latest.context_id != evidence->context_id || latest.session_id != evidence->session_id || latest.run_id != evidence->run_id || latest.authority_epoch != evidence->authority_epoch
      || latest.host_pid != evidence->host_pid || latest.host_created != evidence->host_created || latest.volume != evidence->root_volume || latest.file != evidence->root_file || latest.state != evidence->expected_state || latest.generation != evidence->expected_generation || !JournalDirectoryEmpty(latest.root_path))) return false;
    RecoveryStage(200); const HRESULT deleted = DeleteAppContainerProfile(latest.profile.c_str()); if ((evidence && deleted != S_OK) || (!evidence && deleted != S_OK && deleted != HRESULT_FROM_WIN32(ERROR_NOT_FOUND) && deleted != HRESULT_FROM_WIN32(ERROR_FILE_NOT_FOUND))) return false;
    TrustedRootHandle root; const DWORD open_flags = FILE_FLAG_OPEN_REPARSE_POINT | (latest.resource_kind == "directory" ? FILE_FLAG_BACKUP_SEMANTICS : 0); const DWORD open_access = latest.resource_kind == "directory" ? MAXIMUM_ALLOWED : READ_CONTROL | WRITE_DAC | FILE_READ_ATTRIBUTES;
    RecoveryStage(300); root.handle = CreateFileW(latest.root_path.c_str(), open_access, FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING, open_flags, nullptr); if (root.handle == INVALID_HANDLE_VALUE) return false;
    if (evidence) {
      PACL before = nullptr; PSECURITY_DESCRIPTOR before_descriptor = nullptr; unsigned matches = 0; bool unexpected = false; const bool inspected = GetSecurityInfo(root.handle, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, nullptr, nullptr, &before, nullptr, &before_descriptor) == ERROR_SUCCESS && before
        && InspectRecoveryAcl(before, latest, CONTAINER_INHERIT_ACE | OBJECT_INHERIT_ACE, false, &matches, &unexpected) && !unexpected
        && ((latest.state == "prepared" && matches == 0 && RecoveryAclDigest(before, &latest.acl_digest)) || (latest.state == "applied" && matches == 1));
      if (before_descriptor) LocalFree(before_descriptor); if (!inspected) return false;
    }
    RecoveryStage(400); if (!RemoveExactAce(root.handle, latest, evidence != nullptr)) return false;
    if (evidence) {
      PACL after = nullptr; PSECURITY_DESCRIPTOR after_descriptor = nullptr; unsigned matches = 0; bool unexpected = false; const bool exact = GetSecurityInfo(root.handle, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, nullptr, nullptr, &after, nullptr, &after_descriptor) == ERROR_SUCCESS && after
        && RecoveryAclDigest(after, &latest.acl_digest) && InspectRecoveryAcl(after, latest, CONTAINER_INHERIT_ACE | OBJECT_INHERIT_ACE, false, &matches, &unexpected) && matches == 0 && !unexpected;
      if (after_descriptor) LocalFree(after_descriptor); if (!exact) return false; evidence->profile_deleted = true; evidence->root_acl_exact = true; evidence->appcontainer_aces_absent = true;
    }
    RecoveryStage(500); for (auto it = group.temporary.rbegin(); it != group.temporary.rend(); ++it) if (!DeleteJournalFile(it->second)) return false;
    for (auto it = group.published.rbegin(); it != group.published.rend(); ++it) if (!DeleteJournalFile(it->second)) return false;
    if (evidence) {
      if (!JournalDirectoryEmpty(directory.path)) return false; evidence->record = latest; evidence->journal_writes = static_cast<unsigned>(group.published.size()); evidence->acl_mutations = latest.state == "applied" ? 2u : 0u; evidence->journals_deleted = true;
    }
  }
  return true;
}

bool FixedAclLaunchBinding(Execution* execution, FixedAclRecoveryEvidence* evidence) {
  if (!execution || !evidence || !execution->attestation_key.available || (execution->fixed_acl_variant != "A09-06" && execution->fixed_acl_variant != "A09-07" && execution->fixed_acl_variant != "A14-01" && execution->fixed_acl_variant != "A14-02")) return false; const Json& launch = execution->launch_request;
  const Json* candidate = Field(launch, "candidateId", Json::Kind::string); const Json* build = Field(launch, "buildIdSha256", Json::Kind::string); const Json* source = Field(launch, "sourceSha256", Json::Kind::string); const Json* host = Field(launch, "hostSha256", Json::Kind::string); const Json* launcher = Field(launch, "launcherSha256", Json::Kind::string);
  const Json* execution_id = Field(launch, "executionId", Json::Kind::string); const Json* context = Field(launch, "contextId", Json::Kind::string); const Json* session = Field(launch, "sessionId", Json::Kind::string); const Json* run = Field(launch, "runId", Json::Kind::string); const Json* authority = Field(launch, "authorityEpoch", Json::Kind::number); const Json* entry = Field(launch, "entryPoint", Json::Kind::string); const Json* profile = Field(launch, "profile", Json::Kind::string); const Json* secret = Field(launch, "secret", Json::Kind::string); const Json* tuple = Field(launch, "fixedAdversary", Json::Kind::string); const Json* state_mac = Field(launch, "fixedStateMac", Json::Kind::string); const Json* roots = Field(launch, "roots", Json::Kind::array);
  const std::map<std::string, std::string> profiles = {{"E1","one-shot-shell"},{"E2","agent-shell"},{"E3","script"},{"E4","manual-terminal"}}; const auto expected_profile = entry ? profiles.find(entry->scalar) : profiles.end(); std::uint64_t authority_epoch = 0;
  if (!candidate || candidate->scalar != execution->candidate_sha256 || !build || build->scalar != execution->build_sha256 || !source || source->scalar != execution->source_sha256 || !host || host->scalar != execution->host_sha256 || !launcher || launcher->scalar != execution->launcher_sha256
    || !execution_id || execution_id->scalar != execution->execution_id || !context || !session || !run || !authority || !mini_lux::sec03::Decimal(authority->scalar, &authority_epoch) || !authority_epoch || !entry || !profile || expected_profile == profiles.end() || profile->scalar != expected_profile->second
    || !secret || secret->scalar != execution->control_secret || !tuple || tuple->scalar != execution->fixed_acl_variant + "/" + entry->scalar || !state_mac || !roots || roots->array.size() != 1) return false;
  const Json& root = roots->array.front(); const Json* canonical_path = Field(root, "canonicalPath", Json::Kind::string); const Json* canonical_cwd = Field(root, "canonicalCwd", Json::Kind::string); const Json* identity = Field(root, "identity", Json::Kind::object); const Json* cwd_identity = Field(root, "cwdIdentity", Json::Kind::object);
  const Json* volume = identity ? Field(*identity, "volumeSerial", Json::Kind::string) : nullptr; const Json* file = identity ? Field(*identity, "fileId", Json::Kind::string) : nullptr; const Json* type = identity ? Field(*identity, "type", Json::Kind::string) : nullptr; const Json* cwd_volume = cwd_identity ? Field(*cwd_identity, "volumeSerial", Json::Kind::string) : nullptr; const Json* cwd_file = cwd_identity ? Field(*cwd_identity, "fileId", Json::Kind::string) : nullptr; const Json* cwd_type = cwd_identity ? Field(*cwd_identity, "type", Json::Kind::string) : nullptr;
  std::uint64_t root_volume = 0, root_file = 0, cwd_volume_value = 0, cwd_file_value = 0; if (!canonical_path || !canonical_cwd || canonical_path->scalar != canonical_cwd->scalar || !volume || !file || !type || type->scalar != "directory" || !cwd_volume || !cwd_file || !cwd_type || cwd_type->scalar != "directory"
    || !ParseUnsigned(volume->scalar, &root_volume) || root_volume > MAXDWORD || !ParseUnsigned(file->scalar, &root_file) || !ParseUnsigned(cwd_volume->scalar, &cwd_volume_value) || cwd_volume_value != root_volume || !ParseUnsigned(cwd_file->scalar, &cwd_file_value) || cwd_file_value != root_file) return false;
  RootIdentityPair identity_pair; identity_pair.expected_root_volume = static_cast<std::uint32_t>(root_volume); identity_pair.expected_root_file = root_file; identity_pair.expected_cwd_volume = static_cast<std::uint32_t>(cwd_volume_value); identity_pair.expected_cwd_file = cwd_file_value; std::string root_digest;
  std::vector<RootIdentityPair> identity_pairs{identity_pair}; if (!RootIdentityDigest(identity_pairs, false, &root_digest) || root_digest != execution->expected_root_identity_digest) return false;
  std::vector<unsigned char> received; std::array<unsigned char, 32> expected_mac{}; const std::string state_material = mini_lux::sec03::FixedAdversaryStateMaterial(tuple->scalar, secret->scalar, candidate->scalar, build->scalar, source->scalar, host->scalar, launcher->scalar, execution_id->scalar, run->scalar);
  if (!mini_lux::sec03::CanonicalHex(state_mac->scalar, 32, 32) || !mini_lux::sec03::Unhex(state_mac->scalar, &received) || received.size() != expected_mac.size() || !mini_lux::sec03::HmacSha256(execution->attestation_key, reinterpret_cast<const unsigned char*>(state_material.data()), state_material.size(), &expected_mac) || !mini_lux::sec03::ConstantTimeEqual(received.data(), expected_mac.data(), expected_mac.size())) return false;
  evidence->execution_id = execution_id->scalar; evidence->context_id = context->scalar; evidence->session_id = session->scalar; evidence->run_id = run->scalar; evidence->authority_epoch = authority_epoch; evidence->host_pid = execution->pid; evidence->host_created = execution->host_created; evidence->root_volume = root_volume; evidence->root_file = root_file;
  evidence->expected_state = execution->fixed_acl_variant == "A14-01" ? "prepared" : "applied"; evidence->expected_generation = execution->fixed_acl_variant == "A14-01" ? 1u : 2u; return true;
}

bool CloseLifecycleJobWithEvidence(Execution* execution, FixedAclRecoveryEvidence* evidence) {
  if (!execution || !evidence || !execution->lifecycle_job || !execution->lifecycle_triggered.load()) return false; JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting{}; bool zero = false;
  for (unsigned attempt = 0; attempt < 500; ++attempt) { if (QueryInformationJobObject(execution->lifecycle_job, JobObjectBasicAccountingInformation, &accounting, sizeof(accounting), nullptr) && accounting.ActiveProcesses == 0) { zero = true; break; } Sleep(10); }
  if (!zero || accounting.TotalProcesses < 2) return false; evidence->process_starts = accounting.TotalProcesses - 1; evidence->active_process_zero = true; CloseHandle(execution->lifecycle_job); execution->lifecycle_job = nullptr; evidence->lifecycle_job_closed = true; return true;
}

bool CreateFixedAclRecoveryObservation(Execution* execution, const FixedAclRecoveryEvidence& evidence, DWORD exit_code) {
  const Json& launch = execution->launch_request; const Json* context = Field(launch, "contextId", Json::Kind::string); const Json* session = Field(launch, "sessionId", Json::Kind::string); const Json* run = Field(launch, "runId", Json::Kind::string); const Json* authority = Field(launch, "authorityEpoch", Json::Kind::number); const Json* entry = Field(launch, "entryPoint", Json::Kind::string); const Json* profile = Field(launch, "profile", Json::Kind::string); const Json* persona = Field(launch, "personaDigest", Json::Kind::string); const Json* policy = Field(launch, "policyDigest", Json::Kind::string); const Json* payload_digest = Field(launch, "payloadDigest", Json::Kind::string); const Json* roots = Field(launch, "roots", Json::Kind::array); const Json* environment = Field(launch, "environment", Json::Kind::object); const Json* limits = Field(launch, "limits", Json::Kind::object); const Json* tuple = Field(launch, "fixedAdversary", Json::Kind::string);
  if (!context || !session || !run || !authority || !entry || !profile || !persona || !policy || !payload_digest || !roots || roots->array.size() != 1 || !environment || !limits || !tuple || !evidence.profile_deleted || !evidence.root_acl_exact || !evidence.appcontainer_aces_absent || !evidence.journals_deleted) return false;
  const bool lifecycle = execution->fixed_acl_variant == "A09-06" || execution->fixed_acl_variant == "A09-07"; const bool service_lost = execution->fixed_acl_variant == "A09-06"; const bool pristine = execution->fixed_acl_variant == "A14-01";
  const char* decision_state = lifecycle ? (service_lost ? "service-lost-recovered" : "host-lost-recovered") : (pristine ? "acl-pristine-recovered" : "acl-applied-recovered");
  const char* observed_code = lifecycle ? (service_lost ? "EXEC_SERVICE_LOST" : "EXEC_HOST_LOST") : (pristine ? "OBS_ACL_PRISTINE" : "OBS_ACL_RECOVERED");
  const char* descriptor = lifecycle ? (service_lost ? "service-job-termination" : "host-process-termination") : (pristine ? "pre-mutation-crash" : "post-apply-crash");
  const char* observation_class = lifecycle ? "lifecycle-crash-recovery" : "acl-crash-recovery"; const char* race_stage = lifecycle ? (service_lost ? "post-service-job-termination" : "post-host-termination") : "post-host-recovery"; const char* completion_reason = lifecycle ? (service_lost ? "service-lost-recovered" : "host-lost-recovered") : "host-crash-recovered";
  const DWORD expected_exit = lifecycle ? (service_lost ? 0xE3A6u : 0xE3A7u) : (pristine ? 0xE3A1u : 0xE3A2u); const char* expected_state = pristine ? "prepared" : "applied"; const unsigned expected_generation = pristine ? 1u : 2u; const unsigned expected_mutations = pristine ? 0u : 2u;
  if (exit_code != expected_exit || evidence.record.state != expected_state || evidence.record.generation != expected_generation || evidence.journal_writes != expected_generation || evidence.acl_mutations != expected_mutations || (lifecycle && (!evidence.lifecycle_job_closed || !evidence.active_process_zero || evidence.process_starts < 1))) return false;
  const std::string process_starts = std::to_string(lifecycle ? evidence.process_starts : 0); const std::string aggregate_output = std::to_string(lifecycle ? execution->aggregate_output_bytes.load() : 0); const bool persistent = entry->scalar == "E2" || entry->scalar == "E4";
  std::string request_digest, root_request_digest, root_access_digest, job_policy_digest, environment_names_digest, environment_values_digest, package_sid_digest, input_set_digest, acl_profile_digest, stimulus_digest, transcript_digest; const std::string acl_profile_material = evidence.record.acl_digest + "\n";
  if (!CanonicalJsonDigest("mini-lux/sec03/launcher-request/v1", launch, &request_digest) || !CanonicalJsonDigest("mini-lux/sec03/launcher-root-request/v1", *roots, &root_request_digest) || !CanonicalJsonDigest("mini-lux/sec03/launcher-root-access/v1", *roots, &root_access_digest) || !CanonicalJsonDigest("mini-lux/sec03/launcher-job-policy/v1", *limits, &job_policy_digest) || !EnvironmentDigests(*environment, &environment_names_digest, &environment_values_digest)
    || !mini_lux::sec03::Sha256(evidence.record.sid_bytes.data(), evidence.record.sid_bytes.size(), &package_sid_digest) || !mini_lux::sec03::Sha256(reinterpret_cast<const unsigned char*>(acl_profile_material.data()), acl_profile_material.size(), &acl_profile_digest) || !SequenceDigest("mini-lux/sec03/launcher-sentinel/v1", {"input-set-empty"}, &input_set_digest)) return false;
  const bool digests = lifecycle
    ? SequenceDigest("mini-lux/sec03/fixed-lifecycle-recovery-stimulus/v1", {tuple->scalar, descriptor, observed_code, request_digest, payload_digest->scalar, execution->candidate_sha256, execution->build_sha256, execution->source_sha256, execution->host_sha256, execution->launcher_sha256, execution->execution_id, context->scalar, session->scalar, run->scalar, authority->scalar, entry->scalar, profile->scalar, persona->scalar, policy->scalar, root_request_digest, execution->expected_root_identity_digest, evidence.record.state, std::to_string(evidence.record.generation), std::to_string(exit_code), acl_profile_digest, process_starts, aggregate_output}, &stimulus_digest)
      && SequenceDigest("mini-lux/sec03/fixed-lifecycle-recovery-transcript/v1", {request_digest, root_request_digest, tuple->scalar, decision_state, observed_code, evidence.record.state, std::to_string(evidence.record.generation), std::to_string(evidence.journal_writes), std::to_string(evidence.acl_mutations), execution->expected_root_identity_digest, acl_profile_digest, process_starts, aggregate_output}, &transcript_digest)
    : SequenceDigest("mini-lux/sec03/fixed-acl-recovery-stimulus/v1", {tuple->scalar, descriptor, observed_code, request_digest, payload_digest->scalar, execution->candidate_sha256, execution->build_sha256, execution->source_sha256, execution->host_sha256, execution->launcher_sha256, execution->execution_id, context->scalar, session->scalar, run->scalar, authority->scalar, entry->scalar, profile->scalar, persona->scalar, policy->scalar, root_request_digest, execution->expected_root_identity_digest, evidence.record.state, std::to_string(evidence.record.generation), std::to_string(exit_code), acl_profile_digest}, &stimulus_digest)
      && SequenceDigest("mini-lux/sec03/fixed-acl-recovery-transcript/v1", {request_digest, root_request_digest, tuple->scalar, decision_state, observed_code, evidence.record.state, std::to_string(evidence.record.generation), std::to_string(evidence.journal_writes), std::to_string(evidence.acl_mutations), execution->expected_root_identity_digest, acl_profile_digest}, &transcript_digest);
  if (!digests) return false;
  std::array<wchar_t, MAX_PATH> windows_path{}, system_volume_path{}; std::array<wchar_t, 32> system_filesystem{}; DWORD system_serial = 0; const UINT windows_count = GetWindowsDirectoryW(windows_path.data(), static_cast<UINT>(windows_path.size())); const bool system_volume = windows_count && windows_count < windows_path.size() && GetVolumePathNameW(windows_path.data(), system_volume_path.data(), static_cast<DWORD>(system_volume_path.size())) && GetVolumeInformationW(system_volume_path.data(), nullptr, 0, &system_serial, nullptr, nullptr, system_filesystem.data(), static_cast<DWORD>(system_filesystem.size())) && _wcsicmp(system_filesystem.data(), L"NTFS") == 0;
  const bool root_same_system_volume = system_volume && evidence.record.volume == system_serial; const bool root_has_space = evidence.record.root_path.find(L' ') != std::wstring::npos; const bool root_has_non_ascii = std::any_of(evidence.record.root_path.begin(), evidence.record.root_path.end(), [](wchar_t c) { return c > 0x7f; });
  std::ostringstream proof; proof << "v=1\nkind=launcher-observation\nkeyId=" << execution->attestation_key.key_id << "\ncandidate=" << execution->candidate_sha256 << "\nbuildIdSha256=" << execution->build_sha256 << "\nsourceSha256=" << execution->source_sha256 << "\nhostSha256=" << execution->host_sha256 << "\nlauncher=" << execution->launcher_sha256
    << "\nexecution=" << execution->execution_id << "\ncontext=" << context->scalar << "\nsession=" << session->scalar << "\nrun=" << run->scalar << "\nauthorityEpoch=" << authority->scalar << "\nentryPoint=" << entry->scalar << "\nprofile=" << profile->scalar << "\noperation=launch\ndecisionState=" << decision_state
    << "\npersonaDigest=" << persona->scalar << "\npolicyDigest=" << policy->scalar << "\npayloadDigest=" << payload_digest->scalar << "\nstimulusDigest=" << stimulus_digest << "\nrequestDigest=" << request_digest << "\nrootRequestDigest=" << root_request_digest
    << "\nobservationClass=" << observation_class << "\nraceStage=" << race_stage << "\nrootFailureClass=none\nexpectedRootIdentityDigest=" << execution->expected_root_identity_digest << "\nobservedRootIdentityDigest=" << execution->expected_root_identity_digest << "\nobservedCode=" << observed_code << "\nobservedSubcode=none\nhostExitCode=" << exit_code << "\nrecoveryJournalState=" << evidence.record.state << "\nrecoveryJournalGeneration=" << evidence.record.generation
    << "\ntranscriptSha256=" << transcript_digest << "\ntokenIsAppContainer=0\npackageSidSha256=" << package_sid_digest << "\ncapabilityCount=0\nlowIntegrity=0\njobConstrained=" << (lifecycle ? "1" : "0") << "\njobPolicySha256=" << job_policy_digest << "\nactiveProcessZero=1\nprocessStarts=" << process_starts << "\nprofileCreates=1\njournalWrites=" << evidence.journal_writes << "\naclMutations=" << evidence.acl_mutations
    << "\nstdinWrites=" << (lifecycle && entry->scalar == "E3" ? "1" : "0") << "\ninputDigestSetSha256=" << input_set_digest << "\nconpty=" << (lifecycle && persistent ? "1" : "0") << "\nconptyMerged=" << (lifecycle && persistent ? "1" : "0") << "\nexecutableLease=" << (lifecycle ? (entry->scalar == "E1" ? "0" : "1") : (entry->scalar == "E3" ? "1" : "0")) << "\nchildExit=none\ncompletionReason=" << completion_reason << "\naggregateOutputBytes=" << aggregate_output << "\ncleanupComplete=1\njobClosed=1\nhandlesDrained=1\nhostExited=1\ntreeTerminated=1\nrootIdentityDigest=" << execution->expected_root_identity_digest
    << "\nrootAccessProfileSha256=" << root_access_digest << "\nrootFixedNtfs=1\nrootSameSystemVolume=" << (root_same_system_volume ? "1" : "0") << "\nrootHasSpace=" << (root_has_space ? "1" : "0") << "\nrootHasNonAscii=" << (root_has_non_ascii ? "1" : "0") << "\nenvironmentNameDigest=" << environment_names_digest << "\nenvironmentValueDigest=" << environment_values_digest << "\nambientLeakCount=0\nnetworkMode=deny\nnetworkAttemptCount=0\nnetworkAcceptedCount=0\naclProfileSha256=" << acl_profile_digest << "\n";
  const std::string proof_text = proof.str(); std::map<std::string, std::string> fields; std::array<unsigned char, 32> mac{}, marker{}; std::string proof_sha256;
  if (!mini_lux::sec03::ParseCanonicalLauncherObservation(proof_text, execution->candidate_sha256, execution->build_sha256, execution->source_sha256, execution->host_sha256, execution->launcher_sha256, execution->attestation_key.key_id, &fields) || !mini_lux::sec03::HmacSha256(execution->attestation_key, reinterpret_cast<const unsigned char*>(proof_text.data()), proof_text.size(), &mac) || !mini_lux::sec03::Sha256(reinterpret_cast<const unsigned char*>(proof_text.data()), proof_text.size(), &proof_sha256)) return false;
  const std::string mac_hex = mini_lux::sec03::HexBytes(mac.data(), mac.size()); const std::string marker_payload = mini_lux::sec03::LauncherObservationMarkerPayload(fields, proof_sha256, mac_hex); if (marker_payload.empty() || !mini_lux::sec03::HmacSha256(execution->attestation_key, reinterpret_cast<const unsigned char*>(marker_payload.data()), marker_payload.size(), &marker)) return false;
  execution->native_proof.assign(proof_text.begin(), proof_text.end()); execution->native_proof_mac = mac_hex; execution->native_proof_key_id = execution->attestation_key.key_id; execution->launcher_channel_marker = mini_lux::sec03::HexBytes(marker.data(), marker.size()); execution->launcher_observation = true; execution->proof_seen = true; return true;
}

bool RecoverFixedAclReceipt(Execution* execution, DWORD exit_code) {
  const DWORD expected_exit = execution && execution->fixed_acl_variant == "A09-06" ? 0xE3A6u : execution && execution->fixed_acl_variant == "A09-07" ? 0xE3A7u : execution && execution->fixed_acl_variant == "A14-01" ? 0xE3A1u : execution && execution->fixed_acl_variant == "A14-02" ? 0xE3A2u : 0u; if (!expected_exit || exit_code != expected_exit || execution->proof_seen) return false; FixedAclRecoveryEvidence evidence;
  const bool lifecycle = execution->fixed_acl_variant == "A09-06" || execution->fixed_acl_variant == "A09-07";
  return FixedAclLaunchBinding(execution, &evidence) && (!lifecycle || CloseLifecycleJobWithEvidence(execution, &evidence)) && RecoverJournals(execution->host_sha256, execution->launcher_sha256, &evidence) && CreateFixedAclRecoveryObservation(execution, evidence, exit_code);
}

napi_value LaunchHostMode(napi_env env, napi_callback_info info, const char* fixed_acl_variant) {
  size_t argc = 2; napi_value argv[2], self; Lease* lease = GetLease(env, info, &argc, argv, &self);
  if (!lease || !ConsumeLeaseAttempt(env, lease) || argc != 2) return nullptr;
  bool is_buffer = false; napi_is_buffer(env, argv[0], &is_buffer); void* frame_data = nullptr; size_t frame_size = 0;
  napi_valuetype callback_type; napi_typeof(env, argv[1], &callback_type);
  if (!is_buffer || callback_type != napi_function || napi_get_buffer_info(env, argv[0], &frame_data, &frame_size) != napi_ok || frame_size < 5 || frame_size > kMaxFrame + 4) {
    Throw(env, "EXEC_NATIVE_PROTOCOL", "launchHost requires one bounded launch frame and output callback"); return nullptr;
  }
  std::vector<uint8_t> frame(static_cast<uint8_t*>(frame_data), static_cast<uint8_t*>(frame_data) + frame_size);
  const uint32_t declared = (static_cast<uint32_t>(frame[0]) << 24) | (static_cast<uint32_t>(frame[1]) << 16) | (static_cast<uint32_t>(frame[2]) << 8) | frame[3];
  if (declared != frame_size - 4) { Throw(env, "EXEC_NATIVE_PROTOCOL", "Launch frame length is invalid"); return nullptr; }
  std::string json(reinterpret_cast<char*>(frame.data() + 4), frame.size() - 4);
  Json parsed; if (!Parser(json).Parse(&parsed) || parsed.kind != Json::Kind::object) { Throw(env, "EXEC_NATIVE_PROTOCOL", "Launch frame JSON is invalid"); return nullptr; }
  const Json* requested_type = Field(parsed, "type", Json::Kind::string);
  const bool fixed_adversary = requested_type && requested_type->scalar == "fixed-adversary";
  if (fixed_adversary) {
    std::string fixed_json;
    if (!BuildFixedAdversaryRequest(parsed, *lease, &fixed_json)) { Throw(env, "EXEC_NATIVE_PROTOCOL", "Fixed adversary request is invalid"); return nullptr; }
    Json fixed_parsed;
    if (!Parser(fixed_json).Parse(&fixed_parsed) || fixed_parsed.kind != Json::Kind::object) { Throw(env, "EXEC_NATIVE_PROTOCOL", "Generated fixed adversary request is invalid"); return nullptr; }
    parsed = std::move(fixed_parsed); json = std::move(fixed_json);
  } else if (fixed_acl_variant) {
    const Json* entry = Field(parsed, "entryPoint", Json::Kind::string); const Json* profile = Field(parsed, "profile", Json::Kind::string); const Json* fixed_roots = Field(parsed, "roots", Json::Kind::array);
    const std::map<std::string, std::string> profiles = {{"E1","one-shot-shell"},{"E2","agent-shell"},{"E3","script"},{"E4","manual-terminal"}}; const auto expected = entry ? profiles.find(entry->scalar) : profiles.end();
    if (!requested_type || requested_type->scalar != "launch" || !entry || !profile || expected == profiles.end() || profile->scalar != expected->second || !fixed_roots || fixed_roots->array.size() != 1 || parsed.object.count("fixedAdversary") || parsed.object.count("fixedStateMac") || json.empty() || json.back() != '}') { Throw(env, "EXEC_NATIVE_PROTOCOL", "Fixed ACL receipt request is invalid"); return nullptr; }
    json.insert(json.size() - 1, ",\"fixedAdversary\":\"" + std::string(fixed_acl_variant) + "/" + entry->scalar + "\",\"fixedStateMac\":\"" + std::string(64, '0') + "\""); Json conflict_parsed;
    if (!Parser(json).Parse(&conflict_parsed) || conflict_parsed.kind != Json::Kind::object) { Throw(env, "EXEC_NATIVE_PROTOCOL", "Generated fixed ACL conflict request is invalid"); return nullptr; }
    parsed = std::move(conflict_parsed);
  }
  const Json* candidate_identity = Field(parsed, "candidateId", Json::Kind::string); const Json* build_identity = Field(parsed, "buildIdSha256", Json::Kind::string); const Json* source_identity = Field(parsed, "sourceSha256", Json::Kind::string); const Json* host_slot = Field(parsed, "hostSha256", Json::Kind::string); const Json* launcher_slot = Field(parsed, "launcherSha256", Json::Kind::string);
  if (!candidate_identity || !build_identity || !source_identity || !host_slot || !launcher_slot || !mini_lux::sec03::CanonicalHex(candidate_identity->scalar, 32, 32) || !mini_lux::sec03::CanonicalHex(build_identity->scalar, 32, 32) || !mini_lux::sec03::CanonicalHex(source_identity->scalar, 32, 32) || host_slot->scalar != std::string(64, '0') || launcher_slot->scalar != std::string(64, '0')) { Throw(env, "EXEC_NATIVE_PROTOCOL", "Launch frame candidate identity is invalid"); return nullptr; }
  const std::string candidate_sha256 = candidate_identity->scalar, build_sha256 = build_identity->scalar, source_sha256 = source_identity->scalar;
  std::vector<TrustedRootHandle> root_handles; std::string root_handles_json; RootFailureClass root_failure_class = RootFailureClass::none; RootObservationDigests root_identity_digests;
  const RootOpenResult roots_result = OpenTrustedRoots(parsed, &root_handles, &root_handles_json, &root_failure_class, &root_identity_digests);
  if (roots_result != RootOpenResult::trusted) {
    root_handles.clear(); root_handles_json.clear();
    if (roots_result == RootOpenResult::unsupported || roots_result == RootOpenResult::identity_changed) {
      const LauncherObservationOutcome outcome = roots_result == RootOpenResult::identity_changed ? LauncherObservationOutcome::root_identity_changed : LauncherObservationOutcome::unsupported_root; LauncherObservation observation;
      if (!CreateRootObservation(parsed, outcome, root_failure_class, root_identity_digests, candidate_sha256, build_sha256, source_sha256, lease->sha256, lease->launcher_sha256, &observation) || !ThrowRootObservation(env, outcome, observation)) Throw(env, "EXEC_NATIVE_EVIDENCE_UNAVAILABLE", "Native launcher observation is unavailable");
    } else {
      Throw(env, "EXEC_ROOT_UNSUPPORTED", "Root identity or local NTFS policy mismatch");
    }
    return nullptr;
  }
  const Json* entry_point = Field(parsed, "entryPoint", Json::Kind::string); TrustedRootHandle executable_handle; std::string executable_sha256; const bool has_executable = entry_point && entry_point->scalar == "E3";
  if (has_executable && !OpenCurrentExecutable(&executable_handle, &executable_sha256)) { Throw(env, "EXEC_NATIVE_IDENTITY_INVALID", "Current script executable lease is invalid"); return nullptr; }
  if (json.empty() || json.back() != '}') { Throw(env, "EXEC_NATIVE_PROTOCOL", "Launch frame body is invalid"); return nullptr; }
  json.insert(json.size() - 1, ",\"rootHandles\":" + root_handles_json + ",\"executableHandle\":" + (has_executable ? (std::string("{\"fileId\":\"") + std::to_string(FileId(executable_handle.identity)) + "\",\"handleValue\":\"" + std::to_string(reinterpret_cast<uintptr_t>(executable_handle.handle)) + "\",\"sha256\":\"" + executable_sha256 + "\",\"volumeSerial\":\"" + std::to_string(executable_handle.identity.dwVolumeSerialNumber) + "\"}") : "null"));
  const std::string host_placeholder = "\"hostSha256\":\"0000000000000000000000000000000000000000000000000000000000000000\"";
  const auto host_position = json.find(host_placeholder); if (host_position == std::string::npos || json.find(host_placeholder, host_position + 1) != std::string::npos) { Throw(env, "EXEC_NATIVE_PROTOCOL", "Launch frame lacks host identity slot"); return nullptr; }
  json.replace(host_position + 14, 64, lease->sha256);
  const std::string launcher_placeholder = "\"launcherSha256\":\"0000000000000000000000000000000000000000000000000000000000000000\""; const auto launcher_position = json.find(launcher_placeholder); if (launcher_position == std::string::npos || json.find(launcher_placeholder, launcher_position + 1) != std::string::npos) { Throw(env, "EXEC_NATIVE_PROTOCOL", "Launch frame lacks launcher identity slot"); return nullptr; } json.replace(launcher_position + 18, 64, lease->launcher_sha256);
#ifdef MINI_LUX_SEC03_NATIVE_TEST
  std::array<char, 64> crash{}; const DWORD crash_count = GetEnvironmentVariableA("MINI_LUX_SEC03_NATIVE_TEST_CRASH", crash.data(), static_cast<DWORD>(crash.size())); std::string crash_value = crash_count && crash_count < crash.size() ? std::string(crash.data(), crash_count) : "none"; if (crash_value != "none" && crash_value != "prepared" && crash_value != "applied" && crash_value != "job-zero" && crash_value != "hold-applied" && crash_value != "descendant-applied" && crash_value != "barrier-prepared-hold-applied" && crash_value != "force-active-process-proof-failure" && crash_value != "journal-delete-newest") { Throw(env, "EXEC_NATIVE_PROTOCOL", "Native test crash marker is invalid"); return nullptr; } json.insert(json.size() - 1, ",\"testCrash\":\"" + crash_value + "\"");
#endif
  const std::string placeholder = "\"secret\":\"0000000000000000000000000000000000000000000000000000000000000000\"";
  const auto secret_position = json.find(placeholder);
  if (secret_position == std::string::npos || json.find(placeholder, secret_position + 1) != std::string::npos) { Throw(env, "EXEC_NATIVE_PROTOCOL", "Launch frame lacks the one-use secret slot"); return nullptr; }
  std::array<uint8_t, 32> random{};
  if (BCryptGenRandom(nullptr, random.data(), static_cast<ULONG>(random.size()), BCRYPT_USE_SYSTEM_PREFERRED_RNG) < 0) { Throw(env, "EXEC_NATIVE_UNAVAILABLE", "Cannot create launch secret"); return nullptr; }
  const std::string secret = Hex(random.data(), random.size());
  json.replace(secret_position + 10, 64, secret);
  if (fixed_adversary || fixed_acl_variant) {
    const Json* tuple = Field(parsed, "fixedAdversary", Json::Kind::string); const Json* execution = Field(parsed, "executionId", Json::Kind::string); const Json* run = Field(parsed, "runId", Json::Kind::string);
    std::string binding; mini_lux::sec03::AttestationKey state_key; std::array<unsigned char, 32> state_mac{};
    const std::string state_placeholder = "\"fixedStateMac\":\"" + std::string(64, '0') + "\""; const auto state_position = json.find(state_placeholder);
    if (!tuple || !execution || !run || state_position == std::string::npos || json.find(state_placeholder, state_position + 1) != std::string::npos
      || !mini_lux::sec03::AttestationBindingDigest(candidate_sha256, build_sha256, source_sha256, lease->sha256, lease->launcher_sha256, &binding)
      || !mini_lux::sec03::LoadAttestationKey(binding, lease->launcher_sha256, &state_key)) { Throw(env, "EXEC_NATIVE_EVIDENCE_UNAVAILABLE", "Fixed adversary launcher state is unavailable"); return nullptr; }
    const std::string material = mini_lux::sec03::FixedAdversaryStateMaterial(tuple->scalar, secret, candidate_sha256, build_sha256, source_sha256, lease->sha256, lease->launcher_sha256, execution->scalar, run->scalar);
    if (!mini_lux::sec03::HmacSha256(state_key, reinterpret_cast<const unsigned char*>(material.data()), material.size(), &state_mac)) { Throw(env, "EXEC_NATIVE_EVIDENCE_UNAVAILABLE", "Fixed adversary launcher state is unavailable"); return nullptr; }
    json.replace(state_position + 17, 64, Hex(state_mac.data(), state_mac.size()));
  }
  Json trusted_launch_request; const bool fixed_acl_crash = fixed_acl_variant && (std::string(fixed_acl_variant) == "A14-01" || std::string(fixed_acl_variant) == "A14-02"); const bool fixed_lifecycle_crash = fixed_acl_variant && (std::string(fixed_acl_variant) == "A09-06" || std::string(fixed_acl_variant) == "A09-07"); const bool fixed_recovery_crash = fixed_acl_crash || fixed_lifecycle_crash;
  if (fixed_recovery_crash && (!Parser(json).Parse(&trusted_launch_request) || trusted_launch_request.kind != Json::Kind::object || root_identity_digests.expected.empty())) { Throw(env, "EXEC_NATIVE_PROTOCOL", "Fixed recovery trusted launch request is invalid"); return nullptr; }
  if (json.size() > kMaxFrame) { Throw(env, "EXEC_NATIVE_PROTOCOL", "Patched launch frame exceeds its bound"); return nullptr; }
  frame.resize(json.size() + 4); const uint32_t patched_size = static_cast<uint32_t>(json.size());
  frame[0] = static_cast<uint8_t>(patched_size >> 24); frame[1] = static_cast<uint8_t>(patched_size >> 16); frame[2] = static_cast<uint8_t>(patched_size >> 8); frame[3] = static_cast<uint8_t>(patched_size);
  memcpy(frame.data() + 4, json.data(), json.size());
  const std::string execution_id = ExtractExecutionId(json);
  if (execution_id.empty()) { Throw(env, "EXEC_NATIVE_PROTOCOL", "Launch frame lacks executionId"); return nullptr; }

  SECURITY_ATTRIBUTES attributes{sizeof(attributes), nullptr, TRUE};
  HANDLE control_read = nullptr, control_write = nullptr, event_read = nullptr, event_write = nullptr;
  if (!CreatePipe(&control_read, &control_write, &attributes, 0) || !CreatePipe(&event_read, &event_write, &attributes, 0)) {
    if (control_read) CloseHandle(control_read); if (control_write) CloseHandle(control_write); if (event_read) CloseHandle(event_read); if (event_write) CloseHandle(event_write);
    Throw(env, "EXEC_NATIVE_UNAVAILABLE", "Cannot create private host pipes"); return nullptr;
  }
  SetHandleInformation(control_write, HANDLE_FLAG_INHERIT, 0); SetHandleInformation(event_read, HANDLE_FLAG_INHERIT, 0);

  STARTUPINFOEXW startup{}; startup.StartupInfo.cb = sizeof(startup); startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
  startup.StartupInfo.hStdInput = control_read; startup.StartupInfo.hStdOutput = event_write; startup.StartupInfo.hStdError = event_write;
  SIZE_T list_bytes = 0; InitializeProcThreadAttributeList(nullptr, 1, 0, &list_bytes);
  std::vector<uint8_t> list_storage(list_bytes); startup.lpAttributeList = reinterpret_cast<PPROC_THREAD_ATTRIBUTE_LIST>(list_storage.data());
  std::vector<HANDLE> inherited = {control_read, event_write};
  for (const auto& root : root_handles) { inherited.push_back(root.handle); inherited.push_back(root.cwd_handle); }
  if (has_executable) inherited.push_back(executable_handle.handle);
  if (!InitializeProcThreadAttributeList(startup.lpAttributeList, 1, 0, &list_bytes) || !UpdateProcThreadAttribute(startup.lpAttributeList, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, inherited.data(), inherited.size() * sizeof(HANDLE), nullptr, nullptr)) {
    CloseHandle(control_read); CloseHandle(control_write); CloseHandle(event_read); CloseHandle(event_write); Throw(env, "EXEC_NATIVE_UNAVAILABLE", "Cannot build host handle list"); return nullptr;
  }
  PROCESS_INFORMATION process{}; std::wstring command = L"\"" + lease->path + L"\"";
  const BOOL created = CreateProcessW(lease->path.c_str(), command.data(), nullptr, nullptr, TRUE, EXTENDED_STARTUPINFO_PRESENT | CREATE_NO_WINDOW, nullptr, nullptr, &startup.StartupInfo, &process);
  DeleteProcThreadAttributeList(startup.lpAttributeList); CloseHandle(control_read); CloseHandle(event_write);
  if (!created) { CloseHandle(control_write); CloseHandle(event_read); Throw(env, "EXEC_NATIVE_UNAVAILABLE", "Fixed sandbox host launch failed"); return nullptr; }
  CloseHandle(process.hThread);
  if (!SameIdentity(*lease, process.dwProcessId)) {
    TerminateProcess(process.hProcess, 0xE003); CloseHandle(process.hProcess); CloseHandle(control_write); CloseHandle(event_read); Throw(env, "EXEC_NATIVE_IDENTITY_INVALID", "Launched host identity differs from exclusive lease"); return nullptr;
  }
  FILETIME host_created_time{}, host_exited_time{}, host_kernel_time{}, host_user_time{}; const bool host_time_valid = GetProcessTimes(process.hProcess, &host_created_time, &host_exited_time, &host_kernel_time, &host_user_time) != FALSE; const std::uint64_t host_created = host_time_valid ? mini_lux::sec03::FileTimeValue(host_created_time) : 0;
  if (fixed_recovery_crash && !host_created) { TerminateProcess(process.hProcess, 0xE003); CloseHandle(process.hProcess); CloseHandle(control_write); CloseHandle(event_read); Throw(env, "EXEC_NATIVE_IDENTITY_INVALID", "Launched host creation identity is unavailable"); return nullptr; }
  HANDLE lifecycle_job = nullptr;
  if (fixed_lifecycle_crash) {
    lifecycle_job = CreateJobObjectW(nullptr, nullptr); JOBOBJECT_EXTENDED_LIMIT_INFORMATION lifetime{}; lifetime.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if (!lifecycle_job || !SetInformationJobObject(lifecycle_job, JobObjectExtendedLimitInformation, &lifetime, sizeof(lifetime)) || !AssignProcessToJobObject(lifecycle_job, process.hProcess)) {
      if (lifecycle_job) CloseHandle(lifecycle_job); TerminateProcess(process.hProcess, 0xE003); CloseHandle(process.hProcess); CloseHandle(control_write); CloseHandle(event_read); Throw(env, "EXEC_NATIVE_PRIMITIVE_UNAVAILABLE", "Lifecycle crash containment Job is unavailable"); return nullptr;
    }
  }
  if (!WriteExact(control_write, frame.data(), static_cast<DWORD>(frame.size()))) {
    TerminateProcess(process.hProcess, 0xE003); if (lifecycle_job) CloseHandle(lifecycle_job); CloseHandle(process.hProcess); CloseHandle(control_write); CloseHandle(event_read); Throw(env, "EXEC_NATIVE_IO", "Cannot authenticate fixed host"); return nullptr;
  }

  auto execution = std::make_unique<Execution>(); execution->process = process.hProcess; execution->control = control_write; execution->events = event_read; execution->lifecycle_job = lifecycle_job; execution->pid = process.dwProcessId; execution->host_created = host_created; execution->execution_id = execution_id; execution->candidate_sha256 = candidate_sha256; execution->build_sha256 = build_sha256; execution->source_sha256 = source_sha256; execution->host_sha256 = lease->sha256; execution->launcher_sha256 = lease->launcher_sha256; execution->control_secret = secret; execution->env = env;
  if (fixed_recovery_crash) { execution->launch_request = std::move(trusted_launch_request); execution->fixed_acl_variant = fixed_acl_variant; execution->expected_root_identity_digest = root_identity_digests.expected; }
  std::string attestation_binding; if (mini_lux::sec03::AttestationBindingDigest(candidate_sha256, build_sha256, source_sha256, lease->sha256, lease->launcher_sha256, &attestation_binding)) mini_lux::sec03::LoadAttestationKey(attestation_binding, lease->launcher_sha256, &execution->attestation_key);
  napi_value promise; napi_create_promise(env, &execution->completion, &promise);
  napi_value resource_name; napi_create_string_utf8(env, "mini-lux-sec03-host", NAPI_AUTO_LENGTH, &resource_name);
  if (napi_create_threadsafe_function(env, argv[1], nullptr, resource_name, 0, 1, nullptr, nullptr, nullptr, CallJs, &execution->tsfn) != napi_ok) {
    TerminateProcess(process.hProcess, 0xE003); if (execution->lifecycle_job) { CloseHandle(execution->lifecycle_job); execution->lifecycle_job = nullptr; } CloseHandle(process.hProcess); CloseHandle(control_write); CloseHandle(event_read); Throw(env, "EXEC_NATIVE_ABI_ERROR", "Cannot create host event dispatcher"); return nullptr;
  }
  napi_value object, value, fn; napi_create_object(env, &object);
  napi_create_string_utf8(env, execution_id.c_str(), NAPI_AUTO_LENGTH, &value); napi_set_named_property(env, object, "executionId", value);
  napi_set_named_property(env, object, "completed", promise);
  napi_create_function(env, "writeFrame", NAPI_AUTO_LENGTH, WriteFrame, nullptr, &fn); napi_set_named_property(env, object, "writeFrame", fn);
  napi_create_function(env, "terminateHost", NAPI_AUTO_LENGTH, TerminateHost, nullptr, &fn); napi_set_named_property(env, object, "terminateHost", fn);
  napi_create_function(env, "closeControlChannel", NAPI_AUTO_LENGTH, CloseControlChannel, nullptr, &fn); napi_set_named_property(env, object, "closeControlChannel", fn);
  napi_create_function(env, "probeFixedHostProtocol", NAPI_AUTO_LENGTH, ProbeFixedHostProtocol, nullptr, &fn); napi_set_named_property(env, object, "probeFixedHostProtocol", fn);
  if (fixed_lifecycle_crash) { napi_create_function(env, "triggerLifecycleCrashForReceipt", NAPI_AUTO_LENGTH, TriggerLifecycleCrashForReceipt, nullptr, &fn); napi_set_named_property(env, object, "triggerLifecycleCrashForReceipt", fn); }
#ifdef MINI_LUX_SEC03_NATIVE_TEST
  napi_create_function(env, "crashHostForTest", NAPI_AUTO_LENGTH, CrashHostForTest, nullptr, &fn); napi_set_named_property(env, object, "crashHostForTest", fn);
#endif
  if (napi_create_reference(env, object, 1, &execution->self_reference) != napi_ok || napi_wrap(env, object, execution.get(), FinalizeExecution, nullptr, nullptr) != napi_ok) {
    if (execution->self_reference) { napi_delete_reference(env, execution->self_reference); execution->self_reference = nullptr; }
    TerminateProcess(process.hProcess, 0xE003); napi_release_threadsafe_function(execution->tsfn, napi_tsfn_abort); CloseHandle(execution->process); CloseHandle(execution->control); CloseHandle(execution->events); if (execution->lifecycle_job) CloseHandle(execution->lifecycle_job); execution->process = nullptr; execution->control = nullptr; execution->events = nullptr; execution->lifecycle_job = nullptr; Throw(env, "EXEC_NATIVE_ABI_ERROR", "Cannot retain host execution lifetime"); return nullptr;
  }
  execution->reader = std::thread(ReaderMain, execution.get());
  execution.release(); return object;
}

napi_value LaunchHost(napi_env env, napi_callback_info info) { return LaunchHostMode(env, info, nullptr); }
napi_value LaunchServiceCrashForReceipt(napi_env env, napi_callback_info info) { return LaunchHostMode(env, info, "A09-06"); }
napi_value LaunchHostCrashForReceipt(napi_env env, napi_callback_info info) { return LaunchHostMode(env, info, "A09-07"); }
napi_value LaunchAclPristineCrashForReceipt(napi_env env, napi_callback_info info) { return LaunchHostMode(env, info, "A14-01"); }
napi_value LaunchAclAppliedCrashForReceipt(napi_env env, napi_callback_info info) { return LaunchHostMode(env, info, "A14-02"); }
napi_value LaunchAclConflictForReceipt(napi_env env, napi_callback_info info) { return LaunchHostMode(env, info, "A14-05"); }

bool CreateBrokerObservation(const Json& request, const std::string& wire, const Lease& lease, LauncherObservation* output) {
  if (!output || !ExactKeys(request, {"authorityEpoch","buildIdSha256","candidateId","contextId","entryPoint","executionId","observation","personaDigest","policyDigest","profile","runId","sessionId","sourceSha256","type","v"})) return false;
  const Json* version = Field(request, "v", Json::Kind::number); const Json* type = Field(request, "type", Json::Kind::string); const Json* candidate = Field(request, "candidateId", Json::Kind::string); const Json* build = Field(request, "buildIdSha256", Json::Kind::string); const Json* source = Field(request, "sourceSha256", Json::Kind::string);
  const Json* execution = Field(request, "executionId", Json::Kind::string); const Json* context = Field(request, "contextId", Json::Kind::string); const Json* session = Field(request, "sessionId", Json::Kind::string); const Json* run = Field(request, "runId", Json::Kind::string); const Json* authority = Field(request, "authorityEpoch", Json::Kind::number);
  const Json* entry = Field(request, "entryPoint", Json::Kind::string); const Json* profile = Field(request, "profile", Json::Kind::string); const Json* persona = Field(request, "personaDigest", Json::Kind::string); const Json* policy = Field(request, "policyDigest", Json::Kind::string); const Json* observation = Field(request, "observation", Json::Kind::object);
  if (!version || version->scalar != "1" || !type || type->scalar != "broker-observation" || !candidate || !build || !source || !execution || !context || !session || !run || !authority || !entry || !profile || !persona || !policy || !observation
    || !ExactKeys(*observation, {"attemptCount","authorityDigest","code","destinationSetDigest","dnsResolutionCount","operationDigest","operationIdDigest","operationsDigest","redirectCount","requestBytes","responseBodySha256","responseBytes","responseHeadersDigest","statusCode"})) return false;
  const Json* code = Field(*observation, "code", Json::Kind::string); const Json* authority_digest = Field(*observation, "authorityDigest", Json::Kind::string); const Json* operations_digest = Field(*observation, "operationsDigest", Json::Kind::string); const Json* operation_id_digest = Field(*observation, "operationIdDigest", Json::Kind::string); const Json* operation_digest = Field(*observation, "operationDigest", Json::Kind::string); const Json* destination_digest = Field(*observation, "destinationSetDigest", Json::Kind::string); const Json* headers_digest = Field(*observation, "responseHeadersDigest", Json::Kind::string); const Json* body_digest = Field(*observation, "responseBodySha256", Json::Kind::string);
  const Json* attempts_json = Field(*observation, "attemptCount", Json::Kind::number); const Json* dns_json = Field(*observation, "dnsResolutionCount", Json::Kind::number); const Json* redirects_json = Field(*observation, "redirectCount", Json::Kind::number); const Json* request_bytes_json = Field(*observation, "requestBytes", Json::Kind::number); const Json* response_bytes_json = Field(*observation, "responseBytes", Json::Kind::number); const auto status_found = observation->object.find("statusCode");
  const bool code_valid = code && (code->scalar == "OBS_BROKER_ALLOWED" || code->scalar == "EXEC_BROKER_SCHEME_DENIED" || code->scalar == "EXEC_BROKER_HOST_DENIED" || code->scalar == "EXEC_BROKER_PORT_DENIED" || code->scalar == "EXEC_BROKER_PRIVATE_ADDRESS_DENIED" || code->scalar == "EXEC_BROKER_DNS_REBIND_DENIED" || code->scalar == "EXEC_BROKER_REDIRECT_DENIED" || code->scalar == "EXEC_BROKER_REQUEST_LIMIT" || code->scalar == "EXEC_BROKER_RESPONSE_LIMIT" || code->scalar == "EXEC_BROKER_TIMEOUT");
  const bool profile_pair = entry && profile && ((entry->scalar == "E1" && profile->scalar == "one-shot-shell") || (entry->scalar == "E2" && profile->scalar == "agent-shell") || (entry->scalar == "E3" && profile->scalar == "script"));
  std::uint64_t authority_epoch = 0, attempts = 0, dns = 0, redirects = 0, request_bytes = 0, response_bytes = 0, status = 0;
  const bool status_none = status_found != observation->object.end() && status_found->second.kind == Json::Kind::null_value; const Json* status_json = status_none ? nullptr : Field(*observation, "statusCode", Json::Kind::number);
  if (!code_valid || !profile_pair || !mini_lux::sec03::CanonicalHex(candidate->scalar, 32, 32) || !mini_lux::sec03::CanonicalHex(build->scalar, 32, 32) || !mini_lux::sec03::CanonicalHex(source->scalar, 32, 32)
    || !mini_lux::sec03::LauncherObservationId(execution->scalar) || !mini_lux::sec03::LauncherObservationId(context->scalar) || !mini_lux::sec03::LauncherObservationId(session->scalar) || !mini_lux::sec03::LauncherObservationId(run->scalar)
    || !mini_lux::sec03::CanonicalHex(persona->scalar, 32, 32) || !mini_lux::sec03::CanonicalHex(policy->scalar, 32, 32)
    || !authority_digest || !operations_digest || !operation_id_digest || !operation_digest || !destination_digest || !headers_digest || !body_digest
    || !mini_lux::sec03::CanonicalHex(authority_digest->scalar, 32, 32) || !mini_lux::sec03::CanonicalHex(operations_digest->scalar, 32, 32) || !mini_lux::sec03::CanonicalHex(operation_id_digest->scalar, 32, 32) || !mini_lux::sec03::CanonicalHex(operation_digest->scalar, 32, 32) || !mini_lux::sec03::CanonicalHex(destination_digest->scalar, 32, 32) || !mini_lux::sec03::CanonicalHex(headers_digest->scalar, 32, 32) || !mini_lux::sec03::CanonicalHex(body_digest->scalar, 32, 32)
    || !attempts_json || !dns_json || !redirects_json || !request_bytes_json || !response_bytes_json || !mini_lux::sec03::Decimal(authority->scalar, &authority_epoch) || !authority_epoch || authority->scalar != std::to_string(authority_epoch)
    || !mini_lux::sec03::Decimal(attempts_json->scalar, &attempts) || attempts > 9 || attempts_json->scalar != std::to_string(attempts) || !mini_lux::sec03::Decimal(dns_json->scalar, &dns) || dns > 18 || dns_json->scalar != std::to_string(dns)
    || !mini_lux::sec03::Decimal(redirects_json->scalar, &redirects) || redirects > 8 || redirects_json->scalar != std::to_string(redirects) || !mini_lux::sec03::Decimal(request_bytes_json->scalar, &request_bytes) || request_bytes > 75497472 || request_bytes_json->scalar != std::to_string(request_bytes)
    || !mini_lux::sec03::Decimal(response_bytes_json->scalar, &response_bytes) || response_bytes > 67108864 || response_bytes_json->scalar != std::to_string(response_bytes)
    || (!status_none && (!status_json || !mini_lux::sec03::Decimal(status_json->scalar, &status) || status < 100 || status > 599 || status_json->scalar != std::to_string(status)))) return false;
  const bool allowed = code->scalar == "OBS_BROKER_ALLOWED";
  if ((allowed && (!attempts || dns != attempts * 2 || status_none)) || redirects > attempts || (code->scalar == "EXEC_BROKER_SCHEME_DENIED" && (attempts || dns || redirects || !status_none)) || (code->scalar == "EXEC_BROKER_HOST_DENIED" && (attempts || dns || redirects || !status_none)) || (code->scalar == "EXEC_BROKER_PORT_DENIED" && (attempts || dns || redirects || !status_none)) || (code->scalar == "EXEC_BROKER_REQUEST_LIMIT" && (attempts || dns || redirects || !status_none)) || (code->scalar == "EXEC_BROKER_PRIVATE_ADDRESS_DENIED" && (attempts || dns != 1 || redirects || !status_none)) || (code->scalar == "EXEC_BROKER_DNS_REBIND_DENIED" && (attempts || dns != 2 || redirects || !status_none)) || (code->scalar == "EXEC_BROKER_REDIRECT_DENIED" && (!attempts || dns != attempts * 2 || status_none)) || (code->scalar == "EXEC_BROKER_RESPONSE_LIMIT" && (!attempts || dns != attempts * 2 || status_none))) return false;
  const std::string status_text = status_none ? "none" : std::to_string(status);
  std::ostringstream canonical; canonical << "{\"v\":1,\"type\":\"broker-observation\",\"candidateId\":" << JsonQuoted(candidate->scalar) << ",\"buildIdSha256\":" << JsonQuoted(build->scalar) << ",\"sourceSha256\":" << JsonQuoted(source->scalar) << ",\"executionId\":" << JsonQuoted(execution->scalar) << ",\"contextId\":" << JsonQuoted(context->scalar) << ",\"sessionId\":" << JsonQuoted(session->scalar) << ",\"runId\":" << JsonQuoted(run->scalar) << ",\"authorityEpoch\":" << authority->scalar << ",\"entryPoint\":" << JsonQuoted(entry->scalar) << ",\"profile\":" << JsonQuoted(profile->scalar) << ",\"personaDigest\":" << JsonQuoted(persona->scalar) << ",\"policyDigest\":" << JsonQuoted(policy->scalar) << ",\"observation\":{\"code\":" << JsonQuoted(code->scalar) << ",\"authorityDigest\":" << JsonQuoted(authority_digest->scalar) << ",\"operationsDigest\":" << JsonQuoted(operations_digest->scalar) << ",\"operationIdDigest\":" << JsonQuoted(operation_id_digest->scalar) << ",\"operationDigest\":" << JsonQuoted(operation_digest->scalar) << ",\"attemptCount\":" << attempts << ",\"dnsResolutionCount\":" << dns << ",\"redirectCount\":" << redirects << ",\"requestBytes\":" << request_bytes << ",\"responseBytes\":" << response_bytes << ",\"destinationSetDigest\":" << JsonQuoted(destination_digest->scalar) << ",\"responseHeadersDigest\":" << JsonQuoted(headers_digest->scalar) << ",\"responseBodySha256\":" << JsonQuoted(body_digest->scalar) << ",\"statusCode\":" << (status_none ? "null" : std::to_string(status)) << "}}";
  if (canonical.str() != wire) return false;
  std::string stimulus_digest, transcript_digest;
  if (!SequenceDigest("mini-lux/sec03/broker-observation-stimulus/v1", {code->scalar, candidate->scalar, build->scalar, source->scalar, lease.sha256, lease.launcher_sha256, execution->scalar, context->scalar, session->scalar, run->scalar, authority->scalar, entry->scalar, profile->scalar, persona->scalar, policy->scalar, authority_digest->scalar, operations_digest->scalar, operation_id_digest->scalar, operation_digest->scalar, destination_digest->scalar, headers_digest->scalar, body_digest->scalar, attempts_json->scalar, dns_json->scalar, redirects_json->scalar, request_bytes_json->scalar, response_bytes_json->scalar, status_text, allowed ? "1" : "0"}, &stimulus_digest)
    || !SequenceDigest("mini-lux/sec03/broker-observation-transcript/v1", {stimulus_digest, code->scalar, authority_digest->scalar, operations_digest->scalar, operation_id_digest->scalar, operation_digest->scalar, destination_digest->scalar, headers_digest->scalar, body_digest->scalar, attempts_json->scalar, dns_json->scalar, redirects_json->scalar, request_bytes_json->scalar, response_bytes_json->scalar, status_text, allowed ? "1" : "0"}, &transcript_digest)) return false;
  std::string binding; mini_lux::sec03::AttestationKey key;
  if (!mini_lux::sec03::AttestationBindingDigest(candidate->scalar, build->scalar, source->scalar, lease.sha256, lease.launcher_sha256, &binding) || !mini_lux::sec03::ProvisionAttestationKey(binding, lease.launcher_sha256, &key)) return false;
  std::ostringstream proof; proof << "v=1\nkind=launcher-observation\nkeyId=" << key.key_id << "\ncandidate=" << candidate->scalar << "\nbuildIdSha256=" << build->scalar << "\nsourceSha256=" << source->scalar << "\nhostSha256=" << lease.sha256 << "\nlauncher=" << lease.launcher_sha256
    << "\nexecution=" << execution->scalar << "\ncontext=" << context->scalar << "\nsession=" << session->scalar << "\nrun=" << run->scalar << "\nauthorityEpoch=" << authority->scalar << "\nentryPoint=" << entry->scalar << "\nprofile=" << profile->scalar << "\noperation=broker\ndecisionState=" << code->scalar
    << "\npersonaDigest=" << persona->scalar << "\npolicyDigest=" << policy->scalar << "\npayloadDigest=" << authority_digest->scalar << "\nstimulusDigest=" << stimulus_digest << "\nrequestDigest=" << operations_digest->scalar << "\nrootRequestDigest=" << operation_id_digest->scalar
    << "\nobservationClass=broker-observation\nraceStage=trusted-network-broker\nrootFailureClass=none\nexpectedRootIdentityDigest=" << operation_digest->scalar << "\nobservedRootIdentityDigest=" << operation_digest->scalar << "\nobservedCode=" << code->scalar << "\nobservedSubcode=none\nhostExitCode=" << status_text << "\nrecoveryJournalState=none\nrecoveryJournalGeneration=0\ntranscriptSha256=" << transcript_digest
    << "\ntokenIsAppContainer=0\npackageSidSha256=" << destination_digest->scalar << "\ncapabilityCount=0\nlowIntegrity=0\njobConstrained=0\njobPolicySha256=" << headers_digest->scalar << "\nactiveProcessZero=0\nprocessStarts=0\nprofileCreates=0\njournalWrites=" << dns << "\naclMutations=" << redirects << "\nstdinWrites=" << request_bytes << "\ninputDigestSetSha256=" << body_digest->scalar
    << "\nconpty=0\nconptyMerged=0\nexecutableLease=0\nchildExit=none\ncompletionReason=" << (allowed ? "broker-completed" : "broker-denied") << "\naggregateOutputBytes=" << response_bytes << "\ncleanupComplete=1\njobClosed=1\nhandlesDrained=1\nhostExited=1\ntreeTerminated=1\nrootIdentityDigest=" << operation_digest->scalar << "\nrootAccessProfileSha256=" << operations_digest->scalar << "\nrootFixedNtfs=0\nrootSameSystemVolume=0\nrootHasSpace=0\nrootHasNonAscii=0\nenvironmentNameDigest=" << authority_digest->scalar << "\nenvironmentValueDigest=" << operation_id_digest->scalar << "\nambientLeakCount=0\nnetworkMode=brokered\nnetworkAttemptCount=" << attempts << "\nnetworkAcceptedCount=" << (allowed ? 1 : 0) << "\naclProfileSha256=" << operation_digest->scalar << "\n";
  const std::string proof_text = proof.str(); std::map<std::string, std::string> fields; std::array<unsigned char, 32> mac{}, marker{}; std::string proof_sha256;
  if (!mini_lux::sec03::ParseCanonicalLauncherObservation(proof_text, candidate->scalar, build->scalar, source->scalar, lease.sha256, lease.launcher_sha256, key.key_id, &fields) || !mini_lux::sec03::HmacSha256(key, reinterpret_cast<const unsigned char*>(proof_text.data()), proof_text.size(), &mac) || !mini_lux::sec03::Sha256(reinterpret_cast<const unsigned char*>(proof_text.data()), proof_text.size(), &proof_sha256)) return false;
  output->mac = mini_lux::sec03::HexBytes(mac.data(), mac.size()); const std::string marker_payload = mini_lux::sec03::LauncherObservationMarkerPayload(fields, proof_sha256, output->mac);
  if (marker_payload.empty() || !mini_lux::sec03::HmacSha256(key, reinterpret_cast<const unsigned char*>(marker_payload.data()), marker_payload.size(), &marker)) return false;
  output->proof.assign(proof_text.begin(), proof_text.end()); output->key_id = key.key_id; output->channel_marker = mini_lux::sec03::HexBytes(marker.data(), marker.size()); return true;
}

napi_value ObserveBrokerOperation(napi_env env, napi_callback_info info) {
  size_t argc = 1; napi_value argv[1], self; Lease* lease = GetLease(env, info, &argc, argv, &self);
  if (!lease || !ConsumeLeaseAttempt(env, lease)) return nullptr;
  bool is_buffer = false; void* frame_data = nullptr; size_t frame_size = 0;
  if (argc != 1 || napi_is_buffer(env, argv[0], &is_buffer) != napi_ok || !is_buffer || napi_get_buffer_info(env, argv[0], &frame_data, &frame_size) != napi_ok || frame_size < 6 || frame_size > 32u * 1024u + 4u) { Throw(env, "EXEC_NATIVE_PROTOCOL", "observeBrokerOperation requires one bounded canonical frame"); return nullptr; }
  const auto* frame = static_cast<const unsigned char*>(frame_data); const std::uint32_t declared = (static_cast<std::uint32_t>(frame[0]) << 24) | (static_cast<std::uint32_t>(frame[1]) << 16) | (static_cast<std::uint32_t>(frame[2]) << 8) | frame[3];
  if (declared != frame_size - 4) { Throw(env, "EXEC_NATIVE_PROTOCOL", "Broker observation frame length is invalid"); return nullptr; }
  const std::string wire(reinterpret_cast<const char*>(frame + 4), frame_size - 4); Json request; LauncherObservation observation;
  if (!Parser(wire).Parse(&request) || request.kind != Json::Kind::object || !CreateBrokerObservation(request, wire, *lease, &observation)) { Throw(env, "EXEC_NATIVE_PROTOCOL", "Broker observation request is invalid"); return nullptr; }
  napi_value result; if (!FrozenObservationObject(env, observation, &result)) { Throw(env, "EXEC_NATIVE_EVIDENCE_UNAVAILABLE", "Broker observation result is unavailable"); return nullptr; } return result;
}

napi_value ObserveServiceDenial(napi_env env, napi_callback_info info) {
  size_t argc = 2; napi_value argv[2], self; Lease* lease = GetLease(env, info, &argc, argv, &self);
  if (!lease || !ConsumeLeaseAttempt(env, lease)) return nullptr;
  bool is_buffer = false; void* frame_data = nullptr; size_t frame_size = 0;
  if (argc != 1 || napi_is_buffer(env, argv[0], &is_buffer) != napi_ok || !is_buffer || napi_get_buffer_info(env, argv[0], &frame_data, &frame_size) != napi_ok || frame_size < 6 || frame_size > 16u * 1024u + 4u) { Throw(env, "EXEC_NATIVE_PROTOCOL", "observeServiceDenial requires one bounded canonical frame"); return nullptr; }
  const auto* frame = static_cast<const unsigned char*>(frame_data); const std::uint32_t declared = (static_cast<std::uint32_t>(frame[0]) << 24) | (static_cast<std::uint32_t>(frame[1]) << 16) | (static_cast<std::uint32_t>(frame[2]) << 8) | frame[3];
  if (declared != frame_size - 4) { Throw(env, "EXEC_NATIVE_PROTOCOL", "Service-denial frame length is invalid"); return nullptr; }
  const std::string wire(reinterpret_cast<const char*>(frame + 4), frame_size - 4); Json request;
  if (!Parser(wire).Parse(&request) || request.kind != Json::Kind::object) { Throw(env, "EXEC_NATIVE_PROTOCOL", "Service-denial frame JSON is invalid"); return nullptr; }
  LauncherObservation observation; bool request_valid = false;
  if (!CreateServiceDenialObservation(request, wire, *lease, &request_valid, &observation)) {
    Throw(env, request_valid ? "EXEC_NATIVE_EVIDENCE_UNAVAILABLE" : "EXEC_NATIVE_PROTOCOL", request_valid ? "Native service-denial evidence is unavailable" : "Service-denial request is invalid"); return nullptr;
  }
  napi_value result; if (!FrozenObservationObject(env, observation, &result)) { Throw(env, "EXEC_NATIVE_EVIDENCE_UNAVAILABLE", "Native service-denial evidence result is unavailable"); return nullptr; }
  return result;
}

napi_value CloseLease(napi_env env, napi_callback_info info) {
  size_t argc = 0; napi_value self; if (!Ok(env, napi_get_cb_info(env, info, &argc, nullptr, &self, nullptr), "Cannot read lease close arguments")) return nullptr;
  Lease* lease = nullptr; if (!Ok(env, napi_unwrap(env, self, reinterpret_cast<void**>(&lease)), "Invalid host lease") || !lease) { Throw(env, "EXEC_NATIVE_LEASE_CLOSED", "Host lease is unavailable"); return nullptr; }
  if (!lease->closed) { if (lease->file != INVALID_HANDLE_VALUE) CloseHandle(lease->file); lease->file = INVALID_HANDLE_VALUE; lease->closed = true; }
  return ResolvedPromise(env);
}

napi_value ObserveInvalidRecoveryJournal(napi_env env, napi_callback_info info) {
  size_t argc = 4; napi_value argv[4]; if (!Ok(env, napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr), "Cannot read recovery observation arguments") || argc != 4) return nullptr;
  size_t host_length = 0, launcher_length = 0; int64_t expected_bytes = 0; bool is_buffer = false; void* frame_data = nullptr; size_t frame_size = 0;
  if (napi_get_value_string_utf8(env, argv[0], nullptr, 0, &host_length) != napi_ok || host_length != 64 || napi_get_value_int64(env, argv[1], &expected_bytes) != napi_ok || expected_bytes <= 0
    || napi_get_value_string_utf8(env, argv[2], nullptr, 0, &launcher_length) != napi_ok || launcher_length != 64 || napi_is_buffer(env, argv[3], &is_buffer) != napi_ok || !is_buffer
    || napi_get_buffer_info(env, argv[3], &frame_data, &frame_size) != napi_ok || frame_size < 6 || frame_size > 16u * 1024u + 4u) { Throw(env, "EXEC_NATIVE_PROTOCOL", "Invalid recovery observation arguments"); return nullptr; }
  std::vector<char> host_text(host_length + 1), launcher_text(launcher_length + 1); napi_get_value_string_utf8(env, argv[0], host_text.data(), host_text.size(), &host_length); napi_get_value_string_utf8(env, argv[2], launcher_text.data(), launcher_text.size(), &launcher_length);
  const std::string expected_host(host_text.data(), host_length), expected_launcher(launcher_text.data(), launcher_length); const auto* frame = static_cast<const unsigned char*>(frame_data);
  const std::uint32_t declared = (static_cast<std::uint32_t>(frame[0]) << 24) | (static_cast<std::uint32_t>(frame[1]) << 16) | (static_cast<std::uint32_t>(frame[2]) << 8) | frame[3];
  if (!mini_lux::sec03::CanonicalHex(expected_host, 32, 32) || !mini_lux::sec03::CanonicalHex(expected_launcher, 32, 32) || declared != frame_size - 4) { Throw(env, "EXEC_NATIVE_PROTOCOL", "Invalid recovery observation identity"); return nullptr; }
  const std::string wire(reinterpret_cast<const char*>(frame + 4), frame_size - 4); Json request;
  if (!Parser(wire).Parse(&request) || !ExactKeys(request, {"authorityEpoch", "buildIdSha256", "candidateId", "contextId", "entryPoint", "executionId", "personaDigest", "policyDigest", "profile", "runId", "sessionId", "sourceSha256", "type", "v", "variantId"})) { Throw(env, "EXEC_NATIVE_PROTOCOL", "Invalid recovery observation frame"); return nullptr; }
  const Json* version = Field(request, "v", Json::Kind::number); const Json* type = Field(request, "type", Json::Kind::string); const Json* variant = Field(request, "variantId", Json::Kind::string); const Json* candidate = Field(request, "candidateId", Json::Kind::string); const Json* build = Field(request, "buildIdSha256", Json::Kind::string); const Json* source = Field(request, "sourceSha256", Json::Kind::string);
  const Json* execution = Field(request, "executionId", Json::Kind::string); const Json* context = Field(request, "contextId", Json::Kind::string); const Json* session = Field(request, "sessionId", Json::Kind::string); const Json* run = Field(request, "runId", Json::Kind::string); const Json* authority = Field(request, "authorityEpoch", Json::Kind::number); const Json* entry = Field(request, "entryPoint", Json::Kind::string); const Json* profile = Field(request, "profile", Json::Kind::string); const Json* persona = Field(request, "personaDigest", Json::Kind::string); const Json* policy = Field(request, "policyDigest", Json::Kind::string);
  std::uint64_t authority_epoch = 0; const bool profile_pair = entry && profile && ((entry->scalar == "E1" && profile->scalar == "one-shot-shell") || (entry->scalar == "E2" && profile->scalar == "agent-shell") || (entry->scalar == "E3" && profile->scalar == "script") || (entry->scalar == "E4" && profile->scalar == "manual-terminal"));
  if (!version || version->scalar != "1" || !type || type->scalar != "invalid-recovery-observation" || !variant || variant->scalar != "A14-07" || !candidate || !build || !source || !execution || !context || !session || !run || !authority || !profile_pair || !persona || !policy
    || !mini_lux::sec03::CanonicalHex(candidate->scalar, 32, 32) || !mini_lux::sec03::CanonicalHex(build->scalar, 32, 32) || !mini_lux::sec03::CanonicalHex(source->scalar, 32, 32) || !mini_lux::sec03::LauncherObservationId(execution->scalar) || !mini_lux::sec03::LauncherObservationId(context->scalar) || !mini_lux::sec03::LauncherObservationId(session->scalar) || !mini_lux::sec03::LauncherObservationId(run->scalar) || !mini_lux::sec03::Decimal(authority->scalar, &authority_epoch) || !authority_epoch || authority->scalar != std::to_string(authority_epoch) || !mini_lux::sec03::CanonicalHex(persona->scalar, 32, 32) || !mini_lux::sec03::CanonicalHex(policy->scalar, 32, 32)) { Throw(env, "EXEC_NATIVE_PROTOCOL", "Invalid recovery observation request"); return nullptr; }
  std::ostringstream canonical; canonical << "{\"v\":1,\"type\":\"invalid-recovery-observation\",\"candidateId\":\"" << candidate->scalar << "\",\"buildIdSha256\":\"" << build->scalar << "\",\"sourceSha256\":\"" << source->scalar << "\",\"executionId\":\"" << execution->scalar << "\",\"contextId\":\"" << context->scalar << "\",\"sessionId\":\"" << session->scalar << "\",\"runId\":\"" << run->scalar << "\",\"authorityEpoch\":" << authority->scalar << ",\"entryPoint\":\"" << entry->scalar << "\",\"profile\":\"" << profile->scalar << "\",\"personaDigest\":\"" << persona->scalar << "\",\"policyDigest\":\"" << policy->scalar << "\",\"variantId\":\"A14-07\"}";
  if (canonical.str() != wire || !FixedEvidenceIdentity(expected_host, expected_launcher)) { Throw(env, "EXEC_NATIVE_IDENTITY_INVALID", "Recovery observation native identity differs"); return nullptr; }
  Lease lease; lease.path = FixedHostPath(); lease.launcher_sha256 = expected_launcher; LARGE_INTEGER bytes{}; lease.file = CreateFileW(lease.path.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL | FILE_FLAG_SEQUENTIAL_SCAN, nullptr);
  if (lease.file == INVALID_HANDLE_VALUE || !GetFileInformationByHandle(lease.file, &lease.identity) || !GetFileSizeEx(lease.file, &bytes) || bytes.QuadPart != expected_bytes || !IsAmd64Pe(lease.file) || !Sha256Handle(lease.file, &lease.sha256) || lease.sha256 != expected_host) { if (lease.file != INVALID_HANDLE_VALUE) CloseHandle(lease.file); lease.file = INVALID_HANDLE_VALUE; Throw(env, "EXEC_NATIVE_IDENTITY_INVALID", "Recovery observation host identity differs"); return nullptr; }
  static constexpr char kInvalidJournal[] = "SEC03_A14_INVALID_JOURNAL\n"; const std::wstring expected_name = L"txn-00000000000000000000000000000000.0001.jrn"; mini_lux::sec03::JournalDirectoryLease directory;
  HANDLE mutex = CreateMutexW(nullptr, FALSE, L"Local\\MiniLux.SEC03.AclRecovery.v2"); bool locked = mutex && WaitForSingleObject(mutex, 30000) == WAIT_OBJECT_0; bool fixture_valid = locked && mini_lux::sec03::JournalDirectory(&directory); unsigned entries = 0;
  if (fixture_valid) { WIN32_FIND_DATAW found{}; HANDLE search = FindFirstFileW((directory.path + L"\\*").c_str(), &found); fixture_valid = search != INVALID_HANDLE_VALUE; if (search != INVALID_HANDLE_VALUE) { do { const std::wstring name = found.cFileName; if ((found.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) && (name == L"." || name == L"..")) continue; ++entries; if ((found.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) || name != expected_name) fixture_valid = false; } while (FindNextFileW(search, &found)); if (GetLastError() != ERROR_NO_MORE_FILES) fixture_valid = false; FindClose(search); } }
  std::string fixture; if (fixture_valid) fixture_valid = entries == 1 && ReadSmallFile(directory.path + L"\\" + expected_name, &fixture) && fixture == kInvalidJournal && !RecoverJournals(expected_host, expected_launcher); std::string fixture_after; if (fixture_valid) fixture_valid = ReadSmallFile(directory.path + L"\\" + expected_name, &fixture_after) && fixture_after == fixture;
  if (locked) ReleaseMutex(mutex); if (mutex) CloseHandle(mutex);
  if (!fixture_valid) { CloseHandle(lease.file); lease.file = INVALID_HANDLE_VALUE; Throw(env, "EXEC_RECOVERY_JOURNAL_INVALID", "Fixed invalid recovery journal was not rejected without mutation"); return nullptr; }
  std::string payload_digest, request_digest; if (!mini_lux::sec03::Sha256(reinterpret_cast<const unsigned char*>(fixture.data()), fixture.size(), &payload_digest) || !SequenceDigest("mini-lux/sec03/recovery-observation-request/v1", {candidate->scalar, build->scalar, source->scalar, execution->scalar, context->scalar, session->scalar, run->scalar, authority->scalar, entry->scalar, profile->scalar, persona->scalar, policy->scalar, payload_digest}, &request_digest)) { CloseHandle(lease.file); lease.file = INVALID_HANDLE_VALUE; Throw(env, "EXEC_NATIVE_EVIDENCE_UNAVAILABLE", "Recovery observation digest failed"); return nullptr; }
  std::ostringstream denial_wire; denial_wire << "{\"v\":1,\"type\":\"service-denial\",\"candidateId\":\"" << candidate->scalar << "\",\"buildIdSha256\":\"" << build->scalar << "\",\"sourceSha256\":\"" << source->scalar << "\",\"executionId\":\"" << execution->scalar << "\",\"contextId\":\"" << context->scalar << "\",\"sessionId\":\"" << session->scalar << "\",\"runId\":\"" << run->scalar << "\",\"authorityEpoch\":" << authority->scalar << ",\"entryPoint\":\"" << entry->scalar << "\",\"profile\":\"" << profile->scalar << "\",\"personaDigest\":\"" << persona->scalar << "\",\"policyDigest\":\"" << policy->scalar << "\",\"payloadDigest\":\"" << payload_digest << "\",\"requestDigest\":\"" << request_digest << "\",\"operation\":\"launch\",\"decisionState\":\"recovery-journal-invalid\"}";
  Json denial; bool valid = false; LauncherObservation observation; const std::string denial_text = denial_wire.str(); const bool observed = Parser(denial_text).Parse(&denial) && CreateServiceDenialObservation(denial, denial_text, lease, &valid, &observation) && valid; CloseHandle(lease.file); lease.file = INVALID_HANDLE_VALUE;
  if (!observed) { Throw(env, "EXEC_NATIVE_EVIDENCE_UNAVAILABLE", "Recovery observation evidence is unavailable"); return nullptr; }
  napi_value result; if (!FrozenObservationObject(env, observation, &result)) { Throw(env, "EXEC_NATIVE_EVIDENCE_UNAVAILABLE", "Recovery observation result is unavailable"); return nullptr; } return result;
}

napi_value OpenExclusiveHostLease(napi_env env, napi_callback_info info) {
  size_t argc = 3; napi_value argv[3];
  if (!Ok(env, napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr), "Cannot read lease arguments") || argc != 3) return nullptr;
  size_t length = 0, launcher_length = 0; int64_t expected_bytes = 0;
  if (napi_get_value_string_utf8(env, argv[0], nullptr, 0, &length) != napi_ok || length != 64 || napi_get_value_int64(env, argv[1], &expected_bytes) != napi_ok || expected_bytes <= 0 || napi_get_value_string_utf8(env, argv[2], nullptr, 0, &launcher_length) != napi_ok || launcher_length != 64) { Throw(env, "EXEC_NATIVE_IDENTITY_INVALID", "Host identity arguments are invalid"); return nullptr; }
  std::vector<char> digest(length + 1), launcher_digest(launcher_length + 1); napi_get_value_string_utf8(env, argv[0], digest.data(), digest.size(), &length); napi_get_value_string_utf8(env, argv[2], launcher_digest.data(), launcher_digest.size(), &launcher_length); const std::string expected(digest.data(), length), expected_launcher(launcher_digest.data(), launcher_length);
  if (!mini_lux::sec03::CanonicalHex(expected, 32, 32) || !mini_lux::sec03::CanonicalHex(expected_launcher, 32, 32)) { Throw(env, "EXEC_NATIVE_IDENTITY_INVALID", "Native SHA-256 is not canonical"); return nullptr; }
  HANDLE recovery_mutex = CreateMutexW(nullptr, FALSE, L"Local\\MiniLux.SEC03.AclRecovery.v2"); if (!recovery_mutex || WaitForSingleObject(recovery_mutex, 30000) != WAIT_OBJECT_0) { if (recovery_mutex) CloseHandle(recovery_mutex); Throw(env, "EXEC_ACL_RECOVERY_REQUIRED", "ACL recovery lock is unavailable"); return nullptr; }
  bool recovered = false; try { recovered = RecoverJournals(expected, expected_launcher); } catch (...) { recovered = false; } ReleaseMutex(recovery_mutex); CloseHandle(recovery_mutex); if (!recovered) {
#ifdef MINI_LUX_SEC03_NATIVE_TEST
    const std::string detail = "ACL recovery is unresolved at bounded stage " + std::to_string(g_recovery_stage); Throw(env, "EXEC_ACL_RECOVERY_REQUIRED", detail.c_str());
#else
    Throw(env, "EXEC_ACL_RECOVERY_REQUIRED", "ACL recovery is unresolved");
#endif
    return nullptr;
  }
  auto lease = std::make_unique<Lease>(); lease->path = FixedHostPath(); lease->launcher_sha256 = expected_launcher; LARGE_INTEGER bytes{};
  lease->file = CreateFileW(lease->path.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL | FILE_FLAG_SEQUENTIAL_SCAN, nullptr);
  if (lease->file == INVALID_HANDLE_VALUE || !GetFileInformationByHandle(lease->file, &lease->identity) || !GetFileSizeEx(lease->file, &bytes) || bytes.QuadPart != expected_bytes || !IsAmd64Pe(lease->file) || !Sha256Handle(lease->file, &lease->sha256) || lease->sha256 != expected) {
    if (lease->file != INVALID_HANDLE_VALUE) CloseHandle(lease->file); Throw(env, "EXEC_NATIVE_IDENTITY_INVALID", "Fixed sandbox host does not match manifest"); return nullptr;
  }
  napi_value object, fn; napi_create_object(env, &object); napi_wrap(env, object, lease.get(), FinalizeLease, nullptr, nullptr);
  napi_create_function(env, "launchHost", NAPI_AUTO_LENGTH, LaunchHost, nullptr, &fn); napi_set_named_property(env, object, "launchHost", fn);
  napi_create_function(env, "launchServiceCrashForReceipt", NAPI_AUTO_LENGTH, LaunchServiceCrashForReceipt, nullptr, &fn); napi_set_named_property(env, object, "launchServiceCrashForReceipt", fn);
  napi_create_function(env, "launchHostCrashForReceipt", NAPI_AUTO_LENGTH, LaunchHostCrashForReceipt, nullptr, &fn); napi_set_named_property(env, object, "launchHostCrashForReceipt", fn);
  napi_create_function(env, "launchAclPristineCrashForReceipt", NAPI_AUTO_LENGTH, LaunchAclPristineCrashForReceipt, nullptr, &fn); napi_set_named_property(env, object, "launchAclPristineCrashForReceipt", fn);
  napi_create_function(env, "launchAclAppliedCrashForReceipt", NAPI_AUTO_LENGTH, LaunchAclAppliedCrashForReceipt, nullptr, &fn); napi_set_named_property(env, object, "launchAclAppliedCrashForReceipt", fn);
  napi_create_function(env, "launchAclConflictForReceipt", NAPI_AUTO_LENGTH, LaunchAclConflictForReceipt, nullptr, &fn); napi_set_named_property(env, object, "launchAclConflictForReceipt", fn);
  napi_create_function(env, "observeServiceDenial", NAPI_AUTO_LENGTH, ObserveServiceDenial, nullptr, &fn); napi_set_named_property(env, object, "observeServiceDenial", fn);
  napi_create_function(env, "observeBrokerOperation", NAPI_AUTO_LENGTH, ObserveBrokerOperation, nullptr, &fn); napi_set_named_property(env, object, "observeBrokerOperation", fn);
  napi_create_function(env, "observeFixedNativeIdentity", NAPI_AUTO_LENGTH, ObserveFixedNativeIdentity, nullptr, &fn); napi_set_named_property(env, object, "observeFixedNativeIdentity", fn);
  napi_create_function(env, "close", NAPI_AUTO_LENGTH, CloseLease, nullptr, &fn); napi_set_named_property(env, object, "close", fn);
  lease.release(); return object;
}

void FinalizeEvidenceVerifier(napi_env, void* data, void*) { delete static_cast<EvidenceVerifier*>(data); }

napi_value VerifyExecutionProof(napi_env env, napi_callback_info info) {
  size_t argc = 3; napi_value argv[3], self;
  if (!Ok(env, napi_get_cb_info(env, info, &argc, argv, &self, nullptr), "Cannot read evidence arguments") || argc != 3) return nullptr;
  EvidenceVerifier* verifier = nullptr; bool is_buffer = false; void* proof_data = nullptr; size_t proof_size = 0, mac_length = 0, marker_length = 0;
  if (!Ok(env, napi_unwrap(env, self, reinterpret_cast<void**>(&verifier)), "Invalid evidence verifier") || !verifier
    || napi_is_buffer(env, argv[0], &is_buffer) != napi_ok || !is_buffer || napi_get_buffer_info(env, argv[0], &proof_data, &proof_size) != napi_ok
    || proof_size < 1 || proof_size > mini_lux::sec03::kMaxProofBytes
    || napi_get_value_string_utf8(env, argv[1], nullptr, 0, &mac_length) != napi_ok || mac_length != 64
    || napi_get_value_string_utf8(env, argv[2], nullptr, 0, &marker_length) != napi_ok || marker_length != 64) {
    Throw(env, "EXEC_NATIVE_EVIDENCE_INVALID", "Native execution proof arguments are invalid"); return nullptr;
  }
  std::vector<char> mac_text(mac_length + 1), marker_text(marker_length + 1); napi_get_value_string_utf8(env, argv[1], mac_text.data(), mac_text.size(), &mac_length); napi_get_value_string_utf8(env, argv[2], marker_text.data(), marker_text.size(), &marker_length);
  const std::string mac_hex(mac_text.data(), mac_length), marker_hex(marker_text.data(), marker_length), proof(static_cast<const char*>(proof_data), proof_size); std::vector<unsigned char> received, received_marker; std::map<std::string, std::string> fields; std::array<unsigned char, 32> expected{}, expected_marker{};
  if (!mini_lux::sec03::CanonicalHex(mac_hex, 32, 32) || !mini_lux::sec03::Unhex(mac_hex, &received) || received.size() != expected.size()
    || !mini_lux::sec03::CanonicalHex(marker_hex, 32, 32) || !mini_lux::sec03::Unhex(marker_hex, &received_marker) || received_marker.size() != expected_marker.size()
    || !mini_lux::sec03::ParseCanonicalProof(proof, verifier->candidate, verifier->build, verifier->source, verifier->host, verifier->launcher, verifier->key.key_id, &fields)
    || !mini_lux::sec03::HmacSha256(verifier->key, static_cast<const unsigned char*>(proof_data), proof_size, &expected)
    || !mini_lux::sec03::ConstantTimeEqual(expected.data(), received.data(), expected.size())) {
    Throw(env, "EXEC_NATIVE_EVIDENCE_INVALID", "Native execution proof authentication failed"); return nullptr;
  }
  std::string proof_sha256; if (!mini_lux::sec03::Sha256(static_cast<const unsigned char*>(proof_data), proof_size, &proof_sha256)) { Throw(env, "EXEC_NATIVE_EVIDENCE_INVALID", "Native execution proof digest failed"); return nullptr; }
  const std::string marker_payload = std::string("v=1\nkind=launcher-exit\nkeyId=") + verifier->key.key_id + "\ncandidate=" + verifier->candidate + "\nbuildIdSha256=" + verifier->build + "\nsourceSha256=" + verifier->source + "\nhostSha256=" + verifier->host + "\nlauncher=" + verifier->launcher + "\nexecution=" + fields.at("execution") + "\nproofSha256=" + proof_sha256 + "\nproofMac=" + mac_hex + "\nhostExitCode=" + std::to_string(ProofHostExitCode(fields)) + "\nhostExited=1\n";
  if (!mini_lux::sec03::HmacSha256(verifier->key, reinterpret_cast<const unsigned char*>(marker_payload.data()), marker_payload.size(), &expected_marker) || !mini_lux::sec03::ConstantTimeEqual(expected_marker.data(), received_marker.data(), expected_marker.size())) { Throw(env, "EXEC_NATIVE_EVIDENCE_INVALID", "Native launcher exit marker authentication failed"); return nullptr; }
  std::vector<unsigned char> attestation(proof.begin(), proof.end()); attestation.push_back(0); attestation.insert(attestation.end(), received.begin(), received.end()); attestation.insert(attestation.end(), received_marker.begin(), received_marker.end()); std::string attestation_sha256;
  if (!mini_lux::sec03::Sha256(attestation.data(), attestation.size(), &attestation_sha256)) { Throw(env, "EXEC_NATIVE_EVIDENCE_INVALID", "Native execution proof digest failed"); return nullptr; }
  napi_value result, value; napi_create_object(env, &result); napi_get_boolean(env, true, &value); napi_set_named_property(env, result, "authenticated", value); napi_get_boolean(env, false, &value); napi_set_named_property(env, result, "testOnly", value); napi_create_string_utf8(env, attestation_sha256.c_str(), NAPI_AUTO_LENGTH, &value); napi_set_named_property(env, result, "attestationSha256", value); return result;
}

napi_value VerifyLauncherObservation(napi_env env, napi_callback_info info) {
  size_t argc = 3; napi_value argv[3], self;
  if (!Ok(env, napi_get_cb_info(env, info, &argc, argv, &self, nullptr), "Cannot read launcher observation arguments") || argc != 3) return nullptr;
  EvidenceVerifier* verifier = nullptr; bool is_buffer = false; void* proof_data = nullptr; size_t proof_size = 0, mac_length = 0, marker_length = 0;
  if (!Ok(env, napi_unwrap(env, self, reinterpret_cast<void**>(&verifier)), "Invalid evidence verifier") || !verifier
    || napi_is_buffer(env, argv[0], &is_buffer) != napi_ok || !is_buffer || napi_get_buffer_info(env, argv[0], &proof_data, &proof_size) != napi_ok
    || proof_size < 1 || proof_size > mini_lux::sec03::kMaxProofBytes
    || napi_get_value_string_utf8(env, argv[1], nullptr, 0, &mac_length) != napi_ok || mac_length != 64
    || napi_get_value_string_utf8(env, argv[2], nullptr, 0, &marker_length) != napi_ok || marker_length != 64) {
    Throw(env, "EXEC_NATIVE_EVIDENCE_INVALID", "Native launcher observation arguments are invalid"); return nullptr;
  }
  std::vector<char> mac_text(mac_length + 1), marker_text(marker_length + 1); napi_get_value_string_utf8(env, argv[1], mac_text.data(), mac_text.size(), &mac_length); napi_get_value_string_utf8(env, argv[2], marker_text.data(), marker_text.size(), &marker_length);
  const std::string mac_hex(mac_text.data(), mac_length), marker_hex(marker_text.data(), marker_length), proof(static_cast<const char*>(proof_data), proof_size); std::vector<unsigned char> received, received_marker; std::map<std::string, std::string> fields; std::array<unsigned char, 32> expected{}, expected_marker{};
  if (!mini_lux::sec03::CanonicalHex(mac_hex, 32, 32) || !mini_lux::sec03::Unhex(mac_hex, &received) || received.size() != expected.size()
    || !mini_lux::sec03::CanonicalHex(marker_hex, 32, 32) || !mini_lux::sec03::Unhex(marker_hex, &received_marker) || received_marker.size() != expected_marker.size()
    || !mini_lux::sec03::ParseCanonicalLauncherObservation(proof, verifier->candidate, verifier->build, verifier->source, verifier->host, verifier->launcher, verifier->key.key_id, &fields)
    || !mini_lux::sec03::HmacSha256(verifier->key, static_cast<const unsigned char*>(proof_data), proof_size, &expected)
    || !mini_lux::sec03::ConstantTimeEqual(expected.data(), received.data(), expected.size())) {
    Throw(env, "EXEC_NATIVE_EVIDENCE_INVALID", "Native launcher observation authentication failed"); return nullptr;
  }
  std::string proof_sha256; if (!mini_lux::sec03::Sha256(static_cast<const unsigned char*>(proof_data), proof_size, &proof_sha256)) { Throw(env, "EXEC_NATIVE_EVIDENCE_INVALID", "Native launcher observation digest failed"); return nullptr; }
  const std::string marker_payload = mini_lux::sec03::LauncherObservationMarkerPayload(fields, proof_sha256, mac_hex);
  if (marker_payload.empty() || !mini_lux::sec03::HmacSha256(verifier->key, reinterpret_cast<const unsigned char*>(marker_payload.data()), marker_payload.size(), &expected_marker) || !mini_lux::sec03::ConstantTimeEqual(expected_marker.data(), received_marker.data(), expected_marker.size())) { Throw(env, "EXEC_NATIVE_EVIDENCE_INVALID", "Native launcher observation marker authentication failed"); return nullptr; }
  std::vector<unsigned char> attestation(proof.begin(), proof.end()); attestation.push_back(0); attestation.insert(attestation.end(), received.begin(), received.end()); attestation.insert(attestation.end(), received_marker.begin(), received_marker.end()); std::string attestation_sha256;
  if (!mini_lux::sec03::Sha256(attestation.data(), attestation.size(), &attestation_sha256)) { Throw(env, "EXEC_NATIVE_EVIDENCE_INVALID", "Native launcher observation digest failed"); return nullptr; }
  napi_value result, value; napi_create_object(env, &result); napi_get_boolean(env, true, &value); napi_set_named_property(env, result, "authenticated", value); napi_get_boolean(env, false, &value); napi_set_named_property(env, result, "testOnly", value); napi_create_string_utf8(env, attestation_sha256.c_str(), NAPI_AUTO_LENGTH, &value); napi_set_named_property(env, result, "attestationSha256", value); return result;
}

struct ProjectionIdentity {
  std::string layer;
  std::string race_stage;
  std::string manifest_digest;
  std::string manifest_sha256;
  std::string package_sha256;
  std::string asar_sha256;
  std::string native_source_sha256;
  std::string native_manifest_sha256;
  std::string package_commitment;
  std::string native_commitment;
};

bool EndsWithInsensitive(const std::wstring& value, const std::wstring& suffix) { return value.size() >= suffix.size() && _wcsicmp(value.c_str() + value.size() - suffix.size(), suffix.c_str()) == 0; }

bool HashRegularFile(const std::wstring& path, std::string* digest, std::uint64_t* bytes = nullptr, bool pe = false) {
  HANDLE file = CreateFileW(path.c_str(), GENERIC_READ | FILE_READ_ATTRIBUTES, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_SEQUENTIAL_SCAN, nullptr); BY_HANDLE_FILE_INFORMATION info{}; LARGE_INTEGER size{};
  const bool valid = file != INVALID_HANDLE_VALUE && GetFileInformationByHandle(file, &info) && !(info.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) && GetFileSizeEx(file, &size) && size.QuadPart > 0 && (!pe || IsAmd64Pe(file)) && Sha256Handle(file, digest);
  if (valid && bytes) *bytes = static_cast<std::uint64_t>(size.QuadPart); if (file != INVALID_HANDLE_VALUE) CloseHandle(file); return valid;
}

bool ProjectionBinaryRecord(const Json& native, const char* relative, const std::string& expected_sha256, std::uint64_t expected_bytes) {
  const Json* binaries = Field(native, "binaries", Json::Kind::array); if (!binaries || binaries->array.size() != 2) return false;
  for (const auto& record : binaries->array) {
    if (!ExactKeys(record, {"bytes", "importedDllAllowlistDigest", "machine", "path", "sha256"})) return false;
    const Json* path = Field(record, "path", Json::Kind::string); if (!path || path->scalar != relative) continue; const Json* bytes = Field(record, "bytes", Json::Kind::number); const Json* sha256 = Field(record, "sha256", Json::Kind::string); const Json* imported_dlls = Field(record, "importedDllAllowlistDigest", Json::Kind::string); const Json* machine = Field(record, "machine", Json::Kind::string); std::uint64_t count = 0;
    return bytes && ParseUnsigned(bytes->scalar, &count) && count == expected_bytes && sha256 && sha256->scalar == expected_sha256 && imported_dlls && mini_lux::sec03::CanonicalHex(imported_dlls->scalar, 32, 32) && machine && machine->scalar == "AMD64";
  }
  return false;
}

bool ResolveProjectionIdentity(const EvidenceVerifier& verifier, const std::string& layer, ProjectionIdentity* identity) {
  if (!identity || (layer != "electron" && layer != "packaged") || !FixedEvidenceIdentity(verifier.host, verifier.launcher)) return false;
  const std::wstring launcher_path = CurrentLauncherPath(); const std::wstring electron_suffix = L"\\dist\\native\\sandbox-launcher.node"; const std::wstring packaged_suffix = L"\\app.asar.unpacked\\dist\\native\\sandbox-launcher.node"; std::wstring manifest_path, package_path, asar_path, native_manifest_path;
  if (layer == "electron") {
    if (!EndsWithInsensitive(launcher_path, electron_suffix)) return false; const std::wstring root = launcher_path.substr(0, launcher_path.size() - electron_suffix.size()); manifest_path = root + L"\\electron-stage-integrity.json"; package_path = root + L"\\package.json"; native_manifest_path = root + L"\\dist\\native\\sec03-native-manifest.json"; identity->race_stage = "electron-stage";
  } else {
    if (!EndsWithInsensitive(launcher_path, packaged_suffix)) return false; const std::wstring resources = launcher_path.substr(0, launcher_path.size() - packaged_suffix.size()); const std::wstring unpacked = resources + L"\\app.asar.unpacked"; manifest_path = unpacked + L"\\electron-stage-integrity.json"; package_path = unpacked + L"\\package.json"; asar_path = resources + L"\\app.asar"; identity->race_stage = "packaged-installed";
  }
  std::string manifest_wire, package_wire; if (!ReadSmallFile(manifest_path, &manifest_wire) || !ReadSmallFile(package_path, &package_wire)) return false; Json manifest, package;
  if (!Parser(manifest_wire).Parse(&manifest) || !Parser(package_wire).Parse(&package) || manifest.kind != Json::Kind::object || package.kind != Json::Kind::object) return false;
  const Json* schema = Field(manifest, "schemaVersion", Json::Kind::number); const Json* build_id = Field(manifest, "buildId", Json::Kind::string); const Json* source = Field(manifest, "sourceDigest", Json::Kind::string); const Json* canonical = Field(manifest, "canonicalPayloadSha256", Json::Kind::string); const Json* stage_package = Field(manifest, "stagePackageSha256", Json::Kind::string); const Json* native = Field(manifest, "native", Json::Kind::object);
  const Json* package_name = Field(package, "name", Json::Kind::string); const Json* package_version = Field(package, "version", Json::Kind::string); const Json* package_main = Field(package, "main", Json::Kind::string); std::string build_sha256, canonical_observed;
  if (!schema || schema->scalar != "1" || !build_id || build_id->scalar.empty() || build_id->scalar.size() > 128 || !source || source->scalar != verifier.source || !canonical || !stage_package || !native || !package_name || package_name->scalar != "rainydays" || !package_version || package_version->scalar.empty() || build_id->scalar.rfind(package_version->scalar + "+", 0) != 0 || !package_main || package_main->scalar != "electron/main.cjs"
    || !mini_lux::sec03::Sha256(reinterpret_cast<const unsigned char*>(build_id->scalar.data()), build_id->scalar.size(), &build_sha256) || build_sha256 != verifier.build || !CanonicalJsonSha256(manifest, "canonicalPayloadSha256", &canonical_observed) || canonical_observed != canonical->scalar) return false;
  const Json* native_source = Field(*native, "sourceDigest", Json::Kind::string); const Json* native_manifest = Field(*native, "manifest", Json::Kind::object); const Json* native_architecture = Field(*native, "architectureSha256", Json::Kind::string); const Json* native_toolchain = Field(*native, "toolchainDigest", Json::Kind::string); const Json* native_manifest_path_field = native_manifest ? Field(*native_manifest, "path", Json::Kind::string) : nullptr; const Json* native_manifest_bytes = native_manifest ? Field(*native_manifest, "bytes", Json::Kind::number) : nullptr; const Json* native_manifest_sha = native_manifest ? Field(*native_manifest, "sha256", Json::Kind::string) : nullptr; std::uint64_t manifest_bytes = 0, host_bytes = 0, launcher_bytes = 0;
  if (!native_source || !mini_lux::sec03::CanonicalHex(native_source->scalar, 32, 32) || !native_architecture || !mini_lux::sec03::CanonicalHex(native_architecture->scalar, 32, 32) || !native_toolchain || !mini_lux::sec03::CanonicalHex(native_toolchain->scalar, 32, 32) || !native_manifest_path_field || native_manifest_path_field->scalar != "dist/native/sec03-native-manifest.json" || !native_manifest_bytes || !ParseUnsigned(native_manifest_bytes->scalar, &manifest_bytes) || !manifest_bytes || !native_manifest_sha || !mini_lux::sec03::CanonicalHex(native_manifest_sha->scalar, 32, 32)
    || !HashRegularFile(FixedHostPath(), &identity->native_commitment, &host_bytes, true) || identity->native_commitment != verifier.host || !HashRegularFile(launcher_path, &identity->native_commitment, &launcher_bytes, true) || identity->native_commitment != verifier.launcher
    || !ProjectionBinaryRecord(*native, "dist/native/sandbox-host.exe", verifier.host, host_bytes) || !ProjectionBinaryRecord(*native, "dist/native/sandbox-launcher.node", verifier.launcher, launcher_bytes)) return false;
  if (!mini_lux::sec03::Sha256(reinterpret_cast<const unsigned char*>(manifest_wire.data()), manifest_wire.size(), &identity->manifest_sha256) || !mini_lux::sec03::Sha256(reinterpret_cast<const unsigned char*>(package_wire.data()), package_wire.size(), &identity->package_sha256)) return false;
  if (layer == "electron") {
    std::string actual_native_manifest; std::uint64_t actual_native_manifest_bytes = 0; if (!HashRegularFile(native_manifest_path, &actual_native_manifest, &actual_native_manifest_bytes) || actual_native_manifest != native_manifest_sha->scalar || actual_native_manifest_bytes != manifest_bytes || stage_package->scalar != identity->package_sha256 || !package.object.count("build") || !package.object.count("scripts")) return false; identity->asar_sha256 = "electron-stage-no-asar";
  } else {
    if (package.object.count("build") || package.object.count("scripts") || package.object.count("devDependencies") || !HashRegularFile(asar_path, &identity->asar_sha256)) return false;
  }
  identity->layer = layer; identity->manifest_digest = canonical->scalar; identity->native_source_sha256 = native_source->scalar; identity->native_manifest_sha256 = native_manifest_sha->scalar;
  if (!SequenceDigest("mini-lux/sec03/projection-package/v1", {layer, identity->race_stage, verifier.candidate, verifier.build, verifier.source, identity->manifest_digest, identity->manifest_sha256, identity->package_sha256, identity->asar_sha256, identity->native_source_sha256, identity->native_manifest_sha256, verifier.host, verifier.launcher}, &identity->package_commitment)
    || !SequenceDigest("mini-lux/sec03/projection-native/v1", {layer, verifier.candidate, verifier.build, verifier.source, identity->native_source_sha256, identity->native_manifest_sha256, verifier.host, verifier.launcher}, &identity->native_commitment)) return false;
  return true;
}

struct ProjectionCase {
  const char* projection_id;
  const char* source_variant;
  const char* expected_code;
};

const ProjectionCase* FindProjectionCase(const std::string& projection_id, const std::string& profile_id) {
  static constexpr std::array<ProjectionCase, 12> cases = {{{"P01", "none", "OBS_HOST_BOUND"}, {"P02", "none", "OBS_TOKEN_MATCH"}, {"P03", "none", "OBS_JOB_MATCH"}, {"P04", "none", "OBS_ENV_EXACT"}, {"P05", "A16-01", "OBS_POSITIVE_COMPLETE"}, {"P06", "A02-01", "OBS_FS_DENIED"}, {"P07", "A04-02", "OBS_NETWORK_DENIED"}, {"P08", "A06-02", "OBS_JOB_EMPTY"}, {"P09", "A08-05", "EXEC_LIMIT_OUTPUT"}, {"P10", "A09-03", "EXEC_OWNER_RETIRED"}, {"P11", "A11-05", "EXEC_GRANT_REPLAYED"}, {"P12", "A09-07", "EXEC_HOST_LOST"}}};
  if (projection_id == "P11" && profile_id == "E4") { static constexpr ProjectionCase consent{"P11", "A12-05", "EXEC_CONSENT_REPLAYED"}; return &consent; }
  for (const auto& value : cases) if (projection_id == value.projection_id) return &value; return nullptr;
}

const char* ProjectionProfile(const std::string& profile_id) { return profile_id == "E1" ? "one-shot-shell" : profile_id == "E2" ? "agent-shell" : profile_id == "E3" ? "script" : profile_id == "E4" ? "manual-terminal" : ""; }

bool NapiExactKeys(napi_env env, napi_value object, std::initializer_list<const char*> keys) {
  napi_valuetype type = napi_undefined; napi_value names; uint32_t count = 0;
  if (napi_typeof(env, object, &type) != napi_ok || type != napi_object) return false;
  bool is_array = false; if (napi_is_array(env, object, &is_array) != napi_ok || is_array || napi_get_property_names(env, object, &names) != napi_ok || napi_get_array_length(env, names, &count) != napi_ok || count != keys.size()) return false;
  for (const char* key : keys) { napi_value name; bool present = false; if (napi_create_string_utf8(env, key, NAPI_AUTO_LENGTH, &name) != napi_ok || napi_has_own_property(env, object, name, &present) != napi_ok || !present) return false; }
  return true;
}

bool NapiString(napi_env env, napi_value object, const char* key, std::string* output, size_t maximum = 256) {
  napi_value value; size_t length = 0; if (!output || napi_get_named_property(env, object, key, &value) != napi_ok || napi_get_value_string_utf8(env, value, nullptr, 0, &length) != napi_ok || !length || length > maximum) return false;
  std::vector<char> text(length + 1); if (napi_get_value_string_utf8(env, value, text.data(), text.size(), &length) != napi_ok) return false; output->assign(text.data(), length); return true;
}

struct ProjectionInner {
  bool launcher = false;
  std::string kind;
  std::string proof_sha256;
  std::string attestation_sha256;
  std::map<std::string, std::string> fields;
};

bool AuthenticateProjectionInner(const EvidenceVerifier& verifier, const std::string& kind, const unsigned char* proof_data, size_t proof_size, const std::string& mac_hex, const std::string& marker_hex, ProjectionInner* output) {
  if (!output || !proof_data || !proof_size || proof_size > mini_lux::sec03::kMaxProofBytes || !mini_lux::sec03::CanonicalHex(mac_hex, 32, 32) || !mini_lux::sec03::CanonicalHex(marker_hex, 32, 32)) return false;
  std::vector<unsigned char> mac, marker; std::array<unsigned char, 32> expected_mac{}, expected_marker{}; const std::string proof(reinterpret_cast<const char*>(proof_data), proof_size);
  if (!mini_lux::sec03::Unhex(mac_hex, &mac) || !mini_lux::sec03::Unhex(marker_hex, &marker) || mac.size() != expected_mac.size() || marker.size() != expected_marker.size()
    || !mini_lux::sec03::HmacSha256(verifier.key, proof_data, proof_size, &expected_mac) || !mini_lux::sec03::ConstantTimeEqual(mac.data(), expected_mac.data(), expected_mac.size())
    || !mini_lux::sec03::Sha256(proof_data, proof_size, &output->proof_sha256)) return false;
  output->launcher = kind == "launcher-observation"; output->kind = kind;
  if (kind == "execution-proof") {
    if (!mini_lux::sec03::ParseCanonicalProof(proof, verifier.candidate, verifier.build, verifier.source, verifier.host, verifier.launcher, verifier.key.key_id, &output->fields)) return false;
    const std::string payload = std::string("v=1\nkind=launcher-exit\nkeyId=") + verifier.key.key_id + "\ncandidate=" + verifier.candidate + "\nbuildIdSha256=" + verifier.build + "\nsourceSha256=" + verifier.source + "\nhostSha256=" + verifier.host + "\nlauncher=" + verifier.launcher + "\nexecution=" + output->fields.at("execution") + "\nproofSha256=" + output->proof_sha256 + "\nproofMac=" + mac_hex + "\nhostExitCode=" + std::to_string(ProofHostExitCode(output->fields)) + "\nhostExited=1\n";
    if (!mini_lux::sec03::HmacSha256(verifier.key, reinterpret_cast<const unsigned char*>(payload.data()), payload.size(), &expected_marker)) return false;
  } else if (kind == "launcher-observation") {
    if (!mini_lux::sec03::ParseCanonicalLauncherObservation(proof, verifier.candidate, verifier.build, verifier.source, verifier.host, verifier.launcher, verifier.key.key_id, &output->fields) || output->fields.at("observationClass") == "projection-observation") return false;
    const std::string payload = mini_lux::sec03::LauncherObservationMarkerPayload(output->fields, output->proof_sha256, mac_hex); if (payload.empty() || !mini_lux::sec03::HmacSha256(verifier.key, reinterpret_cast<const unsigned char*>(payload.data()), payload.size(), &expected_marker)) return false;
  } else return false;
  if (!mini_lux::sec03::ConstantTimeEqual(marker.data(), expected_marker.data(), expected_marker.size())) return false;
  std::vector<unsigned char> attestation(proof_data, proof_data + proof_size); attestation.push_back(0); attestation.insert(attestation.end(), mac.begin(), mac.end()); attestation.insert(attestation.end(), marker.begin(), marker.end());
  return mini_lux::sec03::Sha256(attestation.data(), attestation.size(), &output->attestation_sha256);
}

bool ProjectionInnerMatches(const ProjectionCase& projection, const std::string& profile_id, const ProjectionInner& inner) {
  const auto field = [&](const char* key) -> const std::string& { return inner.fields.at(key); };
  const bool fixed_adversary_source = std::string(projection.projection_id) == "P08" && profile_id == "E3";
  const std::string expected_profile = fixed_adversary_source ? "fixed-adversary" : ProjectionProfile(profile_id);
  if (field("profile") != expected_profile || field("cleanupComplete") != "1" || field("handlesDrained") != "1" || field("treeTerminated") != "1") return false;
  if (inner.launcher) {
    if (field("entryPoint") != profile_id) return false;
    if (std::string(projection.projection_id) == "P11") return field("observedCode") == projection.expected_code && field("completionReason") == "pre-host-denial" && field("processStarts") == "0";
    if (std::string(projection.projection_id) == "P12") return field("decisionState") == "host-lost-recovered" && field("observedCode") == "EXEC_HOST_LOST" && field("completionReason") == "host-lost-recovered" && field("hostExitCode") == "58279";
    return false;
  }
  const std::string id(projection.projection_id);
  if (id == "P11" || id == "P12") return false;
  if (id == "P02" && (field("tokenIsAppContainer") != "1" || field("capabilityCount") != "0" || field("lowIntegrity") != "1")) return false;
  if (id == "P03" && (field("jobConstrained") != "1" || field("activeProcessZero") != "1")) return false;
  if (id == "P04" && field("ambientLeakCount") != "0") return false;
  if ((id == "P05" || id == "P06" || id == "P07" || id == "P08") && field("completionReason") != "completed") return false;
  if (id == "P07" && field("networkAcceptedCount") != "0") return false;
  if (id == "P08" && field("activeProcessZero") != "1") return false;
  if (id == "P09" && field("completionReason") != "limit-output") return false;
  if (id == "P10" && field("completionReason") != "owner-retired") return false;
  return true;
}

napi_value CreateProjectionObservation(napi_env env, napi_callback_info info) {
  size_t argc = 1; napi_value argv[1], self;
  if (!Ok(env, napi_get_cb_info(env, info, &argc, argv, &self, nullptr), "Cannot read projection request") || argc != 1) return nullptr;
  EvidenceVerifier* verifier = nullptr; if (!Ok(env, napi_unwrap(env, self, reinterpret_cast<void**>(&verifier)), "Invalid evidence verifier") || !verifier
    || !NapiExactKeys(env, argv[0], {"v","layer","projectionId","familyId","sourceVariant","profileId","expectedCode","innerEvidence"})) { Throw(env, "EXEC_NATIVE_EVIDENCE_INVALID", "Projection request schema is invalid"); return nullptr; }
  napi_value version_value; uint32_t version = 0; std::string layer, projection_id, family_id, profile_id, expected_code;
  if (napi_get_named_property(env, argv[0], "v", &version_value) != napi_ok || napi_get_value_uint32(env, version_value, &version) != napi_ok || version != 1
    || !NapiString(env, argv[0], "layer", &layer, 16) || !NapiString(env, argv[0], "projectionId", &projection_id, 3) || !NapiString(env, argv[0], "familyId", &family_id, 3)
    || !NapiString(env, argv[0], "profileId", &profile_id, 2) || !NapiString(env, argv[0], "expectedCode", &expected_code, 64)) { Throw(env, "EXEC_NATIVE_EVIDENCE_INVALID", "Projection tuple is invalid"); return nullptr; }
  const ProjectionCase* projection = FindProjectionCase(projection_id, profile_id); const char* profile = ProjectionProfile(profile_id);
  if (!projection || !profile[0] || family_id != projection_id || expected_code != projection->expected_code) { Throw(env, "EXEC_NATIVE_EVIDENCE_INVALID", "Projection tuple is not fixed"); return nullptr; }
  napi_value source_value; napi_valuetype source_type = napi_undefined; std::string source_variant = "none";
  if (napi_get_named_property(env, argv[0], "sourceVariant", &source_value) != napi_ok || napi_typeof(env, source_value, &source_type) != napi_ok) { Throw(env, "EXEC_NATIVE_EVIDENCE_INVALID", "Projection source is invalid"); return nullptr; }
  if (source_type != napi_null) { size_t length = 0; if (napi_get_value_string_utf8(env, source_value, nullptr, 0, &length) != napi_ok || !length || length > 16) { Throw(env, "EXEC_NATIVE_EVIDENCE_INVALID", "Projection source is invalid"); return nullptr; } std::vector<char> text(length + 1); napi_get_value_string_utf8(env, source_value, text.data(), text.size(), &length); source_variant.assign(text.data(), length); }
  if (source_variant != projection->source_variant) { Throw(env, "EXEC_NATIVE_EVIDENCE_INVALID", "Projection source variant differs"); return nullptr; }
  napi_value inner_value; if (napi_get_named_property(env, argv[0], "innerEvidence", &inner_value) != napi_ok || !NapiExactKeys(env, inner_value, {"kind","proof","mac","marker"})) { Throw(env, "EXEC_NATIVE_EVIDENCE_INVALID", "Projection inner evidence schema is invalid"); return nullptr; }
  std::string inner_kind, inner_mac, inner_marker; napi_value proof_value; bool proof_buffer = false; void* proof_data = nullptr; size_t proof_size = 0;
  if (!NapiString(env, inner_value, "kind", &inner_kind, 32) || !NapiString(env, inner_value, "mac", &inner_mac, 64) || !NapiString(env, inner_value, "marker", &inner_marker, 64)
    || napi_get_named_property(env, inner_value, "proof", &proof_value) != napi_ok || napi_is_buffer(env, proof_value, &proof_buffer) != napi_ok || !proof_buffer || napi_get_buffer_info(env, proof_value, &proof_data, &proof_size) != napi_ok) { Throw(env, "EXEC_NATIVE_EVIDENCE_INVALID", "Projection inner evidence is invalid"); return nullptr; }
  ProjectionInner inner; if (!AuthenticateProjectionInner(*verifier, inner_kind, static_cast<const unsigned char*>(proof_data), proof_size, inner_mac, inner_marker, &inner) || !ProjectionInnerMatches(*projection, profile_id, inner)) { Throw(env, "EXEC_NATIVE_EVIDENCE_INVALID", "Projection inner evidence does not prove the fixed source case"); return nullptr; }
  ProjectionIdentity projection_identity; if (!ResolveProjectionIdentity(*verifier, layer, &projection_identity)) { Throw(env, "EXEC_NATIVE_IDENTITY_INVALID", "Loaded native projection identity is invalid"); return nullptr; }

  const auto inner_field = [&](const char* key) -> const std::string& { return inner.fields.at(key); };
  const std::string host_exit = inner.launcher ? inner_field("hostExitCode") : "none"; const std::string recovery_state = inner.launcher ? inner_field("recoveryJournalState") : "none"; const std::string recovery_generation = inner.launcher ? inner_field("recoveryJournalGeneration") : "0";
  const std::string profile_creates = inner.launcher ? inner_field("profileCreates") : inner_field("tokenIsAppContainer"); const std::string journal_writes = inner.launcher ? inner_field("journalWrites") : (inner_field("aclMutations") == "0" ? "0" : "2");
  const std::string job_closed = inner.launcher ? inner_field("jobClosed") : inner_field("cleanupComplete"); const std::string host_exited = inner.launcher ? inner_field("hostExited") : "1"; const std::string network_attempts = projection_id == "P07" ? "1" : inner.launcher ? inner_field("networkAttemptCount") : "0";
  std::string projection_execution, layer_digest, case_digest, stimulus_digest, transcript_digest;
  if (!SequenceDigest("mini-lux/sec03/projection-execution/v1", {layer, projection_id, profile_id, inner.attestation_sha256, inner_field("execution"), inner_field("run")}, &projection_execution)
    || !SequenceDigest("mini-lux/sec03/projection-layer/v1", {layer}, &layer_digest)
    || !SequenceDigest("mini-lux/sec03/projection-case/v1", {layer, projection_id, family_id, profile_id, source_variant, expected_code, projection_identity.package_commitment, projection_identity.native_commitment}, &case_digest)
    || !SequenceDigest("mini-lux/sec03/projection-stimulus/v1", {layer, projection_id, family_id, profile_id, source_variant, expected_code, projection_execution, inner.kind, inner.proof_sha256, inner.attestation_sha256, inner_field("execution"), inner_field("run"), inner_field("payloadDigest"), inner_field("transcriptSha256"), projection_identity.package_commitment, projection_identity.native_commitment}, &stimulus_digest)
    || !SequenceDigest("mini-lux/sec03/projection-transcript/v1", {case_digest, stimulus_digest, projection_execution, projection_identity.manifest_digest, projection_identity.manifest_sha256, projection_identity.package_commitment, projection_identity.native_commitment, inner.attestation_sha256, inner_field("execution"), inner_field("context"), inner_field("session"), inner_field("run"), inner_field("tokenIsAppContainer"), inner_field("jobPolicySha256"), inner_field("rootIdentityDigest"), inner_field("environmentNameDigest"), inner_field("environmentValueDigest"), inner_field("completionReason"), inner_field("aclProfileSha256")}, &transcript_digest)) { Throw(env, "EXEC_NATIVE_EVIDENCE_UNAVAILABLE", "Projection evidence digest failed"); return nullptr; }

  std::ostringstream proof; proof << "v=1\nkind=launcher-observation\nkeyId=" << verifier->key.key_id << "\ncandidate=" << verifier->candidate << "\nbuildIdSha256=" << verifier->build << "\nsourceSha256=" << verifier->source << "\nhostSha256=" << verifier->host << "\nlauncher=" << verifier->launcher
    << "\nexecution=" << projection_execution << "\ncontext=" << inner_field("context") << "\nsession=" << inner_field("session") << "\nrun=" << inner_field("run") << "\nauthorityEpoch=" << inner_field("authorityEpoch") << "\nentryPoint=" << profile_id << "\nprofile=" << profile << "\noperation=projection\ndecisionState=" << projection_id
    << "\npersonaDigest=" << layer_digest << "\npolicyDigest=" << case_digest << "\npayloadDigest=" << projection_identity.package_commitment << "\nstimulusDigest=" << stimulus_digest << "\nrequestDigest=" << inner.proof_sha256 << "\nrootRequestDigest=" << projection_identity.manifest_digest
    << "\nobservationClass=projection-observation\nraceStage=" << projection_identity.race_stage << "\nrootFailureClass=none\nexpectedRootIdentityDigest=" << projection_identity.native_commitment << "\nobservedRootIdentityDigest=" << projection_identity.native_commitment << "\nobservedCode=" << expected_code << "\nobservedSubcode=none\nhostExitCode=" << host_exit << "\nrecoveryJournalState=" << recovery_state << "\nrecoveryJournalGeneration=" << recovery_generation << "\ntranscriptSha256=" << transcript_digest
    << "\ntokenIsAppContainer=" << inner_field("tokenIsAppContainer") << "\npackageSidSha256=" << inner_field("packageSidSha256") << "\ncapabilityCount=" << inner_field("capabilityCount") << "\nlowIntegrity=" << inner_field("lowIntegrity") << "\njobConstrained=" << inner_field("jobConstrained") << "\njobPolicySha256=" << inner_field("jobPolicySha256") << "\nactiveProcessZero=" << inner_field("activeProcessZero") << "\nprocessStarts=" << inner_field("processStarts")
    << "\nprofileCreates=" << profile_creates << "\njournalWrites=" << journal_writes << "\naclMutations=" << inner_field("aclMutations") << "\nstdinWrites=" << inner_field("stdinWrites") << "\ninputDigestSetSha256=" << inner_field("inputDigestSetSha256") << "\nconpty=" << inner_field("conpty") << "\nconptyMerged=" << inner_field("conptyMerged") << "\nexecutableLease=" << inner_field("executableLease") << "\nchildExit=" << inner_field("childExit") << "\ncompletionReason=" << inner_field("completionReason") << "\naggregateOutputBytes=" << inner_field("aggregateOutputBytes") << "\ncleanupComplete=" << inner_field("cleanupComplete") << "\njobClosed=" << job_closed << "\nhandlesDrained=" << inner_field("handlesDrained") << "\nhostExited=" << host_exited << "\ntreeTerminated=" << inner_field("treeTerminated")
    << "\nrootIdentityDigest=" << inner_field("rootIdentityDigest") << "\nrootAccessProfileSha256=" << inner_field("rootAccessProfileSha256") << "\nrootFixedNtfs=" << inner_field("rootFixedNtfs") << "\nrootSameSystemVolume=" << inner_field("rootSameSystemVolume") << "\nrootHasSpace=" << inner_field("rootHasSpace") << "\nrootHasNonAscii=" << inner_field("rootHasNonAscii") << "\nenvironmentNameDigest=" << inner_field("environmentNameDigest") << "\nenvironmentValueDigest=" << inner_field("environmentValueDigest") << "\nambientLeakCount=" << inner_field("ambientLeakCount") << "\nnetworkMode=" << inner_field("networkMode") << "\nnetworkAttemptCount=" << network_attempts << "\nnetworkAcceptedCount=" << inner_field("networkAcceptedCount") << "\naclProfileSha256=" << inner_field("aclProfileSha256") << "\n";
  const std::string proof_text = proof.str(); std::map<std::string, std::string> parsed; LauncherObservation observation; std::array<unsigned char, 32> mac{}, marker{}; std::string proof_sha256;
  if (!mini_lux::sec03::ParseCanonicalLauncherObservation(proof_text, verifier->candidate, verifier->build, verifier->source, verifier->host, verifier->launcher, verifier->key.key_id, &parsed)
    || !mini_lux::sec03::HmacSha256(verifier->key, reinterpret_cast<const unsigned char*>(proof_text.data()), proof_text.size(), &mac) || !mini_lux::sec03::Sha256(reinterpret_cast<const unsigned char*>(proof_text.data()), proof_text.size(), &proof_sha256)) { Throw(env, "EXEC_NATIVE_EVIDENCE_UNAVAILABLE", "Projection observation is not canonical"); return nullptr; }
  observation.mac = mini_lux::sec03::HexBytes(mac.data(), mac.size()); const std::string marker_payload = mini_lux::sec03::LauncherObservationMarkerPayload(parsed, proof_sha256, observation.mac);
  if (marker_payload.empty() || !mini_lux::sec03::HmacSha256(verifier->key, reinterpret_cast<const unsigned char*>(marker_payload.data()), marker_payload.size(), &marker)) { Throw(env, "EXEC_NATIVE_EVIDENCE_UNAVAILABLE", "Projection observation marker failed"); return nullptr; }
  observation.proof.assign(proof_text.begin(), proof_text.end()); observation.key_id = verifier->key.key_id; observation.channel_marker = mini_lux::sec03::HexBytes(marker.data(), marker.size()); napi_value result;
  if (!FrozenObservationObject(env, observation, &result)) { Throw(env, "EXEC_NATIVE_EVIDENCE_UNAVAILABLE", "Projection observation result failed"); return nullptr; } return result;
}

napi_value OpenEvidenceVerifier(napi_env env, napi_callback_info info) {
  size_t argc = 5; napi_value argv[5];
  if (!Ok(env, napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr), "Cannot read evidence identity") || argc != 5) return nullptr;
  std::array<std::string, 5> identities;
  for (size_t i = 0; i < identities.size(); ++i) {
    size_t length = 0; if (napi_get_value_string_utf8(env, argv[i], nullptr, 0, &length) != napi_ok || length != 64) { Throw(env, "EXEC_NATIVE_IDENTITY_INVALID", "Evidence identity arguments are invalid"); return nullptr; }
    std::vector<char> text(length + 1); napi_get_value_string_utf8(env, argv[i], text.data(), text.size(), &length); identities[i].assign(text.data(), length);
    if (!mini_lux::sec03::CanonicalHex(identities[i], 32, 32)) { Throw(env, "EXEC_NATIVE_IDENTITY_INVALID", "Evidence identity arguments are invalid"); return nullptr; }
  }
  const auto& [candidate, build, source, host, launcher] = identities;
  if (!FixedEvidenceIdentity(host, launcher)) { Throw(env, "EXEC_NATIVE_IDENTITY_INVALID", "Evidence verifier differs from fixed native artifacts"); return nullptr; }
  std::string binding; if (!mini_lux::sec03::AttestationBindingDigest(candidate, build, source, host, launcher, &binding)) { Throw(env, "EXEC_NATIVE_IDENTITY_INVALID", "Evidence binding is invalid"); return nullptr; }
  auto verifier = std::make_unique<EvidenceVerifier>(); verifier->candidate = candidate; verifier->build = build; verifier->source = source; verifier->host = host; verifier->launcher = launcher;
  if (!mini_lux::sec03::ProvisionAttestationKey(binding, launcher, &verifier->key)) { Throw(env, "EXEC_NATIVE_EVIDENCE_UNAVAILABLE", "Native evidence key is unavailable"); return nullptr; }
  napi_value object, value, fn; napi_create_object(env, &object); napi_wrap(env, object, verifier.get(), FinalizeEvidenceVerifier, nullptr, nullptr); napi_create_string_utf8(env, verifier->key.key_id.c_str(), NAPI_AUTO_LENGTH, &value); napi_set_named_property(env, object, "keyId", value); napi_create_function(env, "verifyExecutionProof", NAPI_AUTO_LENGTH, VerifyExecutionProof, nullptr, &fn); napi_set_named_property(env, object, "verifyExecutionProof", fn); napi_create_function(env, "verifyLauncherObservation", NAPI_AUTO_LENGTH, VerifyLauncherObservation, nullptr, &fn); napi_set_named_property(env, object, "verifyLauncherObservation", fn); napi_create_function(env, "createProjectionObservation", NAPI_AUTO_LENGTH, CreateProjectionObservation, nullptr, &fn); napi_set_named_property(env, object, "createProjectionObservation", fn); verifier.release(); return object;
}

napi_value Init(napi_env env, napi_value exports) {
  napi_value fn, loader, recovery_observer, version; napi_create_function(env, "openExclusiveHostLease", NAPI_AUTO_LENGTH, OpenExclusiveHostLease, nullptr, &fn); napi_create_function(env, "loadValidatedTestProjection", NAPI_AUTO_LENGTH, LoadValidatedTestProjection, nullptr, &loader); napi_set_named_property(env, fn, "loadValidatedTestProjection", loader); napi_create_function(env, "observeInvalidRecoveryJournal", NAPI_AUTO_LENGTH, ObserveInvalidRecoveryJournal, nullptr, &recovery_observer); napi_set_named_property(env, fn, "observeInvalidRecoveryJournal", recovery_observer); napi_set_named_property(env, exports, "openExclusiveHostLease", fn);
  napi_create_function(env, "openEvidenceVerifier", NAPI_AUTO_LENGTH, OpenEvidenceVerifier, nullptr, &fn); napi_set_named_property(env, exports, "openEvidenceVerifier", fn);
  napi_create_uint32(env, kProtocolVersion, &version); napi_set_named_property(env, exports, "protocolVersion", version);
#ifdef MINI_LUX_SEC03_NATIVE_TEST
  napi_create_function(env, "openAclSharingLeaseForTest", NAPI_AUTO_LENGTH, OpenAclSharingLeaseForTest, nullptr, &fn); napi_set_named_property(env, exports, "openAclSharingLeaseForTest", fn);
  napi_create_function(env, "openWindowsExecutableIdentityLeaseForTest", NAPI_AUTO_LENGTH, OpenTestExecutableIdentityLease, nullptr, &fn); napi_set_named_property(env, exports, "openWindowsExecutableIdentityLeaseForTest", fn);
  napi_create_function(env, "observeWindowsProcessReferencesForTest", NAPI_AUTO_LENGTH, ObserveWindowsProcessReferencesForTest, nullptr, &fn); napi_set_named_property(env, exports, "observeWindowsProcessReferencesForTest", fn);
  napi_create_function(env, "observeWindowsFileHandleInProcessTreeForTest", NAPI_AUTO_LENGTH, ObserveWindowsFileHandleInProcessTreeForTest, nullptr, &fn); napi_set_named_property(env, exports, "observeWindowsFileHandleInProcessTreeForTest", fn);
  napi_create_function(env, "observeWindowsKnownFolderPathsForTest", NAPI_AUTO_LENGTH, ObserveWindowsKnownFolderPathsForTest, nullptr, &fn); napi_set_named_property(env, exports, "observeWindowsKnownFolderPathsForTest", fn);
  napi_create_function(env, "observeWindowsRegistryKeyForTest", NAPI_AUTO_LENGTH, ObserveWindowsRegistryKeyForTest, nullptr, &fn); napi_set_named_property(env, exports, "observeWindowsRegistryKeyForTest", fn);
  napi_create_function(env, "observeWindowsRegistrySnapshotForTest", NAPI_AUTO_LENGTH, ObserveWindowsRegistrySnapshotForTest, nullptr, &fn); napi_set_named_property(env, exports, "observeWindowsRegistrySnapshotForTest", fn);
#endif
  return exports;
}
}  // namespace

NAPI_MODULE_INIT() { return Init(env, exports); }
