import React from "react";
import { ProfileScreen } from "../screens/CommunityScreens";
import { useLocalSearchParams } from "expo-router";
export default function Route() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  return <ProfileScreen id={id || "host"} />;
}
