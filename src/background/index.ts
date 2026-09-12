// MV3 workers are suspended when idle. Register future event listeners at
// module scope and persist durable state in chrome.storage, not globals.
export {};
