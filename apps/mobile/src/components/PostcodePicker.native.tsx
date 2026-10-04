import React, { useCallback, useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { getRandomBytesAsync } from "expo-crypto";
import { WebView } from "react-native-webview";
import { Body, Button } from "../ui";
import { isPostcodeDocument, isPostcodeFrame, postcodeHtml, POSTCODE_DOCUMENT_URL, readPostcodeBridgeMessage, type PostcodePickerProps } from "./postcode";

export default function PostcodePicker({ onSelect, onCancel }: PostcodePickerProps) {
  const webview = useRef<WebView>(null);
  const callbacks = useRef({ onSelect });
  useEffect(() => { callbacks.current = { onSelect }; }, [onSelect]);
  const [attempt, setAttempt] = useState(0);
  const [nonce, setNonce] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const activeNonce = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fail = useCallback(() => {
    activeNonce.current = null;
    if (timer.current) clearTimeout(timer.current);
    webview.current?.stopLoading(); setLoading(false);
    setError("주소 검색을 불러오지 못했어요. 다시 시도해 주세요.");
  }, []);
  useEffect(() => {
    let active = true;
    getRandomBytesAsync(16).then((bytes) => {
      if (!active) return;
      const next = [...bytes].map((v) => v.toString(16).padStart(2, "0")).join("");
      activeNonce.current = next; setNonce(next);
      timer.current = setTimeout(fail, 15000);
    }).catch(() => { if (active) fail(); });
    return () => { active = false; activeNonce.current = null; if (timer.current) clearTimeout(timer.current); };
  }, [attempt, fail]);
  return <View style={{ gap: 12 }}>
    {loading && <Body muted>주소 검색을 준비하고 있어요.</Body>}
    {nonce && !error && <WebView ref={webview} key={nonce} style={{ height: 480 }}
      source={{ html: postcodeHtml(nonce), baseUrl: POSTCODE_DOCUMENT_URL }}
      originWhitelist={["*"]} javaScriptEnabled domStorageEnabled={false}
      mixedContentMode="never" allowFileAccess={false} allowFileAccessFromFileURLs={false}
      allowUniversalAccessFromFileURLs={false} javaScriptCanOpenWindowsAutomatically={false}
      setSupportMultipleWindows={false} sharedCookiesEnabled={false} thirdPartyCookiesEnabled={false}
      incognito cacheEnabled={false}
      onShouldStartLoadWithRequest={(request) => {
        const allowed = request.isTopFrame === true ? isPostcodeDocument(request.url) : isPostcodeFrame(request.url);
        if (!allowed) fail();
        return allowed;
      }}
      onNavigationStateChange={(navigation) => { if (!isPostcodeDocument(navigation.url)) fail(); }}
      onOpenWindow={fail} onError={fail} onHttpError={fail}
      onMessage={(event) => {
        if (!activeNonce.current || activeNonce.current !== nonce) return;
        try {
          const message = readPostcodeBridgeMessage(event.nativeEvent.data, event.nativeEvent.url, nonce);
          if (timer.current) clearTimeout(timer.current);
          if (message.kind === "error") { fail(); return; }
          setLoading(false);
          if (message.kind === "selected") callbacks.current.onSelect(message.selection);
        } catch {
          setLoading(false); setError("동·읍·면이 확인되는 주소를 선택해 주세요. ‘선택 안함’ 주소는 사용할 수 없어요.");
          activeNonce.current = null;
        }
      }} />}
    {error && <><Body>{error}</Body><Button secondary onPress={() => { activeNonce.current = null; setNonce(null); setLoading(true); setError(null); setAttempt((v) => v + 1); }}>주소 검색 다시 열기</Button></>}
    {onCancel && <Button secondary onPress={onCancel}>주소 선택 닫기</Button>}
  </View>;
}
