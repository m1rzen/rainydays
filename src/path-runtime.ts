import { PathPolicy } from "./path-policy.js";

/**
 * Process-local PathPolicy security boundary. Authorities are private objects issued by this instance;
 * creating another PathPolicy cannot forge or use them.
 */
export const pathPolicy = new PathPolicy({
  auditSink: (event) => {
    console.warn(JSON.stringify({ component: "path-policy", ...event }));
  },
});
