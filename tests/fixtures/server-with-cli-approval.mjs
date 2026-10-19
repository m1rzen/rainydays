// Test-only private host: no model, key or consent bypass is shipped to the app.
await import("./server-with-test-protector.mjs");
const { registerNativeProcessConsentHandler } = await import("../../dist/index.js");
registerNativeProcessConsentHandler(() => "approve");
