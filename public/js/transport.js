// Transport fallback chain
// Tries Epoxy first, then falls back to other transports
// Every existing proxy site just picks one and breaks if it fails

let transportReady = false;
let activeTransport = null;

export function getActiveTransport() {
  return activeTransport;
}

export function isTransportReady() {
  return transportReady;
}

// The transport is initialized via ScramjetController's wisp config
// This module tracks state for the UI
export function markTransportReady(name) {
  transportReady = true;
  activeTransport = name || "epoxy";
}
