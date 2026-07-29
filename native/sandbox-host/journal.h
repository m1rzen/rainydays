#pragma once

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <aclapi.h>
#include <bcrypt.h>
#include <sddl.h>
#include <shlobj.h>

#include <algorithm>
#include <array>
#include <cstdint>
#include <string>
#include <vector>

namespace mini_lux::sec03 {

struct JournalRecord {
  std::string candidate_host_sha256;
  std::string launcher_sha256;
  std::string execution_id;
  std::string context_id;
  std::string session_id;
  std::string run_id;
  std::uint64_t authority_epoch = 0;
  std::wstring profile;
  std::wstring sid_string;
  std::vector<unsigned char> sid_bytes;
  std::wstring root_path;
  std::uint64_t volume = 0;
  std::uint64_t file = 0;
  std::uint32_t access_mask = 0;
  std::string acl_digest;
  std::vector<unsigned char> ace;
  DWORD host_pid = 0;
  std::uint64_t host_created = 0;
  unsigned generation = 0;
  std::string state;
};

struct JournalDirectoryLease {
  std::wstring path;
  HANDLE handle = INVALID_HANDLE_VALUE;
  JournalDirectoryLease() = default;
  ~JournalDirectoryLease() { if (handle != INVALID_HANDLE_VALUE) CloseHandle(handle); }
  JournalDirectoryLease(const JournalDirectoryLease&) = delete;
  JournalDirectoryLease& operator=(const JournalDirectoryLease&) = delete;
  JournalDirectoryLease(JournalDirectoryLease&& other) noexcept : path(std::move(other.path)), handle(other.handle) { other.handle = INVALID_HANDLE_VALUE; }
};

inline std::string HexBytes(const unsigned char* bytes, size_t size) {
  static constexpr char digits[] = "0123456789abcdef"; std::string out(size * 2, '\0');
  for (size_t i = 0; i < size; ++i) { out[i * 2] = digits[bytes[i] >> 4]; out[i * 2 + 1] = digits[bytes[i] & 15]; } return out;
}
inline bool CanonicalHex(const std::string& text, size_t bytes_min, size_t bytes_max) {
  return text.size() >= bytes_min * 2 && text.size() <= bytes_max * 2 && !(text.size() & 1)
    && std::all_of(text.begin(), text.end(), [](char c) { return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'); });
}
inline bool Unhex(const std::string& text, std::vector<unsigned char>* out) {
  if (!CanonicalHex(text, 0, 1024 * 1024)) return false;
  auto nibble = [](char c) -> int { if (c >= '0' && c <= '9') return c - '0'; if (c >= 'a' && c <= 'f') return c - 'a' + 10; return -1; };
  out->clear(); out->reserve(text.size() / 2); for (size_t i = 0; i < text.size(); i += 2) out->push_back(static_cast<unsigned char>((nibble(text[i]) << 4) | nibble(text[i + 1]))); return true;
}
inline std::string HexWide(const std::wstring& value) { return HexBytes(reinterpret_cast<const unsigned char*>(value.data()), value.size() * sizeof(wchar_t)); }
inline bool UnhexWide(const std::string& text, std::wstring* out, size_t max_chars = 32767) {
  std::vector<unsigned char> bytes; if (!CanonicalHex(text, sizeof(wchar_t), max_chars * sizeof(wchar_t)) || !Unhex(text, &bytes) || bytes.size() % sizeof(wchar_t)) return false;
  out->assign(reinterpret_cast<const wchar_t*>(bytes.data()), bytes.size() / sizeof(wchar_t)); return !out->empty() && out->find(L'\0') == std::wstring::npos;
}
inline bool Decimal(const std::string& text, std::uint64_t* out) {
  if (text.empty() || (text.size() > 1 && text[0] == '0') || !std::all_of(text.begin(), text.end(), [](char c) { return c >= '0' && c <= '9'; })) return false;
  errno = 0; char* end = nullptr; const auto value = _strtoui64(text.c_str(), &end, 10); if (errno == ERANGE || !end || *end) return false; *out = value; return true;
}
inline bool BoundedId(const std::string& value) { return !value.empty() && value.size() <= 128 && std::all_of(value.begin(), value.end(), [](unsigned char c) { return c >= 0x21 && c <= 0x7e && c != '='; }); }
inline bool Sha256(const unsigned char* bytes, size_t size, std::string* output) {
  BCRYPT_ALG_HANDLE algorithm = nullptr; BCRYPT_HASH_HANDLE hash = nullptr; DWORD object_bytes = 0, hash_bytes = 0, got = 0; bool ok = false; std::vector<unsigned char> object, digest;
  if (BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0) < 0) goto done;
  if (BCryptGetProperty(algorithm, BCRYPT_OBJECT_LENGTH, reinterpret_cast<PUCHAR>(&object_bytes), sizeof(object_bytes), &got, 0) < 0 || BCryptGetProperty(algorithm, BCRYPT_HASH_LENGTH, reinterpret_cast<PUCHAR>(&hash_bytes), sizeof(hash_bytes), &got, 0) < 0) goto done;
  object.resize(object_bytes); digest.resize(hash_bytes); if (BCryptCreateHash(algorithm, &hash, object.data(), object_bytes, nullptr, 0, 0) < 0 || BCryptHashData(hash, const_cast<PUCHAR>(bytes), static_cast<ULONG>(size), 0) < 0 || BCryptFinishHash(hash, digest.data(), hash_bytes, 0) < 0) goto done;
  *output = HexBytes(digest.data(), digest.size()); ok = true;
done: if (hash) BCryptDestroyHash(hash); if (algorithm) BCryptCloseAlgorithmProvider(algorithm, 0); return ok;
}
inline std::uint64_t FileTimeValue(const FILETIME& value) { return (static_cast<std::uint64_t>(value.dwHighDateTime) << 32) | value.dwLowDateTime; }
inline bool CurrentProcessCreation(std::uint64_t* out) { FILETIME created{}, exited{}, kernel{}, user{}; return GetProcessTimes(GetCurrentProcess(), &created, &exited, &kernel, &user) && ((*out = FileTimeValue(created)), true); }
inline bool SidToBytesAndString(PSID sid, std::vector<unsigned char>* bytes, std::wstring* text) {
  if (!sid || !IsValidSid(sid)) return false; const DWORD size = GetLengthSid(sid); bytes->resize(size); if (!CopySid(size, bytes->data(), sid)) return false;
  LPWSTR value = nullptr; if (!ConvertSidToStringSidW(sid, &value) || !value) return false; text->assign(value); LocalFree(value); return !text->empty();
}
inline bool AppPackageSid(PSID sid) {
  if (!sid || !IsValidSid(sid)) return false; const SID_IDENTIFIER_AUTHORITY package = SECURITY_APP_PACKAGE_AUTHORITY; return memcmp(GetSidIdentifierAuthority(sid), &package, sizeof(package)) == 0;
}
inline bool BroadUntrustedSid(PSID sid) {
  if (!sid || !IsValidSid(sid) || AppPackageSid(sid)) return AppPackageSid(sid);
  const std::array<WELL_KNOWN_SID_TYPE, 4> broad = {WinWorldSid, WinAuthenticatedUserSid, WinBuiltinUsersSid, WinBuiltinGuestsSid};
  for (const auto kind : broad) { BYTE storage[SECURITY_MAX_SID_SIZE]{}; DWORD bytes = sizeof(storage); if (CreateWellKnownSid(kind, nullptr, storage, &bytes) && EqualSid(sid, storage)) return true; }
  return false;
}
inline bool TrustedDirectorySecurity(HANDLE directory) {
  HANDLE token = nullptr; DWORD token_bytes = 0; PSECURITY_DESCRIPTOR descriptor = nullptr; PSID owner = nullptr; PACL dacl = nullptr; bool ok = false;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) goto done; GetTokenInformation(token, TokenUser, nullptr, 0, &token_bytes); if (!token_bytes) goto done;
  { std::vector<unsigned char> user_storage(token_bytes); if (!GetTokenInformation(token, TokenUser, user_storage.data(), token_bytes, &token_bytes)) goto done; PSID user = reinterpret_cast<TOKEN_USER*>(user_storage.data())->User.Sid;
    if (GetSecurityInfo(directory, SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION, &owner, nullptr, &dacl, nullptr, &descriptor) != ERROR_SUCCESS || !owner || !dacl) goto done;
    BYTE system_buffer[SECURITY_MAX_SID_SIZE]{}, admin_buffer[SECURITY_MAX_SID_SIZE]{}; DWORD system_size = sizeof(system_buffer), admin_size = sizeof(admin_buffer);
    if (!CreateWellKnownSid(WinLocalSystemSid, nullptr, system_buffer, &system_size) || !CreateWellKnownSid(WinBuiltinAdministratorsSid, nullptr, admin_buffer, &admin_size)) goto done;
    if (!EqualSid(owner, user) && !EqualSid(owner, system_buffer) && !EqualSid(owner, admin_buffer)) goto done;
    const DWORD forbidden = FILE_GENERIC_WRITE | FILE_ADD_FILE | FILE_ADD_SUBDIRECTORY | FILE_DELETE_CHILD | DELETE | WRITE_DAC | WRITE_OWNER;
    for (DWORD i = 0; i < dacl->AceCount; ++i) { void* raw = nullptr; if (!GetAce(dacl, i, &raw)) goto done; const auto* header = static_cast<ACE_HEADER*>(raw); if (header->AceType != ACCESS_ALLOWED_ACE_TYPE) continue; const auto* ace = static_cast<ACCESS_ALLOWED_ACE*>(raw); if ((ace->Mask & forbidden) && BroadUntrustedSid(const_cast<DWORD*>(&ace->SidStart))) goto done; }
    ok = true;
  }
done: if (descriptor) LocalFree(descriptor); if (token) CloseHandle(token); return ok;
}
inline bool QualifyFixedNtfsDirectory(const std::wstring& path, JournalDirectoryLease* output) {
  HANDLE handle = CreateFileW(path.c_str(), FILE_LIST_DIRECTORY | FILE_ADD_FILE | FILE_READ_ATTRIBUTES | READ_CONTROL | SYNCHRONIZE, FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
  if (handle == INVALID_HANDLE_VALUE) return false; BY_HANDLE_FILE_INFORMATION identity{}; std::array<wchar_t, 32768> final_path{}; std::array<wchar_t, MAX_PATH> volume_path{}; std::array<wchar_t, 32> filesystem{}; DWORD serial = 0;
  const DWORD count = GetFinalPathNameByHandleW(handle, final_path.data(), static_cast<DWORD>(final_path.size()), FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
  const bool ok = GetFileInformationByHandle(handle, &identity) && (identity.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) && !(identity.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT)
    && count && count < final_path.size() && GetVolumePathNameW(final_path.data(), volume_path.data(), static_cast<DWORD>(volume_path.size())) && GetDriveTypeW(volume_path.data()) == DRIVE_FIXED
    && GetVolumeInformationW(volume_path.data(), nullptr, 0, &serial, nullptr, nullptr, filesystem.data(), static_cast<DWORD>(filesystem.size())) && _wcsicmp(filesystem.data(), L"NTFS") == 0
    && serial == identity.dwVolumeSerialNumber && TrustedDirectorySecurity(handle);
  if (!ok) { CloseHandle(handle); return false; } output->path.assign(final_path.data(), count); output->handle = handle; return true;
}
inline bool JournalDirectory(JournalDirectoryLease* output) {
  PWSTR known = nullptr; if (SHGetKnownFolderPath(FOLDERID_LocalAppData, KF_FLAG_DEFAULT, nullptr, &known) != S_OK || !known) return false; std::wstring base(known); CoTaskMemFree(known);
  std::wstring mini = base + L"\\Mini-Lux"; std::wstring leaf = L"sec03-journal-v2";
#ifdef MINI_LUX_SEC03_NATIVE_TEST
  std::array<wchar_t, 64> nonce{}; const DWORD n = GetEnvironmentVariableW(L"MINI_LUX_SEC03_NATIVE_TEST_NONCE", nonce.data(), static_cast<DWORD>(nonce.size()));
  if (n == 32 && std::all_of(nonce.begin(), nonce.begin() + n, [](wchar_t c) { return (c >= L'0' && c <= L'9') || (c >= L'a' && c <= L'f'); })) leaf += L"-test-" + std::wstring(nonce.data(), n);
#endif
  const std::wstring directory = mini + L"\\" + leaf; if (!CreateDirectoryW(mini.c_str(), nullptr) && GetLastError() != ERROR_ALREADY_EXISTS) return false;
  JournalDirectoryLease parent; if (!QualifyFixedNtfsDirectory(mini, &parent)) return false; if (!CreateDirectoryW(directory.c_str(), nullptr) && GetLastError() != ERROR_ALREADY_EXISTS) return false;
  return QualifyFixedNtfsDirectory(directory, output);
}
inline std::string SerializeJournal(const JournalRecord& value) {
  return "MLSEC03J3\n" + std::string("candidateHostSha256=") + value.candidate_host_sha256 + "\nlauncherSha256=" + value.launcher_sha256 + "\nexecutionId=" + value.execution_id
    + "\ncontextId=" + value.context_id + "\nsessionId=" + value.session_id + "\nrunId=" + value.run_id + "\nauthorityEpoch=" + std::to_string(value.authority_epoch)
    + "\nprofile=" + HexWide(value.profile) + "\nsidString=" + HexWide(value.sid_string) + "\nsidBytes=" + HexBytes(value.sid_bytes.data(), value.sid_bytes.size())
    + "\nroot=" + HexWide(value.root_path) + "\nvolume=" + std::to_string(value.volume) + "\nfile=" + std::to_string(value.file) + "\naccessMask=" + std::to_string(value.access_mask)
    + "\naclDigest=" + value.acl_digest + "\nace=" + HexBytes(value.ace.data(), value.ace.size()) + "\nhostPid=" + std::to_string(value.host_pid) + "\nhostCreated=" + std::to_string(value.host_created)
    + "\ngeneration=" + std::to_string(value.generation) + "\nstate=" + value.state + "\n";
}
inline bool ParseJournal(const std::string& wire, JournalRecord* out) {
  static constexpr std::array<const char*, 20> names = {"candidateHostSha256","launcherSha256","executionId","contextId","sessionId","runId","authorityEpoch","profile","sidString","sidBytes","root","volume","file","accessMask","aclDigest","ace","hostPid","hostCreated","generation","state"};
  if (wire.size() < 64 || wire.size() > 1024 * 1024 || wire.rfind("MLSEC03J3\n", 0) != 0 || wire.back() != '\n' || wire.find('\r') != std::string::npos || wire.find('\0') != std::string::npos) return false;
  std::array<std::string, 20> fields; size_t start = 10; for (size_t i = 0; i < names.size(); ++i) { const size_t end = wire.find('\n', start); if (end == std::string::npos) return false; const std::string prefix = std::string(names[i]) + "="; if (wire.compare(start, prefix.size(), prefix) != 0) return false; fields[i] = wire.substr(start + prefix.size(), end - start - prefix.size()); start = end + 1; } if (start != wire.size()) return false;
  std::uint64_t epoch = 0, volume = 0, file = 0, mask = 0, pid = 0, created = 0, generation = 0; std::vector<unsigned char> sid, ace; std::wstring profile, sid_string, root;
  if (!CanonicalHex(fields[0], 32, 32) || !CanonicalHex(fields[1], 32, 32) || !BoundedId(fields[2]) || !BoundedId(fields[3]) || !BoundedId(fields[4]) || !BoundedId(fields[5])
    || !Decimal(fields[6], &epoch) || !epoch || !UnhexWide(fields[7], &profile, 255) || !UnhexWide(fields[8], &sid_string, 184) || !Unhex(fields[9], &sid) || sid.empty() || sid.size() > SECURITY_MAX_SID_SIZE || !IsValidSid(sid.data())
    || !UnhexWide(fields[10], &root) || !Decimal(fields[11], &volume) || !Decimal(fields[12], &file) || !Decimal(fields[13], &mask) || !mask || mask > MAXDWORD
    || !CanonicalHex(fields[14], 32, 32) || !Unhex(fields[15], &ace) || ace.size() < sizeof(ACCESS_ALLOWED_ACE) || ace.size() > 65535 || !Decimal(fields[16], &pid) || !pid || pid > MAXDWORD
    || !Decimal(fields[17], &created) || !created || !Decimal(fields[18], &generation) || generation < 1 || generation > 9999
    || (fields[19] != "prepared" && fields[19] != "applied" && fields[19] != "job-zero" && fields[19] != "removed")) return false;
  std::vector<unsigned char> sid_from_string; PSID parsed_sid = nullptr; if (!ConvertStringSidToSidW(sid_string.c_str(), &parsed_sid) || !parsed_sid) return false; const DWORD parsed_bytes = GetLengthSid(parsed_sid); const bool sid_equal = parsed_bytes == sid.size() && memcmp(parsed_sid, sid.data(), sid.size()) == 0; LocalFree(parsed_sid); if (!sid_equal) return false;
  out->candidate_host_sha256 = fields[0]; out->launcher_sha256 = fields[1]; out->execution_id = fields[2]; out->context_id = fields[3]; out->session_id = fields[4]; out->run_id = fields[5]; out->authority_epoch = epoch; out->profile = std::move(profile); out->sid_string = std::move(sid_string); out->sid_bytes = std::move(sid); out->root_path = std::move(root); out->volume = volume; out->file = file; out->access_mask = static_cast<std::uint32_t>(mask); out->acl_digest = fields[14]; out->ace = std::move(ace); out->host_pid = static_cast<DWORD>(pid); out->host_created = created; out->generation = static_cast<unsigned>(generation); out->state = fields[19]; return true;
}
inline bool AtomicJournalWrite(const JournalDirectoryLease& directory, const std::wstring& prefix, const JournalRecord& value) {
  wchar_t suffix[32]{}; swprintf_s(suffix, L".%04u", value.generation); const std::wstring temporary = prefix + suffix + L".tmp", published = prefix + suffix + L".jrn";
  HANDLE file = CreateFileW(temporary.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_NEW, FILE_ATTRIBUTE_NORMAL | FILE_FLAG_WRITE_THROUGH, nullptr); if (file == INVALID_HANDLE_VALUE) return false;
  const std::string wire = SerializeJournal(value); DWORD written = 0; const bool ok = wire.size() <= MAXDWORD && WriteFile(file, wire.data(), static_cast<DWORD>(wire.size()), &written, nullptr) && written == wire.size() && FlushFileBuffers(file); CloseHandle(file);
  if (!ok) { DeleteFileW(temporary.c_str()); return false; } if (!MoveFileExW(temporary.c_str(), published.c_str(), MOVEFILE_WRITE_THROUGH)) { DeleteFileW(temporary.c_str()); return false; }
  if (!FlushFileBuffers(directory.handle)) { const DWORD error = GetLastError(); if (error != ERROR_INVALID_FUNCTION && error != ERROR_ACCESS_DENIED) return false; } return true;
}

}  // namespace mini_lux::sec03
