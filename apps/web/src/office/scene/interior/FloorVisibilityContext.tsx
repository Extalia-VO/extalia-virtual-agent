import { createContext, useContext } from "react";

const FloorVisibilityContext = createContext(true);

export const FloorVisibilityProvider = FloorVisibilityContext.Provider;
export function useFloorVisible() {
  return useContext(FloorVisibilityContext);
}
