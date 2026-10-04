import React, { useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { Body, Button } from "../ui";
import { KAKAO_POSTCODE_SCRIPT, selectPostalAddress, type PostcodePickerProps } from "./postcode";

interface PostcodeConstructor {
  new (options: { width: string; height: string; autoMapping: boolean; oncomplete: (data: unknown) => void }): { embed: (container: HTMLElement) => void };
}
const kakao = () => (window as unknown as { kakao?: { Postcode?: PostcodeConstructor } }).kakao?.Postcode;
let loadPromise: Promise<PostcodeConstructor> | null = null;
function loadPostcode(): Promise<PostcodeConstructor> {
  if (kakao()) return Promise.resolve(kakao()!);
  if (loadPromise) return loadPromise;
  loadPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = KAKAO_POSTCODE_SCRIPT;
    script.async = true;
    const timer = setTimeout(() => failed(), 15000);
    const failed = () => {
      clearTimeout(timer);
      script.onload = null; script.onerror = null;
      script.remove();
      loadPromise = null;
      reject(new Error("POSTCODE_LOAD_FAILED"));
    };
    script.onerror = failed;
    script.onload = () => { clearTimeout(timer); const Postcode = kakao(); if (Postcode) resolve(Postcode); else failed(); };
    document.head.appendChild(script);
  });
  return loadPromise;
}
export default function PostcodePicker({ onSelect, onCancel }: PostcodePickerProps) {
  const container = useRef<HTMLDivElement>(null);
  const callbacks = useRef({ onSelect, onCancel });
  useEffect(() => { callbacks.current = { onSelect, onCancel }; }, [onSelect, onCancel]);
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let active = true;
    const host = container.current;
    loadPostcode().then((Postcode) => {
      if (!active || !host) return;
      new Postcode({ width: "100%", height: "100%", autoMapping: false, oncomplete: (raw) => {
        if (!active) return;
        try { callbacks.current.onSelect(selectPostalAddress(raw)); }
        catch { setError("동·읍·면이 확인되는 주소를 선택해 주세요. ‘선택 안함’ 주소는 사용할 수 없어요."); }
      } }).embed(host);
      setLoading(false);
    }).catch(() => { if (active) { setLoading(false); setError("주소 검색을 불러오지 못했어요. 다시 시도해 주세요."); } });
    return () => { active = false; host?.replaceChildren(); };
  }, [attempt]);
  return <View style={{ gap: 12 }}>
    {loading && <Body muted>주소 검색을 준비하고 있어요.</Body>}
    <div ref={container} style={{ width: "100%", height: 480 }} />
    {error && <><Body>{error}</Body><Button secondary onPress={() => { setLoading(true); setError(null); setAttempt((v) => v + 1); }}>주소 검색 다시 열기</Button></>}
    {onCancel && <Button secondary onPress={onCancel}>주소 선택 닫기</Button>}
  </View>;
}
