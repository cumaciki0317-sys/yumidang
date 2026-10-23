import React, { createContext, useContext, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { AccessibilityInfo, Keyboard, Platform, View, type TextInput, type ScrollView, type NativeSyntheticEvent, type NativeScrollEvent, type LayoutChangeEvent } from "react-native";

type ErrorTarget = { error?: string; focus: () => void; order: number };

/** Runs after React commits submitted errors, rather than focusing every invalid field. */
export function createFormErrorController(schedule: (run: () => void) => void = (run) => {
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
  else setTimeout(run, 0);
}) {
  const targets = new Map<string, ErrorTarget>();
  let nextOrder = 0;
  return {
    allocateOrder: () => nextOrder++,
    register(id: string, target: ErrorTarget) { targets.set(id, target); },
    unregister(id: string) { targets.delete(id); },
    focusFirstError() {
      schedule(() => {
        const first = [...targets.values()]
          .filter((target) => !!target.error)
          .sort((a, b) => a.order - b.order)[0];
        first?.focus();
      });
    },
  };
}
export type FormErrorController = ReturnType<typeof createFormErrorController>;
const FormErrorContext = createContext<FormErrorController | null>(null);
export function useFormErrors() {
  const [controller] = useState(createFormErrorController);
  return controller;
}
export function FormErrors({ controller, children }: {
  controller: FormErrorController; children: React.ReactNode;
}) {
  return <FormErrorContext.Provider value={controller}>{children}</FormErrorContext.Provider>;
}
/** Also supports custom required selectors: pass their real focusable control. */
export function useFormErrorTarget({ id, error, focus, order }: {
  id: string; error?: string; focus: () => void; order?: number;
}) {
  const controller = useContext(FormErrorContext);
  const registration = useRef<{ controller: FormErrorController; order: number } | null>(null);
  useLayoutEffect(() => {
    if (!controller) return;
    if (registration.current?.controller !== controller) registration.current = { controller, order: controller.allocateOrder() };
    controller.register(id, { error, focus, order: order ?? registration.current.order });
  }, [controller, id, error, focus, order]);
  useLayoutEffect(() => () => controller?.unregister(id), [controller, id]);
}

/** A focusable neutral fallback for an error whose input cause is not known. */
export function FormErrorAnchor({ id, error, order, children, accessibilityLabel }: {
  id: string; error?: string; order?: number; children: React.ReactNode; accessibilityLabel?: string;
}) {
  const target = useRef<View>(null);
  const uxFocus = useUxFocus();
  const focus = useCallback(() => uxFocus.focusTarget(target.current), [uxFocus]);
  useFormErrorTarget({ id, error, order, focus });
  return <View ref={target} accessible={!!error} collapsable={false} focusable={!!error} tabIndex={error ? -1 : undefined}
    accessibilityLabel={error ? accessibilityLabel || error : undefined}
    style={{ gap: 8 }}>{children}</View>;
}

/** Register inside the FormErrors provider while retaining a specific control's focus callback. */
export function FormErrorTarget({ id, error, order, focus, children }: {
  id: string; error?: string; order?: number; focus: () => void; children: React.ReactNode;
}) {
  useFormErrorTarget({ id, error, order, focus });
  return <>{children}</>;
}

export type UxFocusHost = View | TextInput;
type RevealMode = "start" | "nearest";
type UxViewport = {
  rememberInput: (target: UxFocusHost | null) => void;
  reveal: (target: UxFocusHost, mode: RevealMode, done?: () => void) => void;
};

/** Native keyboard focus and screen-reader focus are distinct operations. */
export function createUxFocusController(environment = {
  isWeb: () => Platform.OS === "web",
  dismissKeyboard: () => Keyboard.dismiss(),
  accessibilityFocus: (target: UxFocusHost) => AccessibilityInfo.sendAccessibilityEvent(target, "focus"),
}) {
  let viewport: UxViewport | null = null;
  let enabled = true;
  let sequence = 0;
  return {
    setEnabled(value: boolean) { enabled = value; sequence++; },
    bindViewport(value: UxViewport) {
      viewport = value;
      return () => { if (viewport === value) { viewport = null; sequence++; } };
    },
    focusTarget(target: UxFocusHost | null, options: { input?: boolean; reveal?: UxFocusHost | null } = {}) {
      if (!target || !enabled) return;
      if (environment.isWeb()) { target.focus(); return; }
      const binding = viewport;
      binding?.rememberInput(options.input ? target : null);
      if (options.input) target.focus();
      else environment.dismissKeyboard();
      const request = ++sequence;
      const announceFocus = () => {
        if (enabled && request === sequence && viewport === binding) environment.accessibilityFocus(target);
      };
      // 확인 문맥은 별도로 노출하되 접근성 초점은 실제 조작 대상에 둡니다.
      if (binding) binding.reveal(options.reveal ?? target, options.reveal ? "start" : options.input ? "nearest" : "start", announceFocus);
      else announceFocus();
    },
    revealTarget(target: UxFocusHost | null) {
      if (!target || !enabled || environment.isWeb()) return;
      sequence++;
      viewport?.rememberInput(target);
      viewport?.reveal(target, "nearest");
    },
  };
}
export type UxFocusController = ReturnType<typeof createUxFocusController>;
const UxFocusContext = createContext<UxFocusController | null>(null);
export function useUxFocus() {
  const inherited = useContext(UxFocusContext);
  const [local] = useState(createUxFocusController);
  return inherited || local;
}
export function UxFocusProvider({ controller, children }: { controller: UxFocusController; children: React.ReactNode }) {
  return <UxFocusContext.Provider value={controller}>{children}</UxFocusContext.Provider>;
}

/** The correction uses measured window coordinates, never a guessed keyboard height. */
export function uxScrollCorrection(viewport: { y: number; height: number }, target: { y: number; height: number }, keyboardTop: number | undefined, mode: RevealMode) {
  const top = viewport.y + 12;
  const bottom = Math.max(top + 1, Math.min(viewport.y + viewport.height, keyboardTop ?? Infinity) - 12);
  if (mode === "start" || target.height > bottom - top || target.y < top) return target.y - top;
  if (target.y + target.height > bottom) return target.y + target.height - bottom;
  return 0;
}

export function useUxScrollViewport(controller: UxFocusController, scrollRef: React.RefObject<ScrollView | null>) {
  const offset = useRef(0);
  const input = useRef<UxFocusHost | null>(null);
  const generation = useRef(0);
  const rememberInput = useCallback((target: UxFocusHost | null) => { input.current = target; }, []);
  const reveal = useCallback((target: UxFocusHost, mode: RevealMode, done?: () => void) => {
    const scroll = scrollRef.current;
    if (!scroll || Platform.OS === "web") { done?.(); return; }
    const request = ++generation.current;
    const nativeScroll = scroll.getNativeScrollRef();
    if (!nativeScroll) { done?.(); return; }
    nativeScroll.measureInWindow((_x, y, _width, height) => target.measureInWindow((_tx, ty, _tw, th) => {
      if (request !== generation.current || scrollRef.current !== scroll) return;
      const correction = uxScrollCorrection({ y, height }, { y: ty, height: th }, Keyboard.metrics()?.screenY, mode);
      if (Math.abs(correction) > 1) {
        const next = Math.max(0, offset.current + correction);
        offset.current = next;
        scroll.scrollTo({ y: next, animated: false });
      }
      requestAnimationFrame(() => { if (request === generation.current) done?.(); });
    }));
  }, [scrollRef]);
  useLayoutEffect(() => controller.bindViewport({ rememberInput, reveal }), [controller, rememberInput, reveal]);
  const invalidate = useCallback(() => { generation.current++; input.current = null; }, []);
  useEffect(() => {
    if (Platform.OS === "web") return;
    const update = () => { if (input.current) reveal(input.current, "nearest"); };
    const shown = Keyboard.addListener("keyboardDidShow", update);
    const changed = Keyboard.addListener("keyboardDidChangeFrame", update);
    return () => { shown.remove(); changed.remove(); invalidate(); };
  }, [reveal, invalidate]);
  const onScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => { offset.current = event.nativeEvent.contentOffset.y; }, []);
  const onLayout = useCallback(() => { if (input.current) reveal(input.current, "nearest"); }, [reveal]);
  return { onScroll, onLayout };
}

/** KAV consumes screen-space keyboard metrics, while its layout y is parent-relative. */
export function uxKeyboardVerticalOffset(rootRelativeY: number, layoutY: number, rootWindowY = 0) {
  return rootWindowY + rootRelativeY - layoutY;
}

/** The app's top-level SafeAreaProvider supplies the root's real window origin. */
export function useUxKeyboardOffset(rootWindowY = 0) {
  const [keyboardVerticalOffset, setOffset] = useState(0);
  const generation = useRef(0);
  const mounted = useRef(true);
  const sample = useRef<{ host: LayoutChangeEvent["target"]; layoutY: number } | null>(null);
  const invalidate = useCallback(() => { mounted.current = false; generation.current++; }, []);
  useLayoutEffect(() => {
    mounted.current = true;
    return invalidate;
  }, [invalidate]);
  const measure = useCallback((host: LayoutChangeEvent["target"], layoutY: number) => {
    const request = ++generation.current;
    // Android Fabric measureInWindow can subtract the status-bar inset. measure.pageY
    // is root-relative; adding the real provider frame keeps both edge-to-edge modes exact.
    host.measure((_x, _y, _width, _height, _pageX, pageY) => {
      if (!mounted.current || request !== generation.current) return;
      const next = uxKeyboardVerticalOffset(pageY, layoutY, rootWindowY);
      if (Number.isFinite(next)) setOffset(previous => previous === next ? previous : next);
    });
  }, [rootWindowY]);
  useLayoutEffect(() => {
    if (sample.current) measure(sample.current.host, sample.current.layoutY);
  }, [measure]);
  const onLayout = useCallback((event: LayoutChangeEvent) => {
    if (Platform.OS === "web") return;
    // KAV forwards its persisted event after an await; target remains the actual host.
    const next = { host: event.target, layoutY: event.nativeEvent.layout.y };
    sample.current = next;
    measure(next.host, next.layoutY);
  }, [measure]);
  return { keyboardVerticalOffset, onLayout };
}
