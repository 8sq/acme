import { getPlayerIds } from "../../players.ts";

export const up = async () => {
  await getPlayerIds();
};

export const down = () => Promise.resolve();
