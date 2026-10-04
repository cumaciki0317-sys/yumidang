import React from "react";
import { AppointmentScreen } from "../screens/CommunityScreens";
import { useLocalSearchParams } from "expo-router";
export default function Route() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  return <AppointmentScreen id={id || "appointment-1"} />;
}
