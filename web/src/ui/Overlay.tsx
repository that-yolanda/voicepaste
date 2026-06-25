import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { OverlayApp } from "./overlay/OverlayApp";
import "../styles/app.css";
import "./overlay/overlay.css";

const rootEl = document.getElementById("root");
if (rootEl) {
  createRoot(rootEl).render(
    <StrictMode>
      <OverlayApp />
    </StrictMode>,
  );
}
