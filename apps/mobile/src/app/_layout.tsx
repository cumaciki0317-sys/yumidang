import { serviceMode, serviceConfigurationError } from "../remote";
import React from "react";
import { Platform, Pressable, Text, View } from "react-native";
import { Stack, router, usePathname } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { AppProvider, useApp } from "../state";
import { colors } from "../ui";

function Frame() {
  const app = useApp();
  const path = usePathname();
  return (
    <View
      style={{
        flex: 1,
        width: "100%",
        maxWidth: 430,
        alignSelf: "center",
        backgroundColor: colors.background,
        overflow: "hidden",
        ...(Platform.OS === "web" ? { boxShadow: "0 0 80px #ded7ed" } : {}),
      }}
    >
      <StatusBar style="dark" />
      <SafeAreaView edges={["top"]} style={{ backgroundColor: "#EDE7FB" }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="프로토타입 상태와 화면 목록"
        onPress={() => { if (!serviceMode) router.push("/preview"); }}
        style={{
          paddingVertical: 7,
          paddingHorizontal: 16,
          backgroundColor: "#EDE7FB",
          flexDirection: "row",
          justifyContent: "space-between",
        }}
      >
        <Text style={{ color: colors.deep, fontSize: 10, fontWeight: "600" }}>
          {serviceMode ? (serviceConfigurationError ? "서비스 연결 준비 중" : "서버 연결 검증 모드") : "디자인 미리보기 · 예시 데이터"}
        </Text>
        <Text style={{ color: colors.deep, fontSize: 10 }}>
          {serviceMode ? "" : path === "/preview" ? "상태 확인 중" : "화면 목록 ↗"}
        </Text>
      </Pressable>
      </SafeAreaView>
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: colors.background },
          animation: "slide_from_right",
        }}
      >
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="post" options={{ presentation: "modal" }} />
        <Stack.Screen name="review" options={{ presentation: "modal" }} />
        <Stack.Screen name="safety" options={{ presentation: "modal" }} />
      </Stack>
      {app.toast && (
        <View
          pointerEvents="none"
          style={{
            position: "absolute",
            bottom: 90,
            left: 18,
            right: 18,
            padding: 16,
            borderRadius: 14,
            backgroundColor: "#292137",
            zIndex: 50,
          }}
        >
          <Text style={{ color: "#fff", fontSize: 13, lineHeight: 21 }}>
            {app.toast}
          </Text>
        </View>
      )}
    </View>
  );
}
export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <AppProvider>
        <View style={{ flex: 1, backgroundColor: "#EEEAF5" }}>
          <Frame />
        </View>
      </AppProvider>
    </SafeAreaProvider>
  );
}
