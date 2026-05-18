// ─────────────────────────────────────────────────────────────
// Webview entry. The same compiled bundle is loaded into both
// the chat sidebar (WebviewView) and the plan artifact editor
// tab (WebviewPanel). The extension host writes
// `window.KLAUDE_MODE` into the panel's HTML at creation
// time so we can mount the right shell here without bouncing a
// "what mode am I in?" RPC round-trip first.
// ─────────────────────────────────────────────────────────────

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { ArtifactApp } from "./ArtifactApp";
import "./theme.css";

declare global {
  interface Window {
    KLAUDE_MODE?: "chat" | "artifact";
    KLAUDE_REVISION_ID?: string;
  }
}

const mode = window.KLAUDE_MODE ?? "chat";
const root = createRoot(document.getElementById("root")!);

root.render(
  <StrictMode>
    {mode === "artifact" && window.KLAUDE_REVISION_ID ? (
      <ArtifactApp revisionId={window.KLAUDE_REVISION_ID} />
    ) : (
      <App />
    )}
  </StrictMode>
);
