import React, { useCallback, useLayoutEffect, useRef, useState } from "react";
import { BackHandler, KeyboardAvoidingView, Modal, Platform, ScrollView, View, type StyleProp, type ViewStyle } from "react-native";
import { useFocusEffect } from "expo-router";
import { useSafeAreaInsets, useSafeAreaFrame } from "react-native-safe-area-context";
import { createUxFocusController, UxFocusProvider, useUxScrollViewport, useUxKeyboardOffset, type UxFocusController } from "./ux-form";

/** Native-window dismissal (iOS/web) and committed in-tree layer removal (Android) have separate adapters. */
export function createModalLifecycle(callbacks: { shown: () => void; closed: () => void }) {
  let visible = false, shown = false, awaitingClose = false, focused = true;
  return {
    setCallbacks(next: typeof callbacks) { callbacks = next; },
    visibility(next: boolean) {
      if (visible && !next) awaitingClose = true;
      if (next) awaitingClose = false;
      visible = next;
    },
    focus(next: boolean) { focused = next; if (!next) { awaitingClose = false; shown = false; } },
    canShow: () => visible && focused && !shown,
    didShow() { if (visible && focused && !shown) { shown = true; callbacks.shown(); } },
    didClose() {
      if (!visible && awaitingClose && focused) { awaitingClose = false; shown = false; callbacks.closed(); }
    },
  };
}

/** Its fields must scroll this sheet, never the underlying post form. */
export function UxModalSheet({ visible, onRequestClose, onShown, onClosed, focusController, overlayStyle, sheetStyle, contentContainerStyle, header, children }: {
  visible: boolean; onRequestClose: () => void; onShown?: () => void; onClosed?: () => void;
  focusController?: UxFocusController; overlayStyle?: StyleProp<ViewStyle>; sheetStyle?: StyleProp<ViewStyle>;
  contentContainerStyle?: StyleProp<ViewStyle>; header?: React.ReactNode; children: React.ReactNode;
}) {
  const [localFocus] = useState(createUxFocusController);
  const [routeFocused, setRouteFocused] = useState(true);
  const focus = focusController || localFocus;
  const scrollRef = useRef<ScrollView>(null);
  const insets = useSafeAreaInsets();
  const safeFrame = useSafeAreaFrame();
  const viewport = useUxScrollViewport(focus, scrollRef);
  const keyboard = useUxKeyboardOffset(safeFrame.y);
  const [lifecycle] = useState(() => createModalLifecycle({ shown() {}, closed() {} }));
  useLayoutEffect(() => {
    lifecycle.setCallbacks({ shown: () => onShown?.(), closed: () => onClosed?.() });
  }, [lifecycle, onShown, onClosed]);
  useLayoutEffect(() => {
    lifecycle.visibility(visible);
    if (!visible) focus.setEnabled(false);
  }, [visible, lifecycle, focus]);
  useFocusEffect(useCallback(() => {
    lifecycle.focus(true); setRouteFocused(true);
    return () => { lifecycle.focus(false); focus.setEnabled(false); setRouteFocused(false); };
  }, [lifecycle, focus]));
  useFocusEffect(useCallback(() => {
    if (Platform.OS !== "android" || !visible) return;
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => { onRequestClose(); return true; });
    return () => subscription.remove();
  }, [visible, onRequestClose]));
  useLayoutEffect(() => {
    // Android uses ordinary sibling views below, so React has removed the layer at this commit.
    // No Android Dialog is created and no timeout/AppState event is treated as a dismiss receipt.
    if (Platform.OS === "android" && !visible) lifecycle.didClose();
  }, [visible, lifecycle]);
  const shown = () => { if (lifecycle.canShow()) { focus.setEnabled(true); lifecycle.didShow(); } };
  const content = (
    <UxFocusProvider controller={focus}>
      <KeyboardAvoidingView collapsable={false} keyboardVerticalOffset={keyboard.keyboardVerticalOffset} onLayout={keyboard.onLayout} style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : Platform.OS === "android" ? "height" : undefined}>
        <View collapsable={false} style={[{ flex: 1, justifyContent: "flex-end", backgroundColor: "#18102766", alignItems: "center" }, overlayStyle]}>
          <View collapsable={false} style={[{ maxHeight: "90%", width: "100%", maxWidth: 440, backgroundColor: "#FAF9FE", borderTopLeftRadius: 26, borderTopRightRadius: 26, paddingTop: 10 }, sheetStyle]}>
            {header}
            <ScrollView ref={scrollRef} style={{ flexShrink: 1 }} onScroll={viewport.onScroll} onLayout={viewport.onLayout}
              scrollEventThrottle={16} scrollsChildToFocus keyboardShouldPersistTaps="handled"
              contentContainerStyle={[{ padding: 22, gap: 14 }, contentContainerStyle, { paddingBottom: Math.max(22, insets.bottom + 12) }]}>
              {children}
            </ScrollView>
          </View>
        </View>
      </KeyboardAvoidingView>
    </UxFocusProvider>
  );
  if (Platform.OS === "android") return visible && routeFocused ? <View collapsable={false}
    style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, zIndex: 100 }}
    pointerEvents="auto" importantForAccessibility="yes" onLayout={shown}>
    {content}
  </View> : null;
  return <Modal visible={visible} transparent animationType="slide" onRequestClose={onRequestClose}
    onShow={shown} onDismiss={() => lifecycle.didClose()}>{content}</Modal>;
}
