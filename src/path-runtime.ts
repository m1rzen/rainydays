import { PathDeniedError, PathPolicy, type PathAuthority, type PathRootInput } from "./path-policy.js";

/**
 * Process-local PathPolicy security boundary. Authorities are private objects issued by this instance;
 * creating another PathPolicy cannot forge or use them.
 */
export const pathPolicy = new PathPolicy({
  auditSink: (event) => {
    console.warn(JSON.stringify({ component: "path-policy", ...event }));
  },
});

/** OS network-drive requests can outlive the UI request. Never publish their late authority. */
export class DirectoryConnectionTimeoutError extends PathDeniedError {
  constructor() { super("PATH_ROOT_UNAVAILABLE", "目录连接超时；请检查网络，或在设置中重新选择本地目录。"); }
}

export async function createRuntimePathAuthority(inputs: readonly PathRootInput[], timeoutMs = 1500): Promise<PathAuthority> {
  let expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const opening = pathPolicy.createAuthority(inputs).then(authority => {
    if (expired) pathPolicy.revoke(authority);
    return authority;
  });
  try {
    return await Promise.race([opening, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        expired = true;
        reject(new DirectoryConnectionTimeoutError());
      }, timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}
