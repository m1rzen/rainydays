import assert from "node:assert/strict";
import test from "node:test";
import { isDuplicateChatRequest, resetChatIdempotency } from "../../src/chat-idempotency.js";

// 重复消息幂等（2026-11-14 审阅补充切片6 / M2）：/api/chat 以 (sessionId, clientRequestId)
// 为幂等键做 10 分钟窗口去重。双击、网络重放、UI 重连重发在窗口内被拒绝；不同消息、
// 不同会话互不影响；窗口过期后同键可重新提交；空键跳过（向后兼容）。

test("clientRequestId 窗口去重：同键拒绝、跨会话与新键放行、过期后放行、空键跳过", () => {
  resetChatIdempotency();
  const base = Date.now();
  // 首次提交记录，窗口内重复提交拒绝。
  assert.equal(isDuplicateChatRequest("s1", "req-aaaaaaaa", base), false);
  assert.equal(isDuplicateChatRequest("s1", "req-aaaaaaaa", base + 1), true);
  assert.equal(isDuplicateChatRequest("s1", "req-aaaaaaaa", base + 5 * 60_000), true, "窗口 10 分钟内重复拒绝");
  // 新键、其他会话不受影响。
  assert.equal(isDuplicateChatRequest("s1", "req-bbbbbbbb", base + 2), false);
  assert.equal(isDuplicateChatRequest("s2", "req-aaaaaaaa", base + 3), false);
  // 窗口过期后同键重新提交放行，且旧条目被清理。
  assert.equal(isDuplicateChatRequest("s1", "req-aaaaaaaa", base + 10 * 60_000 + 1), false);
  // 空键不做去重（无键请求向后兼容）。
  assert.equal(isDuplicateChatRequest("s1", "", base + 4), false);
});
