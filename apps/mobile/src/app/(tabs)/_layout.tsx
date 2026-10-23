import React, { useState } from "react";
import { Text, useWindowDimensions, type ColorValue } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Tabs } from "expo-router";
import { Icon, colors } from "../../ui";

export default function TabLayout() {
  const { width, fontScale } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const scope = `${width}:${fontScale}`;
  const [measured, setMeasured] = useState<Record<string, { scope: string; height: number }>>({});
  const bottomPadding = Math.max(12, insets.bottom);
  const labelHeight = Math.max(14 * fontScale, ...Object.values(measured).filter(value => value.scope === scope).map(value => value.height));
  // The stock label is single-line. Measure our wrapping label rather than cap font scaling.
  const label = (name: string) => function TabLabel({ color }: { color: ColorValue }) { return <Text
    allowFontScaling
    style={{ color, fontSize: 10, lineHeight: 14, fontWeight: "600", textAlign: "center", width: "100%" }}
    onLayout={(event) => {
      const height = Math.ceil(event.nativeEvent.layout.height);
      setMeasured(old => old[name]?.scope === scope && old[name].height === height ? old : { ...old, [name]: { scope, height } });
    }}
  >{name}</Text>; };
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.faint,
        tabBarAllowFontScaling: true,
        tabBarLabelPosition: "below-icon",
        tabBarStyle: {
          height: Math.max(70, 28 + 10 + 8 + bottomPadding + labelHeight),
          paddingBottom: bottomPadding,
          paddingTop: 8,
          borderTopColor: colors.line,
        },
      }}
    >
      <Tabs.Screen name="index" options={{ title: "홈", tabBarLabel: label("홈"), tabBarIcon: ({ color }) => <Icon name="home-outline" color={color} /> }} />
      <Tabs.Screen name="explore" options={{ title: "둘러보기", tabBarLabel: label("둘러보기"), tabBarIcon: ({ color }) => <Icon name="compass-outline" color={color} /> }} />
      <Tabs.Screen name="chats" options={{ title: "채팅", tabBarLabel: label("채팅"), tabBarIcon: ({ color }) => <Icon name="chatbubble-ellipses-outline" color={color} /> }} />
      <Tabs.Screen name="me" options={{ title: "마이페이지", tabBarLabel: label("마이페이지"), tabBarIcon: ({ color }) => <Icon name="person-outline" color={color} /> }} />
    </Tabs>
  );
}
