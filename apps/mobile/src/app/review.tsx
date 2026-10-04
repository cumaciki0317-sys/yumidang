import React from "react";
import { ReviewScreen } from "../screens/CommunityScreens";
import { useLocalSearchParams } from "expo-router";
export default function Route() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  return <ReviewScreen id={id || "appointment-completed"} />;
}
