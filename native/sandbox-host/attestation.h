#pragma once

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <bcrypt.h>
#include <dpapi.h>
#include <shlobj.h>

#include <algorithm>
#include <array>
#include <cstdint>
#include <map>
#include <string>
#include <vector>

#include "journal.h"

namespace mini_lux::sec03 {

inline constexpr char kAttestationDomain[] = "mini-lux/sec03/native-execution-proof/v1";
inline constexpr char kLauncherObservationMarkerDomain[] = "mini-lux/sec03/launcher-observation-marker/v1";
inline constexpr size_t kAttestationKeyBytes = 32;
inline constexpr size_t kMaxProofBytes = 64u * 1024u;

struct AttestationKey {
  std::array<unsigned char, kAttestationKeyBytes> bytes{};
  std::string key_id;
  bool available = false;
  ~AttestationKey() { SecureZeroMemory(bytes.data(), bytes.size()); }
  AttestationKey() = default;
  AttestationKey(const AttestationKey&) = delete;
  AttestationKey& operator=(const AttestationKey&) = delete;
};

inline void AppendU32(std::vector<unsigned char>* out, std::uint32_t value) {
  out->push_back(static_cast<unsigned char>(value)); out->push_back(static_cast<unsigned char>(value >> 8));
  out->push_back(static_cast<unsigned char>(value >> 16)); out->push_back(static_cast<unsigned char>(value >> 24));
}
inline bool ReadU32(const std::vector<unsigned char>& value, size_t offset, std::uint32_t* out) {
  if (offset + 4 > value.size()) return false;
  *out = static_cast<std::uint32_t>(value[offset]) | (static_cast<std::uint32_t>(value[offset + 1]) << 8)
    | (static_cast<std::uint32_t>(value[offset + 2]) << 16) | (static_cast<std::uint32_t>(value[offset + 3]) << 24); return true;
}
inline bool AttestationBindingDigest(const std::string& candidate, const std::string& build, const std::string& source, const std::string& host, const std::string& launcher, std::string* out) {
  if (!CanonicalHex(candidate, 32, 32) || !CanonicalHex(build, 32, 32) || !CanonicalHex(source, 32, 32) || !CanonicalHex(host, 32, 32) || !CanonicalHex(launcher, 32, 32)) return false;
  std::string material; const auto append = [&](const std::string& value) { material.append(value); material.push_back('\0'); };
  append(kAttestationDomain); append("candidate"); append(candidate); append("build"); append(build); append("source"); append(source); append("host"); append(host); append("launcher"); append(launcher);
  return Sha256(reinterpret_cast<const unsigned char*>(material.data()), material.size(), out);
}
inline std::vector<unsigned char> AttestationEntropy(const std::string& candidate, const std::string& launcher) {
  std::vector<unsigned char> value; const auto append = [&](const std::string& text) { value.insert(value.end(), text.begin(), text.end()); value.push_back(0); };
  append(kAttestationDomain); append(candidate); append(launcher); return value;
}
inline bool AttestationKeyId(const std::array<unsigned char, kAttestationKeyBytes>& key, const std::string& candidate, const std::string& launcher, std::string* out) {
  auto material = AttestationEntropy(candidate, launcher); material.insert(material.begin(), key.begin(), key.end()); return Sha256(material.data(), material.size(), out);
}
inline bool AttestationDirectory(JournalDirectoryLease* output) {
  PWSTR known = nullptr; if (SHGetKnownFolderPath(FOLDERID_LocalAppData, KF_FLAG_DEFAULT, nullptr, &known) != S_OK || !known) return false;
  std::wstring base(known); CoTaskMemFree(known); JournalDirectoryLease base_lease; if (!QualifyFixedNtfsDirectory(base, &base_lease)) return false;
  const std::wstring mini = base + L"\\Mini-Lux"; if (!CreateDirectoryW(mini.c_str(), nullptr) && GetLastError() != ERROR_ALREADY_EXISTS) return false;
  JournalDirectoryLease mini_lease; if (!QualifyFixedNtfsDirectory(mini, &mini_lease)) return false;
  const std::wstring leaf = mini + L"\\sec03-attestation-v1"; if (!CreateDirectoryW(leaf.c_str(), nullptr) && GetLastError() != ERROR_ALREADY_EXISTS) return false;
  return QualifyFixedNtfsDirectory(leaf, output);
}
inline std::wstring AttestationKeyPath(const JournalDirectoryLease& directory, const std::string& candidate, const std::string& launcher) {
  return directory.path + L"\\" + std::wstring(candidate.begin(), candidate.end()) + L"-" + std::wstring(launcher.begin(), launcher.end()) + L".key";
}
inline bool QualifiedKeyFile(const std::wstring& path, const JournalDirectoryLease& directory, HANDLE* output) {
  HANDLE file = CreateFileW(path.c_str(), GENERIC_READ | FILE_READ_ATTRIBUTES | READ_CONTROL, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
  if (file == INVALID_HANDLE_VALUE) return false; BY_HANDLE_FILE_INFORMATION info{}; std::array<wchar_t, 32768> final{}; std::array<wchar_t, MAX_PATH> volume{}; std::array<wchar_t, 32> fs{}; DWORD serial = 0;
  const DWORD count = GetFinalPathNameByHandleW(file, final.data(), static_cast<DWORD>(final.size()), FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
  const std::wstring prefix = directory.path + L"\\";
  const bool ok = GetFileInformationByHandle(file, &info) && !(info.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT))
    && count && count < final.size() && std::wstring(final.data(), count).rfind(prefix, 0) == 0
    && GetVolumePathNameW(final.data(), volume.data(), static_cast<DWORD>(volume.size())) && GetDriveTypeW(volume.data()) == DRIVE_FIXED
    && GetVolumeInformationW(volume.data(), nullptr, 0, &serial, nullptr, nullptr, fs.data(), static_cast<DWORD>(fs.size()))
    && serial == info.dwVolumeSerialNumber && _wcsicmp(fs.data(), L"NTFS") == 0 && TrustedDirectorySecurity(file);
  if (!ok) { CloseHandle(file); return false; } *output = file; return true;
}
inline bool ReadAllBounded(HANDLE file, std::vector<unsigned char>* out) {
  LARGE_INTEGER size{}; if (!GetFileSizeEx(file, &size) || size.QuadPart < 148 || size.QuadPart > 16384) return false;
  out->resize(static_cast<size_t>(size.QuadPart)); DWORD got = 0; return ReadFile(file, out->data(), static_cast<DWORD>(out->size()), &got, nullptr) && got == out->size();
}
inline bool DecodeProtectedKey(const std::vector<unsigned char>& encoded, const std::string& candidate, const std::string& launcher, AttestationKey* out) {
  static constexpr char magic[] = "MLSEC03KEY1!"; constexpr size_t header = 12 + 4 + 4 + 64 + 64;
  std::uint32_t version = 0, protected_bytes = 0; if (encoded.size() < header || memcmp(encoded.data(), magic, 12) || !ReadU32(encoded, 12, &version) || version != 1 || !ReadU32(encoded, 16, &protected_bytes)
    || protected_bytes < 16 || protected_bytes > 8192 || encoded.size() != header + protected_bytes
    || memcmp(encoded.data() + 20, candidate.data(), 64) || memcmp(encoded.data() + 84, launcher.data(), 64)) return false;
  auto entropy = AttestationEntropy(candidate, launcher); DATA_BLOB input{protected_bytes, const_cast<BYTE*>(encoded.data() + header)}; DATA_BLOB extra{static_cast<DWORD>(entropy.size()), entropy.data()}; DATA_BLOB clear{};
  if (!CryptUnprotectData(&input, nullptr, &extra, nullptr, nullptr, CRYPTPROTECT_UI_FORBIDDEN, &clear) || clear.cbData != kAttestationKeyBytes || !clear.pbData) { if (clear.pbData) LocalFree(clear.pbData); return false; }
  memcpy(out->bytes.data(), clear.pbData, out->bytes.size()); SecureZeroMemory(clear.pbData, clear.cbData); LocalFree(clear.pbData);
  if (!AttestationKeyId(out->bytes, candidate, launcher, &out->key_id)) { SecureZeroMemory(out->bytes.data(), out->bytes.size()); return false; }
  out->available = true; return true;
}
inline bool LoadAttestationKey(const std::string& candidate, const std::string& launcher, AttestationKey* out) {
  if (!CanonicalHex(candidate, 32, 32) || !CanonicalHex(launcher, 32, 32)) return false; JournalDirectoryLease directory; if (!AttestationDirectory(&directory)) return false;
  HANDLE file = INVALID_HANDLE_VALUE; if (!QualifiedKeyFile(AttestationKeyPath(directory, candidate, launcher), directory, &file)) return false;
  std::vector<unsigned char> encoded; const bool read = ReadAllBounded(file, &encoded); CloseHandle(file); return read && DecodeProtectedKey(encoded, candidate, launcher, out);
}
inline bool ProvisionAttestationKey(const std::string& candidate, const std::string& launcher, AttestationKey* out) {
  if (LoadAttestationKey(candidate, launcher, out)) return true;
  JournalDirectoryLease directory; if (!CanonicalHex(candidate, 32, 32) || !CanonicalHex(launcher, 32, 32) || !AttestationDirectory(&directory)) return false;
  std::array<unsigned char, kAttestationKeyBytes> raw{}; if (BCryptGenRandom(nullptr, raw.data(), static_cast<ULONG>(raw.size()), BCRYPT_USE_SYSTEM_PREFERRED_RNG) < 0) return false;
  auto entropy = AttestationEntropy(candidate, launcher); DATA_BLOB clear{static_cast<DWORD>(raw.size()), raw.data()}; DATA_BLOB extra{static_cast<DWORD>(entropy.size()), entropy.data()}; DATA_BLOB protected_blob{};
  bool ok = CryptProtectData(&clear, L"Mini-Lux SEC-03 attestation key", &extra, nullptr, nullptr, CRYPTPROTECT_UI_FORBIDDEN, &protected_blob) && protected_blob.pbData && protected_blob.cbData >= 16 && protected_blob.cbData <= 8192;
  std::vector<unsigned char> encoded; if (ok) { static constexpr char magic[] = "MLSEC03KEY1!"; encoded.insert(encoded.end(), magic, magic + 12); AppendU32(&encoded, 1); AppendU32(&encoded, protected_blob.cbData); encoded.insert(encoded.end(), candidate.begin(), candidate.end()); encoded.insert(encoded.end(), launcher.begin(), launcher.end()); encoded.insert(encoded.end(), protected_blob.pbData, protected_blob.pbData + protected_blob.cbData); }
  if (protected_blob.pbData) { SecureZeroMemory(protected_blob.pbData, protected_blob.cbData); LocalFree(protected_blob.pbData); }
  GUID guid{}; CoCreateGuid(&guid); wchar_t suffix[80]{}; StringFromGUID2(guid, suffix, 80); const std::wstring final_path = AttestationKeyPath(directory, candidate, launcher); const std::wstring temp_path = directory.path + L"\\.tmp-" + suffix;
  HANDLE temp = ok ? CreateFileW(temp_path.c_str(), GENERIC_WRITE | READ_CONTROL, 0, nullptr, CREATE_NEW, FILE_ATTRIBUTE_TEMPORARY | FILE_FLAG_OPEN_REPARSE_POINT, nullptr) : INVALID_HANDLE_VALUE;
  if (temp != INVALID_HANDLE_VALUE && TrustedDirectorySecurity(temp)) { DWORD wrote = 0; ok = WriteFile(temp, encoded.data(), static_cast<DWORD>(encoded.size()), &wrote, nullptr) && wrote == encoded.size() && FlushFileBuffers(temp); } else ok = false;
  if (temp != INVALID_HANDLE_VALUE) CloseHandle(temp);
  if (ok) ok = MoveFileExW(temp_path.c_str(), final_path.c_str(), MOVEFILE_WRITE_THROUGH) != FALSE;
  if (!ok) { const DWORD error = GetLastError(); DeleteFileW(temp_path.c_str()); if (error != ERROR_ALREADY_EXISTS && error != ERROR_FILE_EXISTS) { SecureZeroMemory(raw.data(), raw.size()); return false; } }
  SecureZeroMemory(raw.data(), raw.size()); return LoadAttestationKey(candidate, launcher, out);
}
inline bool HmacSha256(const AttestationKey& key, const unsigned char* data, size_t size, std::array<unsigned char, 32>* output) {
  if (!key.available || size > kMaxProofBytes) return false; BCRYPT_ALG_HANDLE algorithm = nullptr; BCRYPT_HASH_HANDLE hash = nullptr; DWORD object_bytes = 0, hash_bytes = 0, got = 0; std::vector<unsigned char> object; bool ok = false;
  if (BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, BCRYPT_ALG_HANDLE_HMAC_FLAG) < 0) goto done;
  if (BCryptGetProperty(algorithm, BCRYPT_OBJECT_LENGTH, reinterpret_cast<PUCHAR>(&object_bytes), sizeof(object_bytes), &got, 0) < 0 || BCryptGetProperty(algorithm, BCRYPT_HASH_LENGTH, reinterpret_cast<PUCHAR>(&hash_bytes), sizeof(hash_bytes), &got, 0) < 0 || hash_bytes != output->size()) goto done;
  object.resize(object_bytes); if (BCryptCreateHash(algorithm, &hash, object.data(), object_bytes, const_cast<PUCHAR>(key.bytes.data()), static_cast<ULONG>(key.bytes.size()), 0) < 0 || BCryptHashData(hash, const_cast<PUCHAR>(data), static_cast<ULONG>(size), 0) < 0 || BCryptFinishHash(hash, output->data(), static_cast<ULONG>(output->size()), 0) < 0) goto done; ok = true;
done: if (hash) BCryptDestroyHash(hash); if (algorithm) BCryptCloseAlgorithmProvider(algorithm, 0); return ok;
}
inline bool ConstantTimeEqual(const unsigned char* left, const unsigned char* right, size_t size) { unsigned char diff = 0; for (size_t i = 0; i < size; ++i) diff |= left[i] ^ right[i]; return diff == 0; }
inline bool ParseCanonicalProof(const std::string& proof, const std::string& candidate, const std::string& build, const std::string& source, const std::string& host, const std::string& launcher, const std::string& key_id, std::map<std::string, std::string>* fields) {
  static const std::array<const char*, 72> keys = {"v","kind","keyId","candidate","buildIdSha256","sourceSha256","hostSha256","launcher","execution","context","session","run","authorityEpoch","profile","payloadDigest","tokenIsAppContainer","packageSidSha256","capabilityCount","lowIntegrity","jobConstrained","jobPolicySha256","activeProcessZero","processStarts","observedProcessCount","observedDescendantCount","descendantValidationFailures","aclMutations","stdinWrites","inputDigestSetSha256","conpty","conptyMerged","executableLease","sentinelHandleInheritable","sentinelHandleListed","sentinelHandleObserved","sentinelProbeWin32","unlistedSentinelBlocked","hostDupOpenWin32","jobHandleInheritable","controlHandleInheritable","jobHandleDuplicateWin32","controlHandleDuplicateWin32","jobHandleDuplicateBlocked","controlHandleDuplicateBlocked","postAclRootDeleteOpenWin32","postAclCwdDeleteOpenWin32","postAclReplacementBlocked","processCreatedSuspended","postCreateRootDeleteOpenWin32","postCreateCwdDeleteOpenWin32","postCreateReplacementBlocked","preResumePathIdentityMatch","resumeAfterRecheck","childExit","completionReason","aggregateOutputBytes","cleanupComplete","handlesDrained","treeTerminated","rootIdentityDigest","rootAccessProfileSha256","rootFixedNtfs","rootSameSystemVolume","rootHasSpace","rootHasNonAscii","environmentNameDigest","environmentValueDigest","ambientLeakCount","networkMode","networkAcceptedCount","aclProfileSha256","transcriptSha256"};
  if (proof.empty() || proof.size() > kMaxProofBytes || proof.back() != '\n' || proof.find('\r') != std::string::npos) return false; size_t start = 0;
  for (const char* expected : keys) { const size_t end = proof.find('\n', start); if (end == std::string::npos || end == start) return false; const std::string line = proof.substr(start, end - start); const size_t equal = line.find('='); if (equal == std::string::npos || line.find('=', equal + 1) != std::string::npos || line.substr(0, equal) != expected) return false; const std::string value = line.substr(equal + 1); if (value.empty() || value.size() > 256 || !std::all_of(value.begin(), value.end(), [](unsigned char c) { return c >= 0x21 && c <= 0x7e; })) return false; fields->emplace(expected, value); start = end + 1; }
  if (start != proof.size() || fields->size() != keys.size() || fields->at("v") != "1" || fields->at("kind") != "execution-proof" || fields->at("candidate") != candidate || fields->at("buildIdSha256") != build || fields->at("sourceSha256") != source || fields->at("hostSha256") != host || fields->at("launcher") != launcher || fields->at("keyId") != key_id) return false;
  for (const char* key : {"candidate","buildIdSha256","sourceSha256","hostSha256","launcher","keyId","payloadDigest","packageSidSha256","jobPolicySha256","inputDigestSetSha256","rootIdentityDigest","rootAccessProfileSha256","environmentNameDigest","environmentValueDigest","aclProfileSha256","transcriptSha256"}) if (!CanonicalHex(fields->at(key), 32, 32)) return false;
  for (const char* key : {"tokenIsAppContainer","lowIntegrity","jobConstrained","activeProcessZero","conpty","conptyMerged","executableLease","sentinelHandleInheritable","sentinelHandleListed","sentinelHandleObserved","unlistedSentinelBlocked","jobHandleInheritable","controlHandleInheritable","jobHandleDuplicateBlocked","controlHandleDuplicateBlocked","postAclReplacementBlocked","processCreatedSuspended","postCreateReplacementBlocked","preResumePathIdentityMatch","resumeAfterRecheck","cleanupComplete","handlesDrained","treeTerminated","rootFixedNtfs","rootSameSystemVolume","rootHasSpace","rootHasNonAscii"}) if (fields->at(key) != "0" && fields->at(key) != "1") return false;
  std::uint64_t number = 0; for (const char* key : {"authorityEpoch","capabilityCount","processStarts","observedProcessCount","observedDescendantCount","descendantValidationFailures","aclMutations","stdinWrites","sentinelProbeWin32","hostDupOpenWin32","jobHandleDuplicateWin32","controlHandleDuplicateWin32","postAclRootDeleteOpenWin32","postAclCwdDeleteOpenWin32","postCreateRootDeleteOpenWin32","postCreateCwdDeleteOpenWin32","childExit","aggregateOutputBytes","ambientLeakCount","networkAcceptedCount"}) if (!Decimal(fields->at(key), &number)) return false;
  if (fields->at("networkMode") != "deny") return false; for (const char* key : {"execution","context","session","run","profile","completionReason"}) if (!BoundedId(fields->at(key))) return false; return true;
}

inline bool LauncherObservationId(const std::string& value) {
  return BoundedId(value) && std::all_of(value.begin(), value.end(), [](unsigned char c) { return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '-' || c == '_' || c == '.' || c == ':'; });
}

inline bool LauncherObservationSentinel(const char* label, std::string* output) {
  static constexpr char domain[] = "mini-lux/sec03/launcher-sentinel/v1";
  std::vector<unsigned char> material(domain, domain + sizeof(domain) - 1); material.push_back(0);
  const std::string value(label); AppendU32(&material, static_cast<std::uint32_t>(value.size())); material.insert(material.end(), value.begin(), value.end());
  return Sha256(material.data(), material.size(), output);
}

inline const char* ServiceDenialCode(const std::string& state) {
  if (state == "missing") return "EXEC_GRANT_REQUIRED";
  if (state == "forged") return "EXEC_GRANT_FORGED";
  if (state == "argument-mismatch") return "EXEC_GRANT_ARGUMENT_MISMATCH";
  if (state == "expired") return "EXEC_GRANT_EXPIRED";
  if (state == "replayed") return "EXEC_GRANT_REPLAYED";
  if (state == "cross-run") return "EXEC_GRANT_CROSS_RUN";
  if (state == "cross-session") return "EXEC_GRANT_CROSS_SESSION";
  if (state == "concurrent-reuse") return "EXEC_GRANT_CONCURRENT_REUSE";
  if (state == "consent-denied") return "EXEC_CONSENT_DENIED";
  if (state == "consent-dismissed") return "EXEC_CONSENT_DISMISSED";
  if (state == "consent-expired") return "EXEC_CONSENT_EXPIRED";
  if (state == "consent-argument-mismatch") return "EXEC_CONSENT_ARGUMENT_MISMATCH";
  if (state == "consent-replayed") return "EXEC_CONSENT_REPLAYED";
  if (state == "consent-synthetic") return "EXEC_CONSENT_SYNTHETIC";
  if (state == "consent-cross-window") return "EXEC_CONSENT_CROSS_WINDOW";
  if (state == "consent-cross-session") return "EXEC_CONSENT_CROSS_SESSION";
  if (state == "consent-concurrent-reuse") return "EXEC_CONSENT_CONCURRENT_REUSE";
  if (state == "network-profile-unsupported") return "EXEC_NETWORK_PROFILE_UNSUPPORTED";
  return "";
}

inline bool ParseCanonicalLauncherObservation(const std::string& proof, const std::string& candidate, const std::string& build, const std::string& source, const std::string& host, const std::string& launcher, const std::string& key_id, std::map<std::string, std::string>* fields) {
  static const std::array<const char*, 68> keys = {"v","kind","keyId","candidate","buildIdSha256","sourceSha256","hostSha256","launcher","execution","context","session","run","authorityEpoch","entryPoint","profile","operation","decisionState","personaDigest","policyDigest","payloadDigest","stimulusDigest","requestDigest","rootRequestDigest","observationClass","raceStage","rootFailureClass","expectedRootIdentityDigest","observedRootIdentityDigest","observedCode","observedSubcode","transcriptSha256","tokenIsAppContainer","packageSidSha256","capabilityCount","lowIntegrity","jobConstrained","jobPolicySha256","activeProcessZero","processStarts","profileCreates","journalWrites","aclMutations","stdinWrites","inputDigestSetSha256","conpty","conptyMerged","executableLease","childExit","completionReason","aggregateOutputBytes","cleanupComplete","jobClosed","handlesDrained","hostExited","treeTerminated","rootIdentityDigest","rootAccessProfileSha256","rootFixedNtfs","rootSameSystemVolume","rootHasSpace","rootHasNonAscii","environmentNameDigest","environmentValueDigest","ambientLeakCount","networkMode","networkAttemptCount","networkAcceptedCount","aclProfileSha256"};
  if (!fields || proof.empty() || proof.size() > kMaxProofBytes || proof.back() != '\n' || proof.find('\r') != std::string::npos) return false; size_t start = 0;
  fields->clear();
  for (const char* expected : keys) { const size_t end = proof.find('\n', start); if (end == std::string::npos || end == start) return false; const std::string line = proof.substr(start, end - start); const size_t equal = line.find('='); if (equal == std::string::npos || line.find('=', equal + 1) != std::string::npos || line.substr(0, equal) != expected) return false; const std::string value = line.substr(equal + 1); if (value.empty() || value.size() > 256 || !std::all_of(value.begin(), value.end(), [](unsigned char c) { return c >= 0x21 && c <= 0x7e; })) return false; fields->emplace(expected, value); start = end + 1; }
  if (start != proof.size() || fields->size() != keys.size() || fields->at("v") != "1" || fields->at("kind") != "launcher-observation" || fields->at("candidate") != candidate || fields->at("buildIdSha256") != build || fields->at("sourceSha256") != source || fields->at("hostSha256") != host || fields->at("launcher") != launcher || fields->at("keyId") != key_id) return false;
  for (const char* key : {"candidate","buildIdSha256","sourceSha256","hostSha256","launcher","keyId","personaDigest","policyDigest","payloadDigest","stimulusDigest","requestDigest","rootRequestDigest","expectedRootIdentityDigest","observedRootIdentityDigest","transcriptSha256","packageSidSha256","jobPolicySha256","inputDigestSetSha256","rootIdentityDigest","rootAccessProfileSha256","environmentNameDigest","environmentValueDigest","aclProfileSha256"}) if (!CanonicalHex(fields->at(key), 32, 32)) return false;
  for (const char* key : {"execution","context","session","run"}) if (!LauncherObservationId(fields->at(key))) return false;
  std::uint64_t authority = 0; if (!Decimal(fields->at("authorityEpoch"), &authority) || !authority) return false;
  const bool profile_pair = (fields->at("entryPoint") == "E1" && fields->at("profile") == "one-shot-shell") || (fields->at("entryPoint") == "E2" && fields->at("profile") == "agent-shell") || (fields->at("entryPoint") == "E3" && fields->at("profile") == "script") || (fields->at("entryPoint") == "E4" && fields->at("profile") == "manual-terminal");
  const std::string& observation_class = fields->at("observationClass"); const std::string& race_stage = fields->at("raceStage"); const std::string& root_failure_class = fields->at("rootFailureClass"); const std::string& expected_identity = fields->at("expectedRootIdentityDigest"); const std::string& observed_identity = fields->at("observedRootIdentityDigest"); const std::string& observed_code = fields->at("observedCode");
  const bool root_attempt = fields->at("operation") == "launch" && fields->at("decisionState") == "none";
  const bool unsupported = root_attempt && observation_class == "unsupported-root" && race_stage == "root-qualification" && observed_code == "EXEC_ROOT_UNSUPPORTED" && expected_identity == observed_identity
    && (root_failure_class == "unc" || root_failure_class == "mapped-remote" || root_failure_class == "non-ntfs" || root_failure_class == "removable-ntfs" || root_failure_class == "reparse-root");
  const bool identity_changed = root_attempt && observation_class == "root-identity-changed" && race_stage == "before-retained-handle" && root_failure_class == "none" && observed_code == "EXEC_ROOT_IDENTITY_CHANGED" && expected_identity != observed_identity;
  std::string root_not_consumed; const std::string& denial_state = fields->at("decisionState"); const char* denial_code = ServiceDenialCode(denial_state);
  const bool consent_state = denial_state.rfind("consent-", 0) == 0;
  const bool network_profile_unsupported = denial_state == "network-profile-unsupported";
  const bool grant_denial_pair = !consent_state && !network_profile_unsupported && (((fields->at("entryPoint") == "E1" || fields->at("entryPoint") == "E3") && fields->at("operation") == "launch") || (fields->at("entryPoint") == "E2" && fields->at("operation") == "input"));
  const bool consent_denial_pair = consent_state && fields->at("entryPoint") == "E4" && fields->at("profile") == "manual-terminal" && fields->at("operation") == "consent";
  const bool network_denial_pair = network_profile_unsupported && fields->at("entryPoint") == "E4" && fields->at("profile") == "manual-terminal" && fields->at("operation") == "launch";
  const bool service_denial = LauncherObservationSentinel("root-not-consumed", &root_not_consumed) && (grant_denial_pair || consent_denial_pair || network_denial_pair) && denial_code[0] && observed_code == denial_code
    && observation_class == "service-denial" && race_stage == "trusted-service-decision" && root_failure_class == "none" && expected_identity == root_not_consumed && observed_identity == root_not_consumed && fields->at("rootIdentityDigest") == root_not_consumed;
  if (!profile_pair || (!unsupported && !identity_changed && !service_denial) || (!service_denial && fields->at("rootIdentityDigest") != expected_identity) || fields->at("observedSubcode") != "none" || fields->at("completionReason") != "pre-host-denial" || fields->at("childExit") != "none" || fields->at("networkMode") != "deny") return false;
  for (const char* key : {"tokenIsAppContainer","capabilityCount","lowIntegrity","jobConstrained","processStarts","profileCreates","journalWrites","aclMutations","stdinWrites","conpty","conptyMerged","executableLease","aggregateOutputBytes","rootSameSystemVolume","rootHasSpace","rootHasNonAscii","ambientLeakCount","networkAttemptCount","networkAcceptedCount"}) if (fields->at(key) != "0") return false;
  if (fields->at("rootFixedNtfs") != (identity_changed ? "1" : "0")) return false;
  for (const char* key : {"activeProcessZero","cleanupComplete","jobClosed","handlesDrained","hostExited","treeTerminated"}) if (fields->at(key) != "1") return false;
  return true;
}

inline std::string LauncherObservationMarkerPayload(const std::map<std::string, std::string>& fields, const std::string& proof_sha256, const std::string& proof_mac) {
  if (!CanonicalHex(proof_sha256, 32, 32) || !CanonicalHex(proof_mac, 32, 32)) return {};
  std::string marker(kLauncherObservationMarkerDomain); marker.push_back('\0');
  marker.append("v=1\nkind=launcher-observation-marker\nkeyId=").append(fields.at("keyId"))
    .append("\ncandidate=").append(fields.at("candidate")).append("\nbuildIdSha256=").append(fields.at("buildIdSha256"))
    .append("\nsourceSha256=").append(fields.at("sourceSha256")).append("\nhostSha256=").append(fields.at("hostSha256"))
    .append("\nlauncher=").append(fields.at("launcher")).append("\nexecution=").append(fields.at("execution"))
    .append("\ncontext=").append(fields.at("context")).append("\nsession=").append(fields.at("session")).append("\nrun=").append(fields.at("run"))
    .append("\nauthorityEpoch=").append(fields.at("authorityEpoch")).append("\nentryPoint=").append(fields.at("entryPoint")).append("\nprofile=").append(fields.at("profile"))
    .append("\noperation=").append(fields.at("operation")).append("\ndecisionState=").append(fields.at("decisionState"))
    .append("\npersonaDigest=").append(fields.at("personaDigest")).append("\npolicyDigest=").append(fields.at("policyDigest")).append("\npayloadDigest=").append(fields.at("payloadDigest"))
    .append("\nrequestDigest=").append(fields.at("requestDigest")).append("\nrootRequestDigest=").append(fields.at("rootRequestDigest"))
    .append("\nobservationClass=").append(fields.at("observationClass")).append("\nraceStage=").append(fields.at("raceStage"))
    .append("\nrootFailureClass=").append(fields.at("rootFailureClass")).append("\nexpectedRootIdentityDigest=").append(fields.at("expectedRootIdentityDigest"))
    .append("\nobservedRootIdentityDigest=").append(fields.at("observedRootIdentityDigest")).append("\nobservedCode=").append(fields.at("observedCode"))
    .append("\nproofSha256=").append(proof_sha256).append("\nproofMac=").append(proof_mac)
    .append("\nprocessStarts=0\nhostStarted=0\n");
  return marker;
}

}  // namespace mini_lux::sec03
