import { createRoot } from "react-dom/client";

import "@fontsource-variable/newsreader";
import "@fontsource-variable/public-sans";

import { App } from "./App";
import "./styles.css";

const root = document.getElementById("root");

if (!root) {
  throw new Error("The application root is missing.");
}

const applicationRoot = createRoot(root);
const visualisationPreviewRequested =
  import.meta.env.DEV &&
  new URLSearchParams(window.location.search).get("visualise-preview") === "1";

if (visualisationPreviewRequested) {
  void import("./dev/StoryVisualisationPreview").then(
    ({ StoryVisualisationPreview }) => {
      applicationRoot.render(<StoryVisualisationPreview />);
    },
  );
} else {
  applicationRoot.render(<App />);
}
