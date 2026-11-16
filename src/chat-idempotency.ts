// 重复消息幂等（2026-11-14 审阅补充切片6 / M2）：/api/chat 以客户端生成的
// clientRequestId 为幂等键做窗口去重。双击发送、网络层重放或 UI 重连后的重复
// POST 在窗口内被拒绝，不再产生重复的 user 消息与重复 run。不带键的请求行为
// 不变（向后兼容）。状态只存内存：重启后窗口自然清空，与消息持久化无关。

const WINDOW_MS = 10 * 60_000;

const seenBySession = new Map<string, Map<string, number>>();

/** 记录并判断是否为窗口内的重复提交；true = 重复，应拒绝。 */
export function isDuplicateChatRequest(sessionId: string, clientRequestId: string, now = Date.now()): boolean {
  if (!sessionId || !clientRequestId) return false;
  let byRequest = seenBySession.get(sessionId);
  if (!byRequest) {
    byRequest = new Map();
    seenBySession.set(sessionId, byRequest);
  }
  for (const [key, seen] of byRequest) {
    if (now - seen > WINDOW_MS) byRequest.delete(key);
  }
  if (byRequest.has(clientRequestId)) return true;
  byRequest.set(clientRequestId, now);
  return false;
}

/** 测试辅助：清空全部窗口状态。 */
export function resetChatIdempotency(): void {
  seenBySession.clear();
}
