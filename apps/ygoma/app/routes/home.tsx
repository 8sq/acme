import { getDb } from "@acme/app/db";
import { runtime } from "@acme/app/server";
import { useLoaderData } from "react-router";

declare module "@acme/app/db" {
  interface Databases {
    default: object;
  }
}

export const loader = async () => {
  const row = await getDb()
    .selectNoFrom((builder) => builder.lit(1).as("one"))
    .executeTakeFirst();
  return { runtime: runtime.name, one: row?.one };
};

export default function Home() {
  const data = useLoaderData<typeof loader>();

  return (
    <h1>
      Hello from {data.runtime}, select 1 = {data.one}
    </h1>
  );
}
