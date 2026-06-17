// Browser entry point. Mounts <App/> into #root (see index.html) and pulls in
// the Tailwind v4 + shadcn theme (index.css) so Vite bundles a real stylesheet.

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app.js";
import "./index.css";

// Theme is owned by the ProfileProvider (it toggles .dark/.light from the
// active profile's defaultTheme). Operator (the default) → dark, identical to
// the previous hardcoded force.

const root = document.getElementById("root");
if (!root) throw new Error("crtr web: #root element not found in index.html");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
