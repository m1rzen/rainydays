#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <bcrypt.h>
#include <node_api.h>
#include <delayimp.h>
#include <userenv.h>

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

#include "journal.h"
#include "attestation.h"

#pragma comment(lib, "bcrypt.lib")
#pragma comment(lib, "crypt32.lib")
#pragma comment(lib, "advapi32.lib")
#pragma comment(lib, "userenv.lib")
#pragma comment(lib, "shell32.lib")
#pragma comment(lib, "ole32.lib")

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
  bool Parse(Json* out) { return Utf8() && Value(out, 0) && pos_ == text_.size(); }
 private:
  bool Utf8() const { return !text_.empty() && MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text_.data(), static_cast<int>(text_.size()), nullptr, 0) > 0; }
  bool Take(const char* value) { const size_t n = strlen(value); if (text_.compare(pos_, n, value)) return false; pos_ += n; return true; }
  bool Value(Json* out, unsigned depth) {
    if (depth > 20 || pos_ >= text_.size()) return false;
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
  bool Array(Json* out, unsigned depth) { out->kind = Json::Kind::array; ++pos_; if (pos_ < text_.size() && text_[pos_] == ']') { ++pos_; return true; } for (;;) { Json item; if (!Value(&item, depth)) return false; out->array.push_back(std::move(item)); if (pos_ >= text_.size()) return false; if (text_[pos_] == ']') { ++pos_; return true; } if (text_[pos_++] != ',') return false; } }
  bool Object(Json* out, unsigned depth) { out->kind = Json::Kind::object; ++pos_; if (pos_ < text_.size() && text_[pos_] == '}') { ++pos_; return true; } for (;;) { if (pos_ >= text_.size() || text_[pos_] != '"') return false; std::string key; if (!String(&key) || pos_ >= text_.size() || text_[pos_++] != ':' || out->object.count(key)) return false; Json item; if (!Value(&item, depth)) return false; out->object.emplace(std::move(key), std::move(item)); if (pos_ >= text_.size()) return false; if (text_[pos_] == '}') { ++pos_; return true; } if (text_[pos_++] != ',') return false; } }
  const std::string& text_; size_t pos_ = 0;
};

const Json* Field(const Json& value, const char* key, Json::Kind kind) { const auto it = value.object.find(key); return it != value.object.end() && it->second.kind == kind ? &it->second : nullptr; }
bool ExactKeys(const Json& value, std::initializer_list<const char*> keys) { if (value.kind != Json::Kind::object || value.object.size() != keys.size()) return false; return std::all_of(keys.begin(), keys.end(), [&](const char* key) { return value.object.count(key) == 1; }); }
std::wstring Wide(const std::string& text) { const int n = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text.data(), static_cast<int>(text.size()), nullptr, 0); if (n <= 0) return {}; std::wstring result(n, L'\0'); MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text.data(), static_cast<int>(text.size()), result.data(), n); return result; }
uint64_t FileId(const BY_HANDLE_FILE_INFORMATION& value) { return (static_cast<uint64_t>(value.nFileIndexHigh) << 32) | value.nFileIndexLow; }
bool ParseUnsigned(const std::string& text, uint64_t* out) { if (text.empty() || !std::all_of(text.begin(), text.end(), [](char c) { return c >= '0' && c <= '9'; })) return false; char* end = nullptr; const auto value = _strtoui64(text.c_str(), &end, 10); if (!end || *end) return false; *out = value; return true; }

struct Lease {
  HANDLE file = INVALID_HANDLE_VALUE;
  std::wstring path;
  std::string sha256;
  std::string launcher_sha256;
  BY_HANDLE_FILE_INFORMATION identity{};
  bool closed = false;
};

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
  DWORD pid = 0;
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
  bool proof_seen = false;
  bool protocol_failed = false;
  std::atomic<bool> terminate_sent{false};
  std::atomic<bool> closed{false};
};

struct Dispatch {
  Execution* execution;
  std::vector<uint8_t> frame;
  bool completion;
  DWORD exit_code;
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

bool IsAmd64Pe(HANDLE file) {
  IMAGE_DOS_HEADER dos{}; DWORD count = 0; LARGE_INTEGER offset{};
  if (!SetFilePointerEx(file, offset, nullptr, FILE_BEGIN) || !ReadFile(file, &dos, sizeof(dos), &count, nullptr) || count != sizeof(dos) || dos.e_magic != IMAGE_DOS_SIGNATURE || dos.e_lfanew <= 0) return false;
  offset.QuadPart = dos.e_lfanew; DWORD signature = 0; IMAGE_FILE_HEADER header{};
  const bool valid = SetFilePointerEx(file, offset, nullptr, FILE_BEGIN) && ReadFile(file, &signature, sizeof(signature), &count, nullptr) && count == sizeof(signature) && signature == IMAGE_NT_SIGNATURE && ReadFile(file, &header, sizeof(header), &count, nullptr) && count == sizeof(header) && header.Machine == IMAGE_FILE_MACHINE_AMD64;
  offset.QuadPart = 0; SetFilePointerEx(file, offset, nullptr, FILE_BEGIN);
  return valid;
}

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

bool SameIdentity(const Lease& lease, DWORD pid) {
  HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (!process) return false;
  std::vector<wchar_t> path(32768); DWORD count = static_cast<DWORD>(path.size());
  bool same = false;
  if (QueryFullProcessImageNameW(process, 0, path.data(), &count)) {
    HANDLE image = CreateFileW(std::wstring(path.data(), count).c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (image != INVALID_HANDLE_VALUE) {
      BY_HANDLE_FILE_INFORMATION identity{}; std::string digest;
      same = GetFileInformationByHandle(image, &identity) && identity.dwVolumeSerialNumber == lease.identity.dwVolumeSerialNumber && identity.nFileIndexHigh == lease.identity.nFileIndexHigh && identity.nFileIndexLow == lease.identity.nFileIndexLow && Sha256Handle(image, &digest) && digest == lease.sha256;
      CloseHandle(image);
    }
  }
  CloseHandle(process); return same;
}

std::string ExtractExecutionId(const std::string& json) {
  const std::string marker = "\"executionId\":\""; const auto start = json.find(marker);
  if (start == std::string::npos) return {};
  const auto value = start + marker.size(); const auto end = json.find('"', value);
  if (end == std::string::npos || end - value > 128) return {};
  return json.substr(value, end - value);
}

enum class ProofFrame { ordinary, valid, invalid };
ProofFrame CaptureProofFrame(Execution* execution, const std::vector<uint8_t>& frame) {
  if (frame.size() < 5) return ProofFrame::invalid; std::string json(reinterpret_cast<const char*>(frame.data() + 4), frame.size() - 4); Json parsed;
  if (!Parser(json).Parse(&parsed) || parsed.kind != Json::Kind::object) return ProofFrame::ordinary;
  const Json* kind = Field(parsed, "kind", Json::Kind::string); if (!kind) return ProofFrame::ordinary;
  const Json* version = Field(parsed, "version", Json::Kind::number); const Json* proof_hex = Field(parsed, "proofHex", Json::Kind::string); const Json* mac = Field(parsed, "mac", Json::Kind::string); const Json* key_id = Field(parsed, "keyId", Json::Kind::string);
  if (execution->proof_seen || !ExactKeys(parsed, {"keyId", "kind", "mac", "proofHex", "version"}) || kind->scalar != "native-proof" || !version || version->scalar != "1" || !proof_hex || !mac || !key_id || !mini_lux::sec03::CanonicalHex(proof_hex->scalar, 1, mini_lux::sec03::kMaxProofBytes) || !mini_lux::sec03::CanonicalHex(mac->scalar, 32, 32) || !mini_lux::sec03::CanonicalHex(key_id->scalar, 32, 32)) return ProofFrame::invalid;
  std::vector<unsigned char> proof; std::map<std::string, std::string> fields; if (!mini_lux::sec03::Unhex(proof_hex->scalar, &proof) || proof.size() > mini_lux::sec03::kMaxProofBytes || !mini_lux::sec03::ParseCanonicalProof(std::string(proof.begin(), proof.end()), execution->candidate_sha256, execution->build_sha256, execution->source_sha256, execution->host_sha256, execution->launcher_sha256, key_id->scalar, &fields) || fields.at("execution") != execution->execution_id) return ProofFrame::invalid;
  execution->native_proof.assign(proof.begin(), proof.end()); execution->native_proof_mac = mac->scalar; execution->native_proof_key_id = key_id->scalar; execution->proof_seen = true; return ProofFrame::valid;
}

DWORD ProofHostExitCode(const std::map<std::string, std::string>& fields) {
  const auto reason = fields.find("completionReason"); if (reason == fields.end()) return 1;
  if (reason->second == "completed") return 0; if (reason->second == "protocol-invalid") return 71; if (reason->second == "limit-wall") return 80; if (reason->second == "limit-idle") return 81; if (reason->second == "limit-output") return 82; if (reason->second == "cancelled") return 83; if (reason->second == "cleanup-failed") return 75; return 1;
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
    const char* reason = "host-failed";
    switch (dispatch->exit_code) {
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

void ReaderMain(Execution* execution) {
  for (;;) {
    uint8_t header[4]{};
    if (!ReadExact(execution->events, header, sizeof(header))) break;
    const uint32_t size = (static_cast<uint32_t>(header[0]) << 24) | (static_cast<uint32_t>(header[1]) << 16) | (static_cast<uint32_t>(header[2]) << 8) | header[3];
    if (!size || size > kMaxFrame) break;
    auto dispatch = std::make_unique<Dispatch>(); dispatch->execution = execution; dispatch->completion = false;
    dispatch->frame.resize(size + 4); memcpy(dispatch->frame.data(), header, 4);
    if (!ReadExact(execution->events, dispatch->frame.data() + 4, size)) break;
    const ProofFrame proof = CaptureProofFrame(execution, dispatch->frame); if (proof == ProofFrame::valid) continue; if (proof == ProofFrame::invalid) { execution->protocol_failed = true; continue; }
    napi_call_threadsafe_function(execution->tsfn, dispatch.release(), napi_tsfn_blocking);
  }
  WaitForSingleObject(execution->process, INFINITE); DWORD code = 1; GetExitCodeProcess(execution->process, &code); if (execution->proof_seen && !CreateLauncherChannelMarker(execution, code)) execution->protocol_failed = true;
  auto completion = std::make_unique<Dispatch>(); completion->execution = execution; completion->completion = true; completion->exit_code = code;
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
  if (execution->process) CloseHandle(execution->process);
  delete execution;
}

Lease* GetLease(napi_env env, napi_callback_info info, size_t* argc, napi_value* argv, napi_value* self) {
  if (!Ok(env, napi_get_cb_info(env, info, argc, argv, self, nullptr), "Cannot read lease arguments")) return nullptr;
  Lease* lease = nullptr;
  if (!Ok(env, napi_unwrap(env, *self, reinterpret_cast<void**>(&lease)), "Invalid host lease") || !lease || lease->closed || lease->file == INVALID_HANDLE_VALUE) { Throw(env, "EXEC_NATIVE_LEASE_CLOSED", "Host lease is closed"); return nullptr; }
  return lease;
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
  if (!is_buffer || napi_get_buffer_info(env, argv[0], &data, &size) != napi_ok || !AuthenticatedControlFrame(data, size, "input", execution->control_secret, &authenticated)) { Throw(env, "EXEC_NATIVE_PROTOCOL", "Input frame is invalid"); return nullptr; }
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

#ifdef MINI_LUX_SEC03_NATIVE_TEST
napi_value CrashHostForTest(napi_env env, napi_callback_info info) {
  size_t argc = 0; Execution* execution = GetExecution(env, info, &argc, nullptr);
  if (!execution || argc != 0) return nullptr;
  if (!TerminateProcess(execution->process, 0xE3A0)) { Throw(env, "EXEC_NATIVE_IO", "Test host crash failed"); return nullptr; }
  return ResolvedPromise(env);
}
#endif

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

bool OpenTrustedRoots(const Json& launch, std::vector<TrustedRootHandle>* opened, std::string* handles_json) {
  const Json* roots = Field(launch, "roots", Json::Kind::array);
  if (!roots || roots->array.empty() || roots->array.size() > 8) return false;
  std::ostringstream wire; wire << "[";
  for (size_t index = 0; index < roots->array.size(); ++index) {
    const Json& root = roots->array[index];
    if (!ExactKeys(root, {"access", "canonicalCwd", "canonicalPath", "cwdIdentity", "identity", "rootId"})) return false;
    const Json* path = Field(root, "canonicalPath", Json::Kind::string); const Json* cwd = Field(root, "canonicalCwd", Json::Kind::string); const Json* cwd_identity = Field(root, "cwdIdentity", Json::Kind::object); const Json* access = Field(root, "access", Json::Kind::string); const Json* identity = Field(root, "identity", Json::Kind::object);
    if (!path || !cwd || !cwd_identity || !access || !identity || (access->scalar != "read" && access->scalar != "read-write") || !ExactKeys(*identity, {"fileId", "type", "volumeSerial"}) || !ExactKeys(*cwd_identity, {"fileId", "type", "volumeSerial"})) return false;
    const Json* volume = Field(*identity, "volumeSerial", Json::Kind::string); const Json* file = Field(*identity, "fileId", Json::Kind::string); const Json* type = Field(*identity, "type", Json::Kind::string); const Json* cwd_volume = Field(*cwd_identity, "volumeSerial", Json::Kind::string); const Json* cwd_file = Field(*cwd_identity, "fileId", Json::Kind::string); const Json* cwd_type = Field(*cwd_identity, "type", Json::Kind::string);
    uint64_t expected_volume = 0, expected_file = 0, expected_cwd_volume = 0, expected_cwd_file = 0; const std::wstring canonical = Wide(path->scalar); const std::wstring canonical_cwd = Wide(cwd->scalar);
    if (!volume || !file || !type || !cwd_volume || !cwd_file || !cwd_type || type->scalar != "directory" || cwd_type->scalar != "directory" || canonical.empty() || canonical_cwd.empty() || !ParseUnsigned(volume->scalar, &expected_volume) || !ParseUnsigned(file->scalar, &expected_file) || !ParseUnsigned(cwd_volume->scalar, &expected_cwd_volume) || !ParseUnsigned(cwd_file->scalar, &expected_cwd_file)) return false;
    TrustedRootHandle value; value.handle = CreateFileW(canonical.c_str(), READ_CONTROL | WRITE_DAC | FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
    if (value.handle == INVALID_HANDLE_VALUE || !GetFileInformationByHandle(value.handle, &value.identity) || !(value.identity.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) || (value.identity.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT)) return false;
    std::array<wchar_t, 32768> final_path{}; const DWORD final_count = GetFinalPathNameByHandleW(value.handle, final_path.data(), static_cast<DWORD>(final_path.size()), FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
    std::array<wchar_t, MAX_PATH> volume_path{}; std::array<wchar_t, 32> filesystem{}; DWORD serial = 0;
    if (!final_count || final_count >= final_path.size() || !GetVolumePathNameW(final_path.data(), volume_path.data(), static_cast<DWORD>(volume_path.size())) || GetDriveTypeW(volume_path.data()) != DRIVE_FIXED || !GetVolumeInformationW(volume_path.data(), nullptr, 0, &serial, nullptr, nullptr, filesystem.data(), static_cast<DWORD>(filesystem.size())) || _wcsicmp(filesystem.data(), L"NTFS") != 0) return false;
    if (serial != value.identity.dwVolumeSerialNumber || expected_volume != value.identity.dwVolumeSerialNumber || expected_file != FileId(value.identity) || !SetHandleInformation(value.handle, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT)) return false;
    value.cwd_handle = CreateFileW(canonical_cwd.c_str(), FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr); if (value.cwd_handle == INVALID_HANDLE_VALUE || !GetFileInformationByHandle(value.cwd_handle, &value.cwd_identity) || !(value.cwd_identity.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) || (value.cwd_identity.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) || expected_cwd_volume != value.cwd_identity.dwVolumeSerialNumber || expected_cwd_file != FileId(value.cwd_identity)) return false;
    std::array<wchar_t, 32768> final_cwd{}; const DWORD cwd_count = GetFinalPathNameByHandleW(value.cwd_handle, final_cwd.data(), static_cast<DWORD>(final_cwd.size()), FILE_NAME_NORMALIZED | VOLUME_NAME_DOS); if (!cwd_count || cwd_count >= final_cwd.size()) return false; std::wstring root_name(final_path.data(), final_count), cwd_name(final_cwd.data(), cwd_count); if (cwd_name.size() < root_name.size() || _wcsnicmp(cwd_name.c_str(), root_name.c_str(), root_name.size()) != 0 || (cwd_name.size() > root_name.size() && cwd_name[root_name.size()] != L'\\')) return false;
    if (!SetHandleInformation(value.cwd_handle, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT)) return false;
    if (index) wire << ','; wire << "{\"cwdHandleValue\":\"" << reinterpret_cast<uintptr_t>(value.cwd_handle) << "\",\"handleValue\":\"" << reinterpret_cast<uintptr_t>(value.handle) << "\",\"rootIndex\":" << index << "}";
    opened->push_back(std::move(value));
  }
  wire << "]"; *handles_json = wire.str(); return true;
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
  return a.candidate_host_sha256 == b.candidate_host_sha256 && a.launcher_sha256 == b.launcher_sha256 && a.execution_id == b.execution_id && a.context_id == b.context_id && a.session_id == b.session_id && a.run_id == b.run_id && a.authority_epoch == b.authority_epoch && a.profile == b.profile && a.sid_string == b.sid_string && a.sid_bytes == b.sid_bytes && a.root_path == b.root_path && a.volume == b.volume && a.file == b.file && a.access_mask == b.access_mask && a.acl_digest == b.acl_digest && a.ace == b.ace && a.host_pid == b.host_pid && a.host_created == b.host_created;
}
bool OwnedHostAlive(const mini_lux::sec03::JournalRecord& record) { HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, record.host_pid); if (!process) return false; FILETIME created{}, exited{}, kernel{}, user{}; const bool same = GetProcessTimes(process, &created, &exited, &kernel, &user) && mini_lux::sec03::FileTimeValue(created) == record.host_created && WaitForSingleObject(process, 0) == WAIT_TIMEOUT; CloseHandle(process); return same; }
bool SameAcl(PACL a, PACL b) { return a && b && a->AclSize == b->AclSize && memcmp(a, b, a->AclSize) == 0; }
bool SameAceSequence(PACL a, PACL b) { if (!a || !b || a->AceCount != b->AceCount) return false; for (DWORD i = 0; i < a->AceCount; ++i) { void* x = nullptr; void* y = nullptr; if (!GetAce(a, i, &x) || !GetAce(b, i, &y)) return false; const auto* xh = static_cast<ACE_HEADER*>(x); const auto* yh = static_cast<ACE_HEADER*>(y); if (xh->AceSize != yh->AceSize || memcmp(x, y, xh->AceSize)) return false; } return true; }
unsigned ExactAceCount(PACL acl, const std::vector<unsigned char>& exact) { unsigned count = 0; for (DWORD i = 0; acl && i < acl->AceCount; ++i) { void* ace = nullptr; if (!GetAce(acl, i, &ace)) return UINT_MAX; const auto* header = static_cast<ACE_HEADER*>(ace); if (header->AceSize == exact.size() && memcmp(ace, exact.data(), exact.size()) == 0) ++count; } return count; }
bool QualifyRecoveryRoot(HANDLE root, const mini_lux::sec03::JournalRecord& record) {
  BY_HANDLE_FILE_INFORMATION identity{}; std::array<wchar_t, 32768> final{}; std::array<wchar_t, MAX_PATH> volume_path{}; std::array<wchar_t, 32> filesystem{}; DWORD serial = 0; const DWORD n = GetFinalPathNameByHandleW(root, final.data(), static_cast<DWORD>(final.size()), FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
  return GetFileInformationByHandle(root, &identity) && (identity.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) && !(identity.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) && identity.dwVolumeSerialNumber == record.volume && FileId(identity) == record.file && n && n < final.size() && GetVolumePathNameW(final.data(), volume_path.data(), static_cast<DWORD>(volume_path.size())) && GetDriveTypeW(volume_path.data()) == DRIVE_FIXED && GetVolumeInformationW(volume_path.data(), nullptr, 0, &serial, nullptr, nullptr, filesystem.data(), static_cast<DWORD>(filesystem.size())) && serial == identity.dwVolumeSerialNumber && _wcsicmp(filesystem.data(), L"NTFS") == 0;
}
bool RemoveExactAce(HANDLE root, const mini_lux::sec03::JournalRecord& record) {
  if (!QualifyRecoveryRoot(root, record)) return false; PACL current = nullptr; PSECURITY_DESCRIPTOR descriptor = nullptr; if (GetSecurityInfo(root, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, nullptr, nullptr, &current, nullptr, &descriptor) != ERROR_SUCCESS || !current) return false;
  const unsigned matches = ExactAceCount(current, record.ace); if (matches == UINT_MAX || matches > 1) { LocalFree(descriptor); return false; } if (matches == 0) { LocalFree(descriptor); return true; }
  DWORD bytes = sizeof(ACL); for (DWORD i = 0; i < current->AceCount; ++i) { void* ace = nullptr; GetAce(current, i, &ace); const auto* header = static_cast<ACE_HEADER*>(ace); if (!(header->AceSize == record.ace.size() && memcmp(ace, record.ace.data(), record.ace.size()) == 0)) bytes += header->AceSize; }
  std::vector<unsigned char> storage(bytes); PACL cleaned = reinterpret_cast<PACL>(storage.data()); bool ok = InitializeAcl(cleaned, bytes, ACL_REVISION); for (DWORD i = 0; ok && i < current->AceCount; ++i) { void* ace = nullptr; GetAce(current, i, &ace); const auto* header = static_cast<ACE_HEADER*>(ace); if (header->AceSize == record.ace.size() && memcmp(ace, record.ace.data(), record.ace.size()) == 0) continue; ok = AddAce(cleaned, ACL_REVISION, MAXDWORD, ace, header->AceSize); }
  PACL barrier = nullptr; PSECURITY_DESCRIPTOR barrier_descriptor = nullptr; if (ok) ok = GetSecurityInfo(root, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, nullptr, nullptr, &barrier, nullptr, &barrier_descriptor) == ERROR_SUCCESS && SameAcl(current, barrier); if (ok) ok = SetSecurityInfo(root, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, nullptr, nullptr, cleaned, nullptr) == ERROR_SUCCESS;
  PACL observed = nullptr; PSECURITY_DESCRIPTOR observed_descriptor = nullptr; if (ok) ok = GetSecurityInfo(root, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, nullptr, nullptr, &observed, nullptr, &observed_descriptor) == ERROR_SUCCESS && ExactAceCount(observed, record.ace) == 0 && SameAceSequence(cleaned, observed);
  if (observed_descriptor) LocalFree(observed_descriptor); if (barrier_descriptor) LocalFree(barrier_descriptor); LocalFree(descriptor); return ok;
}
struct JournalGroup { std::map<unsigned, std::wstring> published; std::map<unsigned, std::wstring> temporary; };
bool JournalName(const std::wstring& name, std::wstring* prefix, unsigned* generation, bool* temporary) {
  if (name.size() != 45 || name.rfind(L"txn-", 0) != 0 || name[36] != L'.') return false; for (size_t i = 4; i < 36; ++i) if (!((name[i] >= L'0' && name[i] <= L'9') || (name[i] >= L'a' && name[i] <= L'f'))) return false;
  unsigned value = 0; for (size_t i = 37; i < 41; ++i) { if (name[i] < L'0' || name[i] > L'9') return false; value = value * 10 + static_cast<unsigned>(name[i] - L'0'); } if (value < 1 || value > 9999) return false; const std::wstring ext = name.substr(41); if (ext != L".jrn" && ext != L".tmp") return false; *prefix = name.substr(0, 36); *generation = static_cast<unsigned>(value); *temporary = ext == L".tmp"; return true;
}
bool RecoverJournals(const std::string& candidate, const std::string& launcher) {
  mini_lux::sec03::JournalDirectoryLease directory; if (!mini_lux::sec03::JournalDirectory(&directory)) return false; std::map<std::wstring, JournalGroup> groups; WIN32_FIND_DATAW data{}; HANDLE search = FindFirstFileW((directory.path + L"\\*").c_str(), &data); if (search == INVALID_HANDLE_VALUE) return GetLastError() == ERROR_FILE_NOT_FOUND;
  bool names_ok = true; do { const std::wstring name = data.cFileName; if ((data.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) && (name == L"." || name == L"..")) continue; std::wstring prefix; unsigned generation = 0; bool temporary = false; if ((data.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) || !JournalName(name, &prefix, &generation, &temporary)) { names_ok = false; break; } auto& target = temporary ? groups[prefix].temporary : groups[prefix].published; if (!target.emplace(generation, directory.path + L"\\" + name).second) { names_ok = false; break; } } while (FindNextFileW(search, &data)); FindClose(search); if (!names_ok) return false;
  for (auto& [prefix, group] : groups) {
    if (group.published.empty()) return false; for (unsigned i = 1; i <= group.published.size(); ++i) if (!group.published.count(i)) return false;
    if (group.temporary.size() > 1 || (!group.temporary.empty() && group.temporary.begin()->first != group.published.size() + 1)) return false;
    mini_lux::sec03::JournalRecord first{}, latest{}; const std::array<const char*, 4> states = {"prepared","applied","job-zero","removed"};
    for (unsigned i = 1; i <= group.published.size(); ++i) { std::string wire; mini_lux::sec03::JournalRecord current{}; if (!ReadSmallFile(group.published.at(i), &wire) || !mini_lux::sec03::ParseJournal(wire, &current) || current.generation != i || i > states.size() || current.state != states[i - 1] || (i > 1 && !SameJournalIdentity(first, current))) return false; if (i == 1) first = current; latest = current; }
    if (latest.candidate_host_sha256 != candidate || latest.launcher_sha256 != launcher || OwnedHostAlive(latest)) return false;
    const HRESULT deleted = DeleteAppContainerProfile(latest.profile.c_str()); if (deleted != S_OK && deleted != HRESULT_FROM_WIN32(ERROR_NOT_FOUND)) return false;
    TrustedRootHandle root; root.handle = CreateFileW(latest.root_path.c_str(), READ_CONTROL | WRITE_DAC | FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr); if (root.handle == INVALID_HANDLE_VALUE || !RemoveExactAce(root.handle, latest)) return false;
    for (const auto& [generation, file] : group.published) if (!DeleteFileW(file.c_str())) return false; for (const auto& [generation, file] : group.temporary) if (!DeleteFileW(file.c_str())) return false;
  }
  return true;
}

napi_value LaunchHost(napi_env env, napi_callback_info info) {
  size_t argc = 2; napi_value argv[2], self; Lease* lease = GetLease(env, info, &argc, argv, &self);
  if (!lease || argc != 2) return nullptr;
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
  const Json* candidate_identity = Field(parsed, "candidateId", Json::Kind::string); const Json* build_identity = Field(parsed, "buildIdSha256", Json::Kind::string); const Json* source_identity = Field(parsed, "sourceSha256", Json::Kind::string); const Json* host_slot = Field(parsed, "hostSha256", Json::Kind::string); const Json* launcher_slot = Field(parsed, "launcherSha256", Json::Kind::string);
  if (!candidate_identity || !build_identity || !source_identity || !host_slot || !launcher_slot || !mini_lux::sec03::CanonicalHex(candidate_identity->scalar, 32, 32) || !mini_lux::sec03::CanonicalHex(build_identity->scalar, 32, 32) || !mini_lux::sec03::CanonicalHex(source_identity->scalar, 32, 32) || host_slot->scalar != std::string(64, '0') || launcher_slot->scalar != std::string(64, '0')) { Throw(env, "EXEC_NATIVE_PROTOCOL", "Launch frame candidate identity is invalid"); return nullptr; }
  const std::string candidate_sha256 = candidate_identity->scalar, build_sha256 = build_identity->scalar, source_sha256 = source_identity->scalar;
  std::vector<TrustedRootHandle> root_handles; std::string root_handles_json;
  if (!OpenTrustedRoots(parsed, &root_handles, &root_handles_json)) { Throw(env, "EXEC_ROOT_UNSUPPORTED", "Root identity or local NTFS policy mismatch"); return nullptr; }
  const Json* entry_point = Field(parsed, "entryPoint", Json::Kind::string); TrustedRootHandle executable_handle; std::string executable_sha256; const bool has_executable = entry_point && entry_point->scalar == "E3";
  if (has_executable && !OpenCurrentExecutable(&executable_handle, &executable_sha256)) { Throw(env, "EXEC_NATIVE_IDENTITY_INVALID", "Current script executable lease is invalid"); return nullptr; }
  if (json.empty() || json.back() != '}') { Throw(env, "EXEC_NATIVE_PROTOCOL", "Launch frame body is invalid"); return nullptr; }
  json.insert(json.size() - 1, ",\"rootHandles\":" + root_handles_json + ",\"executableHandle\":" + (has_executable ? (std::string("{\"fileId\":\"") + std::to_string(FileId(executable_handle.identity)) + "\",\"handleValue\":\"" + std::to_string(reinterpret_cast<uintptr_t>(executable_handle.handle)) + "\",\"sha256\":\"" + executable_sha256 + "\",\"volumeSerial\":\"" + std::to_string(executable_handle.identity.dwVolumeSerialNumber) + "\"}") : "null"));
  const std::string host_placeholder = "\"hostSha256\":\"0000000000000000000000000000000000000000000000000000000000000000\"";
  const auto host_position = json.find(host_placeholder); if (host_position == std::string::npos || json.find(host_placeholder, host_position + 1) != std::string::npos) { Throw(env, "EXEC_NATIVE_PROTOCOL", "Launch frame lacks host identity slot"); return nullptr; }
  json.replace(host_position + 14, 64, lease->sha256);
  const std::string launcher_placeholder = "\"launcherSha256\":\"0000000000000000000000000000000000000000000000000000000000000000\""; const auto launcher_position = json.find(launcher_placeholder); if (launcher_position == std::string::npos || json.find(launcher_placeholder, launcher_position + 1) != std::string::npos) { Throw(env, "EXEC_NATIVE_PROTOCOL", "Launch frame lacks launcher identity slot"); return nullptr; } json.replace(launcher_position + 18, 64, lease->launcher_sha256);
#ifdef MINI_LUX_SEC03_NATIVE_TEST
  std::array<char, 32> crash{}; const DWORD crash_count = GetEnvironmentVariableA("MINI_LUX_SEC03_NATIVE_TEST_CRASH", crash.data(), static_cast<DWORD>(crash.size())); std::string crash_value = crash_count && crash_count < crash.size() ? std::string(crash.data(), crash_count) : "none"; if (crash_value != "none" && crash_value != "prepared" && crash_value != "applied" && crash_value != "job-zero" && crash_value != "hold-applied") { Throw(env, "EXEC_NATIVE_PROTOCOL", "Native test crash marker is invalid"); return nullptr; } json.insert(json.size() - 1, ",\"testCrash\":\"" + crash_value + "\"");
#endif
  const std::string placeholder = "\"secret\":\"0000000000000000000000000000000000000000000000000000000000000000\"";
  const auto secret_position = json.find(placeholder);
  if (secret_position == std::string::npos || json.find(placeholder, secret_position + 1) != std::string::npos) { Throw(env, "EXEC_NATIVE_PROTOCOL", "Launch frame lacks the one-use secret slot"); return nullptr; }
  std::array<uint8_t, 32> random{};
  if (BCryptGenRandom(nullptr, random.data(), static_cast<ULONG>(random.size()), BCRYPT_USE_SYSTEM_PREFERRED_RNG) < 0) { Throw(env, "EXEC_NATIVE_UNAVAILABLE", "Cannot create launch secret"); return nullptr; }
  const std::string secret = Hex(random.data(), random.size());
  json.replace(secret_position + 10, 64, secret);
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
  if (!WriteExact(control_write, frame.data(), static_cast<DWORD>(frame.size()))) {
    TerminateProcess(process.hProcess, 0xE003); CloseHandle(process.hProcess); CloseHandle(control_write); CloseHandle(event_read); Throw(env, "EXEC_NATIVE_IO", "Cannot authenticate fixed host"); return nullptr;
  }

  auto execution = std::make_unique<Execution>(); execution->process = process.hProcess; execution->control = control_write; execution->events = event_read; execution->pid = process.dwProcessId; execution->execution_id = execution_id; execution->candidate_sha256 = candidate_sha256; execution->build_sha256 = build_sha256; execution->source_sha256 = source_sha256; execution->host_sha256 = lease->sha256; execution->launcher_sha256 = lease->launcher_sha256; execution->control_secret = secret; execution->env = env; std::string attestation_binding; if (mini_lux::sec03::AttestationBindingDigest(candidate_sha256, build_sha256, source_sha256, lease->sha256, lease->launcher_sha256, &attestation_binding)) mini_lux::sec03::LoadAttestationKey(attestation_binding, lease->launcher_sha256, &execution->attestation_key);
  napi_value promise; napi_create_promise(env, &execution->completion, &promise);
  napi_value resource_name; napi_create_string_utf8(env, "mini-lux-sec03-host", NAPI_AUTO_LENGTH, &resource_name);
  if (napi_create_threadsafe_function(env, argv[1], nullptr, resource_name, 0, 1, nullptr, nullptr, nullptr, CallJs, &execution->tsfn) != napi_ok) {
    TerminateProcess(process.hProcess, 0xE003); CloseHandle(process.hProcess); CloseHandle(control_write); CloseHandle(event_read); Throw(env, "EXEC_NATIVE_ABI_ERROR", "Cannot create host event dispatcher"); return nullptr;
  }
  napi_value object, value, fn; napi_create_object(env, &object);
  napi_create_string_utf8(env, execution_id.c_str(), NAPI_AUTO_LENGTH, &value); napi_set_named_property(env, object, "executionId", value);
  napi_set_named_property(env, object, "completed", promise);
  napi_create_function(env, "writeFrame", NAPI_AUTO_LENGTH, WriteFrame, nullptr, &fn); napi_set_named_property(env, object, "writeFrame", fn);
  napi_create_function(env, "terminateHost", NAPI_AUTO_LENGTH, TerminateHost, nullptr, &fn); napi_set_named_property(env, object, "terminateHost", fn);
#ifdef MINI_LUX_SEC03_NATIVE_TEST
  napi_create_function(env, "crashHostForTest", NAPI_AUTO_LENGTH, CrashHostForTest, nullptr, &fn); napi_set_named_property(env, object, "crashHostForTest", fn);
#endif
  if (napi_create_reference(env, object, 1, &execution->self_reference) != napi_ok || napi_wrap(env, object, execution.get(), FinalizeExecution, nullptr, nullptr) != napi_ok) {
    if (execution->self_reference) { napi_delete_reference(env, execution->self_reference); execution->self_reference = nullptr; }
    TerminateProcess(process.hProcess, 0xE003); napi_release_threadsafe_function(execution->tsfn, napi_tsfn_abort); CloseHandle(execution->process); CloseHandle(execution->control); CloseHandle(execution->events); execution->process = nullptr; execution->control = nullptr; execution->events = nullptr; Throw(env, "EXEC_NATIVE_ABI_ERROR", "Cannot retain host execution lifetime"); return nullptr;
  }
  execution->reader = std::thread(ReaderMain, execution.get());
  execution.release(); return object;
}

napi_value CloseLease(napi_env env, napi_callback_info info) {
  size_t argc = 0; napi_value self; Lease* lease = GetLease(env, info, &argc, nullptr, &self); if (!lease) return nullptr;
  CloseHandle(lease->file); lease->file = INVALID_HANDLE_VALUE; lease->closed = true; return ResolvedPromise(env);
}

napi_value OpenExclusiveHostLease(napi_env env, napi_callback_info info) {
  size_t argc = 3; napi_value argv[3];
  if (!Ok(env, napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr), "Cannot read lease arguments") || argc != 3) return nullptr;
  size_t length = 0, launcher_length = 0; int64_t expected_bytes = 0;
  if (napi_get_value_string_utf8(env, argv[0], nullptr, 0, &length) != napi_ok || length != 64 || napi_get_value_int64(env, argv[1], &expected_bytes) != napi_ok || expected_bytes <= 0 || napi_get_value_string_utf8(env, argv[2], nullptr, 0, &launcher_length) != napi_ok || launcher_length != 64) { Throw(env, "EXEC_NATIVE_IDENTITY_INVALID", "Host identity arguments are invalid"); return nullptr; }
  std::vector<char> digest(length + 1), launcher_digest(launcher_length + 1); napi_get_value_string_utf8(env, argv[0], digest.data(), digest.size(), &length); napi_get_value_string_utf8(env, argv[2], launcher_digest.data(), launcher_digest.size(), &launcher_length); const std::string expected(digest.data(), length), expected_launcher(launcher_digest.data(), launcher_length);
  if (!mini_lux::sec03::CanonicalHex(expected, 32, 32) || !mini_lux::sec03::CanonicalHex(expected_launcher, 32, 32)) { Throw(env, "EXEC_NATIVE_IDENTITY_INVALID", "Native SHA-256 is not canonical"); return nullptr; }
  HANDLE recovery_mutex = CreateMutexW(nullptr, FALSE, L"Local\\MiniLux.SEC03.AclRecovery.v2"); if (!recovery_mutex || WaitForSingleObject(recovery_mutex, 30000) != WAIT_OBJECT_0) { if (recovery_mutex) CloseHandle(recovery_mutex); Throw(env, "EXEC_ACL_RECOVERY_REQUIRED", "ACL recovery lock is unavailable"); return nullptr; }
  const bool recovered = RecoverJournals(expected, expected_launcher); ReleaseMutex(recovery_mutex); CloseHandle(recovery_mutex); if (!recovered) { Throw(env, "EXEC_ACL_RECOVERY_REQUIRED", "ACL recovery is unresolved"); return nullptr; }
  auto lease = std::make_unique<Lease>(); lease->path = FixedHostPath(); lease->launcher_sha256 = expected_launcher; LARGE_INTEGER bytes{};
  lease->file = CreateFileW(lease->path.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL | FILE_FLAG_SEQUENTIAL_SCAN, nullptr);
  if (lease->file == INVALID_HANDLE_VALUE || !GetFileInformationByHandle(lease->file, &lease->identity) || !GetFileSizeEx(lease->file, &bytes) || bytes.QuadPart != expected_bytes || !IsAmd64Pe(lease->file) || !Sha256Handle(lease->file, &lease->sha256) || lease->sha256 != expected) {
    if (lease->file != INVALID_HANDLE_VALUE) CloseHandle(lease->file); Throw(env, "EXEC_NATIVE_IDENTITY_INVALID", "Fixed sandbox host does not match manifest"); return nullptr;
  }
  napi_value object, fn; napi_create_object(env, &object); napi_wrap(env, object, lease.get(), FinalizeLease, nullptr, nullptr);
  napi_create_function(env, "launchHost", NAPI_AUTO_LENGTH, LaunchHost, nullptr, &fn); napi_set_named_property(env, object, "launchHost", fn);
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
  napi_value object, value, fn; napi_create_object(env, &object); napi_wrap(env, object, verifier.get(), FinalizeEvidenceVerifier, nullptr, nullptr); napi_create_string_utf8(env, verifier->key.key_id.c_str(), NAPI_AUTO_LENGTH, &value); napi_set_named_property(env, object, "keyId", value); napi_create_function(env, "verifyExecutionProof", NAPI_AUTO_LENGTH, VerifyExecutionProof, nullptr, &fn); napi_set_named_property(env, object, "verifyExecutionProof", fn); verifier.release(); return object;
}

napi_value Init(napi_env env, napi_value exports) {
  napi_value fn, version; napi_create_function(env, "openExclusiveHostLease", NAPI_AUTO_LENGTH, OpenExclusiveHostLease, nullptr, &fn); napi_set_named_property(env, exports, "openExclusiveHostLease", fn);
  napi_create_function(env, "openEvidenceVerifier", NAPI_AUTO_LENGTH, OpenEvidenceVerifier, nullptr, &fn); napi_set_named_property(env, exports, "openEvidenceVerifier", fn);
  napi_create_uint32(env, kProtocolVersion, &version); napi_set_named_property(env, exports, "protocolVersion", version); return exports;
}
}  // namespace

NAPI_MODULE_INIT() { return Init(env, exports); }
