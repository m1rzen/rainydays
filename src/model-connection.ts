export interface ConnectionProbe {
  probe(signal: AbortSignal): Promise<void>;
}

/** Map provider failures without returning their raw body, URL, or authentication details. */
export async function probeProviderConnection(client: ConnectionProbe, signal = AbortSignal.timeout(15_000)):
Promise<Readonly<{ ok: boolean; code: string; message: string }>> {
  try {
    await client.probe(signal);
    return { ok: true, code: "CONNECTED", message: "模型连接成功。可以关闭设置，添加资料并开始任务。" };
  } catch (error) {
    const failure = error as { status?: number; name?: string; message?: string };
    if (signal.aborted || /Abort|Timeout/u.test(failure.name ?? "")) {
      return { ok: false, code: "TIMEOUT", message: "连接超时。请检查模型地址和网络后重新检测。" };
    }
    if (failure.status === 401) return { ok: false, code: "AUTHENTICATION", message: "密钥未通过验证。请检查 API Key，保存后重新检测。" };
    if (failure.status === 403) {
      return /quota|usage limit|credit|billing|额度|余额/iu.test(failure.message ?? "")
        ? { ok: false, code: "QUOTA", message: "模型额度已用完或余额不足。请在提供方恢复额度，或添加可用的模型配置。" }
        : { ok: false, code: "PERMISSION", message: "提供方拒绝访问。请检查密钥权限和模型是否可用。" };
    }
    if (failure.status === 404 || failure.status === 400) return { ok: false, code: "MODEL", message: "模型或接口地址不可用。请核对模型名称与 Base URL 后保存。" };
    if (failure.status === 429) return { ok: false, code: "RATE_LIMIT", message: "请求过于频繁或额度受限。请稍后重试，或检查提供方额度。" };
    if (failure.status && failure.status >= 500) return { ok: false, code: "PROVIDER", message: "模型服务暂时不可用。请稍后重新检测。" };
    return { ok: false, code: "NETWORK", message: "连接失败。请检查网络和模型地址后重新检测。" };
  }
}
