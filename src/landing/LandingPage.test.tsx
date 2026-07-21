import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { LandingPage } from "./LandingPage";

describe("LandingPage", () => {
  it("presents implementation-grounded capture and trust claims", () => {
    render(<LandingPage />);

    expect(
      screen.getByRole("heading", {
        level: 1,
        name: "Your life. Your words.",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", {
        name: "Capture first. Make sense of it later.",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Private by default" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Saved truthfully" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "AI by invitation" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("img", {
        name: "A young woman writing a personal memory on her laptop at home.",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("img", {
        name: "An older man in his eighties speaking thoughtfully at his kitchen table.",
      }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/printed book|weekly questions|starting at \$|plans for/i),
    ).not.toBeInTheDocument();
  });

  it("keeps the capture destination unwired until it is supplied", () => {
    const { rerender } = render(<LandingPage />);
    expect(
      screen.queryByRole("link", { name: "Begin a story" }),
    ).not.toBeInTheDocument();

    rerender(<LandingPage captureHref="/future-capture" />);
    const links = screen.getAllByRole("link", { name: "Begin a story" });
    expect(links).toHaveLength(2);
    for (const link of links) {
      expect(link).toHaveAttribute("href", "/future-capture");
    }
  });
});
