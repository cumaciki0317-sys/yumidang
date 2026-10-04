import React from "react";
import { CancelScreen } from "../screens/CommunityScreens";
import { useLocalSearchParams } from "expo-router";
export default function Route() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  return <CancelScreen id={id || "post-1"} />;
}
