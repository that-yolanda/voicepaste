import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("@/settings/bridge", () => ({
  openHelpGuide: vi.fn(),
}));
vi.mock("@/settings/SettingsProvider", () => ({
  useSettings: () => ({ settings: { runtime: { version: "2.1.5" } } }),
}));
vi.mock("@/settings/components/UpdateButton", () => ({
  UpdateButton: () => null,
}));

import { Sidebar } from "@/settings/layout/Sidebar";

afterEach(cleanup);

it("expands the settings menu above its trigger and keeps it open after submenu navigation", () => {
  const navigate = vi.fn();
  const { rerender } = render(<Sidebar active="home" onNavigate={navigate} />);

  const trigger = screen.getByRole("button", { name: "设置" });
  const region = document.getElementById(trigger.getAttribute("aria-controls") ?? "");

  expect(trigger).toHaveAttribute("aria-expanded", "false");
  expect(region).not.toBeNull();
  expect(region).not.toHaveClass("is-open");

  fireEvent.click(trigger);

  expect(trigger).toHaveAttribute("aria-expanded", "true");
  expect(region).toHaveClass("is-open");
  expect(region?.nextElementSibling).toBe(trigger);
  expect(region?.querySelector(".absolute")).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "通用设置" }));

  expect(navigate).toHaveBeenCalledWith("app");
  expect(trigger).toHaveAttribute("aria-expanded", "true");

  rerender(<Sidebar active="app" onNavigate={navigate} />);

  expect(screen.getByRole("button", { name: "通用设置" })).toHaveAttribute("aria-current", "page");
  expect(trigger).not.toHaveAttribute("aria-current");
});

it("moves the shared indicator from the home item to a settings submenu item", () => {
  const view = render(<Sidebar active="home" onNavigate={vi.fn()} />);
  const trigger = screen.getByRole("button", { name: "设置" });
  const aside = trigger.closest("aside") as HTMLElement;
  const nav = aside.querySelector("nav") as HTMLElement;
  const home = screen.getByRole("button", { name: "首页" });
  const rect = (top: number, height: number) =>
    ({
      top,
      bottom: top + height,
      height,
      left: 0,
      right: 0,
      width: 0,
      x: 0,
      y: top,
      toJSON: () => ({}),
    }) as DOMRect;

  vi.spyOn(aside, "getBoundingClientRect").mockReturnValue(rect(100, 600));
  vi.spyOn(nav, "getBoundingClientRect").mockReturnValue(rect(100, 400));
  vi.spyOn(home, "getBoundingClientRect").mockReturnValue(rect(130, 34));
  fireEvent.scroll(nav);

  expect(aside.querySelector(".settings-sidebar-indicator")).toHaveStyle({
    transform: "translateY(30px)",
    height: "34px",
    opacity: "1",
  });

  fireEvent.click(trigger);
  const general = screen.getByRole("button", { name: "通用设置" });
  vi.spyOn(general, "getBoundingClientRect").mockReturnValue(rect(360, 34));
  view.rerender(<Sidebar active="app" onNavigate={vi.fn()} />);

  expect(aside.querySelector(".settings-sidebar-indicator")).toHaveStyle({
    transform: "translateY(260px)",
    height: "34px",
    opacity: "1",
  });
});

it("closes the settings menu when switching to another sidebar section", () => {
  const navigate = vi.fn();
  render(<Sidebar active="home" onNavigate={navigate} />);

  const trigger = screen.getByRole("button", { name: "设置" });
  fireEvent.click(trigger);
  fireEvent.click(screen.getByRole("button", { name: "首页" }));

  expect(navigate).toHaveBeenCalledWith("home");
  expect(trigger).toHaveAttribute("aria-expanded", "false");
});

it("closes on Escape and restores focus to the settings trigger", () => {
  render(<Sidebar active="home" onNavigate={vi.fn()} />);

  const trigger = screen.getByRole("button", { name: "设置" });
  fireEvent.click(trigger);
  fireEvent.keyDown(document, { key: "Escape" });

  expect(trigger).toHaveAttribute("aria-expanded", "false");
  expect(trigger).toHaveFocus();
});

it("closes when clicking outside the menu", () => {
  render(<Sidebar active="home" onNavigate={vi.fn()} />);

  const trigger = screen.getByRole("button", { name: "设置" });
  fireEvent.click(trigger);
  fireEvent.mouseDown(document.body);

  expect(trigger).toHaveAttribute("aria-expanded", "false");
});
