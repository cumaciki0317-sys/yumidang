import React from "react";
import { CreateScreen } from "../screens/BrowseScreens";
import { useLocalSearchParams } from "expo-router";
export default function Route() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  return <CreateScreen id={id || ""} />;
}
