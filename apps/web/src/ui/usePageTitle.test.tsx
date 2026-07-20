import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { usePageTitle } from "./usePageTitle";

afterEach(() => cleanup());

describe("usePageTitle", () => {
  it("mounting with a title sets document.title to \"<title> · swng\"", () => {
    renderHook(() => usePageTitle("Your profile"));

    expect(document.title).toBe("Your profile · swng");
  });

  it("mounting with no title sets document.title to the bare wordmark", () => {
    renderHook(() => usePageTitle());

    expect(document.title).toBe("swng");
  });

  it("unmounting resets document.title to the bare wordmark", () => {
    const { unmount } = renderHook(() => usePageTitle("Your profile"));
    expect(document.title).toBe("Your profile · swng");

    unmount();

    expect(document.title).toBe("swng");
  });

  it("a title-prop change updates document.title", () => {
    const { rerender } = renderHook(({ title }: { title?: string }) => usePageTitle(title), { initialProps: { title: "Start a round" } });
    expect(document.title).toBe("Start a round · swng");

    rerender({ title: "Join a round" });

    expect(document.title).toBe("Join a round · swng");
  });
});
