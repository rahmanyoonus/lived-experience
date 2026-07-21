import { describe, expect, it } from "vitest";

import { insertTranscript, mapTextPosition } from "./textInsertion";

describe("transcript insertion", () => {
  it("appends speech by default without changing its words", () => {
    expect(
      insertTranscript("A fictional first paragraph.", "I, um, carried on.", {
        start: 29,
        end: 29,
      }).text,
    ).toBe("A fictional first paragraph.\n\nI, um, carried on.");
  });

  it("inserts at a deliberately placed selection", () => {
    expect(
      insertTranscript("Before. After.", "Spoken words.", {
        start: 8,
        end: 8,
      }).text,
    ).toBe("Before. \n\nSpoken words.\n\nAfter.");
  });

  it("keeps an insertion point anchored while the person types elsewhere", () => {
    expect(mapTextPosition("One. Two.", "New. One. Two.", 5)).toBe(10);
    expect(mapTextPosition("One. Two.", "One. Two. New.", 5)).toBe(5);
  });
});
