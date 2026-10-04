import React from "react";
import { EventListScreen } from "../screens/BrowseScreens";
import { useLocalSearchParams } from "expo-router";
export default function Route() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  return <EventListScreen id={id || "전시"} />;
}
