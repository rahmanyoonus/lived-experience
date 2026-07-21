import { createRoot } from "react-dom/client";

import "@fontsource-variable/newsreader";
import "@fontsource-variable/public-sans";

import { LandingPage } from "./LandingPage";
import "./landing.css";

const root = document.getElementById("landing-root");

if (!root) {
  throw new Error("The landing page root is missing.");
}

createRoot(root).render(<LandingPage />);
