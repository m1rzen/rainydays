#pragma once

#include <cstdint>

namespace mini_lux::sec03 {

inline constexpr std::uint32_t kProtocolVersion = 1;
inline constexpr std::uint32_t kMaxControlFrame = 256u * 1024u;
inline constexpr std::uint32_t kMaxInputFrame = 64u * 1024u;
inline constexpr std::uint32_t kMaxOutputFrame = 1024u * 1024u;
inline constexpr std::uint32_t kFrameHeaderBytes = 4;

enum class State { created, constrained, running, draining, closed, failed };

enum class FrameKind : std::uint8_t {
  launch = 1,
  input = 2,
  terminate = 3,
  event = 128,
  output = 129,
};

inline constexpr char kErrProtocolInvalid[] = "EXEC_PROTOCOL_INVALID";
inline constexpr char kErrUnsupportedPlatform[] = "EXEC_NATIVE_PLATFORM_UNSUPPORTED";
inline constexpr char kErrIdentityInvalid[] = "EXEC_NATIVE_IDENTITY_INVALID";
inline constexpr char kErrRootUnsupported[] = "EXEC_ROOT_UNSUPPORTED";
inline constexpr char kErrPrimitiveUnavailable[] = "EXEC_NATIVE_PRIMITIVE_UNAVAILABLE";
inline constexpr char kErrLaunchFailed[] = "EXEC_SANDBOX_LAUNCH_FAILED";
inline constexpr char kErrTerminated[] = "EXEC_CANCELLED";

}  // namespace mini_lux::sec03
