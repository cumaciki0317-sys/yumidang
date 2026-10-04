import React from "react";
import { Tabs } from "expo-router";
import { Icon, colors } from "../../ui";

export default function TabLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.faint,
        tabBarStyle: {
          height: 70,
          paddingBottom: 12,
          paddingTop: 8,
          borderTopColor: colors.line,
        },
        tabBarLabelStyle: { fontSize: 10, fontWeight: "600" },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: "홈",
          tabBarIcon: ({ color }) => <Icon name="home-outline" color={color} />,
        }}
      />
      <Tabs.Screen
        name="explore"
        options={{
          title: "둘러보기",
          tabBarIcon: ({ color }) => (
            <Icon name="compass-outline" color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="chats"
        options={{
          title: "채팅",
          tabBarIcon: ({ color }) => (
            <Icon name="chatbubble-ellipses-outline" color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="me"
        options={{
          title: "마이페이지",
          tabBarIcon: ({ color }) => (
            <Icon name="person-outline" color={color} />
          ),
        }}
      />
    </Tabs>
  );
}
