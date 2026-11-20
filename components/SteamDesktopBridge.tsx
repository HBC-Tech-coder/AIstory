"use client";

import { useEffect } from "react";

import {
  steamGamepadActionForButton,
  type SteamGamepadAction,
} from "@/lib/steam/contracts";

const FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "a[href]",
  "input:not([disabled])",
  "textarea:not([disabled])",
  "select:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

function visibleFocusableElements(): HTMLElement[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
  ).filter((element) => {
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      style.visibility !== "hidden" &&
      style.display !== "none"
    );
  });
}

function focusRelative(step: number) {
  const elements = visibleFocusableElements();
  if (!elements.length) return;
  const activeIndex = elements.indexOf(document.activeElement as HTMLElement);
  const nextIndex =
    activeIndex < 0
      ? step > 0
        ? 0
        : elements.length - 1
      : (activeIndex + step + elements.length) % elements.length;
  elements[nextIndex]?.focus({ preventScroll: false });
}

function dispatchEscape() {
  const target =
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : document.body;
  target.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "Escape",
      code: "Escape",
      bubbles: true,
      cancelable: true,
    }),
  );
}

function handleGamepadAction(action: SteamGamepadAction) {
  switch (action) {
    case "activate":
      if (document.activeElement instanceof HTMLElement) {
        document.activeElement.click();
      } else {
        focusRelative(1);
      }
      break;
    case "back":
      dispatchEscape();
      break;
    case "previous":
    case "up":
    case "left":
      focusRelative(-1);
      break;
    case "next":
    case "down":
    case "right":
      focusRelative(1);
      break;
    case "fullscreen":
      if (window.aistoryDesktop) {
        void window.aistoryDesktop.toggleFullscreen();
      } else {
        window.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "f",
            code: "KeyF",
            bubbles: true,
          }),
        );
      }
      break;
  }
}

export function SteamDesktopBridge({ enabled }: { enabled: boolean }) {
  useEffect(() => {
    if (!enabled || typeof navigator.getGamepads !== "function") return;
    let frame = 0;
    const pressed = new Map<string, boolean>();
    const tick = () => {
      for (const gamepad of navigator.getGamepads()) {
        if (!gamepad) continue;
        gamepad.buttons.forEach((button, buttonIndex) => {
          const key = `${gamepad.index}:${buttonIndex}`;
          const wasPressed = pressed.get(key) === true;
          const isPressed = button.pressed || button.value > 0.6;
          pressed.set(key, isPressed);
          if (isPressed && !wasPressed) {
            const action = steamGamepadActionForButton(buttonIndex);
            if (action) handleGamepadAction(action);
          }
        });
      }
      frame = window.requestAnimationFrame(tick);
    };
    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    const onFocusIn = (event: FocusEvent) => {
      if (!window.aistoryDesktop) return;
      const target = event.target;
      if (
        !(target instanceof HTMLInputElement) &&
        !(target instanceof HTMLTextAreaElement)
      ) {
        return;
      }
      const rect = target.getBoundingClientRect();
      void window.aistoryDesktop.requestSoftKeyboard({
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        multiline: target instanceof HTMLTextAreaElement,
      });
    };
    document.addEventListener("focusin", onFocusIn);
    return () => document.removeEventListener("focusin", onFocusIn);
  }, [enabled]);

  return null;
}
